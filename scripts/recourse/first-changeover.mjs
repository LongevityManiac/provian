import { assertBaseTransactionGasLimit } from './transaction-gas-limit.mjs';
import { keccak256, sha256, toUtf8Bytes } from 'ethers';
import { preparePredecessorRetirement, verifyPredecessorRetirement, predecessorRetirementValidator } from './predecessor-retirement.mjs';
import { preparePointerDeployment, verifyPointerDeployment, pointerDeploymentValidator } from './pointer-deployment.mjs';
import { buildSuccessionSnapshot } from './snapshot.mjs';
import { buildInstitutionSnapshot, LEGACY_INSTITUTIONS, verifyInstitutionRuntime } from './institution-snapshot.mjs';
import { successorLocations, buildSuccessorPlan } from './successor-plan.mjs';
import { preflightSuccessorPlan, verifySuccessorSourceInterval } from './successor-preflight.mjs';
import { verifySuccessorPlan } from './successor-verification.mjs';
import { successorDeploymentSteps, successorDeploymentValidator } from './successor-deploy-cli.mjs';
import { readPublicationProgress } from './publication-recovery.mjs';
import { prepareSuccessorActivation, verifySuccessorActivation, successorActivationValidator } from './successor-activation.mjs';

const ensure = (value, reason) => { if (!value) throw Error('first_changeover_' + reason); };
const digest = value => sha256(toUtf8Bytes(JSON.stringify(value)));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Use a saved phase checkpoint only for read-only terminal reconciliation.
 * Canonical receipts still come from the live independent provider pair. */
async function historicalPort(port, checkpoint) {
  const current = await port.finalizedBlock();
  ensure(Number.isSafeInteger(checkpoint?.number) && checkpoint.number > 0 && checkpoint.number <= current.number
    && /^0x[0-9a-f]{64}$/.test(checkpoint.hash) && await port.blockHash(checkpoint.number) === checkpoint.hash, 'completion_checkpoint_changed');
  return { ...port, finalizedBlock: async () => {
    ensure(await port.blockHash(checkpoint.number) === checkpoint.hash, 'completion_checkpoint_changed'); return structuredClone(checkpoint);
  } };
}

/** Complete first-changeover ordering with immutable review artifacts. No stage
 * authorizes the next merely because a process once reported success: terminal
 * journals, canonical checkpoints and independently reconstructed state are
 * checked again. execute is an explicit caller decision; this module does not
 * load keys, select a database or infer public-switch authorization. */
