export interface TimedBlock {
  readonly number: number;
  readonly timestamp: number;
}

/** First canonical height whose seconds timestamp is >= target, or head+1. */
export async function firstBlockAtOrAfter(
  read: (height: number) => Promise<TimedBlock | null>,
  head: TimedBlock,
  targetSeconds: number,
): Promise<number> {
  if (!Number.isSafeInteger(head.number) || head.number < 0
    || !Number.isSafeInteger(head.timestamp) || !Number.isSafeInteger(targetSeconds)) {
    throw new Error('block_time_search_invalid');
  }
  if (head.timestamp < targetSeconds) return head.number + 1;
  let low = 0;
  let high = head.number;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const block = await read(middle);
    if (block === null || block.number !== middle || !Number.isSafeInteger(block.timestamp)
      || block.timestamp < 0 || block.timestamp > head.timestamp) throw new Error('block_time_search_unavailable');
    if (block.timestamp < targetSeconds) low = middle + 1;
    else high = middle;
  }
  return low;
}
