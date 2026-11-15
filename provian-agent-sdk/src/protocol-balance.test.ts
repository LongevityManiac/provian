import { describe, it, expect, vi } from 'vitest';
import { readConfirmedProtocolBalance } from './protocol-balance';
import type { ProtocolDeployment } from './protocol-pointer';
const hint = { revision: 1n, manifestHash: 'manifest', pointer: 'pointer', addresses: { kernel: '0xToken' } } as ProtocolDeployment;
describe('speculative balance acceptance', () => {
  it('reserves balance confirmation before later history reads enter the serial queue', async () => {
    const order: string[] = [];
    let tail = Promise.resolve();
    const enqueue = (label: string) => {
      const work = tail.then(() => { order.push(label); return hint; });
      tail = work.then(() => {});
      return work;
    };
    const balance = readConfirmedProtocolBalance(() => enqueue('candidate'),
      () => enqueue('balance confirmation'), async () => 'balance');
    const history = [enqueue('Base history'), enqueue('Arbitrum history'), enqueue('Optimism history')];
    expect(await balance).toBe('balance');
    await Promise.all(history);
    expect(order).toEqual(['candidate', 'balance confirmation', 'Base history', 'Arbitrum history', 'Optimism history']);
  });
  it('starts the read during confirmation but holds its result until confirmation succeeds', async () => {
    let release!: (value: ProtocolDeployment) => void;
    const current = () => new Promise<ProtocolDeployment>(resolve => { release = resolve; });
    const read = vi.fn(async () => 'balance'); let done = false;
    const result = readConfirmedProtocolBalance(async () => hint, current, read).then(x => { done = true; return x; });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(read).toHaveBeenCalledWith('0xtoken'); expect(done).toBe(false);
    release(hint); expect(await result).toBe('balance');
  });
  it('rejects a completed read if confirmation fails', async () => {
    await expect(readConfirmedProtocolBalance(async () => hint, async () => { throw Error('changed'); }, async () => 'balance')).rejects.toThrow('changed');
  });
  it.each(['revision','manifestHash','token'] as const)('discards the old response when %s changes', async field => {
    const changed = { ...hint, ...(field === 'revision' ? { revision: 2n } : field === 'manifestHash' ? { manifestHash: 'new' } : { addresses: { ...hint.addresses, kernel: '0xNew' } }) };
    const read = vi.fn().mockResolvedValueOnce('discard').mockResolvedValueOnce('fresh');
    expect(await readConfirmedProtocolBalance(async () => hint, async () => changed, read)).toBe('fresh');
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenLastCalledWith(changed.addresses.kernel.toLowerCase());
  });
  it('handles no hint and never treats a failed read as a balance', async () => {
    const read = vi.fn(async () => 'fresh');
    expect(await readConfirmedProtocolBalance(async () => undefined, async () => hint, read)).toBe('fresh');
    expect(read).toHaveBeenCalledTimes(1);
    await expect(readConfirmedProtocolBalance(async () => hint, async () => hint, async () => { throw Error('network'); })).rejects.toThrow('read_failed');
  });
});
