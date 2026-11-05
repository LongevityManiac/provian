import { firstBlockAtOrAfter } from './block-time-search';

describe('canonical timestamp boundaries across block cadence changes', () => {
  const timestamp = (n: number) => n < 100 ? n * 2 : 200 + Math.floor((n - 100) / 5);
  const head = { number: 1000, timestamp: timestamp(1000) };
  it.each([0, 100, 199, 200, 201, 300, 380, 381])('finds the first height at second %s', async (second) => {
    const read = jest.fn(async (height: number) => ({ number: height, timestamp: timestamp(height) }));
    const actual = await firstBlockAtOrAfter(read, head, second);
    const expected = Array.from({ length: 1001 }, (_, n) => n).find((n) => timestamp(n) >= second) ?? 1001;
    expect(actual).toBe(expected);
    expect(read.mock.calls.length).toBeLessThanOrEqual(10);
  });
  it('RED: does not interpolate two-second heights or skip equal-second blocks', async () => {
    const first = await firstBlockAtOrAfter(async (n) => ({ number: n, timestamp: timestamp(n) }), head, 201);
    expect(first).toBe(105);
    expect(first).not.toBe(head.number - Math.ceil((head.timestamp - 201) / 2));
  });
  it('refuses a missing or foreign block rather than guessing', async () => {
    await expect(firstBlockAtOrAfter(async () => null, head, 201)).rejects.toThrow('unavailable');
    await expect(firstBlockAtOrAfter(async () => ({ number: 999, timestamp: 1 }), head, 201)).rejects.toThrow('unavailable');
  });
});
