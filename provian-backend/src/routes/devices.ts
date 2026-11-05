import { observeActorSession } from '../core/jurisdiction/mint-compliance';
import { ownerParticipantClass } from '../core/identity/participant-class';
/**
 * Device Registration Routes
 *
 * Devices register to a wallet owner (human or agent), which fixes actor
 * attribution. Human and unlinked-agent contributor residuals route to that
 * owner; an active verified agent-beneficiary relationship instead seals its
 * exact integer-BPS split on each PE at record time. One actor, one device -
 * device identity IS actor identity.
 *
 * Auth: human wallet (Bearer session) or agent wallet (Bearer pvn_live_key:secret).
 * The dual-auth middleware in server.ts routes based on Authorization header prefix.
 *
 * Endpoints:
 *   POST   /v1/devices/register   - Register a new device (wallet or agent auth)
 *   GET    /v1/devices             - List registered devices (wallet or agent auth)
 *   DELETE /v1/devices/:device_id  - Revoke a device (wallet or agent auth)
 *   PATCH  /v1/devices/:device_id  - Update device name (wallet or agent auth)
 *
 * The single-PE device submit (`POST /v1/pe/submit`) is retired: a device sends its PEs as one
 * signed daily batch to `/v1/meter/batch` (PE meter, 2026-10-03; routes/meter-retired-recorders.ts).
 */

import { deliveryWaiting } from '../core/commons/agent-delivery';
import { Router, Request, Response, RequestHandler } from 'express';
import crypto, { webcrypto } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import stableStringify from 'json-stable-stringify';
import type { Firestore } from 'firebase-admin/firestore';

import {
  createDeviceAuthMiddleware,
  hasValidDeviceOwnerType,
  invalidateDeviceCache,
  isDeviceOwnerType,
} from './middleware/device-auth';
import { burnPendingDeviceSetupToken } from './middleware/device-register-auth';
import type { DeviceDocument, DeviceType } from './middleware/device-auth';

import type { RecordPEAccrualParams } from '../pvt-accrual';
import {
  buildGenesisQualification,
  shouldEnqueueGenesisQualification,
} from '../core/pvt/genesis-award-state-machine';
import {
  commitDeviceRegistration,
  deterministicDeviceRegistrationIds,
  deviceRegistrationPeContent,
  GenesisIngressError,
} from '../core/pvt/genesis-ingress';
import { advanceRelayAct, priceRelayAct, readRelayActIntake } from '../core/meter/meter-relay-authored';
import { getDeviceRegistrationId } from './middleware/device-registration-id';
import { verifyAndroidRegistrationChain } from '../core/attestation';
import { makeAgentProvenanceUrl } from '../provenance-links';
import type { GenesisActivationApprovalVerifier } from '../core/pvt/policy/genesis-policy-engine';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DeviceRouterDeps {
  db: Firestore;
  cache: {
    checkRateLimit: (key: string, limit: number, windowSeconds: number) => Promise<{ allowed: boolean; retryAfter?: number }>;
    get: <T>(key: string) => Promise<T | null>;
    set: (key: string, value: unknown, ttl: number) => Promise<void>;
  };
  peBuffer: { enqueue: (docId: string, data: object) => void };
  recordPEAccrual: (params: RecordPEAccrualParams) => Promise<void>;
  /** Durable outbox processor; tests may omit it and leave the act queued. */
  processGenesisQualification?: (qualificationId: string) => Promise<unknown>;
  /** Explicit test seam. Production always uses structured SSHSIG verification. */
  genesisActivationApprovalVerifier?: GenesisActivationApprovalVerifier;
}

const VALID_DEVICE_TYPES: DeviceType[] = [
  'coding_workstation', 'mining_rig', 'gpu_cluster', 'home_server',
  'iot_device', 'mobile_agent', 'cloud_instance', 'other',
];

const VALID_ATTESTATION_CAPABILITIES = ['software', 'hardware_tpm'];

const MAX_DEVICES_PER_WALLET = 10;

/** Attestation capabilities that claim hardware-level trust. */
export const HARDWARE_CAPABILITIES = ['hardware_tpm', 'hardware', 'hardware_full'];

