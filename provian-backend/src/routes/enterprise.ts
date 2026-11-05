/**
 * Enterprise Router
 *
 * Public lead capture for the Provian enterprise pilot page.
 * Persists inquiries to Firestore and sends an internal notification email.
 */

import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { Firestore } from 'firebase-admin/firestore';
import { send } from '../email';

interface EnterpriseRouterDeps {
  db: Firestore;
  cache: {
    checkRateLimit: (key: string, limit: number, windowSeconds: number) => Promise<{ allowed: boolean; retryAfter?: number }>;
  };
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NOTIFY_EMAIL = process.env.ENTERPRISE_PILOT_NOTIFY_EMAIL || 'hello@provian.ai';

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

export function createEnterpriseRouter(deps: EnterpriseRouterDeps): Router {
  const { db, cache } = deps;
  const router = Router();

  router.post('/pilot', async (req: Request, res: Response) => {
    try {
      const name = cleanString(req.body?.name, 120, true);
      const email = cleanString(req.body?.email, 200, true).toLowerCase();
      const company = cleanString(req.body?.company, 200, true);
      const role = cleanString(req.body?.role, 200, true);
      const agentCount = cleanString(req.body?.agentCount, 80, false);

      if (!EMAIL_REGEX.test(email)) {
        res.status(400).json({ error: 'Invalid email address' });
        return;
      }

      // F40: key on the trust-proxy-resolved client IP (req.ip), like every other
      // per-IP limiter in the tree. The previous code took the LEFTMOST
      // X-Forwarded-For entry, which the client fully controls (Cloud Run APPENDS
      // the real client IP), so an attacker rotated `X-Forwarded-For: 10.0.0.<n>`
      // to get a fresh bucket per request and bypass the 10/hour cap — turning this
      // unauthenticated route into a Resend-email + Firestore-write amplifier. The
      // stored audit `ip` now also reflects the real client hop.
      const ip = req.ip || req.socket.remoteAddress || 'unknown';

      const ipRate = await cache.checkRateLimit(`enterprise:ip:${ip}`, 10, 3600);
      if (!ipRate.allowed) {
        res.status(429).json({ error: 'Too many submissions. Please try again later.' });
        return;
      }

      const emailRate = await cache.checkRateLimit(`enterprise:email:${email}`, 3, 86400);
      if (!emailRate.allowed) {
        res.status(429).json({ error: 'This email has already submitted recently.' });
        return;
      }

      const now = Date.now();
      const inquiryId = `enterprise_${uuidv4()}`;
      const inquiry = {
        id: inquiryId,
        name,
        email,
        company,
        role,
        agentCount: agentCount || null,
        source: 'provian-website-enterprise-page',
        path: '/enterprise',
        created_at: now,
        created_at_iso: new Date(now).toISOString(),
        notify_email: NOTIFY_EMAIL,
        ip,
        user_agent: req.get('user-agent') || null,
        status: 'new',
      };

      await db.collection('enterprise_pilot_inquiries').doc(inquiryId).set(inquiry);

      const subject = `New Provian enterprise pilot inquiry - ${company}`;
      const html = `
        <h2>New enterprise pilot inquiry</h2>
        <p><strong>Name:</strong> ${escapeHtml(name)}</p>
        <p><strong>Email:</strong> ${escapeHtml(email)}</p>
        <p><strong>Company:</strong> ${escapeHtml(company)}</p>
        <p><strong>Role:</strong> ${escapeHtml(role)}</p>
        <p><strong>Planned AI agents:</strong> ${escapeHtml(agentCount || 'Not provided')}</p>
        <p><strong>Source:</strong> /enterprise</p>
        <p><strong>Inquiry ID:</strong> ${escapeHtml(inquiryId)}</p>
        <p><strong>Submitted:</strong> ${escapeHtml(new Date(now).toISOString())}</p>
      `;
      const text = [
        'New enterprise pilot inquiry',
        `Name: ${name}`,
        `Email: ${email}`,
        `Company: ${company}`,
        `Role: ${role}`,
        `Planned AI agents: ${agentCount || 'Not provided'}`,
        'Source: /enterprise',
        `Inquiry ID: ${inquiryId}`,
        `Submitted: ${new Date(now).toISOString()}`,
      ].join('\n');

      const emailSent = await send(NOTIFY_EMAIL, subject, html, text);

      if (!emailSent) {
        await db.collection('enterprise_pilot_inquiries').doc(inquiryId).update({
          notification_status: 'failed',
          notification_attempted_at: Date.now(),
        });
      } else {
        await db.collection('enterprise_pilot_inquiries').doc(inquiryId).update({
          notification_status: 'sent',
          notification_attempted_at: Date.now(),
        });
      }

      res.status(201).json({ ok: true, inquiry_id: inquiryId });
    } catch (error) {
      if (error instanceof Error && error.message === 'missing_required_field') {
        res.status(400).json({ error: 'Missing required fields' });
        return;
      }

      console.error('[Enterprise] Pilot inquiry error:', error);
      res.status(500).json({ error: 'Failed to submit inquiry' });
    }
  });

  return router;
}
