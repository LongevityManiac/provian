import { HISTORICAL_BINDING_ABI as abi, readHistoricalBindingLog, type HistoricalBindingLogPort } from './restoration-binding-log';
import type { LossSnapshot } from './loss-snapshot';
import type { CanonicalEconomicLog } from '../onchain/economic-discovery';
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`, h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const kernel = a(1), registry = a(2), previous = a(3), pointer = a(4), account = a(5), identity = h(6);
function fixture() {
  const event = (source: string, index: number): CanonicalEconomicLog => ({ address: source,
    ...abi.encodeEventLog(abi.getEvent('OwnershipBound')!, [identity, account, kernel, h(7), h(8), h(9)]),
    logIndex: index, transactionHash: h(10), transactionIndex: 0, blockNumber: 100, blockHash: h(100), removed: false });
  const loss: LossSnapshot = { identity, kernel, block: 100, blockHash: h(100), transactionHash: h(11), firstOutflowLogIndex: 5,
    recordedBalanceAtomic: '100', lossAtomic: '100', addresses: [{ address: account, balanceAtomic: '100', bindingDigest: h(9) }],
    outflows: [{ block: 100, blockHash: h(100), transactionHash: h(11), logIndex: 5, from: account, to: a(99), amountAtomic: '100' }], occurrence: h(12), evidenceHash: h(13) };
  const state = { bound: 100n, owner: identity, inherited: false, cycle: false, wrongPointer: false };
  const port: HistoricalBindingLogPort = {
    call: jest.fn(async (target, method, _args, pin) => {
      if (pin !== loss.blockHash) throw Error('unpinned');
      if (method === 'registryOperator') { if (target !== loss.kernel) throw Error('not original kernel'); return registry; }
      if (method === 'protocolPointer') return pointer;
      if (method === 'pointer') return state.wrongPointer && target === previous ? a(99) : pointer;
      if (method === 'boundBlock') return state.bound;
      if (method === 'ownerOf') return state.owner;
      if (method === 'previousRegistry') return target === registry && state.inherited ? previous : state.cycle ? registry : a(0);
      throw Error(`unexpected ${method}`);
    }),
    logs: jest.fn(async source => source === (state.inherited ? previous : registry) ? [event(source, 4)] : []),
    blockHash: jest.fn(async () => h(100)),
  };
  return { loss, state, port, event };
}
test('original loss registry supplies same-block binding despite a reset current registry', async () => {
  const { loss, port } = fixture(); await expect(readHistoricalBindingLog(loss, port)).resolves.toBe(4);
  expect(port.call).toHaveBeenCalledWith(kernel, 'registryOperator', [], h(100));
  expect(port.call).toHaveBeenCalledWith(registry, 'boundBlock', [account], h(100));
});
test('first binding in an inherited registry precedes later same-block rebinding', async () => {
  const { loss, state, port, event } = fixture(); state.inherited = true;
  port.logs = async source => source === previous ? [event(previous, 4)] : [event(registry, 6)];
  await expect(readHistoricalBindingLog(loss, port)).resolves.toBe(4);
});
test('an earlier positive bound block needs no same-block log but still rechecks the canonical loss checkpoint', async () => {
  const { loss, state, port } = fixture(); state.bound = 99n;
  await expect(readHistoricalBindingLog(loss, port)).resolves.toBe(0); expect(port.logs).not.toHaveBeenCalled();
  port.blockHash = async () => h(999);
  await expect(readHistoricalBindingLog(loss, port)).rejects.toThrow(/reorg/);
});
test.each(['unbound', 'later', 'wrong-owner', 'wrong-pointer', 'cycle', 'missing', 'late-log', 'duplicate', 'removed', 'wrong-log-owner', 'reorg'])('%s binding proof refuses', async mode => {
  const { loss, state, port, event } = fixture();
  if (mode === 'unbound') state.bound = 0n;
  if (mode === 'later') state.bound = 101n;
  if (mode === 'wrong-owner') state.owner = h(99);
  if (mode === 'wrong-pointer') { state.inherited = true; state.wrongPointer = true; }
  if (mode === 'cycle') state.cycle = true;
  if (mode === 'missing') port.logs = async () => [];
  if (mode === 'late-log') port.logs = async () => [event(registry, 5)];
  if (mode === 'duplicate') port.logs = async () => [event(registry, 4), event(registry, 4)];
  if (mode === 'removed') port.logs = async () => [{ ...event(registry, 4), removed: true }];
  if (mode === 'wrong-log-owner') port.logs = async () => [{ ...event(registry, 4), topics: [event(registry, 4).topics[0], h(99), ...event(registry, 4).topics.slice(2)] }];
  if (mode === 'reorg') port.blockHash = async () => h(999);
  await expect(readHistoricalBindingLog(loss, port)).rejects.toThrow();
});
