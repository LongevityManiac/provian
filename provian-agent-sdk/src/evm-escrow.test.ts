/**
 * Regression: the SDK escrow address must be the institution deployment/PVT9 EscrowV4, resolved
 * from the single source of truth — NOT the retired escrow nor the
 * older PVTv8-cascade escrow. FAILS against the pre- Pass-3 default
 * (`0x15Ec2365…`); PASSES once resolved from `base-pvt9-institutions.json`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAddress } from 'viem';
import { ESCROW_USDC_ADDRESSES, escrowAddressForChain } from './evm-escrow';
import { EvmSignerError } from './evm-signer';

const DEPLOYMENTS = join(__dirname, '..', '..', 'contracts', 'deployments');
const pvt9 = JSON.parse(
  readFileSync(join(DEPLOYMENTS, 'base-pvt9-institutions.json'), 'utf-8'),
) as { contracts: { escrowV4: { address: string } } };
const pass3 = JSON.parse(
  readFileSync(join(DEPLOYMENTS, 'base-retired-addresses.json'), 'utf-8'),
) as { contracts: { escrowV4: string }; retired: { escrowV4: string } };
const NEW_ESCROW = getAddress(pvt9.contracts.escrowV4.address); // 0x96560fDF…
const STALE_ESCROW = getAddress(pass3.contracts.escrowV4); // 0x15Ec2365… (now retired)
const OLD_ESCROW = getAddress(pass3.retired.escrowV4); // 0x10e3BdE9…

describe('evm-escrow: Base USDC escrow resolves to the institution deployment/PVT9 EscrowV4', () => {
  it('ESCROW_USDC_ADDRESSES.base is the institution deployment escrow, not the Pass-3 or older one', () => {
    expect(ESCROW_USDC_ADDRESSES.base).toBe(NEW_ESCROW);
    expect(ESCROW_USDC_ADDRESSES.base).not.toBe(STALE_ESCROW);
    expect(ESCROW_USDC_ADDRESSES.base).not.toBe(OLD_ESCROW);
  });

  it('escrowAddressForChain(usdc, base) returns the checksummed institution deployment escrow', () => {
    expect(escrowAddressForChain('usdc', 'base')).toBe(NEW_ESCROW);
  });

  it('PVT-principal escrow resolves on Base to the SAME institution deployment EscrowV4 (B15,); still fails closed elsewhere', () => {
    // 4b/4d enabled PVT principal on the backend against the institution deployment
    // escrow; the SDK's hard-close was the stale O12 orphan.
    expect(escrowAddressForChain('pvt', 'base')).toBe(escrowAddressForChain('usdc', 'base'));
    expect(() => escrowAddressForChain('pvt', 'arbitrum')).toThrow(EvmSignerError);
    expect(() => escrowAddressForChain('pvt', 'optimism')).toThrow(EvmSignerError);
  });
});
