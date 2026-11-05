import { guardedFetch, guardedFetcher } from './guarded-fetch';
import type { HostResolver } from './egress-guard';
import {sealPrivatePricing} from './meter/private-pricing';
import {setOriginPrivacySecret} from './observer/origin-privacy';
/**
 * Provian Agent SDK - ProvianClient
 *
 * Core client for AI agents to connect to Provian Wallet via Cloud Relay.
 * Uses native fetch (Node 18+, Deno, Bun, browsers).
 */

import { execFileSync, execSync } from 'child_process';
import { defaultPeStoreRoot, FsPeStore, type PeStore, type StoredPe } from './meter/pe-store';
import { buildPeV2, newPeId, type PeV2Content } from './meter/pe-builder';
import { createHttpMeterTransport, type MeterTransport } from './meter/transport';
import { MeterBatcher, type MeterBatcherOptions } from './meter/batcher';
import { ArchiveKeeper, createHttpArchiveTransport, type ArchiveKeeperOptions } from './meter/archive';
import { defaultArchiveCacheDir, FileArchiveObjectCache } from './meter/archive-cache';
import { PROVIAN_BASE_PE_ANCHOR } from './presentation-verify';
import type { PeV2 } from './meter-wire';
import { createHash, createHmac, randomBytes } from 'crypto';
import {
  ProvianClientConfig,
  ActionReport,
  ConnectionResult,
  AgentWalletConfig,
  AgentWalletResult,
  AgentWalletRegistrationHandle,
  TrustProfile,
  ActionResult,
  DeviceActionReport,
  DevicePEResult,
  DeviceRecordedPE,
  ActionTypeStatus,
  OriginWitness,
} from './types';
import {
  createAgentWallet,
  getTrustProfile as fetchTrustProfile,
} from './wallet';
import { resumeAgentWalletRegistration } from './pending-wallet-registration';
import { normalizeInputOrigins, INPUT_ORIGINS_MAX_ENTRIES } from './input-origins';
import { outputCitationOrigin, type OutputSignature } from './output-signature';
import {
  deviceOutputKeyRegistrationBody,
  loadOrCreateDeviceOutputKey,
  markDeviceOutputKeyRegistered,
  outputSignatureMatches,
  readOutputSignatureHeader,
  signOutputWithDigestSigner,
  signOutputWithP256Key,
} from './output-signing';
import { drainOutputCitations, enqueueOutputCitation, requeueOutputCitations } from './meter/output-citations';
import { normalizeOutputDigests } from './output-digests';
import { observerDeviceWitness as buildObserverDeviceWitness } from './observer/origin-capture';
import {
  ProvianError,
  ConnectionError,
  PEDescriptionError,
} from './errors';
import {
  signX402Payment,
  buildPaymentHeader,
  decodePaymentRequired,
  selectCompatibleRequirement,
  selectPinnedRequirement,
  parsePinnedPayment,
  decodePaymentResponse,
  type X402PinnedPayment,
  type X402Wallet,
  type PaymentRequired,
  type PaymentRequirement,
  type SignedX402Authorization,
} from './x402-signer';
// The Solana (SVM) x402 signer statically pulls in @solana/web3.js (~750KB),
// which the self-contained bootstrap bundle would otherwise inline even though
// its connect/onboarding flow never signs an x402 payment. Import it as a
// TYPE only here and lazy-load the runtime module inside the x402 fetch flow
// (see loadSvmSigner below), so @solana stays external to the bundle and loads
// only when an agent actually pays a Solana 402. The signer itself is unchanged.
import type { SvmSignedPayment } from './x402-signer-svm';
import { SUBMIT_OBSERVED_PE, QUEUE_OBSERVED_PE } from './observed-submit';
import { SDK_VERSION } from './version';
import { evaluateStaleness, logStaleness } from './sdk-staleness';
import { cliCommand, sdkUpgradeHint } from './cli-command';

// Per-request timeout applied to individual relay fetches. A hung-but-connected
// relay must fail closed per request rather than hang forever (audit Pass-3
// #10/#37). Also the default timeout for each x402 fetch (audit Pass-3 #9).
const DEFAULT_REQUEST_TIMEOUT = 30_000; // 30 seconds

export class ProvianClient {
  private config: ProvianClientConfig & {
    requestTimeout: number;
  };
  private connected: boolean = false;
  private deviceMode: boolean = false;
  /**
   * x402 idempotency memo (audit Pass-3 #9): the signed EIP-3009 authorization
   * per logical payment (url+network+payTo+amount), reused within its validBefore
   * window so a caller retry — even across separate wrapFetchWithX402() calls on
   * this client — reuses the SAME single-use nonce and cannot mint a second
   * settleable authorization. Instance-scoped (not per-wrapper) to also cover the
   * re-wrap case. Pruned as entries expire.
   */
  private x402SignedByPayment: Map<string, SignedX402Authorization> = new Map();
  // Idempotency for Solana x402: a signed versioned tx has a fixed signature, so
  // reusing it on a caller retry re-submits the SAME transaction (deduped
  // on-chain by signature) rather than double-charging. Keyed by payment,
  // expired past the blockhash validity window.
  private x402SvmSignedByPayment: Map<string, SvmSignedPayment & { signedAt: number }> = new Map();

  // --- Agent-SDK staleness signal (advisory; never gates operation) ---------
  // The relay advertises latest / minimum-supported SDK versions via response
  // headers (every call) and GET /v1/sdk/version. We learn them passively on
  // connect + heartbeat, compare against SDK_VERSION, and nudge ONCE. Fail-open.
  private sdkVersionSeen = false; // have we observed the relay's advertised versions yet?
  private sdkWarned = false; // logged the nudge already? (log at most once per instance)
  private sdkStale = false;
  private sdkBelowMin = false;
  private sdkLatest: string | null = null;
  private sdkMinSupported: string | null = null;

  constructor(config: ProvianClientConfig) {
    if(config.deviceSecret) setOriginPrivacySecret(config.deviceSecret);
    this.config = {
      requestTimeout: DEFAULT_REQUEST_TIMEOUT,
      ...config,
    };
    this.deviceMode = !!(config.deviceKey && config.deviceSecret);

    // the relay agent-session channel (connection token → session) is
    // REMOVED. A client is either in DEVICE mode (deviceKey + deviceSecret from
    // register-device — the witness identity that records PEs) or in SOVEREIGN
    // mode (relayUrl only: x402, sovereign work submission with the agent's own
    // key, read-only relay calls). A connectionToken here is a stale integration
    // and is refused rather than silently downgraded.
    const stale = config as { connectionToken?: unknown; agentWalletKeyHex?: unknown };
    if (stale.connectionToken !== undefined || stale.agentWalletKeyHex !== undefined) {
      throw new ConnectionError(
        'connectionToken / agentWalletKeyHex are no longer accepted: the relay agent-session channel was removed. ' +
        `Work on a registered machine is recorded by the observer daemon (${cliCommand('register-device')}); ` +
        "an agent's own claim about its work is never a PE.",
      );
    }
  }

  // ==========================================================================
  // Connection
  // ==========================================================================

  /**
   * Reachability probe against the Provian Relay. Optional: there is no relay
   * session, so this is not required before other methods — an agent's
   * credentials are its device key and its agent API key.
   *
   * In agent mode: a lightweight probe (no session is opened; the connection
   * token expires by TTL rather than being burned here).
   * In device mode: validates credentials with a lightweight ping.
   */
  async connect(): Promise<ConnectionResult> {
    // --- Device mode: validate reachability with the relay ---
    if (this.deviceMode) {
      // Lightweight OPTIONS ping against /v1/devices. Actual credential
      // validation happens on the first PE submit, but connect() must not report
      // success when the relay is UNREACHABLE or the probe is UNAUTHORIZED — the
      // prior code swallowed both and returned { success: true }, telling the
      // agent it was connected to a relay it could not reach (audit Pass-3 #37).
      const url = `${this.config.relayUrl}/v1/devices`;
      let response: Response;
      try {
        response = await this.fetchWithTimeout(url, { method: 'OPTIONS', headers: this.deviceAuthHeaders() });
      } catch (error) {
        // Unreachable relay (network error / timeout): fail CLOSED, not a false
        // success. "Unknown = Block": a connect() that cannot reach the relay is
        // not a connection.
        throw new ConnectionError(`device-mode connect could not reach the relay: ${(error as Error).message}`);
      }
      // An explicit auth rejection means the device credentials are not valid;
      // fail closed instead of returning success (the prior code ignored status).
      if (response.status === 401 || response.status === 403) {
        throw new ConnectionError(
          `device-mode connect was rejected by the relay (HTTP ${response.status}); check deviceKey / deviceSecret`,
        );
      }
      this.connected = true;
      this.enforceSdkVersionFloor();
      return { success: true, agentId: 'device', walletId: 'device' };
    }

    // --- Sovereign mode: no relay identity to exchange. Probe
    // reachability — fail CLOSED on an unreachable relay ("Unknown = Block") —
    // and learn the advertised SDK versions off the response headers. Every
    // authenticated call is signed by the agent's own key at the call site.
    const url = `${this.config.relayUrl}/v1/sdk/version`;
    let probe: Response;
    try {
      probe = await this.fetchWithTimeout(url, { method: 'GET' });
    } catch (error) {
      throw new ConnectionError(`could not reach the relay: ${(error as Error).message}`);
    }
    if (!probe.ok) {
      // A relay that answers but is not serving (5xx / 4xx on a public, ungated
      // route) is not "connected" either — fail closed, same as unreachable.
      throw new ConnectionError(`relay probe returned HTTP ${probe.status}`);
    }
    this.connected = true;
    this.enforceSdkVersionFloor();
    return { success: true, agentId: this.config.agentId ?? 'sovereign', walletId: 'sovereign' };
  }

