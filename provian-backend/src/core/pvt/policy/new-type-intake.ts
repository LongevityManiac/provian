/**
 * NEW-TYPE INTAKE — the one rule both witness lanes call .
 *
 * - The type of work is never the gate. Any action_type can be submitted.
 * - The gate on RECORDING is a witness: a hardware root (the sovereign lane's admitted
 * `hardware_witness`) or a registered machine's observer (the device batch's gateway plugin
 * marker). A bare API call asserting work — the actor
 * vouching for its own claim with nothing else — is refused, not recorded.
 * - The gate on EARNING is the policy setter signature. A never-seen type on a witness lane records with NO
 * mint (`classAdmittedAction` seals it record_only at weight 0), lands in
 * `pvt_pending_policy_queue` under its lane's source id, shows on the public proposals
 * dashboard, and earns only from the signed matrix row's activation forward.
 *
 * A type in a RELAY-OWNED namespace is never intake-admissible: the relay builds those names at
 * runtime for its own witness lanes (`service:<forge>_<event>` from the forge webhooks, the `git_`
 * commit family), so no static list can know them all, and an intake lane must never pre-claim one.
 *
 * Otherwise a type is intake-admissible on lane L iff
 * (i) it is NEVER-SEEN — a STATIC check against everything the relay names (the action-policy
 * matrix rows, the signed template's actions, the retired matrix and Genesis types, the
 * known launch emitters and proposed launch identifiers, the device observation types, and
 * the types the refusals name). It never reads the runtime monetary activation, so a
 * read failure or an inactive policy cannot make a named type look unnamed; or
 * (ii) FRANK SIGNED IT FOR INTAKE ON THIS LANE — a POSITIVE grant: the type is listed in
 * `INTAKE_SIGNED_ACTION_TYPES` (`intake-signed-action-types.ts`) with L's source id. Signing an
 * intake type is the matrix row AND that list entry, in one change; nothing is inferred from
 * the absence of a known emitter, because most relay types are emitted from constants and
 * watcher specs no static scan sees, and a named relay type writes no queue observation.
 * The grant is necessary, not sufficient: the type must also be neither a known launch
 * emitter nor a matrix row with a static emitter (`STATICALLY_EMITTED_ACTION_TYPES`), and its
 * `pvt_pending_policy_queue` row must exist, be `pending_policy` or `resolved_signed_matrix`,
 * and list a non-empty `integration_sources` that names L and NOTHING but intake lane ids (a
 * forge, relay, device-observation or phone source means another lane witnesses the type).
 * This is how a type the operator signs for the intake keeps being admitted on the lane it came in
 * on, and earns from the cut. A queue read failure refuses (Unknown = Block); the device batch
 * turns it into a thrown error so the batch is retried, never sealed refused.
 *
 * A NAMED type that did not enter on this lane is refused: its witness is someone else's (a chain,
 * the relay, a forge, a counterparty, Genesis, an observation lane); a hardware report on the
 * agent's box or a gateway plugin on its machine does not witness it.
 *
 * This file sits under `core/pvt/policy/`, which the matrix generator's emitter scan skips — it
 * names lane source ids, never an emitted action_type literal, and moves no matrix row, weight or
 * signed template.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { DEVICE_OBSERVATION_ACTION_TYPES } from '../../provenance/device-observation-types';
import {
  KNOWN_LAUNCH_EMITTER_IDENTIFIERS,
  PROPOSED_LAUNCH_ACTION_IDENTIFIERS,
} from './action-policy-gate';
import { isValidPolicyActionType } from './action-type-syntax';
import { WITNESSED_CLASSES, type WitnessClass } from './evidence-class';
import {
  PENDING_POLICY_COLLECTION,
  actionPolicyDocumentId,
  type PendingPolicyReviewState,
} from './pending-policy-queue';
import { PROPOSED_ACTION_POLICY_ENTRIES, RETIRED_MATRIX_ACTION_TYPES } from './proposed-action-policy';
import { RETIRED_GENESIS_ACTION_TYPES } from './proposed-genesis-policy';
import { PROPOSED_MONETARY_POLICY_TEMPLATE } from './proposed-monetary-policy';
import { INTAKE_SIGNED_ACTION_TYPES } from './intake-signed-action-types';
import { STATICALLY_EMITTED_ACTION_TYPES } from './statically-emitted-action-types';

/** The sovereign lane's intake source id (`POST /v1/pe/submit-sovereign` + an admitted hardware witness). */
export const SOVEREIGN_HARDWARE_WITNESS_SOURCE = 'sovereign_hardware_witness' as const;
/** The device batch's intake source id (`POST /v1/meter/batch`, an observer gateway plugin's act). */
export const DEVICE_GATEWAY_OBSERVER_SOURCE = 'device_gateway_observer' as const;

