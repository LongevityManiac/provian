/**
 * PUSH DISCOVERY ON ARBITRUM ONE, OP MAINNET AND SOLANA: Alchemy address-activity webhooks.
 *
 * The rotating scans (`chain-record-multichain-scan.ts`, the Solana lane's signature scan) visit a
 * bounded slice of the watched addresses per run, so at scale each address waits days between
 * visits. Here Alchemy pushes instead: every watched address is registered on an address-activity
 * webhook per network, and Alchemy calls the relay when one sends or receives. The rotating scans
 * keep running unchanged as the backup sweep.
 *
 * A PUSH IS A POINTER, NEVER EVIDENCE. A delivery only names a transaction. For each transfer into
 * or out of a watched address it queues exactly the pointer the scan would have queued — the same
 * observation document, through the same `enqueueChainRecordObservation` /
 * `enqueueSolanaChainRecordObservation`, keyed the same way, so a transaction the scan and the push
 * both find is queued once. The lane then re-reads the whole transaction through that chain's two
 * operator-bound legs at finality, derives the act from what both agree on, and emits through the
 * unchanged fences. A forged or wrong delivery can cost a wasted read, never a mint; and a
 * delivery is accepted only under the webhook's own HMAC signature.
 *
 * WHO IS REGISTERED.
 * - Arbitrum One and OP Mainnet: every address in the watch registry (`watch_registry_v1`). The
 *   registry is add-only, so registration is too; a delivery for an address that no longer resolves
 *   to a watched wallet (a test wallet, a contract-proven address) queues nothing, exactly as the
 *   scan's resolver skips it.
 * - Solana: every address in `solana_proven_addresses`, and every token account each one holds
 *   (`address-activity-solana-tokens.ts`: a token receive names the account, not its owner). A
 *   delivery is matched against that collection by document id, directly or through a registered
 *   token account's recorded owner, so an address whose proof was removed queues nothing.
 *
 * SYNC. Each run (the chain-record auxiliary job) registers the addresses recorded since the last
 * run (with a 15-minute overlap for transactions that committed late), checking a membership
 * document per (network, address) so nothing is registered twice. Addresses fill webhooks in
 * order, `ADDRESS_ACTIVITY_WEBHOOK_CAPACITY` per webhook (Alchemy's limit is 100,000), and a new
 * webhook is created when every existing one is full. A run that does not finish keeps its cursor:
 * the next run continues, and the membership documents keep it from repeating work.
 */

import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { enqueueChainRecordObservation } from './chain-record-watcher';
import { resolveMultichainEntry } from './chain-record-multichain-scan';
import { NATIVE_WALLET_ADDRESS_INDEX_COLLECTION, nativeWalletAddressIndexId } from './native-wallet-registration';
import { readWatchRegistry, type WatchRegistryKind } from './watch-registry';
import { enqueueSolanaChainRecordObservation } from './solana-chain-record-lane';
import { SOLANA_PROVEN_ADDRESSES_COLLECTION, isSolanaProvenAddressRecord } from '../external-address/solana-link';
import { isSolanaAddress, isSolanaSignature } from '../external-address/solana-keys';
import { buildSolanaRpcLegs, readSolanaTokenAccountsUnion } from '../onchain/solana-economic-discovery';
import {
  SOLANA_OWNER_ENUMERATIONS_PER_RUN,
  SOLANA_TOKEN_ACCOUNTS_PER_DELIVERY,
  SOLANA_TOKEN_ACCOUNT_REGISTRATIONS_PER_RUN,
  dueTokenOwners,
  markTokenAccountsRegistered,
  markTokenOwnerEnumerated,
  markTokenOwnersDue,
  ownersOfTokenAccounts,
  pendingTokenAccounts,
  recordTokenAccountOwners,
  seedTokenOwners,
  tokenBalancePairs,
  type TokenAccountOwner,
} from './address-activity-solana-tokens';

export const ADDRESS_ACTIVITY_STATE_COLLECTION = 'alchemy_address_activity_v1';
export const ADDRESS_ACTIVITY_MEMBERS_COLLECTION = 'alchemy_address_activity_members_v1';
/** Addresses per webhook before the next one is created (Alchemy's limit is 100,000). */
export const ADDRESS_ACTIVITY_WEBHOOK_CAPACITY = 95_000;
/** Addresses per Alchemy update call (the API's limit is 500). */
export const ADDRESS_ACTIVITY_UPDATE_CHUNK = 500;
/** Addresses registered per run (bounds one run's time; the next run continues). */
export const ADDRESS_ACTIVITY_MAX_ADDS_PER_RUN = 20_000;
/** A registry entry or proof recorded this long before the last sync's start is checked again. */
export const ADDRESS_ACTIVITY_SYNC_OVERLAP_MS = 15 * 60 * 1000;
/** A delivery names at most this many candidate Solana accounts per transaction (bounds reads). */
const MAX_SOLANA_CANDIDATES_PER_TRANSACTION = 128;
/** Activities read from one EVM delivery (bounds reads; Alchemy batches a handful per call). */
const MAX_EVM_ACTIVITIES_PER_DELIVERY = 1_000;
/** A webhook id unknown to the cache refreshes the list at most this often (a forged id cannot amplify). */
const SIGNING_KEY_REFRESH_MIN_MS = 60 * 1000;
const SIGNING_KEY_CACHE_MS = 10 * 60 * 1000;

