import { bindingChallengeExpiry } from './binding-expiry';
it('keeps millisecond wall time inside the contract block-time ceiling', () => {
  expect(bindingChallengeExpiry(1000, 1002345)).toBe(1300000);
  expect(bindingChallengeExpiry(1003, 1002345)).toBe(1302345);
});
it('refuses expired, malformed or unsafe clocks', () => {
  for (const args of [[2000,1000000],[1000,1300000],[1000,1400000],[1.2,1],[1,NaN],[Number.MAX_SAFE_INTEGER,1]]) {
    expect(() => bindingChallengeExpiry(args[0],args[1])).toThrow();
  }
});
