import {
  loadPvtPrincipalConfig,
  _resetPvtPrincipalConfigForTests,
  getPvtAddressForChain,
  getPvtPrincipalChainString,
  isPvtPrincipalEnabledForChain,
  pvtPrincipalInstitutionAddress,
  logEnabledCurrenciesPerChain,
} from './pvt-principal-config';

// Canonical Base-mainnet values this config must return when enabled.
const PVT9_KERNEL_LOWER = '0x8811441914381143b9408c5c32247367f86f173a';
const BASE_INSTITUTIONS_ESCROW_V4 = '0x96560fDF49e563eFCdc2d502934676DC074732d0';
const BASE_INSTITUTIONS_PROMISE_V3 = '0x7506F4A052750260A0ddcdF5E63a77CC646d89B9';
const BASE_INSTITUTIONS_POOL_V3 = '0x1301BF63Cb6BaE7171f6c7D895C762B243964d26'; // shutdown coverage 2026-10-20

describe('PVT-principal config (4b/4d — flag-honoring, Base-only)', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    _resetPvtPrincipalConfigForTests();
  });

  describe('DISABLED — ENABLE_PVT_PRINCIPAL unset or not exactly "true"', () => {
    beforeEach(() => {
      delete process.env.ENABLE_PVT_PRINCIPAL;
      _resetPvtPrincipalConfigForTests();
    });

    it('returns the canonical disabled state', () => {
      expect(loadPvtPrincipalConfig()).toEqual({
        enabled: false,
        chains: [],
        escrowV4Address: '',
        promiseV3Address: '',
        poolV3Address: '',
        pvtAddressByChainId: {},
      });
    });

    it('fails closed for every chain string', () => {
      for (const chain of ['base', 'arbitrum', 'optimism', 'base_sepolia', 'unknown']) {
        expect(getPvtAddressForChain(chain)).toBeNull();
        expect(isPvtPrincipalEnabledForChain(chain)).toBe(false);
        expect(pvtPrincipalInstitutionAddress('escrowV4', chain)).toBeUndefined();
      }
      expect(getPvtPrincipalChainString()).toBeNull();
    });

    it('treats a non-exact flag value ("1", "TRUE", "yes") as disabled', () => {
      for (const value of ['1', 'TRUE', 'yes', 'True', ' true']) {
        process.env.ENABLE_PVT_PRINCIPAL = value;
        _resetPvtPrincipalConfigForTests();
        expect(isPvtPrincipalEnabledForChain('base')).toBe(false);
        expect(getPvtAddressForChain('base')).toBeNull();
      }
    });

    it('logs only the unconfigured runtime boundary state', () => {
      const lines: string[] = [];
      logEnabledCurrenciesPerChain(loadPvtPrincipalConfig(), (m) => lines.push(m));
      expect(lines).toEqual([
        '[PvtPrincipal] UNAVAILABLE - PVT-principal has no approved runtime in the current Service; legacy environment flags are ignored.',
      ]);
    });
  });

  describe('ENABLED — ENABLE_PVT_PRINCIPAL="true" (Base mainnet only)', () => {
    beforeEach(() => {
      process.env.ENABLE_PVT_PRINCIPAL = 'true';
      _resetPvtPrincipalConfigForTests();
    });

    it('enables Base and nothing else', () => {
      expect(isPvtPrincipalEnabledForChain('base')).toBe(true);
      for (const chain of ['arbitrum', 'optimism', 'base_sepolia', 'base-sepolia', 'unknown']) {
        expect(isPvtPrincipalEnabledForChain(chain)).toBe(false);
      }
    });

    it('returns the successor PVT9 kernel (lowercase) for base, null for other chains', () => {
      expect(getPvtAddressForChain('base')).toBe(PVT9_KERNEL_LOWER);
      for (const chain of ['arbitrum', 'optimism', 'base_sepolia', 'unknown']) {
        expect(getPvtAddressForChain(chain)).toBeNull();
      }
    });

    it('config carries the institution deployment institution addresses + base chain', () => {
      const config = loadPvtPrincipalConfig();
      expect(config.enabled).toBe(true);
      expect(config.chains).toEqual([8453]);
      expect(config.escrowV4Address).toBe(BASE_INSTITUTIONS_ESCROW_V4);
      expect(config.promiseV3Address).toBe(BASE_INSTITUTIONS_PROMISE_V3);
      expect(config.poolV3Address).toBe(BASE_INSTITUTIONS_POOL_V3);
      expect(config.pvtAddressByChainId).toEqual({ 8453: PVT9_KERNEL_LOWER });
    });

    it('pvtPrincipalInstitutionAddress returns institution deployment for base, undefined elsewhere', () => {
      expect(pvtPrincipalInstitutionAddress('escrowV4', 'base')).toBe(BASE_INSTITUTIONS_ESCROW_V4);
      expect(pvtPrincipalInstitutionAddress('promiseV3', 'base')).toBe(BASE_INSTITUTIONS_PROMISE_V3);
      expect(pvtPrincipalInstitutionAddress('poolV3', 'base')).toBe(BASE_INSTITUTIONS_POOL_V3);
      expect(pvtPrincipalInstitutionAddress('escrowV4', 'arbitrum')).toBeUndefined();
    });

    it('getPvtPrincipalChainString is "base"', () => {
      expect(getPvtPrincipalChainString()).toBe('base');
    });

    it('IGNORES stale legacy env addresses — canonical institution deployment/PVT9 wins', () => {
      Object.assign(process.env, {
        PVT_CONTRACT_ADDRESS: '0x1111111111111111111111111111111111111111',
        PVT_CONTRACT_ADDRESS_BASE: '0x2222222222222222222222222222222222222222',
        ESCROW_V4_CONTRACT_ADDRESS: '0x3333333333333333333333333333333333333333',
        ESCROW_V4_CONTRACT_ADDRESS_BASE: '0x3333333333333333333333333333333333333333',
        PROMISE_V3_CONTRACT_ADDRESS: '0x4444444444444444444444444444444444444444',
        POOL_V3_CONTRACT_ADDRESS: '0x5555555555555555555555555555555555555555',
        // A widening attempt via the ignored PVT_PRINCIPAL_CHAINS env must NOT
        // enable Arbitrum/Optimism — Base-only is hardcoded.
        PVT_PRINCIPAL_CHAINS: 'base,arbitrum,optimism',
      });
      _resetPvtPrincipalConfigForTests();
      const config = loadPvtPrincipalConfig();
      expect(config.escrowV4Address).toBe(BASE_INSTITUTIONS_ESCROW_V4);
      expect(config.pvtAddressByChainId).toEqual({ 8453: PVT9_KERNEL_LOWER });
      expect(getPvtAddressForChain('base')).toBe(PVT9_KERNEL_LOWER);
      expect(isPvtPrincipalEnabledForChain('arbitrum')).toBe(false);
      expect(isPvtPrincipalEnabledForChain('optimism')).toBe(false);
    });

    it('logs the ENABLED banner naming the canonical addresses', () => {
      const lines: string[] = [];
      logEnabledCurrenciesPerChain(loadPvtPrincipalConfig(), (m) => lines.push(m));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('[PvtPrincipal] ENABLED');
      expect(lines[0]).toContain('base(8453)');
      expect(lines[0]).toContain(PVT9_KERNEL_LOWER);
      expect(lines[0]).toContain(BASE_INSTITUTIONS_ESCROW_V4);
    });
  });

  // ── RED negative control ────────────────────────────────────────────
  // The SAME chain flips outcome SOLELY on the flag. A mutation that hardwires
  // the gate in EITHER direction (`enabled: true` always, or `return false`)
  // makes exactly one half of this assertion fail — so the guard cannot pass
  // vacuously. The evaluated-branch count is asserted so a zero-iteration pass
  // is impossible to mistake for a real one.
  it('the gate READS the flag (both directions must hold)', () => {
    let checks = 0;

    delete process.env.ENABLE_PVT_PRINCIPAL;
    _resetPvtPrincipalConfigForTests();
    expect(isPvtPrincipalEnabledForChain('base')).toBe(false);
    expect(getPvtAddressForChain('base')).toBeNull();
    checks += 1;

    process.env.ENABLE_PVT_PRINCIPAL = 'true';
    _resetPvtPrincipalConfigForTests();
    expect(isPvtPrincipalEnabledForChain('base')).toBe(true);
    expect(getPvtAddressForChain('base')).toBe(PVT9_KERNEL_LOWER);
    checks += 1;

    expect(checks).toBe(2);
  });
});
