import type { Firestore, Transaction } from 'firebase-admin/firestore';

export const PRIVATE_ISSUANCE_ADDRESSES = 'recourse_private_issuance_addresses_v1';
export const PRIVATE_ISSUANCE_BATCHES = 'recourse_private_issuance_batches_v1';

/** An unregistered or never-joined payee still needs a reservation. Otherwise
 * its zero-contribution ticket could race a new binding or first admission. */
export async function assertNoPendingAddressIssuance(db: Firestore, tx: Transaction, addresses: readonly string[]): Promise<void> {
  const rows = await Promise.all(addresses.map(account => tx.get(db.collection(PRIVATE_ISSUANCE_ADDRESSES).doc(account))));
  if (rows.some(row => row.get('batchId') != null)) throw Error('recourse_issuance_reconciliation_pending');
}
