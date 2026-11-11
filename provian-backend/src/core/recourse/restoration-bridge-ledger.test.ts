import { applyRestorationBalanceBridge as apply, restorationBalanceKey as key,
  type RestorationBalanceRef, type RestorationBridgeLedger, type RestorationComponents } from './restoration-bridge-ledger';
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const account = (kernel: number, address = 1): RestorationBalanceRef => ({ kind: 'account', kernel: a(kernel), address: a(address) });
const entitlement = (origin: number, identity = 1): RestorationBalanceRef => ({ kind: 'entitlement', origin: a(origin), identity: h(identity) });
const parts = (balance: bigint, reversible = 0n, protectedValue = 0n): RestorationComponents => ({ balance, reversible, protected: protectedValue });
function expectComponents(actual: RestorationComponents | undefined, expected: RestorationComponents): void {
  // Jest's JSON reporter cannot serialize BigInt matcher results on a failure.
  // Compare the exact values as decimal strings so RED controls remain reportable.
  const display = (value: RestorationComponents | undefined) => JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString() : item);
  expect(display(actual)).toBe(display(expected));
}
const ledger = (...entries: readonly [RestorationBalanceRef, RestorationComponents][]): RestorationBridgeLedger =>
  ({ balances: new Map(entries.map(([ref, value]) => [key(ref), value])), consumed: new Set() });
