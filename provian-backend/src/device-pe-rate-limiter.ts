/**
 * Device PE Rate Limiter
 *
 * Prevents PVT farming via app reinstalls by rate-limiting setup PE action types
 * per physical device (device_attestation_id), NOT per user_id.
 *
 * The device_attestation_id is derived from the Secure Enclave and survives app
 * reinstalls on the same physical device. This is the only reliable anchor for
 * deduplicating setup PEs across wallet recreations.
 *
 * Firestore collection: device_pe_rate_limits
 * Document key: {device_attestation_id}_{action_type}
 *
 * Fallback: If device_attestation_id is missing (agent SDKs, software-only),
 * falls back to device_id from the authenticated request. If neither exists,
 * the PE still records (existing behavior preserved for non-hardware paths).
 */

import { relayDb } from './firestore-db';

// =============================================================================
// RATE LIMIT CONFIGURATION
// =============================================================================

interface DeviceRateLimitRule {
  /** Maximum number of PEs allowed within the window */
  maxCount: number;
  /** Window duration in milliseconds */
  windowMs: number;
}

/**
 * Rate-limited action types and their windows.
 * Action types NOT in this map are unrestricted at the device level —
 * repetition there is priced by novelty decay and gated by the evidence
 * layer, never by a volume ceiling (removed the per-user PE caps).
 */
const DEVICE_RATE_LIMITS: Record<string, DeviceRateLimitRule> = {
  // Setup actions: 1 per device per 90 days
  wallet_created:   { maxCount: 1, windowMs: 90 * 24 * 60 * 60 * 1000 },
  device_register:  { maxCount: 1, windowMs: 90 * 24 * 60 * 60 * 1000 },

  // Credential actions: 5 per device per day
  credential_added:   { maxCount: 5, windowMs: 24 * 60 * 60 * 1000 },
  credential_updated: { maxCount: 5, windowMs: 24 * 60 * 60 * 1000 },
};

const COLLECTION = 'device_pe_rate_limits';

// =============================================================================
// TYPES
// =============================================================================

interface DeviceRateLimitDoc {
  device_id: string;        // device_attestation_id or fallback device_id
  action_type: string;
  /** Timestamps (ms) of each recorded PE within the current window */
  recorded_at: number[];
  /** Stable PE id → consumed timestamp. Makes a partial accrual retry idempotent. */
  recorded_pe_ids?: Record<string, number>;
  updated_at: number;
}

export interface DeviceRateLimitResult {
  /** true = PE is allowed, false = rate-limited (skip PE) */
  allowed: boolean;
  /** Reason for denial, if any */
  reason?: string;
  /** Which device identifier was used */
  anchor: 'device_attestation_id' | 'device_id' | 'none';
}

// =============================================================================
// CORE: CHECK AND RECORD
// =============================================================================

/**
 * Check whether a PE action is allowed for this physical device.
 *
 * If the action_type is not rate-limited, returns { allowed: true } immediately.
 * If rate-limited, checks the Firestore document for this device+action combo.
 *
 * IMPORTANT: This function both checks AND records the timestamp atomically
 * (via Firestore transaction) to prevent race conditions. The caller should
 * NOT record the PE if allowed === false.
 */
export async function checkDevicePERateLimit(
  deviceAttestationId: string | null | undefined,
  deviceId: string | null | undefined,
  actionType: string,
  peId?: string,
): Promise<DeviceRateLimitResult> {
  // If action type is not rate-limited, allow unconditionally
  const rule = DEVICE_RATE_LIMITS[actionType];
  if (!rule) {
    return { allowed: true, anchor: 'none' };
  }

  // Resolve device anchor: prefer hardware attestation, fall back to device_id
  const anchor = deviceAttestationId || deviceId;
  if (!anchor) {
    // P1-4: No device identifier - DENY for rate-limited PE types (setup actions).
    // Agent SDKs without device binding cannot submit setup PEs (wallet_created,
    // device_register, etc.) because there's no anchor to deduplicate against.
    // Their PEs still record normally at the lowest attestation tier via other paths.
    console.warn('[DeviceRateLimit] No device anchor - blocking rate-limited action:', actionType);
    return { allowed: false, anchor: 'none', reason: 'No device identifier for rate-limited action' };
  }

  const anchorType: DeviceRateLimitResult['anchor'] = deviceAttestationId
    ? 'device_attestation_id'
    : 'device_id';

  const docId = `${anchor}_${actionType}`;
  const db = relayDb();
  const ref = db.collection(COLLECTION).doc(docId);
  const now = Date.now();
  const windowStart = now - rule.windowMs;

  let allowed = true;
  let reason: string | undefined;

  await db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);

    if (!snap.exists) {
      // First time this device has generated this action type - allow and record
      const newDoc: DeviceRateLimitDoc = {
        device_id: anchor,
        action_type: actionType,
        recorded_at: [now],
        ...(peId ? { recorded_pe_ids: { [peId]: now } } : {}),
        updated_at: now,
      };
      txn.set(ref, newDoc);
      allowed = true;
      return;
    }

    const data = snap.data() as DeviceRateLimitDoc;

    if (peId && data.recorded_pe_ids
      && Number.isSafeInteger(data.recorded_pe_ids[peId])) {
      // The same canonical PE already reserved this slot. A crash after this
      // transaction but before pe_history must resume that PE, not convert it
      // to a 90-day terminal zero on retry.
      allowed = true;
      return;
    }

    // Filter to only timestamps within the current window
    const recentTimestamps = (data.recorded_at || []).filter(
      (ts: number) => ts > windowStart,
    );

    if (recentTimestamps.length >= rule.maxCount) {
      // Rate limit exceeded - do NOT record
      allowed = false;
      const oldestRecent = Math.min(...recentTimestamps);
      const nextAllowedAt = oldestRecent + rule.windowMs;
      const daysUntil = Math.ceil((nextAllowedAt - now) / (24 * 60 * 60 * 1000));
      reason = `Device rate limit: ${actionType} limited to ${rule.maxCount} per ${Math.round(rule.windowMs / (24 * 60 * 60 * 1000))}d. Next allowed in ~${daysUntil}d.`;
      return;
    }

    // Under limit - record this timestamp
    recentTimestamps.push(now);
    const recordedPeIds = Object.fromEntries(Object.entries(data.recorded_pe_ids ?? {})
      .filter(([, timestamp]) => Number.isSafeInteger(timestamp) && timestamp > windowStart));
    if (peId) recordedPeIds[peId] = now;
    txn.update(ref, {
      recorded_at: recentTimestamps,
      recorded_pe_ids: recordedPeIds,
      updated_at: now,
    });
    allowed = true;
  });

  if (!allowed) {
    console.warn('[DeviceRateLimit] PE blocked:', {
      anchor: anchorType,
      device: anchor.substring(0, 8) + '...',
      actionType,
      reason,
    });
  }

  return { allowed, reason, anchor: anchorType };
}

/**
 * Check if an action type is device-rate-limited.
 * Useful for callers that want to know before invoking the full check.
 */
export function isDeviceRateLimited(actionType: string): boolean {
  return actionType in DEVICE_RATE_LIMITS;
}
