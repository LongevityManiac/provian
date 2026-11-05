import {privateIdentifierMac} from './origin-privacy';
/**
 * origin-capture (backend) — Prompt 2 builders that turn what a SERVER-SIDE
 * observer witnessed into `input_origins` entries, honouring the privacy rule.
 * Mirror of the SDK copy (`provian-agent-sdk/src/observer/origin-capture.ts`);
 * the private-origin type tags and witness-type literals are kept byte-identical
 * across the packages by `origin-capture-parity.test.ts`.
 *
 * THE PRIVACY RULE: publicly-resolvable identifiers (on-chain address, public
 * repo/owner/commit, domain, DOI, package coordinate) are recorded RESOLVABLY
 * (the identifier itself is the origin_identifier); private/sensitive identifiers
 * (URL paths, internal structure) are recorded as a secret-protected HMAC only with a
 * non-sensitive type tag as the origin_identifier. No private plaintext ever
 * reaches origin_identifier.
 *
 * WITNESSED (Prompt 1b): server-side observers are relay-witnessed — a chain
 * watcher's origins are `chain_watcher` (the on-chain fact is verified by the
 * watcher / tx-verifier), a forge webhook's are `forge_webhook` (HMAC-verified).
 * Both are a key that is NOT the actor's, so they are `witnessed:true`. The
 * normalizer always finalizes the output; these builders only pre-shape it.
 */
import { createHash } from 'crypto';
import type { InputOrigin, OriginWitness } from './input-origins';

/** Witness type literals (Prompt 2) — kept identical to the SDK/app copies. */
export const WITNESS_OBSERVER_DEVICE = 'observer_device';
export const WITNESS_FORGE_WEBHOOK = 'forge_webhook';
export const WITNESS_CHAIN_WATCHER = 'chain_watcher';
export const WITNESS_ORIGIN_OWNER_SIGNATURE = 'origin_owner_signature';

/** Private-origin type tags (the non-sensitive label when the value is secret-protected). */
export const PRIVATE_FILE = 'private_file';
export const PRIVATE_URL_PATH = 'private_url_path';
export const PRIVATE_PKG = 'private_pkg';
export const PRIVATE_PROJECT = 'private_project';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** A publicly-resolvable origin: identifier recorded in the clear; hash is its digest. */
export function resolvableOrigin(identifier: string, witness?: OriginWitness | null): InputOrigin {
  const base = { hash: `sha256:${sha256Hex(identifier)}`, origin_identifier: identifier };
  return witness ? { ...base, witnessed: true, witness } : { ...base, witnessed: false };
}

/** A private origin: ONLY the hash carries the value; origin_identifier is a type tag. */
export function privateOrigin(typeTag: string, rawValue: string, witness?: OriginWitness | null): InputOrigin {
  const base = { hash: `sha256:${privateIdentifierMac(typeTag,rawValue)}`, origin_identifier: typeTag };
  return witness ? { ...base, witnessed: true, witness } : { ...base, witnessed: false };
}

/** Lower-cased host of an http(s) URL, or null. */
export function domainOf(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** One URL → domain (resolvable) + path (private hash over the full URL). */
export function urlOrigins(rawUrl: string, witness?: OriginWitness | null): InputOrigin[] {
  const out: InputOrigin[] = [];
  const host = domainOf(rawUrl);
  if (host) out.push(resolvableOrigin(`domain:${host}`, witness));
  try {
    const u = new URL(rawUrl);
    // userinfo (user:token@) never enters even the path digest.
    u.username = '';
    u.password = '';
    if (u.pathname && u.pathname !== '/') out.push(privateOrigin(PRIVATE_URL_PATH, u.toString(), witness));
  } catch { /* domain-only */ }
  return out;
}

/** The relay-witnessed `chain_watcher` witness (a chain-verified observation). */
export function chainWatcherWitness(identity: string): OriginWitness {
  return { type: WITNESS_CHAIN_WATCHER, identity };
}

/** The relay-witnessed `forge_webhook` witness (an HMAC-verified webhook). */
export function forgeWebhookWitness(identity: string): OriginWitness {
  return { type: WITNESS_FORGE_WEBHOOK, identity };
}

/**
 * Union two `input_origins` lists, dedup by (origin_identifier, hash), keeping
 * the witnessed-true variant on collision, capped at 64. Used for the
 * order-independence invariant: the PE that lands the mint for one act carries
 * the union of every witness's origins (the commit device↔forge takeover). Never
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
    if (!existing || (o.witnessed && !existing.witnessed)) byKey.set(key, o);
  }
  return Array.from(byKey.values()).slice(0, 64);
}
