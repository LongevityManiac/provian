import type { Firestore } from 'firebase-admin/firestore';
import { parseNonceJournal, type NonceJournalStore } from './canonical-nonce.js';

export function firestoreNonceStore(db: Firestore): NonceJournalStore {
  return {
    async transact(key, change) {
      if (!/^[0-9]+_0x[0-9a-f]{40}$/.test(key)) throw new Error('nonce_store_key_invalid');
      const ref = db.collection('evm_signer_nonce_journals_v1').doc(key);
      return db.runTransaction(async (txn) => {
        const snap = await txn.get(ref);
        const cutover = (await txn.get(db.collection('evm_server_writer_cutovers_v1').doc('base_canonical_nonce'))).data();
        if (cutover?.protocol !== 'canonical-nonce-v1' || cutover.active !== true
          || !Number.isSafeInteger(cutover.old_writers_drained_at_ms) || cutover.old_writers_drained_at_ms > Date.now()
          || !Number.isSafeInteger(cutover.activated_at_ms) || cutover.activated_at_ms < cutover.old_writers_drained_at_ms
          || cutover.activated_at_ms > Date.now()) throw new Error('server_nonce_writer_cutover_not_active');
        const next = parseNonceJournal(change(parseNonceJournal(snap.exists ? snap.data() : null)));
        if (!next) throw new Error('nonce_store_empty_write');
        txn.set(ref, { ...next });
        return next;
      });
    },
  };
}
