import type { EconomicSessionLineageClaim } from './observer/session-lineage';
import type { OutputDigest } from './output-digests';
/**
 * Provian Agent SDK Types
 */

// ============================================================================
// Configuration
// ============================================================================

export interface ProvianClientConfig {
  /**
   * Trust Layer §2.9: a HARDWARE WITNESS producer. Called with the binding nonce (sha256 hex over
   * the canonical submit body minus the slot) for every device-mode submission; returns a report a
   * non-actor key signed over that nonce (TPM quote, Confidential Space token, …) or null. The
   * relay verifies it against the scheme's pinned public root; verified → hardware_rooted (4.0×).
   */
  hardwareWitness?: import('./hardware-witness').HardwareWitnessProvider;
  /** Relay base URL (e.g. https://relay.provian.ai) */
  relayUrl: string;

  /**
   * Optional label for this client. the relay agent-session channel
   * (connectionToken / agentWalletId / agentWalletKeyHex) is REMOVED — a client
   * is in device mode (below) or sovereign mode (relayUrl only).
   */
  agentId?: string;

  // --- Device mode (persistent credentials from register-device) ---
  /** Device API key (pdk_...) - set in PROVIAN_DEVICE_KEY env var */
  deviceKey?: string;
  /** Device API secret (pds_...) - set in PROVIAN_DEVICE_SECRET env var */
  deviceSecret?: string;
  /** Device identifier - required when signingMethod === 'secure_enclave_p256' */
  deviceId?: string;
  /**
   * Per-PE signing method. Defaults to 'bearer' when absent. When set to
   * 'secure_enclave_p256', the client canonicalizes each submission, SHA-256
   * hashes it, shells out to `provian-se-sign` against `signingKeyAlias`, and
   * sends a DeviceSignature header. The relay verifies with @noble/curves/p256.
   */
  signingMethod?: 'bearer' | 'secure_enclave_p256';
  /** Secure Enclave key alias - required when signingMethod === 'secure_enclave_p256' */
  signingKeyAlias?: string;
  /**
   * Path to the provian-se-sign binary. Defaults to PATH lookup via
   * `command -v provian-se-sign`. Override for tests or non-standard installs.
   */
  seSignBinary?: string;
  /**
   * Where a BEARER device keeps the P-256 key it signs its outputs with.
   * Default `~/.provian/output-keys/<device id>.json` (0600). An SE device signs with its
   * Secure-Enclave key and needs none.
   */
  outputKeyPath?: string;

  /**
   * called when the relay REFUSES a session-lineage claim on a device
   * act, carrying the ordinal the relay's own registry expects next (null when
   * the refusal is not a sequencing answer).
   *
   * PE meter: the relay prices the act without the claim regardless (a refused
   * lineage never costs the record) and says so in the batch receipt
   * (`lineage_rejected:…`); the batcher delivers it here. This hook exists so the
   * Observer can adopt the relay's ordinal and stop drifting — without it, one
   * burned ordinal locked a device out of lineage-bearing submission permanently.
   */
  onSessionLineageRejected?: (info: {
    code: string;
    expectedOrdinal: number | null;
  }) => void;

  /**
   * Audience claim included in the bound-preimage envelope of every
   * device-signed PE submission (BLOCKER-4 fix). Defaults to
   * 'provian-relay-prod' to match the relay's DEVICE_SIGNATURE_AUDIENCE
   * default. Override for staging/test deployments.
   */
  deviceSignatureAudience?: string;

  /**
   * Per-request timeout in ms for individual relay fetches (default: 30000).
   * Bounds each fetch (incl. the device-mode connect probe) so a
   * hung-but-connected relay fails closed rather than hanging forever.
   */
  requestTimeout?: number;

