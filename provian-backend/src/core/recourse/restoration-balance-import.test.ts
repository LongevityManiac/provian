import { Interface, keccak256 } from 'ethers';
import { readHistoricalBalanceImport, type BalanceImportPort } from './restoration-balance-import';
import type { BaseTransactionEvidence, CanonicalEconomicLog } from '../onchain/economic-discovery';
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`, h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const old = a(1), kernel = a(2), executor = a(3), account = a(4), destination = a(5), manifest = h(6);
const abi = new Interface(['event BalanceMigrated(address indexed previousOwner,address indexed destination,uint256 amount)',
  'event Transfer(address indexed from,address indexed to,uint256 amount)']);
function fixture(broken = false) {
  const event = (name: string, args: readonly unknown[], address: string, logIndex: number): CanonicalEconomicLog => ({
    address, ...abi.encodeEventLog(abi.getEvent(name)!, args), logIndex, transactionHash: h(201), blockNumber: 200,
    blockHash: h(200), transactionIndex: 0, removed: false });
  const logs = [event('Transfer', [a(0), destination, 50], kernel, 1),
    event('BalanceMigrated', [account, destination, 50], executor, 2)];
  const tx: BaseTransactionEvidence = { schemaVersion: 'base-transaction-evidence/v1', chainId: 8453, transactionHash: h(201),
    blockNumber: 200, blockHash: h(200), blockTimestampMs: 1, confirmationFloor: 12, providerOperatorIds: ['a', 'b'],
    fromAddress: a(9), toAddress: executor, valueWei: '0', inputEmpty: false, transactionSelector: '0x12345678', logs, evidenceHash: h(11) };
  const port: BalanceImportPort = {
    chain: { finalizedBlock: jest.fn(async () => 300), blockHash: jest.fn(async n => h(n)) },
    manifest: jest.fn(async () => manifest),
    lineage: jest.fn(async () => ({ kernel, executor, manifestHash: manifest, block: 300, blockHash: h(300),
      migrations: [{ predecessor: old, kernel, executor, cutoff: 100, cutoffHash: h(100), root: h(12),
        kind: broken ? 'cryptographic_break' as const : 'ordinary' as const }] })),
    authenticateExecutor: jest.fn(async () => undefined),
    artifact: jest.fn(async () => ({ domain: { predecessor: old, block: 100, root: h(12) }, owners: [],
      institutions: [{ source: account, destination, amount: '50', runtimeHash: keccak256('0x1234'), proof: [] }] })),
    call: jest.fn(async () => { throw Error('unexpected call'); }), balance: jest.fn(async () => 50n),
    code: jest.fn(async () => '0x1234'), token: jest.fn(async () => kernel),
    imports: jest.fn(async () => [logs[1]]), transaction: jest.fn(async () => tx),
  };
  return { port, logs, tx, event };
}
test.each([false, true])('exact imported custody is a typed bridge (cryptographic break=%s)', async broken => {
  const { port } = fixture(broken), result = await readHistoricalBalanceImport(old, account, 250, port);
  expect(result?.bridge).toEqual({ kind: 'succession', kernel: old, origin: executor,
    sources: [{ ref: { kind: 'account', kernel: old, address: account }, amount: 50n }],
    destination: { kind: 'account', kernel, address: destination } });
  expect(result?.mintId).toBe(`${kernel}:${h(201)}:1`);
  expect(port.balance).toHaveBeenCalledWith(old, account, h(100));
  expect(port.authenticateExecutor).toHaveBeenCalledWith(executor, kernel, h(250));
  expect(port.imports).toHaveBeenCalledWith(executor, account, 101, 250);
});
test('zero ordinary balance has no invented import', async () => {
  const { port } = fixture(); port.balance = async () => 0n; port.imports = async () => [];
  await expect(readHistoricalBalanceImport(old, account, 250, port)).resolves.toBeNull();
  expect(port.transaction).not.toHaveBeenCalled(); expect(port.manifest).toHaveBeenCalled();
});
test.each(['omission', 'duplicate', 'zero-with-log'])('%s import history refuses', async mode => {
  const { port, logs } = fixture();
  if (mode === 'zero-with-log') port.balance = async () => 0n;
  port.imports = async () => mode === 'omission' ? [] : mode === 'duplicate' ? [logs[1], logs[1]] : [logs[1]];
  await expect(readHistoricalBalanceImport(old, account, 250, port)).rejects.toThrow(/history_incomplete/);
});
test.each(['root', 'source', 'amount', 'destination', 'runtime', 'token'])('break institution %s mismatch refuses', async mode => {
  const { port } = fixture(true), original = port.artifact;
  port.artifact = async origin => {
    const artifact = await original(origin);
    return { ...artifact, domain: { ...artifact.domain, root: mode === 'root' ? h(99) : artifact.domain.root },
      institutions: artifact.institutions.map(row => ({ ...row, source: mode === 'source' ? a(99) : row.source,
        amount: mode === 'amount' ? '49' : row.amount, destination: mode === 'destination' ? a(99) : row.destination })) };
  };
  if (mode === 'runtime') port.code = async () => '0x1235';
  if (mode === 'token') port.token = async () => old;
  await expect(readHistoricalBalanceImport(old, account, 250, port)).rejects.toThrow();
});
test.each(['wrong-kernel', 'wrong-source', 'wrong-destination', 'wrong-amount', 'missing', 'removed'])('%s adjacent mint refuses', async mode => {
  const { port, logs, event } = fixture();
  logs[0] = event('Transfer', [mode === 'wrong-source' ? account : a(0), mode === 'wrong-destination' ? account : destination,
    mode === 'wrong-amount' ? 51 : 50], mode === 'wrong-kernel' ? old : kernel, mode === 'missing' ? 0 : 1);
  if (mode === 'removed') logs[0] = { ...logs[0], removed: true };
  await expect(readHistoricalBalanceImport(old, account, 250, port)).rejects.toThrow(/mint_/);
});
test.each(['receipt', 'chain', 'event-amount', 'event-source', 'event-executor'])('%s mismatch refuses', async mode => {
  const { port, tx, logs, event } = fixture();
  if (mode === 'receipt') port.transaction = async () => ({ ...tx, logs: [logs[0]] });
  if (mode === 'chain') port.transaction = async () => ({ ...tx, chainId: 1 as 8453 });
  if (mode.startsWith('event-')) logs[1] = event('BalanceMigrated', [mode === 'event-source' ? a(99) : account,
    destination, mode === 'event-amount' ? 49 : 50], mode === 'event-executor' ? a(99) : executor, 2);
  await expect(readHistoricalBalanceImport(old, account, 250, port)).rejects.toThrow();
});
test.each(['manifest', 'receipt', 'cutoff', 'through', 'lineage'])('%s changed after reads refuses', async mode => {
  const { port } = fixture(); let changed = false;
  port.manifest = async () => { changed = true; return mode === 'manifest' ? h(99) : manifest; };
  const block = mode === 'receipt' ? 200 : mode === 'cutoff' ? 100 : mode === 'through' ? 250 : 300;
  port.chain.blockHash = async n => changed && n === block ? h(99) : h(n);
  await expect(readHistoricalBalanceImport(old, account, 250, port)).rejects.toThrow(/changed|reorg/);
});
test('discarded successor tail is not current custody', async () => {
  const { port } = fixture(), original = port.lineage;
  port.lineage = async oldKernel => { const lineage = await original(oldKernel); return { ...lineage, migrations: [...lineage.migrations,
    { predecessor: kernel, kernel: a(20), executor: a(21), cutoff: 240, cutoffHash: h(240), root: h(22), kind: 'cryptographic_break' }] }; };
  await expect(readHistoricalBalanceImport(old, account, 250, port)).rejects.toThrow(/generation_invalid/);
  expect(port.imports).not.toHaveBeenCalled();
});
test('lookalike executor cannot authorize a balance bridge', async () => {
  const { port } = fixture(); port.authenticateExecutor = async () => { throw Error('runtime_mismatch'); };
  await expect(readHistoricalBalanceImport(old, account, 250, port)).rejects.toThrow(/runtime_mismatch/);
  expect(port.imports).not.toHaveBeenCalled();
});
