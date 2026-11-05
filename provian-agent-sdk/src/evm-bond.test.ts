/**
 * Headless tests for the bond calldata encoders + deposit math (slice 2).
 * Oracles: hand-built selector+ABI words and ethers.Interface cross-check.
 */
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import {
  encodeApprove,
  encodePostBond,
  encodeRenewBond,
  encodeTopUpBond,
  grossUpTotalDeposit,
  requiredBondWei,
  bondPoolAddressForChain,
  BOND_POOL_ADDRESSES,
} from './evm-bond';
import { EvmSignerError } from './evm-signer';

// Live Base BondPool from the single source of truth (Pass-3 cascade) — never a
// retired literal, so the guard test in contract-addresses.test.ts stays green.
const SPENDER = BOND_POOL_ADDRESSES.base as `0x${string}`;

describe('encodeApprove', () => {
  it('matches the hand-built 0x095ea7b3 + padded args', () => {
    const data = encodeApprove(SPENDER, 1_000_000n);
    const expected =
      '0x095ea7b3' +
      SPENDER.slice(2).toLowerCase().padStart(64, '0') +
      (1_000_000n).toString(16).padStart(64, '0');
    expect(data.toLowerCase()).toBe(expected);
  });

  it('matches the ethers oracle for a large allowance', () => {
    const amount = 773195876288659793815n;
    const data = encodeApprove(SPENDER, amount);
    const iface = new ethers.Interface(['function approve(address,uint256)']);
    expect(data.toLowerCase()).toBe(iface.encodeFunctionData('approve', [SPENDER, amount]).toLowerCase());
  });

  it('rejects a negative amount', () => {
    expect(() => encodeApprove(SPENDER, -1n)).toThrow(EvmSignerError);
  });
});

describe('encodePostBond', () => {
  for (const level of [2, 3] as const) {
    it(`encodes postBond(${level}, discount) byte-exact vs ethers`, () => {
      const data = encodePostBond(level, 1500);
      const iface = new ethers.Interface(['function postBond(uint8,uint256)']);
      expect(data.toLowerCase()).toBe(iface.encodeFunctionData('postBond', [level, 1500]).toLowerCase());
      expect(data.slice(0, 10)).toBe(
        ethers.id('postBond(uint8,uint256)').slice(0, 10),
      );
    });
  }

  it('rejects bad level + out-of-range discount', () => {
    expect(() => encodePostBond(4 as unknown as 2, 0)).toThrow(/autonomyLevel/);
    expect(() => encodePostBond(2, 6000)).toThrow(/trustDiscountBps/);
    expect(() => encodePostBond(2, -1)).toThrow(/trustDiscountBps/);
  });
});

describe('encodeRenewBond', () => {
  it('encodes renewBond() = its 4-byte selector, no args', () => {
    const data = encodeRenewBond();
    expect(data).toBe(ethers.id('renewBond()').slice(0, 10));
    expect(data.length).toBe(10);
  });
});

describe('encodeTopUpBond ', () => {
  it('encodes topUpBond(uint256) byte-exact vs ethers', () => {
    const amount = 25n * 10n ** 18n;
    const data = encodeTopUpBond(amount);
    const iface = new ethers.Interface(['function topUpBond(uint256)']);
    expect(data.toLowerCase()).toBe(iface.encodeFunctionData('topUpBond', [amount]).toLowerCase());
    expect(data.slice(0, 10)).toBe(ethers.id('topUpBond(uint256)').slice(0, 10));
  });

  it('rejects zero and negative amounts (the contract also reverts on 0)', () => {
    expect(() => encodeTopUpBond(0n)).toThrow(EvmSignerError);
    expect(() => encodeTopUpBond(-1n)).toThrow(EvmSignerError);
  });
});

describe('deposit math', () => {
  it('grossUpTotalDeposit = ceil(required * 10000 / 9700)', () => {
    // 97% locked: a 970 deposit locks exactly 9.409... -> check exact + ceil.
    expect(grossUpTotalDeposit(9700n)).toBe(10000n);
    expect(grossUpTotalDeposit(0n)).toBe(0n);
    // 1 wei required -> ceil(10000/9700) = 2
    expect(grossUpTotalDeposit(1n)).toBe(2n);
    expect(() => grossUpTotalDeposit(-1n)).toThrow(EvmSignerError);
  });

  it('requiredBondWei rounds UP so the approve never under-covers', () => {
    // discount 0 -> exactly base * 1e18
    expect(requiredBondWei(750, 0)).toBe(750n * 10n ** 18n);
    // discount 1500 bps on 750 -> 637.5 PVT = 637.5e18 (exact, even)
    expect(requiredBondWei(750, 1500)).toBe(6375n * 10n ** 17n);
    // discount caps at 5000 bps (50%)
    expect(requiredBondWei(3000, 9999)).toBe(1500n * 10n ** 18n);
  });
});

describe('bondPoolAddressForChain', () => {
  it('returns the Base BondPool and refuses unconfigured chains this slice', () => {
    expect(bondPoolAddressForChain('base')).toBe(BOND_POOL_ADDRESSES.base);
    expect(() => bondPoolAddressForChain('arbitrum')).toThrow(/Base only/);
    expect(() => bondPoolAddressForChain('optimism')).toThrow(EvmSignerError);
  });
});
