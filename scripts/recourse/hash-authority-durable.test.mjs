import { test, expect, vi, beforeAll } from 'vitest';
import { keccak256, sha256 } from 'ethers';
import { HASH_ACCOUNT_ABI, hashAccountIntentDigest, hashAccountCall } from '../../provian-agent-sdk/dist/hash-account.js';
import { recoverySigningRoot } from '../../provian-agent-sdk/dist/recourse-hash-authorization.js';
import { prepareDurableHashAuthority, verifyDurableHashAuthority } from './hash-authority-durable.mjs';
// Every test derives and signs with real hash-based keys: about 2.5 s each alone, twice that for
// the tests that sign twice. The full suite runs files in parallel and can more than double that,
// so the 5 s default timed out under load. Same budget as hash-authority-cancellation.test.mjs.
vi.setConfig({ testTimeout: 30000 });
const a = n => '0x' + n.toString(16).padStart(40, '0'), h = n => '0x' + n.toString(16).padStart(64, '0');
const code = '0x60006000', runtime = keccak256(code), seed = new Uint8Array(32).fill(7);
let initialRoot;
beforeAll(async () => { initialRoot = await recoverySigningRoot(seed); });
function fixture() {
  const plan = { schema: 'provian.hash-authority-plan.v1', account: a(1), target: a(2), nonce: '0', currentRoot: initialRoot,
    targetRuntimeHash: runtime, value: '0', callGas: '2000000', data: '0x1234' };
  const seeds = new Map([['initial', { schema: 'provian.hash-authority.v1', root: initialRoot, seed: Buffer.from(seed).toString('hex'), parent: null, intent: null }]]);
  const vault = { create: vi.fn(async record => { const id = String(seeds.size); seeds.set(id, structuredClone(record)); return id; }),
    read: vi.fn(async id => ({ id, record: structuredClone(seeds.get(id)) })),
    byRoot: vi.fn(async root => { const [id, record] = [...seeds].find(([, r]) => r.root === root); return { id, record: structuredClone(record) }; }) };
  const rows = new Map(), state = { orphan: false };
  const store = { read: vi.fn(async key => structuredClone(rows.get(key) ?? null)),
    create: vi.fn(async (key, record) => { if (rows.has(key)) throw Error('exists'); rows.set(key, structuredClone(record)); }) };
  const port = { finalizedBlock: async () => ({ number: 100, hash: h(100) }), code: async () => code,
    blockHash: async () => state.orphan ? h(99) : h(100),
    call: vi.fn(async (to, data) => {
      const parsed = HASH_ACCOUNT_ABI.parseTransaction({ data });
      // Fails if any executable signature is ever sent to the provider.
      expect(parsed.name).not.toBe('execute');
      let value = parsed.name === 'nonce' ? 0n : initialRoot;
      if (parsed.name === 'intentDigest') value = hashAccountIntentDigest({ chainId: '8453', account: to, nonce: '0',
        target: String(parsed.args[0]).toLowerCase(), value: String(parsed.args[1]), callGas: String(parsed.args[2]),
        data: parsed.args[3], nextCommitment: parsed.args[4] });
      return HASH_ACCOUNT_ABI.encodeFunctionResult(parsed.name, [value]);
    }) };
  return { plan, port, vault, store, accountRuntimeHash: runtime, rows, seeds, state };
}
test('real signature is durably saved before returning and never exposed through RPC', async () => {
  const f = fixture(), record = await prepareDurableHashAuthority(f);
  expect(f.rows.size).toBe(1); expect(f.seeds.size).toBe(2); expect(f.store.read).toHaveBeenCalledTimes(2);
  expect(record.transaction.data).toBe(hashAccountCall(record.operation));
  expect(record.operation.signingRoot).toBe(initialRoot);
  expect(f.seeds.get(record.nextItemId).root).toBe(record.operation.nextCommitment);
  expect(JSON.stringify(record)).not.toContain(f.seeds.get(record.nextItemId).seed);
  expect(await verifyDurableHashAuthority(record, f.plan, runtime)).toEqual(record);
});
test('a saved proof restarts without reading a seed or requiring the old current authority state', async () => {
  const f = fixture(), record = await prepareDurableHashAuthority(f);
  f.vault.byRoot.mockClear(); f.port.call.mockClear();
  expect(await prepareDurableHashAuthority(f)).toEqual(record);
  expect(f.vault.byRoot).not.toHaveBeenCalled(); expect(f.port.call).not.toHaveBeenCalled();
  f.state.orphan = true; await expect(prepareDurableHashAuthority(f)).rejects.toThrow(/checkpoint_changed/);
});
test('different plans at the same authority nonce cannot expose competing successors', async () => {
  const f = fixture(); await prepareDurableHashAuthority(f); f.vault.byRoot.mockClear();
  await expect(prepareDurableHashAuthority({ ...f, plan: { ...f.plan, data: '0xabcd' } })).rejects.toThrow(/record_binding/);
  expect(f.vault.byRoot).not.toHaveBeenCalled(); expect(f.rows.size).toBe(1);
});
test('lost creation response reuses the complete authenticated atomic winner', async () => {
  const f = fixture(), create = f.store.create.getMockImplementation();
  f.store.create.mockImplementation(async (key, record) => { await create(key, record); throw Error('response_lost'); });
  const record = await prepareDurableHashAuthority(f);
  expect(record).toEqual([...f.rows.values()][0]);
});
test('failed write or missing readback returns no executable proof', async () => {
  const f = fixture(); f.store.create.mockRejectedValue(Error('write_failed'));
  await expect(prepareDurableHashAuthority(f)).rejects.toThrow(/write_failed/);
  expect(f.rows.size).toBe(0); expect(f.seeds.size).toBe(2);
  const g = fixture(); g.store.create.mockResolvedValue(undefined);
  await expect(prepareDurableHashAuthority(g)).rejects.toThrow(/write_unconfirmed/);
}, 20000);
test('altered signature, successor root or transaction cannot be accepted from storage', async () => {
  const f = fixture(), record = await prepareDurableHashAuthority(f);
  for (const mode of ['signature', 'successor', 'transaction']) {
    const changed = structuredClone(record);
    if (mode === 'signature') changed.operation.signature = '0x' + '00'.repeat(7856);
    if (mode === 'successor') changed.operation.nextCommitment = h(99);
    if (mode === 'transaction') changed.transaction.to = a(99);
    else { changed.intentDigest = hashAccountIntentDigest(changed.operation); changed.transaction.data = hashAccountCall(changed.operation); }
    await expect(verifyDurableHashAuthority(changed, f.plan, runtime)).rejects.toThrow(/signature_invalid|transaction_changed/);
  }
});
test('wrong code refuses before vault reads and an orphan checkpoint refuses before durable publication', async () => {
  const f = fixture(); f.port.code = async () => '0x';
  await expect(prepareDurableHashAuthority(f)).rejects.toThrow(/code_mismatch/); expect(f.vault.byRoot).not.toHaveBeenCalled();
  const g = fixture(); g.state.orphan = true;
  await expect(prepareDurableHashAuthority(g)).rejects.toThrow(/checkpoint_changed/); expect(g.store.create).not.toHaveBeenCalled();
});
test('concurrent different plans expose only the atomic winner for the authority nonce', async () => {
  const f = fixture(), read = f.store.read.getMockImplementation(); let firstReads = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  f.store.read.mockImplementation(async key => {
    if (++firstReads <= 2) { if (firstReads === 2) release(); await barrier; return null; }
    return read(key);
  });
  const results = await Promise.allSettled([prepareDurableHashAuthority(f), prepareDurableHashAuthority({ ...f, plan: { ...f.plan, data: '0xabcd' } })]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  expect(f.rows.size).toBe(1); expect(f.seeds.size).toBe(3);
  const winner = results.find(result => result.status === 'fulfilled').value;
  expect(winner).toEqual([...f.rows.values()][0]);
}, 20000);
test('a checkpoint orphaned while saving cannot return a signature', async () => {
  const f = fixture(), create = f.store.create.getMockImplementation();
  f.store.create.mockImplementation(async (key, record) => { await create(key, record); f.state.orphan = true; });
  await expect(prepareDurableHashAuthority(f)).rejects.toThrow(/checkpoint_changed/);
  expect(f.rows.size).toBe(1); // Retain the unpublished operation for explicit reconciliation.
});
test('caller mutation during verification cannot replace the verified transaction or plan', async () => {
  const f = fixture(), record = await prepareDurableHashAuthority(f), expected = structuredClone(record);
  const checking = verifyDurableHashAuthority(record, f.plan, runtime);
  record.transaction.to = a(99); f.plan.data = '0xabcd';
  expect(await checking).toEqual(expected);
}, 20000);
test('a storage adapter cannot mutate the private expected record during creation', async () => {
  const f = fixture(), create = f.store.create.getMockImplementation();
  f.store.create.mockImplementation(async (key, record) => {
    record.nextItemId = 'unverified-vault-reference'; await create(key, record);
  });
  await expect(prepareDurableHashAuthority(f)).rejects.toThrow(/write_unconfirmed/);
});
