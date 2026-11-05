import { NATIVE_WALLET_ADDRESS_INDEX_COLLECTION, nativeWalletAddressIndexId } from '../pvt/native-wallet-registration';
import { AsyncLocalStorage } from 'async_hooks';
/** Server-derived actor + payee compliance, shared by pricing, recovery and settlement. */
import type { Request } from 'express';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { relayDb } from '../../firestore-db';
import { countryFromIp, type CountryObservation } from './country';
import { resolveJurisdictionPolicy, type JurisdictionMintPolicy } from './jurisdiction-policy';
import { canonicalCurrencyAddress, screenAddresses } from './sdn';
export const SESSION_COLLECTION = 'wallet_jurisdiction_sessions_v1';
export interface WalletLocation extends CountryObservation { readonly address: string; readonly observed_at_ms: number; readonly retention_until_ms?: number }
export interface MintCompliance {
  readonly policy: JurisdictionMintPolicy;
  readonly reason: 'clear' | 'jurisdiction_blocked' | 'jurisdiction_deferred' | 'jurisdiction_unknown' | 'sdn_hit' | 'sdn_unavailable';
  readonly actor_country: string | null;
  readonly actor_region: string | null;
  readonly deferred_context: string | null;
}
const requestLocations = new AsyncLocalStorage<{ addresses: Map<string, WalletLocation>; failedActors: Set<string> }>();
export function withJurisdictionRequest<T>(callback: () => T): T {
  return requestLocations.run({ addresses: new Map(), failedActors: new Set() }, callback);
}
const complianceEvidence = new WeakMap<object, { actor: string; recipient: string | null }>();
export function isMintComplianceEvidence(value: MintCompliance | undefined, actor: string, recipient: string | null): value is MintCompliance {
  if (value === undefined) return false;
  const subject = complianceEvidence.get(value);
  return subject?.actor === actor && subject.recipient === (recipient?.toLowerCase() ?? null);
}
const EVM = /^0x[0-9a-f]{40}$/i;
function addressOf(value: unknown): string | null { return typeof value === 'string' && EVM.test(value) ? value.toLowerCase() : null; }
/** Resolve from relay identity state, never the PE's asserted walletAddress. */
export async function actorWalletAddresses(db: Firestore, actorId: string): Promise<string[]> {
  if (!actorId || actorId.includes('/')) return [];
  const agents = await db.collection('agent_wallets').where('agent_id', '==', actorId).limit(2).get();
  if (agents.docs.length > 1) return [];
  const direct = agents.docs[0] ?? (await db.collection('agent_wallets').doc(actorId).get());
  if (direct.exists) {
    const address = addressOf(direct.data()?.address);
    return address ? [address] : [];
  }
  const wallets = await db.collection('wallets').where('user_id', '==', actorId).limit(20).get();
  const addresses = wallets.docs.map(d => addressOf(d.data().address)).filter((a): a is string => a !== null);
  if (addresses.length) return [...new Set(addresses)];
  const wallet = await db.collection('wallets').doc(actorId).get();
  const address = addressOf(wallet.data()?.address);
  return address ? [address] : [];
}
/** Read the authenticated identity and wallet release in the same conflict set as the observation. */
async function mayObserve(db: Firestore, txn: Transaction, address: string, actorId?: string): Promise<boolean> {
  if (actorId) {
    const agents = await txn.get(db.collection('agent_wallets').where('agent_id', '==', actorId).limit(2));
    if (agents.docs.length > 1) return false;
    const agent = agents.docs[0] ?? await txn.get(db.collection('agent_wallets').doc(actorId));
    if (agent.exists) return addressOf(agent.data()?.address) === address;
    const wallets = await txn.get(db.collection('wallets').where('user_id', '==', actorId).limit(20));
    const direct = wallets.empty ? await txn.get(db.collection('wallets').doc(actorId)) : null;
    return [...wallets.docs, ...(direct?.exists ? [direct] : [])].some(wallet => {
      const data = wallet.data();
      return addressOf(data?.address) === address && data?.released_at_ms === undefined && data?.displaced_at_ms === undefined;
    });
  }
  // Proof-carrying direct callers use the canonical address index, whose key ignores checksum case.
  const index = await txn.get(db.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION).doc(nativeWalletAddressIndexId(address)));
  if (index.exists && index.data()?.owner_type === 'human') {
    const id: unknown = index.data()?.wallet_id;
    if (typeof id !== 'string' || id.includes('/')) return false;
    const wallet = await txn.get(db.collection('wallets').doc(id));
    return wallet.exists && addressOf(wallet.data()?.address) === address
      && wallet.data()?.released_at_ms === undefined && wallet.data()?.displaced_at_ms === undefined;
  }
  const registrations = await txn.get(db.collection('wallets').where('address', '==', address).where('type', '==', 'human'));
  return !registrations.docs.length || registrations.docs.some(d => d.data().released_at_ms === undefined && d.data().displaced_at_ms === undefined);
}
/** Called only after authentication or registration proof. Stores country/region, never raw IP. */
export async function observeWalletSession(db: Firestore, req: Pick<Request, 'ip'>, addresses: readonly string[], actorId?: string): Promise<boolean> {
  const observation = countryFromIp(req.ip);
  const accepted = await Promise.all(addresses.filter(a => EVM.test(a)).map(async address => {
    const id = canonicalCurrencyAddress(address);
    const location = { ...observation, address: id, observed_at_ms: Date.now() };
    const ref = db.collection(SESSION_COLLECTION).doc(id);
    const saved = await db.runTransaction(async txn => {
      const before = (await txn.get(ref)).data();
      if (!await mayObserve(db, txn, id, actorId)) return false;
      const retentionExpired = typeof before?.retention_until_ms === 'number' && before.retention_until_ms <= location.observed_at_ms;
      // Serialize changes across relay instances. A delayed request cannot overwrite a newer session.
      if (before && !retentionExpired && before.observed_at_ms > location.observed_at_ms) return true;
      if (before && !retentionExpired && before.country === location.country && before.region === location.region
        && before.database === location.database && location.observed_at_ms - before.observed_at_ms < 15 * 60 * 1000) return true;
      txn.set(ref, { ...location, ...(typeof before?.retention_until_ms === 'number' && before.retention_until_ms > location.observed_at_ms ? { retention_until_ms: before.retention_until_ms, ...(before.expire_at ? { expire_at: before.expire_at } : {}) } : {}),
        ...(typeof before?.deletion_requested_at_ms === 'number' ? { deletion_requested_at_ms: before.deletion_requested_at_ms } : {}) });
      return true;
    });
    if (saved) requestLocations.getStore()?.addresses.set(id, location);
    return saved;
  }));
  return accepted.length > 0 && accepted.every(Boolean);
}
/** Auth remains usable if the observation cannot be saved. Mint checks remain fail closed. */
export async function observeActorSession(db: Firestore, req: Pick<Request, 'ip'>, actorId: string): Promise<void> {
  const context = requestLocations.getStore();
  context?.failedActors.add(actorId);
  try {
    const addresses = await actorWalletAddresses(db, actorId);
    if (addresses.length === 0) return;
    if (await observeWalletSession(db, req, addresses, actorId)) context?.failedActors.delete(actorId);
  } catch { console.warn('[jurisdiction] authenticated location could not be persisted'); }
}
export async function evaluateMintCompliance(actorId: string, beneficiaryAddress?: string | null,
  db: Firestore = relayDb(), nowMs = Date.now()): Promise<MintCompliance> {
  let actor_country: string | null = null;
  let actor_region: string | null = null;
  const result = (policy: JurisdictionMintPolicy, reason: MintCompliance['reason'], deferred_context: string | null = null): MintCompliance =>
    {
      const evidence = Object.freeze({ policy, reason, actor_country, actor_region, deferred_context });
      complianceEvidence.set(evidence, { actor: actorId, recipient: beneficiaryAddress?.toLowerCase() ?? null });
      return evidence;
    };
  try {
    if ((requestLocations.getStore()?.failedActors.size ?? 0) > 0) return result('blocked', 'jurisdiction_unknown');
    const actors = await actorWalletAddresses(db, actorId);
    if (!actors.length) return result('blocked', 'jurisdiction_unknown');
    const addresses = [...new Set([...actors, ...(beneficiaryAddress ? [beneficiaryAddress.toLowerCase()] : [])])];
    if (addresses.some(a => !EVM.test(a))) return result('blocked', 'jurisdiction_unknown');
    const screening = await screenAddresses(db, addresses, nowMs);
    if (screening !== 'clear') return result('blocked', screening === 'hit' ? 'sdn_hit' : 'sdn_unavailable');
    let deferred: string | null = null;
    for (const [index, address] of addresses.entries()) {
      const location = requestLocations.getStore()?.addresses.get(address)
        ?? (await db.collection(SESSION_COLLECTION).doc(address).get()).data() as WalletLocation | undefined;
      if (index === 0) { actor_country = location?.country ?? null; actor_region = location?.region ?? null; }
      if (!location || location.address !== address || !location.country || !Number.isFinite(location.observed_at_ms)
        || location.observed_at_ms > nowMs || typeof location.retention_until_ms === 'number' && location.retention_until_ms <= nowMs) return result('blocked', 'jurisdiction_unknown');
      const policy = await resolveJurisdictionPolicy(location.country, location.region, db);
      if (policy === 'unknown') return result('blocked', 'jurisdiction_unknown');
      if (policy === 'blocked') return result('blocked', 'jurisdiction_blocked',
        location.region?.startsWith('UA-') ? location.region : location.country);
      if (policy === 'deferred') deferred = location.region?.startsWith('UA-') ? location.region : location.country;
    }
    return deferred ? result('deferred', 'jurisdiction_deferred', deferred) : result('immediate', 'clear');
  } catch { return result('blocked', 'jurisdiction_unknown'); }
}
export async function complianceForRow(row: Readonly<Record<string, unknown>>, db: Firestore = relayDb()): Promise<MintCompliance> {
  const route = row.beneficiary_routing_snapshot as { human_address?: string } | undefined;
  const actor = String(row.userId ?? '');
  const recipient = route?.human_address ?? null;
  const current = await evaluateMintCompliance(actor, recipient, db);
  if (current.reason === 'sdn_hit' || row.jurisdiction_compliance_reason !== 'jurisdiction_blocked') return current;
  // The original jurisdiction's policy must open. A new session cannot release work held by it.
  // Apply this at every promotion boundary, including evidence/cache/review/beneficiary recovery.
  const context = typeof row.jurisdiction_context === 'string' ? row.jurisdiction_context : '';
  const region = context.includes('-') ? context
    : ['UA', 'RU'].includes(context) && typeof row.jurisdiction_region === 'string' ? row.jurisdiction_region : null;
  const original = await resolveJurisdictionPolicy(context.slice(0, 2), region, db);
  const held = (policy: JurisdictionMintPolicy, reason: MintCompliance['reason']): MintCompliance => {
    const evidence = Object.freeze({ ...current, policy, reason, deferred_context: context });
    complianceEvidence.set(evidence, { actor, recipient: recipient?.toLowerCase() ?? null });
    return evidence;
  };
  if (original === 'blocked') return held('blocked', 'jurisdiction_blocked');
  if (original === 'unknown') return held('blocked', 'jurisdiction_unknown');
  if (original === 'deferred' && current.policy === 'immediate') return held('deferred', 'jurisdiction_deferred');
  return current;
}
