/**
 * Marker health: tell the operator when a provider's page stops matching our turn markers.
 *
 * The turn watcher judges each conversation page it sees: did any of the provider's markers match?
 * A provider that changes its page stops matching, and from then on voice chats on it go
 * uncounted with nothing on screen to show it. The chat screen forwards each verdict here; this
 * sends it to the relay, which keeps a per-provider tally the operator's Command Center alarms on.
 *
 * What is sent: the provider, whether its markers matched, which candidate matched, the per-
 * candidate counts, and whether the page looked signed in or signed out (so a break on the
 * signed-in page, which most people see, is told apart from the signed-out one). Never text, a URL,
 * or anything about the person. At most one report per provider, account state and outcome per
 * hour from this phone.
 */

import type { TurnWatcherMessage } from './turnMarkers';

export type MarkerHealthVerdict = Extract<TurnWatcherMessage, { t: 'marker_health' }>;

export interface MarkerHealthBody {
    schema: 'chat_markers/v1';
    provider: string;
    account: 'signed_in' | 'signed_out';
    matched: boolean;
    candidate: number;
    counts: number[];
}

export interface MarkerHealthStorage {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
}

export interface MarkerHealthReporterOptions {
    send: (body: MarkerHealthBody) => Promise<boolean>;
    storage: MarkerHealthStorage;
    now?: () => number;
}

const STORAGE_KEY = '@provian_chat_marker_reports_v1';
const HOUR_MS = 60 * 60 * 1000;

export function markerHealthBody(v: MarkerHealthVerdict): MarkerHealthBody {
    return {
        schema: 'chat_markers/v1',
        provider: v.provider,
        account: v.account,
        matched: v.matched,
        candidate: v.candidate,
        counts: v.counts.slice(0, 16),
    };
}

export class MarkerHealthReporter {
    private readonly send: MarkerHealthReporterOptions['send'];
    private readonly storage: MarkerHealthStorage;
    private readonly now: () => number;
    private inFlight = new Set<string>();

    constructor(opts: MarkerHealthReporterOptions) {
        this.send = opts.send;
        this.storage = opts.storage;
        this.now = opts.now ?? (() => Date.now());
    }

    /** Send one verdict unless this phone sent the same one in the current hour. Never throws. */
    async report(v: MarkerHealthVerdict): Promise<'sent' | 'deduped' | 'failed'> {
        const hour = Math.floor(this.now() / HOUR_MS);
        const key = `${v.provider}|${v.account}|${v.matched ? 'matched' : 'unmatched'}`;
        if (this.inFlight.has(key)) return 'deduped';
        this.inFlight.add(key);
        try {
            const sent = await this.readSent();
            if (sent[key] === hour) return 'deduped';
            const ok = await this.send(markerHealthBody(v));
            if (!ok) return 'failed';
            sent[key] = hour;
            for (const k of Object.keys(sent)) if (sent[k] < hour - 24) delete sent[k];
            await this.storage.setItem(STORAGE_KEY, JSON.stringify(sent));
            return 'sent';
        } catch {
            return 'failed';
        } finally {
            this.inFlight.delete(key);
        }
    }

    private async readSent(): Promise<Record<string, number>> {
        try {
            const raw = await this.storage.getItem(STORAGE_KEY);
            const parsed: unknown = raw ? JSON.parse(raw) : {};
            if (!parsed || typeof parsed !== 'object') return {};
            const out: Record<string, number> = {};
            for (const [k, n] of Object.entries(parsed as Record<string, unknown>)) {
                if (typeof n === 'number' && Number.isInteger(n)) out[k] = n;
            }
            return out;
        } catch {
            return {};
        }
    }
}
