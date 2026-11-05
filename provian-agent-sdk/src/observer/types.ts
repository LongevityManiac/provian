import type { ComputeTelemetry, ExecutionEnv, InputOrigin } from '../types';
import type { OutputDigest } from '../output-digests';
import type { ProvianCredentials } from '../scripts/credentials';
import type { EconomicSessionLineageClaim } from './session-lineage';

export interface ObserverConfig {
  /** §2.9: hardware witness on every observer PE — 'auto' (default: TPM 2.0 / Confidential Space when present) or 'none'. */
  hardwareWitness?: 'auto' | 'none';
  /** PID to watch. If not set, watches own process group */
  targetPid?: number;
  /** Idle threshold in ms before a session boundary fires */
  idleThresholdMs: number;
  /** Maximum session duration before forced PE */
  maxSessionMs: number;
  /** Sampling interval in ms for ProcessPlugin */
  tickIntervalMs: number;
  /** Plugins to load (names) */
  plugins: string[];
  /** Relay URL */
  relayUrl: string;
  /** Device credentials */
  credentials: ProvianCredentials;
  /** Log level */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /**
   * where the durable session ordinal lives. Defaults to
   * `~/.provian/session-ordinal-<deviceId>.json`. Overridable so tests (and
   * multi-tenant hosts) do not share one sequence across devices.
   */
  sessionOrdinalPath?: string;
  /**
   * (B) → PE meter: the LEGACY durable PE outbox. Entries still queued there are moved
   * into this device's PE store once at start (fresh pe_id, under each entry's own idempotency
   * key) and the directory is renamed `<dir>.migrated`. The daemon sets `~/.provian/pe-outbox`.
   */
  peOutboxDir?: string;
  /**
   * PE meter : this device's PE store. Unset → the filesystem store
   * under `peStoreDir` (or `PROVIAN_PE_STORE_DIR` / `~/.provian/pe-store`).
   */
  peStore?: import('../meter/pe-store').PeStore;
  /** Root directory of the default filesystem PE store. */
  peStoreDir?: string;
  /**
   * Run the daily PE batcher (the daemon sets this). Off for tests and embedders that only
   * record: their PEs stay in the store until a batcher sends them.
   */
  meterBatching?: boolean;
  /**
   * This agent's x25519 message secret, for opening PEs other devices sealed to it (the mailbox).
   * Absent / null → the mailbox stays on the relay (dropped there after 30 days).
   */
  messageSecretKey?: () => Promise<Uint8Array | null>;
}

/**
 * Local inference witnessed during ONE session window, accumulated from the
 * LLM plugin's per-tick contributions. `requests` counts COMPLETED inference
 * requests read from the runtime's own request log; `tokensObserved` is true
 * only when a source that actually exposes token counts (llama.cpp / LM Studio
 * log lines, the JSONL source) contributed them — an Ollama-only session keeps
 * `tokensProcessed` at 0 and `tokensObserved` false. Never estimated.
 */
export interface SessionInferenceState {
  requests: number;
  models: string[];
  runtimes: string[];
  sources: string[];
  tokensObserved: boolean;
  /** Trust Layer §2.3: response digests observed on the proxy tee this session (cap 64). */
  responseDigests?: string[];
}

/** One tick's witnessed local inference, contributed by the LLM plugin. */
export interface InferenceContribution {
  runtime: string;
  source: string;
  requests: number;
  models: string[];
  /** True when this contribution's tokens came from a source that exposes them. */
  tokensObserved: boolean;
  /** Trust Layer §2.3: `sha256:<hex>` digests of the responses this tick witnessed (proxy tee). */
  responseDigests?: string[];
}

export interface SessionState {
  active: boolean;
  startedAt: number;
  lastActivityAt: number;
  accumulatedCpu: number;
  peakMemoryMb: number;
  networkCalls: number;
  tokensProcessed: number;
  pluginArtifacts: Map<string, Record<string, unknown>>;
  /** Witnessed local inference for this window; null until the first contribution. */
  inference: SessionInferenceState | null;
  /**
   * the witnessed capture context for THIS session, minted once when the
   * session opens and carried verbatim by every PE the session emits. Null when
   * there is no attested device credential to bind to; the PE then ships without
   * lineage and the fence holds, which is today's behaviour.
   *
   * It lives on the session rather than being derived per PE on purpose: one
   * attested runtime session, one lineage id. Deriving it per PE would make
   * every act its own causal session and satisfy the fence by construction.
   */
  lineage: EconomicSessionLineageClaim | null;
}

