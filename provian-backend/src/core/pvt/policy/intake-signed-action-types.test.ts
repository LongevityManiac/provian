/**
 * The REAL `INTAKE_SIGNED_ACTION_TYPES` list (no mock) — rule (ii)'s positive grant.
 *
 * - every entry is a signed matrix row, granted only to intake lanes, never to a type another lane
 * witnesses by name and never in a relay-owned namespace (the validator has its own RED controls);
 * - it is EMPTY today (the operator has signed no intake type): a signing change edits this assertion;
 * - with the real list, the negative control types — relay types emitted from constants / watcher
 * specs that no static scan sees — are refused on an intake-only resolved queue row.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { KNOWN_LAUNCH_EMITTER_IDENTIFIERS } from './action-policy-gate';
import { INTAKE_SIGNED_ACTION_TYPES } from './intake-signed-action-types';
import {
  NEW_TYPE_INTAKE_LANE_SOURCES,
  isRelayOwnedActionType,
  judgeNewTypeIntake,
} from './new-type-intake';
import { actionPolicyDocumentId } from './pending-policy-queue';
import { PROPOSED_ACTION_POLICY_ENTRIES } from './proposed-action-policy';
import { STATICALLY_EMITTED_ACTION_TYPES } from './statically-emitted-action-types';

const MATRIX_ROWS = new Set(PROPOSED_ACTION_POLICY_ENTRIES.map((e) => e.action_type));
const OTHER_LANE = new Set<string>([...KNOWN_LAUNCH_EMITTER_IDENTIFIERS, ...STATICALLY_EMITTED_ACTION_TYPES]);
const INTAKE_LANES = new Set<string>(NEW_TYPE_INTAKE_LANE_SOURCES);

function listViolations(list: Readonly<Record<string, readonly string[]>>): string[] {
  const out: string[] = [];
  for (const [type, lanes] of Object.entries(list)) {
    if (!MATRIX_ROWS.has(type)) out.push(`${type}: no signed matrix row`);
    if (OTHER_LANE.has(type)) out.push(`${type}: another lane witnesses it`);
    if (isRelayOwnedActionType(type)) out.push(`${type}: relay-owned namespace`);
    if (!Array.isArray(lanes) || lanes.length === 0) out.push(`${type}: no lane`);
    else {
      if (new Set(lanes).size !== lanes.length) out.push(`${type}: duplicate lane`);
      for (const lane of lanes) if (!INTAKE_LANES.has(lane)) out.push(`${type}: non-intake lane ${lane}`);
    }
  }
  return out;
}

describe('INTAKE_SIGNED_ACTION_TYPES — the real list', () => {
  it('every entry is a signed matrix row granted only to intake lanes', () => {
    expect(listViolations(INTAKE_SIGNED_ACTION_TYPES)).toEqual([]);
  });

  it('RED — the validator reports each violating shape', () => {
    expect(listViolations({
      kiln_cycle_unsigned: ['device_gateway_observer'],
      escrow_completed: ['device_gateway_observer'],
      agent_sub_spawned: ['agent_bank_generate_pe'],
      'service:github_issues': ['sovereign_hardware_witness'],
      job_feature_bid_placed_fixture: [],
    })).toEqual([
      'kiln_cycle_unsigned: no signed matrix row',
      'escrow_completed: another lane witnesses it',
      'agent_sub_spawned: non-intake lane agent_bank_generate_pe',
      'service:github_issues: no signed matrix row',
      'service:github_issues: relay-owned namespace',
      'job_feature_bid_placed_fixture: no signed matrix row',
      'job_feature_bid_placed_fixture: no lane',
    ]);
  });

  it('is EMPTY today — the operator has signed no intake type (a signing change edits this line)', () => {
    expect(Object.keys(INTAKE_SIGNED_ACTION_TYPES)).toEqual([]);
  });

  it('RED ( , A) — with the real list, relay types are refused on an intake-only resolved row', async () => {
    const probe = ['commons_post_replied', 'human_job_payment_released', 'bond_slashed'];
    for (const t of probe) {
      for (const laneSource of NEW_TYPE_INTAKE_LANE_SOURCES) {
        const db = {
          collection: () => ({ doc: (id: string) => ({ get: async () => ({
            exists: id === actionPolicyDocumentId(t),
            data: () => ({ action_type: t, integration_sources: [laneSource], policy_review_state: 'resolved_signed_matrix' }),
          }) }) }),
        } as unknown as Firestore;
        expect([t, laneSource, await judgeNewTypeIntake(db, { actionType: t, laneSource })])
          .toEqual([t, laneSource, { admitted: false, reason: 'named_type_witnessed_elsewhere' }]);
      }
    }
  });
});