export type AddressActivityNetwork = 'ARB_MAINNET' | 'OPT_MAINNET' | 'SOLANA_MAINNET';
export const ADDRESS_ACTIVITY_NETWORKS: readonly AddressActivityNetwork[] = Object.freeze(['ARB_MAINNET', 'OPT_MAINNET', 'SOLANA_MAINNET']);
const EVM_CHAIN_IDS: Readonly<Record<'ARB_MAINNET' | 'OPT_MAINNET', 42161 | 10>> = Object.freeze({ ARB_MAINNET: 42161, OPT_MAINNET: 10 });
// The scan's categories (native transfers and ERC-20 transfers). The address-activity webhook labels
// an ERC-20 transfer "token" (its documented payloads); "erc20" is accepted as the same thing.
const EVM_CATEGORIES: ReadonlySet<string> = new Set(['external', 'token', 'erc20']);

const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
const EVM_HASH = /^0x[0-9a-f]{64}$/;

export interface AlchemyWebhook {
  readonly id: string;
  readonly network: string;
  readonly signingKey: string;
  readonly url: string;
  readonly isActive: boolean;
  readonly type: string;
}

/** Alchemy's webhook management API (a fake in tests). */
export interface AlchemyNotifyApi {
  listWebhooks(): Promise<readonly AlchemyWebhook[]>;
  createWebhook(input: { readonly network: AddressActivityNetwork; readonly url: string; readonly name: string; readonly addresses: readonly string[] }): Promise<AlchemyWebhook>;
  addAddresses(webhookId: string, addresses: readonly string[]): Promise<void>;
}

type Env = Record<string, string | undefined>;

export function addressActivityWebhookUrl(env: Env = process.env): string | null {
  const url = env.ALCHEMY_ADDRESS_ACTIVITY_WEBHOOK_URL?.trim();
  return url && /^https:\/\/[^\s]+$/.test(url) ? url : null;
}

// =============================================================================
// MANAGEMENT API (production)
// =============================================================================

const NOTIFY_BASE = 'https://dashboard.alchemy.com/api';

function asWebhook(raw: unknown): AlchemyWebhook | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.network !== 'string' || typeof r.signing_key !== 'string') return null;
  return {
    id: r.id,
    network: r.network,
    signingKey: r.signing_key,
    url: typeof r.webhook_url === 'string' ? r.webhook_url : '',
    isActive: r.is_active !== false,
    type: typeof r.webhook_type === 'string' ? r.webhook_type : '',
  };
}

