/**
 * SOLANA TOKEN ACCOUNTS ON THE PUSH.
 *
 * A token receive into an existing token account names the account, never its owner, so pushing only
 * the owner's own address would miss it. Every watched owner's token accounts are therefore
 * registered on the Solana address-activity webhook too, and a delivery naming one queues the
 * owner's observation: the same `(signature, owner)` pointer the rotating scan queues for that
 * account, so a transaction found both ways is queued once, and the lane re-reads it on both legs
 * before anything mints. A wrong mapping can cost a wasted read, never a mint.
 *
 * WHICH ACCOUNTS, AND WHEN.
 * - On first sight of an owner: its USDC associated token account (derived, so it is watched before
 *   it exists) and every token account it holds (Token and Token-2022, the union of both legs).
 * - Created later: an associated token account is created by a transaction that names its owner,
 *   so that transaction is pushed; the delivery's own token balances name the new account and its
 *   owner, and it is registered while the delivery is handled. The next receive into it is pushed.
 * - Any delivery naming an owner also makes the owner due for a fresh enumeration on the next sync
 *   (finalized, both legs), and every owner is enumerated again at least daily (bounded per run):
 *   that catches the rare account created without naming its owner (a third party initializing an
 *   account for it, or a transferred authority). The rotating scan stays the backup sweep.
 */

import { createHash } from 'crypto';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { base58Decode, base58Encode, isSolanaAddress } from '../external-address/solana-keys';
import { SOLANA_TOKEN_PROGRAM } from '../onchain/solana-economic-discovery';
import { SOLANA_ASSOCIATED_TOKEN_PROGRAM, SOLANA_USDC_MINT_ADDRESS } from './solana-chain-record-derive';

/** token account → the watched owners it was seen under, and whether it is on a webhook yet. */
export const SOLANA_TOKEN_ACCOUNTS_COLLECTION = 'alchemy_solana_token_accounts_v1';
/** owner → when its token accounts are next enumerated. */
export const SOLANA_TOKEN_OWNERS_COLLECTION = 'alchemy_solana_token_owners_v1';
/** Every owner's token accounts are enumerated again at least this often. */
export const SOLANA_OWNER_ENUMERATION_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Owners enumerated per sync run (four RPC reads each: two programs on two legs). */
export const SOLANA_OWNER_ENUMERATIONS_PER_RUN = 300;
/** Pending token accounts registered per sync run. */
export const SOLANA_TOKEN_ACCOUNT_REGISTRATIONS_PER_RUN = 5_000;
/** Token accounts one delivery may name for registration (bounds a delivery's work). */
export const SOLANA_TOKEN_ACCOUNTS_PER_DELIVERY = 64;

const PDA_MARKER = new TextEncoder().encode('ProgramDerivedAddress');

// Ed25519 field arithmetic for the on-curve test Solana's `findProgramAddress` applies
// (curve25519-dalek's `CompressedEdwardsY::decompress`: the y coordinate is the low 255 bits, and the
// point exists when (y² - 1) / (d·y² + 1) is a square mod p).
const P = (1n << 255n) - 19n;
const D = (-121665n * modPow(121666n, P - 2n)) % P;

function mod(a: bigint): bigint {
  const r = a % P;
  return r >= 0n ? r : r + P;
}

function modPow(base: bigint, exp: bigint): bigint {
  let result = 1n;
  let b = ((base % P) + P) % P;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return result;
}

/** Whether 32 bytes decode to a point on the ed25519 curve. */
export function isOnEd25519Curve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i -= 1) y = (y << 8n) | BigInt(bytes[i]);
  y = mod(y & ((1n << 255n) - 1n));
  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  // x = u·v³·(u·v⁷)^((p-5)/8); the point exists when v·x² = ±u.
  const v3 = mod(v * v * v);
  const x = mod(u * v3 * modPow(u * mod(v3 * v3 * v), (P - 5n) / 8n));
  const vx2 = mod(v * x * x);
  return vx2 === u || vx2 === mod(-u);
}

function onCurve(bytes: Uint8Array): boolean {
  return isOnEd25519Curve(bytes);
}

/** Solana's `findProgramAddress`: the highest bump whose hash is off the ed25519 curve. */
export function findProgramAddress(seeds: readonly Uint8Array[], programId: string): string | null {
  const program = base58Decode(programId);
  if (!program || program.length !== 32) return null;
  for (let bump = 255; bump >= 0; bump -= 1) {
    const hash = createHash('sha256');
    for (const seed of seeds) hash.update(seed);
    hash.update(Uint8Array.of(bump));
    hash.update(program);
    hash.update(PDA_MARKER);
    const candidate = new Uint8Array(hash.digest());
    if (!onCurve(candidate)) return base58Encode(candidate);
  }
  return null;
}

/** The associated token account of `owner` for `mint` under `tokenProgram`. */
export function associatedTokenAccount(owner: string, mint: string, tokenProgram: string = SOLANA_TOKEN_PROGRAM): string | null {
  const ownerBytes = base58Decode(owner);
  const mintBytes = base58Decode(mint);
  const programBytes = base58Decode(tokenProgram);
  if (!ownerBytes || !mintBytes || !programBytes) return null;
  if (ownerBytes.length !== 32 || mintBytes.length !== 32 || programBytes.length !== 32) return null;
  return findProgramAddress([ownerBytes, programBytes, mintBytes], SOLANA_ASSOCIATED_TOKEN_PROGRAM);
}

