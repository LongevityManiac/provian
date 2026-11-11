const address = /^0x[0-9a-fA-F]{40}$/;
const hash = /^0x[0-9a-f]{64}$/;
/** Preserve candidates needed to reconstruct prior unissued entitlements.
 * Merkle roots authenticate aggregate entitlements, not accounts[] metadata.
 * Consumers must independently verify every origin/root/cutoff and reconstruct
 * address partitions from the historical registry and canonical balances. */
export function carryBreakArtifacts(pending, priorArtifact) {
  if (!pending) return [];
  const older = priorArtifact?.breakArtifacts ?? [];
  if (!Array.isArray(older)) throw Error('snapshot_break_ancestry_invalid');
  const candidates = [{ origin: pending.origin, ownership: pending.snapshot }, ...older];
  const seen = new Map(), result = [];
  for (const candidate of candidates) {
    const origin = candidate?.origin, snapshot = candidate?.ownership;
    if (typeof origin !== 'string' || !address.test(origin) || /^0x0{40}$/i.test(origin)
      || snapshot?.format !== 'provian-break-ownership-snapshot' || !hash.test(snapshot.root)
      || typeof snapshot.predecessor !== 'string' || !address.test(snapshot.predecessor)
      || !Number.isSafeInteger(snapshot.block) || snapshot.block < 1 || !Array.isArray(snapshot.entries)) {
      throw Error('snapshot_break_ancestry_invalid');
    }
    const key = origin.toLowerCase(), domain = `${snapshot.root}:${snapshot.predecessor.toLowerCase()}:${snapshot.block}`;
    if (seen.has(key)) {
      if (seen.get(key) !== domain) throw Error('snapshot_break_ancestry_conflict');
      continue;
    }
    seen.set(key, domain); result.push(structuredClone({ origin: key, ownership: snapshot }));
  }
  return result;
}

/** Both snapshot modes retain the same authenticated-origin candidates. */
export function assembleSuccessionArtifact({ monetary, pool, ownership, pendingBreak, priorArtifact }) {
  if (!pool) {
    if (ownership) throw Error('snapshot_break_pool_required');
    return monetary;
  }
  const common = { chainId:8453, block:monetary.block, blockHash:monetary.blockHash, monetary, pool,
    breakArtifacts:carryBreakArtifacts(pendingBreak,priorArtifact) };
  if (ownership) return { format:'provian-break-snapshot', ...common, ownership, snapshotTotal:ownership.snapshotBalance };
  return { format:'provian-succession-bundle', ...common, breakOriginSnapshot:pendingBreak?.snapshot,
    pendingBreakOwners:pendingBreak?.owners, snapshotTotal:(BigInt(monetary.supply)+BigInt(pendingBreak?.amount??0)).toString() };
}