  /**
   * PE meter : where this device keeps its own PEs. A PE lives with
   * its owner and is never deleted; the relay keeps batch economics and packed replay
   * membership, plus the small trust rows needed for outputs and cross-witness evidence.
   * Unset → the filesystem store under `peStoreRoot` / `PROVIAN_PE_STORE_DIR` /
   * `~/.provian/pe-store`, one directory per device id. Supply your own (e.g. a database) to
   * keep PEs in your own storage; its `deviceId` must be this device's.
   */
  peStore?: import('./meter/pe-store').PeStore;
  /** Root directory of the default filesystem PE store (overrides `PROVIAN_PE_STORE_DIR`). */
  peStoreRoot?: string;
  /**
   * Called with every PE after it is recorded locally, for operators who want a copy in their
   * own storage. Best-effort: it never blocks or fails the record (a failure is logged once).
   */
  peMirror?: (pe: import('./meter-wire').PeV2) => Promise<void>;

  /**
   * Opt-in strict SDK-version enforcement (default: false). When false — the
   * default — a below-minimum-supported SDK only logs a loud upgrade nudge and
   * keeps operating (fail-open for availability). When true, connect() THROWS a
   * ProvianError(code SDK_BELOW_MIN) if the relay advertises a minimum-supported
   * version newer than this SDK. This never affects an agent's own x402 spending
   * either way — it only gates the relay session at connect time.
   */
  strictSdkVersion?: boolean;
}

// ============================================================================
// Action Categories (the `actionType` vocabulary of ActionReport)
// ============================================================================

export type ActionCategory =
  | 'spending'
  | 'communicate'
  | 'commit'
  | 'share_data'
  | 'public_post'
  | 'system_access'
  | 'uncategorized'
  | 'egress_data';

// ============================================================================
// Intent Context (Phase 1: Device-Attested Intent Binding)
// ============================================================================

/**
 * Provides provenance for agent actions - tracks which user instruction
 * initiated this action and what external content influenced the decision.
 * Agents that include intent context get lower risk scores than those that don't.
 */
export interface IntentContext {
  /** SHA-256 hash of the original user instruction that triggered this action */
  userInstructionHash: string;
  /** Brief explanation of why the agent is taking this action (shown to wallet owner) */
  reasoningSummary: string;
  /** URLs, email IDs, or other external sources that influenced this decision */
  externalInputsUsed?: string[];
}

// ============================================================================
// Agent Wallet
// ============================================================================

/** Version recorded with a new wallet's optional Network Constitution acceptance. */
export const NETWORK_CONSTITUTION_VERSION = 'network-constitution-2026-09-27';
export const APPROVED_NETWORK_CONSTITUTION_VERSIONS = [
  NETWORK_CONSTITUTION_VERSION,
] as const;

export function isCurrentNetworkConstitutionVersion(version: string): boolean {
  return version === NETWORK_CONSTITUTION_VERSION;
}

export interface AgentWalletConfig {
  /** Relay base URL */
  relayUrl: string;
  /** Agent identifier */
  agentId: string;
  /** Human-readable agent name (defaults to agentId) */
  agentName?: string;
  /** Platform identifier (defaults to 'sdk') */
  platform?: string;
  /** Optional: records that the agent accepts the Network Constitution. Acceptance is not required to create a wallet. */
  constitutionAccepted?: boolean;
  /** Constitution version accepted; defaults to the current approved version */
  constitutionVersion?: string;
  /** ISO timestamp of acceptance; defaults to wallet creation request time */
  constitutionAcceptedAt?: string;

  connectionToken?: string;
  /**
   * OPTIONAL parent agent wallet id (`wallet_aw_...`). When set, this wallet is
   * created as a PARENT-SPAWNED CHILD of that agent: the relay requires the
   * parent to authorize the creation with a proof-of-possession over a
   * `/parent-challenge` (supplied at resume time via `parentAuthorization`), the
   * child INHERITS the parent's human-beneficiary snapshot exactly
   * (`linked_human_*` + `operational_reserve_bps`), and the parent's
   * `children_wallet_ids` is capped at 128. A parent-spawned child is a fully
   * admitted agent identity with its own wallet and its own PE chain, and draws
   * its own Genesis grant like any other agent (/10-01,
   * superseding). This value forks the
   * durable registration identity, so a snapshot prepared for parent X can never
   * be resumed as a child of a different parent or as a standalone wallet.
   * Omitted for an ordinary (parentless) agent wallet.
   */
  parentWalletId?: string;
  /**
   * Optional self-declared flags, stored on the wallet record as the agent sent
   * them. Nothing reads them to gate, limit, or approve anything: since
   * Provian does not govern an agent's actions (no oversight, no spending
   * limits). Kept for wire compatibility with existing registrations.
   */
  governance?: {
    pe_coverage_enabled?: boolean;
    attestation_enabled?: boolean;
    human_oversight_enabled?: boolean;
    spending_limits_enabled?: boolean;
  };
}

