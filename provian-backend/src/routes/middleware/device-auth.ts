import { observeActorSession } from '../../core/jurisdiction/mint-compliance';
import {openPrivateAuthenticatedRequest} from '../../core/meter/private-pricing';
/**
 * Device API Key Authentication Middleware
 *
 * Auth flow:
 * 1. Extract DeviceKey token from Authorization header
 * 2. Split into device_key:device_secret
 * 3. Look up device_key_index/{prefix} -> device_id
 * 4. Load devices/{device_id} -> stored hash + salt
 * 5. scrypt verify (constant-time comparison)
 * 6. Attach device document to req.device
 *
 * Supports two formats:
 *   Authorization: DeviceKey {device_key}:{device_secret}
 *   Authorization: Basic {base64(device_key:device_secret)}
 */

import { Request, Response, NextFunction, RequestHandler } from 'express';
import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { verifyApiCredentialAsync } from '../../core/agent-wallet/api-key';
import { cache } from '../../cache';
import { verifyBoundDeviceSignature } from './device-signature-binding';
import { bumpOpsCounter } from '../../core/observability/ops-counters';
import { isValidFirestoreDocumentId } from '../../firestore-document-id';

// STEP 9 (Wave 4): legacy `loadNoble()` shim removed. The bound-preimage
// verifier in device-signature-binding.ts now does all P-256 work via
// Node webcrypto and is the only path called from this middleware. The
// previous `await import('@noble/curves/p256')` would throw at runtime
// because the ./p256 subpath is not in @noble/curves v2 exports.

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type DeviceOwnerType = 'human' | 'agent';

/**
 * Firestore and Redis values are runtime data, so the DeviceDocument type is
 * not evidence that owner_type is valid. Authentication callers must run this
 * exact-value guard before trusting or caching a device record.
 */
export function isDeviceOwnerType(value: unknown): value is DeviceOwnerType {
  return value === 'human' || value === 'agent';
}

export function hasValidDeviceOwnerType(
  value: unknown,
): value is Record<string, unknown> & { owner_type: DeviceOwnerType } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, 'owner_type');
  return descriptor !== undefined
    && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    && isDeviceOwnerType(descriptor.value);
}

