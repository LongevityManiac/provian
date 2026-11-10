import { keccak256 } from 'ethers';
import { HASH_ACCOUNT_ABI, hashAccountCall, hashAccountIntentDigest } from '../../provian-agent-sdk/dist/hash-account.js';
import { prepareVaultHashOperation } from './hash-authority-vault.mjs';

const address = /^0x[0-9a-f]{40}$/;
const hash = /^0x[0-9a-f]{64}$/;
const uint = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) < 2n ** 256n;
const zero = /^0x0+$/;
/** A reviewed plan fixes both deployed programs, account state and complete call.
 * Neither the vault nor a relay supplies any of these execution facts. */
export async function verifyHashAuthorityPlan(plan, port, accountRuntimeHash) {
  if (!plan || plan.schema !== 'provian.hash-authority-plan.v1'
    || ![plan.account, plan.target].every(v => typeof v === 'string' && address.test(v) && !zero.test(v))
    || ![plan.currentRoot, plan.targetRuntimeHash, accountRuntimeHash].every(v => typeof v === 'string' && hash.test(v) && !zero.test(v))
    || ![plan.nonce, plan.value, plan.callGas].every(uint) || BigInt(plan.callGas) === 0n
    || typeof plan.data !== 'string' || !/^0x(?:[0-9a-f]{2})*$/.test(plan.data)) throw Error('hash_authority_plan_invalid');
  const block = await port.finalizedBlock(); // Includes the two-provider Base chain check.
  const [accountCode, targetCode, root, nonce] = await Promise.all([
    port.code(plan.account, block.hash), port.code(plan.target, block.hash),
    port.call(plan.account, HASH_ACCOUNT_ABI.encodeFunctionData('keyCommitment'), block.hash),
    port.call(plan.account, HASH_ACCOUNT_ABI.encodeFunctionData('nonce'), block.hash),
  ]);
  if (accountCode === '0x' || keccak256(accountCode) !== accountRuntimeHash
    || targetCode === '0x' || keccak256(targetCode) !== plan.targetRuntimeHash) throw Error('hash_authority_code_mismatch');
  if (HASH_ACCOUNT_ABI.decodeFunctionResult('keyCommitment', root)[0] !== plan.currentRoot
    || HASH_ACCOUNT_ABI.decodeFunctionResult('nonce', nonce)[0] !== BigInt(plan.nonce)) throw Error('hash_authority_state_changed');
  return { block, intent: { chainId: '8453', account: plan.account, nonce: plan.nonce,
    target: plan.target, value: plan.value, callGas: plan.callGas, data: plan.data } };
}
export async function prepareCheckedHashAuthority(plan, port, accountRuntimeHash, vault, crypto) {
  const verified = await verifyHashAuthorityPlan(plan, port, accountRuntimeHash);
  const prepared = await prepareVaultHashOperation(vault, { currentRoot: plan.currentRoot, intent: verified.intent }, crypto);
  const operation = prepared.operation;
  const digest = hashAccountIntentDigest(operation);
  const onChain = await port.call(plan.account, HASH_ACCOUNT_ABI.encodeFunctionData('intentDigest',
    [plan.target, plan.value, plan.callGas, plan.data, operation.nextCommitment]), verified.block.hash);
  if (HASH_ACCOUNT_ABI.decodeFunctionResult('intentDigest', onChain)[0] !== digest) throw Error('hash_authority_digest_mismatch');
  const calldata = hashAccountCall(operation);
  const simulation = await port.call(plan.account, calldata, verified.block.hash);
  if (HASH_ACCOUNT_ABI.decodeFunctionResult('execute', simulation)[0] !== true) throw Error('hash_authority_target_failed');
  if (await port.blockHash(verified.block.number) !== verified.block.hash) throw Error('hash_authority_snapshot_changed');
  return { schema: 'provian.hash-authority-operation.v1', ...prepared, digest,
    verifiedBlock: verified.block, transaction: { chainId: '8453', to: plan.account, value: '0', data: calldata } };
}
