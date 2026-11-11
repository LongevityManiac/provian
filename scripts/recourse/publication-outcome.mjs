import { AbiCoder, Interface, ZeroAddress, keccak256, sha256, toUtf8Bytes, zeroPadValue } from 'ethers';
import { LEGACY_INSTITUTIONS } from './institution-snapshot.mjs';
import { verifyPointerPublication } from './pointer-publication.mjs';
import { verifySuccessorPlan } from './successor-verification.mjs';
import { verifySuccessorSourceInterval } from './successor-preflight.mjs';

const ensure = (value, reason) => { if (!value) throw Error('publication_outcome_' + reason); };
const lower = value => String(value).toLowerCase();
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hash = /^0x[0-9a-f]{64}$/;
const pointerAbi = new Interface([
  'function revision() view returns(uint256)', 'function authority() view returns(address)',
  'function retired(address) view returns(bool)',
  'function current() view returns(uint256,bytes32,address[10],bytes32[10])',
  'event DeploymentChanged(uint256 indexed revision,bytes32 indexed manifestHash,address[10] components,bytes32[10] runtimeHashes)',
  'event LegacyContractRetired(address indexed target,bytes32 runtimeHash)',
]);
const tokenAbi = new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const position = log => [Number(BigInt(log.blockNumber)), Number(BigInt(log.transactionIndex)), Number(BigInt(log.logIndex))];
const compare = (a, b) => { const x = position(a), y = position(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };
const manifest = (pointer, revision, components, hashes) => keccak256(AbiCoder.defaultAbiCoder().encode(
  ['uint256', 'address', 'uint256', 'address[10]', 'bytes32[10]'], [8453, pointer, revision, components, hashes]));

/** Canonical semantic evidence for the first publication. It deliberately says
 * nothing about which hash-authority signature won or whether a sponsor nonce
 * is closed. Those are separate proofs, even for a wrapped third-party call.
 * All reconstruction runs at authenticated historical state; ordinary activity
 * after the publication log cannot invalidate the pre-publication proof. */
export async function inspectPublicationOutcome(incoming, inputs) {
  const plan = structuredClone(incoming);
  const { port: suppliedPort, ...facts } = inputs;
  inputs = { ...structuredClone(facts), port: suppliedPort };
  const { port, artifacts, successor, deployment, institutions, rule, pin } = inputs;
  const current = await port.finalizedBlock(), original = plan.checkpoint;
  ensure(Number.isSafeInteger(current.number) && Number.isSafeInteger(original?.number)
    && original.number > 0 && current.number >= original.number && hash.test(current.hash)
    && hash.test(original.hash) && (current.number !== original.number || current.hash === original.hash), 'checkpoint_invalid');
  const checkpoints = new Map([[original.number, original.hash], [current.number, current.hash]]);
  const checkPins = async () => {
    for (const [number, expected] of checkpoints) ensure(await port.blockHash(number) === expected, 'reorg');
  };
  await checkPins();
  await verifyPointerPublication(plan, { ...inputs, port: { ...port, finalizedBlock: async () => original } });
  ensure(keccak256(await port.code(pin.address, current.hash)) === pin.runtimeHash, 'pointer_runtime_changed');
  const read = async (method, args = []) => pointerAbi.decodeFunctionResult(method,
    await port.call(pin.address, pointerAbi.encodeFunctionData(method, args), current.hash));
  ensure(lower((await read('authority'))[0]) === successor.pointerAuthority, 'authority_changed');

  const validateLogs = (logs, addresses, end = current.number) => {
    const seen = new Set();
    for (const log of logs) {
      const [height, transactionIndex, logIndex] = position(log), key = `${height}:${logIndex}`;
      ensure(!log.removed && addresses.includes(lower(log.address)) && height > original.number && height <= end
        && [height, transactionIndex, logIndex].every(n => Number.isSafeInteger(n) && n >= 0)
        && hash.test(log.blockHash) && hash.test(log.transactionHash) && !seen.has(key), 'log_invalid');
      seen.add(key);
      ensure(!checkpoints.has(height) || checkpoints.get(height) === log.blockHash, 'log_block_changed');
      checkpoints.set(height, log.blockHash);
    }
    return [...logs].sort(compare);
  };
  const rows = current.number === original.number ? [] : validateLogs(
    await port.logs(pin.address, original.number + 1, current.number), [pin.address]);
  const changes = [];
  for (const row of rows) {
    const event = pointerAbi.parseLog(row);
    ensure(event, 'unknown_pointer_event');
    if (event.name === 'LegacyContractRetired') {
      const index = plan.targets.indexOf(lower(event.args.target));
      ensure(changes.length === 0 && index >= 0 && event.args.runtimeHash === plan.hashes[index], 'retirement_changed');
    } else {
      ensure(event.name === 'DeploymentChanged' && event.args.revision === BigInt(changes.length + 1), 'revision_history');
      const components = [...event.args.components].map(lower), hashes = [...event.args.runtimeHashes];
      ensure(event.args.manifestHash === manifest(pin.address, event.args.revision, components, hashes), 'manifest_hash');
      changes.push({ row, components, hashes, revision: event.args.revision, manifestHash: event.args.manifestHash });
    }
  }
  const revision = (await read('revision'))[0];
  ensure(revision === BigInt(changes.length), 'revision_history');
  const publication = changes[0];
  if (publication) {
    ensure(equal(publication.components, plan.components.map(lower)) && equal(publication.hashes, plan.componentHashes), 'first_manifest_changed');
    const latest = changes.at(-1), state = await read('current');
    ensure(state[0] === latest.revision && state[1] === latest.manifestHash
      && equal([...state[2]].map(lower), latest.components) && equal([...state[3]], latest.hashes), 'current_manifest_changed');
  }

  // Reconcile all imported economics/custody again immediately before the
  // publication block. Events then close the intra-block gap in log order.
  const before = publication ? { number: position(publication.row)[0] - 1,
    hash: await port.blockHash(position(publication.row)[0] - 1) } : current;
  ensure(before.number >= original.number && hash.test(before.hash), 'prepublication_block');
  ensure(!checkpoints.has(before.number) || checkpoints.get(before.number) === before.hash, 'reorg');
  checkpoints.set(before.number, before.hash);
  const reconciled = await verifySuccessorPlan({ plan: successor, institutions, rule, artifacts, port, block: before });
  ensure(equal(reconciled.components, plan.components) && equal(reconciled.hashes, plan.componentHashes), 'components_changed');
  await verifySuccessorSourceInterval({ plan: successor, deployment, artifacts, port, current: before });
  const oldInstitutions = Object.keys(LEGACY_INSTITUTIONS).map(key => lower(deployment.contracts[key].address));
  const names = new Map(successor.creations.map(row => [lower(row.address), row.label.slice('deploy:'.length)]));
  names.set(lower(successor.components[9]), 'ProvianMemberSettlement');
  const targets = [...new Set([...names.keys(), successor.predecessor,
    lower(successor.snapshot.state.eligibilityVerifier.verifier), ...oldInstitutions])];
  const end = publication ? position(publication.row)[0] : current.number;
  if (end > original.number) {
    const interval = validateLogs(await port.logs(targets, original.number + 1, end), targets, end);
    for (const row of interval) {
      if (publication && compare(row, publication.row) > 0) continue;
      const target = lower(row.address);
      ensure(target === successor.predecessor || target === lower(successor.components[0]), 'prepublication_activity');
      const name = target === successor.predecessor ? 'ProvianPVT9' : 'ProvianRecourseKernel';
      const event = new Interface(artifacts[name].abi).parseLog(row);
      ensure(event && ['Transfer', 'Approval', 'Burned'].includes(event.name)
        && (event.name !== 'Transfer' || event.args.from !== ZeroAddress), 'prepublication_activity');
    }
    const custody = [...new Set([...oldInstitutions, ...successor.components.slice(3, 9).map(lower)])];
    const usdc = lower(deployment.wiring.usdc);
    const incoming = validateLogs(await port.logs(usdc, original.number + 1, end,
      [tokenAbi.getEvent('Transfer').topicHash, null, custody.map(address => zeroPadValue(address, 32))]), [usdc], end);
    for (const row of incoming) if (!publication || compare(row, publication.row) < 0) {
      const event = tokenAbi.parseLog(row);
      ensure(event?.name === 'Transfer' && !custody.includes(lower(event.args.to)), 'prepublication_usdc_custody');
    }
  }
  const retired = [];
  for (let index = 0; index < plan.targets.length; index++) {
    const target = plan.targets[index];
    ensure(keccak256(await port.code(target, current.hash)) === plan.hashes[index], 'retirement_runtime_changed');
    retired.push((await read('retired', [target]))[0]);
  }
  if (publication) ensure(retired.every(value => value === true), 'retirement_incomplete');
  const goal = { pointer: pin.address, authority: successor.pointerAuthority, revision: '1',
    componentsDigest: sha256(toUtf8Bytes(JSON.stringify({ components: plan.components, hashes: plan.componentHashes }))) };
  const achieved = plan.stage === 'retire' ? retired.every(value => value === true) : Boolean(publication);
  await checkPins();
  return { status: revision > 1n ? 'superseded' : achieved ? 'achieved' : 'pending', stage: plan.stage, goal,
    checkpoint: current, planDigest: plan.digest, revision: revision.toString(),
    publication: publication ? { transactionHash: publication.row.transactionHash, block: {
      number: position(publication.row)[0], hash: publication.row.blockHash }, logIndex: position(publication.row)[2],
    manifestHash: publication.manifestHash } : null };
}
