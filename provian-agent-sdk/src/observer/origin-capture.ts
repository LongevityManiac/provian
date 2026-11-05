import {privateIdentifierMac} from './origin-privacy';
/**
 * origin-capture — Prompt 2 builders that turn what an observer SAW into
 * `input_origins` entries, honouring the privacy rule.
 *
 * THE PRIVACY RULE (the invariant — do not violate):
 *   - PUBLICLY RESOLVABLE identifiers (DOI, public package coordinate, public
 *     repo/owner/commit, domain, on-chain address) are recorded RESOLVABLY: the
 *     identifier itself is the `origin_identifier`, so the relay can later
 *     resolve its owner for the Prompt 3 independence test. These are public
 *     facts, not private content.
 *   - PRIVATE / sensitive identifiers (internal file paths, private URL paths,
 *     project/client names, anything structural) are recorded as a secret-protected HMAC only:
 *     `origin_identifier` is a non-sensitive TYPE TAG (e.g. `private_file`) and
 *     the identifying content lives ONLY in `hash`. They are not recoverable by guessing without the witness secret — Prompt 3 counts them 0 toward any multiplier — but recorded so the
 *     provenance chain is complete.
 *   - No message text, tool arguments/results content, plaintext paths, or tokens
 *     ever reach `origin_identifier`. Only the hash carries the private value.
 *
 * WITNESSED (Prompt 1b): an origin is `witnessed:true` when a key that is NOT the
 * actor's vouches it crossed the process boundary. On a device observer that
 * voucher is the device's own body-HMAC, so origins an observer plugin captures
 * are stamped with the `observer_device` witness. Artifact-scanned and
 * actor-supplied origins are `witnessed:false` (no witness): provenance and graph
 * input only, zero multiplier contribution.
 *
 * This module is Node-only (the observer daemon runs under Node); it uses
 * `node:crypto`. The normalizer + three-state contract live in
 * `../input-origins.ts` and are environment-neutral — this builder's output is
 * always passed through `normalizeInputOrigins` before it is sealed.
 */
import { createHash } from 'crypto';
import type { InputOrigin, OriginWitness } from '../input-origins';
import type { OriginArgRule, OriginClass } from './origin-rules';

/** Witness type literals (Prompt 2). Documented, not cross-package-bound — the
 * relay stores them verbatim and does not interpret them in Prompt 2. */
export const WITNESS_OBSERVER_DEVICE = 'observer_device';
export const WITNESS_FORGE_WEBHOOK = 'forge_webhook';
export const WITNESS_CHAIN_WATCHER = 'chain_watcher';
export const WITNESS_ORIGIN_OWNER_SIGNATURE = 'origin_owner_signature';

/** Private-origin type tags (the non-sensitive label carried in origin_identifier
 * when the real value is secret-protected). */
export const PRIVATE_FILE = 'private_file';
export const PRIVATE_URL_PATH = 'private_url_path';
export const PRIVATE_PKG = 'private_pkg';
export const PRIVATE_PROJECT = 'private_project';
/** A bare hostname classified as PRIVATE (an internal/unresolvable host — hash
 * only, never counted). Distinct from a `url`, whose domain IS recorded resolvably. */
export const PRIVATE_HOST = 'private_host';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * A witness-FREE origin: `{hash, origin_identifier}` with the privacy
 * classification already applied, but no `witnessed`/`witness` yet. Produced by
 * an extractor that computes the hash at extraction (so no plaintext value
 * propagates) and hands the draft to the observer, which stamps the witness it
 * alone holds (`stampWitness`). The draft NEVER carries the raw private value —
 * only its digest.
 */
export interface OriginDraft {
  readonly hash: string;
  readonly origin_identifier: string;
}

/** A publicly-resolvable draft: the identifier is recorded in the clear (the
 * relay resolves its owner later); the hash is the identifier's own digest. */
export function resolvableDraft(identifier: string): OriginDraft {
  return { hash: `sha256:${sha256Hex(identifier)}`, origin_identifier: identifier };
}

/** A private/sensitive draft: ONLY the hash carries the identifying value; the
 * origin_identifier is a non-sensitive type tag. */
export function privateDraft(typeTag: string, rawValue: string): OriginDraft {
  return { hash: `sha256:${privateIdentifierMac(typeTag,rawValue)}`, origin_identifier: typeTag };
}

/** Attach the voucher to a draft, producing the final entry. A null witness →
 * witnessed:false (actor-supplied / scanned); a witness → witnessed:true. */
