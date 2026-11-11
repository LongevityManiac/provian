import { isDeepStrictEqual } from 'node:util';
import { sha256, toUtf8Bytes } from 'ethers';
import { HASH_ACCOUNT_ABI, hashAccountCall, hashAccountIntentDigest } from '../../provian-agent-sdk/dist/hash-account.js';
import { verifyDurableHashAuthority } from './hash-authority-durable.mjs';
import { verifyHashAuthorityPlan } from './hash-authority-plan.mjs';
import { prepareVaultHashCancellation } from './hash-authority-vault.mjs';
const ensure = (value, reason) => { if (!value) throw Error('hash_authority_cancellation_' + reason); };
const digest = value => sha256(toUtf8Bytes(JSON.stringify(value)));

/** A single fixed alternative to an exposed operation: zero-value empty self
 * call at the SAME nonce, installing the SAME durably retained successor root.
 * The account receive function succeeds with this fixed call-gas allowance.
 * It changes no pointer or target state. The original is retained forever;
 * either winning transaction leaves the operator with the saved next seed. */
export function hashAuthorityCancellationPlan(plan, accountRuntimeHash) {
  return { ...structuredClone(plan), target: plan.account, targetRuntimeHash: accountRuntimeHash,
    value: '0', callGas: '100000', data: '0x' };
}

export async function prepareDurableHashCancellation({ original, plan, accountRuntimeHash, port, vault, store }) {
  plan = structuredClone(plan);
  original = await verifyDurableHashAuthority(original, plan, accountRuntimeHash);
  const originalSlot = digest({ chainId: '8453', account: plan.account, nonce: plan.nonce });
  const cancelSlot = digest({ chainId: '8453', account: plan.account, nonce: plan.nonce, purpose: 'cancel' });
  const cancellationPlan = hashAuthorityCancellationPlan(plan, accountRuntimeHash);
  const assertOriginal = async () => {
    ensure(isDeepStrictEqual(await store.read(originalSlot), original), 'original_not_durable');
    ensure(await port.blockHash(original.verifiedBlock.number) === original.verifiedBlock.hash, 'checkpoint_changed');
  };
  const verifySaved = async record => {
    const checked = await verifyDurableHashAuthority(record, cancellationPlan, accountRuntimeHash);
    ensure(checked.operation.nextCommitment === original.operation.nextCommitment && checked.nextItemId === original.nextItemId, 'successor_changed');
    await assertOriginal();
    ensure(await port.blockHash(checked.verifiedBlock.number) === checked.verifiedBlock.hash, 'checkpoint_changed');
    return checked;
  };
  await assertOriginal();
  const existing = await store.read(cancelSlot);
  if (existing) return verifySaved(existing);
  const verified = await verifyHashAuthorityPlan(cancellationPlan, port, accountRuntimeHash);
  const { operation, nextItemId } = await prepareVaultHashCancellation(vault, {
    currentRoot: plan.currentRoot, nextCommitment: original.operation.nextCommitment,
    nextItemId: original.nextItemId, originalIntentDigest: original.intentDigest, intent: verified.intent,
  }, async intent => {
    // No extra secret record is created. The immutable original uniquely fixes
    // this self-call, nonce, fixed gas and saved successor, including on restart.
    ensure(isDeepStrictEqual(intent, { ...verified.intent, nextCommitment: original.operation.nextCommitment }), 'intent_changed');
    await assertOriginal();
  });
  const intentDigest = hashAccountIntentDigest(operation);
  const onChain = await port.call(plan.account, HASH_ACCOUNT_ABI.encodeFunctionData('intentDigest',
    [cancellationPlan.target, '0', cancellationPlan.callGas, '0x', operation.nextCommitment]), verified.block.hash);
  ensure(HASH_ACCOUNT_ABI.decodeFunctionResult('intentDigest', onChain)[0] === intentDigest, 'digest_mismatch');
  const record = { schema: 'provian.durable-hash-authority.v1', planDigest: digest(cancellationPlan), accountRuntimeHash,
    operation, nextItemId, intentDigest, verifiedBlock: verified.block,
    transaction: { chainId: '8453', to: plan.account, value: '0', data: hashAccountCall(operation) } };
  await verifySaved(record);
  try { await store.create(cancelSlot, structuredClone(record)); }
  catch (error) {
    const saved = await store.read(cancelSlot); if (!saved) throw error;
    return verifySaved(saved);
  }
  const saved = await store.read(cancelSlot);
  ensure(isDeepStrictEqual(saved, record), 'write_unconfirmed');
  return verifySaved(saved);
}
