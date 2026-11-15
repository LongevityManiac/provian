/**
 * the registry-bound `batchMinted(bytes32)` reader.
 *
 * THE DEFECT THIS REPLACES. 's reader bound the CURRENT PVTv8 token
 * unconditionally, so it asked one contract about batches that were minted on
 * three different earlier ones and read every `false` as a negative. PVTv8's
 * live `totalSupply()` is ZERO — nothing was ever minted on it — so that reader
 * could only ever have returned `false`, for every document, forever.
 *
 * THE RULE THIS ENFORCES. A probe that cannot reach the contract a document was
 * minted against is SILENCE, and silence must never be expressible as a
 * negative. Every failure path here THROWS:
 * - the document resolves to no contract → LegacyMintContractUnresolved
 * - the RPC errors, or HTTP-fails → Error
 * - the return word is not a decodable bool → Error
 * There is no code path that returns `false` for any reason other than the
 * correct contract answering `false` about that exact digest.
 *
 * Read-only by construction: `eth_call` at `latest` only. No signer, no key, no
 * transaction surface — the transport it accepts cannot express one.
 */

import { id as ethersId } from 'ethers';
import {
  resolveMintContractForDocument,
  type LegacyMintChainId,
} from './legacy-mint-contract-registry';

/**
 * `batchMinted(bytes32)` selector, DERIVED. A mistyped literal would read a
 * different function, or none, and quietly mis-answer a cutover gate.
 */
export const BATCH_MINTED_SELECTOR = ethersId('batchMinted(bytes32)').slice(0, 10);

/**
 * The minimal read-only transport. Returns the raw `eth_call` result word.
 * Implementations MUST throw on transport or RPC error rather than returning a
 * sentinel — a swallowed error is the same defect in a different place.
 */
export interface EthCallTransport {
  ethCall(chainId: LegacyMintChainId, to: string, data: string): Promise<string>;
}

const BYTES32_BODY = /^[0-9a-fA-F]{64}$/;
/**
 * A CANONICAL ABI bool word: 31 zero bytes then `00` or `01`. Nothing else.
 *
 * Deliberately stricter than "any 32-byte word". A fallback function, a proxy,
 * or a selector collision returns a well-shaped word that is not a bool — and
 * `BigInt(word) === 1n` would silently map every such value to `false`, which
 * is the "could not reach the function" case wearing the mask of a negative
 * answer. (ethers' own bool decoder returns TRUE for any nonzero word, so the
 * loose form was also the INVERSE of a real ABI decode.) Only these two words
 * mean `batchMinted` actually answered.
 */
const CANONICAL_BOOL_WORD = /^0x0{63}[01]$/;

/** Normalize a document id to the 64-hex calldata argument, or throw. */
export function toBytes32Arg(documentId: string): string {
  const raw = documentId.startsWith('0x') ? documentId.slice(2) : documentId;
  if (!BYTES32_BODY.test(raw)) {
    throw new Error(`batch_id is not a 32-byte hex value: ${documentId}`);
  }
  return raw.toLowerCase();
}

export interface RegistryBoundBatchMintedReader {
  /**
   * `batchMinted(documentId)` asked of the contract THIS document minted
   * against. `recordedContractAddress` is the document's own
   * `pvt_contract_address`, used only when no mint-receipt binding exists.
   */
  readBatchMinted(documentId: string, recordedContractAddress?: string | null): Promise<boolean>;
}

/**
 * Build the reader. `transport` is injected so the resolution rules and the
 * throw paths are testable without a network — which is the point: the property
 * that matters ("never false when it could not reach the right contract") is a
 * property of THIS function, not of any particular RPC endpoint.
 */
export function makeRegistryBoundBatchMintedReader(
  transport: EthCallTransport,
): RegistryBoundBatchMintedReader {
  return {
    async readBatchMinted(documentId, recordedContractAddress) {
      // Resolution first, and it THROWS rather than falling back. An
      // unresolvable contract is not a negative answer about the document; it
      // is the absence of any answer at all.
      const target = resolveMintContractForDocument(documentId, recordedContractAddress);
      const data = BATCH_MINTED_SELECTOR + toBytes32Arg(documentId);
      const word = await transport.ethCall(target.chainId, target.address, data);
      if (typeof word !== 'string' || !CANONICAL_BOOL_WORD.test(word)) {
        // Everything that is not a canonical bool lands here: '0x' (no code, or
        // no such function), a short word, and — the case that matters — a
        // well-shaped word like 0x…02 or 0xff…ff, which is what a fallback
        // function or a proxy returns when `batchMinted` was never reached. NONE
        // of these is `false`: a contract that could not answer has not answered.
        throw new Error(
          `batchMinted returned a non-canonical bool word from ${target.address} `
          + `(chain ${target.chainId}, resolved via ${target.source}): ${String(word)}`,
        );
      }
      return word.endsWith('1');
    },
  };
}

/**
 * The production transport: raw JSON-RPC `eth_call`, one endpoint per chain.
 * A chain with no configured endpoint THROWS — the same rule as above, applied
 * to configuration.
 */
export function makeJsonRpcTransport(
  endpoints: Partial<Record<LegacyMintChainId, string>>,
): EthCallTransport {
  return {
    async ethCall(chainId, to, data) {
      const url = endpoints[chainId];
      if (url === undefined || url === '') {
        throw new Error(
          `no RPC endpoint configured for chain ${chainId}; cannot read ${to} — `
          + 'refusing to answer rather than answering false',
        );
      }
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_call',
          params: [{ to, data }, 'latest'],
        }),
      });
      if (!res.ok) throw new Error(`eth_call HTTP ${res.status} (chain ${chainId})`);
      const body = (await res.json()) as { result?: string; error?: { message?: string } };
      if (body.error) throw new Error(`eth_call error: ${body.error.message ?? 'unknown'}`);
      return String(body.result);
    },
  };
}
