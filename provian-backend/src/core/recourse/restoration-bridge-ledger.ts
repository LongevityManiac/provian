/** Internal accounting references. An address on two kernels is two balances;
 * an unissued entitlement is never a token balance or a reversal source. */
export type RestorationBalanceRef =
  | { readonly kind: 'account'; readonly kernel: string; readonly address: string }
  | { readonly kind: 'entitlement'; readonly origin: string; readonly identity: string }
  | { readonly kind: 'retired'; readonly kernel: string; readonly address: string };
export interface RestorationComponents {
  readonly balance: bigint;
  readonly reversible: bigint;
  readonly protected: bigint;
}
export interface RestorationBridgeLedger {
  readonly balances: ReadonlyMap<string, RestorationComponents>;
  readonly consumed: ReadonlySet<string>;
}
export interface RestorationBalanceBridge {
  readonly kind: 'snapshot' | 'restoration' | 'succession';
  readonly kernel: string;
  readonly origin: string;
  readonly sources: readonly { readonly ref: RestorationBalanceRef; readonly amount: bigint }[];
  readonly destination: RestorationBalanceRef;
}
const address = /^0x[0-9a-f]{40}$/;
const hash = /^0x[0-9a-f]{64}$/;
const zeroAddress = `0x${'0'.repeat(40)}`, zeroHash = `0x${'0'.repeat(64)}`;
function validAddress(value: string): boolean { return address.test(value) && value !== zeroAddress; }
export function restorationBalanceKey(ref: RestorationBalanceRef): string {
  if (ref.kind === 'entitlement') {
    if (!validAddress(ref.origin) || !hash.test(ref.identity) || ref.identity === zeroHash) throw Error('recourse_bridge_reference_invalid');
    return `entitlement:${ref.origin}:${ref.identity}`;
  }
  if ((ref.kind !== 'account' && ref.kind !== 'retired') || !validAddress(ref.kernel) || !validAddress(ref.address)) {
    throw Error('recourse_bridge_reference_invalid');
  }
  return `${ref.kind}:${ref.kernel}:${ref.address}`;
}
function checkedComponents(value: RestorationComponents): RestorationComponents {
  if (value.balance < 0n || value.reversible < 0n || value.protected < 0n
    || value.reversible + value.protected > value.balance) throw Error('recourse_bridge_components_invalid');
  return value;
}
/** Apply an independently authenticated snapshot/receipt bridge, never a
 * caller-supplied classification. This layer checks conservation only; it does
 * not establish ownership, Merkle membership, finality or receipt authenticity.
 * Every source is consumed in full, including its untraced component. All
 * validation precedes the returned state; a refusal leaves input unchanged. */
export function applyRestorationBalanceBridge(ledger: RestorationBridgeLedger, bridge: RestorationBalanceBridge): RestorationBridgeLedger {
  if (!validAddress(bridge.kernel) || !validAddress(bridge.origin) || bridge.sources.length === 0) throw Error('recourse_bridge_domain_invalid');
  const destination = restorationBalanceKey(bridge.destination);
  if (ledger.consumed.has(destination)) throw Error('recourse_bridge_destination_consumed');
  const sources = new Set<string>();
  let balance = 0n, reversible = 0n, protectedValue = 0n;
  if (bridge.kind === 'snapshot') {
    if (bridge.destination.kind === 'account'
      || bridge.destination.kind === 'entitlement' && bridge.destination.origin !== bridge.origin
      || bridge.destination.kind === 'retired' && bridge.destination.kernel !== bridge.kernel
      || ledger.balances.has(destination)) throw Error('recourse_bridge_destination_invalid');
  } else if (bridge.kind === 'restoration') {
    if (bridge.destination.kind !== 'account' || bridge.destination.kernel !== bridge.kernel || bridge.sources.length !== 1) {
      throw Error('recourse_bridge_destination_invalid');
    }
  } else if (bridge.kind === 'succession') {
    if (bridge.destination.kind !== 'account' || bridge.destination.kernel === bridge.kernel || bridge.sources.length !== 1
      || bridge.sources[0].ref.kind !== 'account') throw Error('recourse_bridge_destination_invalid');
  } else throw Error('recourse_bridge_domain_invalid');
  for (const source of bridge.sources) {
    const key = restorationBalanceKey(source.ref);
    if (key === destination || sources.has(key) || ledger.consumed.has(key)) throw Error('recourse_bridge_source_reused');
    sources.add(key);
    if (source.ref.kind === 'retired'
      || source.ref.kind === 'account' && (bridge.kind === 'restoration' || source.ref.kernel !== bridge.kernel)
      || source.ref.kind === 'entitlement' && (bridge.kind === 'restoration'
        ? source.ref.origin !== bridge.origin : source.ref.origin === bridge.origin)) throw Error('recourse_bridge_source_invalid');
    if (source.ref.kind === 'entitlement' && bridge.destination.kind === 'entitlement'
      && source.ref.identity !== bridge.destination.identity) throw Error('recourse_bridge_source_invalid');
    if (bridge.destination.kind === 'retired' && (bridge.sources.length !== 1 || source.ref.kind !== 'account'
      || source.ref.address !== bridge.destination.address)) throw Error('recourse_bridge_source_invalid');
    const value = ledger.balances.get(key);
    if (!value || checkedComponents(value).balance !== source.amount) throw Error('recourse_bridge_source_incomplete');
    balance += value.balance; reversible += value.reversible; protectedValue += value.protected;
  }
  const previous = checkedComponents(ledger.balances.get(destination) ?? { balance: 0n, reversible: 0n, protected: 0n });
  const balances = new Map(ledger.balances), consumed = new Set(ledger.consumed);
  for (const key of sources) {
    balances.set(key, { balance: 0n, reversible: 0n, protected: 0n }); consumed.add(key);
  }
  balances.set(destination, { balance: previous.balance + balance, reversible: previous.reversible + reversible,
    protected: previous.protected + protectedValue });
  return { balances, consumed };
}