/** Stable, caller-owned registration identity. The private key must be
 * durably encrypted before this object is used for any relay request. */
export interface PreparedAgentWalletRegistration {
  schemaVersion: 'prepared-agent-wallet-registration/v1';
  registrationId: string;
  relayUrl: string;
  agentId: string;
  agentName: string;
  platform: string;
  constitutionAccepted: boolean;
  constitutionVersion: string;
  constitutionAcceptedAt: string;
  /** RETIRED : tolerated on older on-disk snapshots, never set by new code. */
  agentSessionId?: string;
  connectionToken?: string;

  parentWalletId?: string;
  governance?: AgentWalletConfig['governance'];
  privateKey: string;
  publicKey: string;
  address: string;
  chainAddresses: MultiChainAddresses;
  createdAt: string;
}

export type PersistPreparedAgentWalletRegistration = (
  prepared: PreparedAgentWalletRegistration,
) => void | Promise<void>;

/**
 * Opaque capability for one authenticated, durable pending registration.
 *
 * Values are issued only after the SDK has reread and authenticated its
 * encrypted pending-registration file. The runtime implementation also uses
 * object identity, so a structurally fabricated value (including one produced
 * with a TypeScript cast) is rejected before networking.
 */
declare const agentWalletRegistrationHandleBrand: unique symbol;
export interface AgentWalletRegistrationHandle {
  readonly [agentWalletRegistrationHandleBrand]: true;
}

export interface MultiChainAddresses {
  /** EVM wallet address (0x-prefixed, checksummed) */
  evm: string;
  /**
   * Solana address (base58, ed25519) derived from the SAME secp256k1 secret via
   * a domain-separated KDF. This is where the agent receives/holds USDC and SOL
   * for Solana x402 payments. No separate key to back up.
   */
  solana?: string;
}

export interface AgentWalletResult {
  /** Primary EVM wallet address (0x-prefixed, checksummed) */
  address: string;
  /** Receive addresses for all supported chain families */
  chainAddresses: MultiChainAddresses;
  /** Hex-encoded secp256k1 private key - agent must store securely */
  privateKey: string;
  /** Uncompressed secp256k1 public key (hex, no 04 prefix) - non-secret */
  publicKey: string;
  /** Provian wallet ID for relay operations */
  walletId: string;
  /** API key for authenticating Commons institutions requests - shown only once */
  apiKey: string;
  /** API secret for authenticating Commons institutions requests - shown only once */
  apiSecret: string;
  /** ISO timestamp of wallet creation */
  createdAt: string;
  /** Envelope ID of the "birth certificate" PE */
  firstEnvelopeId: string;
  /** Initial badges earned */
  badges: string[];
  /**
   * The x25519 recovery anchor (base64url) the relay named at birth: the connection code's anchor,
   * its issuer's published anchor, or a parent-spawned child's inherited human's.
   */
  recoveryAnchorPubkey?: string;
  /**
   * / L381: true when this create sealed the wallet key to `recoveryAnchorPubkey` and the
   * relay stored the escrow. False when the relay named no anchor (no human at birth) or when the
   * escrow did not land (`recoveryEscrowError` says why). An escrow failure never throws: the
   * credential this create issued is always returned, so persist it, then retry the escrow
   * (`sealAndEscrow`, or resume the same durable registration again). Escrow is how the linked
   * human can restore this key if the agent's runtime or key is lost; it never holds earnings —
   * the agent's mints and payouts proceed whether this is true or false.
   */
  recoveryEscrowed?: boolean;
  /** Why the birth escrow did not land, when an anchor was named and the escrow failed. */
  recoveryEscrowError?: string;
  /** Welcome message with ecosystem info, contract addresses, and getting started guide */
  welcome?: Record<string, unknown>;
}

