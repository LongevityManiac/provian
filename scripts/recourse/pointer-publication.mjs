import { Interface, ZeroAddress, ZeroHash, keccak256, sha256, toUtf8Bytes } from 'ethers';
import { LEGACY_INSTITUTIONS } from './institution-snapshot.mjs';
import { verifySuccessorPlan } from './successor-verification.mjs';
import { reconstructSuccessorPlan, verifySuccessorSourceInterval } from './successor-preflight.mjs';
import { assertManifestSuccession } from './pointer-manifest-succession.mjs';
const ensure = (value, reason) => { if (!value) throw Error('pointer_publication_' + reason); };
const digest = value => sha256(toUtf8Bytes(JSON.stringify(value)));
const lower = value => String(value).toLowerCase();
const abi = new Interface(['function authority() view returns(address)', 'function revision() view returns(uint256)',
  'function retired(address) view returns(bool)', 'function registerLegacyRetirements(address[],bytes32[])',
  'function publish(uint256,address[10],bytes32[10])', 'function keyCommitment() view returns(bytes32)', 'function nonce() view returns(uint256)']);
/** The caller obtains deployment/legacy token facts from canonical repository
 * configuration and verifies the signed membership rule before this boundary.
 * This module returns unsigned calls only: it does not access a recovery seed
 * or expose an executable hash-authority signature to an RPC operator. */
