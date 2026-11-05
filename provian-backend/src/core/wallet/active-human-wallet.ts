/**
 * A human wallet that can stand behind an act: a first-party human wallet with a
 * usable address and an owner, never released by its owner (DELETE /v1/user/data),
 * never displaced by its address's key holder, and not carrying a
 * non-active status. Anything else — or a shape this code does not recognise — is
 * not an active human wallet. Unknown = block.
 *
 * One definition, read by the person proof routes and every watcher's person-proven
 * enumeration.
 */

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function isActiveHumanWallet(data: unknown): data is Record<string, unknown> & {
  user_id: string;
} {
  if (data === null || typeof data !== 'object') return false;
  const w = data as Record<string, unknown>;
  return w.type === 'human'
    && typeof w.user_id === 'string'
    && w.user_id.length > 0
    && typeof w.address === 'string'
    && EVM_ADDRESS.test(w.address)
    && w.released_at_ms === undefined
    && w.displaced_at_ms === undefined
    && (w.status === undefined || w.status === 'active');
}
