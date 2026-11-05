/**
 * INTAKE-SIGNED ACTION TYPES — the positive grant behind new-type intake rule (ii).
 *
 * A never-seen type that enters on an intake lane (the sovereign lane's admitted hardware witness,
 * or a device's observer gateway plugin) records with no mint and queues in
 * `pvt_pending_policy_queue`. When the operator signs it, it becomes a NAMED matrix row — and from then on
 * rule (i) ("never-seen") no longer admits it. Rule (ii) keeps admitting it on the lane it came in
 * on ONLY when it is listed here, for that lane.
 *
 * Why a positive list, not an inference: the relay emits most of its own named types from
 * constants and watcher specs, not from literals the matrix generator can see
 * (`commons_post_replied`, `human_job_payment_released`, `bond_slashed` …). Once a type is named,
 * the relay's own emission writes no queue observation, so a queue row that lists only an intake
 * lane proves nothing about who witnesses the type. Without this list, a type an intake lane
 * pre-queued before the operator signed it for a RELAY lane would be admitted on the intake lane and mint
 * at the relay row's price, skipping the relay's witness (and, for speech, the burn budget).
 *
 * SIGNING AN INTAKE TYPE IS TWO EDITS IN ONE CHANGE:
 * 1. the signed action-policy matrix row (and the signed monetary template, under the operator’s SSHSIG);
 * 2. an entry here: `<action_type>: [<the intake lane source id(s) the operator signed it for>]`, using
 * `'sovereign_hardware_witness'` and/or `'device_gateway_observer'`
 * (`NEW_TYPE_INTAKE_LANE_SOURCES` in `new-type-intake.ts`).
 * A type signed for any other lane is never listed here. An entry without a matrix row admits
 * nothing that can earn: the type is still never-seen and records at weight 0 under rule (i).
 *
 * Empty today: the operator has signed no intake type.
 *
 * This file sits under `core/pvt/policy/`, which the matrix generator's emitter scan skips, and its
 * entries are object keys, not `actionType:` / `action_type:` literals — it moves no matrix row.
 */
import type { NewTypeIntakeLaneSource } from './new-type-intake';

export const INTAKE_SIGNED_ACTION_TYPES: Readonly<Record<string, readonly NewTypeIntakeLaneSource[]>> =
  Object.freeze({});

