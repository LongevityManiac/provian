import { ethers } from 'ethers';
import {
  RECOVERY_DOMAIN,
  RECOVERY_TYPES,
  RECOVERY_PURPOSE,
  recoverRecoverySigner,
} from './recovery-eip712';

describe('recovery EIP-712 domain pinning (WS5)', () => {
  const wallet = ethers.Wallet.createRandom();
  const message = { user: wallet.address, timestamp: 1_700_000_000, purpose: RECOVERY_PURPOSE };

  it('recovers the signer for a signature over the PINNED domain', async () => {
    const sig = await wallet.signTypedData(RECOVERY_DOMAIN, RECOVERY_TYPES, message);
    expect(recoverRecoverySigner(message, sig)).toBe(wallet.address.toLowerCase());
  });

  it('does NOT recover the wallet from a signature over a DIFFERENT domain (replay defense)', async () => {
    // Same key, same struct + values, but a foreign domain (e.g. another dApp).
    const foreignDomain = {
      name: 'Some Other dApp',
      version: '1',
      chainId: 8453,
      verifyingContract: '0x1111111111111111111111111111111111111111',
    };
    const foreignSig = await wallet.signTypedData(foreignDomain, RECOVERY_TYPES, message);
    // Verified against the PINNED domain, the foreign signature recovers a
    // DIFFERENT address — so it cannot pass the `== wallet_address` check.
    expect(recoverRecoverySigner(message, foreignSig)).not.toBe(wallet.address.toLowerCase());
  });

  it('does NOT recover the wallet when the struct types differ (e.g. extra field)', async () => {
    const foreignTypes = {
      RelayRecovery: [
        { name: 'user', type: 'address' },
        { name: 'timestamp', type: 'uint256' },
        { name: 'purpose', type: 'string' },
        { name: 'extra', type: 'string' },
      ],
    };
    const sig = await wallet.signTypedData(RECOVERY_DOMAIN, foreignTypes, { ...message, extra: 'x' });
    expect(recoverRecoverySigner(message, sig)).not.toBe(wallet.address.toLowerCase());
  });
});
