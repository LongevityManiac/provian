import type { Firestore } from 'firebase-admin/firestore';
import { successionCollectionPort } from './restoration-succession-collector-chain';
import { fixture } from './__test-helpers__/restoration-evidence-fixture';
const mockCall = jest.fn();
const mockSendA = jest.fn(), mockSendB = jest.fn();
jest.mock('../onchain/rpc-provider', () => ({ getOperatorBoundRpcLegs: () => [
  { operatorId: 'a', provider: { send: mockSendA } }, { operatorId: 'b', provider: { send: mockSendB } }] }));
jest.mock('./restoration-break-receipt', () => ({ historicalBreakReceiptPort: () => ({ call: mockCall }), readHistoricalBreakRestoration: jest.fn() }));
jest.mock('./restoration-balance-import', () => ({ balanceImportPort: () => ({}), readHistoricalBalanceImport: jest.fn() }));
jest.mock('./restoration-break-partition-chain', () => ({ breakPartitionChainPort: () => ({}) }));
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`, h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
beforeEach(() => { mockCall.mockReset(); mockSendA.mockReset(); mockSendB.mockReset(); });
test('historical empty code is zero only when both independent canonical reads agree', async () => {
  const f = fixture(), balance = jest.fn(async () => 73n), evidence = { ...f.port, chain: { ...f.port.chain, balance } };
  const port = successionCollectionPort({} as Firestore, evidence);
  mockSendA.mockResolvedValue('0x'); mockSendB.mockResolvedValue('0x');
  expect(await port.openingBalance(a(1), a(2), h(3))).toBe(0n); expect(balance).not.toHaveBeenCalled();
  expect(mockSendA).toHaveBeenCalledWith('eth_getCode', [a(1), { blockHash: h(3), requireCanonical: true }]);
  mockSendA.mockResolvedValue('0x1234'); mockSendB.mockResolvedValue('0x1234');
  expect(await port.openingBalance(a(1), a(2), h(3))).toBe(73n);
  expect(balance).toHaveBeenCalledWith(a(1), a(2), h(3));
});
test.each([['0x', '0x1234'], ['0xz1', '0xz1'], [null, null]])('unproven code %s/%s cannot become a zero opening balance', async (first, second) => {
  const f = fixture(), balance = jest.fn(async () => 0n);
  mockSendA.mockResolvedValue(first); mockSendB.mockResolvedValue(second);
  const port = successionCollectionPort({} as Firestore, { ...f.port, chain: { ...f.port.chain, balance } });
  await expect(port.openingBalance(a(1), a(2), h(3))).rejects.toThrow(/opening_code_invalid/);
  expect(balance).not.toHaveBeenCalled();
});
test('origin comes from the historical executor at the exact generation cutoff', async () => {
  const f = fixture(); mockCall.mockImplementation(async (_target, method) => method === 'ownerAuthorization' ? a(4) : a(5));
  expect(await successionCollectionPort({} as Firestore, f.port).origin(a(1), h(3))).toBe(a(5));
  expect(mockCall.mock.calls).toEqual([[a(1), 'ownerAuthorization', [], h(3)], [a(4), 'breakOrigin', [], h(3)]]);
});
