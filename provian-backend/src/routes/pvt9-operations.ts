/**
 * settlement runtime — the two PVT9 operational routes.
 *
 * POST /v1/internal/scheduler/pvt9-epoch-keeper scheduler auth ON A TIMER (every 20 min)
 * POST /v1/internal/settlement/pvt9-run scheduler OR admin auth ON A TIMER (daily, per-payee interval)
 *
 * ── THE TWO CLOCKS — STILL DECOUPLED ─────────────────────────────────────────
 * They remain two different kinds of thing on two different cadences; gave the
 * settlement runner its OWN timer (daily, per-payee interval) but did NOT fuse them.
 *
 * `openNextEpoch` (the KEEPER, every 20 min) is the only kernel entrypoint with NO modifier:
 * permissionless, mints nothing, moves nothing, derives its own epoch. It MUST be on a timer,
 * because if it is not: scheduled policy never applies (the operator’s `scheduleCapPolicy` for epoch 1
 * sits unapplied), and every settlement batch after a 7-day boundary reverts with
 * `EpochMismatch`. An unscheduled keeper is the same as no keeper.
 *
 * SETTLEMENT issues PVT (the daily runner, `0 12 * * *`, / — the operator-approved: automatic,
 * unattended, from the first mint on). It has TWO ways in:
 * - SCHEDULER auth — the scheduled runs (daily both-lanes, daily Genesis-only). Same OIDC/secret gate as the keeper, so the
 * arming token stays out of scheduler config. The standing gate is `PVT9_SETTLEMENT_ARMED`
 * in the ENVIRONMENT, which still refuses an unarmed deploy. Idempotent, so a retry can't
 * double-mint.
 * - ADMIN auth (unchanged) — the hand run: admin key + armed env + the token echoed in the
 * BODY. The "a person types this string" gate is preserved for manual settlement.
 * The keeper NEVER settles and settlement NEVER advances an epoch — the split is intact.
 *
 * ── WHAT THESE ROUTES DO NOT DO ──────────────────────────────────────────────
 * Neither builds a signer, reads a key, or contains a gate. Every decision lives in
 * `core/pvt/wp4/operator-runtime.ts`, which the two scripts also call, so a hand run and a
 * route run cannot diverge. A route with its own copy of the gates is a second, weaker set of
 * gates, and the weaker one is the one that mints.
 */

import { Router, type Request, type Response } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import { safeSecretCompare } from './middleware/admin-secret';
import { seedPayeeSettlementClocks } from '../core/pvt/wp4/seed-payee-settlement-clocks';
import { legacySettlementTimeReader } from '../core/pvt/wp4/operator-runtime';
import { carryOccurrenceDigests } from '../core/meter/carry-occurrence-digests';
import {
  ARMING_TOKEN,
  OperatorRefusal,
  runEpochKeeperRuntime,
  runSettlement,
  summarizeSettlementRun,
  settlementRunNeedsAlarm,
} from '../core/pvt/wp4/operator-runtime';
import type { SettlementDb } from '../core/pvt/wp4/durable-settlement-store';

export const EPOCH_KEEPER_PATH = '/v1/internal/scheduler/pvt9-epoch-keeper';
export const SETTLEMENT_RUN_PATH = '/v1/internal/settlement/pvt9-run';
// the DAILY Genesis-only settlement runner (the operator’s cadence: Genesis daily,
// standard per-payee interval). Its own endpoint (not a body flag on the both-lanes path) so it is
// first-class in scheduler-jobs.json and independently reconcile-pinned. Serves the
// SAME handler as the both-lanes path with the lane forced to 'genesis'.
export const SETTLEMENT_GENESIS_RUN_PATH = '/v1/internal/settlement/pvt9-genesis-run';

