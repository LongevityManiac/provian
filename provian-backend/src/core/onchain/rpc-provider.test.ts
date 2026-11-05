/**
 * rpc-provider tests — verifier (quorum-2) vs general (quorum-1) providers.
 *
 * getVerifierProvider must require TWO endpoints bound to distinct operator
 * identities to AGREE (quorum 2, equal weights) before a verification read is
 * accepted, so a single compromised or malicious RPC cannot forge a receipt
 * into a "verified" Provenance Envelope. Different hostnames alone do not count.
 * getChainProvider stays quorum 1 (availability) for general/non-verification
 * reads. See the security rationale in rpc-provider.ts.
 *
 * The quorum/weight invariant is what makes the behavior deterministic:
 *   - both legs weight 1, quorum 2  => a single leg (weight 1 < 2) can NEVER meet
 *     quorum, so a lone forged/available endpoint cannot produce a result and a
 *     single-provider outage fails closed; only BOTH legs agreeing (1 + 1 = 2)
 *     satisfies quorum. (Behavioral fail-closed at the verifier layer is covered
 *     in tx-verifier.test.ts.)
 */

import {
  getChainProvider,
  getVerifierProvider,
  getVerifierProviderIdentity,
  _clearProviderCache,
  RPC_ENV_VARS,
  RPC_OPERATOR_ENV_VARS,
  RPC_SECONDARY_ENV_VARS,
  RPC_SECONDARY_OPERATOR_ENV_VARS,
  type ChainName,
} from './rpc-provider';

const CHAINS: ChainName[] = ['base', 'arbitrum', 'optimism'];

