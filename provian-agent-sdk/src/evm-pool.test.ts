/**
 * Pool withdrawal calldata + address pins (P4-01-SDK).
 * - encodeWithdrawContribution byte-exact calldata (selector + bytes32 arg)
 * - poolAddressForChain resolves the institution deployment/PVT9 PoolV3 on Base (not the
 * retired pool, not the older cascade pool) and fails closed on
 * unconfigured chains
 * - the pool contract is in the SDK's CONTRACT_ALLOWLIST so the withdrawal
 * broadcast passes the signer's target guard
 */
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAddress, type Hex } from 'viem';
import { encodeWithdrawContribution, poolAddressForChain, POOL_ADDRESSES } from './evm-pool';
import { isAllowlistedTarget } from './evm-allowlist';
import { EvmSignerError } from './evm-signer';

const DEPLOYMENTS = join(__dirname, '..', '..', 'contracts', 'deployments');
const pvt9 = JSON.parse(
  readFileSync(join(DEPLOYMENTS, 'base-pvt9-institutions.json'), 'utf-8'),
) as { contracts: { poolV3: { address: string } } };
const pass3 = JSON.parse(
  readFileSync(join(DEPLOYMENTS, 'base-retired-addresses.json'), 'utf-8'),
) as { contracts: { poolV3: string }; retired: { poolV3: string } };
const NEW_POOL = getAddress(pvt9.contracts.poolV3.address); // 0xb355C79a…
const STALE_POOL = getAddress(pass3.contracts.poolV3); // 0x5102d092… (now retired)
const OLD_POOL = getAddress(pass3.retired.poolV3); // 0x2FA2C1C5…

const POOL_ID = ('0x' + '9'.repeat(64)) as Hex;

describe('encodeWithdrawContribution — byte-exact calldata', () => {
  it('matches the withdrawContribution(bytes32) selector + bytes32 arg', () => {
    const data = encodeWithdrawContribution(POOL_ID);
    const expectedSelector = ethers.id('withdrawContribution(bytes32)').slice(0, 10);
    expect(data.slice(0, 10)).toBe(expectedSelector);
    expect(data.toLowerCase()).toBe((expectedSelector + POOL_ID.slice(2)).toLowerCase());
    expect(data.length).toBe(2 + 8 + 64);
  });

  it('matches the ethers oracle', () => {
    const data = encodeWithdrawContribution(POOL_ID);
    const iface = new ethers.Interface(['function withdrawContribution(bytes32)']);
    expect(data.toLowerCase()).toBe(iface.encodeFunctionData('withdrawContribution', [POOL_ID]).toLowerCase());
  });

  it('rejects a malformed bytes32', () => {
    expect(() => encodeWithdrawContribution('0xnothex')).toThrow(EvmSignerError);
    expect(() => encodeWithdrawContribution('0x' + 'a'.repeat(63))).toThrow(/bytes32/);
  });
});

describe('poolAddressForChain', () => {
  it('resolves the institution deployment PoolV3 on Base, not the Pass-3 or older cascade pool', () => {
    expect(POOL_ADDRESSES.base).toBe(NEW_POOL);
    expect(POOL_ADDRESSES.base).not.toBe(STALE_POOL);
    expect(POOL_ADDRESSES.base).not.toBe(OLD_POOL);
    expect(poolAddressForChain('base')).toBe(NEW_POOL);
  });

  it('fails closed on chains where no pool is configured (Arbitrum/Optimism this slice)', () => {
    expect(() => poolAddressForChain('arbitrum')).toThrow(EvmSignerError);
    expect(() => poolAddressForChain('optimism')).toThrow(/not configured/);
  });
});

describe('CONTRACT_ALLOWLIST', () => {
  it('includes the Base pool so withdrawFromPool passes the sendTransaction target guard', () => {
    expect(isAllowlistedTarget('base', NEW_POOL)).toBe(true);
  });

  it("does NOT allowlist the retired pool or the older cascade pool", () => {
    expect(isAllowlistedTarget('base', STALE_POOL)).toBe(false);
    expect(isAllowlistedTarget('base', OLD_POOL)).toBe(false);
  });
});
