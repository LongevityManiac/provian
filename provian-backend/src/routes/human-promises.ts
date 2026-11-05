/**
 * Human P2P promise — relay API routes.
 *
 * The human IOU lifecycle now runs here under HUMAN WALLET AUTH, replacing the
 * Firestore `promise_sync` side-channel. This router is mounted BEHIND the
 * top-level `authenticate` middleware, so `req.user!.id` is the authenticated
 * account; the caller's OWN first-party human EVM address is resolved server-side
 * via `resolveHumanWallet` (never client-supplied), and every transition is
 * authorized only by that wallet as a party to the promise.
 *
 * Every transition pushes to the counterparty via `sendPushToUser` (best-effort,
 * never gates the write) so a foregrounded peer refreshes in real time — the
 * replacement for the retired Firestore `onSnapshot` listener.
 */

import { Router, Request, Response } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import { resolveHumanWallet } from '../core/presentation/principal';
import { sendPushToUser } from '../core/notifications/pushDispatcher';
import { bumpOpsCounter } from '../core/observability/ops-counters';
import { ValidationError, NotFoundError, ForbiddenError, RateLimitError } from '../core/agent-bank/errors';
import {
  createHumanPromise,
  acceptHumanPromise,
  counterHumanPromise,
  rejectHumanPromise,
  closeOutHumanPromise,
  disputeHumanPromise,
  brokenHumanPromise,
  getHumanPromise,
  listMyHumanPromises,
  type HumanPromiseCaller,
} from '../core/human-promises/human-promises';
import type { HumanPromiseDocument } from '../core/human-promises/types';

interface HumanPromisesRouterDeps {
  db: Firestore;
  cache: {
    checkRateLimitStrict(key: string, max: number, windowSeconds: number): Promise<{ allowed: boolean; retryAfter?: number }>;
  };
}

const PROMISE_NOTIFICATION_CHANNEL = 'promises';

