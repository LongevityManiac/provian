import { describe, it, expect } from 'vitest';
import {
    agentLiveness,
    parseLastPeDate,
    AGENT_STALE_AFTER_MS,
    linkedAgentIsLive,
    anyLinkedAgentLive,
    lastActivityDisplay,
    lastActivityTexts,
    workingLine,
} from './agentLiveness';
import type { TFunction } from 'i18next';

const NOW = Date.UTC(2026, 8, 7, 14, 0, 0); // 2026-09-07T14:00:00Z

describe('parseLastPeDate', () => {
    it('resolves to the END of the named day, not its midnight', () => {
        // Midnight would overstate silence by up to 24h and make a working
        // agent look stale.
        expect(parseLastPeDate('2026-09-07')).toBe(Date.UTC(2026, 8, 7, 23, 59, 59, 999));
    });

    it('NEGATIVE CONTROL — junk and absence are null, never a guess', () => {
        for (const bad of [null, undefined, '', 'yesterday', '2026-9-7', '20260907']) {
            expect(parseLastPeDate(bad as string | null)).toBeNull();
        }
    });
});

describe('agentLiveness', () => {
    it('THE ATLAS STATE — PEs that stopped days ago read as STALE', () => {
        // Atlas's real value on the morning this was written.
        const r = agentLiveness('2026-09-02', NOW);
        expect(r.state).toBe('stale');
        expect(r.daysSince).toBe(4);
    });

    it('THE BUG — a lifetime count cannot express this, so the state must come from a date', () => {
        // The old signal was `pe_count > 0`. Atlas had 181 PEs and was dark.
        // Whatever the count, liveness here depends only on recency.
        expect(agentLiveness('2026-09-02', NOW).state).toBe('stale');
        expect(agentLiveness('2026-09-07', NOW).state).toBe('live');
    });

    it('NEGATIVE CONTROL — a recently active agent is live', () => {
        expect(agentLiveness('2026-09-07', NOW).state).toBe('live');
        expect(agentLiveness('2026-09-06', NOW).state).toBe('live');
    });

    it('NEGATIVE CONTROL — an agent that has NEVER produced a PE is "never", not "stale"', () => {
        // Setup is unfinished; alarming here would be wrong and would train the
        // user to ignore the signal.
        expect(agentLiveness(null, NOW).state).toBe('never');
        expect(agentLiveness(undefined, NOW).state).toBe('never');
    });

    it('an idle weekend does not alarm — the window is generous on purpose', () => {
        const justInside = NOW - AGENT_STALE_AFTER_MS + 60_000;
        const date = new Date(justInside).toISOString().slice(0, 10);
        expect(agentLiveness(date, NOW).state).toBe('live');
    });

    it('a future-dated value is live, never an error state', () => {
        expect(agentLiveness('2026-09-09', NOW).state).toBe('live');
    });
});

