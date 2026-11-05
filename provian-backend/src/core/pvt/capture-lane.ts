/**
 * capture_lane — WHICH capture lane produced a PE (D-OPS, ops-dashboard build).
 *
 * PURE PROVENANCE METADATA with ZERO mint effect. It is sealed INFORMATIONAL on the
 * economic snapshot (like the pieces-1–4 origin fields) and mirrored top-level on
 * the pe_history doc for cheap collector reads. It NEVER enters the record-points formula,
 * never gates, never caps, never revalues — adding it does not move the monetary template
 * digest or the action-policy matrix (it is not a template/pricing field), only the
 * money-path tripwire (→ `money-path:accept`). It is READ-ONLY observability.
 *
 * The capture lanes are the surfaces the ops console breaks sealed PVT down by, so a
 * whole lane silently sealing zero (the dark-lane shape) is visible against the
 * aggregate. The DERIVATION here is the best-effort fallback for a row with no explicit
 * lane; a caller/daemon that KNOWS its lane passes an exact hint (the daemon's per-plugin
 * `metadata.capture_lane`, or an emitter setting `captureLane` on the accrual params), which
 * always wins — that is how every future row becomes exact rather than inferred.
 */

/** The capture lanes. `other` is the honest fallback, never a silent mis-bucket. */
export const CAPTURE_LANES = [
  'transcript',
  'proxy',
  'otel',
  'process',
  'endpoint',
  'forge_webhook',
  'daemon_git',
  'mobile_chat',
  'desktop_chat',
  'watcher',
  'other',
] as const;

export type CaptureLane = (typeof CAPTURE_LANES)[number];

const CAPTURE_LANE_SET: ReadonlySet<string> = new Set(CAPTURE_LANES);

/** True iff `value` is one of the ten canonical lanes (validates an untrusted hint). */
export function isCaptureLane(value: unknown): value is CaptureLane {
  return typeof value === 'string' && CAPTURE_LANE_SET.has(value);
}

/**
 * Action types produced by the on-chain institution watchers (completion + funding).
 * A PE of one of these types was sealed by a chain-verified watcher → the `watcher` lane.
 */
const WATCHER_ACTION_TYPES: ReadonlySet<string> = new Set([
  'escrow_completed', 'escrow_resolved', 'escrow_disputed',
  'promise_settled', 'pool_executed',
  'escrow_funded', 'pool_contributed', 'promise_funded',
]);

/** Git-commit action types (a daemon GitPlugin or a forge webhook witnesses these). */
function isCommitActionType(actionType: string): boolean {
  return actionType === 'coding_session'
    || actionType.startsWith('service:github_')
    || actionType.startsWith('service:gitlab_')
    || actionType.startsWith('git_');
}

/** The `metadata.tool` the observer daemon's OTel plugin stamps on every PE it builds. */
export const DAEMON_OTEL_TOOL = 'provian-observer-otel';

/** The `metadata.tool` the observer daemon's process lane stamps. */
export const DAEMON_PROCESS_TOOL = 'provian:process';

/**
 * The exact lane of a device-daemon submission that the daemon's own `metadata.tool` names
 *. Until now every daemon PE that was not chat or a commit fell to the `transcript`
 * default, so the ops console labelled OTel-lane turns `transcript`. Every daemon version
 * stamps `provian-observer-otel` on its OTel PEs, so this needs no daemon change. Display only:
 * the lane never prices, gates or caps anything. Unknown tools return null (the default stands).
 */
export function deviceSubmitLaneHint(tool: unknown): CaptureLane | null {
  if (tool === DAEMON_OTEL_TOOL) return 'otel';
  if (tool === DAEMON_PROCESS_TOOL) return 'process';
  return null;
}

export interface DeriveCaptureLaneInput {
  /** An explicit lane from the caller/daemon (`metadata.capture_lane`). Wins if valid. */
  readonly laneHint?: string | null;
  /** The accrual `integrationSource` (the stable submitting-path label). */
  readonly integrationSource?: string | null;
  readonly actionType: string;
}

/**
 * Resolve the capture lane. An explicit valid `laneHint` always wins (the exact source —
 * the only way to distinguish proxy vs transcript vs otel, which share a submit path). With
 * no hint, derive the best lane from integrationSource + actionType, defaulting to `other`
 * rather than guessing a specific lane the evidence does not support.
 */
export function deriveCaptureLane(input: DeriveCaptureLaneInput): CaptureLane {
  if (isCaptureLane(input.laneHint)) return input.laneHint;

  const src = input.integrationSource ?? '';
  const action = input.actionType;

  // Chain-verified watchers.
  if (src === 'agent_bank_generate_pe' || WATCHER_ACTION_TYPES.has(action)) return 'watcher';

  // Chat lanes: mobile vs desktop is carried by the submit path (with no daemon hint).
  if (action === 'ai_conversation') {
    if (src === 'mobile_pe_submit') return 'mobile_chat';
    if (src === 'device_pe_submit') return 'desktop_chat';
    return 'other';
  }

  // A commit witnessed through the device daemon's GitPlugin (a forge webhook sets an
  // explicit `forge_webhook` hint at its emit site, so it never falls through to here).
  if (isCommitActionType(action) && src === 'device_pe_submit') return 'daemon_git';

  // Direct relay / API submissions.
  switch (src) {
    case 'relay_action':
    case 'relay_work_product':
    case 'relay_request_decision':
    case 'relay_authorization_decision':
    case 'relay_agent_connect':
    case 'provisional_pe_submit':
    case 'human_wallet_registration':
    case 'device_registration':
    case 'device_revocation':
    case 'coinbase_onramp_verifier':
    case 'wallet_kill_switch':
      return 'endpoint';
    // A generic device daemon submit (compute / orchestration) with no per-plugin hint.
    // Transcript is the default device witness lane (transcript is demoted only on a
    // repointed harness, where the daemon sets an explicit `proxy` hint). The exact lane for
    // these arrives once the daemon tags `metadata.capture_lane`.
    case 'device_pe_submit':
      return 'transcript';
    default:
      return 'other';
  }
}