export interface DeviceDocument {
  device_id: string;
  device_name: string;
  device_type: DeviceType;
  platform: string;
  owner_wallet_id: string;
  owner_user_id: string;
  owner_address: string;
  owner_type: DeviceOwnerType;
  attestation_capability: string;
  device_key_hash: string;
  device_key_salt: string;
  device_key_prefix: string;
  status: 'active' | 'revoked';
  created_at: number;
  last_pe_at: number | null;
  total_pes: number;
  /**
   * Per-PE signing method for inbound submissions from this device.
   *   - undefined / 'bearer' - authenticate via DeviceKey:DeviceSecret (legacy)
   *   - 'secure_enclave_p256' - verify payload signatures against
   *     `signing_public_key` using @noble/curves/p256.
   */
  signing_method?: 'bearer' | 'secure_enclave_p256';
  /**
   * SEC1 uncompressed P-256 public key hex (65 bytes, "04" || X || Y).
   * Set when signing_method === 'secure_enclave_p256'.
   */
  signing_public_key?: string;
  /**
   * Server-VERIFIED attestation tier, set ONLY when an Android Key Attestation
   * chain was presented at registration and verified against Google's roots.
   * Distinct from the self-reported `attestation_capability` so the downgrade
   * path and Commons recompute have an unambiguous source of truth. Absent =
   * no Google-attested evidence. Agent-owned devices are forced to software
   * before signing-method selection; human-device resolution otherwise fails
   * closed unless the server can verify the claimed capability.
   * See core/attestation.
   */
  attested_security_level?: 'hardware_full' | 'hardware_tpm';
  /** Evidence captured at the moment the attestation chain was verified. */
  attestation_evidence?: {
    method: 'android_key_attestation';
    security_level: string;
    boot_state: string;
    verified_at: number;
  };
  /**
   * Self-reported LLM-session capture status from the device's observer daemon
   * (via PUT /v1/devices/me/capture-status, device auth). Lets the app show
   * whether AI-app capture is actually working on this machine or needs the
   * user to grant macOS permissions. Absent = the daemon has not reported yet
   * (older SDK, or first heartbeat pending). NOT security-bearing: it never
   * affects auth, attestation, or earning — display only.
   */
  capture_status?: {
    /** config `capture.llm_session_enabled` — did the user turn AI-app capture on. */
    llm_session_enabled: boolean;
    /** process.platform of the daemon host (perms only meaningful on 'darwin'). */
    platform: string;
    /** the plugin is running (helper spawned) — not disabled by config/platform. */
    active: boolean;
    /** the helper has reported an OS permission status at least once. */
    permissions_checked: boolean;
    /** macOS Accessibility permission granted. */
    accessibility: boolean;
    /** macOS Input Monitoring permission granted. */
    input_monitoring: boolean;
    /** server clock at write time. */
    updated_at: number;
    /**
     * Advisory SDK-staleness fields the observer daemon self-reports (D — agent
     * update signal). Display-only, like the rest of capture_status: the phone's
     * device view shows a stale agent at a glance. Absent = older SDK that does
     * not report them yet. NEVER affects auth, attestation, or earning.
     */
    sdk_version?: string;
    sdk_stale?: boolean;
    sdk_below_min?: boolean;
  };
  /**
   * What the observer's transcript watcher can SEE on this device, reported by
   * the daemon (2026-09-07, after the Atlas outage).
   *
   * Distinct from `capture_status`, which describes the AI-foreground capture
   * plugin's permissions. This one answers a different and, as it turned out,
   * more important question: can the daemon read the agent harness's records at
   * all? A device whose harness is installed and whose `total_sources` is 0 is
   * BLIND — and blind is indistinguishable from idle unless it is reported.
   *
   * Structure only, enforced at the write boundary by `buildDeviceCaptureHealth`:
   * names, versions, counts, integers, timestamps. No path, table, session id,
   * or content can be stored here. Display and alerting only — this NEVER
   * affects auth, attestation, eligibility, or earning.
   */
  capture_health?: {
    schema: string;
    daemon_version: string;
    runtime: string;
    sqlite_readable: boolean;
    harnesses: Array<{
      harness: string;
      version: string | null;
      sources: number;
      containers: string[];
    }>;
    total_sources: number;
    cursor_total: number;
    last_verdict: string;
    last_verdict_at_ms: number | null;
    last_capture_at_ms: number | null;
    // --- Witness lanes (item 5) --------------------------------------
    // Which independent witness(es) actually produce capture on this device. A
    // device can host two (transcript watcher + OTel receiver); this makes a
    // single-witness machine read as single-witness rather than doubly-covered.
    // `lanes` is a SERVER-derived judgement (like `broken`), never the device's
    // claim: otel counts only when active AND listening AND a span has arrived —
    // a listening-but-silent receiver (the OpenClaw exporter defect) is not a lane.
    /** OTel plugin registered and running (may be absent on older daemons). */
    otel_active?: boolean;
    /** OTLP receiver socket bound and listening. */
    otel_receiver_listening?: boolean;
    /** A span has ever reached the receiver — the OTel lane's real-witness proof. */
    otel_spans_ever_seen?: boolean;
    /** Epoch ms of the last span received; null if none ever arrived. */
    otel_last_span_at_ms?: number | null;
    /** Which witness lane(s) produce capture: transcript | otel | both | none. */
    lanes?: 'transcript' | 'otel' | 'both' | 'none';
    // --- Model-endpoint proxy witness lane (Lane 5,) -----------------
    /** The model-proxy plugin is registered and running. */
    proxy_active?: boolean;
    /** The loopback proxy socket is bound and listening. */
    proxy_listening?: boolean;
    /** A model turn has ever been witnessed — the proxy lane's real-witness proof. */
    proxy_turns_ever_seen?: boolean;
    /** Epoch ms of the last model turn witnessed; null if none ever arrived. */
    proxy_last_turn_at_ms?: number | null;
    /** Traffic the proxy forwarded but could not parse, by shape. */
    proxy_unrecognized?: Array<{ fingerprint: string; provider: string | null; method: string; count: number }>;
    // --- Process witness lane (Lane 4,) ------------------------------
    /** The process-lane plugin is registered and running (agent VMs only). */
    process_active?: boolean;
    /** The lane is reading the OS process table. */
    process_watching?: boolean;
    /** A command act has ever sealed+minted — the process lane's real-witness proof. */
    process_acts_ever_sealed?: boolean;
    /** Epoch ms of the last command act sealed; null if none. */
    process_last_act_at_ms?: number | null;
    /** the process lane's state (closed set); null when absent or unrecognised. */
    process_lane_state?: string | null;
    /** When `process_lane_state` began, on the relay's clock (from the daemon's reported age). */
    process_lane_state_since_ms?: number | null;
    /** The daemon reports `launcher_changed` only for a confirmed harness change. */
    process_launcher_change_confirmed?: boolean;
    /** the daemon's audit saw the recorded launcher running this window. */
    process_launcher_live?: boolean;
    /** commands the audit saw that are due to have sealed this window, and how many did. */
    process_commands_due_in_window?: number;
    process_commands_due_sealed_in_window?: number;
    /** launchers the audit re-bound the lane to this window. */
    process_launcher_heals_in_window?: number;
    /**
     * The complete witness-lane set (superset of `lanes`), incl. model_proxy and process.
     * (retired the loopback intakes: the Grok hooks lane and the local
     * self-report endpoint — a record written before then may still carry
     * `grok_hooks` / `self_report` and `hooks_*` / `self_report_*` fields.)
     */
    lane_names?: Array<'transcript' | 'otel' | 'model_proxy' | 'process'>;
    /**
     * The daemon's Grok proxy repoint: `repointed`, or why not (`unwritable`,
     * `foreign`, `unsupported`, `error`, `disabled`, `not_listening`, and
     * `unsupervised` no supervisor restarts this daemon, so it writes no repoint);
     * null when Grok is absent or the daemon did not report it.
     */
    detected_harness_homes?: string[];
    /** How the daemon is kept running (closed set). */
    supervision_method?: 'launchd' | 'systemd' | 'cron' | 'scheduled_task' | 'detached' | 'unknown';
    /** Under cron: whether a cron daemon process is running; null when not cron / unknowable. */
    cron_alive?: boolean | null;
    /**
     * the restart mechanism beside `supervision_method` (closed set): `shell_rc` when the
     * daemon's shell-startup restart hook is in place (a detached / cron Linux box); null otherwise.
     */
    restart_hook?: 'shell_rc' | null;
    /**
     * WHAT brings the observer back after a reboot or instance move
     * (closed set). `agent` = no cron, no service manager, no startup file this box reads — the
     * agent keeps it running (setup instruction). Null for an older daemon.
     */
    restart_mechanism?: 'systemd' | 'launchd' | 'scheduled_task' | 'cron' | 'shell_rc' | 'agent' | null;
    /** Epoch ms of the last work PE the daemon submitted on any lane; null if none. */
    last_work_pe_at_ms?: number | null;
    // --- Sole-witness silence -----------------------------
    /** Records the watcher read this window (recognized or not). 0 = idle source. */
    records_consumed_in_window?: number;
    /** Tool calls the extractor recognized this window. 0 with records>0 = the alarm. */
    tool_calls_recognized_in_window?: number;
    // --- Self-update outcome (item 2, ops-dashboard build) ------------------
    /** The daemon's last self-update outcome (closed enum); null if never reported. */
    self_update_outcome?: string | null;
    /** When the daemon last attempted a self-update. */
    self_update_at_ms?: number | null;
    /** The release version the daemon last applied / attempted. */
    self_update_version?: number;
    // --- Unparsed session-like stores ---------------------
    /**
     * Session-like SQLite stores discovery found but could not parse into tool
     * activity — an uncataloged harness, surfaced by shape. Structure-only: the
     * fingerprint is a one-way hash of the store's schema; the two counts are
     * integers. No name or path can ride here. Absent on daemons predating this.
     */

    /**
     * Why the device is not receiving, or null when it is. `no_readable_sources`
     * = a harness installed but nothing readable (the original Atlas alarm);
     * `sole_witness_silence` = readable and records flowing but zero tool calls
     * recognized (the Sep-1 outage one layer down). Server-derived, never the
     * device's claim. Absent on older daemons that predate this field.
     */
    format_broken_programs?: string[];
    broken_reason?: 'no_readable_sources' | 'sole_witness_silence' | 'session_format_broken' | 'process_launcher_changed' | 'process_launcher_not_seen' | 'process_no_launcher' | 'process_launcher_unsupported' | 'process_lane_silence' | null;
    /** True when a harness is installed and nothing is readable, or sole-witness silent. THE alarm. */
    broken: boolean;
    /** When the broken state began, for the process lane's own flags; null otherwise. */
    broken_since_ms?: number | null;

    /** Server clock at write time — never the device's, which can lie or drift. */
    updated_at: number;
  };
}

