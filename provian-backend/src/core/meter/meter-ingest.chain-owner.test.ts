/**
 * Who may open a device chain. A registered device's id (`dev_<sha256>`) is derived at its
 * registration and its chain belongs to that device. A lane whose device id is only a label the
 * caller chose (the phone lane) may open a chain under such an id only when the device is
 * registered to the caller — never ahead of the registration, never for anyone else's device.
 *
 * Each case sends a batch that does not continue the chain (seq 2 on an unopened chain): a case
 * the ownership rule lets through is answered by the continuity check that follows it, so the
 * two outcomes are told apart without pricing anything.
 */
import { describe, expect, it, jest } from '@jest/globals';

jest.mock('../../cache', () => ({
  cache: { checkRateLimit: async () => ({ allowed: true }), get: async () => null, set: async () => {}, del: async () => {} },
  CacheUnavailableError: class CacheUnavailableError extends Error {},
}));

import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { ingestMeterBatch, type MeterLane } from './meter-ingest';
import { buildBatch, METER_GENESIS_PREV_HASH, PE_V2_SCHEMA, type PeV2 } from './meter-wire';

const T0 = Date.parse('2026-10-10T12:00:00Z');
const REGISTERED_ID = `dev_${'ab'.repeat(32)}`;
const PHONE_LABEL = 'phone-fingerprint-1234';

function lane(deviceId: string, actorId: string, ownerBoundChain: boolean): MeterLane {
  return {
    deviceId, actorId,
    resolveSealedRecipient: () => null,
    mapAct: async () => { throw new Error('no act is priced in these cases'); },
    extraWrites: () => [],
    ...(ownerBoundChain ? { ownerBoundChain: true } : {}),
  };
}

function offChainBatch(deviceId: string) {
  const pe = { schema: PE_V2_SCHEMA, pe_id: 'pe_1', device_id: deviceId, prev_hash: METER_GENESIS_PREV_HASH, timestamp: T0, action_type: 'compute_session', metadata: {} } as unknown as PeV2;
  return buildBatch({ device_id: deviceId, seq: 2, prev_batch_hash: 'cd'.repeat(32), created_at_ms: T0, pes: [pe] });
}

async function attempt(opts: { deviceId: string; actorId: string; ownerBound: boolean; registeredTo?: { owner_type: string; owner_user_id: string } }) {
  const db = createFakeFirestore() as unknown as Firestore;
  if (opts.registeredTo) await db.collection('devices').doc(opts.deviceId).set({ device_id: opts.deviceId, status: 'active', ...opts.registeredTo });
  const result = await ingestMeterBatch(db, lane(opts.deviceId, opts.actorId, opts.ownerBound), offChainBatch(opts.deviceId), T0);
  return { status: result.status, error: (result.body as { error?: unknown }).error };
}

const REFUSED = { status: 403, error: 'batch_device_not_owned' };
const PAST_THE_OWNERSHIP_RULE = { status: 409, error: 'batch_chain_broken' };

describe('opening a chain under a registered device id from a caller-labelled lane', () => {
  it('RED: an id no device is registered under yet cannot be taken ahead of its device', async () => {
    expect(await attempt({ deviceId: REGISTERED_ID, actorId: 'user_phone', ownerBound: true })).toEqual(REFUSED);
  });
  it('RED: a device registered to another owner, or to an agent, is refused', async () => {
    expect(await attempt({ deviceId: REGISTERED_ID, actorId: 'user_phone', ownerBound: true, registeredTo: { owner_type: 'human', owner_user_id: 'user_other' } })).toEqual(REFUSED);
    expect(await attempt({ deviceId: REGISTERED_ID, actorId: 'user_phone', ownerBound: true, registeredTo: { owner_type: 'agent', owner_user_id: 'user_phone' } })).toEqual(REFUSED);
  });
  it('control: a device registered to the caller, and a plain label, pass the ownership rule', async () => {
    expect(await attempt({ deviceId: REGISTERED_ID, actorId: 'user_phone', ownerBound: true, registeredTo: { owner_type: 'human', owner_user_id: 'user_phone' } })).toEqual(PAST_THE_OWNERSHIP_RULE);
    expect(await attempt({ deviceId: PHONE_LABEL, actorId: 'user_phone', ownerBound: true })).toEqual(PAST_THE_OWNERSHIP_RULE);
  });
  it('control: the device lane, authenticated by the device\'s own key, opens its chain without the registry read', async () => {
    expect(await attempt({ deviceId: REGISTERED_ID, actorId: 'agent_wallet', ownerBound: false })).toEqual(PAST_THE_OWNERSHIP_RULE);
  });
});
