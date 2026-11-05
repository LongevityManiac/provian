/** Relay policy table. Unknown location or unreadable policy never authorizes minting. */
import type { Firestore } from 'firebase-admin/firestore';
import { relayDb } from '../../firestore-db';
export type JurisdictionMintPolicy = 'immediate' | 'deferred' | 'blocked';
export interface JurisdictionPolicyEntry { policy: JurisdictionMintPolicy; reason: string; since: string }
export const INITIAL_JURISDICTION_POLICIES: Readonly<Record<string, JurisdictionPolicyEntry>> = {
  CN: { policy: 'deferred', reason: 'Token generation deferred; provenance remains valid.', since: '2026-04-01' },
  ...Object.fromEntries(['KP', 'IR', 'CU', 'UA-43', 'UA-40', 'UA-14', 'UA-09'].map(code =>
    [code, { policy: 'blocked' as const, reason: 'Restricted jurisdiction; provenance only.', since: code.startsWith('UA-') ? '2026-11-01' : '2026-04-01' }])),
};
let cache: { db: Firestore; expires: number; entries: Map<string, JurisdictionPolicyEntry> } | null = null;
export async function resolveJurisdictionPolicy(countryCode: string | null | undefined, region?: string | null,
  db: Firestore = relayDb()): Promise<JurisdictionMintPolicy | 'unknown'> {
  if (!countryCode || !/^[A-Z]{2}$/.test(countryCode) || ['ZZ', 'XX'].includes(countryCode)) return 'unknown';
  // Occupied regions may be reported under either UA or RU. A country-only lookup is insufficient.
  if (['UA', 'RU'].includes(countryCode) && !region) return 'unknown';
  try {
    if (!cache || cache.db !== db || cache.expires <= Date.now()) {
      const snapshot = await db.collection('jurisdiction_policy').get();
      const entries = new Map<string, JurisdictionPolicyEntry>();
      for (const doc of snapshot.docs) {
        const entry = doc.data() as JurisdictionPolicyEntry;
        if (!['immediate', 'deferred', 'blocked'].includes(entry.policy)) return 'unknown';
        entries.set(doc.id, entry);
      }
      // A missing table is an unavailable compliance source, never an allow-all table.
      if (entries.size === 0) return 'unknown';
      cache = { db, expires: Date.now() + 60000, entries };
    }
    const policies = [cache.entries.get(countryCode)?.policy, region ? cache.entries.get(region)?.policy : undefined];
    return policies.includes('blocked') ? 'blocked' : policies.includes('deferred') ? 'deferred' : 'immediate';
  } catch { return 'unknown'; }
}
/** Public policy remains fail closed; callers needing recovery distinguish unavailable evidence. */
export async function getJurisdictionPolicy(countryCode: string | null | undefined, region?: string | null,
  db: Firestore = relayDb()): Promise<JurisdictionMintPolicy> {
  const policy = await resolveJurisdictionPolicy(countryCode, region, db);
  return policy === 'unknown' ? 'blocked' : policy;
}
export async function getFullJurisdictionPolicy(): Promise<{
  version: string; updated_at: number; default_policy: string; unknown_policy: 'blocked'; jurisdictions: Record<string, JurisdictionPolicyEntry>;
}> {
  const snapshot = await relayDb().collection('jurisdiction_policy').get();
  return { version: '2.0.0', updated_at: Date.now(), default_policy: 'immediate', unknown_policy: 'blocked',
    jurisdictions: Object.fromEntries(snapshot.docs.map(doc => [doc.id, doc.data() as JurisdictionPolicyEntry])) };
}