export function buildAlchemyNotifyApi(
  env: Env = process.env,
  fetchImpl: typeof fetch = fetch,
): AlchemyNotifyApi | null {
  const token = env.ALCHEMY_NOTIFY_AUTH_TOKEN?.trim();
  // The secret exists before the real token is staged; a placeholder (anything this short) is unset.
  if (!token || token.length < 16) return null;
  const call = async (method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<unknown> => {
    const res = await fetchImpl(`${NOTIFY_BASE}/${path}`, {
      method,
      headers: { 'X-Alchemy-Token': token, 'content-type': 'application/json', accept: 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`alchemy_notify_http_${res.status}:${path.split('?')[0]}`);
    const text = await res.text();
    return text ? JSON.parse(text) as unknown : {};
  };
  return {
    listWebhooks: async () => {
      const reply = await call('GET', 'team-webhooks') as { data?: unknown };
      if (!Array.isArray(reply.data)) throw new Error('alchemy_notify_list_invalid');
      return reply.data.map(asWebhook).filter((w): w is AlchemyWebhook => w !== null);
    },
    createWebhook: async ({ network, url, name, addresses }) => {
      const reply = await call('POST', 'create-webhook', {
        network, webhook_type: 'ADDRESS_ACTIVITY', webhook_url: url, name, addresses: [...addresses],
      }) as { data?: unknown };
      const created = asWebhook({ ...(reply.data as Record<string, unknown> | undefined), network, webhook_url: url });
      if (!created) throw new Error('alchemy_notify_create_invalid');
      return created;
    },
    addAddresses: async (webhookId, addresses) => {
      await call('PATCH', 'update-webhook-addresses', {
        webhook_id: webhookId, addresses_to_add: [...addresses], addresses_to_remove: [],
      });
    },
  };
}

// =============================================================================
// SYNC
// =============================================================================

interface WebhookSlot { readonly id: string; count: number }
interface NetworkState { webhooks: WebhookSlot[]; synced_through_ms: number | null }

function stateRef(db: Firestore, network: AddressActivityNetwork) {
  return db.collection(ADDRESS_ACTIVITY_STATE_COLLECTION).doc(`state_${network}`);
}

function memberId(network: AddressActivityNetwork, address: string): string {
  return `${network}_${address}`;
}

function parseState(raw: Record<string, unknown> | undefined): NetworkState {
  const webhooks: WebhookSlot[] = [];
  if (Array.isArray(raw?.webhooks)) {
    for (const w of raw.webhooks as unknown[]) {
      const r = w as Record<string, unknown>;
      if (r && typeof r.id === 'string' && Number.isSafeInteger(r.count) && (r.count as number) >= 0) {
        webhooks.push({ id: r.id, count: r.count as number });
      } else {
        throw new Error('address_activity_state_invalid');
      }
    }
  }
  const through = raw?.synced_through_ms;
  return { webhooks, synced_through_ms: Number.isSafeInteger(through) ? through as number : null };
}

interface NetworkSyncReport {
  candidates: number;
  added: number;
  webhooks: number;
  complete: boolean;
  error?: string;
  token_accounts?: SolanaTokenSyncReport;
}

export interface AddressActivitySyncReport {
  skipped?: string;
  networks: Record<string, NetworkSyncReport>;
}

export interface AddressActivitySyncDeps {
  readonly db: Firestore;
  readonly api: AlchemyNotifyApi | null;
  readonly webhookUrl: string | null;
  /** Registry addresses recorded at or after `sinceMs` (all when null), EVM lowercase. */
  readonly evmCandidates: (sinceMs: number | null) => Promise<readonly string[]>;
  /** Solana proven addresses proven at or after `sinceMs` (all when null). */
  readonly solanaCandidates: (sinceMs: number | null) => Promise<readonly string[]>;
  /** Every token account a Solana owner holds (both legs); null when the legs are not configured. */
  readonly solanaTokenAccounts: ((owner: string) => Promise<readonly string[]>) | null;
  readonly now?: () => number;
  /** Addresses per webhook (tests); defaults to `ADDRESS_ACTIVITY_WEBHOOK_CAPACITY`. */
  readonly capacity?: number;
}

async function missingMembers(db: Firestore, network: AddressActivityNetwork, addresses: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < addresses.length; i += 300) {
    const chunk = addresses.slice(i, i + 300);
    const snaps = await db.getAll(...chunk.map((a) => db.collection(ADDRESS_ACTIVITY_MEMBERS_COLLECTION).doc(memberId(network, a))));
    snaps.forEach((snap, k) => { if (!snap.exists) out.push(chunk[k]); });
  }
  return out;
}

async function recordMembers(
  db: Firestore,
  network: AddressActivityNetwork,
  webhookId: string,
  addresses: readonly string[],
  nowMs: number,
): Promise<void> {
  for (let i = 0; i < addresses.length; i += 400) {
    const batch = db.batch();
    for (const address of addresses.slice(i, i + 400)) {
      batch.set(db.collection(ADDRESS_ACTIVITY_MEMBERS_COLLECTION).doc(memberId(network, address)),
        { network, address, webhook_id: webhookId, added_at_ms: nowMs });
    }
    await batch.commit();
  }
}

/**
 * Room on a network's webhooks, reserved transactionally, so the sync and a delivery that registers
 * a new token account never overwrite each other's counts. Returns the webhook and how many
 * addresses it takes, or null when every webhook is full. A reservation whose add then fails stays
 * counted: the count only ever overstates, and the capacity is below Alchemy's limit.
 */
async function reserveWebhookRoom(
  db: Firestore,
  network: AddressActivityNetwork,
  want: number,
  capacity: number,
  nowMs: number,
): Promise<{ readonly id: string; readonly take: number } | null> {
  const ref = stateRef(db, network);
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    const state = parseState(snap.exists ? snap.data() as Record<string, unknown> : undefined);
    const slot = state.webhooks.find((w) => w.count < capacity);
    if (!slot) return null;
    const take = Math.min(want, capacity - slot.count);
    if (take <= 0) return null; // never a zero-size reservation (the caller would not advance)
    slot.count += take;
    txn.set(ref, { webhooks: state.webhooks.map((w) => ({ id: w.id, count: w.count })), updated_at_ms: nowMs }, { merge: true });
    return { id: slot.id, take };
  });
}

