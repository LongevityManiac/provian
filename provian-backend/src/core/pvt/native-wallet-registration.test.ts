import {
  createNativeWalletRegistrationFence,
  parseNativeWalletRegistrationFence,
} from './native-wallet-registration';

describe('native wallet Base watcher registration fence', () => {
  it('persists the operator-agreed birth head and starts eligibility at H+1', () => {
    const fence = createNativeWalletRegistrationFence(140);
    expect(fence).toEqual({
      schema_version: 'native-wallet-base-registration/v1',
      chain_id: 8453,
      observed_head_block: 140,
      eligibility_start_block: 141,
    });
    expect(parseNativeWalletRegistrationFence(fence)).toEqual(fence);
    expect(Object.isFrozen(fence)).toBe(true);
  });

  it.each([
    undefined,
    {},
    {
      schema_version: 'native-wallet-base-registration/v1',
      chain_id: 8453,
      observed_head_block: 140,
      eligibility_start_block: 140,
    },
    {
      schema_version: 'native-wallet-base-registration/v1',
      chain_id: 8453,
      observed_head_block: 140,
      eligibility_start_block: 141,
      untrusted_extra: true,
    },
  ])('rejects a missing, inconsistent, or non-canonical fence: %p', (value) => {
    expect(() => parseNativeWalletRegistrationFence(value))
      .toThrow('native_wallet_registration_fence_invalid');
  });

  it('rejects a birth head that cannot safely produce H+1', () => {
    expect(() => createNativeWalletRegistrationFence(Number.MAX_SAFE_INTEGER))
      .toThrow('native_wallet_registration_head_invalid');
  });
});
