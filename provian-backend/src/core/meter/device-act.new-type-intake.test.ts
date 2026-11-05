/**
 * NEW-TYPE INTAKE on the device batch .
 *
 * A type outside the observation lanes is admitted on `POST /v1/meter/batch` iff the observer
 * daemon marked the act as a registered plugin's observation (`metadata.source ===
 * 'observer_plugin'` + a bounded `metadata.observer_plugin` name — the parallel of the transcript
 * lane's `link_spend` source) AND the type passes the one intake rule on this lane (never-seen, or
 * signed for intake on this lane — `INTAKE_SIGNED_ACTION_TYPES`, mocked here — with a queue row that
 * lists `device_gateway_observer`). It is filed under that lane's source. Everything
 * else is refused exactly as before; observation types are untouched.
 *
 * Each acceptance carries its RED control: the same act without the marker, with a forged/blank
 * marker, a named type, a queue row from another lane, and an unreadable queue.
 */
import { describe, expect, it, jest } from '@jest/globals';

// Rule (ii)'s positive grant: the stand-in named type is "signed for intake" on both lanes (the
// queue row still decides which lane it entered on). The real list is empty today.
jest.mock('../pvt/policy/intake-signed-action-types', () => ({
  INTAKE_SIGNED_ACTION_TYPES: { agent_sub_spawned: ['sovereign_hardware_witness', 'device_gateway_observer'] },
}));
import type { Firestore } from 'firebase-admin/firestore';
import { deviceActToAccrualParams, type DeviceBatchLane } from './device-act';
import type { ActRecord } from './meter-wire';
import type { DeviceDocument } from '../../routes/middleware/device-auth';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import {
  DEVICE_GATEWAY_OBSERVER_SOURCE,
  OBSERVER_PLUGIN_SOURCE,
  SOVEREIGN_HARDWARE_WITNESS_SOURCE,
  newTypeIntakeCache,
} from '../pvt/policy/new-type-intake';
import { PENDING_POLICY_COLLECTION, actionPolicyDocumentId } from '../pvt/policy/pending-policy-queue';
import { DEVICE_OBSERVATION_ACTION_TYPES } from '../provenance/device-observation-types';

const NEVER_SEEN = ['soil', 'moisture', 'reading', 'gateway'].join('_');
const MARKER = { source: OBSERVER_PLUGIN_SOURCE, observer_plugin: 'sensor-gateway' };
const NOW = Date.now();

function lane(db: Firestore, ownerType: 'agent' | 'human' = 'human'): DeviceBatchLane {
  return {
    db,
    device: { owner_type: ownerType, device_id: 'dev_gw_1', owner_user_id: 'user_gw', owner_wallet_id: 'w_gw' } as DeviceDocument,
    ownerId: 'user_gw', signatureAuthenticated: true, bodyBound: true, attestationTier: 'software',
    receivedAtMs: NOW, lineage: null, lineageTouched: false, intakeCache: newTypeIntakeCache(),
  };
}

let seq = 0;
function act(actionType: string, metadata: Record<string, unknown> | undefined): ActRecord {
  seq += 1;
  return {
    action_type: actionType, pe_id: `pe_gw_${seq}`, timestamp: NOW, prev_hash: 'genesis',
    pe_hash: `sha256:${'a'.repeat(64)}`,
    pricing: { ...(metadata ? { metadata } : {}), output_digests: [{ hash: `sha256:${'b'.repeat(64)}`, kind: 'sensor' }] },
  };
}

function throwingDb(): Firestore {
  return {
    collection: () => ({ doc: () => ({ get: async () => { throw new Error('firestore unavailable'); } }) }),
  } as unknown as Firestore;
}

async function map(db: Firestore, a: ActRecord, owner: 'agent' | 'human' = 'human') {
  return deviceActToAccrualParams(lane(db, owner), a, `relay_${a.pe_id}`);
}

