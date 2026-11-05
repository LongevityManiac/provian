/**
 * the ONE predicate naming Provian's own fee / gas / revenue wallets.
 * Every assertion binds to the module's exported constants (and their real sources), never to a
 * re-declared copy, and every "is a service wallet" case sits beside a RED control that differs
 * in one variable.
 */
import { describe, it, expect } from '@jest/globals';
import { PROVIAN_TREASURY } from '../config/live-value-recipients';
import { PROVIAN_SOLANA_TREASURY, PROVIAN_SOLANA_USDC_FEE_ACCOUNT } from '../swap/swap-fees';
import { PAYOUT_FEE_RECIPIENT } from '../payout/payout-terms';
import {
  FACILITATOR_BASE_GAS_ADDRESS_DEFAULT,
  FACILITATOR_SOLANA_GAS_ADDRESS_DEFAULT,
} from './x402-facilitator-settlement';
import {
  PAYOUT_BASE_GAS_ADDRESS,
  PROVIAN_SERVICE_FEE_EXEMPT_ACTION_TYPES,
  PROVIAN_SERVICE_FEE_REASON_CODE,
  PROVIAN_SERVICE_WALLETS_EVM,
  PROVIAN_SERVICE_WALLETS_SOLANA,
  isProvianServiceWallet,
  provianServiceFeeApplies,
  provianServiceWallets,
} from './provian-service-wallets';
import { MINT_REASON_CODES } from './policy/monetary-accounting';

const NO_ENV = Object.freeze({}) as Readonly<Record<string, string | undefined>>;
const STRANGER_EVM = '0x5000000000000000000000000000000000000005';
const STRANGER_SOLANA = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';

describe('the service-wallet set', () => {
  it('the population is real: three EVM and three Solana wallets are pinned', () => {
    expect(PROVIAN_SERVICE_WALLETS_EVM.size).toBe(3);
    expect(PROVIAN_SERVICE_WALLETS_SOLANA.size).toBe(3);
  });

  it('pins the treasury (the payout fee recipient and EVM swap-fee recipient), the facilitator Base gas EOA and the payout gas EOA', () => {
    const evm = [...PROVIAN_SERVICE_WALLETS_EVM.keys()];
    expect(evm).toEqual(expect.arrayContaining([
      PROVIAN_TREASURY, PAYOUT_FEE_RECIPIENT, FACILITATOR_BASE_GAS_ADDRESS_DEFAULT, PAYOUT_BASE_GAS_ADDRESS,
    ]));
    for (const address of evm) expect(address).toBe(address.toLowerCase());
  });

  it('the payout gas EOA is the full address recorded for (0x35F96e1A…4351)', () => {
    expect(PAYOUT_BASE_GAS_ADDRESS).toMatch(/^0x35f96e1a[0-9a-f]{28}4351$/);
  });

  it('pins the facilitator Solana fee/gas wallet, the Solana treasury and its USDC fee account', () => {
    expect([...PROVIAN_SERVICE_WALLETS_SOLANA.keys()]).toEqual(expect.arrayContaining([
      FACILITATOR_SOLANA_GAS_ADDRESS_DEFAULT, PROVIAN_SOLANA_TREASURY, PROVIAN_SOLANA_USDC_FEE_ACCOUNT,
    ]));
  });

  it('env adds a wallet (a moved fee recipient is followed) and never removes a pinned one', () => {
    const moved = '0x1234567890abcdef1234567890abcdef12345678';
    const wallets = provianServiceWallets({ FACILITATOR_BASE_GAS_ADDRESS: moved, PAYOUT_BASE_GAS_ADDRESS: STRANGER_EVM });
    expect(wallets.evm.has(moved)).toBe(true);
    expect(wallets.evm.has(STRANGER_EVM)).toBe(true);
    for (const pinned of PROVIAN_SERVICE_WALLETS_EVM.keys()) expect(wallets.evm.has(pinned)).toBe(true);
    // RED control: without the env the same address is not a service wallet.
    expect(provianServiceWallets(NO_ENV).evm.has(moved)).toBe(false);
  });

  it('a malformed env value adds nothing and drops nothing', () => {
    const wallets = provianServiceWallets({ FACILITATOR_BASE_GAS_ADDRESS: 'not-an-address', PAYOUT_BASE_GAS_ADDRESS: '0x12' });
    expect(wallets.evm.size).toBe(PROVIAN_SERVICE_WALLETS_EVM.size);
  });
});