export function stampWitness(draft: OriginDraft, witness?: OriginWitness | null): InputOrigin {
  return witness ? { ...draft, witnessed: true, witness } : { ...draft, witnessed: false };
}

/** A publicly-resolvable origin: the identifier is recorded in the clear so its
 * owner can be resolved later; the hash is the identifier's own digest. */
export function resolvableOrigin(identifier: string, witness?: OriginWitness | null): InputOrigin {
  return stampWitness(resolvableDraft(identifier), witness);
}

/** A private / sensitive origin: ONLY the hash carries the identifying value; the
 * origin_identifier is a non-sensitive type tag. */
export function privateOrigin(typeTag: string, rawValue: string, witness?: OriginWitness | null): InputOrigin {
  return stampWitness(privateDraft(typeTag, rawValue), witness);
}

/** Lower-cased host of a URL, or null when it is not parseable / not http(s). */
export function domainOf(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * One external URL → up to two DRAFTS under the privacy rule: the DOMAIN is
 * public (resolvable), the PATH+query is private (hash only, over the full URL so
 * the digest is unique per resource). A URL with no path beyond "/" yields only
 * the domain draft. The plaintext path never leaves — only its digest.
 */
export function urlDrafts(rawUrl: string): OriginDraft[] {
  const out: OriginDraft[] = [];
  const host = domainOf(rawUrl);
  if (host) out.push(resolvableDraft(`domain:${host}`));
  try {
    const u = new URL(rawUrl);
    if (u.pathname && u.pathname !== '/') {
      // credentials embedded in a URL never leave the device — not even
      // inside the path digest. userinfo (user:token@) is removed before hashing;
      // a URL without userinfo hashes byte-identically to before.
      u.username = '';
      u.password = '';
      out.push(privateDraft(PRIVATE_URL_PATH, u.toString()));
    }
  } catch { /* domain-only */ }
  return out;
}

/** URL → origins with a witness attached (convenience for callers holding one). */
export function urlOrigins(rawUrl: string, witness?: OriginWitness | null): InputOrigin[] {
  return urlDrafts(rawUrl).map((d) => stampWitness(d, witness));
}

/** A 40-hex git commit; a `repo`-class value that is one is recorded as `commit:`. */
const COMMIT_HASH_RE = /^[0-9a-f]{40}$/i;

/** The resolvable identifier for a `repo`-class value: `commit:<lc-sha>` for a
 * bare 40-hex commit, else `repo:<value>` (owner/repo, or owner/repo@ref). */
function repoIdentifier(raw: string): string {
  return COMMIT_HASH_RE.test(raw) ? `commit:${raw.toLowerCase()}` : `repo:${raw}`;
}

// --- credentials embedded in URL-shaped repo/package values ----------
//
// A `repo`/`package` argument (and a manifest dependency coordinate) is recorded
// RESOLVABLY (in the clear) under the ruled 09-11 treatment. A value can be
// URL-shaped and carry a credential: a clone URL
// `https://x-access-token:ghp_…@github.com/o/r.git`, a `git+https://user:tok@host/x.git`
// dependency, a tarball `…/x.tgz?token=…`. Such a credential must never leave the
// device — not in the clear and not inside a digest. So before any identifier or
// hash is built, userinfo and the query are STRIPPED from the URL-shaped part (a
// fragment is kept — it is a git ref like `#v1.2.3` — unless it is key=value or
// token-shaped). A bare `git@` (the conventional ssh user, no password) is not a
// credential and is kept, so a clean `git+ssh://git@github.com/o/r.git` and an
// scp-style `git@github.com:o/r.git` are byte-identical. When a token-shaped string
// survives the strip (e.g. inside the path) or the URL does not parse, the value is
// recorded as the class's PRIVATE variant — and the digest is taken over the
// STRIPPED value with token shapes redacted, never over the credential.

/** A URL scheme prefix (`https://`, `git+ssh://`, `ssh://`, …). */
const URL_SCHEME_RE = /[a-z][a-z0-9+.-]*:\/\//i;
/** scp-style `user@host:path` (git), host must look like a DNS name. */
const SCP_STYLE_RE = /^([^@\s/]+)@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}|localhost):(.+)$/;
/** The one userinfo that is a convention, not a credential: `git@`, no password. */
const CONVENTIONAL_GIT_USER = 'git';
/** Token-shaped values (forge / registry / cloud / chat token prefixes). */
const TOKEN_SHAPES = [
  'gh[pousr]_[A-Za-z0-9]{16,}',
  'github_pat_[A-Za-z0-9_]{16,}',
  'glpat-[A-Za-z0-9_-]{16,}',
  'npm_[A-Za-z0-9]{30,}',
  'xox[abprs]-[A-Za-z0-9-]{8,}',
  'AKIA[0-9A-Z]{16}',
  '(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}',
];
const TOKEN_SHAPE_GLOBAL_RE = new RegExp(TOKEN_SHAPES.join('|'), 'gi');
/**
 * Token-shaped strings that must never appear in a resolvable identifier:
 * forge/registry/cloud token prefixes, and credential-named query parameters.
 */
