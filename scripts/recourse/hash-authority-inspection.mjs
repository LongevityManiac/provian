import { keccak256, ZeroHash, toBeHex, zeroPadValue } from 'ethers';
import { HASH_ACCOUNT_ABI } from '../../provian-agent-sdk/dist/hash-account.js';
import { verifyDurableHashAuthority } from './hash-authority-durable.mjs';
const ensure = (value, reason) => { if (!value) throw Error('hash_authority_inspection_' + reason); };
const hash = /^0x[0-9a-f]{64}$/;
const lower = value => String(value).toLowerCase();
/** Read-only outcome of a retained operation, including direct third-party gas
 * sponsorship. An Executed event by itself is never exact-operation evidence.
 * Wrapped or different calldata is reported as consumed_other, not success;
 * publication-specific reconciliation must establish any semantic outcome.
 * This function does not release or abandon a gas-signer nonce reservation. */
export async function inspectDurableHashAuthority({ record, plan, accountRuntimeHash, port }) {
  plan = structuredClone(plan);
  record = await verifyDurableHashAuthority(record, plan, accountRuntimeHash);
  const original = record.verifiedBlock, block = await port.finalizedBlock();
  ensure(Number.isSafeInteger(block.number) && block.number >= original.number && hash.test(block.hash)
    && await port.blockHash(original.number) === original.hash, 'checkpoint_changed');
  ensure(keccak256(await port.code(plan.account, block.hash)) === accountRuntimeHash, 'runtime_changed');
  const read = async method => HASH_ACCOUNT_ABI.decodeFunctionResult(method,
    await port.call(plan.account, HASH_ACCOUNT_ABI.encodeFunctionData(method), block.hash))[0];
  const nonce = await read('nonce'), root = await read('keyCommitment'), expected = BigInt(plan.nonce);
  ensure(typeof nonce === 'bigint' && nonce >= expected && hash.test(root) && root !== ZeroHash, 'authority_state_invalid');
  let state = 'unspent', execution = null;
  if (nonce === expected) ensure(root === plan.currentRoot, 'authority_state_changed');
  else {
    const topic = HASH_ACCOUNT_ABI.getEvent('Executed').topicHash;
    const rows = await port.logs(plan.account, original.number + 1, block.number, [topic, zeroPadValue(toBeHex(expected), 32)]);
    ensure(rows.length === 1, 'execution_ambiguous');
    const log = rows[0], height = Number(BigInt(log.blockNumber));
    ensure(!log.removed && lower(log.address) === plan.account && Number.isSafeInteger(height)
      && height > original.number && height <= block.number && hash.test(log.blockHash) && hash.test(log.transactionHash), 'execution_invalid');
    ensure(keccak256(await port.code(plan.account, log.blockHash)) === accountRuntimeHash, 'runtime_changed');
    const event = HASH_ACCOUNT_ABI.parseLog(log);
    ensure(event?.name === 'Executed' && event.args.nonce === expected && typeof event.args.success === 'boolean', 'execution_invalid');
    const transaction = await port.transaction(log.transactionHash);
    ensure(transaction.hash === log.transactionHash && transaction.blockHash === log.blockHash, 'transaction_invalid');
    const exact = lower(transaction.to) === plan.account && transaction.input === record.transaction.data
      && lower(event.args.target) === plan.target;
    if (exact) ensure(keccak256(await port.code(plan.target, log.blockHash)) === plan.targetRuntimeHash, 'target_runtime_changed');
    state = exact ? event.args.success ? 'succeeded' : 'target_failed' : 'consumed_other';
    if (exact && nonce === expected + 1n) ensure(root === record.operation.nextCommitment, 'successor_root_changed');
    execution = { transactionHash: log.transactionHash, block: { number: height, hash: log.blockHash },
      target: lower(event.args.target), success: event.args.success, exactDirectCall: exact };
    ensure(await port.blockHash(height) === log.blockHash, 'execution_reorg');
  }
  ensure(await port.blockHash(original.number) === original.hash && await port.blockHash(block.number) === block.hash, 'checkpoint_changed');
  return { state, authorityNonce: nonce.toString(), authorityRoot: root, checkpoint: block, execution };
}
