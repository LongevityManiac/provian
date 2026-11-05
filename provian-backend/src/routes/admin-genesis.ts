import {readGenesisActivation} from '../core/pvt/genesis-activation-store';
/**
 * Genesis administration boundary after the atomic accounting/PVT9 rebaseline.
 *
 * The historical `pvt_config/genesis_campaign` surface encoded a global pool,
 * per-action/source caps, funding thresholds, and retired activity bounties.
 * None of those may arm PVT9. This router therefore preserves read/audit and a
 * one-way emergency kill only. Re-arming requires the separately signed exact
 * PVT9 activation manifest; `/arm` and legacy tuning keys fail closed.
 */

import { Router, Request, Response } from 'express';
import { relayDb } from '../firestore-db';

import {
  getGenesisCampaignState,
  invalidateGenesisConfigCache,
  loadGenesisCampaignConfig,
} from '../core/pvt/genesis-campaign';
import {
  GENESIS_ACTIVATION_COLLECTION,
  GENESIS_ACTIVATION_DOCUMENT,
  closeGenesisAdmission,
} from '../core/pvt/genesis-award-state-machine';
import { safeSecretCompare } from './middleware/admin-secret';

const router = Router();
const AUDIT_COLLECTION = 'genesis_campaign_audit_log';
const LEGACY_CONFIG_COLLECTION = 'pvt_config';
const LEGACY_CONFIG_DOCUMENT = 'genesis_campaign';

const RETIRED_BOUNTY_KEYS = new Set([
  'agent_wallet_created',
  'agent_wallet_funded',
  'wallet_funded',
  'agent_first_transaction',
  'wallet_first_transaction',
  'agent_sustained_activity',
  'wallet_sustained_activity',
]);

const RETIRED_CONFIG_KEYS = new Set([
  'window_start_ms',
  'window_end_ms',
  'pool_cap_pvt',
  'per_epoch_mint_cap_pvt',
  'per_wallet_cap_pvt',
  'per_source_cap_pvt',
  'funding_min_usd',
  'bounties',
  'decay',
  'sustained',
]);

function authenticateAdmin(req: Request, res: Response): boolean {
  const key = (req.headers['x-admin-key'] || req.headers['x-admin-secret']) as string | undefined;
  const expected = process.env.ADMIN_API_KEY || process.env.AGENT_BANK_ADMIN_SECRET;
  if (!safeSecretCompare(key, expected)) {
    res.status(401).json({ error: 'admin_auth_failed' });
    return false;
  }
  return true;
}

function handleError(res: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : 'Internal server error';
  console.error('[admin-genesis]', message);
  res.status(500).json({ error: message });
}

async function writeAudit(action: string, detail: Record<string, unknown>): Promise<void> {
  await relayDb().collection(AUDIT_COLLECTION).add({
    action,
    ...detail,
    set_by: 'admin',
    timestamp: Date.now(),
  });
}

/**
 * The only accepted legacy mutation is `enabled:false` (one-way kill).
 * Every former economic/configuration key is explicitly rejected so stale
 * runbooks cannot silently resurrect retired Genesis economics.
 */
export function buildGenesisConfigUpdate(
  body: Record<string, unknown>,
): { update: Record<string, unknown>; errors: string[] } {
  const update: Record<string, unknown> = {};
  const errors: string[] = [];

  for (const key of Object.keys(body)) {
    if (key === 'enabled') continue;
    if (key === 'bounties' && body.bounties && typeof body.bounties === 'object') {
      for (const bountyKey of Object.keys(body.bounties as Record<string, unknown>)) {
        if (RETIRED_BOUNTY_KEYS.has(bountyKey)) {
          errors.push(`retired Genesis bounty key rejected: ${bountyKey}`);
        } else {
          errors.push(
            `legacy bounty configuration rejected: ${bountyKey}; PVT9 requires a separately approved and signed exact activation manifest`,
          );
        }
      }
      continue;
    }
    if (RETIRED_CONFIG_KEYS.has(key)) {
      errors.push(`retired Genesis configuration key rejected: ${key}`);
    } else {
      errors.push(`unknown Genesis configuration key rejected: ${key}`);
    }
  }

  if ('enabled' in body) {
    if (body.enabled !== false) {
      errors.push('legacy Genesis can only be disabled; PVT9 re-arm requires a signed activation manifest');
    } else {
      update.enabled = false;
    }
  }
  return { update, errors };
}