export const CREDENTIAL_SHAPED_RE = new RegExp([
  ...TOKEN_SHAPES,
  '[?&;#](?:access_token|token|auth|authorization|key|api_key|apikey|password|passwd|pwd|secret|sig|signature|x-amz-signature|x-amz-credential|private_token)=',
].join('|'), 'i');

/** Remove userinfo (but a bare `git@`) and the query from one absolute URL; a
 * key=value fragment goes too. Null when unparseable. Clean → byte-identical. */
function stripUrlCredentials(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const conventionalUser = u.username === CONVENTIONAL_GIT_USER && !u.password;
  const dropUser = (u.username !== '' || u.password !== '') && !conventionalUser;
  const dropHash = u.hash.includes('=');
  if (!dropUser && !u.search && !dropHash) return url; // clean: byte-identical
  if (dropUser) { u.username = ''; u.password = ''; }
  u.search = '';
  if (dropHash) u.hash = '';
  return u.toString();
}

/** Regex strip for a URL the parser refused: userinfo (but bare `git@`), then query/fragment. */
function stripUnparseableUrl(url: string): string {
  return url
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)@/i, (_m, scheme: string, user: string) =>
      (user === CONVENTIONAL_GIT_USER ? `${scheme}${user}@` : scheme))
    .replace(/[?#].*$/s, '');
}

export interface StrippedCoordinate {
  /** The value with userinfo/query removed and any surviving token shape redacted. */
  readonly value: string;
  /** True when `value` is safe to record RESOLVABLY; false → hash it private. */
  readonly clean: boolean;
}

/**
 * Strip embedded credentials from a URL-shaped repo/package/dependency value. The
 * returned `value` NEVER contains the credential: it is the resolvable identifier
 * when `clean`, and the only input to the private digest when not. Non-URL values
 * (`owner/repo`, `npm:@scope/lib@1.2.3`, a commit sha) return unchanged and clean.
 */
export function stripCoordinateCredentials(raw: string): StrippedCoordinate {
  let value = raw;
  let clean = true;
  const m = URL_SCHEME_RE.exec(raw);
  if (m) {
    // The URL may be the whole value or follow a spec prefix (`name@git+https://…`).
    const prefix = raw.slice(0, m.index);
    const urlPart = raw.slice(m.index);
    const stripped = stripUrlCredentials(urlPart);
    if (stripped === null) {
      // Unparseable URL: safe only if nothing credential-bearing could be in it.
      if (/[@?#]/.test(urlPart)) clean = false;
      value = prefix + stripUnparseableUrl(urlPart);
    } else {
      value = prefix + stripped;
    }
  } else {
    const scp = SCP_STYLE_RE.exec(raw);
    // Drop a non-conventional scp user (`tok@host:path`); `git@host:path` stays.
    if (scp && scp[1] !== CONVENTIONAL_GIT_USER) value = `${scp[2]}:${scp[3]}`;
  }
  if (CREDENTIAL_SHAPED_RE.test(value)) {
    clean = false;
    value = value.replace(TOKEN_SHAPE_GLOBAL_RE, '[redacted]').replace(/[?#].*$/s, '');
  }
  return { value, clean };
}

/**
 * The value of a URL-shaped repo/package argument with any embedded credential
 * removed, or null when it cannot be made safe (→ the caller hashes it private).
 */
export function credentialFreeCoordinate(raw: string): string | null {
  const s = stripCoordinateCredentials(raw);
  return s.clean ? s.value : null;
}

/**
 * A package/dependency coordinate → ONE draft: the RAW value (the spec / range the
 * user wrote) is stripped FIRST and only then joined to its class prefix
 * (`pkg:`, `npm:<name>@`), so the prefix can never be mistaken for part of the
 * value (an scp-style `git@github.com:o/r.git` must keep its `git@`, a
 * `tok@github.com:o/r` must lose only `tok@`). Resolvable when clean, else
 * `private_pkg` hashed over the prefixed STRIPPED value. The one seam for
 * manifest dependency coordinates (GitPlugin, report-pe) and the catalog/schema
 * `package` class.
 */
export function packageCoordinateDraft(prefix: string, value: string): OriginDraft {
  const s = stripCoordinateCredentials(value);
  return s.clean ? resolvableDraft(`${prefix}${s.value}`) : privateDraft(PRIVATE_PKG, `${prefix}${s.value}`);
}

/** `packageCoordinateDraft` with the witness stamped. */
export function packageCoordinateOrigin(prefix: string, value: string, witness?: OriginWitness | null): InputOrigin {
  return stampWitness(packageCoordinateDraft(prefix, value), witness);
}

/**
 * One `package.json` dependency → its origin: `npm:<name>@<range>` (or
 * `npm:<name>` with no range), the RANGE stripped of credentials before the
 * coordinate is built. Package names cannot carry credentials; ranges can.
 */
export function npmDependencyOrigin(name: string, range: string | null, witness?: OriginWitness | null): InputOrigin {
  return range !== null && range.length > 0
    ? packageCoordinateOrigin(`npm:${name}@`, range, witness)
    : resolvableOrigin(`npm:${name}`, witness);
}

/**
 * The FIVE origin classes (close, the operator ), each carrying its exact
 * 09-11 treatment. The no-plaintext-seam invariant is enforced PER CLASS:
 * - `file` / `host` → PRIVATE (hash only): the raw value lives ONLY in the
 * digest; the origin_identifier is a non-sensitive type tag. Counted 0.
 * - `url` → the public DOMAIN resolvable + the path/query hashed (userinfo
 * removed before hashing,).
 * - `package` / `repo` → the public coordinate recorded RESOLVABLY, with any
 * embedded credential (userinfo, query) stripped first; a value whose
 * credential cannot be stripped is hashed as `private_pkg` / `private_project`
 * over the STRIPPED, token-redacted value.
 * An unrecognized class yields NO draft (skipped, never plaintext) —
 * defense-in-depth for a rule that somehow bypassed catalog sanitization.
 */
function privacyClassDrafts(cls: OriginClass, raw: string): OriginDraft[] {
  switch (cls) {
    case 'file': return [privateDraft(PRIVATE_FILE, raw)];
    case 'host': return [privateDraft(PRIVATE_HOST, raw)];
    case 'url': return urlDrafts(raw);
    case 'package': return [packageCoordinateDraft('pkg:', raw)];
    case 'repo': {
      const s = stripCoordinateCredentials(raw);
      return [s.clean ? resolvableDraft(repoIdentifier(s.value)) : privateDraft(PRIVATE_PROJECT, s.value)];
    }
    default: return [];
  }
}

/**
 * Map ONE tool call's arguments to origin DRAFTS, reading ONLY the narrow,
 * known argument keys whose values are safe to classify, and hashing every
 * private value at this point so no plaintext argument ever propagates. This is
 * the privacy-critical seam for the transcript watcher: it is deliberately a
 * tiny allowlist, NOT a general argument scan.
 * - file tools (Read/Write/Edit/MultiEdit/NotebookEdit) → `file_path` /
 * `notebook_path` / `path` → PRIVATE `private_file` (hash only). Claude Code
 * names its arg `file_path`; OpenClaw's `read`/`write`/`edit` tools name it
 * `path` the `path` key is read ONLY under a file-tool name (so a non-file
 * tool that happens to carry a `path` contributes nothing), and the value is
 * hashed, so no plaintext path ever propagates regardless of the key.
 * - web tools (WebFetch/WebSearch/fetch) → `url` → DOMAIN resolvable + PATH
 * private.
 * Every other tool (Bash, OpenClaw `exec`, Grep, Glob, …) contributes NO origin —
 * their arguments are free-form and the most sensitive, so they are never read here.
 *
 *, five classes — MACHINE-LOCAL RULES. The validated local description
 * may teach this seam how a harness Provian never shipped code for names its
 * external-artifact arguments, via `localRules`. Those rules are ADDITIVE (they
 * run after the built-in allowlist and are deduped against it) and route a value
 * into ONLY the five privacy-safe classes (`privacyClassDrafts`): `file`/`host`
 * secret-protected, `url` domain-resolvable + path-hashed, `package`/`repo` resolvable.
 * There is deliberately no class that emits plaintext, and the two private
 * classes hash on device — so a local rule cannot widen what leaves the device;
 * the plaintext value never escapes this function under a local rule any more
 * than under the built-ins.
 */
export function toolInputOriginDrafts(
  toolName: string,
  input: unknown,
  localRules?: readonly OriginArgRule[],
): OriginDraft[] {
  if (typeof toolName !== 'string' || input === null || typeof input !== 'object') return [];
  const args = input as Record<string, unknown>;
  const name = toolName.toLowerCase();
  const out: OriginDraft[] = [];
  const filePath = typeof args.file_path === 'string' ? args.file_path
    : typeof args.notebook_path === 'string' ? args.notebook_path
    : typeof args.path === 'string' ? args.path
    : null;
  const url = typeof args.url === 'string' ? args.url : null;
  if (/^(read|write|edit|multiedit|notebookedit)$/.test(name) && filePath) {
    out.push(privateDraft(PRIVATE_FILE, filePath));
  }
  if (/^(webfetch|websearch|fetch)$/.test(name) && url) {
    out.push(...urlDrafts(url));
  }
  if (localRules && localRules.length > 0) {
    const seen = new Set(out.map((d) => `${d.origin_identifier}|${d.hash}`));
    for (const rule of localRules) {
      if (!rule || !Array.isArray(rule.tools)) continue;
      if (!rule.tools.some((t) => typeof t === 'string' && t.toLowerCase() === name)) continue;
      const raw = args[rule.key];
      if (typeof raw !== 'string' || raw.length === 0) continue;
      // The class is one of the five privacy-safe seams (parseProgramDescription drops any
      // other); `privacyClassDrafts` routes each to its 09-11 treatment and yields
      // nothing for an unrecognized class, so a local rule can never emit plaintext.
      const drafts = privacyClassDrafts(rule.class, raw);
      for (const d of drafts) {
        const key = `${d.origin_identifier}|${d.hash}`;
        if (!seen.has(key)) { seen.add(key); out.push(d); }
      }
    }
  }
  return out;
}

/**
 * Classify ONE tool parameter to an origin class from its SCHEMA (type/format)
 * and NAME — generic and HARNESS-FREE. A url/uri-typed or
 * url-named parameter → `url`; a path/file-named → `file`; repo/package/host
 * likewise. Reads ONLY the parameter name + the structural type/format — never a
 * description or any value content. Returns null when the parameter bears no
 * external-artifact identifier. This needs NO catalog entry; a local description
 * rule (`toolInputOriginDrafts`' `localRules`) only ADDS precision for a known
 * harness, and is never a prerequisite for counting.
 */
export function classifyParamOriginClass(
  paramName: string,
  schema?: { type?: string; format?: string } | null,
): OriginClass | null {
  if (typeof paramName !== 'string' || paramName.length === 0) return null;
  const name = paramName.toLowerCase();
  const fmt = (schema?.format ?? '').toLowerCase();
  const word = (re: RegExp): boolean => re.test(name);
  // url/uri-TYPED (JSON-Schema format) OR url-NAMED → the counted domain (path hashed).
  if (fmt === 'uri' || fmt === 'url' || fmt === 'uri-reference'
    || word(/(^|[_-])(url|uri|link|href|endpoint)s?([_-]|$)/)) return 'url';
  if (word(/(^|[_-])(repo|repository)s?([_-]|$)/)) return 'repo';
  if (word(/(^|[_-])(package|pkg|dependency|module)s?([_-]|$)/)) return 'package';
  if (word(/(^|[_-])(path|file|filepath|filename|notebook_path)s?([_-]|$)/)) return 'file';
  if (word(/(^|[_-])(host|hostname|server|domain)s?([_-]|$)/)) return 'host';
  return null;
}

/**
 * SCHEMA-DRIVEN origin drafts for one tool call: classify EVERY string argument
 * by its parameter schema and route it through the SAME five
 * privacy-safe classes as the built-in allowlist and catalog rules. So a fetch
 * tool of ANY name, with a url-typed/url-named parameter, yields a counted origin
 * with no catalog entry. Private classes (file/host) are hashed on device; a
 * non-URL value in a url-class parameter yields nothing (`urlDrafts` no-ops).
 * ADDITIVE — the caller dedups these against the built-in + catalog drafts.
 */
export function schemaOriginDrafts(
  input: unknown,
  paramSchemas?: ReadonlyMap<string, { type?: string; format?: string }> | null,
): OriginDraft[] {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return [];
  const out: OriginDraft[] = [];
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value !== 'string' || value.length === 0) continue;
    const cls = classifyParamOriginClass(key, paramSchemas?.get(key) ?? null);
    if (!cls) continue;
    out.push(...privacyClassDrafts(cls, value));
  }
  return out;
}

const HTTP_URL_RE = /\bhttps?:\/\/[^\s"'<>)\]}]+/gi;
const DOI_RE = /\b10\.\d{4,9}\/[^\s"'<>)\]}]+/gi;
const EVM_ADDR_RE = /\b0x[0-9a-fA-F]{40}\b/g;
const COMMIT_SHA_RE = /\b[0-9a-f]{40}\b/g;

/**
 * Artifact-scan: mine a produced text artifact (a commit message, an output
 * document, a log) for identifiers it CONTAINS — DOIs, on-chain addresses,
 * domains, commit hashes. These are `witnessed:false` (no non-actor key vouched
 * they crossed a boundary — the actor's own artifact merely mentions them):
 * provenance + Prompt-3 graph input, zero multiplier contribution. Public
 * identifiers are recorded resolvably; nothing private is scanned out (a scan
 * never emits plaintext paths).
 */
export function artifactScanOrigins(text: string): InputOrigin[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const seen = new Set<string>();
  const out: InputOrigin[] = [];
  const add = (o: InputOrigin): void => {
    if (seen.has(o.origin_identifier + '|' + o.hash)) return;
    seen.add(o.origin_identifier + '|' + o.hash);
    out.push(o);
  };
  for (const m of text.matchAll(DOI_RE)) add(resolvableOrigin(`doi:${m[0]}`));
  for (const m of text.matchAll(EVM_ADDR_RE)) add(resolvableOrigin(`evm:${m[0].toLowerCase()}`));
  for (const m of text.matchAll(HTTP_URL_RE)) {
    const host = domainOf(m[0]);
    if (host) add(resolvableOrigin(`domain:${host}`));
  }
  for (const m of text.matchAll(COMMIT_SHA_RE)) {
    // A 40-hex that is not an address (addresses are 0x-prefixed, excluded above).
    add(resolvableOrigin(`commit:${m[0].toLowerCase()}`));
  }
  return out;
}

/**
 * Union two `input_origins` lists, dedup by (origin_identifier, hash), keeping
 * the witnessed-true variant when the same origin appears both ways, and capping
 * at the 64-entry bloat guard. Used to carry the UNION of every witness's origins
 * onto the PE that lands the mint for one act (the order-independence invariant):
 * locally when OTel and transcript describe one tool turn, and on the backend
 * when a device coding_session and a forge webhook witness one commit. Never
 * mutates its inputs.
 */
export function mergeInputOrigins(
  a: InputOrigin[] | null | undefined,
  b: InputOrigin[] | null | undefined,
): InputOrigin[] {
  const byKey = new Map<string, InputOrigin>();
  for (const o of [...(a ?? []), ...(b ?? [])]) {
    if (!o || typeof o.hash !== 'string' || typeof o.origin_identifier !== 'string') continue;
    const key = `${o.origin_identifier}|${o.hash}`;
    const existing = byKey.get(key);
    // Prefer the witnessed-true variant (a richer provenance claim) on collision.
    if (!existing || (o.witnessed && !existing.witnessed)) byKey.set(key, o);
  }
  return Array.from(byKey.values()).slice(0, 64);
}

/**
 * Best-effort `observer_device` witness for origins a device plugin captured.
 * The identity is the registered device id; the tier mirrors the device's own
 * registration (agent devices are forced `software` server-side; a human Mac
 * Secure-Enclave CLI is `hardware_partial`; everything else `software`).
 *
 * Prompt 2 is zero-mint-effect, so the money path never reads this tier (proven
 * in the run log: a claimed hardware_full witness did not move a software
 * multiplier). Prompt 3, which prices witnesses, is where the relay must become
 * authoritative on the tier for an `observer_device` witness. Returns null when
 * there is no device id — an unwitnessed origin is the honest fallback.
 */
export function observerDeviceWitness(
  deviceId: string | null | undefined,
  ownerType: 'human' | 'agent' | undefined,
  signingMethod: string | null | undefined,
): OriginWitness | null {
  if (!deviceId) return null;
  let tier = 'software';
  if (ownerType !== 'agent' && typeof signingMethod === 'string'
    && /secure_enclave|strongbox|hardware/i.test(signingMethod)) {
    tier = 'hardware_partial';
  }
  return { type: WITNESS_OBSERVER_DEVICE, identity: deviceId, attestation_tier: tier };
}
