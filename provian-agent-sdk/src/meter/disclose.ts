/**
 * Requester-named disclosure — the PRESENTER'S side of finding what it holds (2026-10-10).
 *
 * A signed challenge may name a specific PE by one of its output digests, or PEs witnessed by a
 * named issuer or signer. This module scans THIS machine's PE store for the records that answer
 * such a request and builds each with its two-hop proof (only an anchored act can be presented).
 * The relay re-derives the witness facts from the PE and REFUSES a record that does not satisfy
 * the request, so the finder is conservative:
 *
 *   - `pe` by digest: exact match on `output_digests[].hash` (or the PE's own hash);
 *   - `witness` by issuer: a pinned root fingerprint maps to its scheme (the five hardware roots
 *     the relay pins), so the candidates are this store's PEs carrying a report of that scheme;
 *     `chain:base` → PEs the relay stamped chain-verified; a device id → that device's PEs;
 *   - `witness` by signer: a device id → that device's own PEs; a 64-hex key fingerprint → the
 *     hardware-witnessed PEs (the report key is only known to the relay's verifier, so the relay
 *     has the last word).
 *
 * Nothing here elects: the caller decides which requests to answer (`disclosed`) and which to
 * decline; this only finds the records for an elected request.
 */

import type { CanonicalDisclosureRequest } from '../disclosure-request';
import type { DisclosedPeRecord } from '../presentation';
import type { PeStore } from './pe-store';
import { peFactFromStore, type ArchivedPeSource } from './prove';

/** The pinned hardware roots the relay admits, by sha256 fingerprint → scheme (mirrors `core/hardware/roots.ts`). */
export const PINNED_ROOT_SCHEME: Readonly<Record<string, string>> = Object.freeze({
  '594759594b9b61524f6c8ef668f7177f7b9066bc0674f2f49fe9e052be78beb2': 'tpm2_quote',        // Google Cloud EK/AK CA Root
  '1cb9823ba28ba6ad2d33a006941de2ae4f513ef1d4e831b9f7e0fa7b6242c932': 'apple_app_attest',  // Apple App Attestation Root CA
  '641a0321a3e244efe456463195d606317ed7cdcc3c1756e09893f3c68f79bb5b': 'aws_nitro',         // AWS Nitro Root-G1
  '102bf659d5419614c9d8e6aecebc80454eb26b1df6a769ac720b9a690b167b48': 'nvidia_cc',         // NVIDIA Device Identity CA
});

const HEX64 = /^[0-9a-f]{64}$/;

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function digestsOf(pe: Record<string, unknown>): string[] {
  const out: string[] = [];
  const list = pe.output_digests;
  if (!Array.isArray(list)) return out;
  for (const e of list) {
    const h = typeof obj(e)?.hash === 'string' ? (obj(e)!.hash as string).trim().toLowerCase().replace(/^sha256:/, '').replace(/^0x/, '') : '';
    if (HEX64.test(h)) out.push(h);
  }
  return out;
}

function isChainVerified(pe: Record<string, unknown>): boolean {
  const md = obj(pe.metadata);
  if (!md || md.verified !== true) return false;
  const ev = obj(md.economic_evidence);
  return [md.tx_hash, md.txHash, ev?.txHash, ev?.tx_hash].some((c) => typeof c === 'string' && /^0x[0-9a-fA-F]{64}$/.test(c));
}

/** Does a stored PE plausibly answer the request? (The relay verifies; this only selects.) */
export function storedPeMatches(pe: Record<string, unknown>, deviceId: string, request: CanonicalDisclosureRequest): boolean {
  const hw = obj(pe.hardware_witness);
  const scheme = typeof hw?.scheme === 'string' ? hw.scheme : null;
  if (request.kind === 'pe') {
    const own = typeof pe.pe_hash === 'string' ? pe.pe_hash.toLowerCase() : '';
    if (!digestsOf(pe).includes(request.output_digest) && own !== request.output_digest) return false;
    if (request.issuer !== undefined) {
      const wanted = PINNED_ROOT_SCHEME[request.issuer];
      if (wanted !== undefined) return scheme === wanted;
      if (request.issuer === 'chain:base') return isChainVerified(pe);
      return false;
    }
    return true;
  }
  if (request.issuer !== undefined) {
    const wanted = PINNED_ROOT_SCHEME[request.issuer];
    if (wanted !== undefined) { if (scheme !== wanted) return false; }
    else if (request.issuer === 'chain:base') { if (!isChainVerified(pe)) return false; }
    else return false;
  }
  if (request.signer !== undefined) {
    if (request.signer === deviceId.toLowerCase()) { if (hw !== null) return false; }
    else if (HEX64.test(request.signer)) { if (hw === null) return false; }
    else return false;
  }
  return true;
}

export interface FindDisclosureRecordsResult {
  readonly records: DisclosedPeRecord[];
  /** PEs that matched but could not be presented (not anchored yet, archived and unreachable). */
  readonly skipped: { peId: string; detail: string }[];
}

/**
 * Find the records in `store` that answer `request`, newest first, up to the request's limit (1 for a
 * `pe` request), each with its anchored two-hop proof.
 */
export async function findDisclosureRecords(
  store: PeStore,
  request: CanonicalDisclosureRequest,
  archive?: ArchivedPeSource,
  options: { readonly scanLimit?: number } = {},
): Promise<FindDisclosureRecordsResult> {
  const limit = request.kind === 'witness' ? request.limit : 1;
  const head = await store.head();
  const scan = Math.min(head.count, options.scanLimit ?? head.count);
  const from = Math.max(0, head.count - scan);
  const candidates = store.listChainRows
    ? (await store.listChainRows()).filter(row => row.index >= from && row.index < head.count)
    : (await store.readPes(from, scan)).map(entry => ({ kind: 'pe' as const, index: entry.index, stored: entry }));
  const matches = candidates.filter(row => row.kind !== 'unreadable').sort((a, b) => b.index - a.index);
  const records: DisclosedPeRecord[] = [];
  const skipped: { peId: string; detail: string }[] = [];
  for (const m of matches) {
    if (records.length >= limit) break;
    if (m.kind === 'pe' && !storedPeMatches(m.stored.pe as unknown as Record<string, unknown>, store.deviceId, request)) continue;
    const peId = m.kind === 'pointer' ? m.stub.pe_id : m.stored.pe.pe_id;
    const fact = await peFactFromStore(store, peId, archive);
    if (!fact.ok) { skipped.push({ peId, detail: fact.detail }); continue; }
    if (!storedPeMatches(fact.fact.pe as unknown as Record<string, unknown>, store.deviceId, request)) continue;
    records.push({ peId: fact.fact.peId, envelopeHash: fact.fact.envelopeHash, pe: fact.fact.pe, inclusion: fact.fact.inclusion });
  }
  return { records, skipped };
}
