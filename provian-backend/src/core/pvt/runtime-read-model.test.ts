import { publicRuntimeGasWallets } from './runtime-read-model';

describe('public runtime identities', () => {
  it('publishes the public address without retaining any runtime key', () => {
    const key = '0x' + '11'.repeat(32);
    const states = publicRuntimeGasWallets({ PVT9_SETTLEMENT_MINTER_KEY: key });
    expect(Object.keys(states)).toHaveLength(6);
    expect(states.settlement_minter).toEqual({ configured: true,
      address: '0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a', error: null });
    expect(JSON.stringify(states)).not.toContain(key);
    expect(states.settlement_approver).toEqual({ configured: false, address: null, error: null });
  });
  it('RED: a malformed configured key stays configured and reports an error without echoing it', () => {
    const key = 'private-malformed-canary-keep-out-of-the-read-model';
    const state = publicRuntimeGasWallets({ PVT9_SETTLEMENT_APPROVER_KEY: key });
    expect(state.settlement_approver).toEqual({ configured: true, address: null, error: 'invalid_runtime_key' });
    expect(JSON.stringify(state)).not.toContain(key);
  });
  it('RED: whitespace is unconfigured and never invents an address', () => {
    const states = publicRuntimeGasWallets({ ESCROW_RELEASE_KEY: '   ' });
    expect(states.escrow_keeper).toEqual({ configured: false, address: null, error: null });
  });
});