describe('rpc-provider — verifier quorum-2 vs general quorum-1', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    _clearProviderCache();
    for (const chain of CHAINS) {
      for (const v of [
        RPC_ENV_VARS[chain],
        RPC_OPERATOR_ENV_VARS[chain],
        RPC_SECONDARY_ENV_VARS[chain],
        RPC_SECONDARY_OPERATOR_ENV_VARS[chain],
      ]) savedEnv[v] = process.env[v];
      // A non-empty primary makes the env-primary leg distinct from the chain public leg.
      process.env[RPC_ENV_VARS[chain]] = `https://primary.example/${chain}`;
      process.env[RPC_OPERATOR_ENV_VARS[chain]] = `primary-${chain}`;
      delete process.env[RPC_SECONDARY_ENV_VARS[chain]];
      delete process.env[RPC_SECONDARY_OPERATOR_ENV_VARS[chain]];
    }
  });

  afterEach(() => {
    for (const chain of CHAINS) {
      for (const v of [
        RPC_ENV_VARS[chain],
        RPC_OPERATOR_ENV_VARS[chain],
        RPC_SECONDARY_ENV_VARS[chain],
        RPC_SECONDARY_OPERATOR_ENV_VARS[chain],
      ]) {
        if (savedEnv[v] === undefined) delete process.env[v];
        else process.env[v] = savedEnv[v];
      }
    }
    _clearProviderCache();
  });

  it('getVerifierProvider requires two endpoints to agree (quorum 2, equal weights)', () => {
    for (const chain of CHAINS) {
      const p = getVerifierProvider(chain);
      expect(p.quorum).toBe(2);
      // env primary + chain public => two distinct operator-bound legs.
      expect(p.providerConfigs).toHaveLength(2);
      // Equal weight (1 each): neither leg meets quorum 2 alone, so both must agree.
      for (const cfg of p.providerConfigs) {
        expect(cfg.weight).toBe(1);
      }
      // Total weight (2) == quorum (2): a single forged/unavailable leg cannot pass.
      const totalWeight = p.providerConfigs.reduce((s, c) => s + c.weight, 0);
      expect(totalWeight).toBe(p.quorum);
    }
  });

  it('getChainProvider stays quorum 1 for general (non-verification) reads', () => {
    for (const chain of CHAINS) {
      const p = getChainProvider(chain);
      expect(p.quorum).toBe(1);
      // Same two legs, but quorum 1 means either single leg satisfies the read
      // (a primary outage cuts over to public without stalling).
      expect(p.providerConfigs).toHaveLength(2);
    }
  });

  it('configures two distinct operator-bound legs for every prod chain so quorum 2 is satisfiable', () => {
    for (const chain of CHAINS) {
      const p = getVerifierProvider(chain);
      expect(p.providerConfigs).toHaveLength(2);
      // No chain is left with a single real provider (which would make quorum 2
      // permanently unsatisfiable and silently break that chain's verification).
      expect(p.providerConfigs.length).toBeGreaterThanOrEqual(p.quorum);
    }
  });

  it('getVerifierProvider fails closed (throws) when the primary RPC env var is missing', () => {
    _clearProviderCache();
    const v = RPC_ENV_VARS.base;
    const prior = process.env[v];
    delete process.env[v];
    expect(() => getVerifierProvider('base')).toThrow(/is not set/);
    if (prior === undefined) delete process.env[v];
    else process.env[v] = prior;
  });

  // WS9: the verifier's second leg must be bound to a distinct operator
  // identity (not merely a second hostname or the primary queried twice). The general provider must keep the
  // public endpoint as its failover so wide eth_getLogs scans still work even
  // when the configured secondary is a free-tier (small getLogs range) provider.
  const legUrls = (p: ReturnType<typeof getVerifierProvider>): string[] =>
    p.providerConfigs.map((c) => (c.provider as unknown as { _getConnection(): { url: string } })._getConnection().url);

  it('getVerifierProvider uses BASE_RPC_URL_SECONDARY as its separately bound second leg when set', () => {
    _clearProviderCache();
    process.env.BASE_RPC_URL = 'https://public-primary.example/base';
    process.env.BASE_RPC_URL_SECONDARY = 'https://alchemy-secondary.example/base';
    process.env.BASE_RPC_SECONDARY_OPERATOR_ID = 'alchemy';
    const urls = legUrls(getVerifierProvider('base'));
    expect(urls).toContain('https://public-primary.example/base');
    expect(urls).toContain('https://alchemy-secondary.example/base');
    // It is not the same public endpoint twice; operator separation is checked
    // independently by the configured/pinned identity validation.
    expect(urls).not.toContain('https://mainnet.base.org');
    delete process.env.BASE_RPC_URL_SECONDARY;
    delete process.env.BASE_RPC_SECONDARY_OPERATOR_ID;
  });

  it('fails closed when the two verifier URLs use the same RPC host even with different labels', () => {
    _clearProviderCache();
    process.env.BASE_RPC_URL = 'https://same-provider.example/primary-key';
    process.env.BASE_RPC_URL_SECONDARY = 'https://same-provider.example/secondary-key';
    process.env.BASE_RPC_OPERATOR_ID = 'operator-a';
    process.env.BASE_RPC_SECONDARY_OPERATOR_ID = 'operator-b';
    expect(() => getVerifierProvider('base')).toThrow(/same host/);
    delete process.env.BASE_RPC_URL_SECONDARY;
    delete process.env.BASE_RPC_SECONDARY_OPERATOR_ID;
  });

  it('fails closed when different hostnames are declared as the same operator', () => {
    _clearProviderCache();
    process.env.BASE_RPC_URL = 'https://gateway-one.example/base';
    process.env.BASE_RPC_URL_SECONDARY = 'https://gateway-two.example/base';
    process.env.BASE_RPC_OPERATOR_ID = 'same-operator';
    process.env.BASE_RPC_SECONDARY_OPERATOR_ID = 'same-operator';
    expect(() => getVerifierProvider('base')).toThrow(/both legs are operated by same-operator/);
  });

  it('fails closed when an unrecognized endpoint has no bound operator identity', () => {
    _clearProviderCache();
    process.env.BASE_RPC_URL = 'https://unrecognized.example/base';
    delete process.env.BASE_RPC_OPERATOR_ID;
    expect(() => getVerifierProvider('base')).toThrow(/BASE_RPC_OPERATOR_ID is required/);
  });

  it('uses pinned operator ownership for known endpoints and rejects a conflicting declaration', () => {
    _clearProviderCache();
    process.env.BASE_RPC_URL = 'https://eth-mainnet.g.alchemy.com/v2/key';
    process.env.BASE_RPC_OPERATOR_ID = 'not-alchemy';
    expect(() => getVerifierProvider('base')).toThrow(/conflicts with the pinned operator alchemy/);
  });

  it('returns the validated operator pair separately from endpoint hostnames', () => {
    expect(getVerifierProviderIdentity('base')).toEqual({
      primaryOperatorId: 'primary-base',
      secondaryOperatorId: 'base-foundation',
    });
  });

  it('getChainProvider keeps the public endpoint as its failover and ignores the verifier secondary env', () => {
    _clearProviderCache();
    process.env.BASE_RPC_URL = 'https://public-primary.example/base';
    process.env.BASE_RPC_URL_SECONDARY = 'https://alchemy-secondary.example/base';
    process.env.BASE_RPC_SECONDARY_OPERATOR_ID = 'alchemy';
    const urls = legUrls(getChainProvider('base'));
    expect(urls).toContain('https://mainnet.base.org'); // wide-getLogs-capable failover preserved
    expect(urls).not.toContain('https://alchemy-secondary.example/base');
    delete process.env.BASE_RPC_URL_SECONDARY;
    delete process.env.BASE_RPC_SECONDARY_OPERATOR_ID;
  });

  it('getVerifierProvider falls back to the chain public endpoint when the secondary env is unset', () => {
    _clearProviderCache();
    process.env.BASE_RPC_URL = 'https://public-primary.example/base';
    delete process.env.BASE_RPC_URL_SECONDARY;
    const urls = legUrls(getVerifierProvider('base'));
    expect(urls).toContain('https://mainnet.base.org');
  });
});
