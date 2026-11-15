import { Wallet } from 'ethers';
import { RECOURSE_GAS_ADDRESS } from '../pvt/provian-service-wallets';
import { assertLaneKeyPinned, recourseLaneAddress } from './transaction-lane-key';
import { LANE_TEST_KEY } from './__test-helpers__/lane-chain-fixture';

const NO_ENV = {} as NodeJS.ProcessEnv;
test('the lane signs only from a pinned service wallet', () => {
  expect(() => assertLaneKeyPinned(RECOURSE_GAS_ADDRESS, NO_ENV)).not.toThrow();
  // RED control: the same check refuses an unpinned key's address.
  const unpinned = recourseLaneAddress({ RECOURSE_GAS_KEY: LANE_TEST_KEY } as NodeJS.ProcessEnv);
  expect(() => assertLaneKeyPinned(unpinned, NO_ENV)).toThrow('recourse_lane_key_unpinned');
  // A rotated successor named in env is accepted without a code change.
  expect(() => assertLaneKeyPinned(unpinned, { RECOURSE_GAS_ADDRESS: new Wallet(LANE_TEST_KEY).address } as NodeJS.ProcessEnv)).not.toThrow();
});
test('the key is required', () => {
  expect(() => recourseLaneAddress(NO_ENV)).toThrow('recourse_lane_key_unavailable');
});
