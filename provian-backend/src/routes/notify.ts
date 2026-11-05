/**
 * Notify Router
 *
 * Public "notify me at launch" capture for the Get-the-app (/download) page.
 * Persists signups to Firestore (`launch_notify_signups`) and sends an internal
 * notification email. Mirrors the enterprise pilot router (routes/enterprise.ts).
 *
 * No auth (public lead capture). Rate-limited by IP and by email+platform.
 */

import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { Firestore } from 'firebase-admin/firestore';
import { send } from '../email';

interface NotifyRouterDeps {
  db: Firestore;
  cache: {
    checkRateLimit: (key: string, limit: number, windowSeconds: number) => Promise<{ allowed: boolean; retryAfter?: number }>;
  };
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NOTIFY_EMAIL =
  process.env.LAUNCH_NOTIFY_EMAIL ||
  process.env.ENTERPRISE_PILOT_NOTIFY_EMAIL ||
  'hello@provian.ai';

const PLATFORM_LABELS: Record<string, string> = {
  ios_app_store: 'iOS App Store',
  google_play: 'Google Play',
  android_apk: 'Android APK',
  android_test: 'Android test',
  general: 'General',
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cleanString(value: unknown, maxLength: number, required = false): string {
  const cleaned = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  const sliced = cleaned.slice(0, maxLength);
  if (required && !sliced) {
    throw new Error('missing_required_field');
  }
  return sliced;
}

export function createNotifyRouter(deps: NotifyRouterDeps): Router {
  const { db, cache } = deps;
  const router = Router();

  // POST /v1/notify - record a launch-notify signup for a platform.
  router.post('/', async (req: Request, res: Response) => {
    try {
      const email = cleanString(req.body?.email, 200, true).toLowerCase();
      const platformRaw = cleanString(req.body?.platform, 40, false);
      const platform = PLATFORM_LABELS[platformRaw] ? platformRaw : 'general';

      if (!EMAIL_REGEX.test(email)) {
        res.status(400).json({ error: 'Please enter a valid email address.' });
        return;
      }

      // `req.ip` is the Cloud-Run-appended client address under `trust proxy 1`;
      // the FIRST X-Forwarded-For entry is client-supplied and let a caller rotate
      // its own limiter key (2026-10-17).
      const ip = req.ip || 'unknown';

      const ipRate = await cache.checkRateLimit(`notify:ip:${ip}`, 20, 3600);
      if (!ipRate.allowed) {
        res.status(429).json({ error: 'Too many requests. Please try again later.' });
        return;
      }

      // 2 per email+platform per 7 days. A repeat is treated as success
      // (idempotent UX) rather than an error.
      const emailRate = await cache.checkRateLimit(`notify:email:${email}:${platform}`, 2, 7 * 86400);
      if (!emailRate.allowed) {
        res.status(200).json({ ok: true, already: true });
        return;
      }

      const now = Date.now();
      const signupId = `notify_${uuidv4()}`;
      const signup = {
        id: signupId,
        email,
        platform,
        platform_label: PLATFORM_LABELS[platform],
        source: 'provian-website-download-page',
        path: '/download',
        created_at: now,
        created_at_iso: new Date(now).toISOString(),
        ip,
        user_agent: req.get('user-agent') || null,
        status: 'pending',
        notified: false,
      };

      await db.collection('launch_notify_signups').doc(signupId).set(signup);

      // Internal notification (non-blocking; failure does not fail the request).
      const label = PLATFORM_LABELS[platform];
      const subject = `New launch-notify signup - ${label}`;
      const html = `
        <h2>New launch-notify signup</h2>
        <p><strong>Email:</strong> ${escapeHtml(email)}</p>
        <p><strong>Platform:</strong> ${escapeHtml(label)}</p>
        <p><strong>Signup ID:</strong> ${escapeHtml(signupId)}</p>
        <p><strong>Submitted:</strong> ${escapeHtml(new Date(now).toISOString())}</p>
      `;
      const text = [
        'New launch-notify signup',
        `Email: ${email}`,
        `Platform: ${label}`,
        `Signup ID: ${signupId}`,
        `Submitted: ${new Date(now).toISOString()}`,
      ].join('\n');

      send(NOTIFY_EMAIL, subject, html, text)
        .then((sent) =>
          db.collection('launch_notify_signups').doc(signupId).update({
            notification_status: sent ? 'sent' : 'failed',
            notification_attempted_at: Date.now(),
          }),
        )
        .catch(() => {});

      res.status(201).json({ ok: true, signup_id: signupId });
    } catch (error) {
      if (error instanceof Error && error.message === 'missing_required_field') {
        res.status(400).json({ error: 'Email is required.' });
        return;
      }
      console.error('[Notify] signup error:', error);
      res.status(500).json({ error: 'Failed to sign up. Please try again.' });
    }
  });

  return router;
}
