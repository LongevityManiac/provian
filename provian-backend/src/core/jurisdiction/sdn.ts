/** Current OFAC digital-currency addresses. Refresh is scheduled; screening is local. */
import { XMLParser } from 'fast-xml-parser';
import { createHash } from 'crypto';
import { Resolver } from 'dns/promises';
import { request } from 'https';
import type { Firestore } from 'firebase-admin/firestore';
import { isPrivateIp } from '../net/private-ip';
import { pinnedLookup } from '../net/pinned-lookup';
import { startDeadline, raceDeadline } from '../net/bounded-fetch';
export const SDN_URL = 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML';
export const SDN_MAX_AGE_MS = 48 * 60 * 60 * 1000;
export interface SdnSnapshot { checked_at_ms: number; published: string; sha256: string; addresses: string[] }
export function canonicalCurrencyAddress(address: string): string {
  const value = address.trim();
  return /^0x[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : value;
}
export function parseSdn(xml: string, nowMs: number): SdnSnapshot {
  // Forbid DTD/entity processing. OFAC's simple SDN XML needs neither.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('sdn_xml_entities_forbidden');
  const parsed = new XMLParser({ ignoreAttributes: true, parseTagValue: false, processEntities: false }).parse(xml) as {
    sdnList?: { publshInformation?: { Publish_Date?: string; Record_Count?: string }; sdnEntry?: unknown[] };
  };
  const list = parsed.sdnList;
  if (!list || !Array.isArray(list.sdnEntry) || list.sdnEntry.length < 1000
    || Number(list.publshInformation?.Record_Count) !== list.sdnEntry.length) throw new Error('sdn_population_invalid');
  const addresses = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const obj = value as Record<string, unknown>;
    if (typeof obj.idType === 'string' && obj.idType.startsWith('Digital Currency Address - ')) {
      if (typeof obj.idNumber !== 'string' || !obj.idNumber.trim()) throw new Error('sdn_address_invalid');
      addresses.add(canonicalCurrencyAddress(obj.idNumber));
    }
    Object.values(obj).forEach(visit);
  };
  visit(list.sdnEntry);
  if (addresses.size < 100 || !list.publshInformation?.Publish_Date) throw new Error('sdn_addresses_empty');
  return { checked_at_ms: nowMs, published: list.publshInformation.Publish_Date,
    sha256: createHash('sha256').update(xml).digest('hex'), addresses: [...addresses].sort() };
}
/** OFAC redirects exports to its public GovCloud bucket. No other redirect host is trusted. */
export function approvedSdnUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  const official = new URL(SDN_URL);
  const bucket = 'wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com';
  if (url.protocol !== 'https:' || url.username || url.password || url.hash
    || (url.port && url.port !== '443')
    || (url.hostname === official.hostname
      ? url.pathname !== official.pathname || url.search !== ''
      : url.hostname !== bucket || !/^\/Published\/.+\/SDN\.XML$/i.test(url.pathname))) throw new Error('sdn_redirect_refused');
  return url;
}
/** Every hop is DNS checked and socket pinned under one deadline/byte cap. Signed URLs are never logged. */
async function downloadSdn(): Promise<string> {
  const deadline = startDeadline(90000);
  let rawUrl = SDN_URL;
  try {
    for (let hop = 0; hop < 3; hop += 1) {
      const url = approvedSdnUrl(rawUrl);
      const resolver = new Resolver({ timeout: 5000, tries: 1 });
      const addresses = (await raceDeadline(Promise.all([
        resolver.resolve4(url.hostname).catch(() => [] as string[]),
        resolver.resolve6(url.hostname).catch(() => [] as string[]),
      ]), deadline, () => resolver.cancel())).flat();
      if (!addresses.length || addresses.some(isPrivateIp)) throw new Error('sdn_dns_refused');
      const answer = await new Promise<{ body: string } | { redirect: string }>((resolve, reject) => {
        const req = request(url, { lookup: pinnedLookup(addresses[0]), signal: deadline.signal,
          headers: { 'User-Agent': 'Provian-SDN-Refresh/1.0 (+https://provian.ai)', Accept: 'application/xml, text/xml' } }, res => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0) && res.headers.location) {
            try {
              const redirect = new URL(res.headers.location, url).toString();
              approvedSdnUrl(redirect);
              res.destroy(); resolve({ redirect });
            } catch { res.destroy(); reject(new Error('sdn_redirect_invalid')); }
            return;
          }
          if (res.statusCode !== 200) { res.destroy(); reject(new Error(`sdn_http_${res.statusCode ?? 0}`)); return; }
          let size = 0;
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 64 * 1024 * 1024) { req.destroy(new Error('sdn_body_too_large')); return; }
            chunks.push(chunk);
          });
          res.on('error', reject);
          res.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject); req.end();
      });
      if ('body' in answer) return answer.body;
      rawUrl = answer.redirect;
    }
    throw new Error('sdn_redirect_limit');
  } finally { deadline.clear(); }
}
/** Failure metadata is separate from the last good screening snapshot and contains no remote URL. */
export async function refreshSdn(db: Firestore): Promise<{ addresses: number; published: string }> {
  const started = Date.now();
  const health = db.collection('jurisdiction_screening_v1').doc('ofac_sdn_refresh');
  await health.set({ last_attempt_at_ms: started, max_age_ms: SDN_MAX_AGE_MS }, { merge: true });
  try {
    const snapshot = parseSdn(await downloadSdn(), Date.now());
    await db.runTransaction(async txn => {
      const previous = (await txn.get(health)).data();
      if (typeof previous?.last_success_at_ms === 'number' && previous.last_success_at_ms > snapshot.checked_at_ms) return;
      txn.set(db.collection('jurisdiction_screening_v1').doc('ofac_sdn'), snapshot);
      txn.set(health, { last_success_at_ms: snapshot.checked_at_ms, max_age_ms: SDN_MAX_AGE_MS }, { merge: true });
    });
    cache = null;
    return { addresses: snapshot.addresses.length, published: snapshot.published };
  } catch {
    await health.set({ last_failure_at_ms: Date.now(), last_error_code: 'refresh_failed', max_age_ms: SDN_MAX_AGE_MS }, { merge: true });
    throw new Error('sdn_refresh_failed');
  }
}
let cache: { db: Firestore; expires: number; snapshot: SdnSnapshot; addresses: Set<string> } | null = null;
export async function screenAddresses(db: Firestore, addresses: readonly string[], nowMs = Date.now()): Promise<'clear' | 'hit' | 'unknown'> {
  try {
    if (!cache || cache.db !== db || cache.expires <= nowMs) {
      const raw = (await db.collection('jurisdiction_screening_v1').doc('ofac_sdn').get()).data() as SdnSnapshot | undefined;
      if (!raw || !Array.isArray(raw.addresses) || raw.addresses.length < 100
        || raw.addresses.some(a => typeof a !== 'string' || !a.trim() || canonicalCurrencyAddress(a) !== a)
        || new Set(raw.addresses).size !== raw.addresses.length
        || typeof raw.published !== 'string' || !/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(raw.published)
        || !Number.isFinite(Date.parse(raw.published)) || Date.parse(raw.published) > nowMs
        || !/^[a-f0-9]{64}$/.test(raw.sha256)) return 'unknown';
      cache = { db, expires: nowMs + 60000, snapshot: raw, addresses: new Set(raw.addresses) };
    }
    if (!Number.isFinite(cache.snapshot.checked_at_ms) || cache.snapshot.checked_at_ms > nowMs
      || nowMs - cache.snapshot.checked_at_ms > SDN_MAX_AGE_MS || !addresses.length || addresses.some(a => !a)) return 'unknown';
    return addresses.some(a => cache!.addresses.has(canonicalCurrencyAddress(a))) ? 'hit' : 'clear';
  } catch { return 'unknown'; }
}