/** The accounts watched for an owner before any read: its USDC associated token account. */
export function derivedTokenAccounts(owner: string): string[] {
  const usdc = associatedTokenAccount(owner, SOLANA_USDC_MINT_ADDRESS, SOLANA_TOKEN_PROGRAM);
  return usdc && usdc !== owner ? [usdc] : [];
}

export interface TokenAccountOwner {
  readonly tokenAccount: string;
  readonly owner: string;
}

function validPair(p: TokenAccountOwner): boolean {
  return isSolanaAddress(p.tokenAccount) && isSolanaAddress(p.owner) && p.tokenAccount !== p.owner;
}

/**
 * Record token account → owner pairs. Returns the token accounts not yet on a webhook (new, or
 * recorded earlier and still pending). The owner is added to the account's owners, never replaced.
 */
export async function recordTokenAccountOwners(
  db: Firestore,
  pairs: readonly TokenAccountOwner[],
  source: 'derived' | 'enumeration' | 'delivery',
  nowMs: number,
): Promise<string[]> {
  const byAccount = new Map<string, Set<string>>();
  for (const p of pairs) {
    if (!validPair(p)) continue;
    const owners = byAccount.get(p.tokenAccount) ?? new Set<string>();
    owners.add(p.owner);
    byAccount.set(p.tokenAccount, owners);
  }
  const accounts = [...byAccount.keys()].sort();
  const pending: string[] = [];
  for (let i = 0; i < accounts.length; i += 300) {
    const chunk = accounts.slice(i, i + 300);
    const refs = chunk.map((a) => db.collection(SOLANA_TOKEN_ACCOUNTS_COLLECTION).doc(a));
    const snaps = await db.getAll(...refs);
    const batch = db.batch();
    let writes = 0;
    snaps.forEach((snap, k) => {
      const account = chunk[k];
      const wanted = [...byAccount.get(account)!];
      const data = snap.exists ? snap.data() as Record<string, unknown> : undefined;
      const known = Array.isArray(data?.owners) ? (data!.owners as unknown[]).filter((o): o is string => typeof o === 'string') : [];
      const registered = data?.registered === true;
      if (!registered) pending.push(account);
      if (snap.exists && wanted.every((o) => known.includes(o))) return;
      batch.set(refs[k], {
        token_account: account,
        owners: FieldValue.arrayUnion(...wanted),
        registered,
        ...(snap.exists ? {} : { first_seen_ms: nowMs, source }),
        updated_at_ms: nowMs,
      }, { merge: true });
      writes += 1;
    });
    if (writes > 0) await batch.commit();
  }
  return pending;
}

/** The recorded owners of each of `accounts` that has any. */
export async function ownersOfTokenAccounts(db: Firestore, accounts: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const list = [...new Set(accounts.filter((a) => isSolanaAddress(a)))];
  for (let i = 0; i < list.length; i += 300) {
    const chunk = list.slice(i, i + 300);
    const snaps = await db.getAll(...chunk.map((a) => db.collection(SOLANA_TOKEN_ACCOUNTS_COLLECTION).doc(a)));
    snaps.forEach((snap, k) => {
      if (!snap.exists) return;
      const owners = (snap.data() as Record<string, unknown>).owners;
      if (!Array.isArray(owners)) return;
      const valid = owners.filter((o): o is string => isSolanaAddress(o) && o !== chunk[k]);
      if (valid.length > 0) out.set(chunk[k], valid);
    });
  }
  return out;
}

/** Mark token accounts as on a webhook. */
export async function markTokenAccountsRegistered(db: Firestore, accounts: readonly string[], nowMs: number): Promise<void> {
  for (let i = 0; i < accounts.length; i += 400) {
    const batch = db.batch();
    for (const a of accounts.slice(i, i + 400)) {
      batch.set(db.collection(SOLANA_TOKEN_ACCOUNTS_COLLECTION).doc(a), { registered: true, registered_at_ms: nowMs }, { merge: true });
    }
    await batch.commit();
  }
}

/** Token accounts recorded but not yet on a webhook, oldest first. */
export async function pendingTokenAccounts(db: Firestore, limit: number): Promise<string[]> {
  const snap = await db.collection(SOLANA_TOKEN_ACCOUNTS_COLLECTION).where('registered', '==', false).limit(limit).get();
  return snap.docs.map((d) => d.id).filter((id) => isSolanaAddress(id)).sort();
}

/**
 * Start watching owners' token accounts: record each owner's derived accounts and make the owner
 * due for an enumeration now. An owner already known keeps its schedule.
 */
