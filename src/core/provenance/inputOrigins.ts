/**
 * input_origins — a forward-only Provenance Envelope field (Prompt 1 + Prompt 1b).
 *
 * A list recording the EXTERNAL artifacts a piece of work consumed. THIS is the
 * mobile-app copy of the canonical normalizer + classifier. Its rules are
 * byte-for-byte identical to the backend
 * (`provian-backend/src/core/provenance/input-origins.ts`) and the SDK
 * (`provian-agent-sdk/src/input-origins.ts`); the three packages cannot
 * cross-import, so the caps are bound to agreement by a source-read parity test.
 *
 * PURE PROVENANCE, ZERO mint effect. Entry shape (Prompt 1b):
 * `{ hash, origin_identifier, witnessed, witness? }`.
 *   - `witnessed` (boolean) — true only when a NON-actor key vouched the origin
 *     crossed the process boundary; false for actor-supplied / scanned origins.
 *   - `witness` — the voucher reference (type + identity + attestation_tier for a
 *     device witness). Present ONLY when `witnessed` is true; a `witnessed:true`
 *     with no usable witness fails closed to false.
 *
 * List three-state (Prompt 1, unchanged): non-array → `null` (ABSENT);
 * `[]` → PRESENT_EMPTY; populated → PRESENT_POPULATED. `createEnvelope` sets the
 * key ONLY when normalized is non-null; a Prompt 1 entry (no `witnessed`) reads as
 * `witnessed:false` and is never rejected (forward-only).
 */

import { signedCitationOf, type OutputSignature } from '../meter/output-signature';

/** The reference to whoever vouched an origin crossed the process boundary. */
export interface OriginWitness {
    readonly type: string;
    readonly identity: string;
    readonly attestation_tier?: string;
}

/** One recorded external input origin (Prompt 1b entry shape). */
export interface InputOrigin {
    readonly hash: string;
    readonly origin_identifier: string;
    readonly witnessed: boolean;
    readonly witness?: OriginWitness;
    /**
     * A SIGNED citation only (`out:<kind>:<id>`,): the producer's signature over
     * the output's hash (`core/meter/output-signature.ts`). Kept only when well-formed and naming
     * the entry's own signer and hash; the relay verifies it at intake.
     */
    readonly signature?: OutputSignature;
}

/** The three representable states of `input_origins`. */
export type InputOriginsState = 'absent' | 'present_empty' | 'present_populated';

/** Bloat guards. Legitimate values are far below these; only abuse is capped. */
export const INPUT_ORIGINS_MAX_ENTRIES = 64;
export const INPUT_ORIGIN_HASH_MAX_LEN = 256;
export const INPUT_ORIGIN_IDENTIFIER_MAX_LEN = 512;
export const INPUT_ORIGIN_WITNESS_TYPE_MAX_LEN = 64;
export const INPUT_ORIGIN_WITNESS_IDENTITY_MAX_LEN = 256;
export const INPUT_ORIGIN_WITNESS_TIER_MAX_LEN = 64;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Normalize a witness reference, or `null` when it is not a usable reference. */
export function normalizeOriginWitness(value: unknown): OriginWitness | null {
    if (!isPlainObject(value)) return null;
    const type = value.type;
    const identity = value.identity;
    const tier = value.attestation_tier;
    if (typeof type !== 'string' || typeof identity !== 'string') return null;
    const t = type.slice(0, INPUT_ORIGIN_WITNESS_TYPE_MAX_LEN);
    const i = identity.slice(0, INPUT_ORIGIN_WITNESS_IDENTITY_MAX_LEN);
    if (t.length === 0 || i.length === 0) return null;
    const witness: { type: string; identity: string; attestation_tier?: string } = { type: t, identity: i };
    if (typeof tier === 'string' && tier.length > 0) {
        witness.attestation_tier = tier.slice(0, INPUT_ORIGIN_WITNESS_TIER_MAX_LEN);
    }
    return witness;
}

/**
 * Normalize a caller value to the ONE canonical form for its state. Non-array →
 * `null` (absent). Array → filtered/capped canonical entries (may be `[]`). Per
 * entry: string `hash` + `origin_identifier` required, extra keys dropped, values
 * length-capped; `witnessed` coerced to boolean (default false); `witness` emitted
 * ONLY when `witnessed` is true AND a usable witness is present, else `witnessed`
 * fails closed to false. Never throws.
 */
export function normalizeInputOrigins(value: unknown): InputOrigin[] | null {
    if (!Array.isArray(value)) return null;
    const out: InputOrigin[] = [];
    for (const raw of value) {
        if (out.length >= INPUT_ORIGINS_MAX_ENTRIES) break;
        if (!isPlainObject(raw)) continue;
        const hash = raw.hash;
        const originId = raw.origin_identifier;
        if (typeof hash !== 'string' || typeof originId !== 'string') continue;
        const h = hash.slice(0, INPUT_ORIGIN_HASH_MAX_LEN);
        const o = originId.slice(0, INPUT_ORIGIN_IDENTIFIER_MAX_LEN);
        if (h.length === 0 || o.length === 0) continue;
        const witness = raw.witnessed === true ? normalizeOriginWitness(raw.witness) : null;
        // A signed citation keeps its signature (shape-checked here; verified by the relay at intake).
        const signature = signedCitationOf({ hash: h, origin_identifier: o, signature: raw.signature });
        const base: InputOrigin = witness !== null
            ? { hash: h, origin_identifier: o, witnessed: true, witness }
            : { hash: h, origin_identifier: o, witnessed: false };
        out.push(signature !== null ? { ...base, signature } : base);
    }
    return out;
}

/**
 * Classify a value into its three-state. `undefined` (key omitted) and `null`
 * both read as ABSENT — a missing field is unobservable, never present-empty.
 */
export function inputOriginsState(value: unknown): InputOriginsState {
    if (value === undefined || value === null) return 'absent';
    if (Array.isArray(value)) {
        return value.length === 0 ? 'present_empty' : 'present_populated';
    }
    return 'absent';
}
