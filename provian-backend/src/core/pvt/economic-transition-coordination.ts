export const EPOCH_KEEPER_STATE_COLLECTION = 'pvt_epoch_keeper_state_v1';
export const EPOCH_KEEPER_STATE_ID = 'base';
const EPOCH_KEEPER_STATE_KEYS = Object.freeze([
  'schema_version',
  'state',
  'pending_from_epoch',
  'pending_tx_hash',
  'pending_prepared_transaction',
  'lease_owner_id',
  'lease_fencing_token',
  'broadcast_protocol',
  'prepared_at_ms',
  'broadcast_at_ms',
  'last_finalized_from_epoch',
  'last_finalized_tx_hash',
  'updated_at_ms',
] as const);

/**
 * Missing means the epoch keeper has never run. An existing row is considered
 * idle only when every transition-ownership field is empty; a stale prepared
 * payload or lease fence must not be hidden behind a forged `state: idle`.
 */
export function assertEpochTransitionIdleForMint(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('epoch_transition_state_invalid');
  }
  const doc = value as Record<string, unknown>;
  if (Object.keys(doc).length !== EPOCH_KEEPER_STATE_KEYS.length
    || EPOCH_KEEPER_STATE_KEYS.some((key) =>
      !Object.prototype.hasOwnProperty.call(doc, key))
    || doc.schema_version !== 'pvt-epoch-keeper-state/v1'
    || doc.state !== 'idle'
    || doc.pending_from_epoch !== null
    || doc.pending_tx_hash !== null
    || doc.pending_prepared_transaction !== null
    || doc.lease_owner_id !== null
    || doc.lease_fencing_token !== null
    || doc.broadcast_protocol !== null
    || doc.prepared_at_ms !== null
    || doc.broadcast_at_ms !== null
    || (doc.last_finalized_from_epoch !== null
      && !Number.isSafeInteger(doc.last_finalized_from_epoch))
    || (doc.last_finalized_tx_hash !== null
      && (typeof doc.last_finalized_tx_hash !== 'string'
        || !/^0x[a-fA-F0-9]{64}$/.test(doc.last_finalized_tx_hash)))
    || !Number.isSafeInteger(doc.updated_at_ms)) {
    throw new Error('epoch_transition_not_idle');
  }
}