async function killGenesis(reason: string | null): Promise<void> {
  const db = relayDb();
  const batch = db.batch();
  batch.set(
    db.collection(LEGACY_CONFIG_COLLECTION).doc(LEGACY_CONFIG_DOCUMENT),
    { enabled: false, updated_at: Date.now() },
    { merge: true },
  );
  batch.set(
    db.collection(GENESIS_ACTIVATION_COLLECTION).doc(GENESIS_ACTIVATION_DOCUMENT),
    {
      grants_enabled: false,
      genesis_kill_switch_active: true,
      killed_at_ms: Date.now(),
      kill_reason: reason,
    },
    { merge: true },
  );
  await batch.commit();
  await writeAudit('kill', { reason });
  invalidateGenesisConfigCache();
}

router.get('/', async (req: Request, res: Response) => {
  if (!authenticateAdmin(req, res)) return;
  try {
    const db = relayDb();
    const [legacyConfig, activationSnap] = await Promise.all([
      loadGenesisCampaignConfig(db),
      readGenesisActivation(db),
    ]);
    const legacyState = await getGenesisCampaignState(db, legacyConfig);
    res.json({
      pvt9_activation: activationSnap.exists ? activationSnap.data() : null,
      legacy_config: legacyConfig,
      legacy_state: legacyState,
      legacy_arm_retired: true,
      force_off: process.env.GENESIS_CAMPAIGN_FORCE_OFF === 'true'
        || process.env.GENESIS_CAMPAIGN_FORCE_OFF === '1',
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/config', async (req: Request, res: Response) => {
  if (!authenticateAdmin(req, res)) return;
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { update, errors } = buildGenesisConfigUpdate(body);
    if (errors.length > 0) {
      return res.status(400).json({ error: 'validation_failed', details: errors });
    }
    if (update.enabled !== false) {
      return res.status(400).json({ error: 'no valid fields supplied' });
    }
    await killGenesis('legacy_config_disable');
    return res.json({ success: true, enabled: false, pvt9_rearm_required: true });
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/kill', async (req: Request, res: Response) => {
  if (!authenticateAdmin(req, res)) return;
  try {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : null;
    await killGenesis(reason);
    res.json({
      success: true,
      enabled: false,
      pvt9_genesis_kill_switch_active: true,
      reenable_requires_signed_activation_manifest: true,
    });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * Evented admission close for an already-approved/armed PVT9 Genesis campaign.
 * This is deliberately separate from `/kill`: it flips admission only and
 * leaves the kill switch false so pre-cutoff durable outboxes can drain.
 */
router.post('/close-admission', async (req: Request, res: Response) => {
  if (!authenticateAdmin(req, res)) return;
  const admissionCloseAuditId = req.body?.admission_close_audit_id;
  const operatorId = req.body?.operator_id;
  if (typeof admissionCloseAuditId !== 'string'
    || typeof operatorId !== 'string') {
    return res.status(400).json({
      error: 'admission_close_audit_id and operator_id are required',
    });
  }
  try {
    const result = await closeGenesisAdmission(relayDb(), {
      admissionCloseAuditId,
      closedBy: operatorId,
    });
    res.json({
      success: true,
      event_id: result.eventId,
      cutoff_at_ms: result.cutoffAtMs,
      idempotent: result.idempotent,
      grants_enabled: false,
      genesis_kill_switch_active: false,
      pre_cutoff_outboxes_preserved: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('genesis_admission_')
      || message.startsWith('genesis_activation_')) {
      return res.status(409).json({ error: message });
    }
    handleError(res, error);
  }
});

router.post('/arm', async (req: Request, res: Response) => {
  if (!authenticateAdmin(req, res)) return;
  res.status(410).json({
    error: 'legacy_genesis_arm_retired',
    message: 'PVT9 Genesis can only be armed from the signed exact activation manifest.',
  });
});

router.get('/audit-log', async (req: Request, res: Response) => {
  if (!authenticateAdmin(req, res)) return;
  try {
    const snapshot = await relayDb().collection(AUDIT_COLLECTION)
      .orderBy('timestamp', 'desc')
      .limit(100)
      .get();
    res.json({
      entries: snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
      count: snapshot.size,
    });
  } catch (error) {
    handleError(res, error);
  }
});

export default router;
