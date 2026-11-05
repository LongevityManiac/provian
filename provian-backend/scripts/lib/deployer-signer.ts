import { HDNodeWallet, Mnemonic, Wallet, getAddress } from 'ethers';

/**
 * Standard Ethereum / MetaMask BIP-44 account path. Index `i` is MetaMask
 * "Account i+1". We scan the first ten so the operator does not have to know
 * which account slot BOOTSTRAP_ADMIN occupies.
 */
export const DEPLOYER_MNEMONIC_ACCOUNT_SCAN = 10;
export const ethAccountPath = (index: number): string => `m/44'/60'/0'/0/${index}`;

export const NOT_A_KEY_OR_MNEMONIC =
  'PVT9_DEPLOYER_KEY is neither a 32-byte hex private key nor a valid BIP-39 recovery phrase';

/**
 * Resolve the deployer signer from `PVT9_DEPLOYER_KEY`, which may be EITHER a raw
 * 32-byte hex private key OR a BIP-39 recovery phrase (mnemonic).
 *
 * A MetaMask account is stored as a seed phrase, not a bare private key, so the
 * operator should not have to export the key by hand. For a mnemonic we derive
 * the standard Ethereum path `m/44'/60'/0'/0/i` and scan the first ten account
 * indices for the one whose address is `expectedAdmin` — the account the caller
 * intends to sign with — and REFUSE (throw) if none matches rather than sign with
 * an unintended account.
 *
 * Returns an UNCONNECTED signer; the caller attaches the provider. The value is
 * read straight from the process env by the caller and is never logged, echoed,
 * or written here.
 *
 * Fail-closed:
 * - a value that is neither a 32-byte hex key nor a valid mnemonic throws;
 * - a mnemonic whose first ten accounts none match `expectedAdmin` throws;
 * - a hex private key for the WRONG account returns a signer whose address the
 *   caller must still check against `expectedAdmin` (this function does not
 *   silently substitute — a hex key is trusted to be the intended account, and
 *   the caller's post-resolution `signer.address === expectedAdmin` guard is the
 *   backstop, exactly as before this mnemonic support was added).
 */
export function resolveDeployerSigner(
  rawKey: string,
  expectedAdmin: string,
): Wallet | HDNodeWallet {
  const admin = getAddress(expectedAdmin);
  const trimmed = rawKey.trim();
  const hex = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
  if (/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    return new Wallet(hex);
  }
  let mnemonic: Mnemonic;
  try {
    mnemonic = Mnemonic.fromPhrase(trimmed);
  } catch {
    throw new Error(NOT_A_KEY_OR_MNEMONIC);
  }
  for (let index = 0; index < DEPLOYER_MNEMONIC_ACCOUNT_SCAN; index += 1) {
    const candidate = HDNodeWallet.fromMnemonic(mnemonic, ethAccountPath(index));
    if (getAddress(candidate.address) === admin) {
      return candidate;
    }
  }
  throw new Error(
    `no account index 0..${DEPLOYER_MNEMONIC_ACCOUNT_SCAN - 1} of the supplied recovery phrase ` +
      `matches BOOTSTRAP_ADMIN ${admin}`,
  );
}
