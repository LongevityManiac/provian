/**
 * output_digests — the citable OUTPUT of a PE (Trust Layer build, §2.3).
 *
 * A PE is metadata-only and fixed at mint. What makes it CITABLE is a digest of the thing it
 * produced: a commit sha, the sha256 of a file/artifact it wrote, the digest of a model response the
 * proxy tee observed, an on-chain tx hash, a receipt hash, a sensor-reading digest. Every lane
 * populates `output_digests[]` from what it ALREADY observes; the list is EMPTY when nothing is
 * observable — never a placeholder, never a guess. Content never leaves the device: a digest is a
 * hash plus an optional publicly-resolvable locator (a repo/commit URL, a chain tx), never bytes.
 *
 * Wire + stored shape (forward-only, hashed into the PE preimage the same way `input_origins` is —
 * the key is OMITTED when absent so every pre-existing PE hashes byte-identically):
 * { hash: '<algo>:<hex>', kind: <OutputDigestKind>, locator?: string }
 *
 * The relay keeps NO index of digests (: nothing at the relay grows with history).
 * A digest is citable because its producer SIGNS it when handing the output out
 * (`core/meter/output-signature.ts`); a consumer that cites the signed digest (`out:<producer>`)
 * builds the producer's Consumption, verified at intake (`core/pvt/output-citation.ts`).
 *
 * THREE COPIES, ONE SHAPE: this file (relay), `provian-agent-sdk/src/output-digests.ts` (daemon),
 * `src/core/provenance/outputDigests.ts` (app). `output-digests-parity.test.ts` pins the caps and
 * the hash grammar byte-identically across the three.
 */

/** What the digest is a digest OF. Rules by identifier type — never a catalog of sources. */
export const OUTPUT_DIGEST_KINDS = [
  'commit',      // a git commit sha (`git:<sha1|sha256>`)
  'file',        // sha256 of a file's bytes the actor wrote
  'artifact',    // sha256 of a produced artifact/bundle (replication pack output, build output)
  'response',    // sha256 of a model response body observed on the proxy tee
  'tx',          // an on-chain transaction hash (`evmtx:<0x…>`)
  'receipt',     // sha256 of a settlement/spend receipt record (e.g. a Link spend-request record)
  'sensor',      // sha256 of a sensor reading / measurement record
  'session',     // sha256 of a session fingerprint (an identity digest, citable as an output)
] as const;
export type OutputDigestKind = (typeof OUTPUT_DIGEST_KINDS)[number];
const KIND_SET: ReadonlySet<string> = new Set(OUTPUT_DIGEST_KINDS);

export interface OutputDigest {
  /** `<algo>:<hex>` — `sha256:<64 hex>` | `git:<40|64 hex>` | `evmtx:<0x + 64 hex>`. */
  readonly hash: string;
  readonly kind: OutputDigestKind;
  /** Optional PUBLIC locator (a URL / chain reference). Never a private path. */
  readonly locator?: string;
}

/** Bloat guards. Legitimate values are far below these; only abuse is capped. */
export const OUTPUT_DIGESTS_MAX_ENTRIES = 64;
export const OUTPUT_DIGEST_HASH_MAX_LEN = 128;
export const OUTPUT_DIGEST_LOCATOR_MAX_LEN = 512;

/** The hash grammar. A digest that does not parse is DROPPED (never a fatal submit error). */
export const OUTPUT_DIGEST_HASH_RE = /^(sha256:[0-9a-f]{64}|git:[0-9a-f]{40}|git:[0-9a-f]{64}|evmtx:0x[0-9a-f]{64})$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Lowercase the hex so `sha256:ABC…` and `sha256:abc…` index to one document. */
export function canonicalOutputDigestHash(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (v.length === 0 || v.length > OUTPUT_DIGEST_HASH_MAX_LEN) return null;
  return OUTPUT_DIGEST_HASH_RE.test(v) ? v : null;
}

/**
 * Normalize an arbitrary caller value to the canonical three-state form:
 *   - not an array → `null` (ABSENT — the key is omitted from the PE preimage);
 *   - an array → a filtered, capped, DEDUPED (by hash) array of canonical entries (`[]` allowed).
 * A locator that is not an http(s) URL or a `chain:`/`repo:` reference is dropped (privacy: a
 * private filesystem path must never ride a resolvable field — the hash is the whole record).
 */
export function normalizeOutputDigests(value: unknown): OutputDigest[] | null {
  if (!Array.isArray(value)) return null;
  const out: OutputDigest[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (out.length >= OUTPUT_DIGESTS_MAX_ENTRIES) break;
    if (!isPlainObject(raw)) continue;
    const { hash, kind, locator } = raw;
    if (typeof hash !== 'string' || typeof kind !== 'string') continue;
    const h = canonicalOutputDigestHash(hash);
    if (h === null || !KIND_SET.has(kind)) continue;
    if (seen.has(h)) continue;
    seen.add(h);
    const entry: { hash: string; kind: OutputDigestKind; locator?: string } = {
      hash: h, kind: kind as OutputDigestKind,
    };
    if (typeof locator === 'string') {
      const l = locator.trim().slice(0, OUTPUT_DIGEST_LOCATOR_MAX_LEN);
      if (isPublicLocator(l)) entry.locator = l;
    }
    out.push(entry);
  }
  return out;
}

/** A locator is public iff it is an http(s) URL or a typed chain/repo reference — never a path. */
export function isPublicLocator(value: string): boolean {
  if (value.length === 0) return false;
  if (/^https?:\/\/[^\s]+$/i.test(value)) return true;
  if (/^(chain|repo|evmtx|git):[^\s]+$/i.test(value)) return true;
  return false;
}

/** Classify a STORED / on-the-wire value into its three-state (mirrors `inputOriginsState`). */
export type OutputDigestsState = 'absent' | 'present_empty' | 'present_populated';
export function outputDigestsState(value: unknown): OutputDigestsState {
  if (!Array.isArray(value)) return 'absent';
  return value.length === 0 ? 'present_empty' : 'present_populated';
}

/** Strict stored-shape check (chain validators): absent, or an array of canonical entries. */
export function isValidStoredOutputDigests(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  if (value.length > OUTPUT_DIGESTS_MAX_ENTRIES) return false;
  for (const raw of value) {
    if (!isPlainObject(raw)) return false;
    if (typeof raw.hash !== 'string' || canonicalOutputDigestHash(raw.hash) !== raw.hash) return false;
    if (typeof raw.kind !== 'string' || !KIND_SET.has(raw.kind)) return false;
    if (raw.locator !== undefined && (typeof raw.locator !== 'string' || !isPublicLocator(raw.locator))) return false;
    for (const key of Object.keys(raw)) {
      if (key !== 'hash' && key !== 'kind' && key !== 'locator') return false;
    }
  }
  return true;
}
