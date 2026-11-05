/**
 * Accept-once for the in-app requester (item 6).
 *
 * The relay's `/v1/present/verify` is stateless by design: the same valid token verifies again
 * inside its window. One burn backs exactly one presentation, so its `presentation_id` (= burn id)
 * is the dedupe key — and a requester that grants anything must accept each id only once. This is
 * that seen-store for the app's requester screen.
 *
 * AsyncStorage holds `{ id → expiry ms }` (a presentation id is public, non-sensitive data). An id
 * is kept until its challenge deadline plus skew — after that the verifier refuses the presentation
 * as expired anyway — and pruned on every claim. An in-memory set backs the storage so a storage
 * failure can never turn a second acceptance into a first one within this app session.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

export const ACCEPTED_PRESENTATIONS_KEY = '@provian_accepted_presentations_v1';
/** Kept past the challenge deadline by the verifier's clock skew. */
const SKEW_MS = 60_000;
/** When the verify result carries no challenge deadline: the longest presentation window + skew. */
const FALLBACK_KEEP_MS = 900_000 + SKEW_MS;

type Storage = Pick<typeof AsyncStorage, 'getItem' | 'setItem'>;

const inMemory = new Map<string, number>();

function readMap(raw: string | null): Record<string, number> {
    if (!raw) return {};
    try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
        const out: Record<string, number> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
        }
        return out;
    } catch {
        return {};
    }
}

/**
 * Claim `presentationId` for acceptance. Resolves true exactly once per id while it is live; false
 * when it was already accepted (or the id is empty — an id-less result can never be accepted).
 */
export async function claimPresentationOnce(
    presentationId: string,
    challengeExpiresAtSeconds: number | null | undefined,
    opts: { storage?: Storage; nowMs?: number } = {},
): Promise<boolean> {
    const id = (presentationId ?? '').trim();
    if (id.length === 0) return false;
    const storage = opts.storage ?? AsyncStorage;
    const now = opts.nowMs ?? Date.now();
    const keepUntil = typeof challengeExpiresAtSeconds === 'number' && Number.isFinite(challengeExpiresAtSeconds)
        ? Math.max(challengeExpiresAtSeconds * 1000 + SKEW_MS, now + SKEW_MS)
        : now + FALLBACK_KEEP_MS;

    const mem = inMemory.get(id);
    if (mem !== undefined && mem > now) return false;

    let map: Record<string, number> = {};
    try { map = readMap(await storage.getItem(ACCEPTED_PRESENTATIONS_KEY)); } catch { map = {}; }
    for (const [k, exp] of Object.entries(map)) if (exp <= now) delete map[k];
    if (map[id] !== undefined) {
        inMemory.set(id, map[id]);
        return false;
    }
    map[id] = keepUntil;
    inMemory.set(id, keepUntil);
    try { await storage.setItem(ACCEPTED_PRESENTATIONS_KEY, JSON.stringify(map)); } catch { /* in-memory still holds it */ }
    return true;
}

/** Test seam: forget the in-memory set. */
export function __resetAcceptedPresentationsForTest(): void {
    inMemory.clear();
}

export type RequesterRejectReason =
    | 'not_valid'
    | 'predicates_require_reputation_tier'
    | 'presenter_mismatch'
    | 'presentation_id_missing'
    | 'already_accepted';

/**
 * The requester's accept decision over a relay verify result. Every other check runs FIRST; the
 * accept-once claim is last, so a presentation refused for another reason never burns its id.
 *   - `valid` must be true;
 *   - when predicates were asked, the tier must be `reputation` (a pe_fact token answers none);
 *   - the presenter must be the one asked (when the screen knows who that is);
 *   - the result must carry a `presentation_id` (no id → cannot be accepted once → refused);
 *   - the id must not have been accepted before.
 */
export async function acceptVerifiedPresentation(
    result: { valid: boolean; tier?: string; presentation_id?: string | null; challenge_expires_at?: number | null },
    ctx: { predicatesAsked: number; presenterMatches: boolean; storage?: Storage; nowMs?: number },
): Promise<{ accepted: true } | { accepted: false; reason: RequesterRejectReason }> {
    if (result.valid !== true) return { accepted: false, reason: 'not_valid' };
    if (ctx.predicatesAsked > 0 && result.tier !== 'reputation') return { accepted: false, reason: 'predicates_require_reputation_tier' };
    if (!ctx.presenterMatches) return { accepted: false, reason: 'presenter_mismatch' };
    const id = typeof result.presentation_id === 'string' ? result.presentation_id.trim() : '';
    if (id.length === 0) return { accepted: false, reason: 'presentation_id_missing' };
    const fresh = await claimPresentationOnce(id, result.challenge_expires_at ?? null, { storage: ctx.storage, nowMs: ctx.nowMs });
    return fresh ? { accepted: true } : { accepted: false, reason: 'already_accepted' };
}
