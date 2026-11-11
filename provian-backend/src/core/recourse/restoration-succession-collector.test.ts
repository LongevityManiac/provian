import { Interface } from 'ethers';
import { collectSuccessionCheckpoint, type SuccessionCollectionPort } from './restoration-succession-collector';
import { traceRestorationSuccession } from './restoration-succession-trace';
import type { LossSnapshot } from './loss-snapshot';
import type { TransferEvent } from './ownership';
import type { ReconstructedBreakPartition } from './restoration-break-partition';
import type { BaseTransactionEvidence } from '../onchain/economic-discovery';
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`, h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const old = a(10), kernel = a(11), executor = a(20), owner = a(1), recipient = a(2), destination = a(9), identity = h(1), other = h(2), manifest = h(99);
const abi = new Interface(['event Transfer(address indexed from,address indexed to,uint256 amount)']);
function fixture(mode: 'ordinary' | 'break' | 'institution' = 'break') {
  const loss: TransferEvent = { block: 100, blockHash: h(100), transactionHash: h(1100), logIndex: 0,
    from: owner, to: recipient, amountAtomic: '100' };
  const mint: TransferEvent = { ...loss, block: 115, blockHash: h(115), transactionHash: h(1115), logIndex: 0, from: a(0), to: destination };
  const fresh: TransferEvent = { ...mint, block: 118, blockHash: h(118), transactionHash: h(1118), amountAtomic: '7' };
  const tx = (event: TransferEvent, token: string): BaseTransactionEvidence => ({ schemaVersion: 'base-transaction-evidence/v1', chainId: 8453,
    transactionHash: event.transactionHash, blockNumber: event.block, blockHash: event.blockHash, blockTimestampMs: 1, confirmationFloor: 12,
    providerOperatorIds: ['a', 'b'], fromAddress: event.from, toAddress: token, valueWei: '0', inputEmpty: false,
    transactionSelector: '0x12345678', evidenceHash: h(event.block + 2000), logs: [{ address: token,
      ...abi.encodeEventLog(abi.getEvent('Transfer')!, [event.from, event.to, event.amountAtomic]), transactionHash: event.transactionHash,
      blockNumber: event.block, blockHash: event.blockHash, logIndex: event.logIndex, transactionIndex: 0, removed: false }] });
  const snapshot: LossSnapshot = { identity, kernel: old, block: 100, blockHash: h(100), transactionHash: loss.transactionHash,
    firstOutflowLogIndex: 0, recordedBalanceAtomic: '100', lossAtomic: '100', addresses: [{ address: owner, balanceAtomic: '100', bindingDigest: h(5) }],
    outflows: [loss], occurrence: h(6), evidenceHash: h(7) };
  const state = { restored: true, omitted: false, unbound: false };
  const partition = (id: string): ReconstructedBreakPartition => ({ origin: executor, predecessor: old, cutoff: 110, cutoffHash: h(110),
    owner: { identity: id, amount: id === identity ? '0' : '100', commitment: h(9), proof: [] },
    accounts: [{ address: id === identity ? owner : recipient, amountAtomic: id === identity ? '0' : '100' }], carried: null });
  const port: SuccessionCollectionPort = {
    evidence: {
      chain: { finalizedBlock: async () => 120, blockHash: async n => h(n),
        balance: async (token, account) => token === old ? account === recipient ? 100n : 0n : account === destination ? state.restored ? 107n : 0n : 0n,
        transfers: async (token, account) => token === old ? account === owner || account === recipient ? state.omitted ? [] : [loss] : []
          : account === destination && state.restored ? [mint, fresh] : [] },
      currentKernel: async () => kernel,
      call: async (target, method, args) => method === 'registryOperator' ? (target === old ? a(30) : a(31))
        : method === 'ownerAuthorization' ? executor : method === 'outgoingSequence' ? '3' : method === 'restorationRevision' ? '4'
          : args[0] === owner ? identity : state.unbound && target === a(30) ? h(0) : other,
      privateOwner: async id => id, verifiedIdentity: async () => null,
      transaction: async hash => hash === loss.transactionHash ? tx(loss, old) : hash === mint.transactionHash ? tx(mint, kernel) : tx(fresh, kernel),
    },
    lineage: async () => ({ kernel, executor, manifestHash: manifest, block: 120, blockHash: h(120), migrations: [{ kernel, executor,
      predecessor: old, cutoff: 110, cutoffHash: h(110), root: h(22), kind: mode === 'ordinary' ? 'ordinary' : 'cryptographic_break' }] }),
    artifact: async () => ({ domain: { predecessor: old, block: 110, root: h(22) }, owners: [partition(identity).owner, partition(other).owner],
      institutions: mode === 'institution' ? [{ source: recipient, destination, amount: '100', runtimeHash: h(23), proof: [] }] : [] }),
    partition: async (_origin, id) => partition(id),
    openingBalance: async (token, account) => token === old && account === owner ? 100n : 0n,
    balanceImport: async (_prior, account) => account !== recipient ? null : ({ bridge: { kind: 'succession', kernel: old, origin: executor,
      sources: [{ ref: { kind: 'account', kernel: old, address: recipient }, amount: 100n }], destination: { kind: 'account', kernel, address: destination } },
      block: 115, blockHash: h(115), transactionHash: mint.transactionHash, logIndex: 0, mintId: `${kernel}:${mint.transactionHash}:0`, evidenceHash: h(33) }),
    restoration: async (_kernel, id) => id !== other || !state.restored ? null : ({ bridge: { kind: 'restoration', kernel, origin: executor,
      sources: [{ ref: { kind: 'entitlement', origin: executor, identity: other }, amount: 100n }], destination: { kind: 'account', kernel, address: destination } },
      block: 115, blockHash: h(115), transactionHash: mint.transactionHash, logIndex: 1, mintId: `${kernel}:${mint.transactionHash}:0`, evidenceHash: h(34) }),
    origin: async () => executor, manifest: async () => manifest,
  };
  return { port, snapshot, state, partition };
}
test.each(['ordinary', 'break', 'institution'] as const)('%s authenticated bridge excludes only its real mint and keeps fresh work', async mode => {
  const { port, snapshot } = fixture(mode), result = await collectSuccessionCheckpoint(snapshot, port);
  expect(result.trace).toMatchObject({ shortfallAtomic: '100', sources: [] });
  const transfers = result.checkpoint.events.filter(event => event.kind === 'transfer');
  expect(transfers).toHaveLength(2);
  // Determination's independent invoice evidence can establish gratuitousness;
  // the collector itself leaves direct-transfer shape unresolved.
  const trace = traceRestorationSuccession(snapshot, { ...result.checkpoint, events: result.checkpoint.events.map(event =>
    event.kind === 'transfer' ? { ...event, transfer: { ...event.transfer, receipt: 'gratuitous' as const } } : event) });
  expect(trace).toMatchObject({ shortfallAtomic: '0', reversibleAtomic: '100', sources: [{ address: destination, amountAtomic: '100', outgoingSequence: '3' }] });
});
test('unissued entitlement never becomes a current reversal source', async () => {
  const { port, snapshot, state } = fixture(); state.restored = false;
  const result = await collectSuccessionCheckpoint(snapshot, port);
  expect(result.trace).toMatchObject({ shortfallAtomic: '100', sources: [] });
  expect(result.checkpoint.balances.find(row => row.ref.kind === 'entitlement' && row.ref.identity === other)?.closingAtomic).toBe('100');
});
test('unbound balances retire without inventing an entitlement', async () => {
  const { port, snapshot, state } = fixture(); state.unbound = true;
  const result = await collectSuccessionCheckpoint(snapshot, port);
  expect(result.checkpoint.balances.find(row => row.ref.kind === 'retired' && row.ref.address === recipient)?.closingAtomic).toBe('100');
  expect(result.trace.sources).toEqual([]);
});
test.each(['missing-transfer', 'wrong-partition', 'wrong-amount', 'wrong-import', 'wrong-origin', 'wrong-opening', 'manifest', 'reorg'])('%s fails closed', async mode => {
  const { port, snapshot, state, partition } = fixture(mode === 'wrong-import' ? 'ordinary' : 'break');
  if (mode === 'missing-transfer') state.omitted = true;
  if (mode === 'wrong-partition') port.partition = async (_origin, id) => ({ ...partition(id), predecessor: a(88) });
  if (mode === 'wrong-amount') port.partition = async (_origin, id) => ({ ...partition(id), accounts: [{ address: recipient, amountAtomic: '99' }] });
  if (mode === 'wrong-import') port.balanceImport = async () => null;
  if (mode === 'wrong-origin') port.origin = async () => a(88);
  if (mode === 'wrong-opening') port.openingBalance = async () => 100n;
  if (mode === 'manifest') port.manifest = async () => h(88);
  if (mode === 'reorg') { let changed = false; port.manifest = async () => { changed = true; return manifest; };
    port.evidence.chain.blockHash = async n => changed && n === 110 ? h(88) : h(n); }
  await expect(collectSuccessionCheckpoint(snapshot, port)).rejects.toThrow();
});

test('unissued rights cross a second break once without becoming invented intermediate token balances', async () => {
  const { port, snapshot, state, partition } = fixture(); state.restored = false;
  const successor = a(12), nextExecutor = a(21), originalLineage = port.lineage;
  port.lineage = async lossKernel => { const value = await originalLineage(lossKernel); return { ...value, kernel: successor,
    executor: nextExecutor, block: 130, blockHash: h(130), migrations: [...value.migrations,
      { kernel: successor, executor: nextExecutor, predecessor: kernel, cutoff: 120, cutoffHash: h(120), root: h(24), kind: 'cryptographic_break' }] }; };
  port.evidence.currentKernel = async () => successor; port.evidence.chain.finalizedBlock = async () => 130;
  port.origin = async token => token === kernel ? executor : nextExecutor;
  port.partition = async (origin, id) => origin === executor ? partition(id) : { ...partition(id), origin: nextExecutor,
    predecessor: kernel, cutoff: 120, cutoffHash: h(120), accounts: [], carried: partition(id) };
  const result = await collectSuccessionCheckpoint(snapshot, port);
  expect(result.trace).toMatchObject({ sources: [], shortfallAtomic: '100' });
  expect(result.checkpoint.balances.filter(row => row.ref.kind === 'entitlement' && row.ref.identity === other)
    .map(row => [row.ref.kind === 'entitlement' ? row.ref.origin : '', row.closingAtomic])).toEqual([[executor, '0'], [nextExecutor, '100']]);
  expect(result.checkpoint.events.filter(event => event.kind === 'transfer')).toHaveLength(1);
});

test('private determination evidence is JSON-safe without changing an atomic-unit balance', async () => {
  const { recordSuccessionCheckpoint, readSuccessionCheckpoint } = await import('./restoration-succession-record');
  const { port, snapshot } = fixture(), result = await collectSuccessionCheckpoint(snapshot, port);
  const record = recordSuccessionCheckpoint(result.checkpoint);
  expect(readSuccessionCheckpoint(JSON.parse(JSON.stringify(record)))).toEqual(result.checkpoint);
  for (const amount of ['-1', '01', '1.0', (1n << 256n).toString()]) {
    const events = record.events.map(event => event.kind === 'bridge' ? { ...event,
      bridge: { ...event.bridge, sources: event.bridge.sources.map(source => ({ ...source, amount })) } } : event);
    expect(() => readSuccessionCheckpoint({ ...record, events })).toThrow(/amount_invalid/);
  }
});

test('a reached binding cannot silently lose or contradict its private owner', async () => {
  for (const mode of ['missing', 'conflict']) {
    const { port, snapshot } = fixture();
    if (mode === 'missing') port.evidence.privateOwner = async id => id === other ? null : id;
    else port.evidence.verifiedIdentity = async account => account === recipient ? { identity, evidenceHash: h(98) } : null;
    await expect(collectSuccessionCheckpoint(snapshot, port)).rejects.toThrow(/owner_missing|owner_conflict/);
  }
});
test('pending entitlement survives an ordinary successor without duplicate virtual balance', async () => {
  const { port, snapshot, state } = fixture(); state.restored = false;
  const successor = a(12), nextExecutor = a(21), originalLineage = port.lineage;
  port.lineage = async lossKernel => { const value = await originalLineage(lossKernel); return { ...value, kernel: successor,
    executor: nextExecutor, block: 130, blockHash: h(130), migrations: [...value.migrations,
      { kernel: successor, executor: nextExecutor, predecessor: kernel, cutoff: 120, cutoffHash: h(120), root: h(24), kind: 'ordinary' }] }; };
  port.evidence.currentKernel = async () => successor; port.evidence.chain.finalizedBlock = async () => 130;
  const result = await collectSuccessionCheckpoint(snapshot, port);
  expect(result.checkpoint.balances.filter(row => row.ref.kind === 'entitlement' && row.ref.identity === other)
    .map(row => row.closingAtomic)).toEqual(['100']);
  expect(result.trace).toMatchObject({ sources: [], shortfallAtomic: '100' });
});


test.each(['ordinary', 'break', 'institution'] as const)('%s determination reclassifies actual receipts through typed bridges and observes only current accounts', async mode => {
  const { createHash } = await import('crypto');
  const { collectRestorationEvidence, assertRestorationEvidence } = await import('./restoration-evidence');
  const { prepareDetermination, assessRestoration } = await import('./determination');
  const { determinationPlan } = await import('./determination-plan');
  const { createFakeFirestore } = await import('../pvt/__test-helpers__/fake-firestore');
  const { RESTORATION_REQUESTS } = await import('./restoration-request');
  const { port, snapshot } = fixture(mode); port.evidence.succession = port;
  const fake = createFakeFirestore(), membership = { active: true, periodIndex: 0, unpaidAtomic: '0', completedNonissuanceMonths: [],
    evidenceHash: h(90), lossTimestamp: 100 };
  const exact = JSON.stringify({ snapshot, membership });
  const ticket = { request: snapshot.occurrence, identity, destination: a(50), currentDestination: a(50), maximumLoss: snapshot.lossAtomic,
    lossHash: `0x${createHash('sha256').update(exact).digest('hex')}` };
  fake.store.set(`${RESTORATION_REQUESTS}/${ticket.request}`, { identity, destination: ticket.destination, snapshot, membership,
    evidence: exact, status: 'awaiting_determination' });
  const packet = await prepareDetermination(fake as unknown as import('firebase-admin/firestore').Firestore, ticket.request, {
    ticket: async () => ticket, evidence: loss => collectRestorationEvidence(loss, port.evidence),
    pool: async () => ({ outcomeRevision: '0' } as import('./pool-state').RecoursePoolState) });
  expect(() => JSON.stringify(packet)).not.toThrow();
  expect(() => assertRestorationEvidence(packet.evidence)).not.toThrow();
  const first = packet.evidence.checkpoint.transfers[0];
  const judgment = { packetHash: packet.packetHash, finding: 'accepted_theft' as const, reasoning: 'Evidence-based taking determination.',
    evidenceHashes: [snapshot.evidenceHash], receipts: [{ transactionHash: first.transactionHash, logIndex: first.logIndex,
      conclusion: 'theft_taker' as const, evidenceHashes: [first.witnessHash], reasoning: 'Affirmative finding about this original taking.' }] };
  const result = assessRestoration(packet, judgment);
  expect(result.trace).toMatchObject({ reversibleAtomic: '100', shortfallAtomic: '0', sources: [{ address: destination, amountAtomic: '100', outgoingSequence: '3' }] });
  const plan = determinationPlan(result, { revision: 1n, registry: a(31), bindingLogIndex: 0 });
  if (!plan.accepted) throw Error('expected acceptance');
  expect(plan.reversal.observationAccounts).toContain(destination);
  expect(plan.reversal.observationAccounts).not.toContain(recipient);
  expect(plan.reversal.restorationRevision).toBe('4');
  expect(packet.evidence.checkpoint.transfers[0].receipt).toBe('unresolved');
  expect(() => assessRestoration(packet, { ...judgment, receipts: [{ ...judgment.receipts[0], transactionHash: h(1115) }] })).toThrow(/receipt_invalid/);
});

test('distinct public bindings belonging to the same private owner offset a return without publishing a portfolio', async () => {
  const { port, snapshot } = fixture(); port.evidence.privateOwner = async () => identity;
  const result = await collectSuccessionCheckpoint(snapshot, port);
  expect(result.trace).toMatchObject({ returnedAtomic: '100', shortfallAtomic: '0', sources: [] });
});

test('current-kernel collection preserves the established restoration amounts without a succession', async () => {
  const { collectRestorationEvidence } = await import('./restoration-evidence');
  const { port, snapshot } = fixture();
  port.evidence.currentKernel = async () => old; port.evidence.chain.finalizedBlock = async () => 110;
  const closing = port.evidence.chain.balance;
  port.evidence.chain.balance = (token, account, pin) => pin === h(99) ? port.openingBalance(token, account, pin) : closing(token, account, pin);
  port.lineage = async () => ({ kernel: old, executor, manifestHash: manifest, block: 110, blockHash: h(110), migrations: [] });
  const typed = await collectSuccessionCheckpoint(snapshot, port), prior = await collectRestorationEvidence(snapshot, port.evidence);
  const { evidenceHash: _typedHash, ...typedAmounts } = typed.trace, { evidenceHash: _priorHash, ...priorAmounts } = prior.trace;
  expect(typedAmounts).toEqual(priorAmounts);
});

test('a pending break right restored by an ordinary successor reaches its actual current balance', async () => {
  const { port, snapshot, state } = fixture(); state.restored = false;
  const successor = a(12), nextExecutor = a(21), originalLineage = port.lineage, originalTransfers = port.evidence.chain.transfers;
  const originalTransaction = port.evidence.transaction;
  port.lineage = async lossKernel => { const value = await originalLineage(lossKernel); return { ...value, kernel: successor,
    executor: nextExecutor, block: 130, blockHash: h(130), migrations: [...value.migrations,
      { kernel: successor, executor: nextExecutor, predecessor: kernel, cutoff: 120, cutoffHash: h(120), root: h(24), kind: 'ordinary' }] }; };
  port.evidence.currentKernel = async () => successor; port.evidence.chain.finalizedBlock = async () => 130;
  const mint: TransferEvent = { block: 125, blockHash: h(125), transactionHash: h(1125), logIndex: 0, from: a(0), to: destination, amountAtomic: '100' };
  port.evidence.chain.balance = async (token, account) => token === old && account === recipient || token === successor && account === destination ? 100n : 0n;
  port.evidence.chain.transfers = async (token, account, from, through) => token === successor && account === destination ? [mint] : originalTransfers(token, account, from, through);
  port.evidence.transaction = async hash => hash !== mint.transactionHash ? originalTransaction(hash) : {
    ...await originalTransaction(snapshot.transactionHash), transactionHash: mint.transactionHash, blockNumber: 125, blockHash: h(125),
    logs: [{ address: successor, ...abi.encodeEventLog(abi.getEvent('Transfer')!, [a(0), destination, 100]),
      blockNumber: 125, blockHash: h(125), transactionHash: mint.transactionHash, logIndex: 0, transactionIndex: 0, removed: false }] };
  port.restoration = async (token, id) => token !== successor || id !== other ? null : { bridge: { kind: 'restoration', kernel: successor, origin: executor,
    sources: [{ ref: { kind: 'entitlement', origin: executor, identity: other }, amount: 100n }], destination: { kind: 'account', kernel: successor, address: destination } },
    block: 125, blockHash: h(125), transactionHash: mint.transactionHash, logIndex: 1, mintId: `${successor}:${mint.transactionHash}:0`, evidenceHash: h(34) };
  const result = await collectSuccessionCheckpoint(snapshot, port);
  expect(result.checkpoint.balances.find(row => row.ref.kind === 'account' && row.ref.kernel === successor && row.ref.address === destination)?.closingAtomic).toBe('100');
  expect(result.checkpoint.balances.find(row => row.ref.kind === 'entitlement' && row.ref.identity === other)?.closingAtomic).toBe('0');
  const trace = traceRestorationSuccession(snapshot, { ...result.checkpoint, events: result.checkpoint.events.map(event => event.kind === 'transfer'
    ? { ...event, transfer: { ...event.transfer, receipt: 'gratuitous' as const } } : event) });
  expect(trace).toMatchObject({ reversibleAtomic: '100', shortfallAtomic: '0' });
});
