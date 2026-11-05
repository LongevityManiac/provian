/**
 * work package minimum-burn FLOOR operations (Part 1,) — the schedulable side.
 *
 * The per-action floor (name/vouch/pledge = 15 PVT launch, export/subscription =
 * 0) is a SETTABLE value with a bounded max, not a hardcoded constant — the
 * relay-side analogue of the institutions' on-chain `scheduleFeeBps`. This router
 * is how an operator ratchets a floor on live data without a redeploy:
 *
 * - POST /v1/internal/burn-floor/schedule { product, amount_atomic }
 * Admin auth. Writes `burn_floor_policy/{product}`, bounded to
 * [0, BURN_FLOOR_MAX_ATOMIC] (refused, never clamped, outside the range).
 * - GET /v1/internal/burn-floor
 * Admin auth. Reports the effective floor for every product (scheduled
 * override if set, else the launch literal).
 *
 * Auth mirrors `pvt9-operations.ts::authenticateOperator` exactly (x-admin-key /
 * x-admin-secret vs ADMIN_API_KEY || AGENT_BANK_ADMIN_SECRET, constant-time). It
 * does NOT build a signer or move value — it writes one policy doc the consume
 * path reads; the burn itself is the agent's own on-chain PVT9 `burn()`.
 */

import { Router, type Request, type Response } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import { safeSecretCompare } from './middleware/admin-secret';
import {
  BURN_PRODUCTS,
  BURN_FLOOR_MAX_ATOMIC,
  BurnConsumptionError,
  isBurnProduct,
  resolveBurnFloorAtomic,
  scheduleBurnFloor,
} from '../core/commons/burn-consumption';

export const BURN_FLOOR_SCHEDULE_PATH = '/v1/internal/burn-floor/schedule';
export const BURN_FLOOR_READ_PATH = '/v1/internal/burn-floor';

export interface BurnFloorOperationsDeps {
  readonly db: Firestore;
  readonly now?: () => number;
}

function authenticateOperator(req: Request, res: Response): boolean {
  const key = (req.headers['x-admin-key'] || req.headers['x-admin-secret']) as string | undefined;
  const expected = process.env.ADMIN_API_KEY || process.env.AGENT_BANK_ADMIN_SECRET;
  if (!safeSecretCompare(key, expected)) {
    res.status(401).json({ error: 'admin_auth_failed' });
    return false;
  }
  return true;
}

async function effectiveFloors(db: Firestore): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const product of BURN_PRODUCTS) {
    out[product] = (await resolveBurnFloorAtomic(db, product)).toString();
  }
  return out;
}

export function createBurnFloorOperationsRouter(deps: BurnFloorOperationsDeps): Router {
  const router = Router();
  const now = deps.now ?? (() => Date.now());

  router.get(BURN_FLOOR_READ_PATH, async (req: Request, res: Response) => {
    if (!authenticateOperator(req, res)) return;
    res.json({ max_atomic: BURN_FLOOR_MAX_ATOMIC.toString(), floors: await effectiveFloors(deps.db) });
  });

  router.post(BURN_FLOOR_SCHEDULE_PATH, async (req: Request, res: Response) => {
    if (!authenticateOperator(req, res)) return;
    const body = (req.body ?? {}) as { product?: unknown; amount_atomic?: unknown };

    if (!isBurnProduct(body.product)) {
      res.status(400).json({ error: 'product must be one of', products: BURN_PRODUCTS });
      return;
    }
    const rawAmount = body.amount_atomic;
    if (typeof rawAmount !== 'string' || !/^[0-9]+$/.test(rawAmount)) {
      res.status(400).json({ error: 'amount_atomic must be a non-negative integer string (atomic PVT units)' });
      return;
    }

    try {
      await scheduleBurnFloor(deps.db, body.product, BigInt(rawAmount), 'operator', now());
      res.json({
        scheduled: { product: body.product, amount_atomic: rawAmount },
        floors: await effectiveFloors(deps.db),
      });
    } catch (err) {
      if (err instanceof BurnConsumptionError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  return router;
}
