/**
 * activation arm — resolveDeployerSigner accepts EITHER a raw hex private key OR a
 * BIP-39 recovery phrase (mnemonic), and refuses anything else or any mnemonic
 * that does not derive BOOTSTRAP_ADMIN in its first ten accounts.
 *
 * This exists because the launch operator's key lives in 1Password as a MetaMask
 * SEED PHRASE, not a bare private key — passing the phrase must select the
 * BOOTSTRAP_ADMIN account, and passing anything wrong (e.g. a login password)
 * must fail CLOSED rather than sign with an unintended account.
 *
 * The RED controls at the bottom each fail under an obvious mutation of the code
 * under test (verified by hand and recorded in the run log / decisions):
 * - dropping the `Mnemonic.fromPhrase` throw → the "login password" case would
 * no longer throw NOT_A_KEY_OR_MNEMONIC;
 * - replacing the scan-and-throw with `fromMnemonic(mnemonic, path(0))` →
 * the "no BOOTSTRAP_ADMIN match" case would silently return account 0.
 */
import { describe, expect, test } from '@jest/globals';
import { HDNodeWallet, Mnemonic, Wallet, getAddress } from 'ethers';
import {
  resolveDeployerSigner,
  ethAccountPath,
  DEPLOYER_MNEMONIC_ACCOUNT_SCAN,
  NOT_A_KEY_OR_MNEMONIC,
} from '../../../../scripts/lib/deployer-signer';

// A fixed, WELL-KNOWN BIP-39 test mnemonic (the Hardhat default). Never a real key.
const TEST_MNEMONIC = 'test test test test test test test test test test test junk';

/** Ground-truth address for account `index`, derived the SAME way the code does. */
function accountAddress(phrase: string, index: number): string {
  return getAddress(HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(phrase), ethAccountPath(index)).address);
}

describe('activation arm · resolveDeployerSigner', () => {
  test('a 0x-prefixed 32-byte hex private key resolves to its own account', () => {
    const w = Wallet.createRandom();
    expect(getAddress(resolveDeployerSigner(w.privateKey, w.address).address)).toBe(getAddress(w.address));
  });

  test('a hex private key WITHOUT the 0x prefix is accepted', () => {
    const w = Wallet.createRandom();
    expect(getAddress(resolveDeployerSigner(w.privateKey.slice(2), w.address).address)).toBe(getAddress(w.address));
  });

  test('a recovery phrase resolves account 0 when that IS BOOTSTRAP_ADMIN', () => {
    const admin = accountAddress(TEST_MNEMONIC, 0);
    expect(getAddress(resolveDeployerSigner(TEST_MNEMONIC, admin).address)).toBe(admin);
  });

  test('a recovery phrase SCANS beyond account 0 to find BOOTSTRAP_ADMIN', () => {
    const admin = accountAddress(TEST_MNEMONIC, 3); // MetaMask "Account 4"
    expect(admin).not.toBe(accountAddress(TEST_MNEMONIC, 0)); // a genuinely different slot
    expect(getAddress(resolveDeployerSigner(TEST_MNEMONIC, admin).address)).toBe(admin);
  });

  // --- RED negative controls ---

  test('RED: the exact value the operator hit (a login password) is REFUSED, not signed with', () => {
    // `Provian254$` is a real 1Password login-password value that reached the
    // arm command; it must fail closed, never resolve to a signer.
    expect(() => resolveDeployerSigner('Provian254$', accountAddress(TEST_MNEMONIC, 0)))
      .toThrow(NOT_A_KEY_OR_MNEMONIC);
  });

  test('RED: a valid recovery phrase whose scanned accounts do NOT include BOOTSTRAP_ADMIN throws (never silently signs account 0)', () => {
    const stranger = getAddress(Wallet.createRandom().address); // not derivable from TEST_MNEMONIC
    for (let i = 0; i < DEPLOYER_MNEMONIC_ACCOUNT_SCAN; i += 1) {
      expect(accountAddress(TEST_MNEMONIC, i)).not.toBe(stranger); // truly outside the scan
    }
    expect(() => resolveDeployerSigner(TEST_MNEMONIC, stranger)).toThrow(/no account index/);
  });

  test('RED: an account JUST past the scan window (index 10) is not found — the bound is real', () => {
    const justPast = accountAddress(TEST_MNEMONIC, DEPLOYER_MNEMONIC_ACCOUNT_SCAN);
    expect(() => resolveDeployerSigner(TEST_MNEMONIC, justPast)).toThrow(/no account index/);
  });
});
