/**
 * F46 — fail-closed selection of the users doc that POST /v1/users/recover should
 * rotate credentials for, given the users docs matching a wallet_address and the
 * set of user ids that own a first-party human `wallets` doc for that address.
 *
 * The old recover query used `.limit(1)`, so when several users docs carried the
 * same address (a legacy state, or the squat the wallet_address-persist fix now
 * prevents at the source) it rotated an ARBITRARY one — an attacker's shell doc
 * could win. This decides fail-closed.
 *
 * (moto restore): the HUMAN WALLET OWNER IS AUTHORITATIVE. A `wallets` doc of
 * type 'human' is written only through the authenticated register path, under an
 * address-uniqueness index, so it is the relay's own record of whose wallet this
 * address is. `users.wallet_address` is a best-effort denormalization that
 * pre-F46 accounts never carried — matching ONLY on it sent a real key holder
 * whose users doc lacked the field down the "no existing user" branch, which
 * minted a fresh shell user with no human wallet (every human-wallet route then
 * 404s "no first-party human wallet found for this account"). So:
 * - exactly one owner → that user, whether or not its users doc carries the
 * address (`owner` when it does not, so the caller loads and backfills it);
 * - more than one owner → ambiguous (refuse);
 * - no owner → the F46 users-doc rule: one match → it, several → ambiguous.
 * Pure so the fail-closed rule is unit-testable.
 */

export type RecoverySelection =
  | { kind: 'none' }
  | { kind: 'unique'; user: Record<string, unknown> }
  | { kind: 'owner'; userId: string }
  | { kind: 'ambiguous' };

export function selectRecoveryUser(
  matches: readonly { id: string; data: Record<string, unknown> }[],
  humanOwnerUserIds: ReadonlySet<string>,
): RecoverySelection {
  if (humanOwnerUserIds.size > 1) return { kind: 'ambiguous' };
  if (humanOwnerUserIds.size === 1) {
    const [ownerId] = [...humanOwnerUserIds];
    const matched = matches.find((m) => m.id === ownerId);
    return matched ? { kind: 'unique', user: matched.data } : { kind: 'owner', userId: ownerId };
  }
  if (matches.length === 0) return { kind: 'none' };
  if (matches.length === 1) return { kind: 'unique', user: matches[0].data };
  return { kind: 'ambiguous' };
}

/** The narrow Firestore surface the recovery lookup reads — a real `Firestore` satisfies it. */
export interface RecoveryLookupDb {
  collection(name: string): {
    where(field: string, op: '==', value: unknown): {
      limit(n: number): { get(): Promise<{ size: number; docs: { id: string; data(): unknown }[] }> };
    };
    doc(id: string): { get(): Promise<{ exists: boolean; id: string; data(): unknown }> };
  };
}

export type RecoveryLookup =
  | { kind: 'existing'; user: Record<string, unknown> & { id: string } }
  | { kind: 'none' }
  | { kind: 'ambiguous'; usersMatched: number; owners: number }
  | { kind: 'owner_missing'; userId: string };

/**
 * The route's whole account lookup, executable under test: users docs by the
 * lowercased address, the `type: 'human'` wallets owners by BOTH address cases
 * (wallets addresses are not uniformly lowercased), the selector, and the owner
 * load. Only a `type: 'human'` wallets doc names an owner — agent wallets docs may
 * carry a `user_id`, and counting them would hand an agent's key holder that
 * human's account.
 */
export async function lookupRecoveryUser(
  db: RecoveryLookupDb,
  walletAddress: string,
): Promise<RecoveryLookup> {
  const addressLc = walletAddress.toLowerCase();
  const [matchingUsers, ...walletMatches] = await Promise.all([
    db.collection('users').where('wallet_address', '==', addressLc).limit(25).get(),
    db.collection('wallets').where('address', '==', addressLc).limit(25).get(),
    db.collection('wallets').where('address', '==', walletAddress).limit(25).get(),
  ]);
  const owners = new Set<string>();
  for (const q of walletMatches) {
    for (const d of q.docs) {
      const w = d.data() as { user_id?: unknown; type?: unknown; displaced_at_ms?: unknown; released_at_ms?: unknown } | undefined;
      // a registration the address's key holder DISPLACED (it was never proven), or one
      // its owner RELEASED by deleting their data, names no owner — counting it would make the
      // real owner's recovery ambiguous, or hand them the displaced account.
      if (w?.displaced_at_ms !== undefined || w?.released_at_ms !== undefined) continue;
      if (w?.type === 'human' && typeof w.user_id === 'string' && w.user_id.length > 0) owners.add(w.user_id);
    }
  }
  const selection = selectRecoveryUser(
    matchingUsers.docs.map((d) => ({ id: d.id, data: (d.data() ?? {}) as Record<string, unknown> })),
    owners,
  );
  switch (selection.kind) {
    case 'ambiguous':
      return { kind: 'ambiguous', usersMatched: matchingUsers.size, owners: owners.size };
    case 'none':
      return { kind: 'none' };
    case 'unique': {
      const id = selection.user.id;
      if (typeof id !== 'string' || id.length === 0) {
        return { kind: 'ambiguous', usersMatched: matchingUsers.size, owners: owners.size };
      }
      return { kind: 'existing', user: { ...selection.user, id } };
    }
    case 'owner': {
      // Unknown = block: the human wallet names an owner whose users doc is gone.
      // Minting a fresh account would orphan the wallet again.
      const ownerDoc = await db.collection('users').doc(selection.userId).get();
      if (!ownerDoc.exists) return { kind: 'owner_missing', userId: selection.userId };
      return { kind: 'existing', user: { ...((ownerDoc.data() ?? {}) as Record<string, unknown>), id: ownerDoc.id } };
    }
  }
}