/** Give back room reserved for an add that failed, so a failed call never inflates the count. */
async function releaseWebhookRoom(db: Firestore, network: AddressActivityNetwork, id: string, take: number, nowMs: number): Promise<void> {
  const ref = stateRef(db, network);
  await db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    const state = parseState(snap.exists ? snap.data() as Record<string, unknown> : undefined);
    const slot = state.webhooks.find((w) => w.id === id);
    if (!slot) return;
    slot.count = Math.max(0, slot.count - take);
    txn.set(ref, { webhooks: state.webhooks.map((w) => ({ id: w.id, count: w.count })), updated_at_ms: nowMs }, { merge: true });
  });
}

async function appendWebhook(db: Firestore, network: AddressActivityNetwork, id: string, count: number, nowMs: number): Promise<number> {
  const ref = stateRef(db, network);
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    const state = parseState(snap.exists ? snap.data() as Record<string, unknown> : undefined);
    state.webhooks.push({ id, count });
    txn.set(ref, { webhooks: state.webhooks.map((w) => ({ id: w.id, count: w.count })), updated_at_ms: nowMs }, { merge: true });
    return state.webhooks.length;
  });
}

/**
 * Put `addresses` (none of them members yet) on the network's webhooks, filling in order. Only the
 * sync creates a webhook (`mayCreate`); a delivery that finds every webhook full leaves the rest
 * for the sync. Returns how many were added and whether all were.
 */
async function addToNetwork(
  db: Firestore,
  api: AlchemyNotifyApi,
  url: string,
  network: AddressActivityNetwork,
  addresses: readonly string[],
  nowMs: number,
  options: { readonly capacity: number; readonly budget: { remaining: number }; readonly mayCreate: boolean },
): Promise<{ added: string[]; complete: boolean }> {
  const added: string[] = [];
  let cursor = 0;
  while (cursor < addresses.length) {
    if (options.budget.remaining <= 0) return { added, complete: false };
    const want = Math.min(ADDRESS_ACTIVITY_UPDATE_CHUNK, options.budget.remaining, addresses.length - cursor);
    const room = await reserveWebhookRoom(db, network, want, options.capacity, nowMs);
    let chunk: string[];
    let webhookId: string;
    if (room) {
      chunk = addresses.slice(cursor, cursor + room.take);
      try {
        await api.addAddresses(room.id, chunk);
      } catch (error) {
        await releaseWebhookRoom(db, network, room.id, room.take, nowMs).catch(() => { /* the count only ever overstates */ });
        throw error;
      }
      webhookId = room.id;
    } else {
      if (!options.mayCreate) return { added, complete: false };
      chunk = addresses.slice(cursor, cursor + Math.min(want, options.capacity));
      const existing = parseState((await stateRef(db, network).get()).data() as Record<string, unknown> | undefined).webhooks.length;
      const created = await api.createWebhook({
        network, url, name: `provian-address-activity-${network.toLowerCase()}-${existing + 1}`, addresses: chunk,
      });
      await appendWebhook(db, network, created.id, chunk.length, nowMs);
      webhookId = created.id;
    }
    await recordMembers(db, network, webhookId, chunk, nowMs);
    added.push(...chunk);
    cursor += chunk.length;
    options.budget.remaining -= chunk.length;
  }
  return { added, complete: true };
}

async function webhookCount(db: Firestore, network: AddressActivityNetwork): Promise<number> {
  const snap = await stateRef(db, network).get();
  return parseState(snap.exists ? snap.data() as Record<string, unknown> : undefined).webhooks.length;
}