  /**
   * Check if the client is connected.
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Clear local connection state. there is no relay session to revoke
   * any more — device credentials persist independently and a sovereign client
   * holds no relay identity — so this is local-only and always succeeds.
   */
  async disconnect(): Promise<{ revoked: boolean; error?: string }> {
    if (this.deviceMode) {
      this.connected = false;
      return { revoked: true };
    }

    this.connected = false;
    return { revoked: true };
  }

  // ==========================================================================
  // Action Reporting
  // ==========================================================================

  /**
   * Prompt 2: the `observer_device` witness for origins this client captures.
   * Derived from the registered device id when
   * present; null without a registered device (an unwitnessed / actor-supplied
   * origin is the honest fallback there).
   */
  originWitness(): OriginWitness | null {
    return buildObserverDeviceWitness(this.config.deviceId ?? null, undefined, this.config.signingMethod ?? null);
  }

  /**
   * The observed content of a report, as a PE v2 carries it (PE meter, ).
   * The same fields the v1 device-submit body carried; `cited_pe_ids` is dropped (retired in
   * favour of `input_origins`,). Never a credential.
   */
  private peContentOf(report: ActionReport | DeviceActionReport): PeV2Content {
    const meta = report.metadata || {};
    // Prompt 1: forward-only external input origins. Only ever included when the caller observed
    // origins — `normalizeInputOrigins` returns null for absent, matching the relay's "omit the
    // key" three-state contract. PURE PROVENANCE, ZERO mint effect.
    const normalizedInputOrigins = normalizeInputOrigins(report.input_origins);
    // Trust Layer §2.3: the outputs this work produced (hash + kind + optional public locator).
    const normalizedOutputDigests = normalizeOutputDigests(report.output_digests);
    return {
      action_type: report.actionType,
      ...(report.description !== undefined ? { description: report.description } : {}),
      metadata: {
        ...meta,
        success: ('success' in report) ? report.success : true,
      },
      // Extended structural fields - passed through when provided
      compute: report.compute ?? null,
      geo: report.geo ?? null,
      execution_env: report.execution_env ?? null,
      parent_goal_pe_id: report.parent_goal_pe_id ?? null,
      ...(normalizedInputOrigins !== null ? { input_origins: normalizedInputOrigins } : {}),
      ...(normalizedOutputDigests !== null ? { output_digests: normalizedOutputDigests } : {}),
      // witnessed capture context. Only ever carried when the caller HAS one: an omitted
      // key is the honest "no attested session" signal, and the relay treats absence as the fence
      // holding. Never defaulted, never synthesized here. `in` rather than a cast: the AGENT-mode
      // report shapes do not declare this field.
      ...('economic_session_lineage' in report && report.economic_session_lineage !== undefined
        ? { economic_session_lineage: report.economic_session_lineage }
        : {}),
    };
  }

  // --- PE meter: this device's own PE store ---------------------------------

  private peStorePromise: Promise<PeStore> | null = null;
  private mirrorWarned = false;

  /**
   * This device's PE store (PE meter): the operator's `config.peStore`, or the filesystem store
   * under `config.peStoreRoot` / `PROVIAN_PE_STORE_DIR` / `~/.provian/pe-store`, one directory per
   * device id. A device registered before credentials carried its id learns it from the relay's
   * tip once (that one call needs the relay; every later record does not).
   */
  async getPeStore(): Promise<PeStore> {
    if (!this.peStorePromise) {
      this.peStorePromise = this.openPeStore().catch((err: unknown) => {
        this.peStorePromise = null;
        throw err;
      });
    }
    return this.peStorePromise;
  }

  private async openPeStore(): Promise<PeStore> {
    if (this.config.peStore) {
      if (this.config.deviceId !== undefined && this.config.deviceId !== this.config.peStore.deviceId) {
        throw new ProvianError(
          `peStore belongs to device ${this.config.peStore.deviceId}, not ${this.config.deviceId}`,
          'PE_STORE_DEVICE_MISMATCH',
        );
      }
      return this.config.peStore;
    }
    const deviceId = this.config.deviceId ?? await this.deviceIdFromRelay();
    return new FsPeStore(deviceId, this.config.peStoreRoot ?? defaultPeStoreRoot());
  }

  private async deviceIdFromRelay(): Promise<string> {
    const answer = await this.meterTransport().getTip();
    const body = answer.body as { device_id?: unknown } | null;
    if (answer.status === 200 && body && typeof body.device_id === 'string' && body.device_id.length > 0) return body.device_id;
    throw new ProvianError(
      `this device's id is not in its credentials and the relay could not supply it (${answer.status ?? answer.error ?? 'no answer'})`,
      'DEVICE_ID_UNKNOWN',
    );
  }

  /**
   * The device-authenticated `/v1/meter/*` surface, for a caller that reads it directly (a PE
   * export fetching the anchoring records of received PEs' batches). Needs device credentials.
   */
  createMeterTransport(): MeterTransport {
    if (!this.deviceMode) {
      throw new ProvianError(`The PE meter needs device credentials (${cliCommand('register-device')}).`, 'NO_WITNESS_PATH');
    }
    return this.meterTransport();
  }

  /** The device-authenticated `/v1/meter/*` surface (the batch POST is body-bound). */
  private meterTransport(): MeterTransport {
    return createHttpMeterTransport({
      relayUrl: this.config.relayUrl,
      privacySecret:()=>this.config.deviceSecret??'',
      boundEnvelope: (body, path) => this.deviceSubmitEnvelope(body, { method: 'POST', path }),
      authHeaders: () => this.deviceAuthHeaders(),
      timeoutMs: this.config.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT,
    });
  }

  /**
   * The daily batcher over this device's store (PE meter). The observer daemon runs one; an
   * embedder that records through this client and wants its PEs priced runs one too. It sends only
   * what the store holds; the relay's session-lineage answers reach `onSessionLineageRejected`.
   */
  async createMeterBatcher(options: Partial<Omit<MeterBatcherOptions, 'store' | 'transport'>> = {}): Promise<MeterBatcher> {
    if (!this.deviceMode) {
      throw new ProvianError(`The PE meter needs device credentials (${cliCommand('register-device')}).`, 'NO_WITNESS_PATH');
    }
    return new MeterBatcher({
      ...(this.config.onSessionLineageRejected ? { onSessionLineageRejected: this.config.onSessionLineageRejected } : {}),
      ...options,
      store: await this.getPeStore(),
      transport: this.meterTransport(),
    });
  }

  /**
   * The paid PE Archive keeper over this device's store : uploads closed days while
   * the owner's Archive is on, drops confirmed days older than 30 days after reading them back,
   * and pulls a dropped PE back to present it. `messageSecretKey` is the owner's message key
   * (an agent's: `agentMessageSecretProvider`); without it nothing is dropped. A pulled day is
   * cached as served (sealed ciphertext) beside the filesystem store, so repeated presentations
   * from later CLI calls or a restarted daemon do not re-fetch it; an operator-supplied store gets
   * no file cache unless `objectCache` is passed.
   */
  async createArchiveKeeper(options: Partial<Omit<ArchiveKeeperOptions, 'store' | 'transport'>> = {}): Promise<ArchiveKeeper> {
    if (!this.deviceMode) {
      throw new ProvianError(`The PE Archive needs device credentials (${cliCommand('register-device')}).`, 'NO_WITNESS_PATH');
    }
    const objectCache = options.objectCache !== undefined
      ? options.objectCache
      : this.config.peStore
        ? null
        : new FileArchiveObjectCache(defaultArchiveCacheDir(this.config.peStoreRoot ?? defaultPeStoreRoot()));
    return new ArchiveKeeper({
      anchorContract: PROVIAN_BASE_PE_ANCHOR,
      ...options,
      objectCache,
      store: await this.getPeStore(),
      transport: createHttpArchiveTransport({
        relayUrl: this.config.relayUrl,
        boundEnvelope: (body, path) => this.deviceSubmitEnvelope(body, { method: 'POST', path }),
        authHeaders: () => this.deviceAuthHeaders(),
        timeoutMs: this.config.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT,
      }),
    });
  }

  /**
   * Build one PE v2 from observed content and append it to this device's chain. Optimistic: the
   * PE (and its hardware witness, which binds the chain position) is built against the head read
   * first, and rebuilt if another process appended in between. A known idempotency key answers
   * with the PE already recorded (review 4: a lane that resubmits after a restart).
   */
  private async recordObserved(
    content: PeV2Content,
    idempotencyKey: string | null,
    occurredAtMs: number | null = null,
  ): Promise<{ kind: 'recorded'; stored: StoredPe; replay: boolean } | { kind: 'refused' | 'failed'; reason: string }> {
    const store = await this.getPeStore();
    if (idempotencyKey !== null) {
      const hit = await store.findByIdempotencyKey(idempotencyKey);
      if (hit !== null) return { kind: 'recorded', stored: hit, replay: true };
    }
    // outputs this device received SIGNED since its last PE are cited by this one,
    // witnessed by this device (the act it observed), never declared.
    const citations = drainOutputCitations(store.location);
    if (citations.length > 0) content = this.withOutputCitations(content, store.deviceId, citations);
    const result = await this.recordObservedContent(store, content, idempotencyKey, occurredAtMs);
    if (result.kind !== 'recorded' && citations.length > 0) requeueOutputCitations(store.location, citations);
    return result;
  }

