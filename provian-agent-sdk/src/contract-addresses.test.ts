/**
 * Single-source-of-truth + retired-address guard tests for the SDK's protocol
 * contract addresses (cascade button-up 2a, then 4c-sdk).
 *
 * INVERTED the live/retired boundary: the Base institution default moved
 * from the Pass-3 stack (`base-retired-addresses.json`) to the institution deployment/PVT9 stack
 * (`base-pvt9-institutions.json`,), and the WHOLE Pass-3 stack (its
 * institutions + the PVTv8 kernel) joined the retired set. These tests bind every
 * resolver to the institution deployment JSON and assert the Pass-3 quartet is now unreachable. The
 * final `describe` is the grep-style guard: it walks the whole SDK source tree and
 * fails if ANY retired institution address reappears.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getAddress } from 'viem';
import {
  BASE_PVT9_ADDRESSES,
  retiredBaseAddresses,
  resolveBondPoolAddress,
  resolveEscrowUsdcAddress,
  resolvePoolAddress,
  isRetiredAddress,
} from './contract-addresses';

// The canonical deployment artifacts — the ONE source these values must match.
const DEPLOYMENTS = join(__dirname, '..', '..', 'contracts', 'deployments');

// The LIVE institution deployment/PVT9 Base institution set + successor kernel (the new default).
const pvt9 = JSON.parse(
  readFileSync(join(DEPLOYMENTS, 'base-pvt9-institutions.json'), 'utf-8'),
) as {
  contracts: {
    escrowV4: { address: string };
    promiseV3: { address: string };
    poolV3: { address: string };
    bondPool: { address: string };
    courtV2: { address: string };
  };
  successorKernel: { pvt9Kernel: { address: string } };
  predecessor: {
    pvt9Kernel: string;
    eligibilityVerifier: string;
    contracts: { escrowV4: string; promiseV3: string; poolV3: string; bondPool: string; courtV2: string };
  };
  d525: { retiredPoolV3: { address: string } };
  safetyPolicy: { retiredPoolV3: { address: string } };
  shutdownCoverage: { retiredPoolV3: { address: string } };
};

// The Pass-3 artifact — loaded here ONLY to name the now-retired addresses.
const pass3 = JSON.parse(
  readFileSync(join(DEPLOYMENTS, 'base-retired-addresses.json'), 'utf-8'),
) as {
  contracts: { escrowV4: string; poolV3: string; courtV2: string; bondPool: string };
  retired: { escrowV4: string; poolV3: string; courtV2: string; bondPool: string };
  reused: { pvtV8: string };
};
const arbChunkII = JSON.parse(
  readFileSync(join(DEPLOYMENTS, 'arbitrum-live.json'), 'utf-8'),
) as { contracts: { escrowV4: string } };

// LIVE institution deployment/PVT9 institutions.
const BASE_INSTITUTIONS_ESCROW = getAddress(pvt9.contracts.escrowV4.address); // 0x96560fDF…
const BASE_INSTITUTIONS_POOL = getAddress(pvt9.contracts.poolV3.address); // 0x1301BF63… (shutdown coverage 2026-10-20)
const BASE_INSTITUTIONS_COURT = getAddress(pvt9.contracts.courtV2.address); // 0x9a326D1f…
const BASE_INSTITUTIONS_BOND = getAddress(pvt9.contracts.bondPool.address); // 0x6b09E9C7…
const BASE_INSTITUTIONS_PVT = getAddress(pvt9.successorKernel.pvt9Kernel.address); // 0x88114419…
// The set retired.
const PREDECESSOR_KERNEL = getAddress(pvt9.predecessor.pvt9Kernel);
const PREDECESSOR_VERIFIER = getAddress(pvt9.predecessor.eligibilityVerifier);
const PREDECESSOR_ESCROW = getAddress(pvt9.predecessor.contracts.escrowV4);
const PREDECESSOR_PROMISE = getAddress(pvt9.predecessor.contracts.promiseV3);
const PREDECESSOR_POOL = getAddress(pvt9.predecessor.contracts.poolV3);
const PREDECESSOR_BOND = getAddress(pvt9.predecessor.contracts.bondPool);
const PREDECESSOR_COURT = getAddress(pvt9.predecessor.contracts.courtV2);
// The PoolV3 replaced in place.
const RETIRED_UNVALIDATED_POOL = getAddress(pvt9.safetyPolicy.retiredPoolV3.address);
const RETIRED_UNREFUNDABLE_POOL = getAddress(pvt9.shutdownCoverage.retiredPoolV3.address);

// Now-RETIRED: the retired institutions.
const STALE_ESCROW = getAddress(pass3.contracts.escrowV4); // 0x15Ec2365…
const STALE_POOL = getAddress(pass3.contracts.poolV3); //         0x5102d092…
const STALE_COURT = getAddress(pass3.contracts.courtV2); // 0x3d7091b3…
const STALE_BOND = getAddress(pass3.contracts.bondPool); //     0x6150Bc53…
// Older: the prior PVTv8-cascade quartet + the abandoned PVTv8 kernel.
const PRIOR_ESCROW = getAddress(pass3.retired.escrowV4); // 0x10e3BdE9…
const PRIOR_POOL = getAddress(pass3.retired.poolV3); // 0x2FA2C1C5…
const PRIOR_COURT = getAddress(pass3.retired.courtV2); // 0xA65Ac1c4…
const PRIOR_BOND = getAddress(pass3.retired.bondPool); // 0x2BDa41B6…
const PVTV8_KERNEL = getAddress(pass3.reused.pvtV8); // 0x50D6F1Ff…

describe('contract-addresses: resolves to the institution deployment/PVT9 stack, never the retired one', () => {
  const saved = { ...process.env };
  afterEach(() => {
    // Restore any env vars a test mutated so resolution stays default-driven.
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  it('BASE_PVT9_ADDRESSES equals the institution deployment institutions JSON (single source, no drift)', () => {
    expect(BASE_PVT9_ADDRESSES.escrow).toBe(BASE_INSTITUTIONS_ESCROW);
    expect(BASE_PVT9_ADDRESSES.pool).toBe(BASE_INSTITUTIONS_POOL);
    expect(BASE_PVT9_ADDRESSES.court).toBe(BASE_INSTITUTIONS_COURT);
    expect(BASE_PVT9_ADDRESSES.bondPool).toBe(BASE_INSTITUTIONS_BOND);
    // .pvt is the PVT9 successor kernel, NOT the abandoned PVTv8 kernel.
    expect(BASE_PVT9_ADDRESSES.pvt).toBe(BASE_INSTITUTIONS_PVT);
    expect(BASE_PVT9_ADDRESSES.pvt).not.toBe(PVTV8_KERNEL);
  });

  it('resolveBondPoolAddress(base) is the institution deployment bond, not the Pass-3 or older one', () => {
    const addr = resolveBondPoolAddress('base');
    expect(addr).toBe(BASE_INSTITUTIONS_BOND);
    expect(addr).not.toBe(STALE_BOND); // fail-before: the old default was 0x6150Bc53…
    expect(addr).not.toBe(PRIOR_BOND);
  });

  it('resolveEscrowUsdcAddress(base) is the institution deployment escrow, not the Pass-3 or older one', () => {
    const addr = resolveEscrowUsdcAddress('base');
    expect(addr).toBe(BASE_INSTITUTIONS_ESCROW);
    expect(addr).not.toBe(STALE_ESCROW); // fail-before: the old default was 0x15Ec2365…
    expect(addr).not.toBe(PRIOR_ESCROW);
  });

  it('resolvePoolAddress(base) is the institution deployment pool, not the Pass-3 or older one', () => {
    const addr = resolvePoolAddress('base');
    expect(addr).toBe(BASE_INSTITUTIONS_POOL);
    expect(addr).not.toBe(STALE_POOL); // fail-before: the old default was 0x5102d092…
    expect(addr).not.toBe(PRIOR_POOL);
  });

  it('arb/op escrow resolve to their Chunk-II EscrowV4 (unchanged — PVT/institutions are Base-only)', () => {
    expect(resolveEscrowUsdcAddress('arbitrum')).toBe(getAddress(arbChunkII.contracts.escrowV4));
    expect(resolveEscrowUsdcAddress('optimism')).toBe(getAddress(arbChunkII.contracts.escrowV4));
  });

  it('bond is Base-only this slice (arb/op return undefined → caller fails closed)', () => {
    expect(resolveBondPoolAddress('arbitrum')).toBeUndefined();
    expect(resolveBondPoolAddress('optimism')).toBeUndefined();
  });

  it('honors the SAME env-var override the backend uses (env → JSON default)', () => {
    const override = '0x1111111111111111111111111111111111111111';
    process.env.BOND_POOL_CONTRACT_ADDRESS_BASE = override;
    expect(resolveBondPoolAddress('base')).toBe(getAddress(override));
    delete process.env.BOND_POOL_CONTRACT_ADDRESS_BASE;

    process.env.ESCROW_CONTRACT_ADDRESS = override; // legacy single-valued fallback
    expect(resolveEscrowUsdcAddress('base')).toBe(getAddress(override));
  });

  it('the retired set is exactly the Pass-3 stack (institutions + prior quartet + PVTv8) plus the PVT9 set, checksummed', () => {
    expect(retiredBaseAddresses()).toEqual([
      STALE_ESCROW,
      STALE_POOL,
      STALE_COURT,
      STALE_BOND,
      PRIOR_ESCROW,
      PRIOR_POOL,
      PRIOR_COURT,
      PRIOR_BOND,
      PVTV8_KERNEL,
      PREDECESSOR_KERNEL,
      PREDECESSOR_VERIFIER,
      PREDECESSOR_ESCROW,
      PREDECESSOR_PROMISE,
      PREDECESSOR_POOL,
      PREDECESSOR_BOND,
      PREDECESSOR_COURT,
      RETIRED_UNVALIDATED_POOL,
      RETIRED_UNREFUNDABLE_POOL,
    ]);
    // the replaced pool is retired, is not the live pool, and no live resolver returns it.
    expect(RETIRED_UNVALIDATED_POOL).toBe('0x68d557e0A7049a8e32908E548556D22bCda1e3D0');
    expect(isRetiredAddress(RETIRED_UNVALIDATED_POOL)).toBe(true);
    expect(RETIRED_UNVALIDATED_POOL).not.toBe(BASE_INSTITUTIONS_POOL);
    // Shutdown coverage : the pool is retired too, and is not the live pool.
    expect(RETIRED_UNREFUNDABLE_POOL).toBe('0xb355C79a78DC0F33b7d1EF5dA230CD8097630a84');
    expect(isRetiredAddress(RETIRED_UNREFUNDABLE_POOL)).toBe(true);
    expect(BASE_INSTITUTIONS_POOL).toBe('0x1301BF63Cb6BaE7171f6c7D895C762B243964d26');
    expect(retiredBaseAddresses()).not.toContain(BASE_INSTITUTIONS_POOL);
    // the predecessor is retired, and no live resolver returns it.
    expect(PREDECESSOR_KERNEL).toBe('0x4Bf02d5C9bC4306c38603EF2aA164f2f2273bcd7');
    expect(retiredBaseAddresses()).not.toContain(BASE_INSTITUTIONS_PVT);
    expect(retiredBaseAddresses()).not.toContain(BASE_INSTITUTIONS_COURT);
    // The default (no env) resolution is never a retired address.
    expect(retiredBaseAddresses()).not.toContain(resolveBondPoolAddress('base'));
    expect(retiredBaseAddresses()).not.toContain(resolveEscrowUsdcAddress('base'));
    expect(retiredBaseAddresses()).not.toContain(resolvePoolAddress('base'));
    expect(retiredBaseAddresses()).not.toContain(resolveEscrowUsdcAddress('arbitrum'));
  });

  /**
   * NEGATIVE CONTROL — a guard that cannot fail is not evidence. This
   * asserts the SPECIFIC inversion makes, so it would go RED against the
   * pre-fix code (which defaulted Base to the Pass-3 quartet and had those
   * addresses OUTSIDE the retired set). Verified non-vacuous: reverting the Base
   * defaults + retired-set expansion in contract-addresses.ts turns every
   * assertion below RED (resolvers equalled the stale Pass-3 literals and
   * isRetiredAddress returned false for them).
   */
  it('NEGATIVE CONTROL: Base resolvers reject the stale Pass-3 literals and the stale ones are now retired', () => {
    // Pre-fix these three resolvers RETURNED exactly these literals.
    expect(resolveEscrowUsdcAddress('base')).not.toBe(STALE_ESCROW); // 0x15Ec2365…
    expect(resolveBondPoolAddress('base')).not.toBe(STALE_BOND); //     0x6150Bc53…
    expect(resolvePoolAddress('base')).not.toBe(STALE_POOL); //         0x5102d092…
    // …and instead return the institution deployment addresses.
    expect(resolveEscrowUsdcAddress('base')).toBe(BASE_INSTITUTIONS_ESCROW);
    expect(resolveBondPoolAddress('base')).toBe(BASE_INSTITUTIONS_BOND);
    expect(resolvePoolAddress('base')).toBe(BASE_INSTITUTIONS_POOL);
    // Pre-fix isRetiredAddress returned FALSE for the Pass-3 quartet (it wasn't
    // in the retired set); makes it true.
    expect(isRetiredAddress(STALE_ESCROW)).toBe(true);
    expect(isRetiredAddress(STALE_BOND)).toBe(true);
    expect(isRetiredAddress(STALE_POOL)).toBe(true);
    expect(isRetiredAddress(STALE_COURT)).toBe(true);
    // The abandoned PVTv8 kernel is retired; the live institution deployment addresses are not.
    expect(isRetiredAddress(PVTV8_KERNEL)).toBe(true);
    expect(isRetiredAddress(BASE_INSTITUTIONS_BOND)).toBe(false);
    expect(isRetiredAddress(BASE_INSTITUTIONS_ESCROW)).toBe(false);
    expect(isRetiredAddress(BASE_INSTITUTIONS_PVT)).toBe(false);
    // The prior PVTv8-cascade quartet stays retired (unchanged by).
    expect(isRetiredAddress(PRIOR_BOND)).toBe(true);
    expect(isRetiredAddress(PRIOR_ESCROW)).toBe(true);
  });
});