export interface TrustProfile {
  /** Wallet address queried */
  address: string;
  /** 'human' | 'agent' - included for informational purposes only */
  ownerType: 'human' | 'agent';
  /** Total verified PEs generated by this wallet */
  peCount: number;
  /** PVT earned (string for precision) */
  pvtEarned: string;
  /** Trust score (0-100) */
  trustScore: number;
  /** Wallet creation timestamp */
  memberSince: string;
  /** Summary of PE history by action type */
  actionBreakdown: Record<string, number>;
}

// ============================================================================
// Action Reporting
// ============================================================================

// ============================================================================
// Extended Structural Fields - Compute Telemetry, Geo Provenance, Execution Env
// ============================================================================

/** Compute resource telemetry - include what the source can observe, null the rest */
export interface ComputeTelemetry {
  duration_ms:          number | null;   // Wall-clock time of computation in ms
  tokens_processed?:    number | null;   // Tokens in + out (LLM inference)
  records_processed?:   number | null;   // Records/items processed (data pipelines, sensors)
  output_cardinality?:  number | null;   // Number of discrete outputs produced
  cpu_seconds?:         number | null;   // CPU compute time in seconds
  memory_peak_mb?:      number | null;   // Peak memory usage in MB
  energy_joules?:       number | null;   // Energy consumed (from hardware/OS telemetry)
  gpu_seconds?:         number | null;   // GPU compute time (from CUDA/ROCm telemetry)
  model_parameters?:    number | null;   // Model size in parameters (e.g. 7e9 for 7B)
  framework?:           string | null;   // ML framework (e.g. "pytorch", "jax", "tensorflow")
  hardware_class?:      string | null;   // Hardware class (e.g. "h100", "a100", "m4-pro", "cpu")
}

/** Geographic provenance - hardware-attested when available */
export interface GeoProvenance {
  latitude?:            number | null;   // Decimal degrees. Hardware-signed when available.
  longitude?:           number | null;   // Decimal degrees
  altitude_m?:          number | null;   // Meters above sea level
  accuracy_m?:          number | null;   // GPS accuracy in meters
  hardware_attested?:   boolean;         // true = signed by hardware GPS/sensor
  region_code?:         string | null;   // ISO 3166-2 region (e.g. "US-TX")
}

/** Execution environment - OS, runtime, container context */
export interface ExecutionEnv {
  os?:              string | null;   // e.g. "linux", "macos", "windows"
  os_version?:      string | null;   // e.g. "14.4.1"
  runtime?:         string | null;   // e.g. "node", "python", "deno"
  runtime_version?: string | null;   // e.g. "20.11.0"
  container?:       string | null;   // e.g. "docker", "kubernetes", null if bare metal
  tee_type?:        string | null;   // e.g. "sgx", "tdx", "sev", null if no TEE
  tee_version?:     string | null;   // TEE firmware/spec version
  /** Trust Layer §2.11: 'container' | 'ci' | 'vm' | 'bare_metal' | 'unknown' (daemon-detected). */
  environment_class?: string | null;
}

/**
 * The reference to whoever vouched an origin crossed the process boundary
 * (Prompt 1b): a witness type, the key/device identity of the voucher, and an
 * attestation tier when the witness is a device. Present on an entry only when
 * `witnessed` is true.
 */
export interface OriginWitness {
  type: string;
  identity: string;
  attestation_tier?: string;
}

/**
 * One recorded external input origin. `{ hash, origin_identifier }` names the
 * external artifact the work consumed (Prompt 1); `witnessed` + `witness`
 * (Prompt 1b) record whether a NON-actor key vouched it crossed the boundary.
 * See `input-origins.ts` for the canonical three-state + entry semantics; the
 * field is forward-only and has ZERO mint effect (pure provenance).
 */