export interface Pvt9OperationsDeps {
  readonly db: Firestore;
  /** Cloud Scheduler OIDC / shared-secret check, supplied by `server.ts`. */
  readonly authenticateScheduler: (req: Request) => Promise<boolean>;
  readonly log?: (message: string) => void;
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

function refusalStatus(reason: OperatorRefusal['reason']): number {
  // `not_armed` is 409, not 403: the caller's credentials were fine and the SERVER is not in a
  // state where settling is allowed. Collapsing it into 403 would tell an operator to go
  // looking for the wrong problem.
  switch (reason) {
    case 'not_armed': return 409;
    case 'pvt9_not_configured': return 503;
    case 'rpc_not_configured':
    case 'minter_key_absent':
    case 'approver_key_absent': return 503;
    case 'approver_unfunded':
    case 'epoch_verifier_absent':
    // another run holds this signer's settlement lease: a state conflict, not a fault.
    case 'settlement_run_in_progress': return 409;
    default: return 500;
  }
}

export function createPvt9OperationsRouter(deps: Pvt9OperationsDeps): Router {
  const router = Router();
  const db = deps.db as unknown as SettlementDb;
  const log = deps.log ?? ((message: string) => console.log(message));

  router.post('/v1/internal/settlement/meter-dedupe-prepare', async (req: Request, res: Response) => {
    if (!await deps.authenticateScheduler(req) && !authenticateOperator(req, res)) return;
    try {
      const phase = (req.body as { phase?: unknown } | undefined)?.phase;
      if (phase !== 'capture' && phase !== 'finalize') { res.status(400).json({ error: 'occurrence_carry_phase_required' }); return; }
      const nowMs = Date.now();
      if (phase === 'finalize') {
        const state = (await deps.db.collection('meter_occurrence_carry_v1').doc('live').get()).data();
        // Capture first, then drain every old handler plus Firestore's maximum transaction life.
        // The operator also removes old revision traffic/tags before this final fixed scan.
        if (!Number.isSafeInteger(state?.captured_at_ms) || nowMs - Number(state?.captured_at_ms) < 26 * 60_000) {
          res.status(409).json({ error: 'occurrence_carry_old_writers_not_drained' }); return;
        }
      }
      const result = await carryOccurrenceDigests(deps.db, process.env.PVT_NOVELTY_SEALS_PAUSED === 'true', nowMs, phase === 'finalize');
      const clocks = phase === 'finalize' ? await seedPayeeSettlementClocks(deps.db, legacySettlementTimeReader()) : null;
      res.json({ complete: phase === 'finalize', ...result, clocks });
    } catch (error) {
      console.error('[meter-dedupe-prepare] failed:', error);
      res.status(409).json({ error: 'occurrence_carry_not_complete' });
    }
  });

  /**
   * The epoch keeper. Scheduler auth, idempotent, safe on any cadence.
   *
   * Returns 200 even when the keeper alarms, and carries `alarm: true` in the body. A 5xx
   * would make Cloud Scheduler retry a condition retrying cannot fix — a keeper that cannot
   * open an epoch because the chain refuses it will refuse identically one minute later — and
   * the retry storm would bury the one log line an operator needs. The ALARM is the signal;
   * the status code is transport.
   */
  router.post(EPOCH_KEEPER_PATH, async (req: Request, res: Response) => {
    if (!await deps.authenticateScheduler(req)) {
      res.status(403).json({ error: 'Unauthorized' });
      return;
    }
    try {
      const { keeper, capClock, signer } = await runEpochKeeperRuntime({ db, log });
      if (keeper.lag.alarm) {
        console.error(`[pvt9-epoch-keeper] ALARM ${keeper.lag.level}: ${keeper.lag.message}`);
      }
      if (capClock.alarm) {
        console.error(`[pvt9-epoch-keeper] CAP CLOCK ${capClock.level}: ${capClock.message}`);
      }
      res.json({
        signer,
        outcome: keeper.outcome,
        stopReason: keeper.stopReason,
        opened: keeper.opened,
        stillOwed: keeper.stillOwed,
        detail: keeper.detail,
        alarm: keeper.lag.alarm || capClock.alarm,
        lag: keeper.lag,
        capClock: { level: capClock.level, alarm: capClock.alarm, message: capClock.message },
      });
    } catch (error) {
      if (error instanceof OperatorRefusal) {
        console.error(`[pvt9-epoch-keeper] REFUSED (${error.reason}): ${error.message}`);
        res.status(refusalStatus(error.reason))
          .json({ error: error.reason, message: error.message, alarm: true });
        return;
      }
      // An unhandled failure IS an alarm: the epoch clock is the thing this route exists to
      // keep running, and a quiet 500 is how it stops without anyone noticing.
      console.error('[pvt9-epoch-keeper] FAILED:', error);
      res.status(500).json({ error: 'epoch_keeper_failed', alarm: true });
    }
  });

  /**
   * The settlement run. TWO authenticated ways in — deliberately different postures:
   *
   * 1. SCHEDULER auth : the daily automatic run (Cloud Scheduler,
   * `provian-pvt9-settlement`, `0 12 * * *`, ). Same auth the epoch keeper uses
   * (OIDC / shared secret), so the arming token never lives in scheduler
   * config. A scheduled call fires a REAL settlement — the standing gate is the
   * `PVT9_SETTLEMENT_ARMED` env inside runSettlement, which still refuses an
   * unarmed deploy. Idempotent (mint-once by claim_key), so a Scheduler retry
   * cannot double-mint. Tried FIRST so a scheduled call needs neither the admin
   * key nor the body token.
   * 2. ADMIN auth (UNCHANGED): the manual operator route. Admin key + armed env +
   * the arming token echoed in the body for a real run; `{"dryRun" true}` is a
   * keyless read of what would settle. This path is exactly as safe as before —
   * the "a person typing this string" gate is preserved for hand runs.
   */
  const handleSettlementRun = async (
    req: Request,
    res: Response,
    forcedLane?: 'genesis' | 'standard',
  ): Promise<void> => {
    // the lane this run SETTLES. A dedicated path forces it (the daily
    // Genesis endpoint passes 'genesis'); otherwise an optional `lane` in the POST
    // body scopes it — 'genesis', 'standard', or 'both' (the default / daily path
    // / any body without `lane`). Registration still covers both lanes; only
    // settlement is scoped. Anything unrecognized fails closed to 'both'.
    const rawLane = (req.body as { lane?: unknown } | undefined)?.lane;
    const lane: 'both' | 'genesis' | 'standard' =
      forcedLane ?? (rawLane === 'genesis' || rawLane === 'standard' ? rawLane : 'both');

    // (1) Scheduled automatic path. A valid Cloud Scheduler identity fires a real run.
    if (await deps.authenticateScheduler(req)) {
      try {
        const result = await runSettlement({ db, dryRun: false, log, lane });
        const summary = summarizeSettlementRun(result);
        // a partial settlement stop is NO LONGER silent. A run that stopped
        // for a non-benign reason (e.g. `resumption_abort`) left eligible backlog
        // unsettled; page it loudly at console.error and carry `alarm:true` in the
        // response, instead of the prior console.log INFO + 200 that let a stuck
        // scheduled cron accumulate a backlog invisibly. Observability only.
        const alarm = settlementRunNeedsAlarm(result);
        if (alarm) {
          console.error(
            `[pvt9-settlement-run] SCHEDULED ALARM — settlement STOPPED `
            + `(${result.settlement?.stopReason}); eligible backlog left unsettled: `
            + `${JSON.stringify(summary)}`,
          );
        } else {
          console.log(`[pvt9-settlement-run] SCHEDULED ${JSON.stringify(summary)}`);
        }
        res.json({ ...summary, alarm });
      } catch (error) {
        if (error instanceof OperatorRefusal) {
          console.error(`[pvt9-settlement-run] SCHEDULED REFUSED (${error.reason}): ${error.message}`);
          res.status(refusalStatus(error.reason))
            .json({ error: error.reason, message: error.message });
          return;
        }
        console.error('[pvt9-settlement-run] SCHEDULED FAILED:', error);
        res.status(500).json({ error: 'settlement_run_failed' });
      }
      return;
    }

    // (2) Manual operator path — UNCHANGED. Admin auth + armed env + body token.
    if (!authenticateOperator(req, res)) return;

    const body = (req.body ?? {}) as { dryRun?: unknown; confirm?: unknown };
    const dryRun = body.dryRun === true;

    if (!dryRun && body.confirm !== ARMING_TOKEN) {
      // The environment alone must never be enough for a HAND run. A deploy that
      // carries the arming token is a deploy, not a decision to settle; the manual
      // decision is a person typing this string. (The scheduler path above is the
      // deliberately-automated exception, gated by a verified Cloud Scheduler identity.)
      res.status(400).json({
        error: 'confirmation_required',
        message: `Settling requires "confirm": "${ARMING_TOKEN}" in the request body, `
          + 'in addition to the armed environment. Use {"dryRun": true} to see what would settle.',
      });
      return;
    }

    try {
      const result = await runSettlement({ db, dryRun, log, lane });
      const summary = summarizeSettlementRun(result);
      // same loud alarm as the scheduled path — a non-benign settlement
      // stop pages at console.error + carries `alarm:true`, never a silent 200.
      const alarm = settlementRunNeedsAlarm(result);
      if (alarm) {
        console.error(
          `[pvt9-settlement-run] ALARM — settlement STOPPED `
          + `(${result.settlement?.stopReason}); eligible backlog left unsettled: `
          + `${JSON.stringify(summary)}`,
        );
      } else {
        console.log(`[pvt9-settlement-run] ${JSON.stringify(summary)}`);
      }
      res.json({ ...summary, alarm });
    } catch (error) {
      if (error instanceof OperatorRefusal) {
        console.error(`[pvt9-settlement-run] REFUSED (${error.reason}): ${error.message}`);
        res.status(refusalStatus(error.reason))
          .json({ error: error.reason, message: error.message });
        return;
      }
      console.error('[pvt9-settlement-run] FAILED:', error);
      res.status(500).json({ error: 'settlement_run_failed' });
    }
  };

  // Daily (default) path — settles both lanes (Genesis-first) plus the attestation
  // top-up rows, or the lane named in the body. This is the `provian-pvt9-settlement`
  // cron (0 12 * * *, epoch-aligned, ).
  router.post(SETTLEMENT_RUN_PATH, (req: Request, res: Response) => { void handleSettlementRun(req, res); });
  // Genesis-only path — the Genesis lane's daily pass (00:00 UTC); standard rows
  // wait for the next due daily both-lanes run or an on-demand payout. This is the `provian-pvt9-genesis-settlement`
  // cron (0 0 * * *). Same auth + arming.
  router.post(SETTLEMENT_GENESIS_RUN_PATH, (req: Request, res: Response) => { void handleSettlementRun(req, res, 'genesis'); });

  return router;
}
