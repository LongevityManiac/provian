import { JsonRpcProvider } from 'ethers';
import { rpcHostLabel, withRpcUsage, installRpcUsageMeter } from './rpc-usage-meter';

// A provider whose transport is local: `_send` is replaced per instance below the
// prototype patch, so the meter (on the prototype) is what these tests exercise.
function localProvider(url: string): JsonRpcProvider {
  const provider = new JsonRpcProvider(url, 8453, { staticNetwork: true, batchMaxCount: 1 });
  return provider;
}

describe('rpc usage meter', () => {
  const realSend = JsonRpcProvider.prototype._send;
  beforeAll(() => {
    // Stand-in transport under the meter: answer every payload without a network.
    JsonRpcProvider.prototype._send = async function fake(payload) {
      const items = Array.isArray(payload) ? payload : [payload];
      return items.map(item => ({ id: item.id, result: item.method === 'eth_blockNumber' ? '0x10' : '0x' }));
    };
  });
  afterAll(() => { JsonRpcProvider.prototype._send = realSend; });

  it('labels providers by host only and never by the key-bearing path', () => {
    expect(rpcHostLabel('https://base-mainnet.g.alchemy.com/v2/SECRETKEY')).toBe('base-mainnet.alchemy');
    expect(rpcHostLabel('https://lb.drpc.org/ogrpc?network=base&dkey=SECRET')).toBe('drpc');
    expect(rpcHostLabel('not a url')).toBe('other');
    expect(rpcHostLabel('https://example.com/SECRET')).toBe('other');
  });

  it('RED control: before installation nothing is counted', async () => {
    const provider = localProvider('https://base-mainnet.g.alchemy.com/v2/k');
    const { calls } = await withRpcUsage(async () => { await provider.send('eth_blockNumber', []); });
    expect(calls).toEqual({});
  });

  it('counts each call by provider and method inside the request that made it', async () => {
    installRpcUsageMeter();
    const alchemy = localProvider('https://base-mainnet.g.alchemy.com/v2/k');
    const drpc = localProvider('https://lb.drpc.org/ogrpc?network=base&dkey=k');
    const { calls } = await withRpcUsage(async () => {
      await alchemy.send('eth_blockNumber', []);
      await alchemy.send('eth_call', [{ to: '0x0000000000000000000000000000000000000001', data: '0x' }, 'latest']);
      await alchemy.send('eth_call', [{ to: '0x0000000000000000000000000000000000000001', data: '0x' }, 'latest']);
      await drpc.send('eth_getLogs', [{}]);
    });
    expect(calls).toEqual({ 'base-mainnet.alchemy eth_blockNumber': 1, 'base-mainnet.alchemy eth_call': 2, 'drpc eth_getLogs': 1 });
    // Nothing leaks across requests: a call outside any request is not counted anywhere.
    await alchemy.send('eth_blockNumber', []);
    const { calls: next } = await withRpcUsage(async () => undefined);
    expect(next).toEqual({});
  });
});