export interface PluginContribution {
  /** If set, the plugin wants to generate its own PE */
  generatePE?: {
    actionType: string;
    description?: string;
    metadata?: Record<string, unknown>;
    artifactRef?: string;
    replicationPack?: {
      input_hash: string;
      output_hash: string;
      model_id?: string | null;
    };
  };
  /** Metadata to merge into the session's compute telemetry */
  telemetry?: Partial<ComputeTelemetry>;
  /** Additional session metadata */
  sessionData?: Record<string, unknown>;
  /**
   * Witnessed local inference this tick. Any contribution with `requests > 0`
   * (or observed tokens) is ACTIVITY: the observer opens or extends the session
   * on it, which is what lets a human device — where ProcessPlugin is gated off
   * and no CPU signal ever opens a session — witness local model work at all.
   */
  inference?: InferenceContribution;
}

export interface PEClaim {
  start: number;
  end: number;
  peId: string;
  plugin: string;
}

export interface ReplicationPack {
  input_hash: string;
  output_hash: string;
  model_id?: string | null;
}

export interface PluginPE {
  actionType: string;
  description?: string;
  metadata?: Record<string, unknown>;
  compute?: ComputeTelemetry | null;
  execution_env?: ExecutionEnv | null;
  replication_pack?: ReplicationPack;
  /**
   * Prompt 2: the EXTERNAL artifacts this captured work consumed, as
   * `input_origins` entries (see `observer/origin-capture.ts`). Forwarded
   * verbatim by `submitPluginPE` to the device-submit route, which normalizes,
   * stores, and hashes them on the canonical chain doc. Absent/`null` → the
   * observer observed no origins (the key is omitted, byte-identical to a
   * pre-change PE). PURE PROVENANCE, ZERO mint effect.
   */
  input_origins?: InputOrigin[] | null;
  /** Trust Layer §2.3: the digests of what this captured work PRODUCED (see `output-digests.ts`). */
  output_digests?: OutputDigest[] | null;
  windowStart: number;
  windowEnd: number;
  /**
   * If true, the observer submits the PE without consulting or mutating the
   * DeduplicationRegistry. Reserved for plugins that measure a different
   * signal dimension than compute_session / inference_session / coding_session
   * (currently only LLMSessionPlugin's ai_conversation emissions. See
   * docs/CAPTURE_ARCHITECTURE.md §9 and docs/PHASE_2B_DESIGN_NOTES.md §8.)
   * A per-namespace registry API is tracked as a post-2b follow-up.
   */
  skipDedupClaim?: boolean;
  /**
   * Per-turn lane selection : the lane decided this PE's identity itself (the
   * transcript lane's decided-call ledger, the proxy's record of what it carried). Its window is
   * still claimed — so a window-deciding lane (the session lanes) does not emit over it — but no
   * claimed window ever suppresses it: overlapping turns of different sessions are different work,
   * and a turn this lane mints has no other mint (the OTel lane defers to the proxy's record by
   * identity too, `OTelPlugin`).
   */
  identityDecided?: boolean;
  /**
   * review 4: the relay Idempotency-Key this PE is submitted under. A lane
   * that may resubmit the SAME PE after a restart (from its own journal, or by
   * re-reading a turn its cursor had not passed) sets a deterministic key, so the
   * relay answers the resubmission with the PE it already made. Absent: a fresh
   * key per submission (the client's default).
   */
  idempotencyKey?: string;
  /**
   * When the work happened (epoch ms), when the lane knows it from its own record of the act — a
   * transcript turn re-read after a restart carries the time of its last tool call, never the time
   * it was emitted. The PE's timestamp is this (never later than now); absent: the record time.
   */
  occurredAtMs?: number;

}
