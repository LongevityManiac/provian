import { Interface, ZeroAddress, sha256, toUtf8Bytes } from 'ethers';
import { verifyInstitutionRuntime } from './institution-snapshot.mjs';
const ensure = (value, reason) => { if (!value) throw Error('predecessor_retirement_' + reason); };
const address = value => {
  ensure(typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value), 'address_invalid');
  return value.toLowerCase();
};
const digest = value => sha256(toUtf8Bytes(JSON.stringify(value)));

/** The fixed first successor plan cannot invent replacements for a separately
 * scheduled verifier. Detect that unsupported migration before holding funds
 * issuance, rather than discovering it in the post-retirement snapshot. */
async function verifyScheduledVerifierCompatibility({deployment,artifacts,port,block}) {
  const kernel=address(deployment.wiring.pvt),abi=new Interface(artifacts.ProvianPVT9.abi);
  const from=deployment.successorKernel?.pvt9Kernel?.block;
  ensure(Number.isSafeInteger(from)&&from>0&&from<=block.number,'deployment_boundary_missing');
  const epoch=abi.decodeFunctionResult('lastOpenedEpoch',await port.call(kernel,abi.encodeFunctionData('lastOpenedEpoch'),block.hash))[0];
  const names=['BeneficiaryVerifierScheduled','EligibilityVerifierScheduled'];
  const logs=await port.logs(kernel,from,block.number,[names.map(name=>abi.getEvent(name).topicHash)]);
  for(const log of logs){
    const event=abi.parseLog(log);
    if(!event||!names.includes(event.name))continue;
    ensure(!log.removed&&address(log.address)===kernel&&BigInt(log.blockNumber)>=BigInt(from)
      &&BigInt(log.blockNumber)<=BigInt(block.number)&&await port.blockHash(Number(BigInt(log.blockNumber)))===log.blockHash,'history_invalid');
    if(event.args.effectiveEpoch<=epoch)continue;
    const method=event.name==='BeneficiaryVerifierScheduled'?'getScheduledBeneficiaryVerifier':'getScheduledEligibilityVerifier';
    const schedule=abi.decodeFunctionResult(method,await port.call(kernel,abi.encodeFunctionData(method,[event.args.effectiveEpoch]),block.hash))[0];
    ensure(!schedule.exists||address(schedule.config.verifier)===ZeroAddress,'scheduled_verifier_successor_required');
  }
  ensure(await port.blockHash(block.number)===block.hash,'reorg');
}

async function readState({ deployment, artifacts, port, block }) {
  const kernel = address(deployment.wiring.pvt), admin = address(deployment.wiring.admin);
  ensure(kernel !== ZeroAddress && admin !== ZeroAddress && Number.isSafeInteger(block.number) && block.number > 0
    && /^0x[0-9a-f]{64}$/.test(block.hash) && await port.blockHash(block.number) === block.hash, 'checkpoint_invalid');
  const tokenAbi = new Interface(artifacts.ProvianPVT9.abi), verifierAbi = new Interface(artifacts.ProvianPVT9EligibilityVerifier.abi);
  const call = async (target, abi, method, args = []) => abi.decodeFunctionResult(method,
    await port.call(target, abi.encodeFunctionData(method, args), block.hash))[0];
  const kernelRuntimeHash = verifyInstitutionRuntime(artifacts.ProvianPVT9, await port.code(kernel, block.hash));
  ensure(address(await call(kernel, tokenAbi, 'BOOTSTRAP_ADMIN')) === admin, 'kernel_admin_changed');
  const epoch = await call(kernel, tokenAbi, 'lastOpenedEpoch');
  const policy = await call(kernel, tokenAbi, 'getEpochPolicy', [epoch]);
  const verifier = address(policy.eligibilityVerifier.verifier);
  ensure(verifier !== ZeroAddress && verifier !== kernel, 'verifier_invalid');
  const verifierRuntimeHash = verifyInstitutionRuntime(artifacts.ProvianPVT9EligibilityVerifier, await port.code(verifier, block.hash));
  ensure(address(await call(verifier, verifierAbi, 'BOOTSTRAP_ADMIN')) === admin
    && address(await call(verifier, verifierAbi, 'KERNEL')) === kernel
    && await call(verifier, verifierAbi, 'DEPLOYMENT_CHAIN_ID') === 8453n
    && await call(verifier, verifierAbi, 'CONFIGURATION_ID') === policy.eligibilityVerifier.configurationId
    && await call(verifier, verifierAbi, 'CONFIGURATION_VERSION') === policy.eligibilityVerifier.version, 'verifier_binding_changed');
  const state = { kernel, admin, verifier, kernelRuntimeHash, verifierRuntimeHash,
    kernelHeld: await call(kernel, tokenAbi, 'administrativeHold'), minter: address(await call(kernel, tokenAbi, 'operationalMinter')),
    verifierHeld: await call(verifier, verifierAbi, 'administrativeHold'), approver: address(await call(verifier, verifierAbi, 'batchApprover')) };
  ensure(typeof state.kernelHeld === 'boolean' && typeof state.verifierHeld === 'boolean', 'hold_invalid');
  ensure(await port.blockHash(block.number) === block.hash, 'reorg');
  return state;
}
function planFromState(state, block, artifacts) {
  const token = new Interface(artifacts.ProvianPVT9.abi), verifier = new Interface(artifacts.ProvianPVT9EligibilityVerifier.abi);
  const step = (target, abi, method) => ({ label: `retire:${target}:${method}`, from: state.admin, to: target, value: '0', data: abi.encodeFunctionData(method) });
  // Holding the token comes first. Revocation remains explicit even though the
  // hold itself prevents settlement; neither can be mistaken for retirement.
  const steps = [...(!state.kernelHeld ? [step(state.kernel, token, 'placeAdministrativeHold')] : []),
    ...(state.minter !== ZeroAddress ? [step(state.kernel, token, 'revokeOperationalMinter')] : []),
    ...(!state.verifierHeld ? [step(state.verifier, verifier, 'placeAdministrativeHold')] : []),
    ...(state.approver !== ZeroAddress ? [step(state.verifier, verifier, 'revokeBatchApprover')] : [])];
  const plan = { schema: 'provian.predecessor-retirement.v1', chainId: 8453, checkpoint: block, state, steps };
  return { ...plan, digest: digest(plan) };
}
/** Read-only preparation. No signer is loaded and no state changes here. The
 * subsequent cutoff must be chosen only after all four shutdown facts hold at
 * an independently agreed finalized block. Ordinary transfers remain ungated. */
