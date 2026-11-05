/**
 * input_origins — a forward-only Provenance Envelope field (Prompt 1 + Prompt 1b).
 *
 * A list recording the EXTERNAL artifacts a piece of work consumed. THIS is the
 * SDK copy of the canonical normalizer + classifier. Its rules are byte-for-byte
 * identical to the backend (`provian-backend/src/core/provenance/input-origins.ts`)
 * and the app (`src/core/provenance/inputOrigins.ts`); the three packages cannot
 * cross-import, so the caps are bound to agreement by a source-read parity test.
 *
 * PURE PROVENANCE with ZERO mint effect. Entry shape (Prompt 1b):
 * `{ hash, origin_identifier, witnessed, witness? }`.
 *   - `witnessed` (boolean) — true only when a NON-actor key vouched the origin
 *     crossed the process boundary; false for actor-supplied / scanned origins.
 *   - `witness` — the voucher reference (type + identity + attestation_tier for a
 *     device witness). Present ONLY when `witnessed` is true; a `witnessed:true`
 *     with no usable witness fails closed to false.
 *
 * List three-state (Prompt 1, unchanged): not-an-array → `null` (ABSENT);
 * `[]` → PRESENT_EMPTY; populated → PRESENT_POPULATED. A Prompt 1 entry (no
 * `witnessed`) reads as `witnessed:false` and is never rejected (forward-only).
 */
import { createHash } from 'crypto';
import { signedCitationOf, type OutputSignature } from './output-signature';

/** The reference to whoever vouched an origin crossed the process boundary. */
export interface OriginWitness {
  type: string;
  identity: string;
  attestation_tier?: string;
}

/** One recorded external input origin (Prompt 1b entry shape). */
export interface InputOrigin {
  hash: string;
  origin_identifier: string;
  witnessed: boolean;
  witness?: OriginWitness;
  /**
   * A SIGNED citation only (`out:<kind>:<id>`,): the producer's signature over the
   * output's hash (`output-signature.ts`). Kept only when well-formed and naming the entry's own
   * signer and hash; the relay verifies it at intake.
   */
  signature?: OutputSignature;
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
/**
 * Trust Layer build §2.10: the `pe:` origin an agent cites to bind its act to a HUMAN APPROVAL PE
 * the human signed on the phone. The hash is the sha256 of the origin identifier (the relay
 * resolves the cited PE's own hash through its chain index); `witnessed` is false from the body —
 * the relay's index is the witness.
 */
export function humanApprovalOrigin(approvalPeId: string): InputOrigin {
  if (typeof approvalPeId !== 'string' || !/^pe_[A-Za-z0-9_-]{1,240}$/.test(approvalPeId)) {
    throw new Error('humanApprovalOrigin: a pe_… approval PE id is required');
  }
  const identifier = `pe:${approvalPeId}`;
  return { hash: `sha256:${createHash('sha256').update(identifier, 'utf8').digest('hex')}`, origin_identifier: identifier, witnessed: false };
}

export function normalizeOriginWitness(value: unknown): OriginWitness | null {
  if (!isPlainObject(value)) return null;
  const { type, identity, attestation_tier: tier } = value;
  if (typeof type !== 'string' || typeof identity !== 'string') return null;
  const t = type.slice(0, INPUT_ORIGIN_WITNESS_TYPE_MAX_LEN);
  const i = identity.slice(0, INPUT_ORIGIN_WITNESS_IDENTITY_MAX_LEN);
  if (t.length === 0 || i.length === 0) return null;
  const witness: OriginWitness = { type: t, identity: i };
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