export type DeviceType =
  | 'coding_workstation'
  | 'mining_rig'
  | 'gpu_cluster'
  | 'home_server'
  | 'iot_device'
  | 'mobile_agent'
  | 'cloud_instance'
  | 'other';

// The `req.device` augmentation lives in src/types/express.d.ts (consolidated).

/** Cache TTL for device document lookups (seconds) */
const DEVICE_CACHE_TTL_S = 30;

/**
 * Invalidate the cached device document by device_id.
 * Call this when revoking a device for instant revocation.
 *
 * Two cache keys exist for the same device:
 *   - `device:${device_key_prefix}` - populated by the legacy DeviceKey auth path
 *   - `device:id:${deviceId}`        - populated by the signed-submission
 *                                       (DeviceSignature) auth path
 * Both must be deleted to make revocation effective. Audit Pass 2, Fix 5
 * caught a previous version that only deleted the first; revoked devices
 * could continue submitting via the signed path for up to DEVICE_CACHE_TTL_S
 * seconds.
 */
export async function invalidateDeviceCache(db: Firestore, deviceId: string): Promise<void> {
  try {
    const deviceDoc = await db.collection('devices').doc(deviceId).get();
    if (deviceDoc.exists) {
      const rawDevice = deviceDoc.data();
      const cacheKeys = [`device:id:${deviceId}`];
      if (
        hasValidDeviceOwnerType(rawDevice)
        && typeof rawDevice.device_key_prefix === 'string'
        && rawDevice.device_key_prefix.length > 0
      ) {
        cacheKeys.push(`device:${rawDevice.device_key_prefix}`);
      }
      await Promise.all(cacheKeys.map((key) => cache.del(key)));
    } else {
      // Device doc absent (deleted, never existed). Still drop the id-keyed
      // entry in case it's stale.
      await cache.del(`device:id:${deviceId}`);
    }
  } catch (error) {
    console.error(`[DeviceAuth] Failed to invalidate cache for device ${deviceId}:`, error);
  }
}

