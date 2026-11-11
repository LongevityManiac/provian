import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { getBytes, sha256, toUtf8Bytes } from 'ethers';
import { HASH_ACCOUNT_ABI, hashAccountCall, hashAccountIntentDigest, parseSignedHashAccountOperation } from '../../provian-agent-sdk/dist/hash-account.js';
import { verifyHashAuthorityPlan } from './hash-authority-plan.mjs';
import { prepareVaultHashOperation } from './hash-authority-vault.mjs';
const requireSdk = createRequire(new URL('../../provian-agent-sdk/package.json', import.meta.url));
const ensure = (value, reason) => { if (!value) throw Error('hash_authority_durable_' + reason); };
const digest = object => sha256(toUtf8Bytes(JSON.stringify(object)));
async function verifyProof(operation) {
  const { slh_dsa_sha2_128s } = await import(pathToFileURL(requireSdk.resolve('@noble/post-quantum/slh-dsa.js')).href);
  return slh_dsa_sha2_128s.verify(getBytes(operation.signature), getBytes(hashAccountIntentDigest(operation)), getBytes(operation.publicKey));
}
/** Authenticate saved PUBLIC material locally before it can enter a simulation
 * or transaction. An edited successor root would otherwise strand the signer.
 * The storage adapter must use immutable atomic creation for this chain/account/nonce slot. */
export async function verifyDurableHashAuthority(record, plan, accountRuntimeHash) {
  record = structuredClone(record); plan = structuredClone(plan);
  ensure(record?.schema === 'provian.durable-hash-authority.v1' && record.planDigest === digest(plan)
    && record.accountRuntimeHash === accountRuntimeHash && /^0x[0-9a-f]{64}$/.test(accountRuntimeHash), 'record_binding');
  const operation = parseSignedHashAccountOperation(record.operation);
  for (const key of ['account', 'target', 'nonce', 'value', 'callGas', 'data']) ensure(operation[key] === plan[key], 'operation_changed');
  ensure(operation.chainId === '8453' && operation.signingRoot === plan.currentRoot
    && typeof record.nextItemId === 'string' && record.nextItemId.length > 0, 'operation_changed');
  ensure(Number.isSafeInteger(record.verifiedBlock?.number) && record.verifiedBlock.number > 0
    && /^0x[0-9a-f]{64}$/.test(record.verifiedBlock.hash), 'checkpoint_invalid');
  ensure(record.intentDigest === hashAccountIntentDigest(operation)
    && isDeepStrictEqual(record.transaction, { chainId: '8453', to: plan.account, value: '0', data: hashAccountCall(operation) }), 'transaction_changed');
  ensure(await verifyProof(operation), 'signature_invalid');
  return structuredClone(record);
}
/** Explicit signing boundary, but no executable signature is sent to an RPC.
 * The existing vault saves/read-backs every next seed before signing. This
 * additionally saves/read-backs the exact public operation before returning it.
 * A crash or competing preparer reuses the atomic winner rather than exposing
 * multiple signatures for one planned nonce. No gas signer is touched here.
 * Existing records may already have executed; callers reconcile their outcome
 * instead of requiring the old nonce/root to remain current on restart. */
export async function prepareDurableHashAuthority({ plan, accountRuntimeHash, port, vault, store }) {
  plan = structuredClone(plan);
  ensure(store && typeof store.read === 'function' && typeof store.create === 'function', 'store_required');
  const key = digest({ chainId: '8453', account: plan.account, nonce: plan.nonce }), existing = await store.read(key);
  if (existing) {
    const checked = await verifyDurableHashAuthority(existing, plan, accountRuntimeHash);
    ensure(await port.blockHash(checked.verifiedBlock.number) === checked.verifiedBlock.hash, 'checkpoint_changed');
    return checked;
  }
  const verified = await verifyHashAuthorityPlan(plan, port, accountRuntimeHash);
  const { operation, nextItemId } = await prepareVaultHashOperation(vault, { currentRoot: plan.currentRoot, intent: verified.intent });
  const intentDigest = hashAccountIntentDigest(operation);
  // This call contains only the unsigned intent and next public commitment.
  // In particular it contains neither publicKey nor executable signature.
  const onChain = await port.call(plan.account, HASH_ACCOUNT_ABI.encodeFunctionData('intentDigest',
    [plan.target, plan.value, plan.callGas, plan.data, operation.nextCommitment]), verified.block.hash);
  ensure(HASH_ACCOUNT_ABI.decodeFunctionResult('intentDigest', onChain)[0] === intentDigest, 'digest_mismatch');
  ensure(await port.blockHash(verified.block.number) === verified.block.hash, 'checkpoint_changed');
  const record = { schema: 'provian.durable-hash-authority.v1', planDigest: digest(plan), accountRuntimeHash,
    operation, nextItemId, intentDigest, verifiedBlock: verified.block,
    transaction: { chainId: '8453', to: plan.account, value: '0', data: hashAccountCall(operation) } };
  await verifyDurableHashAuthority(record, plan, accountRuntimeHash);
  try { await store.create(key, structuredClone(record)); }
  catch (error) {
    // A concurrent creator may have won, or our write response may be lost.
    // Only a complete, locally authenticated immutable winner can recover it.
    const saved = await store.read(key);
    if (!saved) throw error;
    const checked = await verifyDurableHashAuthority(saved, plan, accountRuntimeHash);
    ensure(await port.blockHash(checked.verifiedBlock.number) === checked.verifiedBlock.hash, 'checkpoint_changed');
    return checked;
  }
  const saved = await store.read(key);
  ensure(saved && isDeepStrictEqual(saved, record), 'write_unconfirmed');
  const checked = await verifyDurableHashAuthority(saved, plan, accountRuntimeHash);
  ensure(await port.blockHash(checked.verifiedBlock.number) === checked.verifiedBlock.hash, 'checkpoint_changed');
  return checked;
}
