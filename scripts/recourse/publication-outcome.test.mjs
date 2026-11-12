import { beforeEach, expect, test, vi } from 'vitest';
import { AbiCoder, Interface, ZeroAddress, keccak256 } from 'ethers';
import { readFileSync } from 'node:fs';
import { inspectPublicationOutcome } from './publication-outcome.mjs';
const checks = vi.hoisted(() => ({ plan: vi.fn(), successor: vi.fn(), interval: vi.fn() }));
vi.mock('./pointer-publication.mjs', () => ({ verifyPointerPublication: checks.plan }));
vi.mock('./successor-verification.mjs', () => ({ verifySuccessorPlan: checks.successor }));
vi.mock('./successor-preflight.mjs', () => ({ verifySuccessorSourceInterval: checks.interval }));
const a = n => `0x${n.toString(16).padStart(40, '0')}`, h = n => `0x${n.toString(16).padStart(64, '0')}`;
const artifact = name => JSON.parse(readFileSync(new URL(`../../contracts/out/${name}.sol/${name}.json`, import.meta.url)));
const pointer = new Interface(artifact('ProvianProtocolPointer').abi), kernel = new Interface(artifact('ProvianRecourseKernel').abi);
const token = new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
beforeEach(() => { for (const check of Object.values(checks)) check.mockReset(); });
function fixture() {
  const components = Array.from({ length: 10 }, (_, i) => a(30 + i)), hashes = components.map(() => keccak256('0x6002'));
  const manifest = (revision, addresses = components) => keccak256(AbiCoder.defaultAbiCoder().encode(
    ['uint256', 'address', 'uint256', 'address[10]', 'bytes32[10]'], [8453, a(20), revision, addresses, hashes]));
  const state = { height: 115, revision: 1n, retired: true, changed: new Map(), rows: [], logQueries: [], calls: [],
    currentComponents: components, currentHashes: hashes, currentManifest: manifest(1), code: '0x6001' };
  const log = (iface, event, args, address, height = 112, index = 5, transactionIndex = 2) => ({
    ...iface.encodeEventLog(iface.getEvent(event), args), address, blockNumber: '0x' + height.toString(16), blockHash: h(height),
    transactionIndex: '0x' + transactionIndex.toString(16), transactionHash: h(height * 100 + transactionIndex),
    logIndex: '0x' + index.toString(16), removed: false,
  });
  const publish = (revision = 1, addresses = components, height = 112, index = 5) =>
    log(pointer, 'DeploymentChanged', [revision, manifest(revision, addresses), addresses, hashes], a(20), height, index);
  state.rows.push(publish());
  const plan = { stage: 'publish', checkpoint: { number: 110, hash: h(110) }, components, componentHashes: hashes,
    targets: [a(1), a(2)], hashes: [keccak256('0x6002'), keccak256('0x6002')], digest: h(90) };
  const successor = { pointerAuthority: a(21), components, predecessor: a(1),
    snapshot: { state: { eligibilityVerifier: { verifier: a(2) } } },
    creations: ['ProvianRecourseKernel', 'ProvianMemberRecoursePool', 'ProvianRecourseEscrow'].map((name, i) => ({ label: `deploy:${name}`, address: components[i] })) };
  const inputs = { successor, artifacts: { ProvianRecourseKernel: artifact('ProvianRecourseKernel'), ProvianPVT9: artifact('ProvianPVT9') },
    institutions: { verified: true }, rule: { verified: true }, pin: { address: a(20), runtimeHash: keccak256('0x6001') },
    deployment: { wiring: { usdc: a(80) }, contracts: Object.fromEntries(['escrowV4', 'promiseV3', 'poolV3', 'bondPool', 'courtV2']
      .map((key, i) => [key, { address: a(10 + i) }])) },
    port: {
      finalizedBlock: async () => ({ number: state.height, hash: h(state.height) }),
      blockHash: async n => state.changed.get(n) ?? h(n),
      code: async address => address === a(20) ? state.code : '0x6002',
      logs: async (addresses, from, to, topics) => {
        state.logQueries.push({ addresses, from, to, topics });
        return state.rows.filter(row => (Array.isArray(addresses) ? addresses : [addresses]).includes(row.address)
          && Number(BigInt(row.blockNumber)) >= from && Number(BigInt(row.blockNumber)) <= to);
      },
      call: async (address, data, block) => {
        expect(address).toBe(a(20)); expect(block).toBe(h(state.height));
        const name = pointer.parseTransaction({ data }).name; state.calls.push(name);
        return pointer.encodeFunctionResult(name, name === 'current'
          ? [state.revision, state.currentManifest, state.currentComponents, state.currentHashes]
          : [{ revision: state.revision, authority: a(21), retired: state.retired }[name]]);
      },
    } };
  checks.plan.mockImplementation(async (actual, checked) => {
    expect(actual).toEqual(plan); expect(await checked.port.finalizedBlock()).toEqual(plan.checkpoint);
  });
  checks.successor.mockResolvedValue({ components, hashes }); checks.interval.mockResolvedValue(undefined);
  return { state, plan, inputs, log, publish, manifest };
}
test('authenticates original plan and publication parent; wrapped sponsorship needs no false direct-call inference', async () => {
  const f = fixture(), result = await inspectPublicationOutcome(f.plan, f.inputs);
  expect(result).toMatchObject({ status: 'achieved', stage: 'publish', revision: '1',
    publication: { block: { number: 112, hash: h(112) }, logIndex: 5 } });
  expect(checks.plan).toHaveBeenCalledOnce(); expect(checks.successor).toHaveBeenCalledOnce();
  expect(checks.successor.mock.calls[0][0].block).toEqual({ number: 111, hash: h(111) });
  expect(checks.interval.mock.calls[0][0].current).toEqual({ number: 111, hash: h(111) });
  expect(result).not.toHaveProperty('authorityRoot'); expect(result).not.toHaveProperty('gasClosed');
});
test('pending publication reconciles current state while retirement may already be achieved', async () => {
  const f = fixture(); f.state.rows = []; f.state.revision = 0n;
  expect((await inspectPublicationOutcome(f.plan, f.inputs)).status).toBe('pending');
  expect(checks.successor.mock.calls[0][0].block.number).toBe(115);
  f.plan.stage = 'retire'; expect((await inspectPublicationOutcome(f.plan, f.inputs)).status).toBe('achieved');
  f.state.retired = false; expect((await inspectPublicationOutcome(f.plan, f.inputs)).status).toBe('pending');
});
test.each(['pending', 'parent', 'publication-block', 'later'])('retained plan checks absent legacy code at %s boundary', async mode => {
  const f = fixture(), base = f.inputs.port.code;
  f.plan.absentLegacyTokens = [a(90)];
  if (mode === 'pending') { f.state.rows = []; f.state.revision = 0n; }
  const changed = mode === 'parent' ? h(111) : mode === 'publication-block' ? h(112) : h(115);
  f.inputs.port.code = async (address, block) => address === a(90) ? (block === changed ? '0x6000' : '0x') : base(address, block);
  if (mode === 'later') expect((await inspectPublicationOutcome(f.plan, f.inputs)).status).toBe('achieved');
  else await expect(inspectPublicationOutcome(f.plan, f.inputs)).rejects.toThrow('publication_outcome_absent_legacy_changed');
});
test('checksum predecessor spelling preserves allowed old-token interval transfers', async () => {
  const f = fixture();
  f.inputs.successor.predecessor = '0x8811441914381143b9408c5C32247367F86F173A';
  f.state.rows.push(f.log(token, 'Transfer', [a(4), a(5), 100], f.inputs.successor.predecessor.toLowerCase(), 112, 4));
  expect((await inspectPublicationOutcome(f.plan, f.inputs)).status).toBe('achieved');
  f.state.rows[1] = f.log(token, 'Transfer', [ZeroAddress, a(5), 100], f.inputs.successor.predecessor.toLowerCase(), 112, 4);
  await expect(inspectPublicationOutcome(f.plan, f.inputs)).rejects.toThrow('publication_outcome_prepublication_activity');
});
test('retirement exact inventory and runtime are required, including before publication', async () => {
  const f = fixture(); f.plan.stage = 'retire';
  f.state.rows.unshift(f.log(pointer, 'LegacyContractRetired', [a(1), f.plan.hashes[0]], a(20), 111, 1));
  expect((await inspectPublicationOutcome(f.plan, f.inputs)).status).toBe('achieved');
  f.state.rows[0] = f.log(pointer, 'LegacyContractRetired', [a(99), f.plan.hashes[0]], a(20), 111, 1);
  await expect(inspectPublicationOutcome(f.plan, f.inputs)).rejects.toThrow(/retirement_changed/);
});
test.each(['before-same-tx', 'before-earlier-tx', 'previous-block', 'unpublished'])('%s rejects state changes before publication', async mode => {
  const f = fixture(), height = mode === 'previous-block' ? 111 : 112;
  if (mode === 'unpublished') { f.state.rows = []; f.state.revision = 0n; }
  f.state.rows.push(f.log(kernel, 'AdministrativeHoldResumed', [a(3)], a(30), height, 4, mode === 'before-earlier-tx' ? 1 : 2));
  await expect(inspectPublicationOutcome(f.plan, f.inputs)).rejects.toThrow(/prepublication_activity/);
});
test('activity after exact publication log, including in its own transaction, is allowed', async () => {
  const f = fixture();
  f.state.rows.push(f.log(kernel, 'AdministrativeHoldResumed', [a(3)], a(30), 112, 6));
  f.state.rows.push(f.log(token, 'Transfer', [a(3), a(33), 100], a(80), 112, 7));
  expect((await inspectPublicationOutcome(f.plan, f.inputs)).status).toBe('achieved');
});
test.each(['new', 'legacy'])('%s ordinary token transfers/approvals remain legal but minting is refused', async kind => {
  const f = fixture(), address = kind === 'new' ? a(30) : a(1);
  f.state.rows.push(f.log(kernel, 'Transfer', [a(4), a(5), 100], address, 112, 4));
  expect((await inspectPublicationOutcome(f.plan, f.inputs)).status).toBe('achieved');
  f.state.rows[1] = f.log(kernel, 'Transfer', [ZeroAddress, a(5), 100], address, 112, 4);
  await expect(inspectPublicationOutcome(f.plan, f.inputs)).rejects.toThrow(/prepublication_activity/);
});
test.each([a(33), a(10)])('incoming USDC custody at %s before publication refuses', async recipient => {
  const f = fixture(); f.state.rows.push(f.log(token, 'Transfer', [a(3), recipient, 1], a(80), 112, 4));
  await expect(inspectPublicationOutcome(f.plan, f.inputs)).rejects.toThrow(/prepublication_usdc_custody/);
});
test('institution activity is refused before publication even without a token movement', async () => {
  const f = fixture(); f.state.rows.push(f.log(kernel, 'Approval', [a(3), a(4), 1], a(32), 112, 4));
  await expect(inspectPublicationOutcome(f.plan, f.inputs)).rejects.toThrow(/prepublication_activity/);
});
test('a later revision is superseded, never hidden by returning to the original manifest', async () => {
  const f = fixture(); f.state.rows.push(f.publish(2, f.plan.components, 113)); f.state.revision = 2n;
  f.state.currentManifest = f.manifest(2);
  expect((await inspectPublicationOutcome(f.plan, f.inputs)).status).toBe('superseded');
  f.state.rows.pop(); await expect(inspectPublicationOutcome(f.plan, f.inputs)).rejects.toThrow(/revision_history/);
});
test.each(['plan', 'parent', 'source', 'components', 'first-manifest', 'current-manifest', 'pointer-runtime', 'retirement-runtime', 'retirement-missing', 'missing-event', 'removed', 'duplicate', 'log-domain'])('%s red control refuses', async mode => {
  const f = fixture();
  if (mode === 'plan') checks.plan.mockRejectedValue(Error('independent_plan_changed'));
  if (mode === 'parent') checks.successor.mockRejectedValue(Error('activation_or_import_incomplete'));
  if (mode === 'source') checks.interval.mockRejectedValue(Error('source_reactivated'));
  if (mode === 'components') checks.successor.mockResolvedValue({ components: [], hashes: [] });
  if (mode === 'first-manifest') f.state.rows = [f.publish(1, [...f.plan.components.slice(0, 9), a(99)])];
  if (mode === 'current-manifest') f.state.currentManifest = h(99);
  if (mode === 'pointer-runtime') f.state.code = '0x6003';
  if (mode === 'retirement-runtime') { const old = f.inputs.port.code; f.inputs.port.code = async address => address === a(1) ? '0x6004' : old(address); }
  if (mode === 'retirement-missing') f.state.retired = false;
  if (mode === 'missing-event') f.state.rows = [];
  if (mode === 'removed') f.state.rows[0].removed = true;
  if (mode === 'duplicate') f.state.rows.push(f.state.rows[0]);
  if (mode === 'log-domain') f.state.rows[0].transactionIndex = '-1';
  await expect(inspectPublicationOutcome(f.plan, f.inputs)).rejects.toThrow();
});
test.each([110, 111, 112, 115])('rechecks canonical checkpoint %s after all asynchronous reads', async height => {
  const f = fixture(), base = f.inputs.port.call;
  f.inputs.port.call = async (...args) => {
    const result = await base(...args);
    if (pointer.parseTransaction({ data: args[1] }).name === 'retired') f.state.changed.set(height, h(999));
    return result;
  };
  await expect(inspectPublicationOutcome(f.plan, f.inputs)).rejects.toThrow(/reorg/);
});
test('input objects cannot be replaced during the first asynchronous read', async () => {
  const f = fixture(), base = f.inputs.port.finalizedBlock;
  f.inputs.port.finalizedBlock = async () => { f.inputs.successor.predecessor = a(99); return base(); };
  const result = await inspectPublicationOutcome(f.plan, f.inputs);
  expect(result.status).toBe('achieved'); expect(checks.successor.mock.calls[0][0].plan.predecessor).toBe(a(1));
});
test('publication parent cannot overwrite the retained original checkpoint during a reorg', async () => {
  const f = fixture(); f.state.rows = [f.publish(1, f.plan.components, 111)];
  checks.plan.mockImplementation(async () => { f.state.changed.set(110, h(999)); });
  await expect(inspectPublicationOutcome(f.plan, f.inputs)).rejects.toThrow(/reorg/);
});
