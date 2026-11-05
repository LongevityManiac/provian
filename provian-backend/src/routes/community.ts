/**
 * POST /v1/community/subscribe — the community-updates opt-in.
 *
 * DELIBERATELY IDENTITY-FREE. No authenticate middleware runs here, req.user
 * is never read, and the stored doc carries no wallet/user/device field: the
 * community email list is decoupled from wallet identity by construction
 * (the operator’s requirement — a non-custodial wallet still needs a way to reach
 * its community, but the address must not ride with the wallet).
 *
 * Gate posture: `/v1/community` sits in APP_AUTHED_PRELAUNCH_PREFIXES, so
 * pre-flip an anonymous public-web caller 404s (non-disclosure unchanged)
 * while any Bearer-presenting caller passes — the app presents its wallet
 * token, the CLI presents a placeholder; neither is authenticated here.
 * Post-flip the surface is fully public.
 *
 * Abuse posture (mirrors the invite-email limiter, fail CLOSED on Redis
 * outage): per-IP 10/day and per-email-hash 5/day, an RFC 5321 254-char cap,
 * and ONE generic success body — a duplicate or a suppressed (unsubscribed)
 * address returns the same 200 as a fresh signup, so the endpoint cannot be
 * used to probe who is or was on the list.
 *
 * Storage: the pre-existing `waitlist` collection, doc id =
 * sha256(normalized email) — same scheme the mobile WaitlistService used —
 * so re-subscribing is idempotent and never duplicates. Suppressed addresses
 * (RFC 8058 unsubscribes) are silently NOT re-added; an unsubscribe must be
 * undone by the user subscribing again AFTER the suppression is cleared by
 * ops, never by a drive-by POST.
 */

import { Router, type Request, type Response } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import type { RedisCache } from '../cache';
import { emailHash, isEmailSuppressed, normalizeEmail } from '../core/email/suppression';

export const WAITLIST_COLLECTION = 'waitlist';

export const COMMUNITY_SUBSCRIBE_SOURCES = ['onboarding', 'settings', 'agent', 'general'] as const;
export type CommunitySubscribeSource = (typeof COMMUNITY_SUBSCRIBE_SOURCES)[number];

// Pragmatic shape check, not full RFC 5322: one @, no whitespace, a dot in
// the domain. Deliverability is decided by the mail provider, not this regex.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;

export interface CommunityRouterDeps {
  db: Firestore;
  cache: RedisCache;
}

export function createCommunityRouter(deps: CommunityRouterDeps): Router {
  const { db, cache } = deps;
  const router = Router();

  router.post('/subscribe', async (req: Request, res: Response): Promise<void> => {
    try {
      const rawEmail = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
      if (!rawEmail || rawEmail.length > MAX_EMAIL_LENGTH || !EMAIL_SHAPE.test(rawEmail)) {
        res.status(400).json({ error: 'invalid_email' });
        return;
      }

      const source: CommunitySubscribeSource = COMMUNITY_SUBSCRIBE_SOURCES.includes(req.body?.source)
        ? req.body.source
        : 'general';

      const email = normalizeEmail(rawEmail);
      const hash = emailHash(email);

      // Fail CLOSED on a Redis outage, same as the invite-email limiter: a
      // signup surface with no working abuse counter stays shut, not open.
      const rlIp = await cache.checkRateLimitStrict(`community-subscribe:ip:${req.ip}`, 10, 86400);
      if (rlIp.error === 'rate_limit_unavailable') {
        res.status(503).json({ error: 'temporarily_unavailable' });
        return;
      }
      if (!rlIp.allowed) {
        res.status(429).json({ error: 'too_many_requests', retry_after: rlIp.retryAfter });
        return;
      }
      const rlEmail = await cache.checkRateLimitStrict(`community-subscribe:email:${hash}`, 5, 86400);
      if (rlEmail.error === 'rate_limit_unavailable') {
        res.status(503).json({ error: 'temporarily_unavailable' });
        return;
      }
      if (!rlEmail.allowed) {
        res.status(429).json({ error: 'too_many_requests', retry_after: rlEmail.retryAfter });
        return;
      }

      // A suppressed (unsubscribed) address is acknowledged but NOT re-added.
      // Same body as success — suppression state must not be probeable.
      if (await isEmailSuppressed(db, email)) {
        res.json({ subscribed: true });
        return;
      }

      // Idempotent upsert keyed on the email hash: first write stamps
      // created_at + source; a re-subscribe only refreshes updated_at.
      const ref = db.collection(WAITLIST_COLLECTION).doc(hash);
      await db.runTransaction(async (txn) => {
        const snap = await txn.get(ref);
        if (!snap.exists) {
          txn.set(ref, { email, source, createdAt: Date.now() });
        } else {
          txn.set(ref, { updatedAt: Date.now() }, { merge: true });
        }
      });

      res.json({ subscribed: true });
    } catch (err) {
      console.error('[community] subscribe failed:', err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  return router;
}
