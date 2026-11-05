/**
 * origin-owner-resolver — the owner-resolver table (, Prompt 3).
 *
 * The ONE thing Provian maintains for independence. An origin's OWNER is the party a PUBLIC
 * AUTHORITY maps its identifier to — on-chain address → that address; DOI → its registrant; domain
 * → the DNS holder; public repo → the repo owner. Owners are PARTIES (canonical strings), not
 * necessarily Provian wallets. This table maps each resolvable `origin_identifier` scheme the SDK
 * emits (`evm:`/`domain:`/`repo:`/`commit:`/`pkg:`/`doi:`) to an owner party; a private/hashed value
 * (`private_*`) is unresolvable BY CONSTRUCTION (only its hash exists); an unrecognized scheme is
 * unresolvable UNTIL a rule is added. Nothing is dropped — an unresolvable origin is still recorded
 * and graph-indexed and simply adds zero to the multiplier until a resolver exists (Prompt 3).
 *
 * A scheme whose owner needs a live lookup Provian does not yet run — a bare commit's repo, a
 * package's publisher — deliberately resolves to `null` here rather than guessing, so the count
 * never inflates on an unproven owner. Adding those lookups is future table growth, purely additive.
 */

import { isSolanaAddress } from '../external-address/solana-keys';

export interface ResolvedOwner {
  /** The canonical owner party, or null when no rule maps this identifier yet. */
  readonly owner: string | null;
  /** True when the identifier is a private/hashed value — independence is unverifiable. */
  readonly privateHashed: boolean;
}

const UNRESOLVABLE: ResolvedOwner = { owner: null, privateHashed: false };
const PRIVATE_HASHED: ResolvedOwner = { owner: null, privateHashed: true };

/** The private-origin type tags (SDK `origin-capture.ts`): value lives only in the hash. */
const PRIVATE_TAGS = new Set([
  'private_file', 'private_url_path', 'private_pkg', 'private_project', 'private_host',
]);

const EVM_RE = /^evm:(0x[0-9a-f]{40})$/;
/** follow-up: a Solana address (base58, case-sensitive — never lowercased). */
const SOLANA_RE = /^solana:([1-9A-HJ-NP-Za-km-z]{32,44})$/;
const DOMAIN_RE = /^domain:([a-z0-9.-]{1,253})$/;
const REPO_RE = /^repo:(.+)$/;
const DOI_RE = /^doi:(10\.\d{2,9})\/.+$/;

/**
 * Registrable-domain reduction (eTLD+1) so subdomains of one holder dedup to one owner and never
 * inflate the count. A small maintained multi-label-suffix set covers the common `x.co.uk` traps;
 * everything else reduces to the last two labels. This is table data, extended as needed.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.jp', 'co.nz',
  'com.br', 'co.in', 'com.cn', 'com.mx', 'co.za', 'com.sg', 'co.kr',
]);

export function registrableDomain(host: string): string {
  const labels = host.split('.').filter((l) => l.length > 0);
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_LABEL_SUFFIXES.has(lastTwo) && labels.length >= 3) {
    return labels.slice(-3).join('.');
  }
  return lastTwo;
}

/**
 * Resolve an `origin_identifier` to its owner party. Pure and deterministic. The rule list IS the
 * maintained table; a scheme absent from it resolves to `null` (recorded, counts zero, never dropped).
 */
export function resolveOriginOwner(originIdentifier: string): ResolvedOwner {
  const id = typeof originIdentifier === 'string' ? originIdentifier.trim() : '';
  if (id.length === 0) return UNRESOLVABLE;

  // Private/hashed values: only the hash exists — independence is unverifiable.
  if (PRIVATE_TAGS.has(id) || id.startsWith('private_')) return PRIVATE_HASHED;

  // on-chain address → that address (the chain is the public authority).
  const evm = EVM_RE.exec(id);
  if (evm) return { owner: `evm:${evm[1]}`, privateHashed: false };
  // A Solana address → that address (the Solana chain is the public authority), exactly as an EVM
  // one. Only the canonical base58 of a 32-byte key; anything else stays unresolvable.
  const solana = SOLANA_RE.exec(id);
  if (solana && isSolanaAddress(solana[1])) return { owner: `solana:${solana[1]}`, privateHashed: false };

  // domain → the DNS/TLS holder (reduced to the registrable domain so subdomains dedup).
  const domain = DOMAIN_RE.exec(id);
  if (domain) return { owner: `domain:${registrableDomain(domain[1])}`, privateHashed: false };

  // DOI → its registrant (the prefix `10.xxxx` is the registrant namespace).
  const doi = DOI_RE.exec(id);
  if (doi) return { owner: `doi-registrant:${doi[1]}`, privateHashed: false };

  // public repo → the repo owner (the account path minus the repo name).
  const repo = REPO_RE.exec(id);
  if (repo) {
    const owner = repoOwnerOf(repo[1]);
    return owner === null ? UNRESOLVABLE : { owner: `repo-owner:${owner}`, privateHashed: false };
  }

  // `commit:<sha>` (owner needs a forge lookup Provian does not run yet) and any unrecognized
  // scheme: recorded, counts zero, resolvable once a rule/lookup is added. Never guessed.
  //
  // Two schemes are resolved ASYNCHRONOUSLY by the orchestrator, not here (this table is pure):
  //   `pe:<pe_id>`   → `signer:<cited PE's actor id>` via `pe-origin-resolver.ts` (§2.1)
  //   `pkg:<coord>`  → `npm-user:<publisher>` via the registry lookup in `pkg-owner-resolver.ts` (§2.11)
  // Both fall through to UNRESOLVABLE here so a caller that skips the async step counts zero.
  return UNRESOLVABLE;
}

/**
 * The owner of a `repo:` value — everything before the repository name (dropping any `@ref`). A
 * bare `owner/repo` → `owner`; a `host/owner/repo` → `host/owner`; a single segment (no repo path)
 * cannot name an owner → null.
 */
function repoOwnerOf(raw: string): string | null {
  const value = raw.split('@')[0].replace(/\/+$/, '');
  const segments = value.split('/').filter((s) => s.length > 0);
  if (segments.length < 2) return null;
  return segments.slice(0, -1).join('/');
}
