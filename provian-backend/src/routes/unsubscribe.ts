/**
 * POST/GET /v1/unsubscribe — the functional email unsubscribe surface.
 *
 * This is the real suppression page (audit 2026-08-05, finding 17), served by
 * the relay itself rather than the marketing site so it needs no separate deploy
 * and is reachable WITHOUT login (the site sits behind a Basic Auth wall; an
 * unsubscribe link must never require signing in). It is public and un-gated by
 * PUBLIC_LAUNCH — invites go out before launch, so their unsubscribe must work
 * before launch too.
 *
 *   GET  /v1/unsubscribe?token=…  — the one-click link in the email footer.
 *                                   Verifies the signed token, suppresses the
 *                                   address, and renders a self-contained
 *                                   confirmation page (no external assets).
 *   POST /v1/unsubscribe          — RFC 8058 List-Unsubscribe-Post one-click,
 *                                   which email clients fire automatically. Same
 *                                   suppression, JSON response.
 *
 * The token is HMAC-signed and carries the recipient address, so one recipient
 * can never unsubscribe another (no enumeration). Suppression is idempotent.
 */

import { Router, type Request, type Response } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import type { RedisCache } from '../cache';
import { suppressEmail, verifyUnsubscribeToken } from '../core/email/suppression';

export interface UnsubscribeRouterDeps {
  db: Firestore;
  cache: RedisCache;
}

function page(title: string, heading: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex">
<title>${title} · Provian</title>
</head>
<body style="margin:0; padding:0; background:#0B0E14; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
<div style="max-width:520px; margin:0 auto; padding:64px 24px;">
<p style="font-size:20px; line-height:30px; color:#e8eaed; font-weight:600; margin:0 0 12px;">${heading}</p>
<p style="font-size:15px; line-height:24px; color:#b8bcc4; margin:0;">${body}</p>
<p style="font-size:13px; line-height:20px; color:#8a8f9a; margin-top:40px;">Provian &middot; Proving provenance.</p>
</div>
</body>
</html>`;
}

const DONE_PAGE = page(
  'Unsubscribed',
  "You're unsubscribed.",
  'You will no longer receive Provian invitation emails at this address. '
    + 'This does not delete any wallet or account — it only stops these emails.',
);

const INVALID_PAGE = page(
  'Unsubscribe link invalid',
  'This link is no longer valid.',
  'The unsubscribe link is invalid or has been altered. If you keep receiving '
    + 'emails you did not ask for, use the unsubscribe link in the most recent one.',
);

/** Extract the token from the query (?token=) or a POST body/form field. */
function extractToken(req: Request): string {
  const fromQuery = req.query.token;
  if (typeof fromQuery === 'string' && fromQuery.length > 0) return fromQuery;
  const body = req.body as { token?: unknown } | undefined;
  if (body && typeof body.token === 'string') return body.token;
  return '';
}

export function createUnsubscribeRouter(deps: UnsubscribeRouterDeps): Router {
  const { db, cache } = deps;
  const router = Router();

  // A light per-IP rate limit — the token gates real abuse, this just caps
  // brute-force probing. Never fail the unsubscribe on a rate-limit read error.
  async function rateLimited(req: Request): Promise<boolean> {
    try {
      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      const result = await cache.checkRateLimit(`rl:unsubscribe:${ip}`, 30, 60);
      return !result.allowed;
    } catch {
      return false;
    }
  }

  router.get('/', async (req: Request, res: Response) => {
    if (await rateLimited(req)) {
      res.status(429).type('html').send(INVALID_PAGE);
      return;
    }
    const email = verifyUnsubscribeToken(extractToken(req));
    if (!email) {
      res.status(400).type('html').send(INVALID_PAGE);
      return;
    }
    try {
      await suppressEmail(db, email, 'unsubscribe_link');
      res.status(200).type('html').send(DONE_PAGE);
    } catch (error) {
      console.error('[Unsubscribe] suppression write failed:', error);
      res.status(500).type('html').send(INVALID_PAGE);
    }
  });

  // RFC 8058 one-click: the client POSTs `List-Unsubscribe=One-Click`. The token
  // rides the URL of the List-Unsubscribe header, so it arrives in the query.
  router.post('/', async (req: Request, res: Response) => {
    if (await rateLimited(req)) {
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    const email = verifyUnsubscribeToken(extractToken(req));
    if (!email) {
      res.status(400).json({ error: 'invalid_token' });
      return;
    }
    try {
      await suppressEmail(db, email, 'list_unsubscribe_post');
      res.status(200).json({ unsubscribed: true });
    } catch (error) {
      console.error('[Unsubscribe] suppression write failed:', error);
      res.status(500).json({ error: 'suppression_failed' });
    }
  });

  return router;
}
