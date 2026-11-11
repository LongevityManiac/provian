import { RESTORATION_RECEIPT_EVENTS as abi, verifyHistoricalRestorationInterval } from './restoration-receipt-interval';
import type { BaseTransactionEvidence, CanonicalEconomicLog } from '../onchain/economic-discovery';
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const kernel = a(1), executor = a(2), origin = a(3), destination = a(4), identity = h(5);
function log(name: string, values: readonly unknown[], address: string, index: number): CanonicalEconomicLog {
  const encoded = abi.encodeEventLog(abi.getEvent(name)!, values);
  return { address, ...encoded, blockNumber: 200, blockHash: h(200), transactionHash: h(201), transactionIndex: 0, logIndex: index, removed: false };
}
function execution(binding: string, start: number, amount = '50', target = destination, auth = executor): CanonicalEconomicLog[] {
  return [log('OwnerAuthorizationConsumed', [binding, 0, h(7), h(8), h(9)], auth, start),
    ...(amount === '0' ? [] : [log('Transfer', [a(0), target, amount], kernel, start + 1)]),
    log('IdentityRestored', [binding, target, amount], auth, start + 2)];
}
function fixture(amount = '50') {
  const transaction: BaseTransactionEvidence = { schemaVersion: 'base-transaction-evidence/v1', chainId: 8453,
    transactionHash: h(201), blockNumber: 200, blockHash: h(200), blockTimestampMs: 1, confirmationFloor: 12,
    providerOperatorIds: ['a', 'b'], fromAddress: a(6), toAddress: a(7), valueWei: '0', inputEmpty: false,
    transactionSelector: '0x12345678', logs: execution(identity, 0, amount), evidenceHash: h(9) };
  return { kernel, executor, origin, owner: { identity, amount, commitment: h(6), proof: [] }, transaction, logIndex: 2 };
}
test('exact historical interval carries an entitlement to a namespaced account without current key or nonce', () => {
  const result = verifyHistoricalRestorationInterval(fixture());
  expect(result.mintId).toBe(`${kernel}:${h(201)}:1`);
  expect(result.bridge.destination).toEqual({ kind: 'account', kernel, address: destination });
  expect(result.bridge.sources[0].amount.toString()).toBe('50');
});
test('several restorations with identical mint destinations and amounts remain distinct within one wrapper receipt', () => {
  const f = fixture();
  f.transaction = { ...f.transaction, logs: [...execution(h(20), 0), ...execution(identity, 3), ...execution(h(21), 6)] };
  f.logIndex = 5;
  expect(verifyHistoricalRestorationInterval(f).mintId).toBe(`${kernel}:${h(201)}:4`);
});
test('zero restoration consumes its entitlement and invents no mint', () => {
  const f = fixture('0'), result = verifyHistoricalRestorationInterval(f);
  expect(result.mintId).toBeNull(); expect(result.bridge.sources[0].amount.toString()).toBe('0');
  f.transaction = { ...f.transaction, logs: execution(identity, 0, '1') };
  expect(() => verifyHistoricalRestorationInterval(f)).toThrow();
});
test.each(['foreign-restored', 'foreign-consumed', 'wrong-binding', 'missing-consumed', 'intervening-consumed', 'already-ended'])('%s cannot substitute another execution', kind => {
  const f = fixture(); let logs = [...f.transaction.logs];
  if (kind === 'foreign-restored') logs[2] = { ...logs[2], address: a(99) };
  if (kind === 'foreign-consumed') logs[0] = { ...logs[0], address: a(99) };
  if (kind === 'wrong-binding') logs[0] = log('OwnerAuthorizationConsumed', [h(99), 0, h(7), h(8), h(9)], executor, 0);
  if (kind === 'missing-consumed') logs.shift();
  if (kind === 'intervening-consumed') { logs = [...execution(identity, 0), ...execution(h(99), 3), log('IdentityRestored', [identity, destination, 50], executor, 6)]; f.logIndex = 6; }
  if (kind === 'already-ended') { logs.push(log('IdentityRestored', [identity, destination, 50], executor, 3)); f.logIndex = 3; }
  f.transaction = { ...f.transaction, logs }; expect(() => verifyHistoricalRestorationInterval(f)).toThrow();
});
test.each(['missing', 'extra', 'outside', 'wrong-amount', 'foreign-kernel', 'wrong-destination', 'non-mint', 'zero-with-mint'])('%s mint refuses', kind => {
  const f = fixture(kind === 'zero-with-mint' ? '0' : '50'); let logs = [...f.transaction.logs];
  if (kind === 'missing') logs.splice(1, 1);
  if (kind === 'extra') { logs = [logs[0], logs[1], { ...logs[1], logIndex: 2 }, { ...logs[2], logIndex: 3 }]; f.logIndex = 3; }
  if (kind === 'outside') logs = [logs[0], logs[2], { ...logs[1], logIndex: 3 }];
  if (kind === 'wrong-amount') logs[1] = log('Transfer', [a(0), destination, 49], kernel, 1);
  if (kind === 'foreign-kernel') logs[1] = { ...logs[1], address: a(99) };
  if (kind === 'wrong-destination') logs[1] = log('Transfer', [a(0), a(99), 50], kernel, 1);
  if (kind === 'non-mint') logs[1] = log('Transfer', [a(99), destination, 50], kernel, 1);
  if (kind === 'zero-with-mint') logs.splice(1, 0, log('Transfer', [a(0), destination, 0], kernel, 1));
  f.transaction = { ...f.transaction, logs }; expect(() => verifyHistoricalRestorationInterval(f)).toThrow();
});
test.each(['duplicate-position', 'removed', 'foreign-block', 'foreign-transaction', 'excess-data'])('%s receipt refuses', kind => {
  const f = fixture(), logs = [...f.transaction.logs];
  if (kind === 'duplicate-position') logs[1] = { ...logs[1], logIndex: 0 };
  if (kind === 'removed') logs[1] = { ...logs[1], removed: true };
  if (kind === 'foreign-block') logs[1] = { ...logs[1], blockHash: h(99) };
  if (kind === 'foreign-transaction') logs[1] = { ...logs[1], transactionHash: h(99) };
  if (kind === 'excess-data') logs[2] = { ...logs[2], data: `${logs[2].data}${'0'.repeat(64)}` };
  f.transaction = { ...f.transaction, logs }; expect(() => verifyHistoricalRestorationInterval(f)).toThrow();
});
