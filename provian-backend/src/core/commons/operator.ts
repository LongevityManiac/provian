/**
 * Provian Commons — Operator identity + announcements channel config.
 *
 * Kept in its own module (imported by BOTH forum.ts and announcements.ts) so
 * the operator-write guard can live at the shared post-creation path in forum.ts
 * without a circular import against announcements.ts.
 *
 * AUTHORITY BOUNDARY: `OPERATOR_COMMONS_WALLETS` is a COMMS allowlist only. It
 * authorizes posting to the `announcements` channel and broadcasting a
 * notification about it — nothing economic, mint, settlement, or custodial. It
 * is separate from the PVT9 admin EOA. Fail-closed: unset/empty ⇒ no operator.
 */

/** The operator-write / everyone-read announcements forum channel. */
export const ANNOUNCEMENTS_CHANNEL = 'announcements';

/**
 * On-chain wallet addresses authorized to post announcements. Parsed fresh each
 * call (the env is process-stable; tests set it per-case). Lowercased for
 * byte-exact comparison, matching the Firestore address convention.
 */
export function operatorCommonsWallets(): Set<string> {
  const raw = process.env.OPERATOR_COMMONS_WALLETS || '';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * True iff `address` is an authorized operator wallet. Fail-closed: a null /
 * empty address, or an unset allowlist, is NEVER an operator. Keys on the
 * resolved on-chain address — for human wallet auth `walletId` is a user_id, so
 * the address (not the id) is the identity to check.
 */
export function isOperatorCommonsWallet(address: string | null | undefined): boolean {
  if (!address) return false;
  return operatorCommonsWallets().has(address.toLowerCase());
}
