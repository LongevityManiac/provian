import { relayDb } from '../../firestore-db';

export const SERVER_WRITER_CUTOVER_COLLECTION = 'evm_server_writer_cutovers_v1';
export const SERVER_WRITER_CUTOVER_DOCUMENT = 'base_canonical_nonce';
/** A rollout barrier for Provian's own server keys; consumer wallets never use it. */
export function assertServerWriterCutover(value: unknown, now: number): void {
  const v = value as Record<string, unknown> | null;
  if (!v || v.protocol !== 'canonical-nonce-v1' || v.active !== true
    || !Number.isSafeInteger(v.old_writers_drained_at_ms) || Number(v.old_writers_drained_at_ms) > now
    || !Number.isSafeInteger(v.activated_at_ms) || Number(v.activated_at_ms) < Number(v.old_writers_drained_at_ms)
    || Number(v.activated_at_ms) > now) throw new Error('server_nonce_writer_cutover_not_active');
}
export async function assertServerNonceWriterActive(): Promise<void> {
  const snap = await relayDb().collection(SERVER_WRITER_CUTOVER_COLLECTION).doc(SERVER_WRITER_CUTOVER_DOCUMENT).get();
  assertServerWriterCutover(snap.exists ? snap.data() : null, Date.now());
}
