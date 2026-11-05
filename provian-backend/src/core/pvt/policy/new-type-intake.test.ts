/**
 * new-type-intake — the ONE intake rule both witness lanes call .
 * Pure / read-only units, each with its RED negative control :
 * - rule (i) never-seen is STATIC: every name the relay knows is refused by it, a made-up one
 * is admitted, and no read or activation state can flip a named type to unnamed;
 * - rule (ii) needs the operator’s POSITIVE grant for THIS lane (`INTAKE_SIGNED_ACTION_TYPES`, mocked
 * here) AND the type's queue row to list only intake lanes, THIS one among them, in a live state;
 * - the A3 queue gate hears only witnessed classes;
 * - the sovereign lane's observations are filed under its source, nobody else's.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  ACTOR_DECLARED_REFUSED_ACTION_TYPES,
  RELAY_OWNED_ACTION_TYPE_PREFIXES,
  DEVICE_GATEWAY_OBSERVER_SOURCE,
  NEW_TYPE_INTAKE_LANE_SOURCES,
  SOVEREIGN_HARDWARE_WITNESS_SOURCE,
  hasObserverPluginWitnessMarker,
  isNeverSeenActionType,
  isStaticallyNamedActionType,
  judgeNewTypeIntake,
  newTypeIntakeCache,
  pendingPolicyObservationSource,
  shouldObservePendingPolicy,
} from './new-type-intake';
import { PROPOSED_ACTION_POLICY_ENTRIES, RETIRED_MATRIX_ACTION_TYPES } from './proposed-action-policy';
import { RETIRED_GENESIS_ACTION_TYPES } from './proposed-genesis-policy';
import { STATICALLY_EMITTED_ACTION_TYPES } from './statically-emitted-action-types';
import { PROPOSED_MONETARY_POLICY_TEMPLATE } from './proposed-monetary-policy';
import { KNOWN_LAUNCH_EMITTER_IDENTIFIERS } from './action-policy-gate';
import { DEVICE_OBSERVATION_ACTION_TYPES } from '../../provenance/device-observation-types';
import { WITNESS_CLASSES, WITNESSED_CLASSES } from './evidence-class';
import { actionPolicyDocumentId } from './pending-policy-queue';

const NEVER_SEEN = ['kiln', 'temperature', 'reading'].join('_');

// Rule (ii)'s positive grant, mutable per test. The real list is empty today and is bound by
// `intake-signed-action-types.test.ts`.
jest.mock('./intake-signed-action-types', () => ({ INTAKE_SIGNED_ACTION_TYPES: {} }));
const signedForIntake = (jest.requireMock('./intake-signed-action-types') as {
  INTAKE_SIGNED_ACTION_TYPES: Record<string, string[]>;
}).INTAKE_SIGNED_ACTION_TYPES;
function setIntakeGrant(actionType: string, lanes: readonly string[] | undefined): void {
  if (lanes === undefined) delete signedForIntake[actionType];
  else signedForIntake[actionType] = [...lanes];
}

function queueDb(rows: Record<string, Record<string, unknown>> = {}, opts: { throws?: boolean } = {}) {
  let reads = 0;
  const db = {
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          reads += 1;
          if (name !== 'pvt_pending_policy_queue') throw new Error(`unexpected collection ${name}`);
          if (opts.throws) throw new Error('unavailable');
          const row = rows[id];
          return { exists: row !== undefined, data: () => row };
        },
        set: async () => { throw new Error('the intake rule must never write'); },
      }),
    }),
  } as unknown as Firestore;
  return { db, reads: () => reads };
}

describe('rule (i) — never-seen is a STATIC check over every name the relay knows', () => {
  it('every matrix row, template action, launch emitter, observation type and -refused type is NAMED', () => {
    const named = [
      ...PROPOSED_ACTION_POLICY_ENTRIES.map((e) => e.action_type),
      ...Object.keys(PROPOSED_MONETARY_POLICY_TEMPLATE.actions),
      ...RETIRED_MATRIX_ACTION_TYPES,
      ...RETIRED_GENESIS_ACTION_TYPES,
      ...KNOWN_LAUNCH_EMITTER_IDENTIFIERS,
      ...DEVICE_OBSERVATION_ACTION_TYPES,
      ...ACTOR_DECLARED_REFUSED_ACTION_TYPES,
    ];
    expect(named.length).toBeGreaterThan(400); // never a pass over an empty population
    const leaked = named.filter((t) => isNeverSeenActionType(t));
    expect(leaked).toEqual([]);
  });

  it('RED (review fix 2) — the retired names are NAMED, never never-seen', () => {
    for (const retired of ['wallet_first_transaction', 'commons_challenge_escalated', 'agent_wallet_funded', 'wallet_sustained_activity']) {
      expect([retired, isNeverSeenActionType(retired)]).toEqual([retired, false]);
    }
  });

  it('RED (review fix 1a) — a relay-owned namespace is never never-seen and is refused on BOTH lanes', async () => {
    expect(RELAY_OWNED_ACTION_TYPE_PREFIXES).toEqual(['service:', 'git_']);
    const { db, reads } = queueDb();
    for (const owned of ['service:github_issues', 'service:github_release', 'service:gitlab_note', 'service:bitbucket_x', 'git_tag_pushed']) {
      expect([owned, isNeverSeenActionType(owned)]).toEqual([owned, false]);
      for (const laneSource of NEW_TYPE_INTAKE_LANE_SOURCES) {
        expect([owned, laneSource, await judgeNewTypeIntake(db, { actionType: owned, laneSource })])
          .toEqual([owned, laneSource, { admitted: false, reason: 'relay_owned_namespace' }]);
      }
    }
    expect(reads()).toBe(0);
  });

  it('a made-up, well-formed identifier (flat or namespaced) is never-seen', () => {
    expect(isNeverSeenActionType(NEVER_SEEN)).toBe(true);
    expect(isNeverSeenActionType('acme:kiln_cycle_completed')).toBe(true);
    expect(isStaticallyNamedActionType(NEVER_SEEN)).toBe(false);
  });

  it('RED — malformed identifiers are not never-seen (they are invalid)', () => {
    for (const bad of ['', '9x', 'a b', 'Acme:Upper', 'x'.repeat(201), null, 42]) {
      expect(isNeverSeenActionType(bad)).toBe(false);
    }
  });

  it('judge: never-seen admits with NO read; RED a named type is never admitted by rule (i)', async () => {
    const { db, reads } = queueDb();
    expect(await judgeNewTypeIntake(db, { actionType: NEVER_SEEN, laneSource: DEVICE_GATEWAY_OBSERVER_SOURCE }))
      .toEqual({ admitted: true, basis: 'never_seen' });
    expect(reads()).toBe(0);
    expect(await judgeNewTypeIntake(db, { actionType: 'send', laneSource: DEVICE_GATEWAY_OBSERVER_SOURCE }))
      .toEqual({ admitted: false, reason: 'named_type_witnessed_elsewhere' });
    expect(reads()).toBe(0); // `send` is statically emitted: refused without a read
    expect(await judgeNewTypeIntake(db, { actionType: 'bad type', laneSource: DEVICE_GATEWAY_OBSERVER_SOURCE }))
      .toEqual({ admitted: false, reason: 'invalid_action_type' });
  });
});

describe('rule (ii) — a named type the operator signed for intake on THIS lane, that entered on it', () => {
  // A named row that is neither a launch emitter nor statically emitted: the stand-in for "a type
  // that entered through the intake and that the operator has since signed for the intake".
  const NAMED = 'agent_sub_spawned';
  const id = actionPolicyDocumentId(NAMED);
  beforeEach(() => setIntakeGrant(NAMED, NEW_TYPE_INTAKE_LANE_SOURCES));
  afterEach(() => setIntakeGrant(NAMED, undefined));
  const row = (over: Record<string, unknown> = {}) => ({
    [id]: { action_type: NAMED, integration_sources: [SOVEREIGN_HARDWARE_WITNESS_SOURCE], policy_review_state: 'pending_policy', ...over },
  });

  it.each(['pending_policy', 'resolved_signed_matrix'])('admits on its lane while the row is %s', async (state) => {
    const { db } = queueDb(row({ policy_review_state: state }));
    expect(await judgeNewTypeIntake(db, { actionType: NAMED, laneSource: SOVEREIGN_HARDWARE_WITNESS_SOURCE }))
      .toEqual({ admitted: true, basis: 'entered_on_lane' });
  });

  it('RED — another lane, a rejected / classified row, a mismatched doc, or no row → refused', async () => {
    const cases: Array<[string, Record<string, Record<string, unknown>>, string]> = [
      ['other lane', row(), DEVICE_GATEWAY_OBSERVER_SOURCE],
      ['rejected', row({ policy_review_state: 'rejected' }), SOVEREIGN_HARDWARE_WITNESS_SOURCE],
      ['classified', row({ policy_review_state: 'classified_prospective' }), SOVEREIGN_HARDWARE_WITNESS_SOURCE],
      ['mismatch', row({ action_type: 'not_it' }), SOVEREIGN_HARDWARE_WITNESS_SOURCE],
      ['sources not an array', row({ integration_sources: SOVEREIGN_HARDWARE_WITNESS_SOURCE }), SOVEREIGN_HARDWARE_WITNESS_SOURCE],
      // Review fix 1b: any non-intake source means another lane witnesses the type.
      ['forge source beside the lane', row({ integration_sources: ['agent_bank_generate_pe', SOVEREIGN_HARDWARE_WITNESS_SOURCE], policy_review_state: 'resolved_signed_matrix' }), SOVEREIGN_HARDWARE_WITNESS_SOURCE],
      ['device observation source beside the lane', row({ integration_sources: ['device_pe_submit', SOVEREIGN_HARDWARE_WITNESS_SOURCE] }), SOVEREIGN_HARDWARE_WITNESS_SOURCE],
      ['phone source beside the lane', row({ integration_sources: ['mobile_pe_submit', SOVEREIGN_HARDWARE_WITNESS_SOURCE] }), SOVEREIGN_HARDWARE_WITNESS_SOURCE],
      ['empty sources', row({ integration_sources: [] }), SOVEREIGN_HARDWARE_WITNESS_SOURCE],
      ['no row', {}, SOVEREIGN_HARDWARE_WITNESS_SOURCE],
    ];
    for (const [label, rows, lane] of cases) {
      const { db } = queueDb(rows);
      const verdict = await judgeNewTypeIntake(db, { actionType: NAMED, laneSource: lane as typeof SOVEREIGN_HARDWARE_WITNESS_SOURCE });
      expect([label, verdict]).toEqual([label, { admitted: false, reason: 'named_type_witnessed_elsewhere' }]);
    }
  });

  it('RED ( , A) — no grant, or a grant for the OTHER lane only, refuses with NO read, whatever the queue row says', async () => {
    const intakeRow = row({ integration_sources: [...NEW_TYPE_INTAKE_LANE_SOURCES], policy_review_state: 'resolved_signed_matrix' });
    setIntakeGrant(NAMED, undefined);
    for (const laneSource of NEW_TYPE_INTAKE_LANE_SOURCES) {
      const { db, reads } = queueDb(intakeRow);
      expect(await judgeNewTypeIntake(db, { actionType: NAMED, laneSource }))
        .toEqual({ admitted: false, reason: 'named_type_witnessed_elsewhere' });
      expect(reads()).toBe(0);
    }
    setIntakeGrant(NAMED, [SOVEREIGN_HARDWARE_WITNESS_SOURCE]);
    const { db, reads } = queueDb(intakeRow);
    expect(await judgeNewTypeIntake(db, { actionType: NAMED, laneSource: DEVICE_GATEWAY_OBSERVER_SOURCE }))
      .toEqual({ admitted: false, reason: 'named_type_witnessed_elsewhere' });
    expect(reads()).toBe(0);
    expect(await judgeNewTypeIntake(db, { actionType: NAMED, laneSource: SOVEREIGN_HARDWARE_WITNESS_SOURCE }))
      .toEqual({ admitted: true, basis: 'entered_on_lane' });
  });

  it('RED ( , A) — relay types emitted from constants / watcher specs are refused on an intake-only resolved row with no grant', async () => {
    // the negative control: none of these is statically emitted, so only the positive grant stops them.
    const relayTypes = ['commons_post_replied', 'human_job_payment_released', 'bond_slashed'];
    for (const t of relayTypes) {
      expect([t, isStaticallyNamedActionType(t)]).toEqual([t, true]);
      expect([t, STATICALLY_EMITTED_ACTION_TYPES.includes(t)]).toEqual([t, false]);
      for (const laneSource of NEW_TYPE_INTAKE_LANE_SOURCES) {
        const { db } = queueDb({ [actionPolicyDocumentId(t)]: {
          action_type: t, integration_sources: [laneSource], policy_review_state: 'resolved_signed_matrix',
        } });
        expect([t, laneSource, await judgeNewTypeIntake(db, { actionType: t, laneSource })])
          .toEqual([t, laneSource, { admitted: false, reason: 'named_type_witnessed_elsewhere' }]);
      }
    }
  });

  it('both intake lanes on an intake-only row → admitted on each', async () => {
    const { db } = queueDb(row({ integration_sources: [SOVEREIGN_HARDWARE_WITNESS_SOURCE, DEVICE_GATEWAY_OBSERVER_SOURCE] }));
    for (const laneSource of NEW_TYPE_INTAKE_LANE_SOURCES) {
      expect(await judgeNewTypeIntake(db, { actionType: NAMED, laneSource })).toEqual({ admitted: true, basis: 'entered_on_lane' });
    }
  });

  it('RED (review fix 1c) — a launch emitter or a statically emitted row is refused even with an intake-only row (no read)', async () => {
    const launch = 'escrow_completed';
    expect(KNOWN_LAUNCH_EMITTER_IDENTIFIERS).toContain(launch);
    const staticOnly = STATICALLY_EMITTED_ACTION_TYPES.filter((t) => !KNOWN_LAUNCH_EMITTER_IDENTIFIERS.includes(t));
    expect(staticOnly.length).toBeGreaterThan(0); // never a pass over an empty population
    for (const t of [launch, ...staticOnly]) {
      setIntakeGrant(t, NEW_TYPE_INTAKE_LANE_SOURCES); // even a (wrongful) grant cannot admit it
      const { db, reads } = queueDb({ [actionPolicyDocumentId(t)]: {
        action_type: t, integration_sources: [DEVICE_GATEWAY_OBSERVER_SOURCE], policy_review_state: 'resolved_signed_matrix',
      } });
      expect([t, await judgeNewTypeIntake(db, { actionType: t, laneSource: DEVICE_GATEWAY_OBSERVER_SOURCE })])
        .toEqual([t, { admitted: false, reason: 'named_type_witnessed_elsewhere' }]);
      expect(reads()).toBe(0);
      setIntakeGrant(t, undefined);
    }
  });

  it('RED — a queue read failure refuses (Unknown = Block)', async () => {
    const { db } = queueDb({}, { throws: true });
    expect(await judgeNewTypeIntake(db, { actionType: NAMED, laneSource: SOVEREIGN_HARDWARE_WITNESS_SOURCE }))
      .toEqual({ admitted: false, reason: 'intake_queue_unreadable' });
  });

  it('RED (review fix 3) — a failed read is never cached: the next judgment reads again', async () => {
    let fail = true;
    let reads = 0;
    const db = {
      collection: () => ({ doc: () => ({ get: async () => {
        reads += 1;
        if (fail) throw new Error('unavailable');
        return { exists: true, data: () => ({ action_type: NAMED, integration_sources: [SOVEREIGN_HARDWARE_WITNESS_SOURCE], policy_review_state: 'pending_policy' }) };
      } }) }),
    } as unknown as Firestore;
    const cache = newTypeIntakeCache();
    const input = { actionType: NAMED, laneSource: SOVEREIGN_HARDWARE_WITNESS_SOURCE } as const;
    expect(await judgeNewTypeIntake(db, input, cache)).toEqual({ admitted: false, reason: 'intake_queue_unreadable' });
    fail = false;
    expect(await judgeNewTypeIntake(db, input, cache)).toEqual({ admitted: true, basis: 'entered_on_lane' });
    expect(await judgeNewTypeIntake(db, input, cache)).toEqual({ admitted: true, basis: 'entered_on_lane' });
    expect(reads).toBe(2); // the success IS cached
  });

  it('the per-batch cache reads each (lane, type) once', async () => {
    const { db, reads } = queueDb(row());
    const cache = newTypeIntakeCache();
    for (let i = 0; i < 3; i++) await judgeNewTypeIntake(db, { actionType: NAMED, laneSource: SOVEREIGN_HARDWARE_WITNESS_SOURCE }, cache);
    await judgeNewTypeIntake(db, { actionType: NAMED, laneSource: DEVICE_GATEWAY_OBSERVER_SOURCE }, cache);
    expect(reads()).toBe(2);
  });
});

describe('the gateway plugin witness marker', () => {
  it('accepts exactly source observer_plugin + a bounded printable plugin name', () => {
    expect(hasObserverPluginWitnessMarker({ source: 'observer_plugin', observer_plugin: 'sensor-gateway' })).toBe(true);
    expect(hasObserverPluginWitnessMarker({ source: 'observer_plugin', observer_plugin: 'acme/kiln@2' })).toBe(true);
  });
  it('RED — anything else is no marker', () => {
    for (const md of [null, undefined, [], 'observer_plugin', {}, { source: 'observer_plugin' },
      { source: 'transcript', observer_plugin: 'x' }, { source: 'observer_plugin', observer_plugin: '' },
      { source: 'observer_plugin', observer_plugin: 'x'.repeat(129) }, { source: 'observer_plugin', observer_plugin: 'a\nb' },
      { source: 'observer_plugin', observer_plugin: '-leading' }]) {
      expect([md, hasObserverPluginWitnessMarker(md)]).toEqual([md, false]);
    }
  });
});

describe('A3 — the pending-policy queue hears only witnessed classes', () => {
  it('unnamed (pending_policy / class_admitted) + a witnessed class → observed', () => {
    expect(WITNESSED_CLASSES.size).toBe(5);
    for (const cls of WITNESSED_CLASSES) {
      expect(shouldObservePendingPolicy('class_admitted', cls)).toBe(true);
      expect(shouldObservePendingPolicy('pending_policy', cls)).toBe(true);
    }
  });
  it('RED — actor_declared is never observed; named resolutions are never observed', () => {
    expect(shouldObservePendingPolicy('class_admitted', 'actor_declared')).toBe(false);
    expect(shouldObservePendingPolicy('pending_policy', 'actor_declared')).toBe(false);
    for (const cls of WITNESS_CLASSES) {
      for (const status of ['known_launch_identifier', 'classified_prospective', 'rejected']) {
        expect(shouldObservePendingPolicy(status, cls)).toBe(false);
      }
    }
  });
});

describe('the queue source a sovereign observation is filed under', () => {
  it('a verified sovereign occurrence via generatePE → sovereign_hardware_witness', () => {
    expect(pendingPolicyObservationSource({
      integrationSource: 'agent_bank_generate_pe', sovereignWorkOccurrenceId: 'occ_12345678', sovereignWorkSignerAddress: '0xabc',
    })).toBe(SOVEREIGN_HARDWARE_WITNESS_SOURCE);
  });
  it('RED — every other caller keeps its own source (a relay PE with no occurrence, a device act, none)', () => {
    expect(pendingPolicyObservationSource({ integrationSource: 'agent_bank_generate_pe' })).toBe('agent_bank_generate_pe');
    expect(pendingPolicyObservationSource({ integrationSource: 'agent_bank_generate_pe', sovereignWorkOccurrenceId: 'occ_12345678' })).toBe('agent_bank_generate_pe');
    expect(pendingPolicyObservationSource({
      integrationSource: DEVICE_GATEWAY_OBSERVER_SOURCE, sovereignWorkOccurrenceId: 'occ', sovereignWorkSignerAddress: '0xabc',
    })).toBe(DEVICE_GATEWAY_OBSERVER_SOURCE);
    expect(pendingPolicyObservationSource({ integrationSource: '  ' })).toBe('unspecified_pe_submission_path');
  });
  it('the two lane sources are distinct and exported', () => {
    expect(new Set(NEW_TYPE_INTAKE_LANE_SOURCES).size).toBe(2);
  });
});
