import { test, expect, vi, beforeAll } from 'vitest';
import { keccak256 } from 'ethers';
import { HASH_ACCOUNT_ABI, hashAccountIntentDigest } from '../../provian-agent-sdk/dist/hash-account.js';
import { recoverySigningRoot } from '../../provian-agent-sdk/dist/recourse-hash-authorization.js';
import { prepareDurableHashAuthority } from './hash-authority-durable.mjs';
import { prepareDurableHashCancellation, hashAuthorityCancellationPlan } from './hash-authority-cancellation.mjs';
// Real stateless hash signatures are deliberately exercised, not mocked.
vi.setConfig({ testTimeout: 30000 });
const a = n => '0x' + n.toString(16).padStart(40, '0'), h = n => '0x' + n.toString(16).padStart(64, '0');
const code = '0x60006000', runtime = keccak256(code), seed = new Uint8Array(32).fill(7);
let initialRoot;
beforeAll(async () => { initialRoot = await recoverySigningRoot(seed); });
async function fixture() {
  const plan = { schema: 'provian.hash-authority-plan.v1', account: a(1), target: a(2), nonce: '0', currentRoot: initialRoot,
    targetRuntimeHash: runtime, value: '0', callGas: '2000000', data: '0x1234' };
  const seeds = new Map([['initial', { schema: 'provian.hash-authority.v1', root: initialRoot,
    seed: Buffer.from(seed).toString('hex'), parent: null, intent: null }]]);
  const vault = { create: vi.fn(async record => { const id = String(seeds.size); seeds.set(id, structuredClone(record)); return id; }),
    read: vi.fn(async id => ({ id, record: structuredClone(seeds.get(id)) })),
    byRoot: vi.fn(async root => { const [id, record] = [...seeds].find(([, r]) => r.root === root); return { id, record: structuredClone(record) }; }) };
  const rows = new Map(), state = { orphan: false, consumed: false };
  const store = { read: vi.fn(async key => structuredClone(rows.get(key) ?? null)),
    create: vi.fn(async (key, record) => { if (rows.has(key)) throw Error('exists'); rows.set(key, structuredClone(record)); }) };
  const port = { finalizedBlock: async () => ({ number: 100, hash: h(100) }), code: async () => code,
    blockHash: async () => state.orphan ? h(99) : h(100),
    call: vi.fn(async (to, data) => {
      const parsed = HASH_ACCOUNT_ABI.parseTransaction({ data }); expect(parsed.name).not.toBe('execute');
      let value = parsed.name === 'nonce' ? state.consumed ? 1n : 0n : initialRoot;
      if (parsed.name === 'intentDigest') value = hashAccountIntentDigest({ chainId: '8453', account: to, nonce: '0',
        target: String(parsed.args[0]).toLowerCase(), value: String(parsed.args[1]), callGas: String(parsed.args[2]),
        data: parsed.args[3], nextCommitment: parsed.args[4] });
      return HASH_ACCOUNT_ABI.encodeFunctionResult(parsed.name, [value]);
    }) };
  const f = { plan, port, vault, store, accountRuntimeHash: runtime, rows, seeds, state };
  return { ...f, original: await prepareDurableHashAuthority(f) };
}

test('cancellation retains original bytes and uses the same saved successor without another vault item', async () => {
  const f = await fixture(), original = structuredClone(f.original), before = [...f.rows.values()];
  f.vault.create.mockClear();
  const cancelled = await prepareDurableHashCancellation(f);
  expect(f.vault.create).not.toHaveBeenCalled(); expect(f.seeds.size).toBe(2); expect(f.rows.size).toBe(2);
  expect([...f.rows.values()][0]).toEqual(before[0]); expect(f.original).toEqual(original);
  expect(cancelled.nextItemId).toBe(original.nextItemId);
  expect(cancelled.operation).toMatchObject({ account: f.plan.account, target: f.plan.account, nonce: '0', value: '0',
    data: '0x', callGas: '100000', signingRoot: original.operation.signingRoot, nextCommitment: original.operation.nextCommitment });
  expect(cancelled.intentDigest).not.toBe(original.intentDigest);
  expect(JSON.stringify(cancelled)).not.toContain(f.seeds.get(original.nextItemId).seed);
});

test('saved cancellation restarts after either operation may have consumed the nonce without touching seeds', async () => {
  const f = await fixture(), saved = await prepareDurableHashCancellation(f); f.state.consumed = true;
  f.vault.read.mockClear(); f.vault.byRoot.mockClear(); f.port.call.mockClear();
  expect(await prepareDurableHashCancellation(f)).toEqual(saved);
  expect(f.vault.read).not.toHaveBeenCalled(); expect(f.vault.byRoot).not.toHaveBeenCalled(); expect(f.port.call).not.toHaveBeenCalled();
  f.state.orphan = true; await expect(prepareDurableHashCancellation(f)).rejects.toThrow('checkpoint_changed');
});

