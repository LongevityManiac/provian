/** Preserve an agent link invitation across app installation. */

import type { InviteRef } from './InviteCapture';

/** Once-per-install flag. Present (any value) = the check has run; never runs again. */
export const DEFERRED_INVITE_CHECKED_KEY = '@provian:deferred_invite_checked';


export const INSTALL_REFERRER_INVITE_KEY = 'provian_invite';

/** Agent invite id (`inv_<uuid>` or `inv_fleet_<hex>`, provian-backend routes/agent-invite.ts). */
const AGENT_INVITE_ID = 'inv_[A-Za-z0-9_-]{8,128}';
/** Agent wallet id (`wallet_aw_<uuid>`, provian-backend routes/agent-wallet.ts). */
const AGENT_WALLET_ID = 'wallet_aw_[A-Za-z0-9-]{8,128}';

// Exact, anchored, case-sensitive full-string matches. No userinfo, no port, no fragment, no
// extra or repeated parameter, no percent-encoding, no whitespace: anything else is not canonical.
const CANONICAL_AGENT_INVITE = new RegExp(
    `^https://provian\\.ai/invited/?\\?invite=(${AGENT_INVITE_ID})&agent_wallet=(${AGENT_WALLET_ID})$`,
);

const MAX_URL_LENGTH = 512;

/** The canonical agent invite URL (what the website copies). */
export function canonicalAgentInviteUrl(inviteId: string, agentWalletId: string): string {
    return `https://provian.ai/invited?invite=${inviteId}&agent_wallet=${agentWalletId}`;
}

/**
 * Parse a string that must be EXACTLY a canonical Provian invite URL. Null for anything else.
 */
export function parseCanonicalInviteUrl(raw: unknown): InviteRef | null {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) return null;
    const agent = CANONICAL_AGENT_INVITE.exec(raw);
    if (agent) return { kind: 'agent', inviteId: agent[1], agentWalletId: agent[2] };
    return null;
}


export function parseInstallReferrer(raw: unknown): InviteRef | null {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH * 2) return null;
    let value: string | null = null;
    for (const pair of raw.split('&')) {
        if (pair.length === 0) continue;
        const eq = pair.indexOf('=');
        const key = eq === -1 ? pair : pair.slice(0, eq);
        if (key === INSTALL_REFERRER_INVITE_KEY) {
            if (value !== null) return null; // repeated: refuse rather than pick one
            value = eq === -1 ? '' : pair.slice(eq + 1);
            continue;
        }
        if (!/^utm_[a-z_]{1,32}$/.test(key)) return null;
    }
    if (value === null || value.length === 0) return null;
    let decoded: string;
    try {
        decoded = decodeURIComponent(value);
    } catch {
        return null;
    }
    return parseCanonicalInviteUrl(decoded);
}

export interface DeferredInviteStorage {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
}

export interface DeferredInviteDeps {
    platform: string;
    storage: DeferredInviteStorage;
    /** True when a wallet exists or onboarding is complete. */
    walletExists(): boolean;

    getInstallReferrer(): Promise<string>;
    /** iOS only: `Clipboard.hasUrlAsync` (no paste prompt). */
    clipboardHasUrl(): Promise<boolean>;
    /** iOS only: `Clipboard.getUrlAsync` (shows the system paste prompt). */
    clipboardGetUrl(): Promise<string | null>;
    /** `Clipboard.getStringAsync` (used on Android only). */
    clipboardGetString(): Promise<string>;
    /** The shared capture path (`captureInviteForNewWallet` bound to its production deps). */
    capture(invite: InviteRef): Promise<boolean>;
}

export type DeferredInviteOutcome =
    | 'already_checked'
    | 'storage_unavailable'
    | 'wallet_exists'
    | 'unsupported_platform'
    | 'no_invite'
    | 'captured'
    | 'not_captured';


async function findInvite(deps: DeferredInviteDeps): Promise<InviteRef | null> {
    if (deps.platform === 'android') {
        try {
            const fromPlay = parseInstallReferrer(await deps.getInstallReferrer());
            if (fromPlay) return fromPlay;
        } catch {
        }
        try {
            return parseCanonicalInviteUrl(await deps.clipboardGetString());
        } catch {
            return null;
        }
    }
    if (deps.platform === 'ios') {
        try {
            // hasUrlAsync shows no prompt; only a clipboard that holds a URL is ever read.
            if (!(await deps.clipboardHasUrl())) return null;
            return parseCanonicalInviteUrl(await deps.clipboardGetUrl());
        } catch {
            return null;
        }
    }
    return null;
}

/**
 * Run the deferred-invite check. At most once per install: the flag is written after the check
 * (whatever its outcome), and a present flag short-circuits before anything is read. Never throws.
 */
export async function runDeferredInviteCheck(deps: DeferredInviteDeps): Promise<DeferredInviteOutcome> {
    let checked: string | null;
    try {
        checked = await deps.storage.getItem(DEFERRED_INVITE_CHECKED_KEY);
    } catch {
        // Cannot tell whether it already ran: read nothing (it may have run; a re-read would
        // re-prompt). Unknown = block.
        return 'storage_unavailable';
    }
    if (checked !== null) return 'already_checked';

    try {
        if (deps.walletExists()) return 'wallet_exists';
        if (deps.platform !== 'android' && deps.platform !== 'ios') return 'unsupported_platform';
        const invite = await findInvite(deps);
        if (invite === null) return 'no_invite';
        // A wallet created while the carrier was being read can now accept this link.
        return (await deps.capture(invite)) ? 'captured' : 'not_captured';
    } catch {
        return 'not_captured';
    } finally {
        try {
            await deps.storage.setItem(DEFERRED_INVITE_CHECKED_KEY, String(Date.now()));
        } catch {
            // Best-effort; a failed write at worst lets the check run once more.
        }
    }
}
