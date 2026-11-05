import { readCommonCanonicalHead } from './common-canonical-head';
import { readAgreedBaseHead, verifyBaseTransactionEvidence } from './economic-discovery';
import { verifyBaseEconomicTransactionFinality } from './economic-finality';
import type { EconomicStateRpcLeg } from './economic-state';

const q = (n: number): string => `0x${n.toString(16)}`;
const h = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;
const tx = h(1), from = '0x1111111111111111111111111111111111111111', to = '0x2222222222222222222222222222222222222222';

function fixture(tip = 112, change?: (side: number, method: string, params: readonly unknown[], value: unknown) => unknown) {
  let ticks = 0;
  const calls: Array<{ side: number; method: string; params: readonly unknown[] }> = [];
  const block = (height: number) => ({ number: q(height), hash: h(height), parentHash: h(height - 1), timestamp: q(1_700_000_000 + Math.floor(height / 5)) });
  const legs = [0, 1].map(side => ({ operatorId: `independent-${side}`, send: async (method: string, params: readonly unknown[]): Promise<unknown> => {
    calls.push({ side, method, params });
    let value: unknown;
    if (method === 'eth_chainId') value = q(8453);
    else if (method === 'eth_blockNumber') { value = q(tip + Math.floor(ticks / 2) - side); ticks++; }
    else if (method === 'eth_getBlockByNumber') value = block(params[0] === 'safe' ? 111 : Number(params[0]));
    else if (method === 'eth_getBlockByHash') value = block(100);
    else if (method === 'eth_getTransactionReceipt') value = { transactionHash: tx, blockHash: h(100), blockNumber: q(100), status: '0x1', from, to, logs: [] };
    else if (method === 'eth_getTransactionByHash') value = { hash: tx, blockHash: h(100), blockNumber: q(100), from, to, value: '0x1', input: '0x' };
    else throw new Error(`unexpected ${method}`);
    return change ? change(side, method, params, value) : value;
  } })) as [EconomicStateRpcLeg, EconomicStateRpcLeg];
  return { legs, calls };
}

describe('canonical agreement with advancing 200ms provider tips', () => {
  it('uses the lower tip only after exact common-height hash agreement', async () => {
    const f = fixture();
    expect(await readAgreedBaseHead({ rpcLegs: f.legs, disagreementRetry: { attempts: 1 } })).toBe(111);
    expect(f.calls.filter(call => call.method === 'eth_getBlockByNumber').map(call => call.params)).toEqual([['0x6f', false], ['0x6f', false]]);
  });
  it('preserves whole-transaction and burn finality with persistent one-block provider lag', async () => {
    const ordinary = fixture();
    const evidence = await verifyBaseTransactionEvidence({ transactionHash: tx }, { rpcLegs: ordinary.legs, disagreementRetry: { attempts: 1 } });
    expect(evidence).toMatchObject({ blockNumber: 100, confirmationFloor: 12, transactionHash: tx });
    const aligned = fixture(112, (_side, method, _params, value) => method === 'eth_blockNumber' ? '0x70' : value);
    expect(evidence).toEqual(await verifyBaseTransactionEvidence({ transactionHash: tx }, { rpcLegs: aligned.legs }));
    const burn = await verifyBaseEconomicTransactionFinality(tx, { rpcLegs: fixture().legs });
    expect(burn.evidence).toMatchObject({ blockNumber: 100, headBlockNumber: 112, confirmations: 13 });
  });
  it('a faster provider cannot turn the common eleven-confirmation height into twelve', async () => {
    await expect(verifyBaseEconomicTransactionFinality(tx, { rpcLegs: fixture(110).legs })).rejects.toThrow('confirmations_pending');
  });
  it.each(['hash', 'missing', 'height', 'malformed', 'unsafe'] as const)('refuses %s common-height evidence', async fault => {
    const f = fixture(112, (side, method, _params, raw) => {
      if (method === 'eth_blockNumber' && fault === 'unsafe') return '0x20000000000000';
      if (side !== 1 || method !== 'eth_getBlockByNumber') return raw;
      if (fault === 'missing') return null;
      return { ...(raw as Record<string, unknown>), ...(fault === 'hash' ? { hash: h(999) }
        : fault === 'height' ? { number: '0x6e' } : fault === 'malformed' ? { hash: '0x12' } : {}) };
    });
    await expect(readCommonCanonicalHead(f.legs)).rejects.toThrow('canonical_head_rpc_disagreement');
  });
  it('keeps the inexpensive quantity-only path when both tips agree', async () => {
    const f = fixture(112, (_side, method, _params, raw) => method === 'eth_blockNumber' ? '0x6f' : raw);
    expect(await readCommonCanonicalHead(f.legs)).toBe(111n);
    expect(f.calls.map(call => call.method)).toEqual(['eth_blockNumber', 'eth_blockNumber']);
  });
});