export type NewTypeIntakeLaneSource =
  | typeof SOVEREIGN_HARDWARE_WITNESS_SOURCE
  | typeof DEVICE_GATEWAY_OBSERVER_SOURCE;

export const NEW_TYPE_INTAKE_LANE_SOURCES: readonly NewTypeIntakeLaneSource[] = Object.freeze([
  SOVEREIGN_HARDWARE_WITNESS_SOURCE,
  DEVICE_GATEWAY_OBSERVER_SOURCE,
]);

/**
 * The observer-plugin witness marker on a device act's metadata. The SDK observer (never the
 * plugin) stamps `metadata.source = 'observer_plugin'` and `metadata.observer_plugin = <plugin
 * name>` on every drained plugin PE whose type is not an observation-lane type — the parallel of
 * the transcript lane's `metadata.source === 'transcript'` on a `link_spend`.
 */
export const OBSERVER_PLUGIN_SOURCE = 'observer_plugin' as const;
export const OBSERVER_PLUGIN_NAME_MAX_LENGTH = 128;
// Printable, no whitespace at the ends; one plugin name, never a free-text field.
const OBSERVER_PLUGIN_NAME_RE = /^[A-Za-z0-9][\x21-\x7E]*$/;

/** True only when the metadata carries the observer's gateway-plugin witness marker. */
export function hasObserverPluginWitnessMarker(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const { source, observer_plugin: plugin } = metadata as { source?: unknown; observer_plugin?: unknown };
  return source === OBSERVER_PLUGIN_SOURCE
    && typeof plugin === 'string'
    && plugin.length > 0
    && plugin.length <= OBSERVER_PLUGIN_NAME_MAX_LENGTH
    && OBSERVER_PLUGIN_NAME_RE.test(plugin);
}

/**
 * Namespaces the RELAY owns: it builds names in them at runtime for its own witness lanes —
 * `service:` (the forge webhooks: `service:github_${event}`, `service:gitlab_…`,
 * `service:bitbucket_…`) and `git_` (the commit family `capture-lane.ts` reads as a forge/daemon
 * commit). An intake lane never records a type in one of them.
 */
export const RELAY_OWNED_ACTION_TYPE_PREFIXES: readonly string[] = Object.freeze(['service:', 'git_']);

export function isRelayOwnedActionType(actionType: string): boolean {
  return RELAY_OWNED_ACTION_TYPE_PREFIXES.some((prefix) => actionType.startsWith(prefix));
}

/** The types the sovereign refusals name (each witnessed elsewhere: the chain / the transcript lane). */
export const ACTOR_DECLARED_REFUSED_ACTION_TYPES: ReadonlySet<string> = new Set(['x402_payment', 'link_spend']);

/**
 * Every identifier the relay NAMES, statically. Built once at module load from checked-in sources
 * only — no Firestore, no activation document — so it can never fail open.
 */
const STATICALLY_NAMED_ACTION_TYPES: ReadonlySet<string> = new Set<string>([
  ...PROPOSED_ACTION_POLICY_ENTRIES.map((e) => e.action_type),
  ...Object.keys(PROPOSED_MONETARY_POLICY_TEMPLATE.actions),
  ...RETIRED_MATRIX_ACTION_TYPES,
  ...RETIRED_GENESIS_ACTION_TYPES,
  ...KNOWN_LAUNCH_EMITTER_IDENTIFIERS,
  ...PROPOSED_LAUNCH_ACTION_IDENTIFIERS,
  ...DEVICE_OBSERVATION_ACTION_TYPES,
  ...ACTOR_DECLARED_REFUSED_ACTION_TYPES,
]);

