import { readHistoricalBreakRestoration, type HistoricalBreakReceiptPort } from './restoration-break-receipt';
import { RESTORATION_RECEIPT_EVENTS as abi } from './restoration-receipt-interval';
import type { BaseTransactionEvidence, CanonicalEconomicLog } from '../onchain/economic-discovery';
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`, h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const kernel = a(1), executor = a(2), origin = a(3), prior = a(4), identity = h(5), destination = a(6), manifest = h(8);
function fixture() {
  const event = (name: string, args: readonly unknown[], address: string, index: number): CanonicalEconomicLog => ({
    address, ...abi.encodeEventLog(abi.getEvent(name)!, args), logIndex: index, transactionHash: h(201), blockNumber: 200,
    blockHash: h(200), transactionIndex: 0, removed: false });
  const logs = [event('OwnerAuthorizationConsumed', [identity, 0, h(7), h(8), h(9)], executor, 0),
    event('Transfer', [a(0), destination, 50], kernel, 1), event('IdentityRestored', [identity, destination, 50], executor, 2)];
  const tx: BaseTransactionEvidence = { schemaVersion: 'base-transaction-evidence/v1', chainId: 8453, transactionHash: h(201), blockNumber: 200,
    blockHash: h(200), blockTimestampMs: 1, confirmationFloor: 12, providerOperatorIds: ['a', 'b'], fromAddress: a(9), toAddress: a(10),
    valueWei: '0', inputEmpty: false, transactionSelector: '0x12345678', logs, evidenceHash: h(11) };
  const state = { inherited: false, restored: true, ordinary: true, switched: false };
  const port: HistoricalBreakReceiptPort = {
    chain: { finalizedBlock: jest.fn(async () => 300), blockHash: jest.fn(async block => h(block)) },
    manifest: jest.fn(async () => manifest),
    lineage: jest.fn(async () => ({ kernel: a(90), executor: a(91), manifestHash: manifest, block: 300, blockHash: h(300), migrations: [{ kernel: a(90), executor: a(91), predecessor: kernel, cutoff: 250, cutoffHash: h(250), root: h(92), kind: 'cryptographic_break' as const }] })),
    authenticateExecutor: jest.fn(async () => undefined),
    artifact: jest.fn(async () => ({ domain: { predecessor: a(20), block: 100, root: h(21) },
      institutions: [], owners: [{ identity, amount: '50', commitment: h(6), proof: [] }] })),
    call: jest.fn(async (target, method, _args, pin) => {
      if (pin !== h(250)) throw Error('not pinned');
      if (method === 'ownerAuthorization') return executor;
      if (method === 'kernel') return kernel;
      if (method === 'breakOrigin') return origin;
      if (method === 'lastGoodBlock') return target === origin ? 100n : 150n;
      if (method === 'predecessor') return a(20);
      if (method === 'restorationRoot') return h(21);
      if (method === 'previousAuthorization') return state.ordinary ? prior : a(0);
      if (method === 'restoredIdentity') return target === prior ? state.inherited : state.restored;
      throw Error(`unexpected method ${method}`);
    }),
    logs: jest.fn(async () => state.restored && !state.inherited ? [logs[2]] : []), transaction: jest.fn(async () => tx),
  };
  return { port, tx, logs, state };
}
test('retired ordinary executor restores its authenticated older origin without consulting current key state', async () => {
  const { port } = fixture(), result = await readHistoricalBreakRestoration(kernel, identity, 250, port);
  expect(result?.bridge.origin).toBe(origin); expect(result?.mintId).toBe(`${kernel}:${h(201)}:1`);
  expect(port.logs).toHaveBeenCalledWith(executor, identity, 151, 250);
  expect(port.lineage).toHaveBeenCalledWith(kernel);
});
test.each(['unissued', 'inherited'])('%s entitlement is not fabricated as a local restoration', async mode => {
  const { port, state } = fixture(); state.inherited = mode === 'inherited'; state.restored = mode === 'inherited';
  await expect(readHistoricalBreakRestoration(kernel, identity, 250, port)).resolves.toBeNull();
  expect(port.transaction).not.toHaveBeenCalled();
});
test.each(['missing', 'extra', 'inherited-with-local', 'unrestored-with-local'])('%s restoration history refuses', async mode => {
  const { port, logs, state } = fixture();
  if (mode === 'inherited-with-local') state.inherited = true;
  if (mode === 'unrestored-with-local') state.restored = false;
  port.logs = jest.fn(async () => mode === 'missing' ? [] : mode === 'extra' ? [logs[2], logs[2]] : [logs[2]]);
  await expect(readHistoricalBreakRestoration(kernel, identity, 250, port)).rejects.toThrow(/history_incomplete/);
});
test.each(['not-finalized', 'wrong-kernel', 'wrong-root', 'missing-owner', 'wrong-query-receipt'])('%s evidence refuses', async mode => {
  const { port, logs } = fixture();
  if (mode === 'not-finalized') port.chain.finalizedBlock = async () => 249;
  if (mode === 'wrong-kernel' || mode === 'wrong-root') {
    const original = port.call; port.call = async (...args) => args[1] === (mode === 'wrong-kernel' ? 'kernel' : 'restorationRoot') ? (mode === 'wrong-kernel' ? a(99) : h(99)) : original(...args);
  }
  if (mode === 'missing-owner') { const original = port.artifact; port.artifact = async origin => ({ ...await original(origin), institutions: [], owners: [] }); }
  if (mode === 'wrong-query-receipt') port.logs = async () => [{ ...logs[2], data: `${logs[2].data.slice(0, -1)}1` }];
  await expect(readHistoricalBreakRestoration(kernel, identity, 250, port)).rejects.toThrow();
});
test.each(['manifest', 'receipt-reorg', 'checkpoint-reorg', 'lineage-reorg'])('%s after asynchronous reads refuses', async mode => {
  const { port, state } = fixture();
  port.manifest = async () => { state.switched = true; return mode === 'manifest' ? h(99) : manifest; };
  port.chain.blockHash = async block => state.switched && block === (mode === 'receipt-reorg' ? 200 : mode === 'lineage-reorg' ? 300 : 250) ? h(99) : h(block);
  await expect(readHistoricalBreakRestoration(kernel, identity, 250, port)).rejects.toThrow(/changed|reorg/);
});
test('same-block pointer changes do not substitute an end-of-block current-key test for successful execution', async () => {
  const { port } = fixture();
  // The authenticated current lineage already ends in a later kernel; no
  // current-owner or end-of-receipt-block pointer read is an admission rule.
  expect((await readHistoricalBreakRestoration(kernel, identity, 250, port))?.bridge.kernel).toBe(kernel);
});

test('discarded tail after the immediate successor cutoff cannot issue the same carried entitlement twice', async () => {
  const { port } = fixture();
  await expect(readHistoricalBreakRestoration(kernel, identity, 251, port)).rejects.toThrow(/discarded_history/);
  expect(port.logs).not.toHaveBeenCalled();
});

test('lookalike executor getters do not bypass independent implementation authentication', async () => {
  const { port } = fixture(); port.authenticateExecutor = async () => { throw Error('recourse_executor_runtime_mismatch'); };
  await expect(readHistoricalBreakRestoration(kernel, identity, 250, port)).rejects.toThrow(/runtime_mismatch/);
  expect(port.logs).not.toHaveBeenCalled();
});
