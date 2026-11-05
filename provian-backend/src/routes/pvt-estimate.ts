/**
 * GET /v1/pvt/estimate — public PVT payoff estimator (runtime boundary, agent-first launch).
 *
 * Launch-gated discovery surface: 404s until PUBLIC_LAUNCH=true, exactly like
 * the OpenAPI/ecosystem discovery routes (routes/openapi.ts). Mounted at
 * /v1/pvt UNCONDITIONALLY and BEFORE the contract-gated PVT router, so the
 * estimator exists regardless of PVT contract configuration (same reasoning
 * as PE proposals — see CLAUDE.md pitfall #28).
 *
 * Pure read: no auth, no state writes. Per-IP rate limited (leaderboard
 * pattern) on top of the global /v1 limiter.
 */

import { Router, Request, Response } from 'express';
import { isWitnessClass, WITNESS_CLASSES } from '../core/pvt/policy/evidence-class';
import type { Firestore } from 'firebase-admin/firestore';
import type { RedisCache } from '../cache';
import { publicDiscoveryGate } from './middleware/public-launch-gate';
import {
  estimatePVT,
  VALID_ESTIMATE_ATTESTATION_TIERS,
} from '../core/pvt/estimate';

interface PVTEstimateRouterDeps {
  cache: RedisCache;
  /**
   * C-2: the estimator now prices through the record path, which reads the
   * live action-policy pointer, the signed monetary activation, and the Genesis
   * activation. All three are READS; this route still writes nothing.
   */
  db: Firestore;
}

const MAX_ACTION_TYPE_LENGTH = 200;
// Permissionless action-type identifiers (letters, digits, _ . : -), same
// character space the catalog auto-registers. Anything else is a 400, not a
// lookup.
const ACTION_TYPE_PATTERN = /^[a-zA-Z0-9_.:-]+$/;
const MAX_COUNTER = 100_000;

function parseCounter(raw: unknown): number | null {
  if (raw === undefined) return 0;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > MAX_COUNTER) return null;
  return n;
}

function parseBoolean(raw: unknown): boolean | null {
  if (raw === undefined) return false;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return null;
}

export function createPVTEstimateRouter(deps: PVTEstimateRouterDeps): Router {
  const { cache, db } = deps;
  const router = Router();

  // Launch gate — discovery surfaces go live at flip, not before. This used to
  // be an inline `process.env.PUBLIC_LAUNCH !== 'true'` at the top of the
  // handler: correct, but a second copy of the one predicate, which is the
  // redeclared-literal shape names. It now calls the shared module, and
  // is named at the call site so the route-reachability matrix classifies this
  // route LAUNCH_GATE instead of OPEN.
  router.get('/estimate', publicDiscoveryGate(), async (req: Request, res: Response) => {
    try {
      const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
      const rateLimit = await cache.checkRateLimit(`rl:pvt-estimate:${clientIp}`, 60, 60);
      if (!rateLimit.allowed) {
        res.status(429).json({ error: 'Rate limit exceeded', retry_after: rateLimit.retryAfter });
        return;
      }

      const actionTypeRaw = req.query.action_type;
      if (typeof actionTypeRaw !== 'string' || actionTypeRaw.length === 0) {
        res.status(400).json({
          error: 'invalid_request',
          message: 'action_type is required, e.g. ?action_type=agent_work_product_code',
        });
        return;
      }
      if (actionTypeRaw.length > MAX_ACTION_TYPE_LENGTH || !ACTION_TYPE_PATTERN.test(actionTypeRaw)) {
        res.status(400).json({
          error: 'invalid_request',
          message: 'action_type must be an action-type identifier (letters, digits, _ . : -)',
        });
        return;
      }

      const attestationTierRaw = req.query.attestation_tier;
      let attestationTier = 'software';
      if (attestationTierRaw !== undefined) {
        if (
          typeof attestationTierRaw !== 'string'
          || !VALID_ESTIMATE_ATTESTATION_TIERS.includes(attestationTierRaw)
        ) {
          res.status(400).json({
            error: 'invalid_request',
            message: 'attestation_tier is not a recognized tier',
            valid_attestation_tiers: [...VALID_ESTIMATE_ATTESTATION_TIERS],
          });
          return;
        }
        attestationTier = attestationTierRaw;
      }

      const novelty = parseCounter(req.query.novelty);
      const count = parseCounter(req.query.count);
      if (novelty === null || count === null) {
        res.status(400).json({
          error: 'invalid_request',
          message: `novelty and count must be non-negative integers <= ${MAX_COUNTER}`,
        });
        return;
      }

      const humanLinked = parseBoolean(req.query.human_linked);
      if (humanLinked === null) {
        res.status(400).json({
          error: 'invalid_request',
          message: 'human_linked must be true or false',
        });
        return;
      }

      // Scenario input only. The public estimator has no identity context and
      // therefore grants no linkage authority; record-time runtime accounting
      // independently verifies human/beneficiary linkage before applying 2x.

      const durableRaw = req.query.durable_submission_path;
      const durableSubmissionPath = parseBoolean(durableRaw);
      if (durableSubmissionPath === null) {
        res.status(400).json({
          error: 'invalid_request',
          message: 'durable_submission_path must be true or false',
        });
        return;
      }

      // §2.8 : the lane the submission would seal under. Unnamed types earn at the
      // class base, so the quote must name the lane; default actor_declared (fail-closed).
      const witnessClassRaw = req.query.witness_class;
      const witnessClass = typeof witnessClassRaw === 'string' ? witnessClassRaw : undefined;
      if (witnessClass !== undefined && !isWitnessClass(witnessClass)) {
        res.status(400).json({
          error: 'invalid_request',
          message: `witness_class must be one of ${WITNESS_CLASSES.join('|')}`,
        });
        return;
      }

      // Fact-base fixes item 1: `speech_pass` (Commons speech types only) — default true, the
      // condition every forum/want/job write already meets; false quotes a no-pass thread message.
      const speechPassRaw = req.query.speech_pass;
      const speechPass = speechPassRaw === undefined ? true : parseBoolean(speechPassRaw);
      if (speechPass === null) {
        res.status(400).json({
          error: 'invalid_request',
          message: 'speech_pass must be true or false',
        });
        return;
      }

      const estimate = await estimatePVT(db, {
        actionType: actionTypeRaw,
        attestationTier,
        novelty,
        count,
        humanLinked,
        durableSubmissionPath,
        speechPass,
        ...(witnessClass ? { witnessClass } : {}),
      });

      res.json(estimate);
    } catch (error) {
      console.error('[PVTEstimate] Error:', error);
      res.status(500).json({ error: 'Estimate failed' });
    }
  });

  return router;
}