async function syncNetwork(
  deps: AddressActivitySyncDeps,
  api: AlchemyNotifyApi,
  url: string,
  network: AddressActivityNetwork,
  runStartMs: number,
  budget: { remaining: number },
): Promise<NetworkSyncReport> {
  const ref = stateRef(deps.db, network);
  const snap = await ref.get();
  const raw = snap.exists ? snap.data() as Record<string, unknown> : undefined;
  const state = parseState(raw);
  const since = state.synced_through_ms === null ? null : state.synced_through_ms - ADDRESS_ACTIVITY_SYNC_OVERLAP_MS;
  const candidates = [...new Set(network === 'SOLANA_MAINNET'
    ? await deps.solanaCandidates(since)
    : await deps.evmCandidates(since))].sort();
  const missing = await missingMembers(deps.db, network, candidates);
  const capacity = deps.capacity ?? ADDRESS_ACTIVITY_WEBHOOK_CAPACITY;
  const result = await addToNetwork(deps.db, api, url, network, missing, runStartMs, { capacity, budget, mayCreate: true });
  if (result.complete) {
    await ref.set({ synced_through_ms: runStartMs, updated_at_ms: runStartMs }, { merge: true });
  }
  const report: NetworkSyncReport = {
    candidates: candidates.length, added: result.added.length, webhooks: 0, complete: result.complete,
  };
  if (network === 'SOLANA_MAINNET') {
    try {
      // Owners are seeded on their own cursor, which moves only after their seeding succeeded: a
      // run that fails before seeding leaves them for the next run (seeding an owner twice is a
      // no-op). The first run seeds every owner already proven.
      const seededThrough = raw?.token_owners_synced_through_ms;
      const ownersSince = Number.isSafeInteger(seededThrough) ? (seededThrough as number) - ADDRESS_ACTIVITY_SYNC_OVERLAP_MS : null;
      const owners = ownersSince === since ? candidates : await deps.solanaCandidates(ownersSince);
      const tokens = await syncSolanaTokenAccounts(deps, api, url, owners, runStartMs, capacity, budget,
        () => ref.set({ token_owners_synced_through_ms: runStartMs }, { merge: true }).then(() => undefined));
      report.token_accounts = tokens;
      if (!tokens.complete) report.complete = false;
    } catch (error) {
      report.complete = false;
      report.token_accounts = { error: error instanceof Error ? error.message : String(error) };
    }
  }
  report.webhooks = await webhookCount(deps.db, network);
  return report;
}

export interface SolanaTokenSyncReport {
  owners_seeded?: number;
  owners_enumerated?: number;
  enumeration_errors?: number;
  pending?: number;
  registered?: number;
  complete?: boolean;
  enumeration?: string;
  error?: string;
}

/**
 * The Solana token-account half of a sync: seed new owners (their derived accounts), enumerate the
 * owners that are due (first sight, named by a delivery, or a day since), and register every
 * pending token account.
 */
async function syncSolanaTokenAccounts(
  deps: AddressActivitySyncDeps,
  api: AlchemyNotifyApi,
  url: string,
  owners: readonly string[],
  nowMs: number,
  capacity: number,
  budget: { remaining: number },
  ownersSeeded: () => Promise<void>,
): Promise<SolanaTokenSyncReport & { complete: boolean }> {
  const report: SolanaTokenSyncReport & { complete: boolean } = { complete: true };
  report.owners_seeded = await seedTokenOwners(deps.db, owners, nowMs);
  await ownersSeeded();
  if (deps.solanaTokenAccounts) {
    const due = await dueTokenOwners(deps.db, nowMs, SOLANA_OWNER_ENUMERATIONS_PER_RUN);
    let enumerated = 0;
    let errors = 0;
    for (const owner of due) {
      let accounts: readonly string[];
      try {
        accounts = await deps.solanaTokenAccounts(owner);
      } catch {
        errors += 1; // stays due: the next run tries again
        continue;
      }
      await recordTokenAccountOwners(deps.db, accounts.map((tokenAccount) => ({ tokenAccount, owner })), 'enumeration', nowMs);
      await markTokenOwnerEnumerated(deps.db, owner, nowMs);
      enumerated += 1;
    }
    report.owners_enumerated = enumerated;
    report.enumeration_errors = errors;
    if (errors > 0) report.complete = false;
  } else {
    report.enumeration = 'solana_legs_unconfigured';
    report.complete = false;
  }
  const pending = await pendingTokenAccounts(deps.db, SOLANA_TOKEN_ACCOUNT_REGISTRATIONS_PER_RUN);
  report.pending = pending.length;
  const missing = new Set(await missingMembers(deps.db, 'SOLANA_MAINNET', pending));
  // Accounts already on a webhook (a delivery registered them) only need their flag.
  const already = pending.filter((a) => !missing.has(a));
  const added = await addToNetwork(deps.db, api, url, 'SOLANA_MAINNET', [...missing], nowMs, { capacity, budget, mayCreate: true });
  await markTokenAccountsRegistered(deps.db, [...already, ...added.added], nowMs);
  report.registered = added.added.length;
  if (!added.complete) report.complete = false;
  return report;
}

