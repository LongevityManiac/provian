/**
 * EmailService - Resend transactional email
 *
 * Email types:
 *   1. sendAgentInvite - when an agent invites a human user
 *
 * Required env vars:
 *   RESEND_API_KEY          - API key from resend.com
 *   RESEND_SENDER_EMAIL     - Verified sender (e.g. noreply@provian.ai)
 *
 * If credentials are missing, emails will fail gracefully with a log warning.
 * Email is not on the critical path - the server does not crash.
 */

import { Resend } from 'resend';
import { bumpOpsCounter } from './core/observability/ops-counters';

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const SENDER = process.env.RESEND_SENDER_EMAIL || 'noreply@provian.ai';

// Lazily construct the Resend client. `new Resend(undefined)` THROWS in the
// installed SDK version, so building it at module load crashed any module that
// imported this file when RESEND_API_KEY was unset (e.g. the whole backend test
// suite) — directly contradicting the "fails gracefully, server does not crash"
// contract above. Deferring construction (and returning null when unconfigured)
// restores that contract.
let _resend: Resend | null = null;
function getResend(): Resend | null {
    if (_resend) return _resend;
    const key = process.env.RESEND_API_KEY;
    if (!key) return null;
    _resend = new Resend(key);
    return _resend;
}

const FOOTER_TEXT = 'You received this because someone listed your email in their Provian wallet. If you believe this was sent in error, you can ignore it.';

/**
 * HTML-escape an interpolated value (F53/F56). Attacker-controlled strings —
 * an agent's display_name, a caller's personal message — are interpolated into
 * these Provian-branded, DKIM-signed emails. Unescaped, they let any agent
 * API-key holder deliver arbitrary HTML (clickable phishing links, tracking
 * pixels) from noreply@provian.ai. The sibling `sendConnectCommand` template
 * already escapes; the invite templates were left raw. Same escaper for all.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Neutralize markup in a plaintext SUBJECT line (not HTML, so entity-escaping
 *  would show literal `&lt;`; strip the angle brackets instead). */
export function stripSubjectMarkup(value: string): string {
  return value.replace(/[<>]/g, '');
}

// Real one-click unsubscribe, served by the relay itself (routes/unsubscribe.ts)
// so it works with no login and no separate site deploy. The per-recipient token
// is minted by the CALLER (signUnsubscribeToken) and passed in; a marketing email
// is never built without one — "no invite email before a working unsubscribe."
const UNSUBSCRIBE_BASE_URL =
    process.env.UNSUBSCRIBE_BASE_URL || 'https://api.provian.ai/v1/unsubscribe';

export function unsubscribeUrl(token: string): string {
    return `${UNSUBSCRIBE_BASE_URL}?token=${encodeURIComponent(token)}`;
}

/**
 * RFC 8058 one-click headers so mail clients render a native Unsubscribe control
 * that POSTs back to us. Paired with the visible footer link for clients that do
 * not support it.
 */
