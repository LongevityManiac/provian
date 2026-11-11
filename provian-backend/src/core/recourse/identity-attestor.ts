import { Interface, Wallet, hashMessage, verifyMessage } from 'ethers';
import type { OwnerOperationChain } from './owner-operation-queue';
import { signHashAccountMessage } from './hash-account';

export interface IdentityAttestor {
  readonly address: string;
  signMessage(message: string): Promise<string>;
  signBytes?(message: Uint8Array): Promise<string>;
}

/** Independent identity material is separate from the restoration authority
 * and from every member's recovery material. An explicitly configured hash
 * account never falls back to the old curve key. */
export function configuredIdentityAttestor(env: NodeJS.ProcessEnv = process.env): IdentityAttestor {
  const account = env.RECOURSE_IDENTITY_HASH_ACCOUNT;
  const material = env.RECOURSE_IDENTITY_HASH_SIGNING_SEED;
  if (account !== undefined || material !== undefined) {
    if (!account || !/^0x[0-9a-fA-F]{40}$/.test(account) || /^0x0{40}$/i.test(account)
      || !material || !/^0x[0-9a-fA-F]{64}$/.test(material)) throw Error('recourse_identity_hash_configuration_invalid');
    const address = account.toLowerCase();
    const sign = async (message: string | Uint8Array): Promise<string> => {
      const seed = Uint8Array.from(Buffer.from(material.slice(2), 'hex'));
      try { return await signHashAccountMessage(address, hashMessage(message), seed); }
      finally { seed.fill(0); }
    };
    return { address, signMessage: sign, signBytes: sign };
  }
  const key = env.PVT9_SETTLEMENT_APPROVER_KEY;
  if (!key) throw Error('recourse_identity_attestor_unavailable');
  const wallet = new Wallet(key);
  return { address: wallet.address.toLowerCase(), signMessage: message => wallet.signMessage(message),
    signBytes: message => wallet.signMessage(message) };
}

const CONTRACT = new Interface(['function isValidSignature(bytes32,bytes) view returns(bytes4)']);
/** Verify at the same authenticated canonical checkpoint as the registry's
 * configured identity authority. A contract's refusal can never fall back to
 * curve recovery, including after rotation of its hash commitment. */
export async function assertIdentityAttestation(chain: OwnerOperationChain, address: string,
  blockHash: string, message: string | Uint8Array, signature: string): Promise<void> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || !/^0x[0-9a-f]{64}$/.test(blockHash)
    || !/^0x(?:[0-9a-fA-F]{2})+$/.test(signature)) throw Error('recourse_identity_attestation_invalid');
  const pin = { blockHash, requireCanonical: true };
  const code = await chain.agree('eth_getCode', [address, pin]);
  if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(code)) throw Error('recourse_identity_attestation_invalid');
  if (code === '0x') {
    if (verifyMessage(message, signature).toLowerCase() !== address.toLowerCase()) throw Error('recourse_identity_attestation_invalid');
    return;
  }
  const result = await chain.agree('eth_call', [{ to: address,
    data: CONTRACT.encodeFunctionData('isValidSignature', [hashMessage(message), signature]) }, pin]);
  if (typeof result !== 'string' || result.toLowerCase() !== CONTRACT.encodeFunctionResult('isValidSignature', ['0x1626ba7e'])) {
    throw Error('recourse_identity_attestation_invalid');
  }
}
