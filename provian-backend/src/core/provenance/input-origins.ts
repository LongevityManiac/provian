/**
 * input_origins — a forward-only Provenance Envelope field (Prompt 1 + Prompt 1b).
 *
 * A list recording the EXTERNAL artifacts a piece of work consumed. THIS module
 * is the backend copy of the canonical normalizer + classifiers. It is PURE
 * PROVENANCE with ZERO mint effect: the field is hashed and stored on the
 * canonical PE chain doc, but it is never a parameter to the sealing computation
 * (monetary-accounting / record-path-estimate never read it). Pricing /
 * independence-weighting / witness-weighting is a later, separate money-path
 * change (the "clean seam").
 *
 * ENTRY SHAPE (Prompt 1b, 09-12): `{ hash, origin_identifier, witnessed, witness? }`.
 * - `hash`, `origin_identifier` the artifact (Prompt 1).
 * - `witnessed` (boolean) — true when a key that is NOT the actor's vouches that
 * the origin crossed the process boundary (the observer's own body-HMAC /
 * device signature, an HMAC-verified webhook, a chain-verified watcher, or the
 * origin owner's signature over a digest). False for anything the actor
 * supplied in the envelope body or scanned from the output artifact.
 * - `witness` the reference to whoever vouched (type + key/device identity +
 * attestation tier where the witness is a device). Present ONLY when
 * `witnessed` is true; absent otherwise. A `witnessed:true` claim with no
 * valid witness reference fails closed to `witnessed:false` (you cannot vouch
 * without naming the voucher).
 *
 * FORWARD-ONLY at the ENTRY level: an entry produced by the Prompt 1 build lacks
 * `witnessed`. The canonical readers hash `raw.input_origins` VERBATIM (they never
 * re-normalize before hashing), so a Prompt-1 stored entry re-derives its ORIGINAL
 * sealed hash byte-identically and stays valid. On READ it is interpreted as
 * `witnessed:false` with no witness (`readInputOrigin`). Nothing rejects an entry
 * for lacking the fields.
 *
 * LIST THREE-STATE (Prompt 1, UNCHANGED):
 * - ABSENT = the key is OMITTED (or null on read). Unobservable.
 * - PRESENT_EMPTY = `[]`. Observed; no external inputs.
 * - PRESENT_POPULATED = `[{…}, …]`.
 * Builders still emit the key IFF `normalizeInputOrigins !== null`, so a PE
 * that observed no origins is byte-identical to a legacy PE.
 *
 * The SAME rules live in `provian-agent-sdk/src/input-origins.ts` and
 * `src/core/provenance/inputOrigins.ts` (the app); they cannot cross-import
 * (three packages), so the caps are bound to agreement by a source-read parity
 * test (`input-origins-parity.test.ts`), mirroring the ai-conversation floor.
 */

import { createHash } from 'crypto';
import { signedCitationOf, type OutputSignature } from '../meter/output-signature';

/** The reference to whoever vouched an origin crossed the process boundary. */
export interface OriginWitness {
  /** Witness type, e.g. observer_device / forge_webhook / chain_watcher / origin_owner_signature. */
  readonly type: string;
  /** The key/device identity of the voucher (device id, webhook id, address, key id). */
  readonly identity: string;
  /** Attestation tier — present only when the witness is a device (e.g. hardware_full / software). */
  readonly attestation_tier?: string;
}

/** One recorded external input origin (Prompt 1b entry shape). */
export interface InputOrigin {
  readonly hash: string;
  readonly origin_identifier: string;
  /** True only when a non-actor key vouched the origin crossed the boundary. */
  readonly witnessed: boolean;
  /** Present only when `witnessed` is true. */
  readonly witness?: OriginWitness;
  /**
   * A SIGNED citation only (`out:<producer address>`,): the producer's EIP-191
   * signature over the output's hash (`core/meter/output-signature.ts`). Kept only when it is
   * well-formed and names the entry's own signer and hash; the relay verifies it at intake.
   */
  readonly signature?: OutputSignature;
}

/** The three representable states of `input_origins`. */
export type InputOriginsState = 'absent' | 'present_empty' | 'present_populated';

/** Bloat guards. Legitimate values are far below these; only abuse is capped. */
export const INPUT_ORIGINS_MAX_ENTRIES = 64;
export const INPUT_ORIGIN_HASH_MAX_LEN = 256;
export const INPUT_ORIGIN_IDENTIFIER_MAX_LEN = 512;
/** Witness reference caps (Prompt 1b). */
export const INPUT_ORIGIN_WITNESS_TYPE_MAX_LEN = 64;
export const INPUT_ORIGIN_WITNESS_IDENTITY_MAX_LEN = 256;
export const INPUT_ORIGIN_WITNESS_TIER_MAX_LEN = 64;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalize a witness reference to its canonical form, or `null` when it is not a
 * usable reference. Requires non-empty string `type` + `identity`; `attestation_tier`
 * is optional (present for device witnesses). Extra keys dropped, values length-capped.
 */