export async function preparePointerPublication({ stage, successor, institutions, rule, deployment, legacyTokens, artifacts, pin, port, callGas, pointerPlan, operators }) {
  ensure(['retire', 'publish'].includes(stage) && typeof callGas === 'string' && /^[1-9][0-9]*$/.test(callGas)
    && BigInt(callGas) < (1n << 256n), 'input_invalid');
  ensure(pin?.chainId === 8453 && successor.pointer === pin.address && /^0x[0-9a-f]{64}$/.test(pin.runtimeHash), 'build_pin_changed');
  ensure(lower(successor.predecessor) === lower(deployment.wiring.pvt) && lower(successor.admin) === lower(deployment.wiring.admin), 'source_changed');
  ensure(Array.isArray(legacyTokens) && legacyTokens.length > 0 && legacyTokens.every(address => /^0x[0-9a-fA-F]{40}$/.test(address)
    && lower(address) !== ZeroAddress), 'legacy_inventory_invalid');
  const rebuilt = await reconstructSuccessorPlan({ plan: successor, pointerPlan, verifiedRule: rule, operators, deployment, artifacts, port });
  ensure(JSON.stringify(institutions) === JSON.stringify(rebuilt.institutions), 'institution_inventory_changed');
  successor = rebuilt.plan;
  const block = await port.finalizedBlock();
  ensure(block.number >= rebuilt.verifiedAt.number, 'finality_regressed');
  const reconciled = await verifySuccessorPlan({ plan: successor, institutions, rule, artifacts, port, block });
  await verifySuccessorSourceInterval({ plan: successor, deployment, artifacts, port, current: block });
  ensure(keccak256(await port.code(successor.pointer, block.hash)) === pin.runtimeHash, 'pointer_runtime_changed');
  const call = async (target, method, args = []) => abi.decodeFunctionResult(method,
    await port.call(target, abi.encodeFunctionData(method, args), block.hash))[0];
  const authority = lower(await call(successor.pointer, 'authority'));
  ensure(authority === successor.pointerAuthority && authority !== ZeroAddress
    && keccak256(await port.code(authority, block.hash)) === keccak256(artifacts.ProvianHashAccount.deployedBytecode.object), 'authority_changed');
  ensure(await call(successor.pointer, 'revision') === 0n, 'already_published');
  // This tool publishes the first manifest only. The succession rule still runs here so every
  // publish call this repository encodes passes through the one check.
  assertManifestSuccession({ revision: 0n, current: Array(10).fill(ZeroAddress), next: reconciled.components });
  // The client forbidden-address inventory spans chains. Only contracts present
  // on this chain can be retired; retain absent entries as verified plan facts.
  // Required source contracts and import helpers may never be absent.
  const absentLegacyTokens = [], presentLegacyTokens = [];
  for (const target of [...new Set(legacyTokens.map(lower))].sort()) {
    const code = await port.code(target, block.hash);
    ensure(/^0x(?:[0-9a-f]{2})*$/.test(code), 'legacy_code_invalid');
    (code === '0x' ? absentLegacyTokens : presentLegacyTokens).push(target);
  }
  const targets = [...new Set([successor.predecessor, successor.snapshot.state.eligibilityVerifier.verifier,
    ...Object.keys(LEGACY_INSTITUTIONS).map(key => deployment.contracts[key].address), ...presentLegacyTokens,
    ...successor.retireAfterImport].map(lower))].sort();
  ensure(targets.length > 0 && targets.every(address => /^0x[0-9a-f]{40}$/.test(address) && address !== ZeroAddress
    && address !== successor.pointer && address !== authority && !successor.components.map(lower).includes(address)), 'legacy_target_invalid');
  const hashes = [], retired = [];
  for (const target of targets) {
    const code = await port.code(target, block.hash);
    ensure(/^0x[0-9a-f]+$/.test(code), 'legacy_code_missing');
    hashes.push(keccak256(code)); retired.push(await call(successor.pointer, 'retired', [target]));
  }
  ensure(retired.every(value => typeof value === 'boolean'), 'legacy_state_invalid');
  if (stage === 'publish') ensure(retired.every(Boolean), 'legacy_retirement_incomplete');
  const currentRoot = await call(authority, 'keyCommitment'), nonce = await call(authority, 'nonce');
  ensure(/^0x[0-9a-f]{64}$/.test(currentRoot) && currentRoot !== ZeroHash && typeof nonce === 'bigint' && nonce >= 0n, 'authority_state_invalid');
  const data = stage === 'retire' ? abi.encodeFunctionData('registerLegacyRetirements', [targets, hashes])
    : abi.encodeFunctionData('publish', [0, reconciled.components, reconciled.hashes]);
  const hashAuthorityPlan = { schema: 'provian.hash-authority-plan.v1', account: authority, target: successor.pointer,
    currentRoot, nonce: nonce.toString(), value: '0', callGas, data, targetRuntimeHash: pin.runtimeHash };
  ensure(await port.blockHash(successor.cutoff.number) === successor.cutoff.hash && await port.blockHash(block.number) === block.hash, 'reorg');
  const body = { schema: 'provian.pointer-publication.v1', stage, chainId: 8453, checkpoint: block, successorDigest: successor.digest,
    institutionDigest: institutions.digest, ruleHash: rule.ruleHash, targets, hashes, absentLegacyTokens,
    components: reconciled.components, componentHashes: reconciled.hashes, complete: stage === 'retire' && retired.every(Boolean), hashAuthorityPlan };
  return { ...body, digest: digest(body) };
}
/** Rebuild current execution facts before the signing boundary. A changed block
 * alone does not invalidate the unsigned review, but no call, authority nonce,
 * economics, component or retirement target may change beneath that review. */
export async function verifyPointerPublication(plan, inputs) {
  ensure(plan?.schema === 'provian.pointer-publication.v1', 'plan_invalid');
  const body = { ...plan }; delete body.digest;
  ensure(digest(body) === plan.digest, 'plan_changed');
  const fresh = await preparePointerPublication({ ...inputs, stage: plan.stage, callGas: plan.hashAuthorityPlan.callGas });
  const facts = value => { const copy = { ...value }; delete copy.checkpoint; delete copy.digest; return copy; };
  ensure(JSON.stringify(facts(fresh)) === JSON.stringify(facts(plan)), 'facts_changed');
  ensure(await inputs.port.blockHash(plan.checkpoint.number) === plan.checkpoint.hash, 'reorg');
  return fresh;
}