  /** The content with `citations` appended to its `input_origins` (capped), on this device's witness. */
  private withOutputCitations(content: PeV2Content, deviceId: string, citations: readonly OutputSignature[]): PeV2Content {
    const witness = buildObserverDeviceWitness(deviceId, undefined, this.config.signingMethod ?? null);
    const existing = Array.isArray(content.input_origins) ? content.input_origins as unknown[] : [];
    const room = Math.max(0, INPUT_ORIGINS_MAX_ENTRIES - existing.length);
    const added = citations.slice(0, room).map((sig) => outputCitationOrigin(sig, witness));
    return added.length === 0 ? content : { ...content, input_origins: [...existing, ...added] };
  }

  private async recordObservedContent(
    store: PeStore,
    content: PeV2Content,
    idempotencyKey: string | null,
    occurredAtMs: number | null = null,
  ): Promise<{ kind: 'recorded'; stored: StoredPe; replay: boolean } | { kind: 'refused' | 'failed'; reason: string }> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const head = await store.head();
      let pe;
      try {
        if(!this.config.deviceSecret)throw new Error('existing device credential unavailable');
        pe = await buildPeV2({
          content,
          deviceId: store.deviceId,
          prevHash: head.last_pe_hash,
          // The time the lane observed the work happen, never later than now.
          timestampMs: occurredAtMs !== null ? Math.min(occurredAtMs, Date.now()) : Date.now(),
          peId: newPeId(),
          hardwareWitness: this.config.hardwareWitness,
          privacySecret: this.config.deviceSecret,
        });
      } catch (err) {
        return { kind: 'refused', reason: `unhashable PE content (${(err as Error).message})` };
      }
      const appended = await store.append(pe, idempotencyKey !== null ? { idempotencyKey } : {});
      if (appended.ok) {
        if (!appended.replay) this.mirrorPe(appended.stored.pe);
        return { kind: 'recorded', stored: appended.stored, replay: appended.replay };
      }
      if (appended.reason === 'invalid') return { kind: 'refused', reason: appended.detail };
    }
    return { kind: 'failed', reason: 'the PE store head kept moving' };
  }

  /** Operator copy (`config.peMirror`): best-effort, after the append, never blocking the record. */
  private mirrorPe(pe: PeV2): void {
    const mirror = this.config.peMirror;
    if (!mirror) return;
    void Promise.resolve()
      .then(() => mirror(pe))
      .catch((err: unknown) => {
        if (!this.mirrorWarned) {
          this.mirrorWarned = true;
          console.warn(`[Provian] PE mirror failed (the PE is recorded locally regardless): ${(err as Error)?.message ?? String(err)}`);
        }
      });
  }

  /**
   * INTERNAL : observer lanes only — not a public API (see observed-submit.ts).
   * review 4: record a device PE durably at shutdown. the PE meter every observed PE
   * is already recorded locally (no network), so this is the same append as SUBMIT_OBSERVED_PE —
   * kept so the observer's shutdown path reads the same. True when the PE is on disk. Never throws.
   */
  async [QUEUE_OBSERVED_PE](report: DeviceActionReport): Promise<boolean> {
    if (!this.deviceMode) return false;
    try {
      const descCheck = report.description ? validatePEDescription(report.description) : { valid: true };
      if (!descCheck.valid) return false;
      const result = await this.recordObserved(this.peContentOf(report), callerIdempotencyKey(report));
      return result.kind === 'recorded';
    } catch {
      return false;
    }
  }

  /**
   * INTERNAL : the observer daemon's instrumentation lanes, the transcript
   * backfill, and the git post-commit hook record what the machine OBSERVED
   * through this symbol-keyed method (observed-submit.ts, not exported from the
   * package). The public `reportAction` was removed: an agent's own claim about
   * its work is never a PE.
   *
   * Device mode (PE meter, ): builds a PE v2 and appends it to this
   * device's own store — no network. The PE goes to the relay as an act record inside this
   * device's next daily batch; its earnings arrive with that batch's receipt. A locally
   * recorded PE is the lanes' "accepted". A client without device credentials throws
   * NO_WITNESS_PATH.
   */
  async [SUBMIT_OBSERVED_PE](report: ActionReport | DeviceActionReport): Promise<ActionResult | DevicePEResult | DeviceRecordedPE | null> {
    // PE quality pre-validation (Article I)
    // Description is optional. Validate only when provided.
    const descCheck = report.description ? validatePEDescription(report.description) : { valid: true };
    if (!descCheck.valid) {
      if (this.deviceMode) {
        console.warn(`[Provian] PE description rejected locally: ${descCheck.error}. ${descCheck.hint} PE was not submitted. Improve the commit message and recommit.`);
        return null;
      }
      throw new PEDescriptionError(descCheck.error!, 'description', descCheck.hint);
    }

    if (this.deviceMode) {
      this.lastSubmitOutcome = null;
      try {
        const result = await this.recordObserved(this.peContentOf(report), callerIdempotencyKey(report), occurredAtOf(report));
        if (result.kind === 'recorded') {
          this.lastSubmitOutcome = 'accepted';
          return {
            pe_id: result.stored.pe.pe_id,
            pe_hash: result.stored.pe.pe_hash,
            recorded_locally: true,
            ...(result.replay ? { idempotent_replay: true } : {}),
          };
        }
        this.lastSubmitOutcome = result.kind === 'refused' ? 'rejected' : 'failed';
        console.error(`[Provian] PE not recorded (${result.kind}): ${result.reason}`);
        return null;
      } catch (error) {
        // Never block the developer's session
        this.lastSubmitOutcome = 'failed';
        console.error('[Provian] PE record error:', (error as Error).message);
        return null;
      }
    }

    // No device credentials → no witness identity (removed the session;
    // removed self-declaration).
    throw new ProvianError(
      `Observed-PE submission needs device credentials (${cliCommand('register-device')}).`,
      'NO_WITNESS_PATH',
    );
  }

  /**
   * What happened to the LAST device-mode observed-PE record: `accepted` = recorded in this
   * device's PE store (it reaches the relay in the next daily batch), `rejected` = refused
   * locally (content that can never be recorded), `failed` = not recorded (store unavailable).
   * `queued` is no longer produced (the PE store replaced the outbox) and is kept for callers.
   */
  lastSubmitOutcome: 'accepted' | 'queued' | 'rejected' | 'failed' | null = null;

  // ==========================================================================
  // Environment Attestation (Phase 4: Agent Environment Integrity)
  // ==========================================================================

  // ==========================================================================
  // Agent Wallet
  // ==========================================================================

  /**
   * Retired unsafe convenience. Fails before key generation or networking;
   * use loadOrCreatePendingAgentWalletRegistration() to obtain an opaque
   * authenticated handle, then resumeWalletRegistration().
   */
  static async createWallet(config: AgentWalletConfig): Promise<AgentWalletResult> {
    return createAgentWallet(config);
  }

  static async resumeWalletRegistration(
    handle: AgentWalletRegistrationHandle,
  ): Promise<AgentWalletResult> {
    return resumeAgentWalletRegistration(handle);
  }

  /**
   * Fetch the unified trust profile for any wallet address.
   * Works for both human and agent wallets - one trust graph.
   */
  async getTrustProfile(
    address: string,
    auth: { apiKey: string; apiSecret: string },
  ): Promise<TrustProfile> {
    // the read authenticates with the agent's own API key (the relay
    // accepts wallet auth OR agent API auth on /v1/trust/profile); there is no
    // relay session to present any more.
    return fetchTrustProfile(this.config.relayUrl, address, `${auth.apiKey}:${auth.apiSecret}`);
  }

  // ==========================================================================
  // Internal Helpers
  // ==========================================================================

  /**
   * Build device auth headers for PE submission.
   *
   * When `signingMethod === 'secure_enclave_p256'`, this only emits the
   * static DeviceKey header - the per-payload signature headers are added
   * by `deviceSignatureHeaders()` because they depend on the body. Callers
   * that submit signed payloads should merge both.
   */
  private deviceAuthHeaders(): Record<string, string> {
    return {
      'Authorization': `DeviceKey ${this.config.deviceKey}:${this.config.deviceSecret}`,
    };
  }

  /**
   * Best-effort: report this device's LLM-session capture status to the relay
   * (PUT /v1/devices/me/capture-status, device auth). Display-only — the relay
   * uses it purely to show "capturing / needs permission / off" in the app; it
   * never gates auth, attestation, or earning. Never throws: a status heartbeat
   * must not disrupt the observer. No-op when not in device mode.
   */
  async reportCaptureStatus(status: {
    llm_session_enabled: boolean;
    platform: string;
    active: boolean;
    permissions_checked: boolean;
    accessibility: boolean;
    input_monitoring: boolean;
    // Advisory SDK-staleness fields, surfaced in the phone's device view so an
    // operator can see a stale agent at a glance. Display-only, like the rest.
    sdk_version?: string;
    sdk_stale?: boolean;
    sdk_below_min?: boolean;
  }): Promise<void> {
    if (!this.config.deviceKey || !this.config.deviceSecret) return;
    try {
      await this.fetchWithTimeout(`${this.config.relayUrl}/v1/devices/me/capture-status`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...this.deviceAuthHeaders() },
        body: JSON.stringify(status),
      });
    } catch {
      // Best-effort heartbeat: swallow network/timeout errors.
    }
  }

  /**
   * Best-effort: report whether this device's observer can SEE its agent
   * harness at all (PUT /v1/devices/me/capture-health, device auth).
   *
   * Sibling of `reportCaptureStatus`, answering a different question. That one
   * says whether the AI-foreground capture plugin has its OS permissions; this
   * one says whether the transcript watcher found anything readable. Atlas ran
   * five days with a healthy daemon, valid credentials and a listening receiver
   * while its harness had moved its records somewhere the watcher did not look —
   * from the relay's side, indistinguishable from an idle agent. This closes
   * that.
   *
   * Structure only: names, versions, counts, integers, timestamps. Never a path,
   * a table name, a session id, or content — and the relay reconstructs the
   * document field by field at the write boundary, so the promise does not rest
   * on this call site alone. Display and alerting only; never gates auth,
   * attestation, eligibility, or earning. Never throws.
   */
  async reportCaptureHealth(report: Record<string, unknown>): Promise<{ deviceRegisteredAtMs: number | null; commonsMailWaiting: boolean } | null> {
    if (!this.config.deviceKey || !this.config.deviceSecret) return null;
    try {
      const res = await this.fetchWithTimeout(`${this.config.relayUrl}/v1/devices/me/capture-health`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...this.deviceAuthHeaders() },
        body: JSON.stringify({private_request:sealPrivatePricing({request:report},this.config.deviceSecret,'provian-private-request:v1:/v1/devices/me/capture-health')}),
      });
      // the relay answers with the device's registration time — the fence
      // before which a backfilled (snapshot-written) transcript turn never mints.
      if (!res || typeof (res as Response).json !== 'function' || !(res as Response).ok) return null;
      const body = await (res as Response).json() as { device_registered_at_ms?: unknown; commons_mail_waiting?: unknown };
      const ms = body?.device_registered_at_ms;
      // Agent devices only: the relay names waiting Commons mail so the observer polls just then.
      return { deviceRegisteredAtMs: typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : null, commonsMailWaiting: body?.commons_mail_waiting === true };
    } catch {
      // Best-effort heartbeat: swallow network/timeout errors. A daemon that
      // cannot report its health must still capture.
      return null;
    }
  }

  /** the relay URL that serves the signed daemon-release manifest (public). */
  releaseManifestUrl(): string {
    return `${this.config.relayUrl}/v1/catalog/release`;
  }

  /**
   * the FIXED relay URL the daemon downloads its own bundle from. NOT
   * taken from the manifest — the manifest only names the bytes' hash, and the
   * download location is pinned to the relay so a signed manifest can never
   * redirect the fetch to another host.
   */
  bundleDownloadUrl(): string {
    return `${this.config.relayUrl}/v1/bootstrap/agent.js`;
  }

  /**
   * fetch the signed release-manifest envelope (public, unauthenticated
   * its integrity is the Ed25519 signature). Returns the parsed body + its byte
   * length so the caller can enforce a size cap before verifying. THROWS on any
   * transport/HTTP/parse fault; the self-updater catches it and keeps running.
   *
   * (1B): a `409` is NOT a fault — it means the relay has a signed manifest
   * but the bundle it names is not (yet) the one this revision serves (a publish is
   * mid-flight). Returned as `{ pending: true }` so the self-updater retries on its
   * next tick rather than waiting a full poll interval, and never fail-closes on a
   * hash mismatch it could not have avoided.
   */
  async fetchReleaseManifest(url: string = this.releaseManifestUrl()): Promise<{ body: unknown; bytes: number; pending?: boolean }> {
    const res = await this.fetchWithTimeout(url, { method: 'GET', headers: { accept: 'application/json' } });
    if (res.status === 409) {
      // Drain the body so the connection can be reused; its content is advisory.
      try { await res.text(); } catch { /* ignore */ }
      return { body: null, bytes: 0, pending: true };
    }
    if (!res.ok) {
      throw new ProvianError(`release manifest fetch failed: HTTP ${res.status}`, 'RELEASE_FETCH_FAILED');
    }
    const text = await res.text();
    return { body: JSON.parse(text), bytes: Buffer.byteLength(text, 'utf8') };
  }

  /**
   * download the release bundle bytes from the fixed relay URL. Returns
   * the raw bytes; the self-updater verifies them against the SIGNED manifest's
   * hash before anything runs. THROWS on transport/HTTP fault or an over-cap body.
   */
  async fetchReleaseBundle(url: string = this.bundleDownloadUrl(), maxBytes = 16 * 1024 * 1024): Promise<Buffer> {
    const res = await this.fetchWithTimeout(url, { method: 'GET', headers: { accept: 'application/javascript' } });
    if (!res.ok) {
      throw new ProvianError(`release bundle fetch failed: HTTP ${res.status}`, 'RELEASE_BUNDLE_FETCH_FAILED');
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) {
      throw new ProvianError(`release bundle too large: ${buf.length} bytes`, 'RELEASE_BUNDLE_TOO_LARGE');
    }
    return buf;
  }

  /**
   * Canonicalize a PE submission payload for signing.
   *
   * The relay recomputes this exact representation before verifying the
   * signature, so both sides must agree on the byte-exact form. We pick the
   * smallest spec that still round-trips faithfully:
   *   - JSON.stringify with sorted top-level-and-below keys
   *   - Strip members whose value is `undefined` (JSON.stringify already does)
   *   - No trailing whitespace
   * Nested objects are sorted recursively, arrays are kept in order.
   *
   * This is exported via the default canonicalizer used by the observed-PE submitter
   * so the relay's DeviceSignature middleware can mirror it exactly.
   */
  private static canonicalizePayload(value: unknown): string {
    return ProvianClient.stableStringify(value);
  }

  private static stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return '[' + value.map(v => ProvianClient.stableStringify(v)).join(',') + ']';
    }
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = (value as Record<string, unknown>)[k];
      if (v === undefined) continue;
      parts.push(JSON.stringify(k) + ':' + ProvianClient.stableStringify(v));
    }
    return '{' + parts.join(',') + '}';
  }

  /**
   * Sign a canonical PE submission payload using the Secure Enclave key.
   *
   * Shells out to `provian-se-sign --sign --key-alias <alias> --hash <hex>`.
   * The CLI returns `{r, s}` as hex strings; we concatenate them into the
   * 64-byte compact P-256 signature format that @noble/curves verifies.
   *
   * Exposed as `public` so integration tests and custom transports can
   * reuse the same canonicalization and signing logic the SDK uses
   * internally for PE submission.
   */
  async signPayloadWithSecureEnclave(
    payload: unknown,
  ): Promise<{ signatureBase64: string; hashHex: string; canonical: string }> {
    if (this.config.signingMethod !== 'secure_enclave_p256') {
      throw new ProvianError(
        'signPayloadWithSecureEnclave called without signingMethod=secure_enclave_p256',
        'SIGNING_METHOD_MISMATCH',
      );
    }

    const canonical = ProvianClient.canonicalizePayload(payload);
    const hashHex = createHash('sha256').update(canonical, 'utf8').digest('hex');
    const signatureBase64 = await this.runSeSignCli(hashHex);
    return {
      signatureBase64,
      hashHex,
      canonical,
    };
  }

  /**
   * Produce the headers + wire body for a PE submission.
   *
   * Branching by signing method:
   *   - secure_enclave_p256: canonicalize the body and emit a BOUND-PREIMAGE
   *     X-Provian-Signature (BLOCKER-4 fix, 2026-05-06). The signature is
   *     over a JSON envelope that binds method, path, body sha256, iat, exp,
   *     a 128-bit jti, and the deployment audience - closing the indefinite-
   *     replay window the previous raw-body signature opened. Wire body is
   *     still the canonical body string so the server hashes the same bytes
   *     the envelope's bh field commits to. Header shape:
   *       X-Provian-Signature: <preimage_b64u>.<sig_b64u>
   *   - bearer (default): JSON.stringify the body and attach DeviceKey.
   *
   * SDK + relay are upgraded in lockstep; older SDKs that emit a raw
   * signature receive a clear 401 with code SIG_HEADER_FORMAT.
   */
  /**
   * Headers + exact wire body for a body-bound device POST (the PE meter batch).
   */
  private async deviceSubmitEnvelope(
    body: Record<string, unknown>,
    bindings: { method: string; path: string },
  ): Promise<{ headers: Record<string, string>; body: string }> {
    if(this.config.deviceSecret&&!body.private_batch&&!body.private_request)body={private_request:sealPrivatePricing({request:body},this.config.deviceSecret,'provian-private-request:v1:'+bindings.path)};
    if (this.config.signingMethod === 'secure_enclave_p256') {
      if (!this.config.deviceId) {
        throw new ProvianError(
          'deviceId is required when signingMethod=secure_enclave_p256',
          'DEVICE_ID_MISSING',
        );
      }
      const canonical = ProvianClient.canonicalizePayload(body);
      const bh = createHash('sha256').update(canonical, 'utf8').digest('hex');
      const iat = Math.floor(Date.now() / 1000);
      const envelope = {
        mth: bindings.method,
        pth: bindings.path,
        bh,
        iat,
        exp: iat + 300,
        jti: randomBytes(16).toString('hex'),
        aud: this.config.deviceSignatureAudience || 'provian-relay-prod',
      };
      const preimageJson = JSON.stringify(envelope);
      const preimageB64u = Buffer.from(preimageJson, 'utf8').toString('base64url');
      // SE signs sha256(preimageB64u) - the same digest the relay verifier
      // computes over the b64url string.
      const digest = createHash('sha256').update(preimageB64u, 'utf8').digest('hex');
      const sigCompact = await this.runSeSignCli(digest);
      const sigB64u = Buffer.from(sigCompact, 'base64').toString('base64url');
      return {
        body: canonical,
        headers: {
          'Authorization': `DeviceSignature ${this.config.deviceId}`,
          'X-Provian-Signature': `${preimageB64u}.${sigB64u}`,
          'X-Provian-Pubkey-Id': this.config.deviceId,
          // Existing credential is used only for private pricing, never as an SE auth fallback.
          ...(this.config.deviceSecret ? {'X-Provian-Privacy-Credential': `${this.config.deviceKey}:${this.config.deviceSecret}`} : {}),
        },
      };
    }
    // Bearer (DeviceKey) path. bind the EXACT wire body to the device
    // secret so the relay counts this submission as body-bound (`deviceBodyBound`
    // in devices.ts), which is the gate for device-witnessed VERIFIED earning.
    // hex(hmac-sha256(deviceSecret, rawBody)) over the exact string sent, mirrored
    // byte-for-byte by the relay's X-Provian-Body-HMAC check. A bearer daemon that
    // does not send this stays authenticated but record_only, unchanged.
    const wireBody = JSON.stringify(body);
    const headers = this.deviceAuthHeaders();
    if (this.config.deviceSecret) {
      headers['X-Provian-Body-HMAC'] = createHmac('sha256', this.config.deviceSecret)
        .update(wireBody, 'utf8')
        .digest('hex');
    }
    return { body: wireBody, headers };
  }

  /**
   * Invoke `provian-se-sign` for a single sha256 digest and return the
   * compact P-256 signature as a base64 string. Shared by the new
   * deviceSubmitEnvelope path and the (now-internal) signPayloadWithSecureEnclave
   * helper, so all SE signing flows use the exact same CLI call shape.
   */
  private async runSeSignCli(hashHex: string): Promise<string> {
    if (!this.config.signingKeyAlias) {
      throw new ProvianError(
        'signingKeyAlias is required when signingMethod=secure_enclave_p256',
        'SIGNING_KEY_ALIAS_MISSING',
      );
    }
    const binary = this.resolveSeSignBinary();
    let cliOutput: string;
    try {
      cliOutput = execFileSync(
        binary,
        ['--sign', '--key-alias', this.config.signingKeyAlias, '--hash', hashHex],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (err) {
      throw new ProvianError(
        `provian-se-sign failed: ${(err as Error).message}`,
        'SECURE_ENCLAVE_SIGN_FAILED',
      );
    }
    let parsed: { r?: string; s?: string };
    try {
      parsed = JSON.parse(cliOutput);
    } catch {
      throw new ProvianError(
        'provian-se-sign output was not valid JSON',
        'SECURE_ENCLAVE_SIGN_FAILED',
      );
    }
    if (!parsed.r || !parsed.s || parsed.r.length !== 64 || parsed.s.length !== 64) {
      throw new ProvianError(
        'provian-se-sign returned malformed {r,s}',
        'SECURE_ENCLAVE_SIGN_FAILED',
      );
    }
    return Buffer.concat([
      Buffer.from(parsed.r, 'hex'),
      Buffer.from(parsed.s, 'hex'),
    ]).toString('base64');
  }

  /**
   * Locate `provian-se-sign`. Explicit config wins; otherwise do a PATH
   * lookup. We don't walk candidate directories here - the register-device
   * helper already encoded that logic; if the binary isn't on PATH by the
   * time the SDK is running, the caller should pass `seSignBinary` directly.
   */
  private resolveSeSignBinary(): string {
    if (this.config.seSignBinary) return this.config.seSignBinary;
    try {
      const resolved = execSync('command -v provian-se-sign', {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (resolved) return resolved;
    } catch {
      // fall through
    }
    throw new ProvianError(
      'provian-se-sign not found on PATH and seSignBinary was not provided',
      'SE_SIGN_BINARY_NOT_FOUND',
    );
  }


  /**
   * fetch() with a per-request timeout (AbortController). A hung-but-connected
   * relay must fail closed per request rather than hang forever - "Unknown =
   * Block" (audit Pass-3 #10/#37). A caller-provided init.signal is honored in
   * addition to the timeout. On timeout this throws a ProvianError with code
   * REQUEST_TIMEOUT (distinguishable from a caller-triggered abort).
   */
  private async fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timeoutMs = this.config.requestTimeout;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const callerSignal = init.signal ?? undefined;
    const onCallerAbort = () => controller.abort();
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort();
      else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
    try {
      const res = await guardedFetch(url, { ...init, signal: controller.signal });
      // Passive staleness signal: read the advertised SDK versions off ANY
      // relay response (reading headers never consumes the body). Non-relay
      // URLs won't carry these headers, so this no-ops for them. Wrapped so a
      // missing/odd `headers` object can never break the request — fail-open.
      try {
        const h = (res as Response).headers;
        if (h && typeof h.get === 'function') {
          this.noteSdkVersionHeaders(h.get('X-Provian-SDK-Latest'), h.get('X-Provian-SDK-Min'));
        }
      } catch {
        /* header inspection is advisory only */
      }
      return res;
    } catch (err) {
      if (controller.signal.aborted && !callerSignal?.aborted) {
        throw new ProvianError(`request to ${url} timed out after ${timeoutMs}ms`, 'REQUEST_TIMEOUT');
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
    }
  }

  /**
   * Record the relay's advertised SDK versions (from response headers or the
   * /v1/sdk/version body) and, on the FIRST time we find ourselves stale or
   * below-min, log a nudge once. Recomputes state every call so
   * getSdkStaleness() stays current; the LOG is deduped so heartbeats don't
   * spam. Fail-open: no signal -> no-op, unparseable -> not stale.
   */
  private noteSdkVersionHeaders(latest: string | null, minSupported: string | null): void {
    if (!latest && !minSupported) return; // this response carried no signal
    if (latest) this.sdkLatest = latest;
    if (minSupported) this.sdkMinSupported = minSupported;
    this.sdkVersionSeen = true;
    const verdict = evaluateStaleness(SDK_VERSION, this.sdkLatest, this.sdkMinSupported);
    this.sdkStale = verdict.stale;
    this.sdkBelowMin = verdict.belowMin;
    if (!this.sdkWarned && (verdict.stale || verdict.belowMin)) {
      logStaleness(verdict);
      this.sdkWarned = true;
    }
  }

  /**
   * Current SDK staleness as last learned from the relay. `latest`/`minSupported`
   * are null until the relay has advertised them (older relay, or not yet
   * contacted). Used by the observer to surface staleness in the device record.
   */
  getSdkStaleness(): {
    current: string;
    latest: string | null;
    minSupported: string | null;
    stale: boolean;
    belowMin: boolean;
  } {
    return {
      current: SDK_VERSION,
      latest: this.sdkLatest,
      minSupported: this.sdkMinSupported,
      stale: this.sdkStale,
      belowMin: this.sdkBelowMin,
    };
  }

  /**
   * Connect-time SDK-floor enforcement. The connect request itself already ran
   * through fetchWithTimeout, so a header-advertising relay has already populated
   * the staleness state (and logged the nudge once) by the time we get here. This
   * only enforces the OPT-IN strict floor: refuse to proceed on a below-minimum
   * SDK. Default (strictSdkVersion unset) is fail-open — the loud log stands and
   * the agent keeps operating. Never throws on a relay that doesn't advertise a
   * version (sdkBelowMin stays false), and NEVER affects x402 spending.
   */
  private enforceSdkVersionFloor(): void {
    if (this.config.strictSdkVersion && this.sdkBelowMin) {
      throw new ProvianError(
        `@provian/agent-sdk ${SDK_VERSION} is below the minimum supported ` +
          `${this.sdkMinSupported ?? '(unknown)'}. Update: ${sdkUpgradeHint()}`,
        'SDK_BELOW_MIN',
      );
    }
  }

  /**
   * Explicit staleness pull for callers that want to check without waiting for a
   * heartbeat (e.g. a one-shot CLI). Best-effort GET /v1/sdk/version; swallows
   * every error (fail-open). The passive header path already covers connect and
   * every heartbeat, so this is rarely needed. Returns the current verdict.
   */
  async checkSdkVersion(): Promise<ReturnType<ProvianClient['getSdkStaleness']>> {
    // If a prior relay response already advertised the versions (the common
    // case — every response carries the headers), the verdict is current; skip
    // the redundant network round-trip.
    if (!this.sdkVersionSeen) {
      try {
        const res = await this.fetchWithTimeout(`${this.config.relayUrl}/v1/sdk/version`, { method: 'GET' });
        if (res && (res as Response).ok) {
          const info = (await res.json()) as { latest?: string; minSupported?: string };
          this.noteSdkVersionHeaders(info?.latest ?? null, info?.minSupported ?? null);
        }
      } catch {
        // Fail-open: never let a version probe throw.
      }
    }
    return this.getSdkStaleness();
  }

  // ===========================================================================
  // x402 — autonomous agent micropayments (the agent signs its OWN EIP-3009 with
  // its OWN funded EOA and retries with PAYMENT-SIGNATURE, the v2 paying
  // header). No AAG, budget, kill switch,
  // relay round-trip, or phone — the agent spends its own USDC freely. The
  // crypto + protocol live in ./x402-signer.
  // ===========================================================================

  /**
   * Wrap a fetch so HTTP 402 responses are paid automatically with the agent's
   * OWN wallet: decode the payment requirement, sign an EIP-3009
   * `transferWithAuthorization` locally with the agent's own secp256k1 key, and
   * replay the request with the `PAYMENT-SIGNATURE` header (the x402 v2 paying
   * header; `X-PAYMENT` is the v1 name live sellers ignore). Governance-free by design —
   * this is the agent's own money ("agent's money, agent's rules"); there is no
   * relay, no phone, and no per-call approval.
   *
   * @param wallet the agent's own funded EOA (`{ privateKeyHex, address }`),
   * e.g. from a completed durable registration or `decryptKeystore`.
   * The same self-sovereign key used for signup/link consent.
   * @param options `maxAmountAtomic` (REQUIRED) is the hard per-payment ceiling
   * in USDC atomic units (6 decimals) applied to EVERY 402 before
   * the agent signs — the SDK's own local safety boundary on the
   * ungoverned x402 key (the analogue of the evm-signer allowlist),
   * so a hostile 402 cannot drain the wallet. This is NOT
   * governance (no relay/phone/AAG/kill switch); it is a caller-set
   * spend cap on the agent's own money, and there is no unlimited
   * default. `maxAmountAtomicPerHost` optionally overrides the
   * ceiling per request host (matched against the URL `host`, then
   * `hostname`). On Solana, a Provian facilitator fee carried in
   * `extra.provianFee` counts toward the same ceiling (payment +
   * fee, both USDC). `recordPE` is ignored (an agent's own report of
   * its payment is not a PE; the chain watcher witnesses the settlement).
   * `fetchFn` overrides the underlying fetch. `pinnedPayment` fixes the exact
   * money terms (Base network, recipient, amount) for a payment whose terms the
   * caller already knows, such as Provian's own $1 payout fee and $5 PE Archive GB:
   * only an accepted option with exactly those terms (and the network's USDC) is
   * signed, and a 402 naming anything else is refused before the key signs.
   */
  wrapFetchWithX402(
    wallet: X402Wallet,
    options: {
      maxAmountAtomic: bigint | string;
      maxAmountAtomicPerHost?: Record<string, bigint | string>;
      pinnedPayment?: X402PinnedPayment;
      fetchFn?: typeof fetch;
      /** @deprecated Ignored since the SDK records no x402_payment PE. */
      recordPE?: boolean;
      requestTimeoutMs?: number;
      /** Whole-response byte cap, including 402 and paid bodies. Default: 1 MiB. */
      maxResponseBytes?: number;
      resolveHost?: HostResolver;
    },
  ): typeof fetch {
    const baseFetch = guardedFetcher(options?.fetchFn, options?.resolveHost);
    const maxResponseBytes = options?.maxResponseBytes ?? 1024 * 1024;
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) throw new Error('invalid x402 response byte cap');
    const requestTimeoutMs = options?.requestTimeoutMs ?? this.config.requestTimeout;
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 2_147_483_647) throw new Error('invalid x402 response deadline');

    // The ceiling is required — refuse to build the wrapper without it (also
    // guards untyped JS callers that bypass the required-field type). No
    // unlimited default: the ungoverned key must never sign an uncapped payment.
    if (options === undefined || options === null || options.maxAmountAtomic === undefined || options.maxAmountAtomic === null) {
      throw new ProvianError(
        'wrapFetchWithX402: options.maxAmountAtomic (per-payment USDC ceiling, atomic units) is required — the agent x402 key is ungoverned, so this ceiling is its only spend boundary',
        'X402_CEILING_REQUIRED',
      );
    }
    const parseCeiling = (v: bigint | string, label: string): bigint => {
      let c: bigint;
      try {
        c = typeof v === 'bigint' ? v : BigInt(v);
      } catch {
        throw new ProvianError(`wrapFetchWithX402: ${label} is not a valid integer`, 'X402_CEILING_REQUIRED');
      }
      if (c <= 0n) throw new ProvianError(`wrapFetchWithX402: ${label} must be a positive integer`, 'X402_CEILING_REQUIRED');
      return c;
    };
    // Validate the global ceiling (and each per-host override) eagerly at wrap
    // time so a misconfigured cap fails fast, not mid-payment.
    const globalCeiling = parseCeiling(options.maxAmountAtomic, 'maxAmountAtomic');
    let pinned: ReturnType<typeof parsePinnedPayment> | null = null;
    if (options.pinnedPayment !== undefined) {
      try {
        pinned = parsePinnedPayment(options.pinnedPayment);
      } catch (err) {
        throw new ProvianError(`wrapFetchWithX402: ${(err as Error).message}`, 'X402_PINNED_PAYMENT_INVALID');
      }
    }
    const perHostCeilings = new Map<string, bigint>();
    if (options.maxAmountAtomicPerHost) {
      for (const [host, v] of Object.entries(options.maxAmountAtomicPerHost)) {
        perHostCeilings.set(host.toLowerCase(), parseCeiling(v, `maxAmountAtomicPerHost[${host}]`));
      }
    }
    // Resolve the ceiling that applies to a given request URL: a per-host
    // override (by host, then hostname) wins over the global ceiling.
    const ceilingForUrl = (url: string): bigint => {
      if (perHostCeilings.size === 0) return globalCeiling;
      try {
        const u = new URL(url);
        const byHost = perHostCeilings.get(u.host.toLowerCase());
        if (byHost !== undefined) return byHost;
        const byHostname = perHostCeilings.get(u.hostname.toLowerCase());
        if (byHostname !== undefined) return byHostname;
      } catch {
        /* unparseable URL — fall through to the global ceiling */
      }
      return globalCeiling;
    };

    // Per-request timeout for BOTH the initial and the paid-retry fetch: a
    // facilitator that settles the USDC on-chain but then hangs the HTTP
    // response must not hang the agent forever (audit Pass-3 #9). A
    // caller-provided signal (init.signal or a Request's signal) is honored too.
    const fetchWithTimeout = async (
      arg: Parameters<typeof fetch>[0],
      reqInit?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
      const callerSignal = reqInit?.signal ?? (arg instanceof Request ? arg.signal : undefined);
      const onAbort = () => controller.abort();
      if (callerSignal) {
        if (callerSignal.aborted) controller.abort();
        else callerSignal.addEventListener('abort', onAbort, { once: true });
      }
      try {
        const response = await baseFetch(arg, { ...reqInit, redirect: 'manual', signal: controller.signal });
        const declared = Number(response.headers.get('content-length'));
        if (declared > maxResponseBytes) {
          controller.abort();
          void response.body?.cancel().catch(() => undefined);
          throw new ProvianError(`x402 response exceeds ${maxResponseBytes} bytes`, 'X402_RESPONSE_TOO_LARGE');
        }
        if (!response.body) return response;
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > maxResponseBytes) {
              controller.abort();
              throw new ProvianError(`x402 response exceeds ${maxResponseBytes} bytes`, 'X402_RESPONSE_TOO_LARGE');
            }
            chunks.push(value);
          }
        } catch (err) {
          void reader.cancel().catch(() => undefined);
          throw err;
        }
        const body = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
        const buffered = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
        Object.defineProperty(buffered, 'url', { value: response.url });
        return buffered;
      } catch (err) {
        if (err instanceof ProvianError && err.code === 'X402_RESPONSE_TOO_LARGE') throw err;
        if (err instanceof Error && err.message === 'egress redirect refused') throw new ProvianError('x402 request was redirected', 'X402_REDIRECTED');
        if (controller.signal.aborted && !callerSignal?.aborted) {
          throw new ProvianError(`x402 request timed out after ${requestTimeoutMs}ms`, 'X402_REQUEST_FAILED');
        }
        throw err;
      } finally {
        clearTimeout(timer);
        if (callerSignal) callerSignal.removeEventListener('abort', onAbort);
      }
    };

    // Idempotency guard (audit Pass-3 #9): memoize the signed EIP-3009
    // authorization per logical payment so a CALLER retry (e.g. after a
    // settled-but-lost response) reuses the SAME single-use nonce instead of
    // signing a second, independently-settleable authorization — the token
    // rejects a reused nonce as a replay, so the retry cannot double-charge.
    // Entries are honored only within the authorization's own validBefore window.
    // Lives on the CLIENT (not this closure) so a re-wrap for the same payment is
    // covered too.
    const signedByPayment = this.x402SignedByPayment;
    const svmSignedByPayment = this.x402SvmSignedByPayment;

    // Lazy, memoized load of the Solana signer. Keeping @solana/web3.js off the
    // static import graph is what lets the bootstrap bundle stay lean; it is
    // pulled in only the first time this wrapped fetch handles a Solana 402.
    // (`.js` specifier + dynamic import() matches the codebase's node16 pattern
    // in bootstrap-flow.ts; esbuild resolves it back to the .ts source.)
    let svmSignerMod: typeof import('./x402-signer-svm.js') | null = null;
    const loadSvmSigner = async (): Promise<typeof import('./x402-signer-svm.js')> => {
      if (svmSignerMod) return svmSignerMod;
      const mod = await import('./x402-signer-svm.js');
      svmSignerMod = mod;
      return mod;
    };

    const pay = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
      // Normalize the request up front so the paid 402 RETRY preserves the
      // ORIGINAL method/headers/body. A caller can idiomatically pass a
      // `Request` (e.g. `wrapped(new Request(url, { method:'POST', body }))`)
      // with no second `init`; deriving the retry from `init` alone would
      // silently downgrade it to a bodyless GET AFTER the agent already signed
      // and paid USDC. When `input` is a `Request` we clone it BEFORE the first
      // fetch so its body is still replayable on retry, and merge `init` on top
      // (explicit `init` fields take precedence). String|URL keeps prior
      // behavior (the retry is built purely from `init`).
      let retryClone: Request | null = null;
      let requestUrl: string;
      let firstArg: Parameters<typeof fetch>[0];

      if (input instanceof Request) {
        // Clone for replay before the body is consumed by the first fetch.
        retryClone = input.clone();
        requestUrl = input.url;
        firstArg = input;
      } else {
        requestUrl = typeof input === 'string' ? input : input.toString();
        firstArg = input;
      }

      const first = await fetchWithTimeout(firstArg, init);
      if (first.status !== 402) return first;

      // Decode + select the requirement (untrusted 402 input). Prefer an EVM
      // (Base) option; fall back to a Solana (SVM) option. If neither family is
      // payable, fail closed with X402_NO_COMPATIBLE_OPTION.
      let paymentRequired: PaymentRequired;
      let requirement: PaymentRequirement;
      let isSvm = false;
      try {
        paymentRequired = await decodePaymentRequired(first);
        if (pinned) {
          // Known money terms: sign only an option that names exactly them; never fall back to
          // another option, another network or the Solana family.
          requirement = selectPinnedRequirement(paymentRequired, pinned);
        } else try {
          requirement = selectCompatibleRequirement(paymentRequired);
        } catch (evmErr) {
          // Only reached when no Base option is payable — the ONLY path that
          // touches the Solana signer (and thus loads @solana). Base-only
          // agents never get here.
          const { selectCompatibleSvmRequirement } = await loadSvmSigner();
          const svmReq = selectCompatibleSvmRequirement(paymentRequired);
          if (!svmReq) throw evmErr;
          requirement = svmReq;
          isSvm = true;
        }
      } catch (err) {
        throw new ProvianError((err as Error).message, 'X402_NO_COMPATIBLE_OPTION');
      }

      // Sign locally with the agent's own key — no relay, no phone. Reuse a
      // memoized authorization for the SAME logical payment (idempotency guard,
      // audit Pass-3 #9): a caller retry must not mint a second settleable
      // authorization for a payment the facilitator may have already settled.
      // Resolve the per-payment ceiling for THIS request's host and enforce
      // it up front - before the idempotency memo - so a memoized authorization
      // signed under a higher ceiling on a prior wrap can never be replayed
      // under a lower one. The signers ALSO enforce it before signing (defense
      // in depth / direct-caller safety); this is the wrapper's copy of the same
      // boundary. The ceiling is baked into the memo key so a differing ceiling
      // never reuses a prior signature.
      const ceilingAtomic = ceilingForUrl(requestUrl);
      let requestedAmount: bigint;
      try {
        requestedAmount = BigInt(requirement.amount);
      } catch {
        throw new ProvianError('x402: 402 requirement amount is not a valid integer', 'X402_NO_COMPATIBLE_OPTION');
      }
      if (requestedAmount > ceilingAtomic) {
        throw new ProvianError(
          `x402: payment amount ${requestedAmount} exceeds the per-payment ceiling ${ceilingAtomic} (USDC atomic units); refusing to sign`,
          'X402_AMOUNT_EXCEEDS_CAP',
        );
      }

      // Solana: a Provian facilitator fee (extra.provianFee) is a second USDC
      // transfer out of the agent's wallet in the SAME transaction, so it counts
      // toward the same per-payment ceiling. resolveProvianFee refuses (throws
      // X402_PROVIAN_FEE_REFUSED) any fee not to the pinned wallet / pinned USDC
      // mint / within the pinned bound. The signer re-checks both (defense in
      // depth); this copy runs before the memo so a memoized tx can't bypass it.
      let svmFeeKey = '';
      if (isSvm) {
        const { resolveProvianFee } = await loadSvmSigner();
        const fee = resolveProvianFee(requirement);
        if (fee) {
          if (requestedAmount + fee.amountAtomic > ceilingAtomic) {
            throw new ProvianError(
              `x402: payment amount ${requestedAmount} plus Provian facilitator fee ${fee.amountAtomic} exceeds the per-payment ceiling ${ceilingAtomic} (USDC atomic units); refusing to sign`,
              'X402_AMOUNT_EXCEEDS_CAP',
            );
          }
          // A differing fee/quote must never reuse a tx signed for another fee.
          svmFeeKey = `\x00fee=${fee.amountAtomic}\x00quote=${fee.quote ?? ''}`;
        }
      }

      const paymentKey = `${requestUrl}\x00${requirement.network}\x00${requirement.payTo.toLowerCase()}\x00${requirement.amount}\x00cap=${ceilingAtomic}${svmFeeKey}`;
      const nowSec = Math.floor(Date.now() / 1000);
      let paymentHeader: string;
      // Carried into the reputation PE: the EVM authorization (payer = from) or
      // the SVM payer (Solana address).
      let evmSigned: SignedX402Authorization | undefined;
      let svmPayer: string | undefined;

      if (isSvm) {
        // Solana: build + partially sign a versioned transaction. Reuse a
        // still-fresh signed tx on a caller retry — a Solana tx has a fixed
        // signature, so re-submitting it is chain-deduped, never a double-charge.
        const nowMs = Date.now();
        const SVM_TTL_MS = 90_000; // ~ blockhash validity
        let svmSigned = svmSignedByPayment.get(paymentKey);
        if (!svmSigned || nowMs - svmSigned.signedAt > SVM_TTL_MS) {
          for (const [k, v] of svmSignedByPayment) {
            if (nowMs - v.signedAt > SVM_TTL_MS) svmSignedByPayment.delete(k);
          }
          try {
            const { signX402SvmPayment } = await loadSvmSigner();
            const s = await signX402SvmPayment({
              privateKeyHex: wallet.privateKeyHex,
              requirement,
              maxAmountAtomic: ceilingAtomic,
            });
            svmSigned = { ...s, signedAt: nowMs };
          } catch (err) {
            // Preserve the ceiling refusal's code (never mask it as a generic
            // signing failure).
            if (err instanceof ProvianError && (err.code === 'X402_AMOUNT_EXCEEDS_CAP' || err.code === 'X402_CEILING_REQUIRED' || err.code === 'X402_PROVIAN_FEE_REFUSED')) throw err;
            throw new ProvianError((err as Error).message, 'X402_SIGNING_FAILED');
          }
          svmSignedByPayment.set(paymentKey, svmSigned);
        }
        svmPayer = svmSigned.payer;
        const { buildSvmPaymentHeader } = await loadSvmSigner();
        paymentHeader = buildSvmPaymentHeader(svmSigned, requirement);
      } else {
        // EVM (Base): sign the off-chain EIP-3009 authorization. Reuse a
        // memoized authorization for the SAME logical payment (idempotency
        // guard, audit Pass-3 #9): a caller retry must not mint a second
        // settleable authorization for a payment already settled.
        let signed: SignedX402Authorization;
        const memo = signedByPayment.get(paymentKey);
        if (memo && Number(memo.authorization.validBefore) > nowSec) {
          // Same single-use nonce as the prior attempt — its second settlement is
          // rejected on-chain as a replay, so the retry cannot double-charge.
          signed = memo;
        } else {
          // Drop authorizations whose validity window has already passed.
          for (const [k, v] of signedByPayment) {
            if (Number(v.authorization.validBefore) <= nowSec) signedByPayment.delete(k);
          }
          try {
            signed = signX402Payment({
              privateKeyHex: wallet.privateKeyHex,
              fromAddress: wallet.address,
              requirement,
              maxAmountAtomic: ceilingAtomic,
            });
          } catch (err) {
            // Preserve the ceiling refusal's code (never mask it as a generic
            // signing failure).
            if (err instanceof ProvianError && (err.code === 'X402_AMOUNT_EXCEEDS_CAP' || err.code === 'X402_CEILING_REQUIRED')) throw err;
            throw new ProvianError((err as Error).message, 'X402_SIGNING_FAILED');
          }
          signedByPayment.set(paymentKey, signed);
        }
        evmSigned = signed;
        paymentHeader = buildPaymentHeader(signed, requirement);
      }

      // Build the retry from the ORIGINAL request, then layer any explicit
      // `init` on top (so `init` wins where the caller set it), then add the
      // PAYMENT-SIGNATURE header on top of everything (never replacing the
      // original headers).
      const retryMethod = init?.method ?? retryClone?.method ?? 'GET';

      const retryHeaders = new Headers(retryClone?.headers);
      if (init?.headers) {
        new Headers(init.headers).forEach((value, key) => retryHeaders.set(key, value));
      }
      // v2 paying header is PAYMENT-SIGNATURE (X-PAYMENT is the v1 name —
      // live v2 sellers ignore it and just re-402; found by LIVE-VERIFY
      // 2026-07-08 against Bazaar-indexed Base-mainnet endpoints).
      retryHeaders.set('PAYMENT-SIGNATURE', paymentHeader);

      // Resolve the retry body. Prefer an explicit `init.body`; otherwise read
      // the cloned Request's body (replayable because we cloned before the
      // first fetch). A bodyless GET/HEAD has no body to send.
      let retryBody: NonNullable<Parameters<typeof fetch>[1]>['body'] = init?.body;
      if (retryBody === undefined && retryClone && retryMethod !== 'GET' && retryMethod !== 'HEAD') {
        try {
          retryBody = await retryClone.arrayBuffer();
        } catch {
          // The original body was a non-replayable consumed stream we could not
          // clone. Fail clearly rather than silently sending an empty body
          // AFTER paying — the caller must resend with a replayable body.
          throw new ProvianError(
            'x402 paid retry could not replay the original request body (non-replayable stream); resend with a replayable body',
            'X402_REQUEST_FAILED',
          );
        }
      }

      const replay = await fetchWithTimeout(requestUrl, {
        method: retryMethod,
        headers: retryHeaders,
        body: retryBody,
        // Fail closed: never auto-follow a redirect on the paid retry — that
        // would resend the freshly-signed USDC authorization to an
        // attacker-influenced Location (protecting the agent's own funds).
        redirect: 'manual',
      });

      // The memo (one signed authorization per payment, re-sent on a caller retry) ends ONLY when a
      // 2xx consumed it: the next call for the same resource and price is a NEW purchase and must
      // carry a fresh nonce (a re-sent spent nonce is refused as a replay, which stranded a repeat
      // buyer until validBefore). EVERY other answer keeps it. A 402 is not "the seller refused this
      // authorization": the x402 resource server answers 402 for every settle failure, including
      // `settlement_pending` AFTER the facilitator has broadcast it, so dropping the memo there made
      // the caller's retry sign a second authorization and pay twice . The memo
      // expires with the authorization itself (validBefore), after which nobody can settle it.
      const delivered = replay.status >= 200 && replay.status < 300;
      if (delivered) {
        signedByPayment.delete(paymentKey);
        svmSignedByPayment.delete(paymentKey);
      }

      if (replay.type === 'opaqueredirect' || (replay.status >= 300 && replay.status < 400)) {
        throw new ProvianError('x402 paid retry was redirected; refusing to resend the payment', 'X402_REDIRECTED');
      }
      if (replay.status === 402) {
        // Server rejected the payment. Do NOT loop / re-sign.
        throw new ProvianError('x402 payment was rejected by the server', 'X402_PAYMENT_REJECTED');
      }
      if (!replay.ok) {
        throw new ProvianError(`x402 paid request failed: HTTP ${replay.status}`, 'X402_REQUEST_FAILED');
      }

      // no x402_payment PE is recorded here. An agent's own report of its
      // payment is not a PE; Provian's chain watcher witnesses the on-chain
      // settlement independently. The receipt is still decoded so a facilitator
      // that serves 200 while reporting success:false is surfaced to the caller.
      const receipt = decodePaymentResponse(replay);
      if (receipt && receipt.success !== true) {
        console.warn(
          '[Provian] x402 paid retry returned 200 but the settlement receipt does not report success.',
        );
      }

      return replay;
    };
    // a response that hands its output out SIGNED is captured for this device's
    // next PE (best-effort; never changes or fails the response).
    return async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> =>
      this.captureReceivedOutput(await pay(input, init));
  }

  // ===========================================================================
  // Signed outputs (: every output an agent hands out carries its signature over
  // the output's hash; a citation counts toward the producer's consumption when it carries it)
  // ===========================================================================

  /**
   * Sign an output with THIS DEVICE's registered key: a Secure-Enclave device's own signing key
   * (`provian-se-sign`), or — on a bearer device, whose HMAC secret no third party can verify — a
   * P-256 output key created once on this machine and registered with the relay
   * (`PUT /v1/devices/me/output-signing-key`). Use it for outputs produced on a device that does
   * not hold the wallet key (a person's MacBook daemon). An agent holding its wallet key may sign
   * with `signOutputWithWalletKey` instead. Serve the result with `outputSignatureHeaders(sig)`.
   */
  async signOutput(output: Uint8Array | string): Promise<OutputSignature> {
    if (!this.deviceMode) {
      throw new ProvianError(`Signing an output with the device key needs device credentials (${cliCommand('register-device')}).`, 'NO_WITNESS_PATH');
    }
    const deviceId = this.config.deviceId ?? (await this.getPeStore()).deviceId;
    const signer = { kind: 'device' as const, id: deviceId };
    if (this.config.signingMethod === 'secure_enclave_p256') {
      return signOutputWithDigestSigner(signer, output, async (digest) =>
        Buffer.from(await this.runSeSignCli(digest), 'base64').toString('hex'));
    }
    let key = loadOrCreateDeviceOutputKey(deviceId, this.config.outputKeyPath);
    if (!key.registered) {
      const res = await this.fetchWithTimeout(`${this.config.relayUrl}/v1/devices/me/output-signing-key`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...this.deviceAuthHeaders() },
        body: JSON.stringify(deviceOutputKeyRegistrationBody(key)),
      });
      if (res.status !== 200 && res.status !== 201) {
        const detail = await res.text().catch(() => '');
        throw new ProvianError(`the relay refused this device's output key (HTTP ${res.status}) ${detail.slice(0, 200)}`, 'OUTPUT_KEY_REGISTRATION_FAILED');
      }
      key = markDeviceOutputKeyRegistered(key, this.config.outputKeyPath);
    }
    return signOutputWithP256Key(key.private_key_hex, signer, output);
  }

  /**
   * Wrap a fetch so every response that hands its output out signed (`Provian-Output-Signature`)
   * is queued for this device's next PE — after checking the signature names exactly the bytes
   * received. The response is returned unchanged; a capture failure never fails the fetch. A
   * client without device credentials captures nothing (there is no witness to cite on).
   */
  wrapFetchWithOutputCitations(fetchFn: typeof fetch = guardedFetch): typeof fetch {
  fetchFn = guardedFetcher(fetchFn);
    return async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> =>
      this.captureReceivedOutput(await fetchFn(input, init));
  }

  /** Queue a received response's signed output for this device's next PE. Never throws. */
  private async captureReceivedOutput(response: Response): Promise<Response> {
    if (!this.deviceMode) return response;
    try {
      const signature = readOutputSignatureHeader(response.headers);
      if (signature === null) return response;
      const body = new Uint8Array(await response.clone().arrayBuffer());
      if (!outputSignatureMatches(signature, body)) return response; // not what we received: never cited
      enqueueOutputCitation((await this.getPeStore()).location, signature);
    } catch {
      // best-effort
    }
    return response;
  }

  // ===========================================================================
  // Earning-type status (Phase 4) — the PULL path.
  // ===========================================================================

  /**
   * Look up the public status of an action type: `live` (and its weight),
   * `building`, `queued` (in review), or `declined`. Lets an agent poll whether
   * a type it recorded now earns, without waiting on the `action_type_activated`
   * webhook. Reads the public `GET /v1/pe/earning-proposals/:action_type` (no
   * auth needed); returns `null` when the type has no observed catalog entry (404). "Live" is computed by the relay from the
   * served, digest-matched matrix — never an admin write.
   */
  async getActionTypeStatus(actionType: string): Promise<ActionTypeStatus | null> {
    const base = this.config.relayUrl.replace(/\/+$/, '');
    const url = `${base}/v1/pe/earning-proposals/${encodeURIComponent(actionType)}`;
    let response: Response;
    try {
      response = await this.fetchWithTimeout(url, { method: 'GET' });
    } catch (error) {
      throw new ConnectionError(`Network error: ${(error as Error).message}`);
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new ProvianError(`HTTP ${response.status}: ${response.statusText}`, `HTTP_${response.status}`);
    }
    return await response.json() as ActionTypeStatus;
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

// ============================================================================
// PE Description Validation (Article I)
// ============================================================================

const PE_BLOCKLIST = new Set([
  'test', 'testing', 'asdf', 'todo', 'n/a', 'na', 'none', 'null', 'undefined',
  'foo', 'bar', 'baz', 'hello world', 'test pe', 'test description',
  'describe action here', 'placeholder', 'description', 'action', 'did stuff',
  'stuff', 'things', 'work', 'update', 'fix', 'changed something', 'misc',
  'temp', 'tmp', 'wip', 'tbd', 'lorem ipsum', 'example', 'sample',
]);

function validatePEDescription(text: unknown, fieldName: string = 'description'): { valid: boolean; error?: string; hint?: string } {
  if (typeof text !== 'string' || !text.trim()) {
    return { valid: false, error: `${fieldName} is required`, hint: `Provide a human-readable ${fieldName} of the action performed.` };
  }
  const trimmed = text.trim();
  if (trimmed.length > 2000) {
    return { valid: false, error: `${fieldName} exceeds 2000 characters`, hint: 'Keep descriptions concise but descriptive.' };
  }
  if (trimmed.length < 20) {
    return { valid: false, error: `${fieldName} is too short (min 20 chars)`, hint: 'Describe what was done, to what, and why. Example: "Read production database metrics for Q1 report"' };
  }
  const words = trimmed.split(/\s+/).filter(w => w.length > 0);
  if (words.length < 3) {
    return { valid: false, error: `${fieldName} needs at least 3 words`, hint: 'Include action, target, and context.' };
  }
  if (!/[a-zA-Z]/.test(trimmed)) {
    return { valid: false, error: `${fieldName} must contain at least one letter`, hint: 'PE descriptions are human-readable records.' };
  }
  if (PE_BLOCKLIST.has(trimmed.toLowerCase())) {
    return { valid: false, error: `"${trimmed}" is not a valid PE ${fieldName} (placeholder/test data)`, hint: 'Describe the actual action. The PE chain is your permanent audit trail.' };
  }
  return { valid: true };
}

/** A caller-set occurrence time (epoch ms) when it is a plausible one, else null. */
function occurredAtOf(report: ActionReport | DeviceActionReport): number | null {
  const t = 'occurredAtMs' in report ? report.occurredAtMs : undefined;
  return typeof t === 'number' && Number.isSafeInteger(t) && t > 1_500_000_000_000 ? t : null;
}

/** A caller-set relay Idempotency-Key when it is well-formed (16-128 of [A-Za-z0-9_-]), else null. */
function callerIdempotencyKey(report: ActionReport | DeviceActionReport): string | null {
  const k = 'idempotencyKey' in report ? report.idempotencyKey : undefined;
  return typeof k === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(k) ? k : null;
}
