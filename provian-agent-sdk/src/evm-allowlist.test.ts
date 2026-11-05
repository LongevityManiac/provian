/**
 * Regression: the agent signer's "only safety boundary" the contract allowlist
 * must allowlist the institution deployment/PVT9 BondPool + EscrowV4 and REJECT the superseded
 * Pass-3 contracts AND the older PVTv8-cascade contracts. FAILS against the
 * pre- Pass-3 default (`0x6150Bc53…`/`0x15Ec2365…`); PASSES once resolved
 * from `base-pvt9-institutions.json`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAddress } from 'viem';
import { CONTRACT_ALLOWLIST, isAllowlistedTarget } from './evm-allowlist';

const DEPLOYMENTS = join(__dirname, '..', '..', 'contracts', 'deployments');
const pvt9 = JSON.parse(
  readFileSync(join(DEPLOYMENTS, 'base-pvt9-institutions.json'), 'utf-8'),
) as { contracts: { escrowV4: { address: string }; bondPool: { address: string } } };
const pass3 = JSON.parse(
  readFileSync(join(DEPLOYMENTS, 'base-retired-addresses.json'), 'utf-8'),
) as {
  contracts: { escrowV4: string; bondPool: string };
  retired: { escrowV4: string; bondPool: string };
};
const NEW_BOND = getAddress(pvt9.contracts.bondPool.address); // 0x6b09E9C7…
const NEW_ESCROW = getAddress(pvt9.contracts.escrowV4.address); // 0x96560fDF…
const STALE_BOND = getAddress(pass3.contracts.bondPool); // 0x6150Bc53… (now retired)
const STALE_ESCROW = getAddress(pass3.contracts.escrowV4); // 0x15Ec2365… (now retired)
const OLD_BOND = getAddress(pass3.retired.bondPool); // 0x2BDa41B6…
const OLD_ESCROW = getAddress(pass3.retired.escrowV4); // 0x10e3BdE9…

describe('evm-allowlist: institution deployment/PVT9 contracts allowlisted, all retired ones rejected', () => {
  it('CONTRACT_ALLOWLIST.base pins the institution deployment BondPool + EscrowV4', () => {
    expect(CONTRACT_ALLOWLIST.base.BondPool).toBe(NEW_BOND);
    expect(CONTRACT_ALLOWLIST.base.EscrowUSDC).toBe(NEW_ESCROW);
    expect(CONTRACT_ALLOWLIST.base.BondPool).not.toBe(STALE_BOND);
    expect(CONTRACT_ALLOWLIST.base.EscrowUSDC).not.toBe(STALE_ESCROW);
  });

  it('isAllowlistedTarget accepts the live institution deployment contracts (case-insensitive)', () => {
    expect(isAllowlistedTarget('base', NEW_BOND)).toBe(true);
    expect(isAllowlistedTarget('base', NEW_ESCROW.toLowerCase())).toBe(true);
  });

  it("isAllowlistedTarget REJECTS the retired and older cascade contracts", () => {
    expect(isAllowlistedTarget('base', STALE_BOND)).toBe(false);
    expect(isAllowlistedTarget('base', STALE_ESCROW)).toBe(false);
    expect(isAllowlistedTarget('base', OLD_BOND)).toBe(false);
    expect(isAllowlistedTarget('base', OLD_ESCROW)).toBe(false);
  });
});

/**
 * Import-purity: CONTRACT_ALLOWLIST is built on first ACCESS, never at module
 * import, so loading evm-allowlist — which the observer pulls in transitively
 * (x402-signer → ProvianClient → ProvianObserver) — reads no deployment artifact.
 * The self-contained bootstrap bundle ships none; an eager build crashed
 * `agent.js observe`. Mirrors the contract-addresses import-purity guard.
 *
 * RED control: the SAME no-deployments mock makes an actual allowlist access
 * throw, so "import resolves" cannot pass on an inert mock. Under the pre-fix
 * eager const, the dynamic import below would itself reject.
 */
describe('evm-allowlist import is filesystem-free (bundle safety)', () => {
  afterEach(() => {
    vi.doUnmock('node:fs');
    vi.resetModules();
  });

  async function importWithNoDeployments(): Promise<typeof import('./evm-allowlist')> {
    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        existsSync: (p: Parameters<typeof actual.existsSync>[0]) =>
          /deployments[/\\][^/\\]+\.json$/.test(String(p)) ? false : actual.existsSync(p),
      };
    });
    return import('./evm-allowlist.js');
  }

  it('imports cleanly with no deployment artifacts present (GREEN: lazy allowlist)', async () => {
    await expect(importWithNoDeployments()).resolves.toBeDefined();
  });

  it('still fails closed when the contract allowlist is actually read (RED control: mock is live)', async () => {
    const mod = await importWithNoDeployments();
    expect(() => mod.CONTRACT_ALLOWLIST.base).toThrow(/deployment artifact/);
    // A token-only allowlist check (no institution artifact) stays usable: USDC
    // is pinned in TOKEN_ALLOWLIST, so this resolves true without reading a file.
    const usdc = mod.getToken('base', 'USDC').address;
    expect(mod.isAllowlistedTarget('base', usdc)).toBe(true);
  });
});