describe('A2 — a gateway plugin\'s never-seen type is recorded under device_gateway_observer', () => {
  it.each(['human', 'agent'] as const)('%s-owned device: admitted, filed under the gateway lane, no earning overlay before a signature', async (owner) => {
    const db = createFakeFirestore() as unknown as Firestore;
    const result = await map(db, act(NEVER_SEEN, MARKER), owner);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.params.actionType).toBe(NEVER_SEEN);
    expect(result.params.integrationSource).toBe(DEVICE_GATEWAY_OBSERVER_SOURCE);
    expect(result.params.witnessClass).toBe('device_tier');
    // No signed row yet → the intake earning overlay is EMPTY (the act seals record_only).
    expect(result.params.durableReplaySource).toBeUndefined();
    expect(result.params.deviceWitnessedOccurrenceHash).toBeUndefined();
  });

  it('RED — the SAME act without the marker is refused exactly as before', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    expect(await map(db, act(NEVER_SEEN, undefined))).toEqual({ ok: false, reason: 'actor_declared:action_type_not_observed' });
    expect(await map(db, act(NEVER_SEEN, { tool: 'sensor-gateway' }))).toEqual({ ok: false, reason: 'actor_declared:action_type_not_observed' });
  });

  it('RED — a forged or malformed marker is refused (source must be observer_plugin, plugin a bounded name)', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    const bad: Record<string, unknown>[] = [
      { source: 'transcript', observer_plugin: 'sensor-gateway' },
      { source: OBSERVER_PLUGIN_SOURCE },
      { source: OBSERVER_PLUGIN_SOURCE, observer_plugin: '' },
      { source: OBSERVER_PLUGIN_SOURCE, observer_plugin: ' leading-space' },
      { source: OBSERVER_PLUGIN_SOURCE, observer_plugin: 'x'.repeat(129) },
      { source: OBSERVER_PLUGIN_SOURCE, observer_plugin: 42 },
      { source: OBSERVER_PLUGIN_SOURCE, observer_plugin: 'has space' },
    ];
    for (const md of bad) {
      expect([md, await map(db, act(NEVER_SEEN, md))]).toEqual([md, { ok: false, reason: 'actor_declared:action_type_not_observed' }]);
    }
  });

  it('RED — the self-report label and an unbound body still refuse first', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    expect(await map(db, act(NEVER_SEEN, { ...MARKER, source: 'mcp_self_report' })))
      .toEqual({ ok: false, reason: 'actor_declared:self_report_source' });
    const unbound = { ...lane(db), bodyBound: false };
    expect(await deviceActToAccrualParams(unbound, act(NEVER_SEEN, MARKER), 'relay_x'))
      .toEqual({ ok: false, reason: 'actor_declared:device_body_not_bound' });
  });
});