export async function seedTokenOwners(db: Firestore, owners: readonly string[], nowMs: number): Promise<number> {
  const list = [...new Set(owners.filter((o) => isSolanaAddress(o)))].sort();
  let seeded = 0;
  for (let i = 0; i < list.length; i += 300) {
    const chunk = list.slice(i, i + 300);
    const refs = chunk.map((o) => db.collection(SOLANA_TOKEN_OWNERS_COLLECTION).doc(o));
    const snaps = await db.getAll(...refs);
    const fresh = chunk.filter((_, k) => !snaps[k].exists);
    if (fresh.length === 0) continue;
    await recordTokenAccountOwners(db, fresh.flatMap((owner) => derivedTokenAccounts(owner).map((tokenAccount) => ({ tokenAccount, owner }))), 'derived', nowMs);
    const batch = db.batch();
    for (const owner of fresh) {
      batch.set(db.collection(SOLANA_TOKEN_OWNERS_COLLECTION).doc(owner), { owner, next_enumeration_at_ms: 0, seeded_at_ms: nowMs });
    }
    await batch.commit();
    seeded += fresh.length;
  }
  return seeded;
}

/** An owner named by a delivery: enumerate it again on the next sync. Only owners already seeded. */
export async function markTokenOwnersDue(db: Firestore, owners: readonly string[], nowMs: number): Promise<void> {
  const list = [...new Set(owners.filter((o) => isSolanaAddress(o)))];
  if (list.length === 0) return;
  const refs = list.map((o) => db.collection(SOLANA_TOKEN_OWNERS_COLLECTION).doc(o));
  const snaps = await db.getAll(...refs);
  const batch = db.batch();
  let writes = 0;
  snaps.forEach((snap, k) => {
    if (!snap.exists) return; // the sync seeds it (and enumerates it at once)
    const next = (snap.data() as Record<string, unknown>).next_enumeration_at_ms;
    if (typeof next === 'number' && next <= nowMs) return;
    batch.set(refs[k], { next_enumeration_at_ms: nowMs, due_since_ms: nowMs }, { merge: true });
    writes += 1;
  });
  if (writes > 0) await batch.commit();
}

/** Owners due for an enumeration, most overdue first. */
export async function dueTokenOwners(db: Firestore, nowMs: number, limit: number): Promise<string[]> {
  const snap = await db.collection(SOLANA_TOKEN_OWNERS_COLLECTION)
    .where('next_enumeration_at_ms', '<=', nowMs).orderBy('next_enumeration_at_ms', 'asc').limit(limit).get();
  return snap.docs.map((d) => d.id).filter((id) => isSolanaAddress(id));
}

export async function markTokenOwnerEnumerated(db: Firestore, owner: string, nowMs: number): Promise<void> {
  await db.collection(SOLANA_TOKEN_OWNERS_COLLECTION).doc(owner).set({
    next_enumeration_at_ms: nowMs + SOLANA_OWNER_ENUMERATION_INTERVAL_MS, enumerated_at_ms: nowMs,
  }, { merge: true });
}

// =============================================================================
// DELIVERY PAYLOAD: token accounts and owners named by a transaction's token balances
// =============================================================================

function firstOf(value: unknown): Record<string, unknown> | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v && typeof v === 'object' ? v as Record<string, unknown> : undefined;
}

function stringKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((k) => (typeof k === 'string' ? k : (k && typeof k === 'object' ? (k as Record<string, unknown>).pubkey : undefined)))
    .map((k) => (typeof k === 'string' ? k : ''));
}

/**
 * The (token account, owner) pairs a pushed Solana transaction's token balances name. The account is
 * the transaction's key at the balance's index: static keys, then loaded writable, then loaded
 * read-only addresses. Accepts the delivery's snake_case fields and the RPC's camelCase ones. A
 * shape it cannot read yields nothing (the next enumeration still finds the account).
 */
export function tokenBalancePairs(item: Record<string, unknown>): TokenAccountOwner[] {
  const tx = firstOf(item.transaction);
  const message = firstOf(tx?.message);
  const meta = firstOf(item.meta ?? tx?.meta);
  if (!message || !meta) return [];
  const loaded = firstOf(meta.loadedAddresses ?? meta.loaded_addresses);
  const keys = [
    ...stringKeys(message.account_keys ?? message.accountKeys),
    ...stringKeys(meta.loaded_writable_addresses ?? loaded?.writable),
    ...stringKeys(meta.loaded_readonly_addresses ?? loaded?.readonly),
  ];
  const balances = [
    ...(Array.isArray(meta.pre_token_balances) ? meta.pre_token_balances : Array.isArray(meta.preTokenBalances) ? meta.preTokenBalances : []),
    ...(Array.isArray(meta.post_token_balances) ? meta.post_token_balances : Array.isArray(meta.postTokenBalances) ? meta.postTokenBalances : []),
  ] as unknown[];
  const out = new Map<string, TokenAccountOwner>();
  for (const raw of balances) {
    if (!raw || typeof raw !== 'object') continue;
    const b = raw as Record<string, unknown>;
    const index = b.account_index ?? b.accountIndex;
    if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= keys.length) continue;
    const pair = { tokenAccount: keys[index as number], owner: typeof b.owner === 'string' ? b.owner : '' };
    if (validPair(pair)) out.set(`${pair.tokenAccount}|${pair.owner}`, pair);
  }
  return [...out.values()];
}
