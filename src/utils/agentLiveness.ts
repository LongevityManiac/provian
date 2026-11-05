import type { TFunction } from 'i18next';
import type { CaptureBrokenReason } from '../core/agents/captureHealthHint';

/**
 * agentLiveness — is this agent's work actually reaching us right now?
 *
 * THE BUG THIS REPLACES. The agent card derived its working signal from
 * `pe_count > 0` — a LIFETIME total that only ever grows. Once an agent had
 * produced a single PE the card read "connected and earning" permanently, so
 * when Atlas's capture broke on 2026-09-01 the hub kept showing a healthy agent
 * for five days. The signal was structurally incapable of going negative.
 *
 * Liveness is a question about RECENCY, and it needs three answers, not two:
 *
 *   never   — no PE has ever arrived. Setup is not finished; saying "not
 *             receiving" would be alarming and wrong.
 *   live    — a PE arrived inside the window.
 *   stale   — PEs arrived once and have stopped. THIS is the alarm, and it is
 *             the state that had no representation before.
 *
 * The window is deliberately generous. An agent is allowed to be idle — a
 * quiet weekend must not page anyone — so this fires only once silence has
 * lasted longer than any ordinary gap.
 */

/** Silence beyond this means "we have stopped receiving", not "it is resting". */
export const AGENT_STALE_AFTER_MS = 48 * 60 * 60 * 1000;

export type AgentLiveness = 'never' | 'live' | 'stale';

export interface AgentLivenessResult {
    state: AgentLiveness;
    /** Epoch ms of the last PE, when one is known. */
    lastPeAtMs: number | null;
    /** Whole days since the last PE, for the "since" copy. */
    daysSince: number | null;
    /**
     * why the agent reads as not-receiving, when capture-health says so.
     * null when liveness came from PE recency alone (the pre-existing behaviour).
     */
    captureBrokenReason?: CaptureBrokenReason | null;
}

/**
 * the earning device's capture-health, the DIRECT "is it receiving
 * now" signal. A broken/silent device is not receiving even if a PE landed
 * earlier today — the exact case a `last_pe_date`-only card missed (Atlas kept
 * a fresh `last_pe_date` while its session heartbeat, and later its capture,
 * went stale). `lastCaptureAtMs` is ms-precise, unlike the day-granular date.
 */
export interface AgentCaptureHealth {
    broken: boolean;
    lastCaptureAtMs: number | null;
    brokenReason?: CaptureBrokenReason | null;
}

/**
 * Parse the relay's `last_pe_date` ('YYYY-MM-DD', UTC).
 *
 * Returns the END of that day: the field has day granularity, and treating it
 * as midnight would systematically overstate silence by up to 24h — enough to
 * make a working agent look stale.
 */
export function parseLastPeDate(value: string | null | undefined): number | null {
    if (typeof value !== 'string') return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (!m) return null;
    const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
    return Number.isFinite(ms) ? ms : null;
}

/**
 * The subset of a relay linked-agent record needed to judge liveness. Kept as a
 * structural type so this util stays free of a RelayAPIService import; the real
 * `LinkedAgent` (RelayAPIService) is assignable to it.
 */
export interface LinkedAgentLivenessFields {
    last_pe_date?: string | null;
    capture_broken?: boolean | null;
    last_capture_at_ms?: number | null;
    capture_broken_reason?: CaptureBrokenReason | null;
}

/**
 * Is this one linked agent live right now? Builds the capture-health exactly as
 * AgentHubScreen does and asks `agentLiveness`. This is the single
 * per-agent "live" test both the Agent Hub card and the Earn surface status use,
 * so the two surfaces cannot disagree about whether an agent is producing work.
 */
export function linkedAgentIsLive(
    agent: LinkedAgentLivenessFields,
    nowMs: number = Date.now(),
): boolean {
    const capture: AgentCaptureHealth | null =
        agent.capture_broken != null || agent.last_capture_at_ms != null
            ? {
                  broken: agent.capture_broken === true,
                  lastCaptureAtMs: agent.last_capture_at_ms ?? null,
                  brokenReason: agent.capture_broken_reason ?? null,
              }
            : null;
    return agentLiveness(agent.last_pe_date, nowMs, undefined, capture).state === 'live';
}

/** Whether ANY linked agent in the list reads live (see `linkedAgentIsLive`). */
export function anyLinkedAgentLive(
    agents: readonly LinkedAgentLivenessFields[],
    nowMs: number = Date.now(),
): boolean {
    return agents.some((a) => linkedAgentIsLive(a, nowMs));
}

export function agentLiveness(
    lastPeDate: string | null | undefined,
    nowMs: number = Date.now(),
    staleAfterMs: number = AGENT_STALE_AFTER_MS,
    capture?: AgentCaptureHealth | null,
): AgentLivenessResult {
    // Prefer the earning device's ms-precise last capture over the day-granular
    // last_pe_date — it is the direct "last real activity".
    const dateMs = parseLastPeDate(lastPeDate);
    const lastPeAtMs = capture?.lastCaptureAtMs ?? dateMs;

    // Capture-health is the DIRECT signal: a broken/silent EARNING device is
    // "not receiving" NOW, even if a PE landed earlier today — the exact case the
    // last_pe_date-only card missed. This is what makes the card read the truth
    // instead of the frozen session-connect heartbeat.
    if (capture?.broken === true) {
        const daysSince = lastPeAtMs !== null
            ? Math.max(0, Math.floor((nowMs - lastPeAtMs) / 86_400_000))
            : null;
        return {
            state: 'stale',
            lastPeAtMs,
            daysSince,
            captureBrokenReason: capture.brokenReason ?? 'no_readable_sources',
        };
    }

    if (lastPeAtMs === null) {
        return { state: 'never', lastPeAtMs: null, daysSince: null, captureBrokenReason: null };
    }
    const age = nowMs - lastPeAtMs;
    const daysSince = Math.max(0, Math.floor(age / 86_400_000));
    // A future-dated value (clock skew across timezones) is treated as live
    // rather than as an error — never alarm on our own arithmetic.
    if (age <= staleAfterMs) return { state: 'live', lastPeAtMs, daysSince, captureBrokenReason: null };
    return { state: 'stale', lastPeAtMs, daysSince, captureBrokenReason: null };
}