describe('A2 — a NAMED non-observation type with the marker is refused', () => {
  it.each(['escrow_completed', 'genesis_signup', 'send', 'x402_payment', 'wallet_created', 'agent_work_product_code'])(
    '%s → actor_declared:named_type_witnessed_elsewhere',
    async (named) => {
      const db = createFakeFirestore() as unknown as Firestore;
      expect(await map(db, act(named, MARKER))).toEqual({ ok: false, reason: 'actor_declared:named_type_witnessed_elsewhere' });
    },
  );

  it('RED (review fix 1a) — a relay-owned namespace with the marker is refused (a forge name, the commit family)', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    for (const owned of ['service:github_issues', 'service:gitlab_note', 'git_tag_pushed']) {
      expect([owned, await map(db, act(owned, MARKER))]).toEqual([owned, { ok: false, reason: 'actor_declared:relay_owned_namespace' }]);
    }
  });

  it('a named type that ENTERED on this lane is admitted (rule ii); RED: entered on another lane / rejected → refused', async () => {
    const named = 'agent_sub_spawned';
    const seed = async (fake: FakeFirestore, row: Record<string, unknown>) => {
      await fake.collection(PENDING_POLICY_COLLECTION).doc(actionPolicyDocumentId(named)).set({
        action_type: named, integration_sources: [DEVICE_GATEWAY_OBSERVER_SOURCE], policy_review_state: 'pending_policy', ...row,
      });
    };
    const onLane = createFakeFirestore();
    await seed(onLane, {});
    const admitted = await map(onLane as unknown as Firestore, act(named, MARKER));
    expect(admitted.ok && admitted.params.integrationSource).toBe(DEVICE_GATEWAY_OBSERVER_SOURCE);

    const otherLane = createFakeFirestore();
    await seed(otherLane, { integration_sources: [SOVEREIGN_HARDWARE_WITNESS_SOURCE] });
    expect(await map(otherLane as unknown as Firestore, act(named, MARKER)))
      .toEqual({ ok: false, reason: 'actor_declared:named_type_witnessed_elsewhere' });

    const rejected = createFakeFirestore();
    await seed(rejected, { policy_review_state: 'rejected' });
    expect(await map(rejected as unknown as Firestore, act(named, MARKER)))
      .toEqual({ ok: false, reason: 'actor_declared:named_type_witnessed_elsewhere' });
  });

  it('RED (review fix 1b) — a row that ALSO lists another lane\'s source never admits the gateway', async () => {
    const named = 'agent_sub_spawned';
    const fake = createFakeFirestore();
    await fake.collection(PENDING_POLICY_COLLECTION).doc(actionPolicyDocumentId(named)).set({
      action_type: named, integration_sources: ['agent_bank_generate_pe', DEVICE_GATEWAY_OBSERVER_SOURCE], policy_review_state: 'resolved_signed_matrix',
    });
    expect(await map(fake as unknown as Firestore, act(named, MARKER)))
      .toEqual({ ok: false, reason: 'actor_declared:named_type_witnessed_elsewhere' });
  });

  it('RED ( , A) — relay types with NO intake grant are refused on an intake-only resolved row, with no read', async () => {
    for (const relayType of ['commons_post_replied', 'human_job_payment_released', 'bond_slashed']) {
      let reads = 0;
      const db = {
        collection: () => ({ doc: () => ({ get: async () => {
          reads += 1;
          return { exists: true, data: () => ({ action_type: relayType, integration_sources: [DEVICE_GATEWAY_OBSERVER_SOURCE], policy_review_state: 'resolved_signed_matrix' }) };
        } }) }),
      } as unknown as Firestore;
      expect([relayType, await map(db, act(relayType, MARKER))])
        .toEqual([relayType, { ok: false, reason: 'actor_declared:named_type_witnessed_elsewhere' }]);
      expect(reads).toBe(0);
    }
  });

  it('RED (review fix 3) — an unreadable queue THROWS (the batch fails and is resent), never a sealed refusal', async () => {
    await expect(map(throwingDb(), act('agent_sub_spawned', MARKER))).rejects.toThrow('new_type_intake_queue_unreadable');
  });

  it('invalid identifier syntax with the marker → invalid_action_type', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    expect(await map(db, act('9not_an_identifier', MARKER))).toEqual({ ok: false, reason: 'invalid_action_type' });
  });

  it('one queue read per type per batch (the lane cache)', async () => {
    let reads = 0;
    const db = {
      collection: () => ({ doc: () => ({ get: async () => { reads += 1; return { exists: false, data: () => undefined }; } }) }),
    } as unknown as Firestore;
    const l = lane(db);
    await deviceActToAccrualParams(l, act('agent_sub_spawned', MARKER), 'r1');
    await deviceActToAccrualParams(l, act('agent_sub_spawned', MARKER), 'r2');
    expect(reads).toBe(1);
  });
});

describe('observation types are untouched by the intake', () => {
  it('every observation type keeps integration source device_pe_submit, marker or not', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    const types = [...DEVICE_OBSERVATION_ACTION_TYPES].filter((t) => !['agent_tool_orchestration', 'agent_api_orchestration', 'link_spend'].includes(t));
    expect(types.length).toBeGreaterThanOrEqual(4); // never a pass over an empty population
    for (const t of types) {
      for (const md of [{}, MARKER]) {
        const r = await map(db, act(t, md));
        expect([t, r.ok && r.params.integrationSource]).toEqual([t, 'device_pe_submit']);
      }
    }
  });
});
