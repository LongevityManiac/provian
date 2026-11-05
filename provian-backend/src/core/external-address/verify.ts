/**
 * External-address proof-of-control - signature verification (Unit 2).
 *
 * Verifies that a signature over the proof message was produced by the
 * controller of `address`, handling BOTH wallet kinds:
 *
 *   - EOA (MetaMask, most agent keys): EIP-191 personal_sign. ethers
 *     `verifyMessage` recovers the signer; we compare to the claimed address.
 *   - Smart-contract wallet (Coinbase Smart Wallet, ERC-4337 accounts with no
 *     recoverable key): EIP-1271. We compute the EIP-191 digest with ethers
 *     `hashMessage` (no hand-rolled hashing) and call the wallet contract's
 *     `isValidSignature(bytes32,bytes)`, accepting iff it returns the magic
 *     value 0x1626ba7e.
 *
 * We try EOA recovery first (pure, no RPC) and fall back to EIP-1271 only when
 * the address has on-chain code. The contract call goes through ethers
 * primitives, never raw eth_call ABI encoding.
 *
 * KNOWN LIMITATION: ERC-6492 (signatures from counterfactual / not-yet-deployed
 * smart wallets) is NOT handled - that needs viem, which the backend does not
 * carry. This is moot for the go-forward-activity reward model: an address only
 * earns once it has witnessed on-chain activity, by which point it is deployed
 * and EIP-1271 works. Revisit if counterfactual proof is ever required.
 */

import { ethers } from 'ethers';
import type { ChainName } from '../onchain/rpc-provider';
import {
  callExternalProofEip1271,
  readExternalProofCode,
  type ExternalProofFenceEvidence,
} from './proof-head';
const EIP1271_MAGIC_VALUE = '0x1626ba7e';

export type ProofMethod = 'eip191_eoa' | 'eip1271_contract';

export interface ExternalSignatureVerifyResult {
  ok: boolean;
  method?: ProofMethod;
  reason?: string;
}

/**
 * On-chain reads the verifier needs. Injectable so tests can exercise the
 * EIP-1271 path without a live RPC. Defaults bind to the chain's RPC provider.
 */
export interface ExternalVerifyDeps {
  /** eth_getCode - '0x' for an EOA, non-empty for a contract. */
  getCode: (address: string, proof: ExternalProofFenceEvidence) => Promise<string>;
  /** Call the wallet contract's EIP-1271 isValidSignature; returns the bytes4. */
  isValidSignature: (
    address: string,
    digest: string,
    signature: string,
    proof: ExternalProofFenceEvidence,
  ) => Promise<string>;
}

function defaultVerifyDeps(_chain: ChainName): ExternalVerifyDeps {
  return {
    getCode: (address, proof) => readExternalProofCode(address, proof),
    isValidSignature: (address, digest, signature, proof) =>
      callExternalProofEip1271(address, digest, signature, proof),
  };
}

/**
 * Verify a proof signature for `address` over `message`. EOA first, EIP-1271
 * fallback for contract wallets.
 */
export async function verifyExternalAddressSignature(
  params: {
    address: string;
    message: string;
    signature: string;
    chain: ChainName;
    proof: ExternalProofFenceEvidence;
  },
  deps?: ExternalVerifyDeps,
): Promise<ExternalSignatureVerifyResult> {
  const { address, message, signature, chain } = params;

  if (!ethers.isAddress(address)) {
    return { ok: false, reason: 'invalid_address' };
  }
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    return { ok: false, reason: 'invalid_signature_format' };
  }

  // Classify the account at the exact finalized proof block. Latest-state code
  // is not proof of what controlled the address at the fenced state.
  const verifyDeps = deps ?? defaultVerifyDeps(chain);

  let code: string;
  try {
    code = await verifyDeps.getCode(address, params.proof);
  } catch {
    return { ok: false, reason: 'getcode_failed' };
  }
  if (code === '0x' || code === '0x0' || code === '') {
    try {
      const recovered = ethers.verifyMessage(message, signature);
      return recovered.toLowerCase() === address.toLowerCase()
        ? { ok: true, method: 'eip191_eoa' }
        : { ok: false, reason: 'eoa_recovery_mismatch' };
    } catch {
      return { ok: false, reason: 'eoa_recovery_mismatch' };
    }
  }

  // Contract at the proof block: only EIP-1271 can authorize it, even if an
  // EOA-style recovery happens to produce the same 20 bytes.
  let result: string;
  try {
    const digest = ethers.hashMessage(message); // EIP-191 digest, correctly prefixed.
    result = await verifyDeps.isValidSignature(address, digest, signature, params.proof);
  } catch {
    return { ok: false, reason: 'eip1271_call_failed' };
  }
  // isValidSignature returns a bytes4; ethers decodes it to an exact 4-byte hex
  // string. Require exact equality (not a prefix) so a longer look-alike return
  // value can never pass.
  if (typeof result === 'string' && result.toLowerCase() === EIP1271_MAGIC_VALUE) {
    return { ok: true, method: 'eip1271_contract' };
  }
  return { ok: false, reason: 'eip1271_invalid' };
}