export function normalizeOriginWitness(value: unknown): OriginWitness | null {
  if (!isPlainObject(value)) return null;
  const { type, identity, attestation_tier: tier } = value;
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
 * credentials embedded in URLs never leave the device (and are never
 * stored by the relay). An `origin_identifier` is stored IN THE CLEAR, so one that
 * still carries a credential — URL userinfo (`scheme://user:token@host`), a
 * credential-named query parameter (`?token=`), or a known token shape (`ghp_…`,
 * `glpat-…`, `npm_…`, `AKIA…`, …) — is converted to the PRIVATE form on
 * normalization: the identifier becomes the non-sensitive type tag for its class
 * and the hash is taken over the credential-STRIPPED value (never the credential). Clean identifiers pass byte-identical.
 * The origin builders strip credentials before this point; this is the backstop
 * for any caller-supplied origin (witness posts, explicit reports, relay bodies).
 */
const ORIGIN_TOKEN_SHAPES = [
  'gh[pousr]_[A-Za-z0-9]{16,}',
  'github_pat_[A-Za-z0-9_]{16,}',
  'glpat-[A-Za-z0-9_-]{16,}',
  'npm_[A-Za-z0-9]{30,}',
  'xox[abprs]-[A-Za-z0-9-]{8,}',
  'AKIA[0-9A-Z]{16}',
  '(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}',
];
const ORIGIN_TOKEN_SHAPES_GLOBAL_RE = new RegExp(ORIGIN_TOKEN_SHAPES.join('|'), 'gi');
export const ORIGIN_CREDENTIAL_RE = new RegExp([
  // URL userinfo — except the bare conventional ssh user `git@` (no password),
  // which is not a credential (`git+ssh://git@github.com/o/r.git` stays clean).
  '[a-z][a-z0-9+.-]*://(?!git@)[^/?#]*@',
  '[?&;#](?:access_token|token|auth|authorization|key|api_key|apikey|password|passwd|pwd|secret|sig|signature|x-amz-signature|x-amz-credential|private_token)=',
  ...ORIGIN_TOKEN_SHAPES,
].join('|'), 'i');

/**
 * The value a credential-bearing identifier is DIGESTED over: userinfo (but a
 * bare `git@`) removed, query/fragment removed, token shapes redacted — so no
 * digest is ever taken over a string containing the credential.
 */
export function credentialStrippedIdentifier(identifier: string): string {
  return identifier
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)@/gi, (_m: string, scheme: string, user: string) =>
      (user === 'git' ? `${scheme}git@` : scheme))
    .replace(/[?#]\S*/g, '')
    .replace(ORIGIN_TOKEN_SHAPES_GLOBAL_RE, '[redacted]');
}

/** The private type tag an identifier of each class falls back to (the ruled tags). */
export function privateTagForIdentifier(identifier: string): string {
  if (identifier.startsWith('pkg:') || identifier.startsWith('npm:')) return 'private_pkg';
  if (identifier.startsWith('repo:') || identifier.startsWith('commit:')) return 'private_project';
  if (identifier.startsWith('domain:')) return 'private_host';
  return 'private_url_path';
}

/** Is this stored-in-the-clear identifier carrying a credential? */
export function originIdentifierCarriesCredential(identifier: string): boolean {
  return ORIGIN_CREDENTIAL_RE.test(identifier);
}

/**
 * Normalize an arbitrary caller-supplied value to the ONE canonical form for its
 * state:
 *   - not an array (undefined / null / object / string / number) → `null` (ABSENT).
 *   - an array → a filtered, capped array of canonical entries (which may be `[]`,
 *     i.e. PRESENT_EMPTY). Each entry must be a plain object with non-empty string
 *     `hash` and `origin_identifier`; every other key is dropped, values length-
 *     capped, order preserved, no dedup. `witnessed` is coerced to a boolean
 *     (default false); `witness` is emitted ONLY when `witnessed` is true AND a
 *     usable witness reference is present — otherwise `witnessed` fails closed to
 *     false and no witness is emitted. Malformed entries are dropped, never fatal.
 */
export function normalizeInputOrigins(value: unknown): InputOrigin[] | null {
  if (!Array.isArray(value)) return null;
  const out: InputOrigin[] = [];
  for (const raw of value) {
    if (out.length >= INPUT_ORIGINS_MAX_ENTRIES) break;
    if (!isPlainObject(raw)) continue;
    const { hash, origin_identifier: originId } = raw;
    if (typeof hash !== 'string' || typeof originId !== 'string') continue;
    let h = hash.slice(0, INPUT_ORIGIN_HASH_MAX_LEN);
    let o = originId.slice(0, INPUT_ORIGIN_IDENTIFIER_MAX_LEN);
    if (h.length === 0 || o.length === 0) continue;
    // never keep a credential in the clear — hash it under its private tag.
    if (originIdentifierCarriesCredential(originId)) {
      h = `sha256:${createHash('sha256').update(credentialStrippedIdentifier(originId), 'utf8').digest('hex')}`;
      o = privateTagForIdentifier(originId);
    }
    // Prompt 1b: a `witnessed:true` claim is only honored when it names a usable
    // voucher; otherwise it fails closed to false (cannot vouch without a witness).
    const witness = raw.witnessed === true ? normalizeOriginWitness(raw.witness) : null;
    const witnessed = witness !== null;
    // A signed citation keeps its signature (shape-checked here; recovered by the relay at intake).
    const signature = signedCitationOf({ hash: h, origin_identifier: o, signature: raw.signature });
    const base: InputOrigin = witnessed
      ? { hash: h, origin_identifier: o, witnessed: true, witness }
      : { hash: h, origin_identifier: o, witnessed: false };
    out.push(signature !== null ? { ...base, signature } : base);
  }
  return out;
}

/**
 * Classify a STORED / on-the-wire `input_origins` value into its three-state.
 * `undefined` (key omitted) and `null` both read as ABSENT — the forward-only
 * rule ("a missing field reads as absent, never as present-empty").
 */
export function inputOriginsState(value: unknown): InputOriginsState {
  if (value === undefined || value === null) return 'absent';
  if (Array.isArray(value)) {
    return value.length === 0 ? 'present_empty' : 'present_populated';
  }
  return 'absent';
}

/**
 * READ helper (Prompt 1b): interpret ONE stored entry with forward-only defaults.
 * A stored entry lacking `witnessed` (a Prompt 1 entry, or a hand-written legacy
 * one) reads as `witnessed:false` with no witness. This is a READ-side view for
 * consumers and API surfaces (e.g. `/export`); it NEVER re-normalizes what is
 * hashed. Returns `null` for a non-object.
 */
export function readInputOrigin(
  entry: unknown,
): { hash: unknown; origin_identifier: unknown; witnessed: boolean; witness?: unknown; signature?: unknown } | null {
  if (!isPlainObject(entry)) return null;
  const witnessed = entry.witnessed === true;
  const view = witnessed
    ? { hash: entry.hash, origin_identifier: entry.origin_identifier, witnessed: true, witness: entry.witness ?? null }
    : { hash: entry.hash, origin_identifier: entry.origin_identifier, witnessed: false };
  return entry.signature !== undefined ? { ...view, signature: entry.signature } : view;
}

/** READ helper: map a stored `input_origins` value to its forward-only read view. */
export function readInputOrigins(
  value: unknown,
): ReturnType<typeof readInputOrigin>[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((entry) => readInputOrigin(entry)).filter((e): e is NonNullable<typeof e> => e !== null);
}

/**
 * Is a STORED `input_origins` value well-formed for the canonical readers?
 * Accepts ABSENT (undefined/null) and any array whose every element is a plain
 * object carrying string `hash` + `origin_identifier`, with OPTIONAL `witnessed`
 * (boolean) and OPTIONAL `witness` (plain object) — so a Prompt 1 entry (no
 * `witnessed`) and a Prompt 1b entry both pass. The writer only ever stores
 * `normalizeInputOrigins(...)` output, so a well-formed doc always passes and a
 * hand-tampered shape (e.g. non-boolean `witnessed`) fails closed.
 */
export function isValidStoredInputOrigins(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (!Array.isArray(value)) return false;
  return value.every((entry) => {
    if (!isPlainObject(entry)) return false;
    if (typeof entry.hash !== 'string' || typeof entry.origin_identifier !== 'string') return false;
    if (entry.witnessed !== undefined && typeof entry.witnessed !== 'boolean') return false;
    if (entry.witness !== undefined && !isPlainObject(entry.witness)) return false;
    if (entry.signature !== undefined && !isPlainObject(entry.signature)) return false;
    return true;
  });
}