/** Register every watched address not yet on an address-activity webhook. A network's fault is reported, never fatal. */
export async function syncAddressActivityWebhooks(deps: AddressActivitySyncDeps): Promise<AddressActivitySyncReport> {
  const report: AddressActivitySyncReport = { networks: {} };
  if (!deps.api) return { ...report, skipped: 'auth_token_unconfigured' };
  if (!deps.webhookUrl) return { ...report, skipped: 'webhook_url_unconfigured' };
  const runStartMs = (deps.now ?? Date.now)();
  const budget = { remaining: ADDRESS_ACTIVITY_MAX_ADDS_PER_RUN };
  for (const network of ADDRESS_ACTIVITY_NETWORKS) {
    try {
      report.networks[network] = await syncNetwork(deps, deps.api, deps.webhookUrl, network, runStartMs, budget);
    } catch (error) {
      report.networks[network] = {
        candidates: 0, added: 0, webhooks: 0, complete: false, error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return report;
}

export function buildAddressActivitySyncDeps(db: Firestore, env: Env = process.env): AddressActivitySyncDeps {
  return {
    db,
    api: buildAlchemyNotifyApi(env),
    webhookUrl: addressActivityWebhookUrl(env),
    evmCandidates: async (sinceMs) => {
      const snapshot = await readWatchRegistry(db);
      if (snapshot === null) return [];
      const out: string[] = [];
      for (const [address, latest] of snapshot.latestMs) {
        if (sinceMs === null || latest >= sinceMs) out.push(address);
      }
      return out;
    },
    solanaCandidates: async (sinceMs) => {
      const collection = db.collection(SOLANA_PROVEN_ADDRESSES_COLLECTION);
      const snap = sinceMs === null ? await collection.get() : await collection.where('proven_at_ms', '>=', sinceMs).get();
      return snap.docs.map((d) => d.id).filter((id) => isSolanaAddress(id));
    },
    solanaTokenAccounts: solanaTokenAccountReader(env),
  };
}

function solanaTokenAccountReader(env: Env): ((owner: string) => Promise<readonly string[]>) | null {
  let legs: ReturnType<typeof buildSolanaRpcLegs>;
  try {
    legs = buildSolanaRpcLegs(env, fetch);
  } catch {
    return null;
  }
  return (owner) => readSolanaTokenAccountsUnion(legs, owner);
}

// =============================================================================
// DELIVERY
// =============================================================================

/** The signing keys of the team's webhooks, cached; refreshed when stale or on an unknown id (rate-limited). */
export class AddressActivitySigningKeys {
  private keys = new Map<string, AlchemyWebhook>();
  private loadedAtMs = 0;
  private lastRefreshMs = 0;
  private refreshing: Promise<void> | null = null;

  constructor(private readonly api: AlchemyNotifyApi | null, private readonly now: () => number = Date.now) {}

  private async refresh(): Promise<void> {
    if (!this.api) return;
    if (!this.refreshing) {
      this.lastRefreshMs = this.now();
      this.refreshing = (async () => {
        const list = await this.api!.listWebhooks();
        const next = new Map<string, AlchemyWebhook>();
        for (const w of list) if (w.type === '' || w.type === 'ADDRESS_ACTIVITY') next.set(w.id, w);
        this.keys = next;
        this.loadedAtMs = this.now();
      })().finally(() => { this.refreshing = null; });
    }
    await this.refreshing;
  }

  async get(webhookId: string): Promise<AlchemyWebhook | null> {
    const now = this.now();
    // Stale keys or an unknown id refresh, but never more than once a minute (counted from the last
    // attempt, successful or not), so posts (forged ones included) cannot turn into list calls.
    const stale = now - this.loadedAtMs >= SIGNING_KEY_CACHE_MS;
    if ((stale || !this.keys.has(webhookId)) && now - this.lastRefreshMs >= SIGNING_KEY_REFRESH_MIN_MS) await this.refresh();
    return this.keys.get(webhookId) ?? null;
  }
}

export function addressActivitySignatureValid(rawBody: string, signature: unknown, signingKey: string): boolean {
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = crypto.createHmac('sha256', signingKey).update(rawBody, 'utf8').digest();
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

export interface AddressActivityDeliveryReport {
  readonly network: string;
  readonly transactions: number;
  readonly queued: number;
  readonly already_queued: number;
  readonly unwatched: number;
  /** Solana: new token accounts of watched owners this delivery put on the webhook. */
  readonly token_accounts_registered?: number;
}

export class AddressActivityDeliveryError extends Error {
  constructor(readonly status: 400 | 401 | 503, message: string) { super(message); }
}

/** The wallet an EVM address is queued under on another chain, or null when it is not watched there. */
async function resolveEvmActivityAddress(db: Firestore, address: string) {
  const native = await db.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION).doc(nativeWalletAddressIndexId(address)).get();
  const kinds: ReadonlySet<WatchRegistryKind> = native.exists ? new Set(['native']) : new Set(['human_proven', 'agent_proven']);
  return resolveMultichainEntry(db, { address, kinds });
}

async function handleEvmDelivery(
  db: Firestore,
  network: 'ARB_MAINNET' | 'OPT_MAINNET',
  event: Record<string, unknown>,
  nowMs: number,
): Promise<AddressActivityDeliveryReport> {
  const activity = event.activity;
  if (!Array.isArray(activity)) throw new AddressActivityDeliveryError(400, 'address_activity_payload_invalid');
  const chainId = EVM_CHAIN_IDS[network];
  // (tx hash, address) pairs, each address resolved once per delivery.
  const pairs = new Map<string, Set<string>>();
  for (const item of activity.slice(0, MAX_EVM_ACTIVITIES_PER_DELIVERY)) {
    const a = item as Record<string, unknown>;
    if (!a || typeof a !== 'object' || typeof a.hash !== 'string' || typeof a.category !== 'string') continue;
    const hash = a.hash.toLowerCase();
    const removed = (a.log as Record<string, unknown> | undefined)?.removed === true;
    if (!EVM_HASH.test(hash) || removed || !EVM_CATEGORIES.has(a.category)) continue;
    for (const party of [a.fromAddress, a.toAddress]) {
      if (typeof party !== 'string') continue;
      const address = party.toLowerCase();
      if (!EVM_ADDRESS.test(address)) continue;
      const hashes = pairs.get(address) ?? new Set<string>();
      hashes.add(hash);
      pairs.set(address, hashes);
    }
  }
  let queued = 0, already = 0, unwatched = 0;
  const transactions = new Set<string>();
  for (const [address, hashes] of pairs) {
    const watched = await resolveEvmActivityAddress(db, address);
    if (!watched) { unwatched += 1; continue; }
    for (const txHash of [...hashes].sort()) {
      transactions.add(txHash);
      const created = await enqueueChainRecordObservation(db, {
        txHash, walletId: watched.walletId, source: 'multichain_scan', ownerType: watched.ownerType, chainId,
      }, nowMs);
      if (created) queued += 1; else already += 1;
    }
  }
  return { network, transactions: transactions.size, queued, already_queued: already, unwatched };
}

/** Every string in `value` that is a Solana address, depth-first, at most `cap`. */
function solanaAddressesIn(value: unknown, out: Set<string>, cap: number): void {
  if (out.size >= cap) return;
  if (typeof value === 'string') {
    if (value.length >= 32 && value.length <= 44 && isSolanaAddress(value)) out.add(value);
    return;
  }
  if (Array.isArray(value)) { for (const v of value) { solanaAddressesIn(v, out, cap); if (out.size >= cap) return; } return; }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) { solanaAddressesIn(v, out, cap); if (out.size >= cap) return; }
  }
}

function solanaSignatureOf(item: Record<string, unknown>): string | null {
  if (typeof item.signature === 'string' && isSolanaSignature(item.signature)) return item.signature;
  const inner = Array.isArray(item.transaction) ? item.transaction[0] : item.transaction;
  const sigs = (inner as Record<string, unknown> | undefined)?.signatures;
  if (Array.isArray(sigs) && typeof sigs[0] === 'string' && isSolanaSignature(sigs[0])) return sigs[0];
  return null;
}

/** Where a delivery registers the new token accounts it names (null: leave them to the sync). */
export interface AddressActivityRegistrar {
  readonly api: AlchemyNotifyApi;
  readonly url: string;
  /** Addresses per webhook (tests); defaults to `ADDRESS_ACTIVITY_WEBHOOK_CAPACITY`. */
  readonly capacity?: number;
}

/** Which of `addresses` are proven Solana addresses (the watched owners). */
async function provenSolanaOwners(db: Firestore, addresses: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const list = [...new Set(addresses)];
  for (let i = 0; i < list.length; i += 300) {
    const chunk = list.slice(i, i + 300);
    const snaps = await db.getAll(...chunk.map((a) => db.collection(SOLANA_PROVEN_ADDRESSES_COLLECTION).doc(a)));
    snaps.forEach((snap, k) => { if (snap.exists && isSolanaProvenAddressRecord(snap.data(), chunk[k])) out.add(chunk[k]); });
  }
  return out;
}

async function handleSolanaDelivery(
  db: Firestore,
  event: Record<string, unknown>,
  nowMs: number,
  registrar: AddressActivityRegistrar | null,
): Promise<AddressActivityDeliveryReport> {
  const items = Array.isArray(event.transaction) ? event.transaction : null;
  if (!items) throw new AddressActivityDeliveryError(400, 'address_activity_payload_invalid');
  const eventSlot = Number.isSafeInteger(event.slot) ? event.slot as number : null;
  let queued = 0, already = 0, unwatched = 0, transactions = 0;
  const namedOwners = new Set<string>();
  const newPairs: TokenAccountOwner[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const signature = solanaSignatureOf(item);
    if (!signature) continue;
    transactions += 1;
    const slot = Number.isSafeInteger(item.slot) ? item.slot as number : eventSlot ?? 0;
    const balances = tokenBalancePairs(item);
    const candidates = new Set<string>();
    solanaAddressesIn(item, candidates, MAX_SOLANA_CANDIDATES_PER_TRANSACTION);
    for (const p of balances) { candidates.add(p.owner); candidates.add(p.tokenAccount); }
    candidates.delete(signature);
    const list = [...candidates];
    // Owners named directly, and owners of the registered token accounts the transaction names.
    const accountOwners = await ownersOfTokenAccounts(db, list);
    const mappedOwners = [...accountOwners.values()].flat();
    const proven = await provenSolanaOwners(db, [...list, ...mappedOwners]);
    const owners = new Set<string>();
    for (const address of list) {
      if (proven.has(address)) owners.add(address);
      for (const owner of accountOwners.get(address) ?? []) if (proven.has(owner)) owners.add(owner);
    }
    for (const owner of [...owners].sort()) {
      namedOwners.add(owner);
      if (await enqueueSolanaChainRecordObservation(db, { signature, address: owner, slot }, nowMs)) queued += 1;
      else already += 1;
    }
    if (owners.size === 0) unwatched += 1;
    // A token account of a watched owner that the transaction's balances name (one it just created).
    for (const p of balances) if (proven.has(p.owner) && !accountOwners.get(p.tokenAccount)?.includes(p.owner)) newPairs.push(p);
  }
  let tokenAccountsRegistered = 0;
  try {
    await markTokenOwnersDue(db, [...namedOwners], nowMs);
    const pending = newPairs.length === 0 ? [] : await recordTokenAccountOwners(db, newPairs.slice(0, SOLANA_TOKEN_ACCOUNTS_PER_DELIVERY), 'delivery', nowMs);
    if (registrar && pending.length > 0) {
      const missing = new Set(await missingMembers(db, 'SOLANA_MAINNET', pending));
      const added = await addToNetwork(db, registrar.api, registrar.url, 'SOLANA_MAINNET', [...missing], nowMs, {
        capacity: registrar.capacity ?? ADDRESS_ACTIVITY_WEBHOOK_CAPACITY,
        budget: { remaining: SOLANA_TOKEN_ACCOUNTS_PER_DELIVERY },
        mayCreate: false,
      });
      await markTokenAccountsRegistered(db, [...pending.filter((a) => !missing.has(a)), ...added.added], nowMs);
      tokenAccountsRegistered = added.added.length;
    }
  } catch (error) {
    // The pointers are queued; a token account left pending is registered by the next sync.
    console.warn('[address-activity] token account registration deferred:', error instanceof Error ? error.message : String(error));
  }
  return { network: 'SOLANA_MAINNET', transactions, queued, already_queued: already, unwatched, token_accounts_registered: tokenAccountsRegistered };
}

/**
 * One delivery: verify the webhook's signature over the raw body, then queue a pointer for every
 * transfer into or out of a watched address. Throws `AddressActivityDeliveryError` for a delivery
 * that is refused (401: unknown webhook or bad signature; 400: malformed; 503: keys unavailable).
 */
export async function handleAddressActivityDelivery(
  db: Firestore,
  keys: AddressActivitySigningKeys,
  rawBody: string,
  signature: unknown,
  nowMs: number = Date.now(),
  registrar: AddressActivityRegistrar | null = null,
): Promise<AddressActivityDeliveryReport> {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    throw new AddressActivityDeliveryError(400, 'address_activity_payload_invalid');
  }
  if (!payload || typeof payload !== 'object' || typeof payload.webhookId !== 'string') {
    throw new AddressActivityDeliveryError(400, 'address_activity_payload_invalid');
  }
  let webhook: AlchemyWebhook | null;
  try {
    webhook = await keys.get(payload.webhookId);
  } catch {
    throw new AddressActivityDeliveryError(503, 'address_activity_keys_unavailable');
  }
  if (!webhook || !addressActivitySignatureValid(rawBody, signature, webhook.signingKey)) {
    throw new AddressActivityDeliveryError(401, 'address_activity_signature_invalid');
  }
  if (payload.type !== 'ADDRESS_ACTIVITY') throw new AddressActivityDeliveryError(400, 'address_activity_type_unexpected');
  const event = payload.event as Record<string, unknown> | undefined;
  if (!event || typeof event !== 'object') throw new AddressActivityDeliveryError(400, 'address_activity_payload_invalid');
  // The network is the webhook's own (a payload naming another is refused).
  const network = webhook.network;
  if (typeof event.network === 'string' && event.network !== network) {
    throw new AddressActivityDeliveryError(400, 'address_activity_network_mismatch');
  }
  if (network === 'ARB_MAINNET' || network === 'OPT_MAINNET') return handleEvmDelivery(db, network, event, nowMs);
  if (network === 'SOLANA_MAINNET') return handleSolanaDelivery(db, event, nowMs, registrar);
  throw new AddressActivityDeliveryError(400, 'address_activity_network_unsupported');
}
