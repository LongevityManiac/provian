/**
 * POST /v1/capture/chat-markers — the app's chat screen says whether a provider's conversation
 * page still matches its turn markers.
 *
 * The chat screen counts a chat (typed or spoken in the provider's own voice mode) from new turns
 * appearing on the provider's page. When a provider changes its page, our markers stop matching
 * and voice chats on it go uncounted with nothing on screen to show it. Each phone judges every
 * conversation page it opens and sends the verdict here (at most once an hour per provider,
 * account state and outcome). The relay keeps one tally per provider and account state in
 * `chat_marker_health_v1`; the operator's Command Center raises an alarm when a provider's latest
 * verdict is "unmatched".
 *
 * The body carries the provider, whether the page looked signed in or signed out, whether any
 * marker matched, which candidate matched, and per-candidate element counts. Nothing about the
 * person is stored: the tally has no wallet, device or user id, and no text or URL is accepted.
 * Wallet auth keeps it to real app installs; the global `/v1` rate limit bounds it.
 *
 * Outside the money path: this never touches a PE, a mint, or any owner state.
 */

import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { Firestore } from 'firebase-admin/firestore';

export const CHAT_MARKER_HEALTH_COLLECTION = 'chat_marker_health_v1';

/** The chat screen's providers. */
export const CHAT_MARKER_PROVIDERS: readonly string[] = ['claude', 'chatgpt', 'gemini', 'perplexity', 'grok', 'venice'];

export interface ChatMarkerReport {
  provider: string;
  account: 'signed_in' | 'signed_out';
  matched: boolean;
  candidate: number;
  counts: number[];
}

export interface ChatMarkerHealthDoc {
  schema: 'chat_marker_health/v1';
  provider: string;
  account: 'signed_in' | 'signed_out';
  last_matched_at_ms: number | null;
  last_unmatched_at_ms: number | null;
  matched_reports: number;
  unmatched_reports: number;
  /** Per-candidate counts from the latest unmatched page (what the markers found). */
  last_unmatched_counts: number[] | null;
  /** Which candidate matched on the latest matched page (0 = the first, current marker). */
  last_matched_candidate: number | null;
  updated_at_ms: number;
}

const BODY_KEYS = new Set(['schema', 'provider', 'account', 'matched', 'candidate', 'counts']);

function smallInt(n: unknown, min: number, max: number): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max;
}

/** Strict parse: unknown keys, providers or shapes are refused, never stored. */
export function parseChatMarkerReport(body: unknown): ChatMarkerReport | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some(k => !BODY_KEYS.has(k))) return null;
  if (b.schema !== 'chat_markers/v1') return null;
  if (typeof b.provider !== 'string' || !CHAT_MARKER_PROVIDERS.includes(b.provider)) return null;
  if (b.account !== 'signed_in' && b.account !== 'signed_out') return null;
  if (typeof b.matched !== 'boolean') return null;
  if (!smallInt(b.candidate, -1, 15)) return null;
  if (b.matched !== (b.candidate >= 0)) return null;
  if (!Array.isArray(b.counts) || b.counts.length > 16 || !b.counts.every(c => smallInt(c, 0, 100_000))) return null;
  return { provider: b.provider, account: b.account, matched: b.matched, candidate: b.candidate, counts: b.counts as number[] };
}

export function chatMarkerDocId(provider: string, account: string): string {
  return `${provider}__${account}`;
}

/** The tally after one report. Pure. */
export function applyChatMarkerReport(prev: Partial<ChatMarkerHealthDoc> | undefined, r: ChatMarkerReport, nowMs: number): ChatMarkerHealthDoc {
  const p = prev ?? {};
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const at = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    schema: 'chat_marker_health/v1',
    provider: r.provider,
    account: r.account,
    last_matched_at_ms: r.matched ? nowMs : at(p.last_matched_at_ms),
    last_unmatched_at_ms: r.matched ? at(p.last_unmatched_at_ms) : nowMs,
    matched_reports: num(p.matched_reports) + (r.matched ? 1 : 0),
    unmatched_reports: num(p.unmatched_reports) + (r.matched ? 0 : 1),
    last_unmatched_counts: r.matched ? (Array.isArray(p.last_unmatched_counts) ? p.last_unmatched_counts : null) : r.counts,
    last_matched_candidate: r.matched ? r.candidate : (typeof p.last_matched_candidate === 'number' ? p.last_matched_candidate : null),
    updated_at_ms: nowMs,
  };
}

export interface ChatMarkersRouterDeps {
  db: Firestore;
  authenticate: RequestHandler;
  now?: () => number;
}

export function createChatMarkersRouter(deps: ChatMarkersRouterDeps): Router {
  const router = Router();
  const now = deps.now ?? (() => Date.now());
  router.post('/chat-markers', deps.authenticate, async (req: Request, res: Response) => {
    const report = parseChatMarkerReport(req.body);
    if (!report) {
      res.status(400).json({ error: 'invalid_chat_marker_report' });
      return;
    }
    try {
      const ref = deps.db.collection(CHAT_MARKER_HEALTH_COLLECTION).doc(chatMarkerDocId(report.provider, report.account));
      await deps.db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        const prev = snap.exists ? (snap.data() as Partial<ChatMarkerHealthDoc>) : undefined;
        tx.set(ref, applyChatMarkerReport(prev, report, now()));
      });
      res.status(204).end();
    } catch {
      res.status(503).json({ error: 'chat_marker_report_unavailable' });
    }
  });
  return router;
}