test('same address on separate kernels stays separate; restoration adds to unrelated current issuance', () => {
  const old = account(10), current = account(11), pending = entitlement(20);
  const initial = ledger([old, parts(100n, 30n, 50n)], [current, parts(9n)]);
  const cut = apply(initial, { kind: 'snapshot', kernel: a(10), origin: a(20), sources: [{ ref: old, amount: 100n }], destination: pending });
  expectComponents(cut.balances.get(key(old)), parts(0n));
  expectComponents(cut.balances.get(key(current)), parts(9n));
  expectComponents(cut.balances.get(key(pending)), parts(100n, 30n, 50n));
  const restored = apply(cut, { kind: 'restoration', kernel: a(11), origin: a(20), sources: [{ ref: pending, amount: 100n }], destination: current });
  expectComponents(restored.balances.get(key(current)), parts(109n, 30n, 50n));
  expectComponents(restored.balances.get(key(pending)), parts(0n));
  expectComponents(initial.balances.get(key(old)), parts(100n, 30n, 50n));
  expect(initial.consumed.size).toBe(0);
});
test('two unclaimed breaks carry protected and reversible components without creating spendable balances', () => {
  const old = account(10), next = account(11), first = entitlement(20), second = entitlement(21), final = account(12, 2);
  const one = apply(ledger([old, parts(80n, 20n, 50n)], [next, parts(10n)]), {
    kind: 'snapshot', kernel: a(10), origin: a(20), sources: [{ ref: old, amount: 80n }], destination: first });
  const two = apply(one, { kind: 'snapshot', kernel: a(11), origin: a(21), sources: [
    { ref: next, amount: 10n }, { ref: first, amount: 80n }], destination: second });
  expectComponents(two.balances.get(key(second)), parts(90n, 20n, 50n));
  expect(two.balances.has(key(final))).toBe(false);
  const restored = apply(two, { kind: 'restoration', kernel: a(12), origin: a(21), sources: [{ ref: second, amount: 90n }], destination: final });
  expectComponents(restored.balances.get(key(final)), parts(90n, 20n, 50n));
  expect(() => apply(two, { kind: 'restoration', kernel: a(12), origin: a(20), sources: [{ ref: first, amount: 0n }], destination: final })).toThrow('source_reused');
});
test('duplicates, partial balances and altered partitions refuse atomically, even with the same aggregate', () => {
  const one = account(10, 1), two = account(10, 2), pending = entitlement(20);
  const initial = ledger([one, parts(60n, 60n)], [two, parts(40n, 0n, 40n)]);
  const base = { kind: 'snapshot' as const, kernel: a(10), origin: a(20), destination: pending };
  for (const sources of [[{ ref: one, amount: 60n }, { ref: one, amount: 60n }],
    [{ ref: one, amount: 50n }, { ref: two, amount: 50n }], [{ ref: one, amount: 59n }],
    [{ ref: account(11), amount: 60n }], [{ ref: account(10, 3), amount: 0n }]]) {
    expect(() => apply(initial, { ...base, sources })).toThrow();
    expectComponents(initial.balances.get(key(one)), parts(60n, 60n));
    expect(initial.balances.has(key(pending))).toBe(false); expect(initial.consumed.size).toBe(0);
  }
  const cut = apply(initial, { ...base, sources: [{ ref: one, amount: 60n }, { ref: two, amount: 40n }] });
  expectComponents(cut.balances.get(key(pending)), parts(100n, 60n, 40n));
  expect(() => apply(cut, { ...base, sources: [{ ref: one, amount: 0n }] })).toThrow('destination_invalid');
});
test('unbound retired value remains accounted but can never be restored as an entitlement', () => {
  const source = account(10), retired: RestorationBalanceRef = { kind: 'retired', kernel: a(10), address: a(1) };
  const cut = apply(ledger([source, parts(100n, 70n, 20n)]), { kind: 'snapshot', kernel: a(10), origin: a(20),
    sources: [{ ref: source, amount: 100n }], destination: retired });
  expectComponents(cut.balances.get(key(retired)), parts(100n, 70n, 20n));
  expect(() => apply(cut, { kind: 'restoration', kernel: a(11), origin: a(20), sources: [{ ref: retired, amount: 100n }], destination: account(11) })).toThrow('source_invalid');
  expect(() => apply(cut, { kind: 'snapshot', kernel: a(11), origin: a(21), sources: [{ ref: retired, amount: 100n }], destination: entitlement(21) })).toThrow('source_invalid');
});
test('zero entitlements still consume once; origin, identity and component bounds remain mandatory', () => {
  const pending = entitlement(20), current = account(11), empty = ledger([pending, parts(0n)]);
  const bridge = { kind: 'restoration' as const, kernel: a(11), origin: a(20), sources: [{ ref: pending, amount: 0n }], destination: current };
  expect(() => apply(apply(empty, bridge), bridge)).toThrow('source_reused');
  expect(() => apply(empty, { ...bridge, origin: a(21) })).toThrow('source_invalid');
  expect(() => apply(empty, { kind: 'snapshot', kernel: a(11), origin: a(21), sources: bridge.sources, destination: entitlement(21, 2) })).toThrow('source_invalid');
  for (const value of [parts(-1n), parts(10n, 11n), parts(10n, 5n, 6n), parts(10n, -1n)]) {
    expect(() => apply(ledger([pending, value]), { ...bridge, sources: [{ ref: pending, amount: value.balance }] })).toThrow('components_invalid');
  }
  expect(() => key(entitlement(0))).toThrow('reference_invalid');
  expect(() => key(entitlement(20, 0))).toThrow('reference_invalid');
});
test('a later restoration cannot resurrect an account already consumed at its kernel cutoff', () => {
  const old = account(10), pending = entitlement(19);
  const initial = ledger([old, parts(5n)], [pending, parts(10n, 10n)]);
  const cut = apply(initial, { kind: 'snapshot', kernel: a(10), origin: a(20),
    sources: [{ ref: old, amount: 5n }], destination: entitlement(20) });
  expect(() => apply(cut, { kind: 'restoration', kernel: a(10), origin: a(19),
    sources: [{ ref: pending, amount: 10n }], destination: old })).toThrow('destination_consumed');
  expectComponents(cut.balances.get(key(old)), parts(0n));
  expectComponents(cut.balances.get(key(pending)), parts(10n, 10n));
});

test('ordinary succession carries the whole historical balance between kernel domains, never an entitlement', () => {
  const old = account(10), current = account(11), initial = ledger([old, parts(100n, 30n, 50n)], [current, parts(9n)]);
  const bridge = { kind: 'succession' as const, kernel: a(10), origin: a(20), sources: [{ ref: old, amount: 100n }], destination: current };
  const carried = apply(initial, bridge);
  expectComponents(carried.balances.get(key(current)), parts(109n, 30n, 50n));
  expectComponents(carried.balances.get(key(old)), parts(0n));
  expect(() => apply(initial, { ...bridge, destination: account(10, 2) })).toThrow('destination_invalid');
  expect(() => apply(ledger([entitlement(20), parts(100n)]), { ...bridge, sources: [{ ref: entitlement(20), amount: 100n }] })).toThrow('destination_invalid');
  expect(() => apply(carried, bridge)).toThrow('source_reused');
});
