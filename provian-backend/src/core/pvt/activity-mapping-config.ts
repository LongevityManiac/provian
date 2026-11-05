/**
 * Runtime kill switch for the PERMANENT activity-mapping layer.
 *
 * Continuous mapping of a proven external address's on-chain activity into
 * standard Financial PEs is a CORE, indefinite capability - not the Genesis
 * campaign. It therefore gets its OWN operational pause, fully independent of
 * the Genesis kill switch: an operator can halt mapping for safety without
 * touching Genesis, and disarming/emptying Genesis never halts mapping.
 *
 * Default: ENABLED. Unlike Genesis (which is fail-closed OFF until an admin arms
 * it), mapping is a standing capability that is on by default. Two ways to stop
 * it:
 *   - `ACTIVITY_MAPPING_FORCE_OFF=true|1` env - a deploy-level hard kill that no
 *     admin-secret holder can override at runtime (mirrors GENESIS_CAMPAIGN_FORCE_OFF).
 *   - Firestore `system_config/activity_mapping` doc `{ enabled: false }` - a
 *     runtime pause an operator can toggle.
 *
 * A missing config doc means "no override -> enabled". A config READ FAILURE is
 * an unknown state: per "Unknown = Block, Not Warn" the gate skips this scan
 * cycle (the watchers are idempotent + checkpointed, so the next cron run simply
 * catches up - skipping is harmless, minting on an unconfirmable switch is not).
 */

import type { Firestore } from 'firebase-admin/firestore';

const CONFIG_COLLECTION = 'system_config';
const CONFIG_DOC = 'activity_mapping';

/** Deploy-level hard kill. True halts mapping regardless of Firestore state. */
export function isActivityMappingForcedOff(): boolean {
  const v = process.env.ACTIVITY_MAPPING_FORCE_OFF;
  return v === 'true' || v === '1';
}

/**
 * Whether the permanent activity-mapping layer should run right now. Enabled by
 * default; disabled by the env force-off, by an explicit `{ enabled: false }`
 * config doc, or (fail-closed) when the config cannot be read.
 */
export async function isActivityMappingEnabled(db: Firestore): Promise<boolean> {
  if (isActivityMappingForcedOff()) return false;
  try {
    const snap = await db.collection(CONFIG_COLLECTION).doc(CONFIG_DOC).get();
    if (!snap.exists) return true; // no override -> default on
    return (snap.data() as { enabled?: boolean }).enabled !== false;
  } catch {
    // Unknown state -> do not mint on an unconfirmable switch. Skipping one scan
    // is harmless (idempotent + checkpointed); the next cron run catches up.
    return false;
  }
}