export interface InputOrigin {
  hash: string;
  origin_identifier: string;
  /** True only when a non-actor key vouched; false for actor-supplied / scanned origins. */
  witnessed: boolean;
  /** The voucher reference — present only when `witnessed` is true. */
  witness?: OriginWitness;
  /** A signed citation's producer signature (`out:<kind>:<id>`, see `output-signature.ts`). */
  signature?: import('./output-signature').OutputSignature;
}

export interface ActionReport {
  actionType: ActionCategory;
  /** Optional - structural metadata is sufficient without it */
  description?: string;
  success: boolean;
  metadata?: Record<string, unknown>;
  // Extended structural fields - include what the source can observe, null the rest
  compute?: ComputeTelemetry | null;
  geo?: GeoProvenance | null;
  execution_env?: ExecutionEnv | null;
  cited_pe_ids?: string[] | null;
  parent_goal_pe_id?: string | null;
  /**
   * Prompt 1 (forward-only): external input origins this work consumed.
   * `undefined`/`null` = absent (unobservable), `[]` = observed-none,
   * `[{…}]` = one or more. PURE PROVENANCE, ZERO mint effect.
   */
  input_origins?: InputOrigin[] | null;
  /**
   * Trust Layer build §2.3: what this work PRODUCED — `{ hash, kind, locator? }` digests (a commit
   * sha, a file/artifact sha256, a model response digest, a tx hash). Forwarded to every submit
   * route; the relay normalizes, stores, and indexes them by hash. Empty when nothing observable.
   */
  output_digests?: OutputDigest[] | null;
}

// ============================================================================
// Work Product Reporting
// ============================================================================

/** Type of work product the agent created */
export type WorkProductType = 'code' | 'document' | 'research' | 'analysis' | 'design' | 'data' | 'other';

/** Report a work product (code, document, research, etc.) to generate a Creation PE */
export interface WorkProductReport {
  /** Trust Layer §2.3: further digests of what the work produced (the artifact hash is one already). */
  output_digests?: OutputDigest[] | null;
  /** What type of output was produced */
  productType: WorkProductType;
  /** SHA-256 hash of the artifact content (the agent computes this) */
  artifactHash: string;
  /** Human-readable summary of what was produced (shown in PE history) */
  summary: string;
  /** Optional: language for code, format for docs (e.g. 'typescript', 'markdown', 'pdf') */
  format?: string;
  /** Optional: size metrics (lines of code, word count, page count, etc.) */
  sizeMetrics?: Record<string, number>;
  /** Optional: tools/models used to produce this output */
  toolsUsed?: string[];
  /** Optional: intent context linking this output to the original user instruction */
  intentContext?: IntentContext;

  // ── Replication Pack fields (optional but increases PVT multiplier when all three provided) ──

  /**
   * SHA-256 hash of the COMPLETE model input - the full prompt sent to the model,
   * including system context, retrieved data, and user instruction. Agent computes this.
   * Different from intentContext.userInstructionHash which is only the user's original words.
   */
  inputHash?: string;

  /**
   * Structured model identifier: "provider/model-name/version"
   * Examples: "anthropic/claude-sonnet-4-6/2025-05", "openai/gpt-4o/2024-11"
   * Used for Replication Pack - verifier needs to know which model to reproduce the work.
   */
  modelId?: string;

  /**
   * Optional model checkpoint hash - cryptographic identifier of the exact model weights.
   * Currently only available via GPU TEE attestation (future). Include if your runtime provides it.
   */
  modelCheckpointHash?: string;

  /**
   * SHA-256 of the canonical Replication Pack bundle:
   * SHA-256(inputHash + artifactHash + modelId + (environmentHash if available) + timestamp)
   * Agent computes this. When all three (inputHash, modelId, replicationPackHash) are provided,
   * the PE may qualify for a higher attestation tier. If the PE is otherwise eligible, that tier
   * can increase its PVT estimate; neither the fields nor the tier guarantees minting.
   */
  replicationPackHash?: string;

  // Extended structural fields - include what the source can observe, null the rest
  compute?: ComputeTelemetry | null;
  geo?: GeoProvenance | null;
  execution_env?: ExecutionEnv | null;
  cited_pe_ids?: string[] | null;
  parent_goal_pe_id?: string | null;
}

