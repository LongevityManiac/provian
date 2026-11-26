/**
 * /v1/passkey-backup — the web app's passkey backup of a wallet seed (core/wallet/passkey-backup.ts).
 *
 *   PUT    /            wallet auth   store or replace this account's backup for one passkey
 *   GET    /            wallet auth   which passkeys hold a backup (no envelopes)
 *   DELETE /            wallet auth   erase every passkey backup of this account
 *   POST   /challenge   none          a single-use challenge (5 minutes) for the passkey to sign
 *   POST   /fetch       none          the backup, for a valid assertion of its passkey
 */
import express, { type Request, type Response, type RequestHandler } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import type { RedisCache } from '../cache';
import {
    PasskeyBackupError,
    deletePasskeyBackups,
    fetchPasskeyBackup,
    issuePasskeyChallenge,
    listPasskeyBackups,
    storePasskeyBackup,
    type AssertionInput,
} from '../core/wallet/passkey-backup';

export interface PasskeyBackupRouterDeps {
    db: Firestore;
    cache: RedisCache;
    authenticate: RequestHandler;
}

function sendError(res: Response, err: unknown, label: string): void {
    if (err instanceof PasskeyBackupError) {
        res.status(err.status).json({ error: err.code });
        return;
    }
    console.error(`[PasskeyBackup] ${label} failed:`, err);
    res.status(500).json({ error: 'internal_error' });
}

export function createPasskeyBackupRouter(deps: PasskeyBackupRouterDeps): express.Router {
    const { db, cache, authenticate } = deps;
    const router = express.Router();

    const clientIp = (req: Request): string => req.ip || req.socket.remoteAddress || 'unknown';

    router.put('/', authenticate, async (req: Request, res: Response) => {
        try {
            const userId = req.user!.id;
            const user = await db.collection('users').doc(userId).get();
            const accountWalletAddress = user.exists && typeof user.data()?.wallet_address === 'string' ? user.data()!.wallet_address as string : null;
            const stored = await storePasskeyBackup(db, { userId, accountWalletAddress, body: (req.body ?? {}) as Record<string, unknown> });
            res.status(200).json({ stored: true, ...stored });
        } catch (err) {
            sendError(res, err, 'store');
        }
    });

    router.get('/', authenticate, async (req: Request, res: Response) => {
        try {
            res.json({ backups: await listPasskeyBackups(db, req.user!.id) });
        } catch (err) {
            sendError(res, err, 'list');
        }
    });

    router.delete('/', authenticate, async (req: Request, res: Response) => {
        try {
            res.json({ deleted: await deletePasskeyBackups(db, req.user!.id) });
        } catch (err) {
            sendError(res, err, 'delete');
        }
    });

    router.post('/challenge', async (req: Request, res: Response) => {
        const limited = await cache.checkRateLimitStrict(`rl:passkey-backup:challenge:ip:${clientIp(req)}`, 30, 600);
        if (limited.error === 'rate_limit_unavailable') {
            res.status(503).json({ error: 'temporarily_unavailable' });
            return;
        }
        if (!limited.allowed) {
            res.status(429).json({ error: 'rate_limited', retry_after: limited.retryAfter });
            return;
        }
        try {
            res.json(await issuePasskeyChallenge(db));
        } catch (err) {
            sendError(res, err, 'challenge');
        }
    });

    router.post('/fetch', async (req: Request, res: Response) => {
        const limited = await cache.checkRateLimitStrict(`rl:passkey-backup:fetch:ip:${clientIp(req)}`, 20, 3600);
        if (limited.error === 'rate_limit_unavailable') {
            res.status(503).json({ error: 'temporarily_unavailable' });
            return;
        }
        if (!limited.allowed) {
            res.status(429).json({ error: 'rate_limited', retry_after: limited.retryAfter });
            return;
        }
        try {
            res.json(await fetchPasskeyBackup(db, (req.body ?? {}) as AssertionInput));
        } catch (err) {
            sendError(res, err, 'fetch');
        }
    });

    return router;
}
