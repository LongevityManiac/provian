import { beforeEach, expect, it, vi } from 'vitest';
import { sha256 } from 'ethers';
import { deliverHashAccountOperation, hashDeliveryId, type HashDeliveryPorts, type HashDeliveryRecord } from './hash-account-delivery';
import { hashAccountCall, type SignedHashAccountOperation } from './hash-account-data';
import type { OwnerChainNetwork } from './recourse-owner-chain';
const guard = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock('./protocol-transaction', () => ({ assertCurrentProtocolTransaction: guard }));
const a = (v: string) => `0x${v.repeat(20)}`, h = (v: string) => `0x${v.repeat(32)}`;
const operation: SignedHashAccountOperation = { chainId: '8453', account: a('11'), nonce: '0', target: a('22'), value: '0', callGas: '100000', data: '0x1234',
  nextCommitment: h('33'), publicKey: h('44'), signingRoot: sha256(h('44')), signature: `0x${'55'.repeat(7856)}` };
function fixture() {
  let record: HashDeliveryRecord | null = null;
  const state = { mined: false, finalized: false, reverted: false, mismatch: false, reorg: false, txChanged: false, lost: false, writeFails: false, reorgAtFinality: false };
  const sent = new Map<string, string>(), sender = a('66'), txHash = h('77'), blockHash = h('88');
  const request = async (method: string, params: readonly unknown[], index: number): Promise<unknown> => {
    if (method === 'eth_getTransactionReceipt') return !state.mined ? null : { transactionHash: txHash, blockHash, blockNumber: '0x64',
      status: state.mismatch && index === 1 ? '0x0' : state.reverted ? '0x0' : '0x1' };
    if (method === 'eth_getTransactionByHash') return { hash: txHash, blockHash, from: state.txChanged ? a('ff') : sender, to: operation.account,
      input: hashAccountCall(operation), value: '0x0' };
    if (method === 'eth_getBlockByNumber' && params[0] === 'finalized' && state.reorgAtFinality) state.reorg = true;
    if (method === 'eth_getBlockByNumber') return params[0] === 'finalized' ? { number: state.finalized ? '0x64' : '0x63' }
      : { number: '0x64', hash: state.reorg ? h('ee') : blockHash };
    throw Error('unexpected rpc');
  };
  const network = { rpcs: [0, 1].map(index => ({ request: (method: string, params: readonly unknown[]) => request(method, params, index) })), deployment: vi.fn() } as unknown as OwnerChainNetwork;
  const ports: HashDeliveryPorts = {
    network, sender, read: async () => record === null ? null : JSON.parse(JSON.stringify(record)) as HashDeliveryRecord,
    write: vi.fn(async (_id, value) => { if (state.writeFails) throw Error('write failed'); record = JSON.parse(JSON.stringify(value)) as HashDeliveryRecord; }),
    send: vi.fn(async (id, tx) => {
      expect(record?.attempts.at(-1)?.id).toBe(id);
      expect(tx).toEqual({ to: operation.account, data: hashAccountCall(operation), value: '0', chainId: 8453 });
      sent.set(id, txHash); if (state.lost) throw Error('lost response'); return txHash;
    }), recover: vi.fn(async id => sent.get(id) ?? null), complete: vi.fn(async () => 'succeeded' as const),
  };
  return { state, ports, txHash, read: () => record, set: (r: HashDeliveryRecord) => { record = r; } };
}
beforeEach(() => { guard.mockReset(); guard.mockResolvedValue({}); });
it('persists before delivery and completes only after independent finality and the inner outcome', async () => {
  const f = fixture();
  expect(await deliverHashAccountOperation(operation, f.ports)).toEqual({ status: 'pending', transactionHash: f.txHash });
  expect(f.ports.send).toHaveBeenCalledTimes(1);
  await deliverHashAccountOperation(operation, f.ports); expect(f.ports.complete).not.toHaveBeenCalled();
  f.state.mined = true; await deliverHashAccountOperation(operation, f.ports); expect(f.ports.complete).not.toHaveBeenCalled();
  f.state.finalized = true; vi.mocked(f.ports.complete).mockResolvedValue('target_failed');
  const result = { status: 'complete', transactionHash: f.txHash, outcome: 'target_failed' };
  expect(await deliverHashAccountOperation(operation, f.ports)).toEqual(result);
  expect(await deliverHashAccountOperation(operation, f.ports)).toEqual(result);
  expect(f.ports.complete).toHaveBeenCalledTimes(1); expect(f.ports.send).toHaveBeenCalledTimes(2);
  expect(vi.mocked(f.ports.send).mock.calls[1][0]).toBe(vi.mocked(f.ports.send).mock.calls[0][0]);
});
it('an uncertain response recovers the existing gas hash even after retirement without a second send', async () => {
  const f = fixture(); f.state.lost = true;
  await expect(deliverHashAccountOperation(operation, f.ports)).rejects.toThrow('lost response');
  expect(f.read()?.attempts[0].hash).toBeNull(); guard.mockRejectedValue(Error('retired'));
  expect(await deliverHashAccountOperation(operation, f.ports)).toEqual({ status: 'pending', transactionHash: f.txHash });
  expect(f.ports.send).toHaveBeenCalledTimes(1);
  f.state.mined = true; f.state.finalized = true;
  expect((await deliverHashAccountOperation(operation, f.ports)).status).toBe('complete');
});
it('a new gas attempt requires a proven finalized outer revert and an explicit later invocation', async () => {
  const f = fixture(); await deliverHashAccountOperation(operation, f.ports);
  f.state.mined = true; f.state.reverted = true;
  expect((await deliverHashAccountOperation(operation, f.ports)).status).toBe('pending'); expect(f.ports.send).toHaveBeenCalledTimes(1);
  f.state.finalized = true;
  expect((await deliverHashAccountOperation(operation, f.ports)).status).toBe('outer_reverted');
  expect(f.ports.send).toHaveBeenCalledTimes(1); expect(f.ports.complete).not.toHaveBeenCalled();
  await deliverHashAccountOperation(operation, f.ports);
  expect(f.ports.send).toHaveBeenCalledTimes(2);
  const attempts = f.read()!.attempts;
  expect(attempts).toHaveLength(2); expect(attempts[0].reverted).toBe(true); expect(attempts[1].id).not.toBe(attempts[0].id);
});
it('disagreement, changed gas transaction and reorg cannot rotate or retry', async () => {
  for (const field of ['mismatch', 'txChanged', 'reorg'] as const) {
    const f = fixture(); await deliverHashAccountOperation(operation, f.ports);
    f.state.mined = true; f.state.finalized = true; f.state[field] = true;
    await expect(deliverHashAccountOperation(operation, f.ports)).rejects.toThrow();
    expect(f.ports.send).toHaveBeenCalledTimes(1); expect(f.ports.complete).not.toHaveBeenCalled();
  }
});
it('failed durable storage, changed journal sender and retired inner calls cannot send', async () => {
  const f = fixture(); f.state.writeFails = true;
  await expect(deliverHashAccountOperation(operation, f.ports)).rejects.toThrow('write failed'); expect(f.ports.send).not.toHaveBeenCalled();
  f.state.writeFails = false; guard.mockRejectedValueOnce(Error('retired'));
  await expect(deliverHashAccountOperation(operation, f.ports)).rejects.toThrow('retired'); expect(f.ports.send).not.toHaveBeenCalled();
  await deliverHashAccountOperation(operation, f.ports);
  f.set({ ...f.read()!, sender: a('ff') });
  await expect(deliverHashAccountOperation(operation, f.ports)).rejects.toThrow('invalid'); expect(f.ports.send).toHaveBeenCalledTimes(1);
});
it('completion failure retains the exact transaction and retries completion without another send', async () => {
  const f = fixture(); await deliverHashAccountOperation(operation, f.ports); f.state.mined = true; f.state.finalized = true;
  vi.mocked(f.ports.complete).mockRejectedValueOnce(Error('rotation interrupted'));
  await expect(deliverHashAccountOperation(operation, f.ports)).rejects.toThrow('rotation interrupted');
  expect(f.read()?.complete).toBeNull(); expect(f.read()?.operation).toBe(hashDeliveryId(operation));
  expect((await deliverHashAccountOperation(operation, f.ports)).status).toBe('complete'); expect(f.ports.send).toHaveBeenCalledTimes(1);
});

it('an unmined retry must reuse the exact signed transaction hash and still refuse retired targets', async () => {
  const f = fixture(); await deliverHashAccountOperation(operation, f.ports);
  vi.mocked(f.ports.send).mockResolvedValueOnce(h('ee'));
  await expect(deliverHashAccountOperation(operation, f.ports)).rejects.toThrow('replay_changed');
  guard.mockRejectedValue(Error('retired')); const count = vi.mocked(f.ports.send).mock.calls.length;
  await expect(deliverHashAccountOperation(operation, f.ports)).rejects.toThrow('retired');
  expect(f.ports.send).toHaveBeenCalledTimes(count);
});

it('a reorg during finality lookup cannot release an orphaned outer revert for a new gas nonce', async () => {
  const f = fixture(); await deliverHashAccountOperation(operation, f.ports);
  f.state.mined = true; f.state.finalized = true; f.state.reverted = true; f.state.reorgAtFinality = true;
  await expect(deliverHashAccountOperation(operation, f.ports)).rejects.toThrow('reorg');
  expect(f.read()?.attempts[0].reverted).toBe(false); expect(f.ports.send).toHaveBeenCalledTimes(1);
  expect(f.ports.complete).not.toHaveBeenCalled();
});