/** True when the relay names `actionType` anywhere in its checked-in policy / emitter sources. */
export function isStaticallyNamedActionType(actionType: string): boolean {
  return STATICALLY_NAMED_ACTION_TYPES.has(actionType);
}

/** Rule (i): a syntactically valid identifier the relay names nowhere, outside its own namespaces. PURE. */
export function isNeverSeenActionType(actionType: unknown): actionType is string {
  return isValidPolicyActionType(actionType)
    && !isRelayOwnedActionType(actionType)
    && !STATICALLY_NAMED_ACTION_TYPES.has(actionType);
}

/** Types another lane witnesses by name: never admitted by rule (ii), whatever the queue says. */
const OTHER_LANE_WITNESSED_TYPES: ReadonlySet<string> = new Set<string>([
  ...KNOWN_LAUNCH_EMITTER_IDENTIFIERS,
  ...STATICALLY_EMITTED_ACTION_TYPES,
]);
const INTAKE_LANE_SOURCE_SET: ReadonlySet<string> = new Set<string>([
  SOVEREIGN_HARDWARE_WITNESS_SOURCE,
  DEVICE_GATEWAY_OBSERVER_SOURCE,
]);

/** Rule (ii)'s positive grant: `actionType` is listed in `INTAKE_SIGNED_ACTION_TYPES` for `laneSource`. PURE. */
export function isIntakeSignedForLane(actionType: string, laneSource: NewTypeIntakeLaneSource): boolean {
  if (!Object.prototype.hasOwnProperty.call(INTAKE_SIGNED_ACTION_TYPES, actionType)) return false;
  const lanes: unknown = INTAKE_SIGNED_ACTION_TYPES[actionType];
  return Array.isArray(lanes) && lanes.includes(laneSource);
}

/** The queue states under which a type that entered on a lane keeps being admitted there. */
const ENTERED_ON_LANE_STATES: ReadonlySet<PendingPolicyReviewState> = new Set<PendingPolicyReviewState>([
  'pending_policy',
  'resolved_signed_matrix',
]);

export type NewTypeIntakeVerdict =
  | { readonly admitted: true; readonly basis: 'never_seen' | 'entered_on_lane' }
  | {
    readonly admitted: false;
    readonly reason:
      | 'invalid_action_type'
      | 'relay_owned_namespace'
      | 'named_type_witnessed_elsewhere'
      | 'intake_queue_unreadable';
  };

/** A per-batch memo of queue verdicts (one read per type per batch). */
export type NewTypeIntakeCache = Map<string, Promise<NewTypeIntakeVerdict>>;

export function newTypeIntakeCache(): NewTypeIntakeCache {
  return new Map();
}

async function enteredOnLane(
  db: Firestore,
  actionType: string,
  laneSource: NewTypeIntakeLaneSource,
): Promise<NewTypeIntakeVerdict> {
  try {
    const snap = await db.collection(PENDING_POLICY_COLLECTION).doc(actionPolicyDocumentId(actionType)).get();
    if (!snap.exists) return { admitted: false, reason: 'named_type_witnessed_elsewhere' };
    const row = snap.data() as Record<string, unknown> | undefined;
    if (!row || row.action_type !== actionType) return { admitted: false, reason: 'named_type_witnessed_elsewhere' };
    const sources = row.integration_sources;
    const state = row.policy_review_state;
    // Entered ONLY through the intake: every source is an intake lane, and this lane is one of them.
    const onlyIntake = Array.isArray(sources)
      && sources.length > 0
      && sources.every((source) => typeof source === 'string' && INTAKE_LANE_SOURCE_SET.has(source));
    const onLane = onlyIntake && (sources as unknown[]).includes(laneSource);
    const live = typeof state === 'string' && ENTERED_ON_LANE_STATES.has(state as PendingPolicyReviewState);
    return onLane && live
      ? { admitted: true, basis: 'entered_on_lane' }
      : { admitted: false, reason: 'named_type_witnessed_elsewhere' };
  } catch {
    return { admitted: false, reason: 'intake_queue_unreadable' };
  }
}