function unsubscribeHeaders(token: string): Record<string, string> {
    const url = unsubscribeUrl(token);
    return {
        'List-Unsubscribe': `<${url}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    };
}

// ---------------------------------------------------------------------------
// Startup validation
// ---------------------------------------------------------------------------

/**
 * Call during server startup. Logs a warning if credentials look missing.
 * Does NOT crash - email is not critical path.
 */
export function validateEmailConfig(): void {
    if (!process.env.RESEND_SENDER_EMAIL) {
        console.warn(
            '[Email] WARNING: RESEND_SENDER_EMAIL is not set. ' +
            'Emails will attempt to send from "noreply@provian.ai" - ' +
            'this must be a verified domain in your Resend dashboard.',
        );
    }

    if (!process.env.RESEND_API_KEY) {
        console.warn(
            '[Email] WARNING: RESEND_API_KEY is not set. ' +
            'Email sending will fail until an API key is configured.',
        );
    }

    console.log(`[Email] Resend configured: sender=${SENDER}`);
}

// ---------------------------------------------------------------------------
// Internal send helper
// ---------------------------------------------------------------------------

export type EmailSendResult = { status: 'accepted'; id: string } | { status: 'rejected' | 'uncertain' };

/** The boolean wrapper preserves callers; announcements also persist provider receipts. */
export async function send(...args: Parameters<typeof sendWithReceipt>): Promise<boolean> {
    return (await sendWithReceipt(...args)).status === 'accepted';
}

export async function sendWithReceipt(
    to: string, subject: string, html: string, text: string,
    headers?: Record<string, string>, idempotencyKey?: string,
): Promise<EmailSendResult> {
    const client = getResend();
    if (!client) {
        console.warn('[Email] RESEND_API_KEY not set - email rejected before submission');
        return { status: 'rejected' };
    }
    try {
        const { data, error } = await client.emails.send({
            from: SENDER, to: [to], subject, html, text,
            ...(headers ? { headers } : {}),
            ...(idempotencyKey ? { tags: [{ name: 'delivery_key', value: idempotencyKey }] } : {}),
        }, idempotencyKey ? { idempotencyKey } : undefined);
        if (error) {
            console.error(`[Email] Resend error for "${subject}":`, error);
            bumpOpsCounter('email.failed');
            // HTTP 4xx except conflicts are definite non-acceptance. Network,
            // server and idempotency-conflict responses may hide an accepted send.
            return { status: error.statusCode && error.statusCode >= 400 && error.statusCode < 500
                && error.statusCode !== 409 ? 'rejected' : 'uncertain' };
        }
        if (!data?.id) return { status: 'uncertain' };
        console.log(`[Email] Sent "${subject}" to ${to.replace(/(.{3}).*@/, '$1***@')}`);
        bumpOpsCounter('email.sent');
        return { status: 'accepted', id: data.id };
    } catch (error) {
        console.error(`[Email] Failed to send "${subject}":`, error);
        bumpOpsCounter('email.failed');
        return { status: 'uncertain' };
    }
}

// User-facing copy is selected before interpolating user data. Commands and URLs
// never pass through the translator; HTML escaping affects only their representation.
import { emailCopy, emailLanguage, type EmailCopyKey } from './core/email/language';

function renderEmail(language: unknown, title: string, body: string): string {
    return `<!DOCTYPE html><html lang="${emailLanguage(language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escapeHtml(title)}</title></head><body style="margin:0;background:#0B0E14;color:#e8eaed;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"><div style="max-width:600px;margin:0 auto;padding:40px 24px;line-height:1.6">${body}</div></body></html>`;
}

function commandHtml(value: string): string { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function paragraph(value: string): string { return `<p>${escapeHtml(value)}</p>`; }
function anchor(url: string, label: string): string {
    return `<a style="color:#a59fff" href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
}

export async function sendConnectCommand(
    to: string,
    kind: 'device' | 'agent_device',
    command: string,
    expiresAt: number,
    personalMessage?: string,
    deviceName?: string,
    windowsCommand?: string,
    requestedBy: 'app' | 'agent' = 'app',
    language?: unknown,
): Promise<boolean> {
    const t = (key: EmailCopyKey, values: Record<string, string | number> = {}) => emailCopy(language, key, values);
    const subject = t('setupSubject');
    const intro = t(kind === 'device' ? 'deviceIntro' : 'agentIntro');
    const afterNote = t(kind === 'device' ? 'deviceAfter' : 'agentAfter');
    const minutes = Math.max(1, Math.round((expiresAt - Date.now()) / 60000));
    const expiry = t(requestedBy === 'agent' ? 'expiresAgent' : 'expiresApp', { minutes });
    const requested = t(requestedBy === 'agent' ? 'requestedAgent' : 'requestedApp');
    const device = deviceName ? t('deviceName', { name: deviceName }) : '';
    const note = personalMessage ? `“${personalMessage}”` : '';
    const windows = kind === 'agent_device' && windowsCommand ? `${t('windows')} ${windowsCommand}` : '';
    const text = [subject, intro, device, note, t('terminal'), t('terminalHelp'), t('paste'), command,
        t('after'), afterNote, t('batchCadence'), t('settlementCadence'), windows, expiry, t('team'), t('gloss'), requested].filter(Boolean).join('\n\n');
    const html = renderEmail(language, subject,
        [subject, intro, device, note, t('terminal'), t('terminalHelp'), t('paste')].filter(Boolean).map(paragraph).join('')
        + `<pre style="white-space:pre-wrap;word-break:break-all;background:#141920;padding:16px">${commandHtml(command)}</pre>`
        + [t('after'), afterNote, t('batchCadence'), t('settlementCadence')].map(paragraph).join('')
        + (windows ? paragraph(t('windows')) + `<pre style="white-space:pre-wrap;word-break:break-all">${commandHtml(windowsCommand!)}</pre>` : '')
        + [expiry, t('team'), t('gloss'), requested].map(paragraph).join(''));
    return send(to, subject, html, text);
}

async function sendInvitation(
    to: string, agentName: string, inviteId: string, unsubscribeToken: string,
    agentWalletId: string | undefined, beneficiary: boolean, count: number,
    personalMessage: string | undefined, language: unknown,
): Promise<boolean> {
    const t = (key: EmailCopyKey, values: Record<string, string | number> = {}) => emailCopy(language, key, values);
    const subject = t(beneficiary ? 'beneficiarySubject' : 'inviteSubject', { name: stripSubjectMarkup(agentName) });
    const landing = `https://provian.ai/invited?invite=${inviteId}` + (agentWalletId ? `&agent_wallet=${encodeURIComponent(agentWalletId)}` : '');
    const deepLink = `provian://link?invite=${inviteId}&agent_wallet=${agentWalletId ?? ''}`;
    const unsub = unsubscribeUrl(unsubscribeToken);
    const first = beneficiary
        ? [t('beneficiaryHeading'), t('proofCount', { name: agentName, count: count.toLocaleString(emailLanguage(language)) })]
        : [t('inviteHeading', { name: agentName }), t('inviteIntro')];
    if (personalMessage) first.push(`“${personalMessage}”`);
    first.push(...(beneficiary ? [t('beneficiaryProof'), t('unlocks')] : [t('what'), t('proof'), t('linking')]));
    const items = beneficiary ? [t('factor'), t('routing'), t('prospective'), t('split')]
        : [t('work'), t('routing'), t('split'), t('visibility')];
    const cta = t(beneficiary ? 'open' : 'download');
    const last = [t('batchCadence'), t('settlementCadence'), t('team'), t('gloss'), t('footer'), t('inviteFooter')];
    const text = [...first, ...items.map(v => `• ${v}`), `${cta}: ${landing}`,
        ...(beneficiary ? [t('already'), `${t('complete')}\n${deepLink}`] : []), ...last, `${t('unsubscribe')}: ${unsub}`].join('\n\n');
    const html = renderEmail(language, subject, first.map(paragraph).join('')
        + `<ul>${items.map(v => `<li>${escapeHtml(v)}</li>`).join('')}</ul>` + paragraph('') + anchor(landing, cta)
        + (beneficiary ? paragraph(t('already')) + paragraph(t('complete')) + anchor(deepLink, deepLink) : '')
        + last.map(paragraph).join('') + anchor(unsub, t('unsubscribe')));
    return send(to, subject, html, text, unsubscribeHeaders(unsubscribeToken));
}

export async function sendAgentInvite(
    to: string, agentName: string, inviteId: string, unsubscribeToken: string,
    agentWalletId?: string, language?: unknown,
): Promise<boolean> {
    return sendInvitation(to, agentName, inviteId, unsubscribeToken, agentWalletId, false, 0, undefined, language);
}

export async function sendBeneficiaryInvite(
    to: string, agentName: string, inviteId: string, walletId: string,
    _signingBonusPVT: number, agentPECount: number, unsubscribeToken: string,
    personalMessage?: string, language?: unknown,
): Promise<boolean> {
    return sendInvitation(to, agentName, inviteId, unsubscribeToken, walletId, true, agentPECount, personalMessage, language);
}