export async function preparePredecessorRetirement({ deployment, artifacts, port }) {
  const block = await port.finalizedBlock();
  await verifyScheduledVerifierCompatibility({deployment,artifacts,port,block});
  return planFromState(await readState({ deployment, artifacts, port, block }), block, artifacts);
}
/** Authenticate an exact stage against its original canonical source, then
 * allow only monotonic progress toward held/revoked. A resumed journal uses the
 * original plan, never a newly shortened transaction list with different nonce
 * meanings. The durable runner authenticates each submitted receipt separately. */
export async function verifyPredecessorRetirement({ plan, deployment, artifacts, port, complete = false }) {
  ensure(plan?.schema === 'provian.predecessor-retirement.v1' && plan.chainId === 8453, 'plan_invalid');
  const original = await readState({ deployment, artifacts, port, block: plan.checkpoint });
  ensure(JSON.stringify(plan) === JSON.stringify(planFromState(original, plan.checkpoint, artifacts)), 'plan_changed');
  const block = await port.finalizedBlock();
  await verifyScheduledVerifierCompatibility({deployment,artifacts,port,block});
  ensure(block.number >= plan.checkpoint.number, 'finality_regressed');
  const current = await readState({ deployment, artifacts, port, block });
  for (const field of ['kernel', 'admin', 'verifier', 'kernelRuntimeHash', 'verifierRuntimeHash']) ensure(current[field] === original[field], 'domain_changed');
  ensure((!original.kernelHeld || current.kernelHeld) && (!original.verifierHeld || current.verifierHeld)
    && [original.minter, ZeroAddress].includes(current.minter) && [original.approver, ZeroAddress].includes(current.approver), 'authority_changed');
  // Detect an intervening resume/reappointment even if a later transaction
  // restores the same final flags. Transfer/settlement history is preserved by
  // the later cutoff snapshot; it is not erased or rewritten by this planner.
  if (block.number > plan.checkpoint.number) {
    const interfaces = new Map([[current.kernel, new Interface(artifacts.ProvianPVT9.abi)],
      [current.verifier, new Interface(artifacts.ProvianPVT9EligibilityVerifier.abi)]]);
    for (const log of await port.logs([current.kernel, current.verifier], plan.checkpoint.number + 1, block.number)) {
      const target = address(log.address), iface = interfaces.get(target);
      ensure(iface && !log.removed && BigInt(log.blockNumber) > BigInt(plan.checkpoint.number)
        && BigInt(log.blockNumber) <= BigInt(block.number) && await port.blockHash(Number(BigInt(log.blockNumber))) === log.blockHash, 'history_invalid');
      const event = iface.parseLog(log);
      ensure(event && event.name !== 'AdministrativeHoldResumed'
        && !(target === current.kernel && event.name === 'OperationalMinterUpdated' && address(event.args.newMinter) !== ZeroAddress)
        && !(target === current.verifier && event.name === 'BatchApproverAppointed'), 'reactivated');
    }
  }
  const retired = current.kernelHeld && current.verifierHeld && current.minter === ZeroAddress && current.approver === ZeroAddress;
  if (complete) ensure(retired, 'incomplete');
  ensure(await port.blockHash(plan.checkpoint.number) === plan.checkpoint.hash && await port.blockHash(block.number) === block.hash, 'reorg');
  return { retired, block, state: current };
}
export function predecessorRetirementValidator({ plan, deployment, artifacts, port }) {
  plan = structuredClone(plan); deployment = structuredClone(deployment);
  const stageDigest = digest({ planDigest: plan.digest, steps: plan.steps });
  return async checked => {
    ensure(checked.planDigest === plan.digest && checked.stageDigest === stageDigest
      && JSON.stringify(checked.steps) === JSON.stringify(plan.steps), 'stage_changed');
    return verifyPredecessorRetirement({ plan, deployment, artifacts, port });
  };
}
