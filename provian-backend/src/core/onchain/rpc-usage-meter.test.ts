import { JsonRpcProvider, FetchRequest } from 'ethers';
import { rpcHostLabel, withRpcUsage, installRpcUsageMeter } from './rpc-usage-meter';
import { LinearDecodeJsonRpcProvider } from './rpc-provider';

// The relay's own provider class, as buildJsonRpc constructs it, with its transport
// replaced so no network is used. The meter sits above the transport.
function relayProvider(url: string, batchMaxCount?: number): JsonRpcProvider {
  return new LinearDecodeJsonRpcProvider(new FetchRequest(url), 8453, { staticNetwork: true, ...(batchMaxCount ? { batchMaxCount } : {}) });
}

describe('rpc usage meter', () => {
  const realSend = LinearDecodeJsonRpcProvider.prototype._send;
  beforeAll(() => {
    LinearDecodeJsonRpcProvider.prototype._send = async function fake(payload) {
      const items = Array.isArray(payload) ? payload : [payload];
      await new Promise(resolve => setTimeout(resolve, 5));
      return items.map(item => ({ id: item.id, result: item.method === 'eth_blockNumber' ? '0x10' : '0x' }));
    };
  });
  afterAll(() => { LinearDecodeJsonRpcProvider.prototype._send = realSend; });

  it('labels providers by host only and never by the key-bearing path', () => {
    expect(rpcHostLabel('https://base-mainnet.g.alchemy.com/v2/SECRETKEY')).toBe('base-mainnet.alchemy');
    expect(rpcHostLabel('https://lb.drpc.org/ogrpc?network=base&dkey=SECRET')).toBe('drpc');
    expect(rpcHostLabel('not a url')).toBe('other');
    expect(rpcHostLabel('https://example.com/SECRET')).toBe('other');
  });

  it('RED control: before installation nothing is counted', async () => {
    const provider = relayProvider('https://base-mainnet.g.alchemy.com/v2/k', 1);
    const { calls } = await withRpcUsage(async () => { await provider.send('eth_blockNumber', []); });
    expect(calls).toEqual({});
  });

  it('counts the relay provider class by provider and method inside the request that made each call', async () => {
    installRpcUsageMeter();
    const alchemy = relayProvider('https://base-mainnet.g.alchemy.com/v2/k', 1);
    const drpc = relayProvider('https://lb.drpc.org/ogrpc?network=base&dkey=k', 1);
    const { calls } = await withRpcUsage(async () => {
      await alchemy.send('eth_blockNumber', []);
      await Promise.all([alchemy.send('eth_call', [{}, 'latest']), alchemy.send('eth_call', [{}, 'latest'])]);
      await drpc.send('eth_getLogs', [{}]);
    });
    expect(calls).toEqual({ 'base-mainnet.alchemy eth_blockNumber': 1, 'base-mainnet.alchemy eth_call': 2, 'drpc eth_getLogs': 1 });
    await alchemy.send('eth_blockNumber', []); // outside any request: counted nowhere
    expect((await withRpcUsage(async () => undefined)).calls).toEqual({});
  });

  it('concurrent requests on one shared, batching provider are each charged only their own calls', async () => {
    installRpcUsageMeter();
    const shared = relayProvider('https://arb-mainnet.g.alchemy.com/v2/k'); // default batching, shared drain timer
    const [a, b] = await Promise.all([
      withRpcUsage(async () => { await Promise.all([shared.send('eth_getLogs', [{}]), shared.send('eth_call', [{}, 'latest'])]); }),
      withRpcUsage(async () => { await shared.send('eth_blockNumber', []); }),
    ]);
    expect(a.calls).toEqual({ 'arb-mainnet.alchemy eth_getLogs': 1, 'arb-mainnet.alchemy eth_call': 1 });
    expect(b.calls).toEqual({ 'arb-mainnet.alchemy eth_blockNumber': 1 });
  });
});