test('an undurable original or already consumed authority cannot create a cancellation', async () => {
  const f = await fixture(); f.state.consumed = true;
  await expect(prepareDurableHashCancellation(f)).rejects.toThrow('state_changed');
  f.state.consumed = false; f.rows.clear(); f.vault.read.mockClear();
  await expect(prepareDurableHashCancellation(f)).rejects.toThrow('original_not_durable'); expect(f.vault.read).not.toHaveBeenCalled();
});

test.each(['root', 'parent', 'digest', 'seed'])('changed saved successor %s refuses before cancellation signing', async field => {
  const f = await fixture(), next = f.seeds.get(f.original.nextItemId);
  next[field] = field === 'parent' ? { root: h(9), itemId: 'other' } : field === 'seed' ? '09'.repeat(32) : h(9);
  await expect(prepareDurableHashCancellation(f)).rejects.toThrow('cancellation_lineage'); expect(f.rows.size).toBe(1);
});

test('lost cancellation write response recovers the immutable winner; missing readback returns no proof', async () => {
  const f = await fixture(), create = f.store.create;
  f.store.create = async (slot, value) => { await create(slot, value); throw Error('reply_lost'); };
  const saved = await prepareDurableHashCancellation(f); expect(f.rows.size).toBe(2);
  expect(saved.operation.nextCommitment).toBe(f.original.operation.nextCommitment);
  f.rows.delete([...f.rows.keys()][1]); f.store.create = async () => {};
  await expect(prepareDurableHashCancellation(f)).rejects.toThrow('write_unconfirmed');
});

test('changed stored cancellation or a reorg during persistence never returns executable proof', async () => {
  const f = await fixture(); await prepareDurableHashCancellation(f);
  const slot = [...f.rows.keys()][1], row = f.rows.get(slot); row.nextItemId = 'wrong';
  await expect(prepareDurableHashCancellation(f)).rejects.toThrow('successor_changed');
  f.rows.delete(slot); const create = f.store.create;
  f.store.create = async (slot, value) => { await create(slot, value); f.state.orphan = true; };
  await expect(prepareDurableHashCancellation(f)).rejects.toThrow('checkpoint_changed');
});

test('fixed cancellation plan cannot inherit original target, funds, data or gas', () => {
  const plan = { account: a(1), target: a(2), value: '9', nonce: '7', currentRoot: h(3), data: '0xabcd', callGas: '1', targetRuntimeHash: h(4) };
  expect(hashAuthorityCancellationPlan(plan, runtime)).toEqual({ ...plan, target: a(1), value: '0', data: '0x', callGas: '100000', targetRuntimeHash: runtime });
});

test('malformed successor decode wipes the already allocated current seed', async () => {
  const { prepareVaultHashCancellation } = await import('./hash-authority-vault.mjs');
  const wiped = [], originalFill = Uint8Array.prototype.fill;
  const spy = vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function(value, ...rest) {
    if (value === 0 && this.length === 32) wiped.push(Array.from(this));
    return originalFill.call(this, value, ...rest);
  });
  try {
    await expect(prepareVaultHashCancellation({
      byRoot: async () => ({ id: 'old', record: { schema: 'provian.hash-authority.v1', root: h(1), seed: '11'.repeat(32) } }),
      read: async () => ({ id: 'next', record: { seed: 'bad' } }),
    }, { currentRoot: h(1), nextItemId: 'next' }, async () => {})).rejects.toThrow('record_invalid');
    expect(wiped).toContainEqual(Array(32).fill(17));
  } finally { spy.mockRestore(); }
});

test('vault await cannot replace the requested cancellation intent', async () => {
  const { prepareVaultHashCancellation } = await import('./hash-authority-vault.mjs');
  let resume;
  const pause = new Promise(resolve => { resume = resolve; });
  const input = { currentRoot: h(1), nextCommitment: h(2), nextItemId: 'next', originalIntentDigest: h(3), intent: { data: '0x' } };
  const crypto = { root: async seed => seed[0] === 17 ? h(1) : h(2), prepare: vi.fn(async value => {
    await value.persistBeforeSigning({ ...value.intent, nextCommitment: h(2) }, value.nextSigningSeed);
    return value.intent;
  }) };
  const pending = prepareVaultHashCancellation({
    byRoot: async () => { await pause; return { id: 'old', record: { schema: 'provian.hash-authority.v1', root: h(1), seed: '11'.repeat(32) } }; },
    read: async id => ({ id, record: { schema: 'provian.hash-authority.v1', root: h(2), seed: '22'.repeat(32), parent: { root: h(1), itemId: 'old' }, digest: h(3) } }),
  }, input, async intent => { expect(intent.data).toBe('0x'); }, crypto);
  input.intent.data = '0x1234'; resume();
  expect((await pending).operation.data).toBe('0x');
});
