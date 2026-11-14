/** Reuse only a two-provider historical prefix whose canonical boundary is
 * rechecked on every read. Fresh suffixes and all signing/state checks remain
 * the caller's responsibility. Failed reads never advance the saved boundary. */
export function verifiedLogHistory({read, blockHash, finalizedBlock}) {
  const saved = new Map(), pending = new Map();
  return async (address, from, to, topics) => {
    const query = structuredClone({address, from, to, topics});
    const key = JSON.stringify([query.address, query.from, query.topics ?? null]);
    const previous = pending.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const final = await finalizedBlock();
      if (!Number.isSafeInteger(final.number) || final.number < 0) throw Error('snapshot_history_finality_invalid');
      const canonicalHash = async height => {
        const hash = await blockHash(height);
        if (typeof hash !== 'string' || !/^0x[0-9a-f]{64}$/.test(hash)) throw Error('snapshot_history_hash_invalid');
        return hash;
      };
      if (to > final.number || from > to) return read(query.address, from, to, query.topics);
      const old = saved.get(key), prefix = old && old.to <= to ? old : null;
      const checkPrefix = async () => {
        if (prefix && await canonicalHash(prefix.to) !== prefix.hash) throw Error('snapshot_history_reorg');
      };
      await checkPrefix();
      const targetHash = await canonicalHash(to);
      const suffix = prefix && prefix.to === to ? []
        : await read(query.address, prefix ? prefix.to + 1 : from, to, query.topics);
      await checkPrefix();
      if (await canonicalHash(to) !== targetHash) throw Error('snapshot_history_reorg');
      const logs = [...(prefix?.logs ?? []), ...suffix];
      if (!old || to >= old.to) saved.set(key, {to, hash: targetHash, logs: structuredClone(logs)});
      return structuredClone(logs);
    });
    pending.set(key, operation);
    try {return await operation;} finally {if(pending.get(key) === operation) pending.delete(key);}
  };
}
