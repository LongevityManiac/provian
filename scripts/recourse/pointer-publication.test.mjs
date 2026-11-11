import { test, expect, vi, beforeEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { Interface, keccak256, sha256, toUtf8Bytes } from 'ethers';
import { preparePointerPublication, verifyPointerPublication } from './pointer-publication.mjs';
const checks = vi.hoisted(() => ({ successor: vi.fn(), interval: vi.fn(), reconstruct: vi.fn() }));
vi.mock('./successor-verification.mjs', () => ({ verifySuccessorPlan: checks.successor }));
vi.mock('./successor-preflight.mjs', () => ({ verifySuccessorSourceInterval: checks.interval, reconstructSuccessorPlan: checks.reconstruct }));
const a = n => `0x${n.toString(16).padStart(40, '0')}`, h = n => `0x${n.toString(16).padStart(64, '0')}`;
const abi = new Interface(['function authority() view returns(address)', 'function revision() view returns(uint256)', 'function retired(address) view returns(bool)',
  'function registerLegacyRetirements(address[],bytes32[])', 'function publish(uint256,address[10],bytes32[10])',
  'function keyCommitment() view returns(bytes32)', 'function nonce() view returns(uint256)']);
beforeEach(() => { checks.successor.mockReset(); checks.interval.mockReset(); checks.reconstruct.mockReset(); });
function fixture() {
  const pointer = a(20), authority = a(21), pointerCode = '0x6001', authorityCode = '0x6002';
  const components = Array.from({ length: 10 }, (_, i) => a(30 + i)), hashes = components.map(() => keccak256('0x6003'));
  const successor = { pointer, pointerAuthority: authority, predecessor: a(1), admin: a(2), cutoff: { number: 100, hash: h(100) },
    snapshot: { state: { eligibilityVerifier: { verifier: a(3) } } }, retireAfterImport: [a(4)], components, digest: h(5) };
  const deployment = { wiring: { pvt: a(1), admin: a(2) }, contracts: Object.fromEntries(['escrowV4', 'promiseV3', 'poolV3', 'bondPool', 'courtV2'].map((key, i) => [key, { address: a(10 + i) }])) };
  const state = { retired: false, held: true, changed: false, nonce: 0n, root: h(6), height: 110 };
  const artifacts = { ProvianHashAccount: { deployedBytecode: { object: authorityCode } } }, institutions = { digest: h(7) }, rule = { ruleHash: h(8) };
  checks.successor.mockImplementation(async input => {
    if (!state.held) throw Error('successor_verify_activation_state');
    expect(input.plan).toEqual(successor); return { components, hashes };
  });
  checks.interval.mockResolvedValue(undefined);
  checks.reconstruct.mockImplementation(async input => {
    expect(input.pointerPlan).toEqual({ fixture: 'independent-pointer-plan' });
    expect(input.operators).toEqual({ fixture: 'independent-operators' });
    return { plan: successor, institutions, verifiedAt: { number: 100, hash: h(100) } };
  });
  const port = { finalizedBlock: async () => ({ number: state.height, hash: h(state.height) }), blockHash: async n => state.changed ? h(99) : h(n),
    code: async target => target === pointer ? pointerCode : target === authority ? authorityCode : '0x6003',
    call: async (target, data, pin) => {
      expect(pin).toBe(h(state.height)); const name = abi.parseTransaction({ data }).name;
      expect([pointer, authority]).toContain(target);
      return abi.encodeFunctionResult(name, [{ authority, revision: 0, retired: state.retired, keyCommitment: state.root, nonce: state.nonce }[name]]);
    } };
  return { stage: 'retire', successor, deployment, artifacts, institutions, rule, legacyTokens: [a(50), a(51)],
    pointerPlan: { fixture: 'independent-pointer-plan' }, operators: { fixture: 'independent-operators' },
    pin: { chainId: 8453, address: pointer, runtimeHash: keccak256(pointerCode) }, port, callGas: '2000000', state, components, hashes };
}
test('retirement derives a nonempty exact inventory and unsigned hash-authority call after full reconciliation', async () => {
  const f = fixture(), plan = await preparePointerPublication(f);
  expect(plan.complete).toBe(false); expect(plan.targets).toHaveLength(10);
  const parsed = abi.parseTransaction({ data: plan.hashAuthorityPlan.data });
  expect(parsed.name).toBe('registerLegacyRetirements'); expect([...parsed.args[0]].map(address => address.toLowerCase())).toEqual(plan.targets);
  expect(plan.hashAuthorityPlan).toMatchObject({ account: f.successor.pointerAuthority, target: f.pin.address, currentRoot: h(6), nonce: '0', value: '0', callGas: '2000000' });
  expect(checks.reconstruct).toHaveBeenCalledOnce(); expect(checks.successor).toHaveBeenCalledOnce(); expect(checks.interval).toHaveBeenCalledOnce();
});
test('publication requires all retirement markers and fixes the complete reconciled component set', async () => {
  const f = fixture();
  await expect(preparePointerPublication({ ...f, stage: 'publish' })).rejects.toThrow(/retirement_incomplete/);
  f.state.retired = true; f.state.nonce = 1n;
  const plan = await preparePointerPublication({ ...f, stage: 'publish' }), parsed = abi.parseTransaction({ data: plan.hashAuthorityPlan.data });
  expect(parsed.name).toBe('publish'); expect(parsed.args[0]).toBe(0n);
  expect([...parsed.args[1]].map(address => address.toLowerCase())).toEqual(f.components); expect([...parsed.args[2]]).toEqual(f.hashes);
  expect(plan.hashAuthorityPlan.nonce).toBe('1');
});
test('already registered legacy inventory needs no new authority operation', async () => {
  const f = fixture(); f.state.retired = true;
  expect((await preparePointerPublication(f)).complete).toBe(true);
});
test.each(['pin', 'runtime', 'authority-runtime', 'empty-legacy', 'current-retirement', 'missing-code', 'nonce-root', 'reorg', 'activation', 'source-activity'])('%s refuses unsigned preparation', async mode => {
  const f = fixture();
  if (mode === 'pin') f.pin.address = a(99);
  if (mode === 'runtime' || mode === 'authority-runtime' || mode === 'missing-code') {
    const base = f.port.code, target = mode === 'runtime' ? f.pin.address : mode === 'authority-runtime' ? f.successor.pointerAuthority : a(50);
    f.port.code = async address => address === target ? '0x' : base(address);
  }
  if (mode === 'empty-legacy') f.legacyTokens = [];
  if (mode === 'current-retirement') f.legacyTokens = [f.components[0]];
  if (mode === 'nonce-root') f.state.root = h(0);
  if (mode === 'reorg') f.state.changed = true;
  if (mode === 'activation') f.state.held = false;
  if (mode === 'source-activity') checks.interval.mockRejectedValue(Error('source_activity_after_cutoff'));
  await expect(preparePointerPublication(f)).rejects.toThrow();
});
test('fresh reconstruction tolerates only a newer canonical checkpoint, not authority or call drift', async () => {
  const f = fixture(), plan = await preparePointerPublication(f); f.state.height = 111;
  expect((await verifyPointerPublication(plan, f)).checkpoint.number).toBe(111);
  f.state.nonce = 1n; await expect(verifyPointerPublication(plan, f)).rejects.toThrow(/facts_changed/);
});
test('rehashing edited target calldata cannot replace independently reconstructed publication facts', async () => {
  const f = fixture(), plan = await preparePointerPublication(f);
  const changed = structuredClone(plan); changed.hashAuthorityPlan.target = a(99); delete changed.digest;
  changed.digest = sha256(toUtf8Bytes(JSON.stringify(changed)));
  await expect(verifyPointerPublication(changed, f)).rejects.toThrow(/facts_changed/);
});

test('independent reconstruction rejects rehashed component and retirement substitutions before reconciliation', async () => {
  const f = fixture();
  checks.reconstruct.mockRejectedValue(Error('successor_preflight_plan_changed'));
  await expect(preparePointerPublication(f)).rejects.toThrow(/plan_changed/);
  expect(checks.successor).not.toHaveBeenCalled(); expect(checks.interval).not.toHaveBeenCalled();
});
test('supplied institution file cannot replace freshly reconstructed cutoff inventory', async () => {
  const f = fixture();
  await expect(preparePointerPublication({ ...f, institutions: { digest: h(99) } })).rejects.toThrow(/institution_inventory_changed/);
});
test('actual unsigned CLI help needs no provider and execution flags are refused', () => {
  const cli = new URL('./pointer-publication-cli.mjs', import.meta.url).pathname;
  const env = { ...process.env, BASE_RPC_URL: 'not-a-provider', BASE_RPC_URL_SECONDARY: 'not-a-provider' };
  expect(execFileSync(process.execPath, [cli, '--help'], { env, encoding: 'utf8' })).toContain('Read-only unsigned preparation');
  for (const args of [['prepare', '/missing-input', '--execute'], ['inspect', '/missing-input', '--execute']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
    expect(result.status).toBe(1); expect(result.stderr.trim()).toBe('pointer_publication_cli_usage');
  }
});