/** Result of reporting an action (agent mode; device mode returns DevicePEResult) */
export interface ActionResult {
  /** Whether the action was accepted and a PE was created */
  accepted: boolean;
  /** PE ID of the created provenance envelope */
  peId: string;
  /**
   * Relay submit-time PVT estimate for this PE. An estimate at current
   * protocol weights, never a guarantee — every act of work mints PVT once at its best-supported value
   * under protocol rules (eligibility, novelty, rate limits, and chain
   * verification apply at mint).
   */
  estimatedPVT?: number;
  /**
   * The relay's record-time disposition for this PE. A `record_only` (or any
   * non-`eligible`) disposition mints 0 PVT however large the estimate — record
   * points are not PVT. Surfaced so callers see the disposition beside the number.
   */
  mintDisposition?: string;
  /** The reason code behind the disposition (e.g. `unknown_action_type`). */
  mintReasonCode?: string;
  /** Human-readable note explaining the disposition and what earning requires. */
  mintNote?: string;
  /**
   * For an action type with no named matrix row (observed in the operator queue): the seal's review
   * state — `class_admitted` (admitted at the witness class the relay assigned) or `pending_policy`.
   * Null for a named type.
   */
  policyReviewState?: string | null;
  /** Public status page for this action type (provian.ai/proposals/<type>). */
  reviewUrl?: string;
}

/** Result of reporting a work product */
export interface WorkProductResult {
  /** Whether the work product was accepted and a PE was created */
  accepted: boolean;
  /** PE ID of the created provenance envelope */
  peId: string;
  /** Current PVT estimate; final amount reflects evidence quality, novelty, duplication, jurisdiction, caps, and protocol policy. */
  estimatedPVT?: number;
  /** Whether all three replication pack fields were provided (inputHash + modelId + replicationPackHash) */
  replicationPackComplete?: boolean;
  /** Whether this PE is inside its 30-day corroboration window (a later witness can still lift its value with an additive top-up) */
  auditHold?: boolean;
  /** Timestamp when the corroboration window closes (ms) */
  auditWindowExpiresAt?: number;
}

// ============================================================================
// Connection
// ============================================================================

export interface ConnectionResult {
  success: boolean;
  agentId: string;
  walletId: string;
}

// ============================================================================
// Device PE Submission
// ============================================================================

/** Report an action from a registered device */
export interface DeviceActionReport {
  /** PE action type (e.g. 'agent_work_product_code', 'system_access') */
  actionType: string;
  /** Optional description - structural metadata is sufficient without it */
  description?: string;
  /** Whether the action succeeded */
  success?: boolean;
  /** Arbitrary metadata (tool name, files changed, etc.) */
  metadata?: Record<string, unknown>;
  // Extended structural fields - include what the source can observe, null the rest
  compute?: ComputeTelemetry | null;
  geo?: GeoProvenance | null;
  execution_env?: ExecutionEnv | null;
  cited_pe_ids?: string[] | null;
  parent_goal_pe_id?: string | null;
  /**
   * Prompt 1 (forward-only): external input origins this work consumed. Same
   * three-state semantics as ActionReport. PURE PROVENANCE, ZERO mint effect.
   */
  input_origins?: InputOrigin[] | null;
  /**
   * Trust Layer build §2.3: what this work PRODUCED — `{ hash, kind, locator? }` digests (a commit
   * sha, a file/artifact sha256, a model response digest, a tx hash). Forwarded to every submit
   * route; the relay normalizes, stores, and indexes them by hash. Empty when nothing observable.
   */
  output_digests?: OutputDigest[] | null;
  /**
   * WITNESSED CAPTURE CONTEXT. The attested observer runtime session
   * under which this evidence was captured, minted by the Observer SDK and
   * verified by the relay against the device it authenticated. Omit it and the
   * `session_lineage_policy: 'required'` fence holds, exactly as before. It is
   * never account- or transport-derived; see
   * `observer/session-lineage.ts`.
   */
  economic_session_lineage?: EconomicSessionLineageClaim;
  /**
   * review 4: the relay Idempotency-Key to submit under (16-128 of
   * [A-Za-z0-9_-]). A caller that may resubmit the same PE after a restart sets
   * a deterministic key so the relay answers the resubmission with the PE it
   * already made. Absent or malformed: a fresh key.
   */
  idempotencyKey?: string;
  /**
   * When the work happened (epoch ms), when the observing lane knows it. The PE's timestamp is
   * this, clamped to now; absent or invalid: the record time.
   */
  occurredAtMs?: number;
}

