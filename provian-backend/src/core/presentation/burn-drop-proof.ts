/**
 * POSITIVE proof that an accepted Base burn was dropped by a reorg.
 *
 * "An RPC error is never evidence that a burn isn't final. A real burn is never revoked because an
 * RPC was down." The finalizer (`burn-finality.ts`) may therefore revoke a burn whose finality read
 * says `tx_not_found` ONLY with this proof in hand. Every leg of it is read from BOTH operator-bound
 * Base legs and must agree exactly:
 *
 * 1. the agreed SAFE head (`readAgreedBaseSafeHead`, the L1-derived tip — the watchers'
 * depth) sits at least {@link BASE_WATCHER_CONFIRMATION_FLOOR} blocks above the height the burn
 * was accepted at, so the height is settled by L1 and cannot be reorged back by the sequencer;
 * 2. the canonical block at that height has a hash DIFFERENT from the recorded
 * `included_block_hash` the block the burn was accepted in is no longer on the chain;
 * 3. neither leg has a receipt for the tx (it was not re-included anywhere else); and
 * 4. neither leg knows the tx at all (`eth_getTransactionByHash` null — it is not waiting in either
 * node's pool to be re-included).
 *
 * Anything else is "not proven". A thrown error (a leg down, a disagreement, a malformed reply) is
 * never a proof — the caller treats it as an RPC failure and leaves the burn standing.
 */

import { ethers } from 'ethers';
import { BASE_WATCHER_CONFIRMATION_FLOOR, readAgreedBaseSafeHead } from '../onchain/economic-discovery';
import type { EconomicStateRpcLeg } from '../onchain/economic-state';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';

const HASH = /^0x[0-9a-fA-F]{64}$/;

export interface BurnDropProofInput {
  readonly txHash: string;
  /** The block the burn was accepted in (`pvt_burn_records.block_number`). */
  readonly includedBlockNumber: number;
  /** Its hash at acceptance (`pvt_burn_records.included_block_hash`). */
  readonly includedBlockHash: string;
}

export type BurnDropProof =
  | {
    readonly dropped: true;
    readonly safeHeadNumber: number;
    readonly canonicalHashAtHeight: string;
  }
  | { readonly dropped: false; readonly reason: string };

export interface BurnDropProofOptions {
  /** Test-only injection. Production uses the configured operator-bound Base legs. */
  readonly rpcLegs?: readonly [EconomicStateRpcLeg, EconomicStateRpcLeg];
}

function configuredLegs(): readonly [EconomicStateRpcLeg, EconomicStateRpcLeg] {
  const legs = getOperatorBoundRpcLegs('base');
  return [
    { operatorId: legs[0].operatorId, send: (method, params) => legs[0].provider.send(method, [...params]) },
    { operatorId: legs[1].operatorId, send: (method, params) => legs[1].provider.send(method, [...params]) },
  ];
}

function blockIdentity(raw: unknown, label: string): { number: number; hash: string } | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`burn_drop_proof_block_invalid:${label}`);
  const block = raw as Record<string, unknown>;
  if (typeof block.hash !== 'string' || !HASH.test(block.hash)
    || typeof block.number !== 'string' || !/^0x[0-9a-fA-F]+$/.test(block.number)) {
    throw new Error(`burn_drop_proof_block_invalid:${label}`);
  }
  const n = Number.parseInt(block.number, 16);
  if (!Number.isSafeInteger(n)) throw new Error(`burn_drop_proof_block_invalid:${label}`);
  return { number: n, hash: block.hash.toLowerCase() };
}

/** Read the same method from both legs at once. */
async function both(
  legs: readonly [EconomicStateRpcLeg, EconomicStateRpcLeg],
  method: string,
  params: readonly unknown[],
): Promise<[unknown, unknown]> {
  const [a, b] = await Promise.all([legs[0].send(method, params), legs[1].send(method, params)]);
  return [a, b];
}

export async function proveBurnDropped(
  input: BurnDropProofInput,
  options: BurnDropProofOptions = {},
): Promise<BurnDropProof> {
  const { txHash, includedBlockNumber } = input;
  if (!HASH.test(txHash)
    || !Number.isSafeInteger(includedBlockNumber) || includedBlockNumber < 0
    || typeof input.includedBlockHash !== 'string' || !HASH.test(input.includedBlockHash)) {
    return { dropped: false, reason: 'drop_proof_row_incomplete' };
  }
  const includedBlockHash = input.includedBlockHash.toLowerCase();
  const legs = options.rpcLegs ?? configuredLegs();
  if (legs[0].operatorId === legs[1].operatorId) throw new Error('burn_drop_proof_operators_not_independent');

  // 1. The accepted height is settled by L1: at or below the agreed safe head, 12 deep.
  const safe = await readAgreedBaseSafeHead({ rpcLegs: legs });
  if (safe === null) return { dropped: false, reason: 'drop_proof_no_safe_head' };
  const depth = safe.number - includedBlockNumber + 1;
  if (depth < BASE_WATCHER_CONFIRMATION_FLOOR) {
    return { dropped: false, reason: `drop_proof_not_safe_depth: ${depth}/${BASE_WATCHER_CONFIRMATION_FLOOR}` };
  }

  // 2. The canonical block at that height (both legs, exact agreement) is not the accepted block.
  const [left, right] = await both(legs, 'eth_getBlockByNumber', [ethers.toQuantity(includedBlockNumber), false]);
  const a = blockIdentity(left, 'height.a');
  const b = blockIdentity(right, 'height.b');
  if (a === null && b === null) return { dropped: false, reason: 'drop_proof_height_block_missing' };
  if (a === null || b === null || a.number !== b.number || a.hash !== b.hash) {
    throw new Error('burn_drop_proof_rpc_disagreement:height_block');
  }
  if (a.number !== includedBlockNumber) throw new Error('burn_drop_proof_height_mismatch');
  if (a.hash === includedBlockHash) return { dropped: false, reason: 'drop_proof_included_block_canonical' };

  // 3. Not re-included anywhere: no receipt on either leg.
  const [receiptA, receiptB] = await both(legs, 'eth_getTransactionReceipt', [txHash]);
  if (receiptA !== null || receiptB !== null) return { dropped: false, reason: 'drop_proof_tx_has_receipt' };

  // 4. Not waiting to be re-included: neither leg knows the tx.
  const [txA, txB] = await both(legs, 'eth_getTransactionByHash', [txHash]);
  if (txA !== null || txB !== null) return { dropped: false, reason: 'drop_proof_tx_still_known' };

  return { dropped: true, safeHeadNumber: safe.number, canonicalHashAtHeight: a.hash };
}
