import { rpcChainFactsEqual } from './rpc-chain-facts';

describe('canonical RPC facts with optional millisecond annotations', () => {
  const log = { blockHash: 'same', transactionHash: 'tx', logIndex: '0x1', removed: false, data: '0x01' };
  it.each([
    [{ number: '0x1', timestamp: '0x2' }, { number: '0x1', timestamp: '0x2', timestampMs: '0x898' }],
    [{ logs: [log] }, { logs: [{ ...log, blockTimestampMs: '0x898' }] }],
    [[log], [{ ...log, blockTimestampMs: '0x898' }]],
    [{ transactions: [{ hash: 'tx' }] }, { timestampMs: '0x898', transactions: [{ hash: 'tx', blockTimestampMs: '0x898' }] }],
  ])('allows absent optional metadata, in either direction', (a, b) => {
    expect(rpcChainFactsEqual(a, b)).toBe(true);
    expect(rpcChainFactsEqual(b, a)).toBe(true);
  });
  it('refuses contradictory or malformed optional fields', () => {
    expect(rpcChainFactsEqual({ timestampMs: '0x1' }, { timestampMs: '0x2' })).toBe(false);
    expect(rpcChainFactsEqual({}, { timestampMs: 'bad' })).toBe(false);
  });
  it.each(['blockHash', 'transactionHash', 'logIndex', 'data', 'removed'])('RED: still refuses a changed %s', (key) => {
    expect(rpcChainFactsEqual({ logs: [log] }, { logs: [{ ...log, [key]: 'changed', blockTimestampMs: '0x898' }] })).toBe(false);
  });
  it('refuses missing authoritative/unknown fields and reordered logs', () => {
    expect(rpcChainFactsEqual({ number: '0x1' }, {})).toBe(false);
    expect(rpcChainFactsEqual({}, { futureFact: 1 })).toBe(false);
    expect(rpcChainFactsEqual([log, { ...log, data: '0x02' }], [{ ...log, data: '0x02' }, log])).toBe(false);
  });
});