export async function advanceFirstChangeover({ inputs, state, execute, runtime, publish, authorityStore }) {
  const { port, ...facts } = inputs; inputs = { ...structuredClone(facts), port };
  ensure(typeof execute === 'boolean' && typeof runtime === 'function' && typeof publish === 'function'
    && typeof state?.read === 'function' && typeof state?.create === 'function', 'configuration');
  const { deployment, artifacts, pointerPlan, pin, rule, legacyTokens, importBatchSize, callGas } = inputs;
  const addresses = Object.fromEntries(['deployer', 'identityAttestor', 'batchApprover', 'submitter'].map(key => [key, inputs[key]]));
  ensure(Object.values(addresses).every(value => typeof value === 'string' && /^0x[0-9a-f]{40}$/.test(value))
    && Number.isSafeInteger(importBatchSize) && importBatchSize >= 1 && importBatchSize <= 128
    && typeof callGas === 'string' && /^[1-9][0-9]*$/.test(callGas), 'configuration');
  assertBaseTransactionGasLimit(BigInt(callGas));
  if (inputs.executionLimits) assertBaseTransactionGasLimit(BigInt(inputs.executionLimits.maxGas));
  const configuration = { schema: 'provian.first-changeover.v1', deployment, pointerPlan, pin, rule, legacyTokens,
    ...addresses, importBatchSize, callGas, executionLimits: inputs.executionLimits ?? null,
    artifactHashes: Object.fromEntries(Object.entries(artifacts).sort(([a], [b]) => a.localeCompare(b))
      .map(([name, artifact]) => [name, { init: keccak256(artifact.bytecode.object), runtime: keccak256(artifact.deployedBytecode.object) }])) };
  await state.create('configuration', configuration);
  ensure(equal(await state.read('configuration'), configuration), 'configuration_changed');
  const stored = async (name, prepare) => (await state.read(name)) ?? await state.create(name, await prepare());
  const complete = async (phase, planDigest, checkpoint) => state.create(`${phase}-complete`, {
    schema: 'provian.changeover-completion.v1', phase, planDigest, checkpoint,
  });
  const completion = async (phase, planDigest) => {
    const row = await state.read(`${phase}-complete`);
    if (row) ensure(row.schema === 'provian.changeover-completion.v1' && row.phase === phase && row.planDigest === planDigest, 'completion_changed');
    return row;
  };
  const stage = async (phase, plan, steps, verify, validator) => {
    const done = await completion(phase, plan.digest), checkedPort = done ? await historicalPort(port, done.checkpoint) : port;
    const verifyAtCheckpoint = async (source, finished) => {
      const checkpoint = await source.finalizedBlock();
      const pinned = { ...source, finalizedBlock: async () => structuredClone(checkpoint) };
      const result = await verify(pinned, finished);
      ensure(result.block.number === checkpoint.number && result.block.hash === checkpoint.hash
        && await source.blockHash(checkpoint.number) === checkpoint.hash, 'verification_checkpoint_changed');
      return result;
    };
    const before = await verifyAtCheckpoint(checkedPort, Boolean(done));
    if (done) {
      if (steps.length) {
        const checked = await runtime({ steps, planDigest: plan.digest, assertPlan: validator(checkedPort) }, { phase, requireCompleted: true });
        ensure(checked.status === 'confirmed', 'terminal_stage_incomplete');
      }
      ensure(before.block.hash === done.checkpoint.hash && before.block.number === done.checkpoint.number, 'completion_changed');
      return null;
    }
    if (!execute) return { status: 'preflight_passed', phase, planDigest: plan.digest, steps: steps.length, broadcast: false };
    if (steps.length) {
      const result = await runtime({ steps, planDigest: plan.digest, assertPlan: validator(checkedPort) }, { phase, requireCompleted: false });
      if (result.status !== 'confirmed') return { ...result, phase };
    }
    const after = await verifyAtCheckpoint(port, true); await complete(phase, plan.digest, after.block); return null;
  };

  const retirement = await stored('retirement-plan', () => preparePredecessorRetirement({ deployment, artifacts, port }));
  const pointer = await stored('pointer-plan', () => preparePointerDeployment({ pointerPlan, deployer: addresses.deployer, port, pin }));
  let waiting = await stage('retirement', retirement, retirement.steps,
    (checkedPort, done) => verifyPredecessorRetirement({ plan: retirement, deployment, artifacts, port: checkedPort, complete: done }),
    checkedPort => predecessorRetirementValidator({ plan: retirement, deployment, artifacts, port: checkedPort }));
  if (waiting) return waiting;
  waiting = await stage('pointer', pointer, pointer.steps,
    (checkedPort, done) => verifyPointerDeployment({ plan: pointer, port: checkedPort, pin, complete: done }),
    checkedPort => pointerDeploymentValidator({ plan: pointer, port: checkedPort, pin }));
  if (waiting) return waiting;

  const bundle = await stored('successor-bundle', async () => {
    const retired = await verifyPredecessorRetirement({ plan: retirement, deployment, artifacts, port, complete: true });
    const cutoff = retired.block, counts = await Promise.all(port.rpcs.map(reader => reader.request('eth_getTransactionCount', [addresses.deployer, 'pending'])));
    const latest = await Promise.all(port.rpcs.map(reader => reader.request('eth_getTransactionCount', [addresses.deployer, 'latest'])));
    ensure(counts.length === 2 && counts[0] === counts[1] && latest[0] === counts[0] && latest[1] === counts[0]
      && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(counts[0]), 'deployer_nonce_disagreement');
    const nonce = Number(BigInt(counts[0])); ensure(Number.isSafeInteger(nonce) && nonce >= 0, 'deployer_nonce_invalid');
    const operators = { ...addresses, nonce };
    const snapshot = await buildSuccessionSnapshot({ port, kernelAbi: artifacts.ProvianPVT9.abi,
      predecessor: deployment.wiring.pvt, deploymentBlock: deployment.successorKernel.pvt9Kernel.block,
      block: cutoff.number, blockHash: cutoff.hash, expectedRuntimeHash: verifyInstitutionRuntime(artifacts.ProvianPVT9,
        await port.code(deployment.wiring.pvt, cutoff.hash)),
      destinations: successorLocations(deployment, addresses.deployer, nonce).destinations,
      institutions: Object.keys(LEGACY_INSTITUTIONS).map(key => deployment.contracts[key].address) });
    const institutions = await buildInstitutionSnapshot({ port, deployment, artifacts, block: cutoff.number, blockHash: cutoff.hash });
    const plan = buildSuccessorPlan({ snapshot, institutions, deployment, artifacts, pointerPlan, rule, ...operators });
    ensure(await port.blockHash(cutoff.number) === cutoff.hash, 'cutoff_changed');
    return { plan, institutions, operators };
  });
  const successor = bundle.plan, institutions = bundle.institutions, operators = bundle.operators;
  const inventoryBody = { ...institutions }; delete inventoryBody.digest;
  ensure(digest(inventoryBody) === institutions.digest && successor.institutionDigest === institutions.digest, 'institution_inventory_changed');
  const deploymentSteps = successorDeploymentSteps(successor, artifacts, importBatchSize);
  const successorFacts = { plan: successor, pointerPlan, verifiedRule: rule, operators, deployment, artifacts };
  waiting = await stage('successor', successor, deploymentSteps, async (checkedPort, done) => {
    const preflight = await preflightSuccessorPlan({ ...successorFacts, port: checkedPort });
    if (done) {
      const block = await checkedPort.finalizedBlock();
      await verifySuccessorSourceInterval({ plan: successor, deployment, artifacts, port: checkedPort, current: block });
      return verifySuccessorPlan({ plan: successor, institutions, rule, artifacts, port: checkedPort, block });
    }
    return { block: preflight.verifiedAt };
  }, checkedPort => successorDeploymentValidator({ plan: successor, pointerPlan, deployment, artifacts, port: checkedPort, steps: deploymentSteps }));
  if (waiting) return waiting;

  const publicationInputs = { successor, institutions, operators, pointerPlan, deployment, artifacts, pin, rule, legacyTokens, callGas, port };
  const publicationDigest = digest({ successor: successor.digest, institutions: institutions.digest, pointer: pin.address });
  const published = await completion('publication', publicationDigest);
  const publicationPort = published ? await historicalPort(port, published.checkpoint) : port;
  if (!published && !execute) return { status: 'preflight_passed', phase: 'publication', broadcast: false };
  const delivery = await publish({ ...publicationInputs, port: publicationPort }, { requireCompleted: Boolean(published) });
  if (delivery.status !== 'confirmed') { ensure(!published, 'terminal_publication_incomplete'); return { ...delivery, phase: 'publication' }; }
  const progress = await readPublicationProgress({ ...publicationInputs, port: publicationPort }, authorityStore);
  ensure(progress.outcome.publication && progress.outcome.revision === '1', 'publication_incomplete');
  const publication = await stored('publication-anchor', async () => progress.baseline);
  ensure(equal(publication, progress.baseline), 'publication_anchor_changed');
  if (!published) await complete('publication', publicationDigest, progress.outcome.checkpoint);

  const activationInputs = { ...publicationInputs, publication };
  const activation = await stored('activation-plan', () => prepareSuccessorActivation(activationInputs));
  waiting = await stage('activation', activation, activation.steps,
    (checkedPort, done) => verifySuccessorActivation({ ...activationInputs, plan: activation, port: checkedPort, complete: done }),
    checkedPort => successorActivationValidator({ ...activationInputs, plan: activation, port: checkedPort }));
  if (waiting) return waiting;
  const finished = await completion('activation', activation.digest);
  return { status: 'confirmed', phase: 'complete', pointer: pin.address, successorDigest: successor.digest,
    checkpoint: finished.checkpoint, configurationDigest: digest(configuration) };
}
