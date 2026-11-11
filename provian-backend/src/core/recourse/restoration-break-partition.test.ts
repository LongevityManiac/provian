import { reconstructBreakPartition, type BreakPartitionPort } from './restoration-break-partition';
import type { VerifiedBreakArtifact } from './break-artifact';
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
function fixture() {
  const owner = (amount: string) => ({ identity: h(1), amount, commitment: h(9), proof: [] });
  const artifacts = new Map<string, VerifiedBreakArtifact>([
    [a(20), { domain: { predecessor: a(10), block: 100, root: h(1000) }, owners: [owner('80')] }],
    [a(21), { domain: { predecessor: a(11), block: 200, root: h(2000) }, owners: [owner('90')] }],
  ]);
  let restored = false, changed = false, reorg = false, manifests = 0;
  const port: BreakPartitionPort = {
    async manifest() { manifests++; if (manifests > 1 && changed) return h(888); return h(777); },
    async artifact(origin) { const value = artifacts.get(origin); if (!value) throw Error('missing_artifact'); return value; },
    async blockHash(block) { return h(reorg && manifests > 1 ? 999 : block); },
    async registryAccounts(registry) { return registry === a(40) ? [a(1)] : [a(2)]; },
    async call(target, method, args, pin) {
      const previous = pin === h(100), kernel = previous ? a(10) : a(11);
      switch (method) {
        case 'registryOperator': return previous ? a(40) : a(41);
        case 'ownerAuthorization': return previous ? a(30) : a(31);
        case 'protocolPointer': case 'pointer': return a(50);
        case 'component': case 'kernel': return kernel;
        case 'breakOrigin': return previous ? a(0) : a(20);
        case 'restoredIdentity': return restored;
        case 'ownerOf': return args[0] === (previous ? a(1) : a(2)) ? h(1) : h(999);
        case 'boundBlock': return previous ? 90n : 190n;
        case 'balanceOf': return previous ? 80n : 10n;
        default: throw Error(`${target}:${method}`);
      }
    },
  };
  return { port, artifacts, setRestored() { restored = true; }, setChanged() { changed = true; }, setReorg() { reorg = true; } };
}
test('repeated breaks reconstruct cutoff balances plus unissued rights with their original components', async () => {
  const f = fixture(), result = await reconstructBreakPartition(a(21), h(1), f.port);
  expect(result).toMatchObject({ origin: a(21), predecessor: a(11), cutoff: 200, owner: { amount: '90' },
    accounts: [{ address: a(2), amountAtomic: '10' }], carried: {
      origin: a(20), predecessor: a(10), cutoff: 100, owner: { amount: '80' }, accounts: [{ address: a(1), amountAtomic: '80' }], carried: null } });
});
test('claimed state is read from the effective predecessor executor at cutoff, not the original origin today', async () => {
  const f = fixture(); f.setRestored();
  const current = f.artifacts.get(a(21))!;
  f.artifacts.set(a(21), { ...current, owners: [{ ...current.owners[0], amount: '10' }] });
  const calls: { target: string; method: string; pin: string }[] = [], read = f.port.call;
  const result = await reconstructBreakPartition(a(21), h(1), { ...f.port, async call(target, method, args, pin) {
    calls.push({ target, method, pin }); return read(target, method, args, pin);
  } });
  expect(result?.carried).toBeNull(); expect(result?.owner.amount).toBe('10');
  expect(calls.filter(call => call.method === 'restoredIdentity')).toEqual([{ target: a(31), method: 'restoredIdentity', pin: h(200) }]);
});
test('authenticated prior absence differs from a missing artifact', async () => {
  const f = fixture(), current = f.artifacts.get(a(21))!, prior = f.artifacts.get(a(20))!;
  f.artifacts.set(a(21), { ...current, owners: [{ ...current.owners[0], amount: '10' }] });
  f.artifacts.set(a(20), { ...prior, owners: [{ ...prior.owners[0], identity: h(2) }] });
  expect((await reconstructBreakPartition(a(21), h(1), f.port))?.carried).toBeNull();
  f.artifacts.delete(a(20));
  await expect(reconstructBreakPartition(a(21), h(1), f.port)).rejects.toThrow('missing_artifact');
});
test('omitted bindings, changed balances and substituted ownership refuse rather than becoming pool shortfalls', async () => {
  for (const method of ['balanceOf', 'ownerOf', 'boundBlock'] as const) {
    const f = fixture(), call = f.port.call;
    await expect(reconstructBreakPartition(a(21), h(1), { ...f.port, call: async (target, name, args, pin) =>
      name === method ? method === 'ownerOf' ? h(999) : method === 'boundBlock' ? 201n : 11n : call(target, name, args, pin) })).rejects.toThrow();
  }
  const f = fixture();
  await expect(reconstructBreakPartition(a(21), h(1), { ...f.port, registryAccounts: async () => [] })).rejects.toThrow();
  await expect(reconstructBreakPartition(a(21), h(1), { ...f.port, registryAccounts: async () => [a(2), a(2)] })).rejects.toThrow('account_duplicate');
  const current = f.artifacts.get(a(21))!;
  f.artifacts.set(a(21), { ...current, owners: current.owners.map(owner => ({ ...owner, identity: h(2) })) });
  await expect(reconstructBreakPartition(a(21), h(1), f.port)).rejects.toThrow('owner_omitted');
});
test('cycles, nondecreasing cutoffs and a changed unclaimed recovery commitment cannot carry', async () => {
  const cycle = fixture(), call = cycle.port.call;
  await expect(reconstructBreakPartition(a(21), h(1), { ...cycle.port, call: async (target, method, args, pin) =>
    method === 'breakOrigin' ? a(21) : call(target, method, args, pin) })).rejects.toThrow('cycle');
  const future = fixture(), prior = future.artifacts.get(a(20))!;
  future.artifacts.set(a(20), { ...prior, domain: { ...prior.domain, block: 200 } });
  await expect(reconstructBreakPartition(a(21), h(1), future.port)).rejects.toThrow('cutoff_invalid');
  const changed = fixture(), current = changed.artifacts.get(a(21))!;
  changed.artifacts.set(a(21), { ...current, owners: [{ ...current.owners[0], commitment: h(999) }] });
  await expect(reconstructBreakPartition(a(21), h(1), changed.port)).rejects.toThrow('total_mismatch');
});
test('pointer or cutoff reorgs invalidate reconstruction after all recursive reads', async () => {
  const f = fixture(); f.setChanged(); await expect(reconstructBreakPartition(a(21), h(1), f.port)).rejects.toThrow('protocol_changed');
  const g = fixture(); g.setReorg(); await expect(reconstructBreakPartition(a(21), h(1), g.port)).rejects.toThrow('reorg');
});