/**
 * what a card may SHOW as the agent's last activity.
 *
 * `agentLiveness().lastPeAtMs` is a JUDGING value: for a day-granular `last_pe_date` it is the END
 * of that UTC day (23:59:59.999), so a quiet agent is never called stale early. Rendered as a clock
 * time it is a fiction — a new agent read "Last active 6:59:59 PM" (UTC day-end in CDT, in the
 * future) beside "last activity Just now". Display therefore never uses it:
 *
 * instant — a real ms-precise moment (the earning device's last capture, or a PE timestamp the
 * caller holds), clamped to `nowMs` so a skewed clock never renders a future time;
 * day — only the UTC date is known: show the date, never a time of day;
 * none — nothing is known.
 */
export type LastActivityDisplay =
    | { kind: 'instant'; atMs: number }
    | { kind: 'day'; dateUtc: string; dayStartMs: number; daysAgo: number }
    | { kind: 'none' };

const DAY_MS = 86_400_000;

export function lastActivityDisplay(
    lastPeDate: string | null | undefined,
    capture: AgentCaptureHealth | null | undefined,
    nowMs: number = Date.now(),
    exactFallbackMs?: number | null,
): LastActivityDisplay {
    const exact = [capture?.lastCaptureAtMs, exactFallbackMs].find(
        (v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0,
    );
    if (exact !== undefined) return { kind: 'instant', atMs: Math.min(exact, nowMs) };
    const endOfDay = parseLastPeDate(lastPeDate);
    if (endOfDay === null || typeof lastPeDate !== 'string') return { kind: 'none' };
    const dayStartMs = endOfDay - (DAY_MS - 1);
    const todayStartMs = Math.floor(nowMs / DAY_MS) * DAY_MS;
    const daysAgo = Math.max(0, Math.round((todayStartMs - dayStartMs) / DAY_MS));
    return { kind: 'day', dateUtc: lastPeDate.trim(), dayStartMs, daysAgo };
}

/** The two strings a card renders for a `LastActivityDisplay`, or null when nothing is known. */
export function lastActivityTexts(
    d: LastActivityDisplay,
    t: TFunction,
    relative: (ms: number) => string,
): { absolute: string; relative: string } | null {
    if (d.kind === 'none') return null;
    if (d.kind === 'instant') {
        return { absolute: new Date(d.atMs).toLocaleString(), relative: relative(d.atMs) };
    }
    // Day-only: the calendar date as a LOCAL date object so no timezone shifts the day shown,
    // and no time of day is invented.
    const [y, m, day] = d.dateUtc.split('-').map(Number);
    return {
        absolute: new Date(y, m - 1, day).toLocaleDateString(),
        relative: d.daysAgo === 0 ? t('promise.today')
            : d.daysAgo === 1 ? t('promise.yesterday')
                : t('agentHub.daysAgo', { count: d.daysAgo }),
    };
}

/**
 * The card's working line : which sentence, with which time, in which tone.
 *
 * live — work is arriving: "connected and recording · last activity".
 * stale — not receiving. For a broken computer the time is WHEN IT BROKE (the relay's
 * `capture_broken_since_ms`), never the last work's arrival (work is batched, so its
 * arrival is no moment of breaking); when that moment is unknown, no time is shown.
 * Plain silence (no broken report) keeps "since the last activity", which is the truth.
 * never — nothing has arrived yet.
 */
export type WorkingTone = 'live' | 'stale' | 'never';

export interface WorkingLine {
    /** i18n key; every key takes `name`, and `time` when `time` is not null. */
    key: string;
    time: string | null;
    tone: WorkingTone;
}

export function workingLine(input: {
    liveness: AgentLivenessResult;
    /** The card's "last activity" relative text (null when nothing is known). */
    lastActivityRelative: string | null;
    /** `capture_broken_since_ms` from the relay. */
    brokenSinceMs?: number | null;
    relative: (ms: number) => string;
    nowMs: number;
}): WorkingLine {
    const { liveness, lastActivityRelative } = input;
    if (liveness.state === 'live') {
        if (lastActivityRelative === null) return { key: 'agentHub.workingNotReceiving', time: null, tone: 'never' };
        return { key: 'agentHub.workingEarning', time: lastActivityRelative, tone: 'live' };
    }
    if (liveness.state === 'stale') {
        if (liveness.captureBrokenReason) {
            const since = input.brokenSinceMs;
            return typeof since === 'number' && Number.isFinite(since) && since > 0
                ? { key: 'agentHub.workingStopped', time: input.relative(Math.min(since, input.nowMs)), tone: 'stale' }
                : { key: 'agentHub.workingStoppedNoTime', time: null, tone: 'stale' };
        }
        return lastActivityRelative !== null
            ? { key: 'agentHub.workingStopped', time: lastActivityRelative, tone: 'stale' }
            : { key: 'agentHub.workingStoppedNoTime', time: null, tone: 'stale' };
    }
    return { key: 'agentHub.workingNotReceiving', time: null, tone: 'never' };
}
