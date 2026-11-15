import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { LANE_TEST_KEY, laneTestWallet } from './__test-helpers__/lane-chain-fixture';

jest.mock('../onchain/rpc-provider', () => ({ getOperatorBoundRpcLegs: () => [
  { operatorId: 'a', provider: { send: jest.fn() } }, { operatorId: 'b', provider: { send: jest.fn() } }] }));
jest.mock('./identity-attestor', () => ({ configuredIdentityAttestor: () => ({ address: `0x${'aa'.repeat(20)}` }) }));
jest.mock('./transaction-lane-legacy', () => ({ drainLegacyRecourse: jest.fn(async () => ({ adopted: 0, settled: 0, released: 0, rebroadcast: 0, waiting: 0 })) }));
jest.mock('./transaction-lane', () => ({ ...jest.requireActual('./transaction-lane'),
  runRecourseLane: jest.fn(async () => ({ skipped: 'lane_idle', signed: 0, replaced: 0, confirmed: 0, failed: 0, closedUnsigned: 0, waiting: 0, open: 0, nextNonce: 0, stopReason: null, errors: [] })) }));

import { drainLegacyRecourse } from './transaction-lane-legacy';
import { runRecourseLane } from './transaction-lane';
import { runRecourseLaneFor } from './transaction-lane-runtime';

const env = { RECOURSE_GAS_KEY: LANE_TEST_KEY, RECOURSE_GAS_ADDRESS: laneTestWallet().address } as NodeJS.ProcessEnv;
test('every lane run first releases anything the relay held before the lane existed, then runs the lane', async () => {
  const db = createFakeFirestore() as unknown as Firestore;
  await runRecourseLaneFor(db, { budgetMs: 1_000, env });
  expect(drainLegacyRecourse).toHaveBeenCalledTimes(1);
  expect(runRecourseLane).toHaveBeenCalledTimes(1);
  expect((drainLegacyRecourse as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan((runRecourseLane as jest.Mock).mock.invocationCallOrder[0]);
});
test('a failing legacy check never stops the lane', async () => {
  (drainLegacyRecourse as jest.Mock).mockRejectedValueOnce(Error('rpc_down'));
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  await runRecourseLaneFor(createFakeFirestore() as unknown as Firestore, { budgetMs: 1_000, env });
  expect(runRecourseLane).toHaveBeenCalledTimes(2);
  expect(warn).toHaveBeenCalledWith('[recourse-lane] legacy drain deferred:', 'rpc_down');
});
test('RED control: an unpinned lane key is refused before anything runs', async () => {
  await expect(runRecourseLaneFor(createFakeFirestore() as unknown as Firestore, { budgetMs: 1_000, env: { RECOURSE_GAS_KEY: LANE_TEST_KEY } as NodeJS.ProcessEnv }))
    .rejects.toThrow('recourse_lane_key_unpinned');
  expect(drainLegacyRecourse).toHaveBeenCalledTimes(2);
});
