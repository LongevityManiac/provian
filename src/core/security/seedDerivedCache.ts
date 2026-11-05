/** Only loaded domain caches register here. No seed, grant or key is retained by this registry. */
const clearers = new Set<() => void>();
export function registerSeedDerivedCache(clear: () => void): void { clearers.add(clear); }
/** Clear before a seed mutation, including writes that may commit before later cleanup fails. */
export function invalidateSeedDerivedCaches(): void { for (const clear of clearers) clear(); }
