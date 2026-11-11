import { Interface, keccak256, sha256, toUtf8Bytes } from 'ethers';
import { preparePointerPublication } from './pointer-publication.mjs';
import { inspectPublicationOutcome, publicationGoal } from './publication-outcome.mjs';
import { verifyDurableHashAuthority } from './hash-authority-durable.mjs';
import { hashAuthorityCancellationPlan } from './hash-authority-cancellation.mjs';

const ensure = (value, reason) => { if (!value) throw Error('publication_recovery_' + reason); };
const digest = value => sha256(toUtf8Bytes(JSON.stringify(value)));
const abi = new Interface(['function nonce() view returns(uint256)', 'function keyCommitment() view returns(bytes32)',
  'function registerLegacyRetirements(address[],bytes32[])', 'function publish(uint256,address[10],bytes32[10])']);
export const publicationOperationSlot = (account, nonce, cancel = false) => digest({ chainId: '8453', account,
  nonce: String(nonce), ...(cancel ? { purpose: 'cancel' } : {}) });

/** Historical authority material can authenticate gas cleanup even if the
 * current source/goal/root no longer permits publication. This reader does not
 * authorize exposing or broadcasting an executable authority call. */
export async function readPublicationRecord(inputs, store, nonce) {
  const { port, ...facts } = inputs; inputs = { ...structuredClone(facts), port };
  const account = inputs.successor.pointerAuthority, runtimeHash = keccak256(inputs.artifacts.ProvianHashAccount.deployedBytecode.object);
  ensure(typeof nonce === 'string' && /^(0|[1-9][0-9]*)$/.test(nonce), 'nonce_invalid');
  const saved = structuredClone(await store.read(publicationOperationSlot(account, nonce)));
  if (!saved) return null;
  const finalized = await port.finalizedBlock(), checkpoint = saved.verifiedBlock;
  ensure(saved.operation?.account === account && saved.operation?.nonce === nonce && saved.operation?.target === inputs.pin.address
    && Number.isSafeInteger(checkpoint?.number) && checkpoint.number > 0 && checkpoint.number <= finalized.number
    && /^0x[0-9a-f]{64}$/.test(checkpoint.hash), 'record_invalid');
  if (nonce === '0') ensure(saved.operation.signingRoot === inputs.pointerPlan.initialRoot, 'operation_lineage_changed');
  ensure(await port.blockHash(checkpoint.number) === checkpoint.hash, 'checkpoint_changed');
  const call = abi.parseTransaction({ data: saved.operation.data });
  ensure(call && ['registerLegacyRetirements', 'publish'].includes(call.name), 'operation_not_publication');
  const plan = await preparePointerPublication({ ...inputs, stage: call.name === 'publish' ? 'publish' : 'retire',
    callGas: saved.operation.callGas, port: { ...port, finalizedBlock: async () => checkpoint } });
  const record = await verifyDurableHashAuthority(saved, plan.hashAuthorityPlan, runtimeHash);
  const cancel = await store.read(publicationOperationSlot(account, nonce, true));
  let cancellation = null;
  if (cancel) {
    cancellation = await verifyDurableHashAuthority(cancel, hashAuthorityCancellationPlan(plan.hashAuthorityPlan, runtimeHash), runtimeHash);
    ensure(cancellation.nextItemId === record.nextItemId && cancellation.operation.nextCommitment === record.operation.nextCommitment,
      'cancellation_successor_changed');
    ensure(cancellation.verifiedBlock.number <= finalized.number
      && await port.blockHash(cancellation.verifiedBlock.number) === cancellation.verifiedBlock.hash, 'checkpoint_changed');
  }
  ensure(await port.blockHash(checkpoint.number) === checkpoint.hash
    && await port.blockHash(finalized.number) === finalized.hash, 'checkpoint_changed');
  if (cancellation) ensure(await port.blockHash(cancellation.verifiedBlock.number) === cancellation.verifiedBlock.hash, 'checkpoint_changed');
  return { plan, record, cancellation, goal: publicationGoal(plan, inputs) };
}

export async function readPublicationHistory(inputs, store) {
  const records = [];
  for (let nonce = 0; ; nonce++) {
    ensure(Number.isSafeInteger(nonce), 'nonce_invalid');
    const row = await readPublicationRecord(inputs, store, String(nonce));
    if (!row) break;
    ensure(!records.length || JSON.stringify(row.goal) === JSON.stringify(records[0].goal), 'historical_goal_changed');
    records.push(row);
  }
  for (const row of records) for (const record of [row.record, ...(row.cancellation ? [row.cancellation] : [])])
    ensure(await inputs.port.blockHash(record.verifiedBlock.number) === record.verifiedBlock.hash, 'checkpoint_changed');
  return records.length ? { records, goal: records[0].goal } : null;
}

/** Recover the publication lifecycle from immutable public operation records.
 * Every consumed authority nonce must have retained, independently reconstructed
 * material, and the current root must be the saved successor of that lineage.
 * This handles a crash after simulation exposed a proof but before any sponsor
 * transaction was reserved. No private key is needed to recover this state. */
