/**
 * — on-demand payout routes.
 *
 * POST /v1/payout agent API key. x402: no `PAYMENT-SIGNATURE` → 402 with the $1
 * requirement (or 409 nothing_to_pay, 503 waits_for_gas — nothing
 * charged); with it → charge, and answer once the charge is decided
 * (202 `charged`;). The settlement of the agent's own address
 * runs from the sweep, never inside the paid request.
 * POST /v1/payout/mobile human wallet auth. Body `{ payee?, payment? }` the person's own Base
 * wallet address (default: their only one) and the base64 x402 payment
 * the app signed with that wallet's key. Same terms, same flow.
 * GET /v1/payout/:id the requester's own request (agent or person).
 * POST /v1/internal/scheduler/payout-sweep scheduler auth: finish charged requests.
 *
 * The path sits OUTSIDE `/v1/pvt` on purpose: that namespace is the PVT9 runtime boundary's
 * read-only window and stays that way. Nothing here mints by itself — the settlement it runs is
 * the same PVT9 runtime the daily run uses, scoped to one payee.
 */
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import {
  advancePayout,
  PAYOUT_REQUESTS_COLLECTION,
  publicPayoutView,
  requestPayout,
  sweepPayouts,
  type PayoutDeps,
  type PayoutRequestDoc,
  type PayoutResponse,
} from '../core/payout/on-demand-payout';
import { encodeHeaderJson, PAYOUT_NETWORK, payoutPaymentRequired } from '../core/payout/payout-terms';

const WALLETS_COLLECTION = 'wallets';
const ADDRESS = /^0x[0-9a-f]{40}$/;
const REQUEST_ID = /^po_[0-9a-f]{40}$/;

export interface PayoutRouterDeps {
  readonly db: Firestore;
  readonly authenticateAgent: RequestHandler;
  readonly authenticateWallet: RequestHandler;
  readonly authenticateScheduler: (req: Request) => Promise<boolean>;
  /** Null while the payout gas key or RPC is not configured: every payout route answers 503. */
  readonly payoutDeps: () => PayoutDeps | null;
  readonly publicBaseUrl: string;
}

