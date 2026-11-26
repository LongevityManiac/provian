/**
 * /v1/handoff — moving a wallet between the phone app and the web app with a QR code
 * (core/wallet/wallet-qr-move.ts). No wallet auth: the receiving device has no credentials yet.
 * Each side is its own bearer token; the relay only ever holds ciphertext it cannot open, and
 * deletes the session at pickup, cancel or expiry (10 minutes).
 *
 *   POST /          the web app opens a session (mode send|receive) and shows the code
 *   POST /join      the phone joins after scanning (once)
 *   POST /state     either side: is the other side there, its label, the receiver's key
 *   POST /seal      the sender leaves the sealed seed (once)
 *   POST /take      the receiver picks it up; the session is deleted
 *   POST /cancel    either side ends the session
 */
import express, { type Request, type Response } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import type { RedisCache } from '../cache';
import {
    HandoffError,
    cancelHandoff,
    handoffState,
    joinHandoff,
    openHandoff,
    sealHandoff,
    takeHandoff,
} from '../core/wallet/wallet-qr-move';

export interface WalletHandoffRouterDeps {
    db: Firestore;
    cache: RedisCache;
}

/** Per-IP limits. State and take are polled about once a second for at most ten minutes. */
export const HANDOFF_RATE_LIMITS = {
    open: { limit: 20, windowSeconds: 600 },
    join: { limit: 30, windowSeconds: 600 },
    state: { limit: 1500, windowSeconds: 600 },
    seal: { limit: 20, windowSeconds: 600 },
    take: { limit: 1500, windowSeconds: 600 },
    cancel: { limit: 60, windowSeconds: 600 },
} as const;

type Action = keyof typeof HANDOFF_RATE_LIMITS;

export function createWalletHandoffRouter(deps: WalletHandoffRouterDeps): express.Router {
    const { db, cache } = deps;
    const router = express.Router();
    const clientIp = (req: Request): string => req.ip || req.socket.remoteAddress || 'unknown';

    const handle = (action: Action, run: (body: Record<string, unknown>) => Promise<unknown>) =>
        async (req: Request, res: Response): Promise<void> => {
            const { limit, windowSeconds } = HANDOFF_RATE_LIMITS[action];
            const limited = await cache.checkRateLimitStrict(`rl:handoff:${action}:ip:${clientIp(req)}`, limit, windowSeconds);
            if (limited.error === 'rate_limit_unavailable') {
                res.status(503).json({ error: 'temporarily_unavailable' });
                return;
            }
            if (!limited.allowed) {
                res.status(429).json({ error: 'rate_limited', retry_after: limited.retryAfter });
                return;
            }
            try {
                const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
                res.json(await run(body));
            } catch (err) {
                if (err instanceof HandoffError) {
                    res.status(err.status).json({ error: err.code });
                    return;
                }
                console.error(`[Handoff] ${action} failed:`, err);
                res.status(500).json({ error: 'internal_error' });
            }
        };

    router.post('/', handle('open', body => openHandoff(db, body)));
    router.post('/join', handle('join', body => joinHandoff(db, body)));
    router.post('/state', handle('state', body => handoffState(db, body)));
    router.post('/seal', handle('seal', body => sealHandoff(db, body)));
    router.post('/take', handle('take', body => takeHandoff(db, body)));
    router.post('/cancel', handle('cancel', body => cancelHandoff(db, body)));
    return router;
}
