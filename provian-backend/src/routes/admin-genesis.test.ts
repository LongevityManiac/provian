import { describe, expect, it } from '@jest/globals';

import { buildGenesisConfigUpdate } from './admin-genesis';

describe('buildGenesisConfigUpdate — retired legacy boundary', () => {
  it('accepts only the one-way legacy kill', () => {
    expect(buildGenesisConfigUpdate({ enabled: false })).toEqual({
      update: { enabled: false },
      errors: [],
    });
  });

  it('rejects legacy re-arm', () => {
    const result = buildGenesisConfigUpdate({ enabled: true });
    expect(result.update).toEqual({});
    expect(result.errors).toContain(
      'legacy Genesis can only be disabled; PVT9 re-arm requires a signed activation manifest',
    );
  });

  it.each([
    'agent_wallet_created',
    'agent_wallet_funded',
    'wallet_funded',
    'agent_first_transaction',
    'wallet_first_transaction',
    'agent_sustained_activity',
    'wallet_sustained_activity',
  ])('rejects retired bounty key %s explicitly', (key) => {
    const result = buildGenesisConfigUpdate({ bounties: { [key]: 1 } });
    expect(result.update).toEqual({});
    expect(result.errors).toContain(`retired Genesis bounty key rejected: ${key}`);
  });

  it.each([
    'pool_cap_pvt',
    'per_source_cap_pvt',
    'funding_min_usd',
    'per_epoch_mint_cap_pvt',
    'per_wallet_cap_pvt',
    'decay',
    'sustained',
  ])('rejects obsolete config key %s', (key) => {
    const result = buildGenesisConfigUpdate({ [key]: 1 });
    expect(result.errors).toContain(`retired Genesis configuration key rejected: ${key}`);
  });

  it.each(['genesis_signup', 'genesis_human_signup', 'genesis_device_link'])(
    'rejects even current leg %s on the legacy surface',
    (key) => {
      const result = buildGenesisConfigUpdate({ bounties: { [key]: 75 } });
      expect(result.errors[0]).toContain(
        'PVT9 requires a separately approved and signed exact activation manifest',
      );
    },
  );

  it('rejects unknown keys and leaves an empty body empty', () => {
    expect(buildGenesisConfigUpdate({ surprise: 1 }).errors)
      .toContain('unknown Genesis configuration key rejected: surprise');
    expect(buildGenesisConfigUpdate({})).toEqual({ update: {}, errors: [] });
  });
});
