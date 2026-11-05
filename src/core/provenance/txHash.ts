/**
 * the transaction hash a confirmed send / swap envelope carries to the
 * relay. Kept dependency-free (types only) so every caller can import it.
 */
import type { ProvenanceEnvelope } from './types';

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export function isEvmTxHash(value: unknown): value is string {
    return typeof value === 'string' && TX_HASH_RE.test(value);
}

/**
 * The wire fields for a send / swap envelope that carries its confirmed
 * transaction — the hash and its numeric chain id (the relay queues only chain
 * 8453). Empty for every other envelope, so their submissions are unchanged.
 */
export function txHashFields(pe: Pick<ProvenanceEnvelope, 'tx_hash' | 'chain_id'>): { tx_hash?: string; chain_id?: number } {
    if (!isEvmTxHash(pe.tx_hash)) return {};
    const chainId = typeof pe.chain_id === 'number' ? pe.chain_id : Number(pe.chain_id);
    return Number.isSafeInteger(chainId) ? { tx_hash: pe.tx_hash, chain_id: chainId } : { tx_hash: pe.tx_hash };
}
