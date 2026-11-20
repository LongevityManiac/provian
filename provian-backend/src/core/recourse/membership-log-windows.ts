import { getAgreedBaseLogs } from '../onchain/economic-discovery';

/** Read the full range through both operators, in bounded parallel batches.
 * Yield in block order so callers can check continuity before applying evidence. */
export async function* readMembershipLogWindows(address: string, topics: readonly string[], fromBlock: number, toBlock: number) {
  const blocksPerWindow = 500, concurrentWindows = 4;
  for (let first = fromBlock; first <= toBlock; first += blocksPerWindow * concurrentWindows) {
    const length = Math.min(concurrentWindows, Math.floor((toBlock - first) / blocksPerWindow) + 1);
    const windows = await Promise.all(Array.from({ length }, async (_, index) => {
      const start = first + index * blocksPerWindow, end = Math.min(start + blocksPerWindow - 1, toBlock);
      const logs = await getAgreedBaseLogs({ address, topics: [topics], fromBlock: start, toBlock: end });
      return { start, end, logs };
    }));
    yield* windows;
  }
}
