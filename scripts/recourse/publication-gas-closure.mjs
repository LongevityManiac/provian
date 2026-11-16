import { matchesPlannedCall } from '../../provian-backend/src/core/onchain/builder-code.ts';
import { Transaction, toQuantity } from 'ethers';
const ensure = (value, reason) => { if (!value) throw Error('publication_gas_closure_' + reason); };
const address = /^0x[0-9a-f]{40}$/;
const hash = /^0x[0-9a-f]{64}$/;
const quantity = value => {
  ensure(typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value), 'quantity_invalid');
  return BigInt(value);
};
/** Verify the entire retained set, including same-nonce gas cancellation bytes.
 * This grants no signing/broadcast authority and certifies no target outcome.
 * The authority transaction must come from the independently verified durable
 * operation; the journal supplies the fixed sponsor and reserved gas nonce. */
export function validatePublicationGasVariants({ from, nonce, authorityTransaction, variants }) {
  ensure(address.test(from) && Number.isSafeInteger(nonce) && nonce >= 0 && address.test(authorityTransaction?.to)
    && /^0x(?:[0-9a-f]{2})+$/.test(authorityTransaction?.data)
    && Array.isArray(variants) && variants.length > 0, 'input_invalid');
  const hashes = [], seen = new Set();
  for (const variant of variants) {
    ensure(variant && ['call', 'cancel'].includes(variant.kind) && typeof variant.raw === 'string', 'variant_invalid');
    const tx = Transaction.from(variant.raw);
    ensure(tx.signature && tx.from?.toLowerCase() === from && tx.chainId === 8453n && tx.type === 2
      && tx.nonce === nonce && tx.value === 0n && tx.gasLimit > 0n && tx.maxFeePerGas !== null
      && tx.maxPriorityFeePerGas !== null && tx.maxFeePerGas >= tx.maxPriorityFeePerGas, 'signed_binding');
    ensure(variant.kind === 'call' ? tx.to?.toLowerCase() === authorityTransaction.to && matchesPlannedCall(tx.data, authorityTransaction.data)
      : tx.to?.toLowerCase() === from && matchesPlannedCall(tx.data, '0x'), 'call_changed');
    ensure(tx.hash === variant.hash && !seen.has(tx.hash), 'hash_changed');
    seen.add(tx.hash); hashes.push(tx.hash);
  }
  return hashes;
}
/** Finalized account-nonce consumption closes a gas nonce even when a wallet
 * outside this runner supplied its winning transaction. Every retained signed
 * variant then becomes unexecutable. A latest/pending nonce, timeout, or an
 * authority outcome alone cannot establish this fact. The caller still owns
 * transactional lease/CAS closure and must retain all original signed bytes. */
export async function inspectPublicationGasClosure(input, port, priorCheckpoint) {
  input = structuredClone(input); priorCheckpoint = structuredClone(priorCheckpoint);
  const hashes = validatePublicationGasVariants(input), readers = port.rpcs;
  ensure(Array.isArray(readers) && readers.length === 2 && readers.every(reader => typeof reader.operatorId === 'string'
    && reader.operatorId.length > 0 && typeof reader.request === 'function')
    && readers[0].operatorId !== readers[1].operatorId, 'independent_operators');
  const chains = await Promise.all(readers.map(reader => reader.request('eth_chainId', [])));
  ensure(chains.every(chain => quantity(chain) === 8453n), 'wrong_chain');
  const block = await port.finalizedBlock();
  ensure(Number.isSafeInteger(block.number) && block.number > 0 && hash.test(block.hash), 'checkpoint_invalid');
  if (priorCheckpoint) ensure(Number.isSafeInteger(priorCheckpoint.number) && priorCheckpoint.number > 0
    && priorCheckpoint.number <= block.number && hash.test(priorCheckpoint.hash)
    && await port.blockHash(priorCheckpoint.number) === priorCheckpoint.hash, 'prior_checkpoint_changed');
  const counts = await Promise.all(readers.map(reader => reader.request('eth_getTransactionCount', [input.from, toQuantity(block.number)])));
  const nonce = quantity(counts[0]); ensure(nonce === quantity(counts[1]), 'nonce_disagreement');
  ensure(await port.blockHash(block.number) === block.hash, 'checkpoint_changed');
  if (priorCheckpoint) ensure(await port.blockHash(priorCheckpoint.number) === priorCheckpoint.hash, 'prior_checkpoint_changed');
  return { status: nonce > BigInt(input.nonce) ? 'consumed' : 'open', from: input.from, nonce: input.nonce,
    finalizedNonce: nonce.toString(), checkpoint: block, retainedHashes: hashes };
}