export async function readPublicationProgress(inputs, store) {
  const { port, ...facts } = inputs; inputs = { ...structuredClone(facts), port };
  const account = inputs.successor.pointerAuthority;
  const runtimeHash = keccak256(inputs.artifacts.ProvianHashAccount.deployedBytecode.object);
  const block = await port.finalizedBlock();
  ensure(Number.isSafeInteger(block.number) && block.number > 0 && /^0x[0-9a-f]{64}$/.test(block.hash), 'checkpoint_invalid');
  ensure(keccak256(await port.code(account, block.hash)) === runtimeHash, 'authority_runtime_changed');
  const read = async method => abi.decodeFunctionResult(method,
    await port.call(account, abi.encodeFunctionData(method), block.hash))[0];
  const nonce = await read('nonce'), root = await read('keyCommitment');
  ensure(typeof nonce === 'bigint' && nonce >= 0n && nonce <= BigInt(Number.MAX_SAFE_INTEGER), 'nonce_invalid');
  const records = [], checkpoints = new Map([[block.number, block.hash]]);
  let expectedRoot = inputs.pointerPlan.initialRoot;
  for (let index = 0n; index <= nonce; index++) {
    const saved = structuredClone(await store.read(publicationOperationSlot(account, index)));
    if (!saved) { ensure(index === nonce, 'unknown_consumed_operation'); break; }
    ensure(saved.operation?.account === account && saved.operation?.nonce === index.toString()
      && saved.operation?.signingRoot === expectedRoot && saved.operation?.target === inputs.pin.address
      && Number.isSafeInteger(saved.verifiedBlock?.number) && saved.verifiedBlock.number > 0
      && saved.verifiedBlock.number <= block.number && /^0x[0-9a-f]{64}$/.test(saved.verifiedBlock.hash), 'operation_lineage_changed');
    const checkpoint = saved.verifiedBlock;
    ensure(!checkpoints.has(checkpoint.number) || checkpoints.get(checkpoint.number) === checkpoint.hash, 'checkpoint_changed');
    checkpoints.set(checkpoint.number, checkpoint.hash);
    ensure(await port.blockHash(checkpoint.number) === checkpoint.hash, 'checkpoint_changed');
    const call = abi.parseTransaction({ data: saved.operation.data });
    ensure(call && ['registerLegacyRetirements', 'publish'].includes(call.name), 'operation_not_publication');
    const stage = call.name === 'publish' ? 'publish' : 'retire';
    const plan = await preparePointerPublication({ ...inputs, stage, callGas: saved.operation.callGas,
      port: { ...port, finalizedBlock: async () => checkpoint } });
    const record = await verifyDurableHashAuthority(saved, plan.hashAuthorityPlan, runtimeHash);
    const cancel = await store.read(publicationOperationSlot(account, index, true));
    let cancellation = null;
    if (cancel) {
      cancellation = await verifyDurableHashAuthority(cancel, hashAuthorityCancellationPlan(plan.hashAuthorityPlan, runtimeHash), runtimeHash);
      ensure(cancellation.nextItemId === record.nextItemId && cancellation.operation.nextCommitment === record.operation.nextCommitment,
        'cancellation_successor_changed');
      ensure(cancellation.verifiedBlock.number <= block.number
        && (!checkpoints.has(cancellation.verifiedBlock.number) || checkpoints.get(cancellation.verifiedBlock.number) === cancellation.verifiedBlock.hash),
      'checkpoint_changed');
      checkpoints.set(cancellation.verifiedBlock.number, cancellation.verifiedBlock.hash);
    }
    records.push({ plan, record, cancellation });
    if (index < nonce) expectedRoot = record.operation.nextCommitment;
  }
  ensure(root === expectedRoot, 'unknown_current_root');
  let baseline = records[0]?.plan;
  if (!baseline) baseline = await preparePointerPublication({ ...inputs, stage: 'retire', callGas: inputs.callGas });
  const outcome = await inspectPublicationOutcome(baseline, inputs);
  ensure(outcome.status !== 'superseded' && outcome.checkpoint.number >= block.number, 'goal_superseded');
  for (const [method, expected] of [['nonce', nonce], ['keyCommitment', root]]) ensure(abi.decodeFunctionResult(method,
    await port.call(account, abi.encodeFunctionData(method), outcome.checkpoint.hash))[0] === expected, 'authority_advanced');
  ensure(!checkpoints.has(outcome.checkpoint.number) || checkpoints.get(outcome.checkpoint.number) === outcome.checkpoint.hash, 'checkpoint_changed');
  checkpoints.set(outcome.checkpoint.number, outcome.checkpoint.hash);
  for (const [number, hash] of checkpoints) ensure(await port.blockHash(number) === hash, 'checkpoint_changed');
  return { records, nonce: nonce.toString(), root, runtimeHash, baseline, outcome, checkpoint: block,
    current: records.find(row => row.record.operation.nonce === nonce.toString()) ?? null };
}