describe('GUARD: no retired institution address appears anywhere in the SDK source', () => {
  // Retired institution addresses read from the canonical JSON (NOT hardcoded
  // here — so this test file itself carries no retired literal to trip its own
  // scan). Covers BOTH the now-retired retired institution quartet and the
  // older PVTv8-cascade quartet.
  //
  // The PVTv8 KERNEL (0x50D6F1Ff…) is deliberately EXCLUDED from this scan: it is
  // a retired TOKEN, and it legitimately appears in
  // `pvt9-base-config.generated.ts` → `validation.forbidden_pvt_addresses`, which
  // is exactly where a forbidden token belongs. Scanning for it would flag that
  // correct forbidden-list entry as an offender. This guard covers the institution
  // CONTRACT addresses the signer must never resolve as a live target.
  const retiredLower = [
    pass3.contracts.escrowV4,
    pass3.contracts.poolV3,
    pass3.contracts.courtV2,
    pass3.contracts.bondPool,
    pass3.retired.escrowV4,
    pass3.retired.poolV3,
    pass3.retired.courtV2,
    pass3.retired.bondPool,
  ].map((a) => a.toLowerCase());

  function collectTsFiles(dir: string, out: string[]): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        collectTsFiles(full, out);
      } else if (entry.endsWith('.ts')) {
        out.push(full);
      }
    }
  }

  it('grep over src/**/*.ts finds zero retired institution-address literals', () => {
    const srcRoot = __dirname; // provian-agent-sdk/src
    const files: string[] = [];
    collectTsFiles(srcRoot, files);
    expect(files.length).toBeGreaterThan(5); // sanity: the walk actually ran

    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf-8').toLowerCase();
      for (const addr of retiredLower) {
        if (text.includes(addr)) {
          offenders.push(`${file} contains retired ${addr}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * Import-purity: loading this module must perform NO filesystem read. The
 * self-contained bootstrap bundle (`agent.js observe`/`bootstrap`) ships no
 * `deployments/` dir, and contract-addresses is dragged in transitively
 * (evm-allowlist → x402-signer → ProvianClient → the observer). An eager
 * top-level `loadDeployment` (which THROWS when the artifact is absent) crashed
 * the bundle at startup; the loaders are now lazy + memoized.
 *
 * The mock simulates the bundle (deployment artifacts unreadable). RED control:
 * the SAME mock makes an actual institution-address read throw — so the
 * "import resolves" assertion cannot pass vacuously on an inert mock, and the
 * fail-closed-at-use behaviour is proven intact. Under the pre-fix eager code,
 * the dynamic import below would itself REJECT with the not-found error.
 */
describe('contract-addresses import is filesystem-free (bundle safety)', () => {
  afterEach(() => {
    vi.doUnmock('node:fs');
    vi.resetModules();
  });

  async function importWithNoDeployments(): Promise<
    typeof import('./contract-addresses')
  > {
    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        // Every deployment artifact is "absent" — loadDeployment will throw if,
        // and only if, it is actually invoked.
        existsSync: (p: Parameters<typeof actual.existsSync>[0]) =>
          /deployments[/\\][^/\\]+\.json$/.test(String(p)) ? false : actual.existsSync(p),
      };
    });
    return import('./contract-addresses.js');
  }

  it('imports cleanly with no deployment artifacts present (GREEN: lazy loaders)', async () => {
    await expect(importWithNoDeployments()).resolves.toBeDefined();
  });

  it('still fails closed when an institution address is actually read (RED control: mock is live)', async () => {
    const mod = await importWithNoDeployments();
    // Touching a value that needs a deployment artifact throws — proving the
    // mock genuinely simulates absence (not a vacuous pass) and that the read is
    // merely deferred, never skipped.
    expect(() => mod.BASE_PVT9_ADDRESSES.escrow).toThrow(/deployment artifact/);
    expect(() => mod.retiredBaseAddresses()).toThrow(/deployment artifact/);
    // A non-institution path that does not touch an artifact stays usable.
    expect(mod.isRetiredAddress('not-an-address')).toBe(false);
  });
});
