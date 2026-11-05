/**
 * Base inclusion acceptance (`verifyBaseTransactionInclusion`).
 * RED controls: a mempool / replaced-nonce tx (no receipt) is refused; one leg disagreeing or lagging
 * is refused; the two legs are read CONCURRENTLY.
 */
import { verifyBaseTransactionInclusion, type EconomicFinalityRpcLeg } from './economic-finality';

const TX_HASH = `0x${'a'.repeat(64)}`;
const BLOCK_HASH = `0x${'b'.repeat(64)}`;
const OTHER_HASH = `0x${'d'.repeat(64)}`;
const FROM = '0x2222222222222222222222222222222222222222';

const receipt = (o: Record<string, unknown> = {}) => ({
  transactionHash: TX_HASH, blockHash: BLOCK_HASH, blockNumber: '0x64', status: '0x1', from: FROM, to: null, logs: [], ...o,
});
const block = (o: Record<string, unknown> = {}) => ({ number: '0x64', hash: BLOCK_HASH, parentHash: `0x${'c'.repeat(64)}`, timestamp: '0x1', ...o });

function leg(operatorId: string, o: { receipt?: unknown; canonical?: unknown; delay?: (m: string) => Promise<void> } = {}): EconomicFinalityRpcLeg {
  return {
    operatorId,
    send: jest.fn(async (method: string) => {
      if (o.delay) await o.delay(method);
      if (method === 'eth_chainId') return '0x2105';
      if (method === 'eth_getTransactionReceipt') return 'receipt' in o ? o.receipt : receipt();
      if (method === 'eth_getBlockByNumber') return 'canonical' in o ? o.canonical : block();
      throw new Error(`unexpected ${method}`);
    }),
  };
}

describe('verifyBaseTransactionInclusion', () => {
  it('accepts a receipt both legs agree on, in the block both hold canonical', async () => {
    const r = await verifyBaseTransactionInclusion(TX_HASH, { rpcLegs: [leg('op-a'), leg('op-b')] });
    expect(r.blockNumber).toBe(100);
    expect(r.blockHash).toBe(BLOCK_HASH);
    expect(r.providerOperatorIds).toEqual(['op-a', 'op-b']);
  });

  it('RED: a mempool / replaced-nonce tx (no receipt on either leg) is refused as absent', async () => {
    await expect(verifyBaseTransactionInclusion(TX_HASH, { rpcLegs: [leg('op-a', { receipt: null }), leg('op-b', { receipt: null })] }))
      .rejects.toThrow('economic_inclusion_receipt_absent');
  });

  it('RED: one leg without a receipt (lagging or lying) is refused', async () => {
    await expect(verifyBaseTransactionInclusion(TX_HASH, { rpcLegs: [leg('op-a'), leg('op-b', { receipt: null })] }))
      .rejects.toThrow('economic_inclusion_receipt_pending');
    await expect(verifyBaseTransactionInclusion(TX_HASH, { rpcLegs: [leg('op-a', { receipt: null }), leg('op-b')] }))
      .rejects.toThrow('economic_inclusion_receipt_pending');
  });

  it('RED: a single-provider disagreement on the receipt is refused', async () => {
    await expect(verifyBaseTransactionInclusion(TX_HASH, { rpcLegs: [leg('op-a'), leg('op-b', { receipt: receipt({ blockNumber: '0x65' }) })] }))
      .rejects.toThrow('economic_finality_rpc_disagreement:receipt');
  });

  it('RED: a single-provider disagreement on the canonical block is refused', async () => {
    await expect(verifyBaseTransactionInclusion(TX_HASH, { rpcLegs: [leg('op-a'), leg('op-b', { canonical: block({ hash: OTHER_HASH }) })] }))
      .rejects.toThrow('economic_finality_rpc_disagreement:canonical_receipt_block');
  });

  it('RED: a receipt from a block no longer canonical (reorged out) is refused', async () => {
    const canonical = block({ hash: OTHER_HASH });
    await expect(verifyBaseTransactionInclusion(TX_HASH, { rpcLegs: [leg('op-a', { canonical }), leg('op-b', { canonical })] }))
      .rejects.toThrow('economic_finality_receipt_block_not_canonical');
  });

  it('RED: a reverted tx is refused', async () => {
    const r = receipt({ status: '0x0' });
    await expect(verifyBaseTransactionInclusion(TX_HASH, { rpcLegs: [leg('op-a', { receipt: r }), leg('op-b', { receipt: r })] }))
      .rejects.toThrow('economic_finality_transaction_failed');
  });

  it('RED: two legs claiming the same operator are refused', async () => {
    await expect(verifyBaseTransactionInclusion(TX_HASH, { rpcLegs: [leg('op-a'), leg('op-a')] }))
      .rejects.toThrow('economic_finality_rpc_operators_not_independent');
  });

  it('both legs\' receipt lookups are in flight at once (concurrent, not serial)', async () => {
    const inFlight = new Set<string>();
    let maxReceiptConcurrency = 0;
    const gate = (id: string) => async (method: string) => {
      if (method !== 'eth_getTransactionReceipt') return;
      inFlight.add(id);
      maxReceiptConcurrency = Math.max(maxReceiptConcurrency, inFlight.size);
      // Each leg's receipt read resolves only once BOTH are in flight: a serial implementation
      // (await leg A, then ask leg B) would never see leg B start, and this test would time out.
      await new Promise<void>((resolve) => {
        const started = Date.now();
        // Bounded: a serial implementation gives up after 500 ms (and the assertion below fails),
        // instead of leaving a timer running.
        const poll = () => (inFlight.size === 2 || Date.now() - started > 500 ? resolve() : setTimeout(poll, 1));
        poll();
      });
      inFlight.delete(id);
    };
    const a = leg('op-a', { delay: gate('a') });
    const b = leg('op-b', { delay: gate('b') });
    await verifyBaseTransactionInclusion(TX_HASH, { rpcLegs: [a, b] });
    expect(maxReceiptConcurrency).toBe(2);
  });
});