/**
 * THE intake rule. Rule (i) is static and needs no read; rule (ii) reads the type's queue row
 * (memoized per batch when `cache` is passed). Never throws: a read failure is a refusal.
 */
export async function judgeNewTypeIntake(
  db: Firestore,
  input: { readonly actionType: unknown; readonly laneSource: NewTypeIntakeLaneSource },
  cache?: NewTypeIntakeCache,
): Promise<NewTypeIntakeVerdict> {
  if (!isValidPolicyActionType(input.actionType)) return { admitted: false, reason: 'invalid_action_type' };
  const actionType = input.actionType;
  if (isRelayOwnedActionType(actionType)) return { admitted: false, reason: 'relay_owned_namespace' };
  if (!STATICALLY_NAMED_ACTION_TYPES.has(actionType)) return { admitted: true, basis: 'never_seen' };
  // Rule (ii) admits only a type the operator signed for intake on THIS lane (no read needed to refuse).
  if (!isIntakeSignedForLane(actionType, input.laneSource)) {
    return { admitted: false, reason: 'named_type_witnessed_elsewhere' };
  }
  // ... and never a type another lane witnesses by name, whatever the grant says.
  if (OTHER_LANE_WITNESSED_TYPES.has(actionType)) return { admitted: false, reason: 'named_type_witnessed_elsewhere' };
  if (cache === undefined) return enteredOnLane(db, actionType, input.laneSource);
  const key = `${input.laneSource}\0${actionType}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const pending = enteredOnLane(db, actionType, input.laneSource);
  cache.set(key, pending);
  const verdict = await pending;
  // A failed read is never cached: the next act (or the retried batch) reads again.
  if (!verdict.admitted && verdict.reason === 'intake_queue_unreadable') cache.delete(key);
  return verdict;
}

/**
 * Invariant A3 — the pending-policy queue hears ONLY from witnessed lanes. An observation is
 * written for an unnamed type (`pending_policy` / `class_admitted` resolution) only when the sealed
 * witness class is a non-actor class. A bare actor declaration (the phone batch's unnamed type at
 * `actor_declared`, any lane with no witness) records at zero and never reaches the queue. PURE.
 */
export function shouldObservePendingPolicy(
  resolutionStatus: string,
  sealedWitnessClass: WitnessClass,
): boolean {
  return (resolutionStatus === 'pending_policy' || resolutionStatus === 'class_admitted')
    && WITNESSED_CLASSES.has(sealedWitnessClass);
}

/**
 * The integration source a pending-policy observation is filed under. The sovereign route reaches
 * the accrual through `generatePE` (integration source `agent_bank_generate_pe`, shared by every
 * relay-authored lane); its acts are the only ones carrying the verified sovereign-work occurrence
 * binding (`sovereignWorkOccurrenceId` + `sovereignWorkSignerAddress`, stamped by `generatePE` only
 * from the route's server-built `sovereign_work` + `verified` metadata). Those are filed under
 * {@link SOVEREIGN_HARDWARE_WITNESS_SOURCE} so the queue row names the lane the type came in on
 * (rule (ii)). Every other caller's source is unchanged. PURE; observability only, never pricing.
 */
export function pendingPolicyObservationSource(params: {
  readonly integrationSource?: string | null;
  readonly sovereignWorkOccurrenceId?: string | null;
  readonly sovereignWorkSignerAddress?: string | null;
}): string {
  const source = params.integrationSource?.trim() || 'unspecified_pe_submission_path';
  const sovereign = source === 'agent_bank_generate_pe'
    && typeof params.sovereignWorkOccurrenceId === 'string' && params.sovereignWorkOccurrenceId.length > 0
    && typeof params.sovereignWorkSignerAddress === 'string' && params.sovereignWorkSignerAddress.length > 0;
  return sovereign ? SOVEREIGN_HARDWARE_WITNESS_SOURCE : source;
}
