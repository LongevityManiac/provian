/**
 * PE METER (2026-10-03) — read a relay-authored act out of a fake Firestore store.
 *
 * The relay no longer stores a readable PE (`provenance_envelopes`) or a `pe_history` row. A
 * `generatePE` act is staged as a transient intake (`meter_relay_acts_v1/{pe_id}`) in the chain-tip
 * transaction; once priced through the REAL accrual it ends as the 31-day act key
 * (`meter_act_keys_v1/{pe_id}`) whose `.row` is the priced pe_history-shaped row, and the intake is
 * deleted. These helpers bind to the production collection constants (never a re-declared literal)
 * so a rename cannot leave a test asserting over an empty collection.
 */
import { METER_ACT_KEYS_COLLECTION } from '../../meter/meter-store';
import { METER_RELAY_ACTS_COLLECTION, type RelayActIntake } from '../../meter/meter-relay-authored';

type Store = ReadonlyMap<string, unknown>;

/** The priced row of a metered act (`meter_act_keys_v1/{peId}.row`), or undefined. */
export function meterActRow(store: Store, peId: string): Record<string, unknown> | undefined {
  const key = store.get(`${METER_ACT_KEYS_COLLECTION}/${peId}`) as { row?: unknown } | undefined;
  const row = key?.row;
  return row !== null && typeof row === 'object' && !Array.isArray(row)
    ? (row as Record<string, unknown>)
    : undefined;
}

/** Every metered act's priced row, in store order. */
export function meterActRows(store: Store): Record<string, unknown>[] {
  const prefix = `${METER_ACT_KEYS_COLLECTION}/`;
  return [...store.entries()]
    .filter(([k]) => k.startsWith(prefix))
    .map(([, v]) => (v as { row: Record<string, unknown> }).row);
}

/** Every metered act's id, in store order. */
export function meterActIds(store: Store): string[] {
  const prefix = `${METER_ACT_KEYS_COLLECTION}/`;
  return [...store.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
}

/** The staged (not yet priced) intake of a relay-authored act, or undefined. */
export function relayIntake(store: Store, peId: string): RelayActIntake | undefined {
  return store.get(`${METER_RELAY_ACTS_COLLECTION}/${peId}`) as RelayActIntake | undefined;
}

/** Every staged relay intake, in store (commit) order. */
export function relayIntakes(store: Store): RelayActIntake[] {
  const prefix = `${METER_RELAY_ACTS_COLLECTION}/`;
  return [...store.entries()]
    .filter(([k]) => k.startsWith(prefix))
    .map(([, v]) => v as RelayActIntake);
}

/** True when the relay recorded the act at all: priced (act key) or staged (intake). */
export function actRecorded(store: Store, peId: string): boolean {
  return store.has(`${METER_ACT_KEYS_COLLECTION}/${peId}`)
    || store.has(`${METER_RELAY_ACTS_COLLECTION}/${peId}`);
}
