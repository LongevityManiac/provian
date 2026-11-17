/**
 * The one rule for what counts as a Replication Pack. A pack is evidence only when it is whole:
 * its input, output and pack hashes are each present and each a SHA-256 digest. A pack with any of
 * the three missing or malformed is no pack, and earns no attestation-tier upgrade anywhere.
 */

/** A SHA-256 digest as a Replication Pack carries it: 64 hex digits, bare or `sha256:` / `0x` prefixed. */
export const REPLICATION_PACK_HASH = /^(?:sha256:|0x)?[0-9a-f]{64}$/i;

export function isReplicationPackHash(value: unknown): value is string {
  return typeof value === 'string' && REPLICATION_PACK_HASH.test(value);
}

/** Whether a pack carries all three hashes, each well formed. */
export function hasCompleteReplicationPackHashes(
  pack: { readonly input_hash?: unknown; readonly output_hash?: unknown; readonly pack_hash?: unknown } | null | undefined,
): boolean {
  return pack !== null && pack !== undefined
    && isReplicationPackHash(pack.input_hash)
    && isReplicationPackHash(pack.output_hash)
    && isReplicationPackHash(pack.pack_hash);
}