describe('agentLiveness — earning-device capture-health ', () => {
    const HOUR = 3_600_000;

    it('THE ATLAS RECONCILIATION — a fresh PE but a BROKEN earning device reads STALE', () => {
        // The exact bug: last_pe_date is today, so date-only liveness says "live",
        // but the earning device's capture is broken — it is NOT receiving now.
        // Capture-health is the direct signal and overrides the stale-but-fresh date.
        const r = agentLiveness('2026-09-07', NOW, undefined, {
            broken: true,
            lastCaptureAtMs: NOW - 2 * HOUR,
            brokenReason: 'no_readable_sources',
        });
        expect(r.state).toBe('stale');
        expect(r.captureBrokenReason).toBe('no_readable_sources');
    });

    it('surfaces the sole-witness-silence reason distinctly', () => {
        const r = agentLiveness('2026-09-07', NOW, undefined, {
            broken: true,
            lastCaptureAtMs: NOW - HOUR,
            brokenReason: 'sole_witness_silence',
        });
        expect(r.state).toBe('stale');
        expect(r.captureBrokenReason).toBe('sole_witness_silence');
    });

    it('a broken device with no known brokenReason defaults to no_readable_sources', () => {
        const r = agentLiveness('2026-09-07', NOW, undefined, {
            broken: true,
            lastCaptureAtMs: null,
        });
        expect(r.state).toBe('stale');
        expect(r.captureBrokenReason).toBe('no_readable_sources');
    });

    it('ms-precise last capture BEATS a stale day-granular date — reads live', () => {
        // last_pe_date is 5 days old (would be stale), but the earning device
        // captured 1h ago. The ms-precise signal wins and the card reads live.
        const r = agentLiveness('2026-09-02', NOW, undefined, {
            broken: false,
            lastCaptureAtMs: NOW - HOUR,
        });
        expect(r.state).toBe('live');
        expect(r.lastPeAtMs).toBe(NOW - HOUR);
        expect(r.captureBrokenReason).toBeNull();
    });

    it('RED CONTROL — a NON-broken device with a STALE last capture reads stale from RECENCY, not the flag', () => {
        // Proves broken-flag and recency are independent: capture is not broken,
        // but it last captured 3 days ago, so recency alone makes it stale — and
        // captureBrokenReason stays null because nothing declared it broken.
        const r = agentLiveness('2026-09-06', NOW, undefined, {
            broken: false,
            lastCaptureAtMs: NOW - 3 * 24 * HOUR,
        });
        expect(r.state).toBe('stale');
        expect(r.captureBrokenReason).toBeNull();
    });

    it('NEGATIVE CONTROL — no capture arg behaves exactly like the date-only call (no regression)', () => {
        const withNull = agentLiveness('2026-09-02', NOW, undefined, null);
        const without = agentLiveness('2026-09-02', NOW);
        expect(withNull.state).toBe('stale');
        expect(withNull.state).toBe(without.state);
        expect(withNull.lastPeAtMs).toBe(without.lastPeAtMs);
        expect(withNull.captureBrokenReason ?? null).toBeNull();
    });

    it('NEGATIVE CONTROL — a healthy fresh capture is live with no broken reason', () => {
        const r = agentLiveness(null, NOW, undefined, {
            broken: false,
            lastCaptureAtMs: NOW - HOUR,
        });
        expect(r.state).toBe('live');
        expect(r.captureBrokenReason).toBeNull();
    });
});

describe('linkedAgentIsLive / anyLinkedAgentLive', () => {
    const HOUR = 3_600_000;

    it('a fresh last_pe_date reads live; a stale one does not', () => {
        expect(linkedAgentIsLive({ last_pe_date: '2026-09-07' }, NOW)).toBe(true);
        expect(linkedAgentIsLive({ last_pe_date: '2026-09-02' }, NOW)).toBe(false);
    });

    it('RED CONTROL — a broken earning device is NOT live even with a fresh date', () => {
        // Same reconciliation as the Agent Hub card: capture-health overrides the
        // fresh-but-stale date, so the agent reads not-live.
        expect(
            linkedAgentIsLive(
                {
                    last_pe_date: '2026-09-07',
                    capture_broken: true,
                    last_capture_at_ms: NOW - 2 * HOUR,
                },
                NOW,
            ),
        ).toBe(false);
    });

    it('an agent that has never produced a PE is not live', () => {
        expect(linkedAgentIsLive({ last_pe_date: null }, NOW)).toBe(false);
        expect(linkedAgentIsLive({}, NOW)).toBe(false);
    });

    it('anyLinkedAgentLive — true iff at least one agent is live', () => {
        expect(anyLinkedAgentLive([], NOW)).toBe(false);
        expect(
            anyLinkedAgentLive(
                [{ last_pe_date: '2026-09-02' }, { last_pe_date: null }],
                NOW,
            ),
        ).toBe(false);
        expect(
            anyLinkedAgentLive(
                [{ last_pe_date: '2026-09-02' }, { last_pe_date: '2026-09-07' }],
                NOW,
            ),
        ).toBe(true);
    });
});