/** Report a work product from a registered device (includes replication pack) */
export interface DeviceWorkProductReport {
  /** Trust Layer §2.3: further digests of what the work produced (the artifact hash is one already). */
  output_digests?: OutputDigest[] | null;
  /** What type of output was produced */
  productType: WorkProductType;
  /** SHA-256 hash of the artifact content */
  artifactHash: string;
  /** Human-readable summary */
  summary: string;
  /** SHA-256 of complete model input */
  inputHash?: string;
  /** Model identifier (e.g. "anthropic/claude-sonnet-4-6") */
  modelId?: string;
  /** Arbitrary metadata (tool name, files changed, etc.) */
  metadata?: Record<string, unknown>;
  // Extended structural fields - include what the source can observe, null the rest
  compute?: ComputeTelemetry | null;
  geo?: GeoProvenance | null;
  execution_env?: ExecutionEnv | null;
  cited_pe_ids?: string[] | null;
  parent_goal_pe_id?: string | null;
  /**
   * WITNESSED CAPTURE CONTEXT. The attested observer runtime session
   * under which this evidence was captured, minted by the Observer SDK and
   * verified by the relay against the device it authenticated. Omit it and the
   * `session_lineage_policy: 'required'` fence holds, exactly as before. It is
   * never account- or transport-derived; see
   * `observer/session-lineage.ts`.
   */
  economic_session_lineage?: EconomicSessionLineageClaim;
}

/**
 * A device PE recorded in this device's own PE store (PE meter, ). It
 * reaches the relay as an act record in the device's next daily batch; what it earns arrives
 * with that batch's receipt, not here.
 */
export interface DeviceRecordedPE {
  /** The PE's own id (`pe_…`), chosen on this device. */
  pe_id: string;
  /** sha256 over the complete PE — what the relay's fingerprint and the on-chain anchor cover. */
  pe_hash: string;
  recorded_locally: true;
  /** True when a resubmission under the same idempotency key answered with the PE already recorded. */
  idempotent_replay?: boolean;
}

/** Result of submitting a PE from a device */
export interface DevicePEResult {
  /** PE ID of the created provenance envelope */
  pe_id: string;
  /** Current PVT estimate; final amount reflects evidence quality, novelty, duplication, jurisdiction, caps, and protocol policy. */
  estimated_pvt: number;
  /** Attestation tier applied */
  attestation_tier: string;
  /** Wallet attributed to this PE's settlement; no amount, timing, or market value is guaranteed. */
  owner_wallet_id: string;
  /** True when the relay answered a resubmission (same idempotency key) with the PE it already made. */
  idempotent_replay?: boolean;
}

/**
 * The public status of one earning action type (Phase 4). Returned by
 * `ProvianClient.getActionTypeStatus()` from
 * GET /v1/pe/earning-proposals/:action_type — the pull path so an agent can
 * poll whether a type earns without waiting on the activation webhook. Every
 * field is optional and defensively read; `status` is the headline.
 */
export interface ActionTypeStatus {
  action_type: string;
  /** 'live' | 'building' | 'queued' | 'declined'. */
  status: string;
  mint_disposition?: string;
  /** For a live type: the row's weight in basis points (10000 = 1.00x). */
  weight_bps?: number;
  effective_at_ms?: number | null;
  reason_code?: string | null;
  canonical_type?: string | null;
  issue_url?: string | null;
  first_seen_at?: number;
  observation_count?: number;
  review_deadline_ms?: number;
  past_review_promise?: boolean;
}