/**
 * Extract device_key and device_secret from the Authorization header.
 * Supports:
 *   DeviceKey {key}:{secret}
 *   Basic {base64(key:secret)}
 */
function extractCredentials(authHeader: string): { deviceKey: string; deviceSecret: string } | null {
  if (authHeader.startsWith('DeviceKey ')) {
    const token = authHeader.slice(10); // Remove 'DeviceKey '
    const colonIdx = token.indexOf(':');
    if (colonIdx === -1) return null;
    return { deviceKey: token.slice(0, colonIdx), deviceSecret: token.slice(colonIdx + 1) };
  }

  if (authHeader.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(authHeader.slice(6), 'base64').toString();
      const colonIdx = decoded.indexOf(':');
      if (colonIdx === -1) return null;
      return { deviceKey: decoded.slice(0, colonIdx), deviceSecret: decoded.slice(colonIdx + 1) };
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Load a device document by device_id. Uses the same Redis cache layer as the
 * bearer path so a signed-submission verification doesn't pay a Firestore
 * round-trip on every request.
 */
async function loadDeviceById(db: Firestore, deviceId: string): Promise<DeviceDocument | null> {
  const cacheKey = `device:id:${deviceId}`;
  const cached = await cache.get<unknown>(cacheKey);
  if (cached !== null) {
    if (!hasValidDeviceOwnerType(cached)) {
      await cache.del(cacheKey).catch(() => {});
      return null;
    }
    return cached as unknown as DeviceDocument;
  }

  const deviceDoc = await db.collection('devices').doc(deviceId).get();
  if (!deviceDoc.exists) return null;
  const rawDevice = deviceDoc.data();
  if (!hasValidDeviceOwnerType(rawDevice)) return null;
  const device = rawDevice as unknown as DeviceDocument;
  await cache.set(cacheKey, device, DEVICE_CACHE_TTL_S);
  return device;
}

/**
 * Canonicalize a JSON value using sorted keys + minimal whitespace. Mirrors
 * the SDK's ProvianClient.stableStringify so the hash agrees on both sides.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(v => stableStringify(v)).join(',') + ']';
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = (value as Record<string, unknown>)[k];
    if (v === undefined) continue;
    parts.push(JSON.stringify(k) + ':' + stableStringify(v));
  }
  return '{' + parts.join(',') + '}';
}

/**
 * Verify a DeviceSignature-authenticated request using the bound-preimage
 * envelope (BLOCKER-4 fix, 2026-05-06). Replaces the previous raw-body
 * P-256 signature, which had no method/path/timestamp/nonce binding and
 * was indefinitely replayable.
 *
 * Delegates to verifyBoundDeviceSignature in device-signature-binding.ts.
 */
async function verifyDeviceSignature(
  device: DeviceDocument,
  rawBody: string,
  _parsedBody: unknown,
  signatureHeader: string | string[] | undefined,
  req: Request,
  db: Firestore,
): Promise<{ ok: boolean; reason?: string; code?: string }> {
  if (device.signing_method !== 'secure_enclave_p256') {
    return { ok: false, reason: 'device not registered for signed submissions' };
  }
  if (!device.signing_public_key) {
    return { ok: false, reason: 'device has no signing_public_key on file' };
  }
  const fullPath = (req.originalUrl || req.url || req.path).split('?')[0];
  const result = await verifyBoundDeviceSignature({
    signatureHeader,
    rawBody,
    method: req.method,
    path: fullPath,
    signingPublicKeyHex: device.signing_public_key,
    deps: { db, cache },
  });
  if (result.ok) return { ok: true };
  return { ok: false, reason: result.reason, code: result.code };
}

/**
 * Extract a DeviceSignature device_id from the Authorization header, if present.
 * Format: `Authorization: DeviceSignature {device_id}`.
 */
function extractDeviceSignatureId(authHeader: string): string | null {
  if (!authHeader.startsWith('DeviceSignature ')) return null;
  const id = authHeader.slice('DeviceSignature '.length).trim();
  return id || null;
}

/**
 * Create a device authentication middleware bound to the given Firestore instance.
 */
export function createDeviceAuthMiddleware(db: Firestore): RequestHandler {
  return async function authenticateDevice(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
   try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      res.status(401).json({ error: 'Missing Authorization header' });
      return;
    }

    // ---- Path A: DeviceSignature {device_id} - P-256 signed payload ------
    const sigDeviceId = extractDeviceSignatureId(authHeader);
    if (sigDeviceId) {
      // F62: the device id becomes a Firestore document path (`devices/{id}`).
      // A '/' in the caller-supplied id makes `.doc()` throw synchronously and,
      // in this async middleware, crash the process. Reject a non-document-id
      // before it reaches `.doc()`.
      if (!isValidFirestoreDocumentId(sigDeviceId)) {
        res.status(401).json({ error: 'Invalid device signature credentials' });
        return;
      }
      const device = await loadDeviceById(db, sigDeviceId);
      if (!device) {
        res.status(401).json({ error: 'Invalid device signature credentials' });
        return;
      }
      if (device.status === 'revoked') {
        res.status(403).json({ error: 'Device has been revoked' });
        return;
      }
      // Express with express.json() may have consumed the raw body. Access
      // the buffered raw body via req.rawBody (typed globally) when available;
      // fall back to stringifying the parsed body. The signature verifier will
      // try both candidates.
      const rawBody = typeof req.rawBody === 'string' ? req.rawBody : '';
      const check = await verifyDeviceSignature(
        device,
        rawBody,
        req.body,
        req.headers['x-provian-signature'],
        req,
        db,
      );
      if (!check.ok) {
        console.warn(`[DeviceAuth] Signature verification failed for ${sigDeviceId}: ${check.reason} (${check.code ?? 'unknown'})`);
        bumpOpsCounter('auth.device_sig_failed');
        res.status(401).json({ error: 'Invalid device signature', code: check.code });
        return;
      }
      req.device = device;
      req.deviceAuthMethod = 'device_signature';
      await observeActorSession(db, req, device.owner_type === 'human' ? device.owner_user_id : device.owner_wallet_id);
      if(req.body?.private_request||req.query?.private_query){
        const header=req.headers['x-provian-privacy-credential'];
        const credential=typeof header==='string'?extractCredentials('DeviceKey '+header):null;
        if(!credential||!await verifyApiCredentialAsync(credential.deviceKey,credential.deviceSecret,device.device_key_hash,device.device_key_salt))throw new Error('private_request_credential_unavailable');
        openPrivateAuthenticatedRequest(req,credential.deviceSecret);
      }
      next();
      return;
    }

    // ---- Path B: DeviceKey {key}:{secret} or Basic {base64} --------------
    const creds = extractCredentials(authHeader);
    if (!creds) {
      res.status(401).json({ error: 'Invalid credential format. Expected DeviceKey {key}:{secret}, DeviceSignature {device_id}, or Basic {base64}' });
      return;
    }

    const { deviceKey, deviceSecret } = creds;

    if (!deviceKey.startsWith('pdk_') || !deviceSecret.startsWith('pds_')) {
      res.status(401).json({ error: 'Invalid credential format' });
      return;
    }

    // Look up device by key prefix - check Redis cache first
    const prefix = deviceKey.slice(0, 20);
    // F62: the prefix becomes a Firestore document path (`device_key_index/{prefix}`).
    // Reject a non-document-id (e.g. one containing '/') before `.doc()` throws
    // synchronously and crashes this async middleware. A real `pdk_<hex>` passes.
    if (!isValidFirestoreDocumentId(prefix)) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    const cacheKey = `device:${prefix}`;

    const cachedDevice = await cache.get<unknown>(cacheKey);
    let device: DeviceDocument | null = null;

    if (cachedDevice !== null) {
      if (!hasValidDeviceOwnerType(cachedDevice)) {
        await cache.del(cacheKey).catch(() => {});
        res.status(401).json({ error: 'Invalid credentials' });
        return;
      }
      device = cachedDevice as unknown as DeviceDocument;
    }

    if (!device) {
      // Cache miss - read from Firestore via index
      const indexDoc = await db.collection('device_key_index').doc(prefix).get();
      if (!indexDoc.exists) {
        res.status(401).json({ error: 'Invalid credentials' });
        return;
      }

      const indexData = indexDoc.data() as { device_id: string };
      const deviceDoc = await db.collection('devices').doc(indexData.device_id).get();
      if (!deviceDoc.exists) {
        res.status(401).json({ error: 'Invalid credentials' });
        return;
      }

      const rawDevice = deviceDoc.data();
      if (!hasValidDeviceOwnerType(rawDevice)) {
        res.status(401).json({ error: 'Invalid credentials' });
        return;
      }
      device = rawDevice as unknown as DeviceDocument;

      // Cache the device document (NOT the auth result - scrypt must still run)
      await cache.set(cacheKey, device, DEVICE_CACHE_TTL_S);
    }

    if (device.status === 'revoked') {
      res.status(403).json({ error: 'Device has been revoked' });
      return;
    }

    // Verify credentials via async scrypt (constant-time, non-blocking)
    const valid = await verifyApiCredentialAsync(
      deviceKey,
      deviceSecret,
      device.device_key_hash,
      device.device_key_salt,
    );

    if (!valid) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    req.device = device;
    req.deviceAuthMethod = 'bearer';
    await observeActorSession(db, req, device.owner_type === 'human' ? device.owner_user_id : device.owner_wallet_id);
    openPrivateAuthenticatedRequest(req,deviceSecret);
    next();
   } catch (err) {
    // F62: no caller-supplied header/id may take the process down. A synchronous
    // `.doc()` throw (or a transient Firestore/cache error) answers 503 here
    // instead of rejecting uncaught. Never fail open to `next()`.
    console.error('[DeviceAuth] middleware error:', err);
    res.status(503).json({ error: 'Authentication service temporarily unavailable' });
   }
  };
}