describe('lastActivityDisplay (never render a future / invented time)', () => {
    it('RED CONTROL — the judging value for a same-day last_pe_date IS in the future (the bug the display fixes)', () => {
        // A new agent whose only fact is today's date: liveness judges on the END of the UTC day,
        // which is hours ahead of NOW. Rendering it produced "Last active 6:59:59 PM" (CDT).
        const judged = agentLiveness('2026-09-07', NOW).lastPeAtMs as number;
        expect(judged).toBeGreaterThan(NOW);
    });

    it('a day-granular date displays as that DATE, never an instant (so no future clock time)', () => {
        const d = lastActivityDisplay('2026-09-07', null, NOW);
        expect(d).toEqual({ kind: 'day', dateUtc: '2026-09-07', dayStartMs: Date.UTC(2026, 8, 7), daysAgo: 0 });
        expect(lastActivityDisplay('2026-09-06', null, NOW)).toMatchObject({ kind: 'day', daysAgo: 1 });
        expect(lastActivityDisplay('2026-09-01', null, NOW)).toMatchObject({ kind: 'day', daysAgo: 6 });
    });

    it('a ms-precise capture wins and a future one is clamped to now', () => {
        const capture = { broken: false, lastCaptureAtMs: NOW - 60_000 };
        expect(lastActivityDisplay('2026-09-07', capture, NOW)).toEqual({ kind: 'instant', atMs: NOW - 60_000 });
        const skewed = { broken: false, lastCaptureAtMs: NOW + 5 * 3_600_000 };
        const d = lastActivityDisplay('2026-09-07', skewed, NOW);
        expect(d.kind === 'instant' && d.atMs <= NOW).toBe(true);
    });

    it('an exact fallback (newest PE timestamp) beats the bare date; nothing known is none', () => {
        expect(lastActivityDisplay('2026-09-07', null, NOW, NOW - 1000)).toEqual({ kind: 'instant', atMs: NOW - 1000 });
        expect(lastActivityDisplay(null, null, NOW)).toEqual({ kind: 'none' });
        expect(lastActivityDisplay('junk', null, NOW, 0)).toEqual({ kind: 'none' });
    });

    it('texts: a day renders a date + Today/Yesterday/Nd ago; never a time of day', () => {
        const t = ((k: string, o?: { count?: number }) => (o?.count !== undefined ? `${k}:${o.count}` : k)) as unknown as TFunction;
        const rel = (): string => 'REL';
        const today = lastActivityTexts(lastActivityDisplay('2026-09-07', null, NOW), t, rel);
        expect(today?.relative).toBe('promise.today');
        expect(today?.absolute).toBe(new Date(2026, 8, 7).toLocaleDateString());
        expect(lastActivityTexts(lastActivityDisplay('2026-09-06', null, NOW), t, rel)?.relative).toBe('promise.yesterday');
        expect(lastActivityTexts(lastActivityDisplay('2026-09-01', null, NOW), t, rel)?.relative).toBe('agentHub.daysAgo:6');
        expect(lastActivityTexts({ kind: 'none' }, t, rel)).toBeNull();
        expect(lastActivityTexts({ kind: 'instant', atMs: NOW }, t, rel)?.relative).toBe('REL');
    });
});

describe('workingLine ', () => {
    const rel = (ms: number): string => `rel(${NOW - ms})`;
    const live = agentLiveness('2026-09-07', NOW, undefined, { broken: false, lastCaptureAtMs: NOW - 3_600_000 });
    const broken = agentLiveness('2026-09-07', NOW, undefined, { broken: true, lastCaptureAtMs: NOW - 3_600_000, brokenReason: 'process_launcher_changed' });

    it('a broken computer reads "since" the moment it broke, never the last work\'s arrival (RED: without the moment, no time at all)', () => {
        expect(workingLine({ liveness: broken, lastActivityRelative: 'rel(last)', brokenSinceMs: NOW - 600_000, relative: rel, nowMs: NOW }))
            .toEqual({ key: 'agentHub.workingStopped', time: 'rel(600000)', tone: 'stale' });
        expect(workingLine({ liveness: broken, lastActivityRelative: 'rel(last)', brokenSinceMs: null, relative: rel, nowMs: NOW }))
            .toEqual({ key: 'agentHub.workingStoppedNoTime', time: null, tone: 'stale' });
        // A moment ahead of the phone's clock is shown as now, never in the future.
        expect(workingLine({ liveness: broken, lastActivityRelative: null, brokenSinceMs: NOW + 5_000, relative: rel, nowMs: NOW }).time).toBe('rel(0)');
    });

    it('plain silence past the window keeps "since the last activity" (RED: a broken computer does not)', () => {
        const silent = agentLiveness('2026-09-01', NOW);
        expect(silent.state).toBe('stale');
        expect(workingLine({ liveness: silent, lastActivityRelative: '6 days ago', brokenSinceMs: NOW - 1, relative: rel, nowMs: NOW }))
            .toEqual({ key: 'agentHub.workingStopped', time: '6 days ago', tone: 'stale' });
    });

    it('a live agent reads "connected and recording"', () => {
        expect(workingLine({ liveness: live, lastActivityRelative: '1h ago', relative: rel, nowMs: NOW }))
            .toEqual({ key: 'agentHub.workingEarning', time: '1h ago', tone: 'live' });
    });

    it('nothing yet reads "not receiving yet"', () => {
        const never = agentLiveness(null, NOW);
        expect(workingLine({ liveness: never, lastActivityRelative: null, relative: rel, nowMs: NOW }))
            .toEqual({ key: 'agentHub.workingNotReceiving', time: null, tone: 'never' });
    });
});
