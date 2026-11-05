/**
 * Setup Routes
 *
 * Generates one-time device registration tokens for the copy-paste setup
 * flow. The mobile app's Developer Settings surfaces these tokens so users
 * can register additional devices without needing to re-authenticate a
 * wallet on each host. The emitted command is the hosted curl register line
 * (core/setup-command.ts); the npx SDK one-liner returns at public launch
 * when the package publishes.
 *
 * Endpoints:
 *   GET  /ping           - Health check for wallet auth
 *   POST /generate-token - Generate a device registration token (wallet auth)
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import {
  buildDeviceRegisterCommand,
  mintCommandIdempotencyKey,
  resolveRelayUrl,
} from '../core/setup-command';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SetupRouterDeps {
  db: Firestore;
  cache: {
    checkRateLimit: (key: string, limit: number, windowSeconds: number) => Promise<{ allowed: boolean; retryAfter?: number }>;
  };
}

interface AuthenticatedRequest extends Request {
  user?: { id: string; device_id: string };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createSetupRouter(deps: SetupRouterDeps): Router {
  const { db } = deps;
  const router = Router();

  // =========================================================================
  // GET /ping - Health check for wallet auth
  // =========================================================================
  router.get('/ping', (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    res.json({ ok: true, user_id: authReq.user?.id || 'unknown' });
  });

  // =========================================================================
  // POST /generate-token - Generate device registration token (wallet auth)
  // =========================================================================
  router.post('/generate-token', async (req: Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.user?.id;

      if (!userId) {
        res.status(401).json({ error: 'Wallet authentication required' });
        return;
      }

      // --- Rate limiting: 5 active (unused, unexpired) tokens per user ---
      // Simple query (no compound index required) - filter in memory
      const now = Date.now();
      const recentTokens = await db.collection('setup_tokens')
        .where('user_id', '==', userId)
        .where('used', '==', false)
        .get();

      const activeCount = recentTokens.docs.filter(d => {
        const data = d.data();
        return data.type === 'device_registration' && data.expires_at > now;
      }).length;

      if (activeCount >= 5) {
        res.status(429).json({
          error: 'Too many active tokens. Wait for existing tokens to expire or use them first.',
          active_count: activeCount,
        });
        return;
      }

      // --- Generate token ---
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = now + 60 * 60 * 1000; // 1 hour

      await db.collection('setup_tokens').doc(token).set({
        user_id: userId,
        type: 'device_registration',
        created_at: now,
        expires_at: expiresAt,
        used: false,
      });

      const relayUrl = resolveRelayUrl();

      // Pre-flip the SDK is unpublished (npm E404): step_1 is the hosted curl
      // register flow — the exact endpoint that consumes this token. The
      // idempotency key is minted per response so a re-run of the same line
      // replays the original registration instead of failing.
      res.json({
        token,
        expires_at: expiresAt,
        instructions: {
          step_1: buildDeviceRegisterCommand({
            token,
            idempotencyKey: mintCommandIdempotencyKey(),
            relayUrl,
          }),
          step_2: 'Save the device_key / device_secret printed by the response (shown once); the device sends its daily signed batch with them at POST /v1/meter/batch.',
          relay_url: relayUrl,
          note: 'This token expires in 1 hour and is single-use; re-running the same line replays the original registration.',
        },
      });
    } catch (error) {
      console.error('[Setup] Generate token error:', error);
      res.status(500).json({ error: 'Failed to generate token' });
    }
  });

  return router;
}