function handleError(res: Response, error: unknown): void {
  if (error instanceof RateLimitError) {
    res.status(429).json({ error: error.message });
  } else if (error instanceof ValidationError) {
    res.status(400).json({ error: error.message });
  } else if (error instanceof NotFoundError) {
    res.status(404).json({ error: error.message });
  } else if (error instanceof ForbiddenError) {
    res.status(403).json({ error: error.message });
  } else {
    console.error('[HumanPromises] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Best-effort address → user_id via the lowercased `users.wallet_address` index
 * (written lowercased on registration). Fail-closed: 0 or an ambiguous match
 * returns null and the push is simply skipped — a push must never fabricate a
 * recipient or fail a transition.
 */
async function resolveUserIdByAddress(db: Firestore, address: string): Promise<string | null> {
  try {
    const snap = await db.collection('users')
      .where('wallet_address', '==', address.toLowerCase())
      .limit(2)
      .get();
    if (snap.size === 1) return snap.docs[0].id;
    return null;
  } catch {
    return null;
  }
}

/** The party address that is NOT the caller (the one to notify). */
function counterpartyAddressOf(promise: HumanPromiseDocument, callerAddress: string): string | null {
  if (promise.creator_address === callerAddress) return promise.acceptor_address;
  if (promise.acceptor_address === callerAddress) return promise.creator_address;
  return null;
}

/** Fire a promise_* push to the counterparty. Best-effort; never throws. */
async function pushToCounterparty(
  db: Firestore,
  promise: HumanPromiseDocument,
  callerAddress: string,
  type: string,
  title: string,
  body: string,
): Promise<void> {
  try {
    const counterparty = counterpartyAddressOf(promise, callerAddress);
    if (!counterparty) return;
    const userId = await resolveUserIdByAddress(db, counterparty);
    if (!userId) return;
    const pushResult = await sendPushToUser(db, userId, {
      title,
      body,
      data: { type, promise_id: promise.promise_id },
      channelId: PROMISE_NOTIFICATION_CHANNEL,
      priority: 'high',
    });
    // Ops observability (Part D): promise-transition push delivery, distinct from the
    // aggregate push.* the dispatcher already bumps. Structure-only — no user/promise ids.
    if (pushResult.successCount > 0) bumpOpsCounter('promise_push.sent', pushResult.successCount);
    if (pushResult.failureCount > 0) bumpOpsCounter('promise_push.failed', pushResult.failureCount);
  } catch (err) {
    console.warn('[HumanPromises] push skipped:', (err as Error)?.message);
  }
}

export function createHumanPromisesRouter(deps: HumanPromisesRouterDeps): Router {
  const { db, cache } = deps;
  const router = Router();

  /** Resolve the authenticated caller's own human wallet, or 4xx. */
  async function resolveCaller(req: Request, res: Response): Promise<HumanPromiseCaller | null> {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return null;
    }
    const resolved = await resolveHumanWallet(db, userId);
    if (!resolved.ok) {
      res.status(resolved.status).json({ error: resolved.error });
      return null;
    }
    return { userId, address: resolved.address };
  }

  // POST /create → pending
  router.post('/create', async (req: Request, res: Response) => {
    try {
      const caller = await resolveCaller(req, res);
      if (!caller) return;
      const rl = await cache.checkRateLimitStrict(`rl:hpromise:create:${caller.userId}`, 30, 60);
      if (!rl.allowed) {
        res.status(429).json({ error: 'Rate limit exceeded', retry_after: rl.retryAfter });
        return;
      }
      const promise = await createHumanPromise(db, caller, {
        promiseId: req.body.promise_id,
        digest: req.body.digest,
        signature: req.body.signature,
        termsCiphertext: req.body.terms_ciphertext,
      });
      res.status(201).json({ promise_id: promise.promise_id, status: promise.status });
    } catch (error) {
      handleError(res, error);
    }
  });

  // POST /:promise_id/accept → accepted
  router.post('/:promise_id/accept', async (req: Request, res: Response) => {
    try {
      const caller = await resolveCaller(req, res);
      if (!caller) return;
      const promise = await acceptHumanPromise(db, caller, {
        promiseId: req.params.promise_id,
        digest: req.body.digest,
        signature: req.body.signature,
        termsCiphertext: req.body.terms_ciphertext,
      });
      await pushToCounterparty(db, promise, caller.address, 'promise_accepted',
        'Promise accepted', 'Your promise was accepted.');
      res.json({ promise_id: promise.promise_id, status: promise.status });
    } catch (error) {
      handleError(res, error);
    }
  });

  // POST /:promise_id/counter → countered
  router.post('/:promise_id/counter', async (req: Request, res: Response) => {
    try {
      const caller = await resolveCaller(req, res);
      if (!caller) return;
      const promise = await counterHumanPromise(db, caller, {
        promiseId: req.params.promise_id,
        digest: req.body.digest,
        signature: req.body.signature,
        termsCiphertext: req.body.terms_ciphertext,
      });
      await pushToCounterparty(db, promise, caller.address, 'promise_countered',
        'Counter-offer', 'You received a counter-offer on a promise.');
      res.json({ promise_id: promise.promise_id, status: promise.status });
    } catch (error) {
      handleError(res, error);
    }
  });

  // POST /:promise_id/reject → rejected
  router.post('/:promise_id/reject', async (req: Request, res: Response) => {
    try {
      const caller = await resolveCaller(req, res);
      if (!caller) return;
      const promise = await rejectHumanPromise(db, caller, req.params.promise_id);
      await pushToCounterparty(db, promise, caller.address, 'promise_rejected',
        'Promise declined', 'A promise was declined.');
      res.json({ promise_id: promise.promise_id, status: promise.status });
    } catch (error) {
      handleError(res, error);
    }
  });

  // POST /:promise_id/close-out → fulfilled (once both parties sign)
  router.post('/:promise_id/close-out', async (req: Request, res: Response) => {
    try {
      const caller = await resolveCaller(req, res);
      if (!caller) return;
      const result = await closeOutHumanPromise(db, caller, {
        promiseId: req.params.promise_id,
        signature: req.body.signature,
      });
      const type = result.mode === 'fulfilled' ? 'promise_fulfilled' : 'promise_closeout_requested';
      const body = result.mode === 'fulfilled'
        ? 'A promise was completed.'
        : 'The other party marked a promise complete — confirm to close it out.';
      await pushToCounterparty(db, result.promise, caller.address, type, 'Promise update', body);
      res.json({ promise_id: result.promise.promise_id, status: result.promise.status, mode: result.mode });
    } catch (error) {
      handleError(res, error);
    }
  });

  // POST /:promise_id/dispute → disputed
  router.post('/:promise_id/dispute', async (req: Request, res: Response) => {
    try {
      const caller = await resolveCaller(req, res);
      if (!caller) return;
      const promise = await disputeHumanPromise(db, caller, req.params.promise_id);
      await pushToCounterparty(db, promise, caller.address, 'promise_disputed',
        'Promise disputed', 'A promise was disputed.');
      res.json({ promise_id: promise.promise_id, status: promise.status });
    } catch (error) {
      handleError(res, error);
    }
  });

  // POST /:promise_id/broken → broken
  router.post('/:promise_id/broken', async (req: Request, res: Response) => {
    try {
      const caller = await resolveCaller(req, res);
      if (!caller) return;
      const promise = await brokenHumanPromise(db, caller, req.params.promise_id);
      await pushToCounterparty(db, promise, caller.address, 'promise_broken',
        'Promise broken', 'A promise was marked broken.');
      res.json({ promise_id: promise.promise_id, status: promise.status });
    } catch (error) {
      handleError(res, error);
    }
  });

  // GET /mine → all promises the caller is a party to (recovery + sync)
  router.get('/mine', async (req: Request, res: Response) => {
    try {
      const caller = await resolveCaller(req, res);
      if (!caller) return;
      const promises = await listMyHumanPromises(db, caller);
      res.json({ promises, count: promises.length, my_address: caller.address });
    } catch (error) {
      handleError(res, error);
    }
  });

  // GET /:promise_id → one promise by id (possession is the read capability)
  router.get('/:promise_id', async (req: Request, res: Response) => {
    try {
      const caller = await resolveCaller(req, res);
      if (!caller) return;
      const promise = await getHumanPromise(db, req.params.promise_id);
      res.json({ promise });
    } catch (error) {
      handleError(res, error);
    }
  });

  return router;
}