function respond(res: Response, outcome: PayoutResponse, resourceUrl: string): void {
  switch (outcome.kind) {
    case 'payment_required': {
      const body = payoutPaymentRequired(resourceUrl, outcome.error);
      res.setHeader('PAYMENT-REQUIRED', encodeHeaderJson(body));
      res.status(402).json({
        ...body,
        ...(outcome.work !== undefined ? {
          ready: {
            claims: outcome.work.claims,
            record_points_atomic: outcome.work.pointsAtomic.toString(10),
          },
        } : {}),
        ...(outcome.gas !== undefined ? { estimated_gas_usd: Number(outcome.gas.costUsd.toFixed(4)) } : {}),
      });
      return;
    }
    case 'nothing_to_pay':
      res.status(409).json({
        error: 'nothing_to_pay',
        message: 'No earnings are ready to settle for this payee. Nothing was charged.',
      });
      return;
    case 'waits_for_gas':
      res.setHeader('Retry-After', '600');
      res.status(503).json({
        error: 'waits_for_gas',
        message: 'Base gas for this payout is above the $1 fee right now. Nothing was charged; try again later.',
        estimated_gas_usd: Number.isFinite(outcome.costUsd) ? Number(outcome.costUsd.toFixed(4)) : null,
      });
      return;
    case 'not_your_request':
      res.status(409).json({ error: 'payment_already_used', message: 'This payment belongs to another payout request.' });
      return;
    case 'request': {
      const request = outcome.request;
      if (request.charge_tx_hash !== null) {
        res.setHeader('PAYMENT-RESPONSE', encodeHeaderJson({
          success: request.state !== 'charge_failed',
          payer: request.payer,
          transaction: request.charge_tx_hash,
          network: PAYOUT_NETWORK,
        }));
      }
      res.status(request.state === 'settled' ? 200 : request.state === 'charge_failed' ? 402 : 202)
        .json(publicPayoutView(request));
    }
  }
}

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function createPayoutRouter(deps: PayoutRouterDeps): Router {
  const router = Router();
  const resource = (path: string): string => `${deps.publicBaseUrl.replace(/\/$/, '')}${path}`;

  const withPayout = (handler: (req: Request, res: Response, payout: PayoutDeps) => Promise<void>) =>
    async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
      const payout = deps.payoutDeps();
      if (payout === null) {
        res.status(503).json({ error: 'payout_not_configured' });
        return;
      }
      try {
        await handler(req, res, payout);
      } catch (error) {
        console.error('[payout] failed', error instanceof Error ? error.message : error);
        if (!res.headersSent) res.status(500).json({ error: 'payout_failed' });
      }
    };

  router.post('/v1/payout', deps.authenticateAgent, withPayout(async (req, res, payout) => {
    const wallet = req.agentWallet;
    if (wallet === undefined || wallet.status !== 'active') {
      res.status(403).json({ error: 'agent_wallet_inactive' });
      return;
    }
    const payee = String(wallet.address ?? '').toLowerCase();
    if (!ADDRESS.test(payee)) {
      res.status(409).json({ error: 'payee_address_unusable' });
      return;
    }
    const outcome = await requestPayout(payout, {
      payee, payeeKind: 'agent', requestedBy: wallet.id, paymentHeader: header(req, 'payment-signature'),
    });
    respond(res, outcome, resource('/v1/payout'));
  }));

  router.post('/v1/payout/mobile', deps.authenticateWallet, withPayout(async (req, res, payout) => {
    const userId = req.userId;
    if (userId === undefined) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const owned = await deps.db.collection(WALLETS_COLLECTION).where('user_id', '==', userId).get();
    const addresses = owned.docs
      .map((d) => d.data() as { type?: unknown; address?: unknown })
      .filter((w) => w.type === undefined || w.type === 'human')
      .map((w) => String(w.address ?? '').toLowerCase())
      .filter((a) => ADDRESS.test(a));
    const body = (req.body ?? {}) as { payee?: unknown; payment?: unknown };
    const requested = typeof body.payee === 'string' ? body.payee.toLowerCase() : null;
    const unique = [...new Set(addresses)];
    const payee = requested ?? (unique.length === 1 ? unique[0] : null);
    if (payee === null || !unique.includes(payee)) {
      res.status(400).json({ error: 'payee_not_your_wallet', wallets: unique.length });
      return;
    }
    const paymentHeader = typeof body.payment === 'string' && body.payment.length > 0
      ? body.payment
      : header(req, 'payment-signature');
    const outcome = await requestPayout(payout, { payee, payeeKind: 'human', requestedBy: userId, paymentHeader });
    respond(res, outcome, resource('/v1/payout/mobile'));
  }));

  const readOwn = async (req: Request, res: Response, requester: string | undefined): Promise<void> => {
    const id = String(req.params.request_id ?? '');
    if (!REQUEST_ID.test(id) || requester === undefined) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const snap = await deps.db.collection(PAYOUT_REQUESTS_COLLECTION).doc(id).get();
    const request = snap.exists ? (snap.data() as PayoutRequestDoc) : null;
    if (request === null || request.requested_by !== requester) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(publicPayoutView(request));
  };
  router.get('/v1/payout/:request_id', (req, res, next) => {
    const auth = req.headers.authorization ?? '';
    const chain = auth.startsWith('Bearer pvn_live_') ? deps.authenticateAgent : deps.authenticateWallet;
    chain(req, res, () => {
      void readOwn(req, res, req.agentWallet?.id ?? req.userId).catch(next);
    });
  });

  // The app asks the relay to finish a charged request it is watching (idempotent; the sweep does
  // the same on its schedule).
  router.post('/v1/payout/:request_id/advance', deps.authenticateWallet, withPayout(async (req, res, payout) => {
    const id = String(req.params.request_id ?? '');
    const snap = REQUEST_ID.test(id) ? await deps.db.collection(PAYOUT_REQUESTS_COLLECTION).doc(id).get() : null;
    const request = snap?.exists ? (snap.data() as PayoutRequestDoc) : null;
    if (request === null || request.requested_by !== req.userId) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(publicPayoutView(await advancePayout(payout, id)));
  }));

  router.post('/v1/internal/scheduler/payout-sweep', async (req: Request, res: Response) => {
    if (!await deps.authenticateScheduler(req)) {
      res.status(403).json({ error: 'Unauthorized' });
      return;
    }
    const payout = deps.payoutDeps();
    if (payout === null) {
      res.json({ skipped: 'payout_not_configured' });
      return;
    }
    try {
      res.json(await sweepPayouts(payout));
    } catch (error) {
      console.error('[payout-sweep] FAILED', error instanceof Error ? error.message : error);
      res.status(500).json({ error: 'payout_sweep_failed' });
    }
  });

  return router;
}