function buildDeviceAttributionContext(ownerWalletId: string, ownerType: 'human' | 'agent') {
  return {
    mode: 'device_owner',
    owner_wallet_id: ownerWalletId,
    owner_type: ownerType,
    provenance_url: ownerType === 'agent' ? makeAgentProvenanceUrl(ownerWalletId) : null,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Server-side attestation depth verification.
 *
 * Closes the "claim hardware from software" attack vector by checking the
 * device's registered attestation_capability against the owner type and
 * wallet registration data.
 *
 * Fail-closed policy (BLOCKER-2 fix, 2026-05-06):
 * - Agent-owned devices can NEVER have hardware attestation (agents = software).
 * - Human-owned devices may claim hardware tier ONLY when the wallet's
 *   attested_security_level is explicitly set to a recognised hardware
 *   value by a server-trusted writer. Missing/null/unknown values are
 *   treated as software-tier and downgrade the claim. Previously the
 *   default was to honour hardware claims when no level was on file,
 *   which let any device elevate itself.
 *
 * Recognised hardware values: 'hardware', 'hardware_tpm', 'hardware_full',
 * 'hardware_partial'. Anything else (including missing) → downgrade.
 */
export interface AttestationVerificationResult {
  verifiedCapability: string;
  downgraded: boolean;
  reason?: string;
}

/**
 * Canonical economic tier emitted by a verified device baseline. Internal
 * capability labels such as `hardware_tpm` are not monetary tiers: verified
 * TPM/TEE or legacy generic hardware evidence remains `hardware_partial`
 * unless the server has the explicit `hardware_full` platform result.
 */
export type DeviceEconomicAttestationTier =
  | 'software'
  | 'hardware_partial'
  | 'hardware_full';

export function canonicalDeviceEconomicAttestationTier(
  verifiedCapability: string,
): DeviceEconomicAttestationTier {
  // registration is a capability fact, never proof of genuine producer software.
  return 'software';
}

const ATTESTED_HARDWARE_LEVELS = new Set([
  'hardware',
  'hardware_tpm',
  'hardware_full',
  'hardware_partial',
]);

export function verifyAttestationCapability(
  claimedCapability: string,
  ownerType: 'human' | 'agent',
  walletSecurityLevel?: string | null,
): AttestationVerificationResult {
  if (!isDeviceOwnerType(ownerType)) {
    throw new Error('invalid_device_owner_type');
  }

  // Agent-owned devices can NEVER claim hardware attestation
  if (ownerType === 'agent' && HARDWARE_CAPABILITIES.includes(claimedCapability)) {
    return {
      verifiedCapability: 'software',
      downgraded: true,
      reason: `owner is agent (software only), claimed ${claimedCapability}`,
    };
  }

  // Human-owned devices: hardware claim requires explicit wallet attestation.
  if (ownerType === 'human' && HARDWARE_CAPABILITIES.includes(claimedCapability)) {
    const level = typeof walletSecurityLevel === 'string' ? walletSecurityLevel : null;
    if (!level || !ATTESTED_HARDWARE_LEVELS.has(level)) {
      return {
        verifiedCapability: 'software',
        downgraded: true,
        reason: `wallet attested_security_level=${level ?? 'missing'} cannot vouch for ${claimedCapability}`,
      };
    }
  }

  return { verifiedCapability: claimedCapability, downgraded: false };
}

/**
 * Resolve the PE attestation tier from a device's signing_method + owner + platform.
 *
 * Tier reflects verified attestation evidence. Desktop currently presents no
 * verifiable attestation chain, so caps at `hardware_partial`. Future
 * verifiers (Android Key Attestation chain, macOS App Attest, Windows TPM)
 * will lift this automatically when evidence is presented. See
 * docs/ATTESTATION_ROADMAP.md.
 *
 *   - owner_type='agent'
 *       → 'software' before signing-method selection. Agent-owned devices are
 *         software-only under the approved policy; hardware eligibility would
 *         require a separate explicit policy decision.
 *   - signing_method='secure_enclave_p256' (human-owned devices only)
 *       → 'hardware_partial' (1.2x). The desktop SDK signs with a P-256 key
 *         that is validated only as a syntactic point on the curve. No
 *         attestation chain is presented today, so the device cannot earn
 *         the `hardware_full` tier. When a verifier for the relevant
 *         platform's attestation primitive ships, this branch grows the
 *         evidence-check and the tier lifts on its own.
 *   - signing_method='bearer' / undefined
 *       → fall back to the classic attestation_capability verification. The
 *         existing `verifyAttestationCapability()` still handles agent downgrade
 *         and wallet-level security mismatches.
 *
 * Pre-fix (2026-05-10): the prior policy bumped human + Mac/iOS-platform-
 * string + secure_enclave_p256 to hardware_full. That was unsafe - a
 * software-generated P-256 key with the platform string set to "macOS"
 * passed all checks. The cap below removes the over-claim. PE economic
 * weight differentiates hardware_partial (1.2x) from hardware_full (2.5x).
 */
export function resolveAttestationTierFromSigning(params: {
  signingMethod?: string;
  ownerType: 'human' | 'agent';
  platform: string;
  claimedCapability: string;
  walletSecurityLevel?: string | null;
  /**
   * Server-verified Android Key Attestation tier, set on the device doc ONLY
   * when a chain was verified against Google's roots at registration. When
   * present on a human-owned device it LIFTS the secure_enclave_p256 cap to the
   * Google-attested tier. Agents never earn hardware tiers (Security Invariant),
   * so an attested level is ignored for agent-owned devices.
   */
  attestedSecurityLevel?: 'hardware_full' | 'hardware_tpm' | null;
}): AttestationVerificationResult {
  if (!isDeviceOwnerType(params.ownerType)) {
    throw new Error('invalid_device_owner_type');
  }

  const { signingMethod } = params;

  // Approved policy boundary: agent-owned devices are software-only. This
  // check MUST precede signing-method tier selection so a syntactically valid
  // P-256 signature cannot re-promote an agent device that registration
  // correctly downgraded. Replication packs may still earn their separate
  // software_verified treatment later in the PE pipeline.
  if (params.ownerType === 'agent') {
    const downgraded = signingMethod === 'secure_enclave_p256'
      || params.claimedCapability !== 'software';
    return {
      verifiedCapability: 'software',
      downgraded,
      ...(downgraded ? { reason: 'agent_device_software_only' } : {}),
    };
  }

  if (signingMethod === 'secure_enclave_p256') {
    if (
      params.attestedSecurityLevel === 'hardware_full' ||
      params.attestedSecurityLevel === 'hardware_tpm'
    ) {
      return {
        verifiedCapability: params.attestedSecurityLevel,
        downgraded: false,
        reason: 'android_key_attestation_verified',
      };
    }
    return {
      verifiedCapability: 'hardware_partial',
      downgraded: true,
      // Platform-neutral: an SE-capable device (iOS OR macOS) whose hardware
      // attestation chain is not server-verifiable. Only Android Key Attestation
      // is verified today, so every non-Android SE device lands here.
      reason: 'se_platform_attestation_unverified',
    };
  }

  // Bearer / unknown: preserve existing verification behavior.
  return verifyAttestationCapability(
    params.claimedCapability,
    params.ownerType,
    params.walletSecurityLevel,
  );
}

/**
 * Validate a SEC1 uncompressed P-256 public key hex string. STEP 9
 * (Wave 4): point validity is now established by importing the key via
 * Node webcrypto rather than `@noble/curves/p256.ProjectivePoint`.
 * webcrypto's importKey for ECDSA P-256 raw rejects malformed or
 * off-curve points, which is exactly what we want here.
 */
async function validateSEC1P256PublicKey(hex: string): Promise<boolean> {
  if (typeof hex !== 'string') return false;
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length !== 130) return false; // 65 bytes * 2 hex chars
  if (!clean.startsWith('04')) return false;
  if (!/^[0-9a-fA-F]+$/.test(clean)) return false;
  try {
    const subtle = (crypto as unknown as { webcrypto: webcrypto.Crypto }).webcrypto.subtle;
    await subtle.importKey(
      'raw',
      Buffer.from(clean, 'hex'),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate device-specific credentials with pdk_/pds_ prefixes.
 * Reuses the same scrypt hashing as agent wallet credentials.
 */
async function prepareDeviceCredentials(
  suppliedKey?: string,
  suppliedSecret?: string,
): Promise<{
  device_key: string;
  device_secret: string;
  device_key_prefix: string;
  device_key_hash: string;
  device_key_salt: string;
}> {
  if ((suppliedKey === undefined) !== (suppliedSecret === undefined)) {
    throw new Error('device_key and device_secret must be supplied together');
  }
  const device_key = suppliedKey ?? ('pdk_' + crypto.randomBytes(16).toString('hex'));
  const device_secret = suppliedSecret ?? ('pds_' + crypto.randomBytes(32).toString('hex'));
  if (!/^pdk_[a-f0-9]{32}$/.test(device_key)
    || !/^pds_[a-f0-9]{64}$/.test(device_secret)) {
    throw new Error('client-supplied device credentials have an invalid format');
  }
  const device_key_prefix = device_key.slice(0, 20);

  // Hash with device-specific key+secret (same scrypt params)
  const salt = crypto.randomBytes(32).toString('hex');
  const combined = `${device_key}:${device_secret}`;

  const hash = await new Promise<string>((resolve, reject) => {
    crypto.scrypt(combined, salt, 64, {
      N: 16384,
      r: 8,
      p: 1,
    }, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(derivedKey.toString('hex'));
    });
  });

  return {
    device_key,
    device_secret,
    device_key_prefix,
    device_key_hash: hash,
    device_key_salt: salt,
  };
}

async function deviceCredentialsMatch(
  deviceKey: string,
  deviceSecret: string,
  deviceDocument: Record<string, unknown>,
): Promise<boolean> {
  const salt = deviceDocument.device_key_salt;
  const expectedHex = deviceDocument.device_key_hash;
  if (typeof salt !== 'string' || typeof expectedHex !== 'string'
    || !/^[a-f0-9]{128}$/.test(expectedHex)) return false;
  const actual = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(`${deviceKey}:${deviceSecret}`, salt, 64, {
      N: 16384,
      r: 8,
      p: 1,
    }, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
  return crypto.timingSafeEqual(actual, Buffer.from(expectedHex, 'hex'));
}

/**
 * Single-use consume of an Android Key Attestation challenge nonce.
 *
 * The nonce is issued by GET /attestation/challenge and baked into the
 * KeyStore key at generateKey() time. Consuming it transactionally (consumed
 * flag + expiry + owner match) gives the server-issued-nonce anti-replay
 * property: a captured chain cannot be replayed because its challenge is
 * single-use and bound to the requesting owner. Returns the nonce bytes on
 * success, or null if the challenge is missing, expired, already used, or owned
 * by someone else (all of which mean "do not promote" - fail closed).
 */
async function consumeAttestationChallenge(
  db: Firestore,
  challengeId: string,
  ownerId: string,
): Promise<Uint8Array | null> {
  const ref = db.collection('device_attestation_challenges').doc(challengeId);
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const data = snap.data() as {
        nonce_b64?: string;
        owner_user_id?: string;
        expires_at?: number;
        consumed?: boolean;
      };
      if (data.consumed === true) return null;
      if (typeof data.expires_at === 'number' && data.expires_at < Date.now()) return null;
      if (data.owner_user_id !== ownerId) return null;
      if (typeof data.nonce_b64 !== 'string' || data.nonce_b64.length === 0) return null;
      tx.update(ref, { consumed: true, consumed_at: Date.now() });
      return new Uint8Array(Buffer.from(data.nonce_b64, 'base64'));
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Register handler (extracted)
// ---------------------------------------------------------------------------
//
// The POST /register handler is exported as a standalone factory so server.ts
// can mount it under a DEDICATED auth middleware (createDeviceRegisterAuth) that
// is the ONLY place the `agent_device_registration` one-time token is honoured.
// All OTHER device routes (GET / DELETE / PATCH, /me, /attestation/challenge)
// stay in createDeviceRouter / createDeviceSelfRouter under the existing
// wallet/device auth and never see that token. See device-register-auth.ts (M1).
//
// Owner context comes ONLY from the Authorization header (resolved upstream into
// req.agentWallet or req.user); the request body never carries owner identity.

export function createRegisterDeviceHandler(deps: DeviceRouterDeps): RequestHandler {
  const { db, cache, peBuffer, recordPEAccrual } = deps;

  return async function registerDevice(req: Request, res: Response): Promise<void> {
    try {
      // Dual auth: agent wallet (req.agentWallet) or human wallet (req.user)
      const agentWallet = req.agentWallet;
      const user = req.user as { id: string; device_id: string } | undefined;

      let ownerId: string;
      let ownerWalletId: string;
      let ownerAddress: string;
      let ownerType: 'human' | 'agent';
      let ownerWalletCreatedAt: number | null = null;
      let walletSecurityLevel: string | null = null;

      if (agentWallet) {
        // Agent wallet auth - device belongs to the agent
        ownerId = agentWallet.id;
        ownerWalletId = agentWallet.id;
        ownerAddress = agentWallet.address || '';
        ownerType = 'agent';
        ownerWalletCreatedAt = Number.isSafeInteger(agentWallet.created_at)
          ? agentWallet.created_at
          : null;
      } else if (user?.id) {
        // Human wallet auth - resolve wallet from user record
        ownerId = user.id;
        ownerType = 'human';

        const walletsQuery = await db.collection('wallets')
          .where('user_id', '==', user.id)
          .limit(1)
          .get();

        ownerWalletId = '';
        ownerAddress = '';
        if (!walletsQuery.empty) {
          const walletData = walletsQuery.docs[0].data();
          ownerWalletId = walletsQuery.docs[0].id;
          ownerAddress = walletData.address || '';
          ownerWalletCreatedAt = Number.isSafeInteger(walletData.created_at)
            ? walletData.created_at
            : null;
          walletSecurityLevel =
            walletData.attested_security_level || walletData.security_level || null;
        }
      } else {
        res.status(401).json({ error: 'Wallet authentication required' });
        return;
      }
      if (!/^0x[0-9a-fA-F]{40}$/.test(ownerAddress)) {
        res.status(409).json({ error: 'owner_wallet_identity_invalid' });
        return;
      }

      const {
        device_name,
        device_type,
        platform,
        attestation_capability,
        signing_method,
        signing_public_key,
        cert_chain,
        challenge_id,
        device_key,
        device_secret,
      } = req.body;

      // --- Validation ---
      if (!device_name || typeof device_name !== 'string' || device_name.length > 100) {
        res.status(400).json({ error: 'device_name is required (max 100 characters)' });
        return;
      }
      if (!device_type || !VALID_DEVICE_TYPES.includes(device_type)) {
        res.status(400).json({ error: `device_type must be one of: ${VALID_DEVICE_TYPES.join(', ')}` });
        return;
      }
      if (!platform || typeof platform !== 'string' || platform.length > 50) {
        res.status(400).json({ error: 'platform is required (max 50 characters)' });
        return;
      }
      const registrationId = getDeviceRegistrationId(req);
      if (registrationId === null) {
        res.status(400).json({
          error: 'A stable Idempotency-Key header (16-128 canonical characters) is required',
        });
        return;
      }
      if (typeof req.headers['idempotency-key'] === 'string'
        && typeof req.body?.registration_id === 'string'
        && req.headers['idempotency-key'].trim() !== req.body.registration_id.trim()) {
        res.status(400).json({ error: 'Idempotency-Key and registration_id disagree' });
        return;
      }
      const attCap = attestation_capability || 'software';
      if (!VALID_ATTESTATION_CAPABILITIES.includes(attCap)) {
        res.status(400).json({ error: `attestation_capability must be one of: ${VALID_ATTESTATION_CAPABILITIES.join(', ')}` });
        return;
      }

      // Signed-submission registration fields (optional; older SDKs don't send them).
      let validatedSigningMethod: 'bearer' | 'secure_enclave_p256' = 'bearer';
      let validatedSigningPublicKey: string | undefined;
      if (signing_method !== undefined) {
        if (signing_method !== 'bearer' && signing_method !== 'secure_enclave_p256') {
          res.status(400).json({ error: 'signing_method must be "bearer" or "secure_enclave_p256"' });
          return;
        }
        validatedSigningMethod = signing_method;
      }
      if (validatedSigningMethod === 'secure_enclave_p256') {
        if (!signing_public_key || typeof signing_public_key !== 'string') {
          res.status(400).json({ error: 'signing_public_key is required when signing_method="secure_enclave_p256"' });
          return;
        }
        const ok = await validateSEC1P256PublicKey(signing_public_key);
        if (!ok) {
          res.status(400).json({ error: 'signing_public_key must be a 65-byte SEC1 uncompressed P-256 point (04 || X || Y, 130 hex chars)' });
          return;
        }
        validatedSigningPublicKey = signing_public_key.startsWith('0x') ? signing_public_key.slice(2) : signing_public_key;
      }

      // --- Android Key Attestation (optional) ---
      // When the client presents a KeyStore-emitted cert_chain plus the
      // challenge_id it baked into the key, verify the chain against Google's
      // hardware-attestation roots and, on success, record a server-VERIFIED
      // attestation tier. Absent or invalid chain means no full-tier promotion:
      // a human secure-enclave signer remains hardware_partial and an agent
      // remains software. Promotion is human-only and requires
      // signing_method='secure_enclave_p256'. Fail-closed: any failure leaves
      // attestedSecurityLevel null. See core/attestation + Security Invariant #7.
      let attestedSecurityLevel: 'hardware_full' | 'hardware_tpm' | null = null;
      let attestationEvidence: DeviceDocument['attestation_evidence'] | undefined;
      let attestationOutcome = 'not_presented';
      if (cert_chain !== undefined || challenge_id !== undefined) {
        if (
          ownerType === 'human' &&
          validatedSigningMethod === 'secure_enclave_p256' &&
          validatedSigningPublicKey &&
          Array.isArray(cert_chain) &&
          typeof challenge_id === 'string' &&
          challenge_id.length > 0
        ) {
          const nonce = await consumeAttestationChallenge(db, challenge_id, ownerId);
          if (!nonce) {
            attestationOutcome = 'challenge_invalid';
          } else {
            const result = await verifyAndroidRegistrationChain({
              certChainB64: cert_chain,
              expectedChallenge: nonce,
              registeredSigningPublicKeyHex: validatedSigningPublicKey,
              cache,
            });
            if (result.ok) {
              attestedSecurityLevel = result.attestedTier;
              attestationEvidence = {
                method: 'android_key_attestation',
                security_level: result.securityLevel,
                boot_state: result.bootState,
                verified_at: Date.now(),
              };
              attestationOutcome = 'verified';
            } else {
              attestationOutcome = result.code;
              console.warn(`[Devices] Android attestation not promoted: ${result.code} (${result.reason})`);
            }
          }
        } else {
          attestationOutcome = 'ignored_invalid_context';
        }
      }

      // --- Verify the claimed attestation capability at registration ---
      // (Audit Pass 2, Fix 2). The PE-submission path already runs verification,
      // but the registration path used to trust the raw claim. That let an
      // agent register `attestation_capability: 'hardware_tpm'` even though
      // every PE it later signed was downgraded to `software`. Compute the
      // verified capability up-front and use it for the device doc and PE
      // metadata; agent hardware eligibility is not an approved policy.
      const attestationVerification = verifyAttestationCapability(
        attCap,
        ownerType,
        walletSecurityLevel,
      );
      const verifiedCap = attestationVerification.verifiedCapability;
      if (attestationVerification.downgraded) {
        console.warn(
          `[Devices] Registration attestation downgrade: claimed=${attCap} → verified=${verifiedCap} (${attestationVerification.reason})`,
        );
      }

      // --- Stable logical ids + credentials ---
      // The registration id is a retry/idempotency key only. It is not a MAC,
      // hardware-attestation requirement, or physical-device mint anchor.
      const now = Date.now();
      const ids = deterministicDeviceRegistrationIds(ownerId, registrationId);
      const deviceId = ids.deviceId;
      let creds: Awaited<ReturnType<typeof prepareDeviceCredentials>>;
      try {
        creds = await prepareDeviceCredentials(
          typeof device_key === 'string' ? device_key : undefined,
          typeof device_secret === 'string' ? device_secret : undefined,
        );
      } catch (error) {
        res.status(400).json({
          error: error instanceof Error ? error.message : 'Invalid device credentials',
        });
        return;
      }

      // VALIDATE BEFORE BURN : the auth middlewares only PRECHECK a
      // one-time setup token; the burn happens HERE, after every syntactic
      // request validation above has passed, so a malformed or mangled paste
      // 400s without consuming the invite. The consume transaction re-runs
      // every precheck condition, so single-use holds under races: a raced
      // second use with a different Idempotency-Key denies 401, and a re-run
      // of the same line idempotently replays.
      if (req.pendingDeviceSetupToken) {
        let burned: boolean;
        try {
          burned = await burnPendingDeviceSetupToken(db, req.pendingDeviceSetupToken, registrationId);
        } catch (error) {
          console.error('[Devices] Setup token burn error:', error);
          res.status(503).json({ error: 'Authentication service temporarily unavailable' });
          return;
        }
        if (!burned) {
          res.status(401).json({ error: 'Invalid or expired registration token' });
          return;
        }
      }

      // --- Build device document ---
      const deviceDoc: DeviceDocument & { network_class: string } = {
        network_class: await ownerParticipantClass(db, ownerWalletId ?? ownerId),
        device_id: deviceId,
        device_name: device_name.trim(),
        device_type,
        platform: platform.trim(),
        owner_wallet_id: ownerWalletId,
        owner_user_id: ownerId,
        owner_address: ownerAddress,
        owner_type: ownerType,
        attestation_capability: verifiedCap,
        device_key_hash: creds.device_key_hash,
        device_key_salt: creds.device_key_salt,
        device_key_prefix: creds.device_key_prefix,
        status: 'active',
        created_at: now,
        last_pe_at: null,
        total_pes: 0,
        signing_method: validatedSigningMethod,
        ...(validatedSigningPublicKey ? { signing_public_key: validatedSigningPublicKey } : {}),
        ...(attestedSecurityLevel ? { attested_security_level: attestedSecurityLevel } : {}),
        ...(attestationEvidence ? { attestation_evidence: attestationEvidence } : {}),
      };

      const canonicalOwnerAddress = /^0x[0-9a-fA-F]{40}$/.test(ownerAddress)
        ? ownerAddress.toLowerCase()
        : null;
      // Every agent with its own wallet draws its own device grant, however it was onboarded,
      // a parent-spawned one included (/10-01; supersedes addendum 3).
      const genesisQualification = ownerWalletId
        && ownerWalletCreatedAt !== null
        && canonicalOwnerAddress !== null
        && shouldEnqueueGenesisQualification('genesis_device_link', now)
        ? buildGenesisQualification({
          actionType: 'genesis_device_link',
          walletId: ownerWalletId,
          economicActorId: ownerId,
          actorAddress: canonicalOwnerAddress,
          // Decided policy: the registered device id is the dedupe anchor.
          // Hardware/MAC/Secure-Enclave evidence is deliberately not required.
          immutableAnchorId: deviceId,
          qualifyingActEvidenceId: `registered-device:${deviceId}`,
          qualifyingActAtMs: now,
          walletCreatedAtMs: ownerWalletCreatedAt,
          walletCreatedEvidenceId: `${ownerType}-wallet:${ownerWalletId}`,
        })
        : null;

      // --- Required device_register PE ---
      // PE METER: a v2 relay act on the owner's chain, priced through its staged intake. The
      // relay keeps no copy; the owner's sealed copy reaches it through the mailbox.
      //
      // Security Invariant #9 (M9): device_register is a device-rate-limited setup PE type
      // deduped by PHYSICAL DEVICE, not by user/wallet. No device anchor
      // (deviceAttestationId) is passed for this accrual, so it records at the lowest tier and
      // mints 0 (the matrix row is record_only for every owner).
      const peId = ids.peId;
      const registerPeContent = deviceRegistrationPeContent({
        ownerWalletId,
        ownerAddress,
        ownerType,
        deviceId,
        deviceName: device_name.trim(),
        deviceType: device_type,
        platform: platform.trim(),
        attestationCapability: verifiedCap,
      });
      const buildRegisterAccrual = (peHashVal: string): RecordPEAccrualParams => ({
        peId,
        userId: ownerId,
        actionType: 'device_register',
        integrationSource: 'device_registration',
        attestationDepth: 'software',
        peHash: peHashVal,
        timestamp: now,
        isDevicePE: true,
        throwOnError: true,
      });

      const requestFingerprint = crypto.createHash('sha256').update(
        stableStringify({
          owner_id: ownerId,
          owner_wallet_id: ownerWalletId,
          owner_type: ownerType,
          device_name: device_name.trim(),
          device_type,
          platform: platform.trim(),
          attestation_capability: attCap,
          signing_method: validatedSigningMethod,
          signing_public_key: validatedSigningPublicKey ?? null,
          challenge_id: typeof challenge_id === 'string' ? challenge_id : null,
          cert_chain_sha256: Array.isArray(cert_chain)
            ? crypto.createHash('sha256').update(stableStringify(cert_chain) || '').digest('hex')
            : null,
        }) || '',
      ).digest('hex');

      let registration: Awaited<ReturnType<typeof commitDeviceRegistration>>;
      try {
        registration = await commitDeviceRegistration({
          db,
          requestDocumentId: ids.requestDocumentId,
          registrationId,
          requestFingerprint,
          ownerId,
          ownerWalletId,
          ownerType,
          deviceId,
          deviceDocument: deviceDoc as unknown as Record<string, unknown>,
          deviceKeyPrefix: creds.device_key_prefix,
          peId,
          createdAtMs: now,
          maxActiveDevices: MAX_DEVICES_PER_WALLET,
          peContent: registerPeContent,
          buildAccrual: buildRegisterAccrual,
          genesisQualification,
          genesisActivationApprovalVerifier: deps.genesisActivationApprovalVerifier,
        });
      } catch (err) {
        if (err instanceof GenesisIngressError && err.code === 'device_limit_exceeded') {
          res.status(400).json({
            error: `Maximum ${MAX_DEVICES_PER_WALLET} active devices per wallet`,
          });
          return;
        }
        console.error(`[Devices] Atomic registration failed for ${ownerId}:`, err);
        res.status(409).json({
          error: err instanceof GenesisIngressError ? err.code : 'device_registration_conflict',
          message: 'Device registration did not commit. Retry with the same Idempotency-Key.',
        });
        return;
      }

      if (!registration.created) {
        const suppliedCredentials = typeof device_key === 'string'
          && typeof device_secret === 'string'
          && await deviceCredentialsMatch(
            device_key,
            device_secret,
            registration.deviceDocument,
          );
        if (!suppliedCredentials) {
          res.status(409).json({
            error: 'device_registration_already_completed_credentials_unavailable',
            device_id: registration.marker.device_id,
            registration_pe_id: registration.marker.pe_id,
            message: 'Retry with the same client-generated device credentials and Idempotency-Key.',
          });
          return;
        }
      }

      // Acknowledge the required setup PE's economic history before returning. If pricing
      // fails, the committed registration marker makes the same request resumable without a
      // second device/PE/outbox; a replay prices whatever is still staged (once priced, the
      // intake is gone and the act key holds the outcome).
      try {
        if (registration.peMetered) {
          const intake = registration.intake ?? await readRelayActIntake(db, registration.marker.pe_id);
          if (intake !== null) {
            if (intake.act.pe_hash !== registration.marker.pe_hash || intake.actor_id !== ownerId) {
              throw new Error('device_registration_intake_mismatch');
            }
            await priceRelayAct(db, intake, { record: recordPEAccrual });
          }
        }
        // A pre-meter registration replayed prices nothing: its accrual landed when it was first
        // committed, and the PE meter migration retired that record into the meter's own state.
      } catch (error) {
        console.error('[Devices] Registration committed but setup PE accrual is pending retry', {
          deviceId,
          peId,
          error: error instanceof Error ? error.message : String(error),
        });
        res.status(503).json({
          error: 'device_registration_accrual_pending',
          device_id: deviceId,
          registration_pe_id: peId,
          retry_with_same_idempotency_key: true,
        });
        return;
      }

      // Device + deterministic Genesis outbox landed in one batch. The standard
      // device_register PE remains a separate setup record (and still mints 0
      // without a physical setup-rate-limit anchor). The Genesis device reward
      // uses only the registered device id and is resumed from its durable state.
      await observeActorSession(db, req, ownerId);
      if (registration.marker.genesis_qualification_id && deps.processGenesisQualification) {
        void deps.processGenesisQualification(registration.marker.genesis_qualification_id)
          .catch((error) => {
            console.warn('[Devices] Genesis qualification remains queued', {
              qualificationId: registration.marker.genesis_qualification_id,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }

      // Honest device Genesis status. A refused-but-retained in-window act reports
      // `retained_pending_activation`, not silence — the grant survives for backfill.
      // `not_qualified` is reserved for an act that never qualified in the first place.
      const genesisQualificationStatus =
        registration.genesisDisposition === 'retained'
          ? 'retained_pending_activation'
          : registration.genesisDisposition === 'persisted'
            ? 'queued'
            : 'not_qualified';

      // HIGH-8 (Wave 4): keep the wallet's Commons profile attestation_tier
      // in sync with its devices. Fire-and-forget so device registration
      // never blocks on a stale Commons projection.
      import('../core/commons/wallet-reads')
        .then((m) => m.recomputeCommonsAttestationTier({ db }, ownerWalletId))
        .catch(() => {});

      // --- Response ---
      res.status(201).json({
        device_id: deviceId,
        device_key: creds.device_key,
        device_secret: creds.device_secret,
        device_name: device_name.trim(),
        owner_wallet_id: ownerWalletId,
        owner_type: ownerType,
        attribution: buildDeviceAttributionContext(ownerWalletId, ownerType),
        registration_pe_id: peId,
        idempotent_replay: !registration.created,
        genesis_qualification_status: genesisQualificationStatus,
        attestation: {
          outcome: attestationOutcome,
          attested_security_level: attestedSecurityLevel,
        },
        message: 'Device registered. PEs from this device are attributed to this wallet; contributor routing follows the verified beneficiary relationship sealed with each PE. Add the credentials below to your shell profile.',
        env_vars: {
          PROVIAN_DEVICE_KEY: creds.device_key,
          PROVIAN_DEVICE_SECRET: creds.device_secret,
          PROVIAN_RELAY_URL: 'https://api.provian.ai',
        },
      });
    } catch (error) {
      console.error('[Devices] Registration error:', error);
      res.status(500).json({ error: 'Device registration failed' });
    }
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createDeviceRouter(deps: DeviceRouterDeps): Router {
  const { db, cache, peBuffer, recordPEAccrual } = deps;
  const router = Router();
  const authenticateDevice = createDeviceAuthMiddleware(db);

  // NOTE: POST /register is NOT mounted here. It is mounted in server.ts under
  // the dedicated createDeviceRegisterAuth middleware so the one-time
  // agent_device_registration token is honoured ONLY on that single route.
  // See createRegisterDeviceHandler above and Security Invariant M1.

  // =========================================================================
  // GET /attestation/challenge - Issue an Android Key Attestation nonce
  // (wallet auth - handled upstream). The client bakes this nonce into a fresh
  // KeyStore key via setAttestationChallenge(), then presents the emitted cert
  // chain at /register. Human wallets only; agents never earn hardware tiers.
  // =========================================================================
  router.get('/attestation/challenge', async (req: Request, res: Response) => {
    try {
      const agentWallet = req.agentWallet;
      const user = req.user as { id: string } | undefined;
      if (agentWallet) {
        res.status(400).json({ error: 'Attestation challenges are not issued to agent wallets' });
        return;
      }
      if (!user?.id) {
        res.status(401).json({ error: 'Wallet authentication required' });
        return;
      }
      const challengeId = `att_${uuidv4()}`;
      const nonce = crypto.randomBytes(32);
      const now = Date.now();
      const ttlMs = 10 * 60 * 1000; // 10 minutes
      await db.collection('device_attestation_challenges').doc(challengeId).set({
        challenge_id: challengeId,
        owner_user_id: user.id,
        nonce_b64: nonce.toString('base64'),
        created_at: now,
        expires_at: now + ttlMs,
        consumed: false,
      });
      res.json({
        challenge_id: challengeId,
        challenge: nonce.toString('base64'),
        expires_at: now + ttlMs,
      });
    } catch (error) {
      console.error('[Devices] Attestation challenge error:', error);
      res.status(500).json({ error: 'Failed to issue attestation challenge' });
    }
  });

  // =========================================================================
  // GET / - List registered devices (wallet auth)
  // =========================================================================
  router.get('/', async (req: Request, res: Response) => {
    try {
      const agentWallet = req.agentWallet;
      const user = req.user as { id: string } | undefined;
      const ownerId = agentWallet ? agentWallet.id : user?.id;
      const ownerType: 'human' | 'agent' = agentWallet ? 'agent' : 'human';
      if (!ownerId) {
        res.status(401).json({ error: 'Wallet authentication required' });
        return;
      }

      const snapshot = await db.collection('devices')
        .where('owner_user_id', '==', ownerId)
        .where('owner_type', '==', ownerType)
        .orderBy('created_at', 'desc')
        .get();

      const devices: Array<Record<string, unknown>> = [];
      for (const doc of snapshot.docs) {
        const rawDevice = doc.data();
        if (
          !hasValidDeviceOwnerType(rawDevice)
          || rawDevice.owner_type !== ownerType
          || rawDevice.owner_user_id !== ownerId
        ) {
          res.status(403).json({ error: 'Invalid device ownership record' });
          return;
        }
        const d = rawDevice as unknown as DeviceDocument;
        devices.push({
          device_id: d.device_id,
          device_name: d.device_name,
          device_type: d.device_type,
          platform: d.platform,
          status: d.status,
          owner_wallet_id: d.owner_wallet_id,
          owner_type: d.owner_type,
          attribution: buildDeviceAttributionContext(d.owner_wallet_id, d.owner_type),
          attestation_capability: d.attestation_capability,
          last_pe_at: d.last_pe_at,
          total_pes: d.total_pes,
          created_at: d.created_at,
          capture_status: d.capture_status ?? null,
        });
      }

      res.json({ devices, count: devices.length });
    } catch (error) {
      console.error('[Devices] List error:', error);
      res.status(500).json({ error: 'Failed to list devices' });
    }
  });

  // Note: GET /v1/devices/me is mounted separately in server.ts (via
  // createDeviceSelfRouter below) because it uses DeviceKey auth, not the
  // wallet-auth middleware that wraps this router.

  // =========================================================================
  // DELETE /:device_id - Revoke a device (wallet auth)
  // =========================================================================
  router.delete('/:device_id', async (req: Request, res: Response) => {
    try {
      const agentWallet = req.agentWallet;
      const user = req.user as { id: string } | undefined;
      const ownerId = agentWallet ? agentWallet.id : user?.id;
      const ownerType: 'human' | 'agent' = agentWallet ? 'agent' : 'human';
      if (!ownerId) {
        res.status(401).json({ error: 'Wallet authentication required' });
        return;
      }

      const { device_id } = req.params;
      const deviceDoc = await db.collection('devices').doc(device_id).get();

      if (!deviceDoc.exists) {
        res.status(404).json({ error: 'Device not found' });
        return;
      }

      const rawDevice = deviceDoc.data();
      // Check both owner_user_id AND owner_type to prevent cross-type auth bypass
      if (
        !hasValidDeviceOwnerType(rawDevice)
        || rawDevice.owner_type !== ownerType
        || rawDevice.owner_user_id !== ownerId
      ) {
        res.status(403).json({ error: 'Not your device' });
        return;
      }
      const device = rawDevice as unknown as DeviceDocument;

      if (device.status === 'revoked') {
        res.status(400).json({ error: 'Device is already revoked' });
        return;
      }

      // Revoke the device
      await db.collection('devices').doc(device_id).update({ status: 'revoked' });

      // Invalidate cache
      await invalidateDeviceCache(db, device_id);

      // Generate device_revoke PE
      // Phase 3 (G-1, Theme 8): same atomic chain advance as register.
      const now = Date.now();
      const peId = `pe_${uuidv4()}`;
      // PE METER: a v2 relay act on the owner's chain (record-only), priced through its staged
      // intake; the relay keeps no copy.
      let staged: Awaited<ReturnType<typeof advanceRelayAct>>;
      try {
        staged = await advanceRelayAct(db, {
          actorId: ownerId,
          walletId: device.owner_wallet_id,
          ownerType,
          peId,
          timestamp: now,
          actionType: 'device_revoke',
          content: {
            wallet_id: device.owner_wallet_id,
            actor_address: device.owner_address,
            attestation_type: 'software',
            metadata: {
              device_id,
              device_name: device.device_name,
              reason: 'owner_revoked',
            },
          },
          accrual: (peHash) => ({
            peId,
            userId: ownerId,
            actionType: 'device_revoke',
            integrationSource: 'device_revocation',
            attestationDepth: 'software',
            peHash,
            timestamp: now,
            isDevicePE: true,
          }),
        });
      } catch (err) {
        console.error(`[Devices] Chain tip contention during revoke for ${ownerId}:`, err);
        res.status(409).json({ error: 'chain_contention', message: 'Concurrent PE submission detected. Please retry.' });
        return;
      }
      // Best effort: a staged act the pricing misses is priced by the relay-act replay sweep.
      priceRelayAct(db, staged.intake, { record: recordPEAccrual }).catch(() => {});

      // HIGH-8 (Wave 4): recompute Commons profile attestation_tier
      // - revoking the device may change which tier still applies.
      import('../core/commons/wallet-reads')
        .then((m) => m.recomputeCommonsAttestationTier({ db }, device.owner_wallet_id))
        .catch(() => {});

      res.json({ revoked: true, device_id, revocation_pe_id: peId });
    } catch (error) {
      console.error('[Devices] Revocation error:', error);
      res.status(500).json({ error: 'Device revocation failed' });
    }
  });

  // =========================================================================
  // PATCH /:device_id - Update device name (wallet auth)
  // =========================================================================
  router.patch('/:device_id', async (req: Request, res: Response) => {
    try {
      const agentWallet = req.agentWallet;
      const user = req.user as { id: string } | undefined;
      const ownerId = agentWallet ? agentWallet.id : user?.id;
      const ownerType: 'human' | 'agent' = agentWallet ? 'agent' : 'human';
      if (!ownerId) {
        res.status(401).json({ error: 'Wallet authentication required' });
        return;
      }

      const { device_id } = req.params;
      const { device_name } = req.body;

      if (!device_name || typeof device_name !== 'string' || device_name.length > 100) {
        res.status(400).json({ error: 'device_name is required (max 100 characters)' });
        return;
      }

      const deviceDoc = await db.collection('devices').doc(device_id).get();
      if (!deviceDoc.exists) {
        res.status(404).json({ error: 'Device not found' });
        return;
      }

      const rawDevice = deviceDoc.data();
      if (
        !hasValidDeviceOwnerType(rawDevice)
        || rawDevice.owner_type !== ownerType
        || rawDevice.owner_user_id !== ownerId
      ) {
        res.status(403).json({ error: 'Not your device' });
        return;
      }
      const device = rawDevice as unknown as DeviceDocument;

      if (device.status === 'revoked') {
        res.status(400).json({ error: 'Cannot update a revoked device' });
        return;
      }

      await db.collection('devices').doc(device_id).update({
        device_name: device_name.trim(),
      });

      res.json({ updated: true, device_id, device_name: device_name.trim() });
    } catch (error) {
      console.error('[Devices] Update error:', error);
      res.status(500).json({ error: 'Device update failed' });
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// Device-authenticated self-lookup router
// ---------------------------------------------------------------------------
//
// Mounted separately from the main /v1/devices router because it uses
// DeviceKey auth (the caller is the device itself), not wallet auth (which
// the caller is a user/agent wallet session). Used by `register-device` to
// warn before overwriting existing credentials on a machine that is already
// registered elsewhere.

/**
 * Coerce an untrusted capture-status report body (from the device's observer
 * daemon) into a validated DeviceDocument.capture_status. Everything is boolean-
 * coerced (a non-boolean becomes false — never leaks a raw type onto the doc),
 * `platform` is a bounded string that falls back to the registered device
 * platform, and `updated_at` is stamped server-side. Display-only: this value
 * never influences auth, attestation, or earning. Exported for unit tests.
 */
export function buildDeviceCaptureStatus(
  body: unknown,
  devicePlatform: string,
  now: number,
): NonNullable<DeviceDocument['capture_status']> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const asBool = (v: unknown): boolean => v === true;
  const status: NonNullable<DeviceDocument['capture_status']> = {
    llm_session_enabled: asBool(b.llm_session_enabled),
    platform: typeof b.platform === 'string' ? b.platform.slice(0, 32) : devicePlatform,
    active: asBool(b.active),
    permissions_checked: asBool(b.permissions_checked),
    accessibility: asBool(b.accessibility),
    input_monitoring: asBool(b.input_monitoring),
    updated_at: now,
  };
  // Advisory SDK-staleness fields (optional). Only persisted when the daemon
  // actually reports a version string, so older SDKs leave them absent rather
  // than writing a misleading `false`. Bounded + boolean-coerced like the rest.
  if (typeof b.sdk_version === 'string') {
    status.sdk_version = b.sdk_version.slice(0, 32);
    status.sdk_stale = asBool(b.sdk_stale);
    status.sdk_below_min = asBool(b.sdk_below_min);
  }
  return status;
}

/**
 * Validate a daemon-reported capture-health payload into the stored shape.
 *
 * THE WRITE BOUNDARY IS WHERE THE PRIVACY PROMISE IS KEPT. The daemon is
 * trusted to be honest about counts, but nothing is trusted to be free of
 * paths — so every field is reconstructed here from a bounded, typed read of
 * the body, and any key the daemon invented is dropped on the floor. A future
 * SDK cannot start smuggling a database path through this endpoint without
 * changing this function.
 *
 * `broken` is computed SERVER-SIDE from the reported counts rather than taken
 * from the body: whether a device is blind is our judgement to make, not the
 * blind device's.
 */
/** what restarts the observer (closed set; the SDK's RESTART_MECHANISMS). */
type RestartMechanism = 'systemd' | 'launchd' | 'scheduled_task' | 'cron' | 'shell_rc' | 'agent';
const RESTART_MECHANISMS: ReadonlySet<string> = new Set<RestartMechanism>(
  ['systemd', 'launchd', 'scheduled_task', 'cron', 'shell_rc', 'agent'],
);

export function buildDeviceCaptureHealth(
  body: unknown,
  now: number,
): NonNullable<DeviceDocument['capture_health']> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const int = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
  const msOrNull = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
  // Every string this endpoint stores is RENDERED on the ops console and used as
  // a group key. The daemon is trusted for counts, never for freedom from
  // content — so a string is stored ONLY if it matches a safe token shape, and
  // anything else (a path, a project name, a cwd, anything with a slash or a
  // space) is REPLACED by the fallback, never stored mangled. This is where the
  // docblock's "no path can be stored here" is actually enforced; a length clip
  // alone let `harness: "/Users/frank/clients/acme"` through.
  const token = (v: unknown, re: RegExp, fallback: string): string =>
    typeof v === 'string' && re.test(v) ? v : fallback;
  const tokenOrNull = (v: unknown, re: RegExp): string | null =>
    typeof v === 'string' && re.test(v) ? v : null;
  const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;      // harness / version-ish
  const RUNTIME = /^[a-z0-9]{1,16}$/i;              // e.g. node26
  const SCHEMA = /^capture_health\/v[0-9]{1,3}$/;
  const VERDICTS = new Set(['capturing', 'zero_sources', 'idle', 'unknown']);
  const lastVerdict = VERDICTS.has(b.last_verdict as string) ? b.last_verdict as string : 'unknown';

  const rawHarnesses = Array.isArray(b.harnesses) ? b.harnesses.slice(0, 16) : [];
  const harnesses = rawHarnesses.map((h) => {
    const r = (h && typeof h === 'object' ? h : {}) as Record<string, unknown>;
    return {
      harness: token(r.harness, NAME, 'unknown'),
      version: tokenOrNull(r.version, NAME),
      sources: int(r.sources),
      containers: (Array.isArray(r.containers) ? r.containers : [])
        .slice(0, 4)
        // A container is one of a closed set of words. Anything else is dropped
        // rather than stored, so this field can never become a free-text channel.
        .filter((c): c is string => c === 'file' || c === 'sqlite'),
    };
  });

  const HEX = /^[0-9a-f]{8,64}$/;
  const totalSources = harnesses.reduce((n, h) => n + h.sources, 0);
  // OTel witness-lane state (item 5). Booleans are coerced (trusted for the
  // fact, never for content); the timestamp is clamped like every other ms field.
  const otelActive = b.otel_active === true;
  const otelListening = b.otel_receiver_listening === true;
  const otelSpansEverSeen = b.otel_spans_ever_seen === true;
  // Which lane(s) actually WITNESS — derived server-side, deliberately NOT the
  // device's `lanes` claim (same philosophy as `broken`). transcript witnesses
  // when discovery found a readable source; otel witnesses only when the receiver
  // is active AND listening AND has actually seen a span — a listening-but-silent
  // receiver (the OpenClaw exporter defect) is NOT a witness.
  const transcriptWitnessing = totalSources > 0;
  const otelWitnessing = otelActive && otelListening && otelSpansEverSeen;
  const lanes: 'transcript' | 'otel' | 'both' | 'none' =
    transcriptWitnessing && otelWitnessing ? 'both'
      : transcriptWitnessing ? 'transcript'
        : otelWitnessing ? 'otel'
          : 'none';
  // Lane 5 — the model-endpoint proxy witness lane. Booleans coerced
  // (trusted for the fact, never content); the ms field clamped. It witnesses
  // only when active AND listening AND a turn has actually been seen (same
  // real-witness rule as otel — a listening-but-never-fed shim is not a witness).
  const proxyActive = b.proxy_active === true;
  const proxyListening = b.proxy_listening === true;
  const proxyTurnsEverSeen = b.proxy_turns_ever_seen === true;
  const proxyWitnessing = proxyActive && proxyListening && proxyTurnsEverSeen;
  // Lane 4 — the process witness lane (agent VMs). Booleans coerced (trusted for the fact,
  // never content). It witnesses only when active AND a command act has actually sealed — a lane
  // merely watching an idle box is not a witness, the same real-witness rule as otel/proxy.
  const processActive = b.process_active === true;
  const processWatching = b.process_watching === true;
  const processActsEverSealed = b.process_acts_ever_sealed === true;
  const processWitnessing = processActive && processActsEverSealed;
  // the lane's own state, from a CLOSED set (never a raw string).
  // (the correction): capture breaks, with the re-record line, when no live
  // process matches the recorded launcher's fingerprint (`launcher_not_seen`), or when the launcher's
  // wrapper changed and the agent's own commands did not re-record it (`launcher_changed` from a daemon
  // that marks it a flag; also its harness running only inside one of its commands). The suspicion
  // that precedes it (`launcher_unconfirmed`) is never shown: any `provian` command run under the
  // launcher re-records the wrapper, and a matching command clears it. A daemon from before the ruling
  // said `launcher_changed` for that suspicion too, so without `process_launcher_change_confirmed` it
  // is read as the suspicion.
  const PROCESS_LANE_STATES = new Set(['active', 'inert_other_lane', 'no_launcher', 'launcher_not_seen', 'launcher_unconfirmed', 'launcher_changed', 'launcher_unsupported', 'unsupported_platform']);
  const processLaneState = PROCESS_LANE_STATES.has(b.process_lane_state as string) ? (b.process_lane_state as string) : null;
  // How long the state has stood, by the daemon's clock; placed on the relay's clock here, so a
  // sandbox clock that is off (a paused VM's can be an hour out) never moves the moment.
  const processLaneStateAgeMs = typeof b.process_lane_state_age_ms === 'number' && Number.isFinite(b.process_lane_state_age_ms) && b.process_lane_state_age_ms >= 0
    ? Math.floor(b.process_lane_state_age_ms) : null;
  const processLaneStateSinceMs = processLaneStateAgeMs !== null && processLaneStateAgeMs < now ? now - processLaneStateAgeMs : null;
  const processChangeConfirmed = b.process_launcher_change_confirmed === true;
  const processLauncherChanged = processActive && processLaneState === 'launcher_changed' && processChangeConfirmed;
  const processLauncherNotSeen = processActive && processLaneState === 'launcher_not_seen';
  // : the harness hands each command to its child itself — the lane mints nothing there.
  const processLauncherUnsupported = processActive && processLaneState === 'launcher_unsupported';
  // follow-up : the lane is this agent's witness (no other lane — the
  // daemon reports `inert_other_lane` when session files, the proxy or OTel witness it) and no
  // launcher is recorded, so it witnesses none of the agent's commands. The fix is the agent's:
  // run "$HOME/.provian/bin/provian" process-lane record once from its own session.
  // Belt and braces for the invariant: a device whose session files, proxy or OTel are producing
  // never shows it, whatever the lane says.
  const processNoLauncher = processActive && processLaneState === 'no_launcher'
    && !transcriptWitnessing && !otelWitnessing && !proxyWitnessing;
  // / (parity): the daemon's independent audit saw the recorded
  // launcher live and starting commands that are past the time they must have sealed by — and none
  // sealed. The relay judges it from the counts, never the device's `broken`.
  const processLauncherLive = b.process_launcher_live === true;
  const processCommandsDue = int(b.process_commands_due_in_window);
  const processCommandsDueSealed = Math.min(int(b.process_commands_due_sealed_in_window), processCommandsDue);
  const processLauncherHeals = int(b.process_launcher_heals_in_window);
  const processLaneSilent = processActive && processLauncherLive && processCommandsDue > 0 && processCommandsDueSealed === 0;
  // item 2: the daemon's LAST self-update outcome — a daemon-only fact the relay cannot re-derive,
  // so it is trusted for the fact (like otel_active/proxy_active) but coerced against a CLOSED enum
  // allowlist, never stored as a raw string. Lets the console see a device frozen on an old release.
  const SELF_UPDATE_OUTCOMES = new Set([
    'no_manifest', 'pending_bundle', 'not_newer', 'rejected', 'node_too_old', 'already_current', 'applied',
  ]);
  const selfUpdateOutcome = SELF_UPDATE_OUTCOMES.has(b.self_update_outcome as string)
    ? (b.self_update_outcome as string) : null;
  // Unrecognized-protocol fingerprints. Group key must be a clean hex
  // token; provider a closed set; method a short uppercase token; count clamped.
  const PROVIDERS = new Set(['anthropic', 'openai', 'xai', 'gemini', 'grok', 'grok_api']);
  const METHOD = /^[A-Z]{1,8}$/;
  const rawProxyFp = Array.isArray(b.proxy_unrecognized) ? b.proxy_unrecognized.slice(0, 32) : [];
  const proxyUnrecognized = rawProxyFp
    .map((s) => {
      const r = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
      const fingerprint = tokenOrNull(r.fingerprint, HEX);
      if (fingerprint === null) return null;
      const provider = typeof r.provider === 'string' && PROVIDERS.has(r.provider) ? r.provider : null;
      const method = token(r.method, METHOD, 'POST');
      return { fingerprint, provider, method, count: int(r.count) };
    })
    .filter((s): s is { fingerprint: string; provider: string | null; method: string; count: number } => s !== null);
  // Blind-but-healthy: agent harness homes the daemon can SEE on the machine,
  // catalogued or not. A closed set of names — anything else is dropped.
  const detectedHarnessHomes = [...new Set((Array.isArray(b.detected_harness_homes) ? b.detected_harness_homes.slice(0, 16) : [])
    .filter((h): h is string => typeof h === 'string' && NAME.test(h)))].sort();
  const SUPERVISION = new Set(['launchd', 'systemd', 'cron', 'scheduled_task', 'detached', 'unknown']);
  const supervisionMethod = (SUPERVISION.has(b.supervision_method as string) ? b.supervision_method : 'unknown') as
    'launchd' | 'systemd' | 'cron' | 'scheduled_task' | 'detached' | 'unknown';
  const cronAlive = b.cron_alive === true ? true : b.cron_alive === false ? false : null;
  // The complete witness-lane set, derived server-side (never the device's claim).
  // no loopback intake lanes (the Grok hooks lane and the local
  // self-report endpoint are retired); a daemon still reporting their fields is
  // ignored — they never name a lane.
  const laneNames: Array<'transcript' | 'otel' | 'model_proxy' | 'process'> = [];
  if (transcriptWitnessing) laneNames.push('transcript');
  if (otelWitnessing) laneNames.push('otel');
  if (proxyWitnessing) laneNames.push('model_proxy');
  if (processWitnessing) laneNames.push('process');
  // sole-witness silence — server-side judgement, mirroring the SDK's
  // `captureBrokenReason`: sources readable and records flowing this window, but
  // ZERO tool calls recognized in an unknown format. Recognized tool-free tails
  // remain healthy. Distinct from a blind harness (no readable
  // sources) and from genuine idle (no records read this window).
  const recordsConsumedInWindow = int(b.records_consumed_in_window);
  const toolCallsRecognizedInWindow = int(b.tool_calls_recognized_in_window);
  const noReadableSources = harnesses.length > 0 && harnesses.some((h) => h.sources === 0);
  const soleWitnessSilent = lastVerdict === 'unknown'
    && totalSources > 0
    && recordsConsumedInWindow > 0
    && toolCallsRecognizedInWindow === 0;
  const formatBrokenPrograms = (Array.isArray(b.format_broken_programs) ? b.format_broken_programs : []).filter((p): p is string => typeof p === 'string' && NAME.test(p)).slice(0, 16);
  const brokenReason: 'no_readable_sources' | 'sole_witness_silence' | 'session_format_broken' | 'process_launcher_changed' | 'process_launcher_not_seen' | 'process_no_launcher' | 'process_launcher_unsupported' | 'process_lane_silence' | null =
    formatBrokenPrograms.length ? 'session_format_broken' : noReadableSources ? 'no_readable_sources'
      : soleWitnessSilent ? 'sole_witness_silence'
        : processLauncherChanged ? 'process_launcher_changed'
          : processLauncherNotSeen ? 'process_launcher_not_seen'
          : processNoLauncher ? 'process_no_launcher'
          : processLauncherUnsupported ? 'process_launcher_unsupported'
          : processLaneSilent ? 'process_lane_silence'
            : null;
  // When the broken state began, for the reasons the lane's own state carries (the daemon keeps the
  // moment a flag was raised across its restarts). Never in the future; null for every other reason.
  const brokenSinceMs = brokenReason !== null && PROCESS_STATE_REASONS.has(brokenReason) ? processLaneStateSinceMs : null;
  return {
    format_broken_programs: formatBrokenPrograms,
    schema: token(b.schema, SCHEMA, 'capture_health/v1'),
    daemon_version: token(b.daemon_version, NAME, ''),
    runtime: token(b.runtime, RUNTIME, ''),
    sqlite_readable: b.sqlite_readable === true,
    harnesses,
    total_sources: totalSources,
    cursor_total: int(b.cursor_total),
    last_verdict: lastVerdict,
    last_verdict_at_ms: msOrNull(b.last_verdict_at_ms),
    last_capture_at_ms: msOrNull(b.last_capture_at_ms),
    otel_active: otelActive,
    otel_receiver_listening: otelListening,
    otel_spans_ever_seen: otelSpansEverSeen,
    otel_last_span_at_ms: msOrNull(b.otel_last_span_at_ms),
    lanes,
    // Lane 5 — model-endpoint proxy witness lane, server-derived.
    proxy_active: proxyActive,
    proxy_listening: proxyListening,
    proxy_turns_ever_seen: proxyTurnsEverSeen,
    proxy_last_turn_at_ms: msOrNull(b.proxy_last_turn_at_ms),
    proxy_unrecognized: proxyUnrecognized,
    // Lane 4 — the process witness lane, server-derived.
    process_active: processActive,
    process_watching: processWatching,
    process_acts_ever_sealed: processActsEverSealed,
    process_last_act_at_ms: msOrNull(b.process_last_act_at_ms),
    process_lane_state: processLaneState,
    process_lane_state_since_ms: processLaneStateSinceMs,
    process_launcher_change_confirmed: processChangeConfirmed,
    process_launcher_live: processLauncherLive,
    process_commands_due_in_window: processCommandsDue,
    process_commands_due_sealed_in_window: processCommandsDueSealed,
    process_launcher_heals_in_window: processLauncherHeals,
    lane_names: laneNames,
    detected_harness_homes: detectedHarnessHomes,
    supervision_method: supervisionMethod,
    cron_alive: supervisionMethod === 'cron' ? cronAlive : null,
    // the shell-startup restart hook — closed set; anything else (or absent) → null.
    restart_hook: b.restart_hook === 'shell_rc' ? 'shell_rc' : null,
    // the restart mechanism the box really got — closed set, else null.
    restart_mechanism: RESTART_MECHANISMS.has(b.restart_mechanism as string)
      ? b.restart_mechanism as RestartMechanism : null,
    last_work_pe_at_ms: msOrNull(b.last_work_pe_at_ms),
    records_consumed_in_window: recordsConsumedInWindow,
    tool_calls_recognized_in_window: toolCallsRecognizedInWindow,
    // item 2 — the daemon's last self-update outcome (closed-enum) + when + to which version.
    self_update_outcome: selfUpdateOutcome,
    self_update_at_ms: msOrNull(b.self_update_at_ms),
    self_update_version: int(b.self_update_version),
    // Server-side judgement, deliberately not the device's claim — and PER
    // HARNESS, not a device total: a device running two harnesses where OpenClaw
    // reads zero and another reads three sums to three, and a total-based rule
    // would call that healthy while OpenClaw is blind. The alarm is "an installed
    // harness we can see NOTHING from" (blind), OR the next layer:
    // readable and records flowing but zero tool calls recognized (sole-witness
    // silence). `broken_reason` says which, so the console and app can tell them apart.
    broken: brokenReason !== null,
    broken_reason: brokenReason,
    broken_since_ms: brokenSinceMs,
    updated_at: now,
  };
}

/** The broken reasons the process lane's own state carries (the daemon reports when that state began). */
const PROCESS_STATE_REASONS: ReadonlySet<string> = new Set(['process_launcher_changed', 'process_launcher_not_seen', 'process_no_launcher', 'process_launcher_unsupported']);
const CAPTURE_BROKEN_REASONS: ReadonlySet<string> = new Set(['no_readable_sources', 'sole_witness_silence', 'session_format_broken', 'process_launcher_changed', 'process_launcher_not_seen', 'process_no_launcher', 'process_launcher_unsupported', 'process_lane_silence']);
type CaptureBrokenReason = NonNullable<NonNullable<DeviceDocument['capture_health']>['broken_reason']>;

/**
 * What the linked-agent list shows of an agent device's stored capture health : the card's
 * truthful "is it receiving now" source. A device doc is written by the relay that judged its last
 * report, and a device that stopped reporting keeps it indefinitely, so the process lane's reasons are
 * judged again here under rules (the correction): a stored
 * `process_launcher_changed` without `process_launcher_change_confirmed` (an older relay's reading of
 * an unconfirmed suspicion) is not broken; a stored `launcher_not_seen` state (which one older relay
 * stored as `process_launcher_changed`, and the next as not broken) is `process_launcher_not_seen`.
 */
export function linkedAgentCaptureFields(ch: Record<string, unknown>, lastPeAt: unknown): {
  last_capture_at_ms: number | null;
  capture_reported_at_ms: number | null;
  capture_broken: boolean;
  capture_broken_reason: CaptureBrokenReason | null;
  capture_receiving: boolean;
  capture_broken_since_ms: number | null;
} {
  let reason: CaptureBrokenReason | null = ch.broken === true
    ? (CAPTURE_BROKEN_REASONS.has(ch.broken_reason as string) ? ch.broken_reason as CaptureBrokenReason : 'no_readable_sources')
    : null;
  if (reason === 'process_launcher_changed' && ch.process_launcher_change_confirmed !== true) reason = null;
  if (ch.process_active === true && ch.process_lane_state === 'launcher_not_seen' && (reason === null || reason === 'process_launcher_changed')) {
    reason = 'process_launcher_not_seen';
  }
  const since = reason === null ? null
    : typeof ch.broken_since_ms === 'number' && ch.broken_reason === reason ? ch.broken_since_ms
      : PROCESS_STATE_REASONS.has(reason) && typeof ch.process_lane_state_since_ms === 'number' ? ch.process_lane_state_since_ms
        : null;
  // The card's "last activity" the last work the daemon witnessed — a session
  // turn, or a command the process lane sealed — never the arrival of the day's batch, which is only
  // the fallback for a device that has reported neither.
  // A daemon's clock is its own: a moment after the relay received the report is never shown.
  const receivedAt = typeof ch.updated_at === 'number' && Number.isFinite(ch.updated_at) ? ch.updated_at : null;
  const witnessed = [ch.last_capture_at_ms, ch.process_last_act_at_ms]
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && receivedAt !== null && v <= receivedAt);
  return {
    last_capture_at_ms: witnessed.length > 0 ? Math.max(...witnessed)
      : typeof lastPeAt === 'number' ? lastPeAt
        : null,
    capture_reported_at_ms: typeof ch.updated_at === 'number' ? ch.updated_at : null,
    capture_broken: reason !== null,
    capture_broken_reason: reason,
    capture_receiving: reason === null,
    // When the broken state began (the process lane's own flags), so the card never reads the last
    // work's arrival as the moment it broke.
    capture_broken_since_ms: since,
  };
}

export function createDeviceSelfRouter(deps: Pick<DeviceRouterDeps, 'db' | 'cache'>): Router {
  const { db } = deps;
  const router = Router();
  const authenticateDevice = createDeviceAuthMiddleware(db);

  // =========================================================================
  // GET /me - Self-lookup for the authenticated device (device auth)
  // Returns enough context for the user to recognize what they'd disconnect.
  // =========================================================================
  router.get('/me', authenticateDevice, async (req: Request, res: Response) => {
    try {
      const device = req.device;
      if (!device) {
        res.status(401).json({ error: 'Device authentication required' });
        return;
      }
      res.json({
        device_id: device.device_id,
        device_name: device.device_name,
        device_type: device.device_type,
        platform: device.platform,
        owner_wallet_id: device.owner_wallet_id,
        owner_user_id: device.owner_user_id,
        owner_type: device.owner_type,
        attribution: buildDeviceAttributionContext(device.owner_wallet_id, device.owner_type),
        created_at: device.created_at,
        last_pe_at: device.last_pe_at,
        total_pes: device.total_pes,
        capture_status: device.capture_status ?? null,
      });
    } catch (error) {
      console.error('[Devices] /me error:', error);
      res.status(500).json({ error: 'Failed to load device info' });
    }
  });

  // =========================================================================
  // PUT /me/capture-status - the device's observer daemon self-reports its
  // LLM-session capture status (device auth). Display-only: this NEVER affects
  // auth, attestation, or earning. Lets the app show "capturing / needs
  // permission / off" for this machine. Best-effort from the daemon side.
  // =========================================================================
  router.put('/me/capture-status', authenticateDevice, async (req: Request, res: Response) => {
    try {
      const device = req.device;
      if (!device) {
        res.status(401).json({ error: 'Device authentication required' });
        return;
      }
      const capture_status = buildDeviceCaptureStatus(
        req.body,
        device.platform,
        Date.now(),
      );
      await db.collection('devices').doc(device.device_id).set({ capture_status }, { merge: true });
      // No cache invalidation needed: capture_status is read by the app via the
      // wallet-authed GET /v1/devices, which reads Firestore directly (fresh).
      // The device-auth cache holds this doc only for auth, which ignores this field.
      res.json({ ok: true, capture_status });
    } catch (error) {
      console.error('[Devices] /me/capture-status error:', error);
      res.status(500).json({ error: 'Failed to update capture status' });
    }
  });

  // =========================================================================
  // PUT /me/capture-health - the observer daemon reports whether it can SEE
  // this machine's agent harness at all (device auth).
  //
  // Added 2026-09-07 after Atlas ran five days with a healthy daemon, valid
  // credentials, a listening receiver and zero readable sources. Nothing was
  // down; the machine was blind, and blind looked exactly like idle. This is the
  // signal that tells them apart. Display + alerting only: it NEVER affects
  // auth, attestation, eligibility, or earning.
  // =========================================================================
  router.put('/me/capture-health', authenticateDevice, async (req: Request, res: Response) => {
    try {
      const device = req.device;
      if (!device) {
        res.status(401).json({ error: 'Device authentication required' });
        return;
      }
      const now = Date.now();
      const capture_health = buildDeviceCaptureHealth(req.body, now);
      // A restarted daemon knows no command it sealed before the restart: keep the last one reported,
      // so the card's last activity never falls back to the batch's arrival.
      // Read fresh: the authenticated device can come from a 30 s cache that predates the last report.
      const prev = await db.collection('devices').doc(device.device_id).get();
      const prevLastAct = (prev.data() as DeviceDocument | undefined)?.capture_health?.process_last_act_at_ms;
      if (capture_health.process_last_act_at_ms === null && typeof prevLastAct === 'number' && Number.isFinite(prevLastAct) && prevLastAct > 0 && prevLastAct <= now) {
        capture_health.process_last_act_at_ms = prevLastAct;
      }
      // Replace the stored report WHOLE (mergeFields, not a deep merge): a deep merge kept
      // fields a daemon no longer sends — 's retired hooks_* / self_report_* read
      // "active" on devices that had closed both lanes (seen on the Grok bot,).
      await db.collection('devices').doc(device.device_id).set({ capture_health }, { mergeFields: ['capture_health'] });
      // the device's own registration time, the fence a daemon applies before
      // minting a snapshot-written (backfilled) transcript turn — turns whose activity
      // predates registration never mint (09-07 backfill ruling).
      const registeredAt = typeof device.created_at === 'number' && Number.isFinite(device.created_at) ? device.created_at : null;
      // An agent's observer polls for Commons mail only when this heartbeat says some waits.
      // A failed read says yes: the poll itself authenticates and finds nothing if nothing waits.
      const mail = device.owner_type === 'agent' && device.owner_wallet_id
        ? { commons_mail_waiting: await deliveryWaiting(db, device.owner_wallet_id).catch(() => true) }
        : {};
      res.json({ ok: true, capture_health, device_registered_at_ms: registeredAt, ...mail });
    } catch (error) {
      console.error('[Devices] /me/capture-health error:', error);
      res.status(500).json({ error: 'Failed to update capture health' });
    }
  });

  return router;
}
