const mockDocuments = new Map<string, Record<string, unknown>>();
const mockUnresolved: { data: () => Record<string, unknown> }[] = [];
jest.mock('../../firestore-db', () => ({ relayDb: () => ({
  collection: (name: string) => ({ doc: (id: string) => ({ key: `${name}/${id}` }), where: () => ({ query: true }) }),
  runTransaction: async (fn: (txn: { get: (ref: { key?: string; query?: boolean }) => Promise<unknown>; set: (ref: { key: string }, value: Record<string, unknown>) => void }) => Promise<unknown>) => fn({
    get: async ref => ref.query ? { docs: mockUnresolved } : { exists: mockDocuments.has(ref.key!), data: () => mockDocuments.get(ref.key!) },
    set: (ref, value) => { mockDocuments.set(ref.key, value); },
  }),
}) }));
import { Wallet, JsonRpcProvider, Transaction, keccak256, type JsonRpcPayload, type JsonRpcResult } from 'ethers';
import { CanonicalWallet } from './canonical-wallet';
import type { NonceJournal, NonceJournalStore } from './canonical-nonce';
import { assertServerWriterCutover } from './server-writer-cutover';
const KEY = `0x${'13'.repeat(32)}`;
const TO = `0x${'ab'.repeat(20)}`;
const HASH = `0x${'01'.repeat(32)}`;
class RecordingProvider extends JsonRpcProvider {
  readonly calls: { method: string; params: unknown[] }[] = [];
  onWire: (raw: string) => void = () => undefined;
  constructor() { super('http://recording.invalid', 8453, { staticNetwork: true, cacheTimeout: -1, batchMaxCount: 1 }); }
  override async _send(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<JsonRpcResult[]> {
    return (Array.isArray(payload) ? payload : [payload]).map(p => {
      const params = p.params as unknown[];
      this.calls.push({ method: p.method, params });
      if (params.some(v => v === 'pending')) throw new Error('pending RPC is unavailable');
      let result: unknown;
      switch (p.method) {
        case 'eth_chainId': result = '0x2105'; break;
        case 'eth_getTransactionCount': result = '0x0'; break;
        case 'eth_blockNumber': result = '0x100'; break;
        case 'eth_estimateGas': result = '0x5208'; break;
        case 'eth_gasPrice': result = '0x2'; break;
        case 'eth_maxPriorityFeePerGas': result = '0x1'; break;
        case 'eth_getBlockByNumber': result = { number: '0x100', hash: HASH, parentHash: HASH, nonce: '0x0000000000000000',
          difficulty: '0x0', gasLimit: '0x1c9c380', gasUsed: '0x0', timestamp: '0x64', extraData: '0x', miner: TO,
          transactions: [], baseFeePerGas: '0x1' }; break;
        case 'eth_getTransactionReceipt': result = null; break;
        case 'eth_sendRawTransaction': this.onWire(String(params[0])); result = keccak256(String(params[0])); break;
        default: throw new Error(`unexpected RPC ${p.method}`);
      }
      return { id: p.id, result };
    });
  }
}
function rig() {
  const docs = new Map<string, NonceJournal>();
  const store: NonceJournalStore = { transact: async (key, change) => { const next = change(docs.get(key) ?? null); docs.set(key, next); return next; } };
  const provider = new RecordingProvider();
  return { docs, provider, wallet: new CanonicalWallet(KEY, provider, store) };
}
describe('server signer explicit canonical preparation and durable wire ordering', () => {
  it('ethers never requests pending; every wire transaction has durable recovery bytes', async () => {
    const r = rig();
    r.provider.onWire = raw => {
      const tx = Transaction.from(raw);
      const attempt = [...r.docs.values()].flatMap(d => d.attempts).find(a => a.hash === tx.hash);
      expect(attempt?.raw).toBe(raw); expect(attempt?.ready).toBe(true);
    };
    const first = await r.wallet.sendTransaction({ to: TO, value: 1n });
    const second = await r.wallet.sendTransaction({ to: TO, value: 1n });
    expect([first.nonce, second.nonce]).toEqual([0, 1]);
    expect(first.hash).not.toBe(second.hash);
    expect(r.provider.calls.some(c => c.params.includes('pending'))).toBe(false);
    expect(r.provider.calls.filter(c => c.method === 'eth_sendRawTransaction').length).toBeGreaterThanOrEqual(2);
    r.provider.destroy();
  });
  it('prepares without wire and resumes only the business-bound signed bytes after persistence', async () => {
    const r = rig();
    const prepared = await r.wallet.prepareCanonicalTransaction({ to: TO, data: '0x1234', value: 0n }, 'operation_1');
    expect(r.provider.calls.filter(c => c.method === 'eth_sendRawTransaction')).toHaveLength(0);
    expect(prepared.ready).toBe(false);
    await expect(r.wallet.sendTransaction({ to: TO, value: 5n })).rejects.toThrow('nonce_uncommitted_attempt');
    const resumed = await r.wallet.prepareCanonicalTransaction({ to: TO, data: '0x1234', value: 0n }, 'operation_1');
    expect(resumed.raw).toBe(prepared.raw);
    await r.wallet.broadcastCanonicalTransaction(prepared.raw);
    expect(r.provider.calls.filter(c => c.method === 'eth_sendRawTransaction').map(c => c.params[0])).toEqual([prepared.raw]);
    r.provider.destroy();
  });
  it('runtime cutover refuses missing/future/not-drained activation and accepts the exact protocol', () => {
    for (const bad of [null, {}, { active: true }, { protocol: 'canonical-nonce-v1', active: true, old_writers_drained_at_ms: 20, activated_at_ms: 10 },
      { protocol: 'canonical-nonce-v1', active: true, old_writers_drained_at_ms: 10, activated_at_ms: 30 }]) {
      expect(() => assertServerWriterCutover(bad, 20)).toThrow('cutover_not_active');
    }
    expect(() => assertServerWriterCutover({ protocol: 'canonical-nonce-v1', active: true, old_writers_drained_at_ms: 10, activated_at_ms: 15 }, 20)).not.toThrow();
  });
  it('adopts an existing outbox without changing its bytes; refuses an unowned nonce gap', async () => {
    const r = rig();
    const legacy = new Wallet(KEY);
    const raw = await legacy.signTransaction({ to: TO, data: '0x1234', value: 0n, chainId: 8453,
      type: 2, nonce: 0, gasLimit: 40000, maxFeePerGas: 2, maxPriorityFeePerGas: 1 });
    await r.wallet.broadcastCanonicalTransaction(raw);
    expect(r.provider.calls.filter(c => c.method === 'eth_sendRawTransaction').map(c => c.params[0])).toEqual([raw]);
    expect([...r.docs.values()][0].attempts[0].raw).toBe(raw);
    const gap = await legacy.signTransaction({ to: TO, value: 1n, chainId: 8453,
      type: 2, nonce: 3, gasLimit: 21000, maxFeePerGas: 2, maxPriorityFeePerGas: 1 });
    await expect(r.wallet.broadcastCanonicalTransaction(gap)).rejects.toThrow('nonce_override_conflicts_with_journal');
    expect(r.provider.calls.filter(c => c.method === 'eth_sendRawTransaction').every(c => c.params[0] === raw)).toBe(true);
    r.provider.destroy();
  });
  it('recovers a crashed expired Firestore owner before inspecting its saved business attempt', async () => {
    mockDocuments.clear(); mockUnresolved.length = 0;
    const r = rig(); const address = r.wallet.address.toLowerCase(); const key = `8453_${address}`;
    const raw = await new Wallet(KEY).signTransaction({ to: TO, chainId: 8453, type: 2,
      nonce: 0, value: 0n, gasLimit: 21000, maxFeePerGas: 2, maxPriorityFeePerGas: 1 });
    mockDocuments.set(`evm_signer_nonce_journals_v1/${key}`, { version: 1, next: 1,
      attempts: [{ nonce: 0, hash: keccak256(raw), raw, intent: 'previous-business', ready: false }], owner: 'crashed-worker', leaseUntil: 1 });
    mockDocuments.set(`pvt9_settlement_signer_leases_v1/${address}`, { owner: 'crashed-worker', expires_at_ms: 1 });
    mockDocuments.set('evm_server_writer_cutovers_v1/base_canonical_nonce', { protocol: 'canonical-nonce-v1', active: true, old_writers_drained_at_ms: 0, activated_at_ms: 0 });
    await new CanonicalWallet(KEY, r.provider).broadcastCanonicalTransaction(raw);
    expect(r.provider.calls.filter(c => c.method === 'eth_sendRawTransaction').map(c => c.params[0])).toEqual([raw]);
    expect(mockDocuments.get(`evm_signer_nonce_journals_v1/${key}`)?.owner).toBeNull();
    expect(mockDocuments.get(`pvt9_settlement_signer_leases_v1/${address}`)?.expires_at_ms).toBe(0);
    // A batch whose signer cannot be established must never be treated as another key.
    mockUnresolved.push({ data: () => ({ cycle_id: 'missing-cycle' }) });
    await expect(new CanonicalWallet(KEY, r.provider).sendTransaction({ to: TO, value: 1n })).rejects.toThrow('nonce_settlement_cycle_invalid');
    r.provider.destroy();
  });

});