describe('isProvianServiceWallet', () => {
  it('EVM: matches case-insensitively, prefix included', () => {
    expect(isProvianServiceWallet(PROVIAN_TREASURY, NO_ENV)).toBe(true);
    expect(isProvianServiceWallet(PROVIAN_TREASURY.toUpperCase().replace('0X', '0x'), NO_ENV)).toBe(true);
    expect(isProvianServiceWallet(`0X${PROVIAN_TREASURY.slice(2).toUpperCase()}`, NO_ENV)).toBe(true);
    expect(isProvianServiceWallet('0xA37fC594E98e951571C771C9e77CDC73f67d3efB', NO_ENV)).toBe(true);
    expect(isProvianServiceWallet('0x35F96e1ABa3E500425135379b775e02e84Ad4351', NO_ENV)).toBe(true);
  });

  it('RED control: an unknown EVM address is not a service wallet', () => {
    expect(isProvianServiceWallet(STRANGER_EVM, NO_ENV)).toBe(false);
    // One hex digit off the treasury.
    expect(isProvianServiceWallet(`${PROVIAN_TREASURY.slice(0, -1)}b`, NO_ENV)).toBe(false);
  });

  it('Solana: matches the exact base58 string', () => {
    expect(isProvianServiceWallet(FACILITATOR_SOLANA_GAS_ADDRESS_DEFAULT, NO_ENV)).toBe(true);
    expect(isProvianServiceWallet(PROVIAN_SOLANA_TREASURY, NO_ENV)).toBe(true);
    expect(isProvianServiceWallet(PROVIAN_SOLANA_USDC_FEE_ACCOUNT, NO_ENV)).toBe(true);
  });

  it('RED control: Solana is case-SIGNIFICANT — a case-folded treasury is a different key', () => {
    expect(isProvianServiceWallet(PROVIAN_SOLANA_TREASURY.toLowerCase(), NO_ENV)).toBe(false);
    expect(isProvianServiceWallet(PROVIAN_SOLANA_TREASURY.toUpperCase(), NO_ENV)).toBe(false);
    expect(isProvianServiceWallet(STRANGER_SOLANA, NO_ENV)).toBe(false);
  });

  it('unknown / malformed input is never a service wallet', () => {
    for (const value of [null, undefined, '', '   ', 42, {}, 'wallet_abc', '0x', `evm:${PROVIAN_TREASURY}`]) {
      expect(isProvianServiceWallet(value, NO_ENV)).toBe(false);
    }
  });
});

describe('provianServiceFeeApplies — the payer of a fee, never the payee', () => {
  it.each(['send', 'swap', 'x402_payment', 'stake', 'escrow_completed', 'some:future_type'])(
    '%s to a Provian service wallet applies',
    (actionType) => {
      expect(provianServiceFeeApplies(actionType, PROVIAN_TREASURY, NO_ENV)).toBe(true);
      // RED control: the same act to a stranger does not.
      expect(provianServiceFeeApplies(actionType, STRANGER_EVM, NO_ENV)).toBe(false);
    },
  );

  it('a receive FROM a Provian wallet is not a fee (the counterparty paid the actor)', () => {
    expect([...PROVIAN_SERVICE_FEE_EXEMPT_ACTION_TYPES]).toEqual(['receive']);
    expect(provianServiceFeeApplies('receive', PROVIAN_TREASURY, NO_ENV)).toBe(false);
  });

  it('the reason is a registered record_only reason code', () => {
    expect(PROVIAN_SERVICE_FEE_REASON_CODE).toBe('provian_service_fee');
    expect((MINT_REASON_CODES as readonly string[]).includes(PROVIAN_SERVICE_FEE_REASON_CODE)).toBe(true);
  });
});
