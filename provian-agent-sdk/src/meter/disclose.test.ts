/**
 * Requester-named disclosure — the presenter's store finder (2026-10-10).
 *
 * A store holding three anchored PEs: a plain device PE carrying an output digest, a PE with a
 * tpm2 hardware report, and a chain-verified transfer. Each request kind selects exactly the PEs
 * that answer it (GREEN) and nothing else (RED), each record carrying its two-hop proof; a PE that
 * is not anchored is SKIPPED with its reason, never presented.
 */
import { describe, it, expect } from 'vitest';
import { actRecordOf, actsRootOf, batchLeafOf, METER_GENESIS_PREV_HASH, peHashOf, PE_V2_SCHEMA, type PeV2 } from '../meter-wire';
import { MemoryPeStore, type StoredPeV2 } from './pe-store';
import { normalizeDisclosureRequests } from '../disclosure-request';
import { findDisclosureRecords, storedPeMatches, PINNED_ROOT_SCHEME } from './disclose';

const DEVICE = 'dev_' + 'd1'.repeat(32);
const ACTOR = 'wallet_aw_discloser';
const GCE_ROOT = '594759594b9b61524f6c8ef668f7177f7b9066bc0674f2f49fe9e052be78beb2';
const NITRO_ROOT = '641a0321a3e244efe456463195d606317ed7cdcc3c1756e09893f3c68f79bb5b';
const DIGEST_A = 'a7'.repeat(32);
const TX = '0x' + '3c'.repeat(32);

const SHAPES: Array<Record<string, unknown>> = [
  { action_type: 'coding_session', description: 'wrote the parser', metadata: { lines: 12 }, output_digests: [{ hash: DIGEST_A, kind: 'file' }] },
  { action_type: 'compute_session', description: 'attested run', metadata: { tokens: 10 }, hardware_witness: { scheme: 'tpm2_quote', report: 'x', chain: [] } },
  { action_type: 'send', description: 'paid', metadata: { verified: true, tx_hash: TX, counterparty: '0x' + '9'.repeat(40) } },
];

async function buildStore(options: { anchored?: boolean } = {}) {
  const store = new MemoryPeStore(DEVICE);
  const pes: StoredPeV2[] = [];
  let prev = METER_GENESIS_PREV_HASH;
  for (let i = 0; i < SHAPES.length; i++) {
    const base = {
      schema: PE_V2_SCHEMA, pe_id: `pe_disc_${i}`, device_id: DEVICE, prev_hash: prev,
      timestamp: 1_790_000_000_000 + i * 60_000, compute: null, ...SHAPES[i],
    } as unknown as PeV2;
    const pe: StoredPeV2 = { ...base, pe_hash: peHashOf(base) };
    const appended = await store.append(pe);
    if (!appended.ok) throw new Error(`append failed: ${appended.reason}`);
    pes.push(pe);
    prev = pe.pe_hash;
  }
  const actsRoot = actsRootOf(pes.map(actRecordOf));
  const batchHash = 'b1'.repeat(32);
  await store.recordBatch({
    seq: 1, batch_hash: batchHash, prev_batch_hash: METER_GENESIS_PREV_HASH, acts_root: actsRoot,
    first_index: 0, count: pes.length, last_pe_hash: prev, created_at_ms: 1, accepted_at_ms: 2, actor_id: ACTOR, totals: null,
  }, null);
  if (options.anchored !== false) {
    await store.recordProof({
      seq: 1, batch_hash: batchHash, acts_root: actsRoot, actor_id: ACTOR,
      batch_leaf: batchLeafOf({ device_id: DEVICE, actor_id: ACTOR, seq: 1, batch_hash: batchHash, acts_root: actsRoot }),
      anchor: {
        day: '2026-10-10', anchor_batch_id: '0x' + '9'.repeat(64), leaf_index: 0, leaf_count: 1,
        leaf_hash: '0x' + '8'.repeat(64), proof: ['0x' + '7'.repeat(64)], merkle_root: '0x' + '6'.repeat(64),
        anchor_tx_hash: '0x' + '5'.repeat(64), anchored_at_ms: 3,
      },
      fetched_at_ms: 4, verified: true,
    });
  }
  return { store, pes };
}

const req = (raw: Record<string, unknown>) => normalizeDisclosureRequests([raw])![0];

describe('storedPeMatches — selection by request kind', () => {
  const plain = { pe_hash: 'cc'.repeat(32), output_digests: [{ hash: DIGEST_A, kind: 'file' }] };
  const hardware = { pe_hash: 'dd'.repeat(32), hardware_witness: { scheme: 'tpm2_quote' } };
  const chain = { pe_hash: 'ee'.repeat(32), metadata: { verified: true, tx_hash: TX } };

  it('pe by output digest: the carrying PE matches; others do not (RED)', () => {
    const r = req({ kind: 'pe', output_digest: DIGEST_A });
    expect(storedPeMatches(plain, DEVICE, r)).toBe(true);
    expect(storedPeMatches(hardware, DEVICE, r)).toBe(false);
    expect(storedPeMatches({ ...plain, output_digests: [{ hash: 'b8'.repeat(32), kind: 'file' }] }, DEVICE, r)).toBe(false);
    // A PE's own hash is also an addressable digest.
    expect(storedPeMatches(hardware, DEVICE, req({ kind: 'pe', output_digest: 'dd'.repeat(32) }))).toBe(true);
  });

  it('pe by digest + issuer: the issuer must be the PE\'s witness (RED on another root)', () => {
    expect(storedPeMatches({ ...hardware, output_digests: [{ hash: DIGEST_A, kind: 'file' }] }, DEVICE, req({ kind: 'pe', output_digest: DIGEST_A, issuer: GCE_ROOT }))).toBe(true);
    expect(storedPeMatches({ ...hardware, output_digests: [{ hash: DIGEST_A, kind: 'file' }] }, DEVICE, req({ kind: 'pe', output_digest: DIGEST_A, issuer: NITRO_ROOT }))).toBe(false);
    expect(storedPeMatches(plain, DEVICE, req({ kind: 'pe', output_digest: DIGEST_A, issuer: GCE_ROOT }))).toBe(false);
    expect(storedPeMatches({ ...chain, output_digests: [{ hash: DIGEST_A, kind: 'file' }] }, DEVICE, req({ kind: 'pe', output_digest: DIGEST_A, issuer: 'chain:base' }))).toBe(true);
    expect(storedPeMatches(plain, DEVICE, req({ kind: 'pe', output_digest: DIGEST_A, issuer: 'chain:base' }))).toBe(false);
  });

  it('witness by issuer: a pinned root selects its scheme; chain:base selects verified transfers; an unknown issuer selects nothing', () => {
    expect(PINNED_ROOT_SCHEME[GCE_ROOT]).toBe('tpm2_quote');
    expect(storedPeMatches(hardware, DEVICE, req({ kind: 'witness', issuer: GCE_ROOT }))).toBe(true);
    expect(storedPeMatches(hardware, DEVICE, req({ kind: 'witness', issuer: NITRO_ROOT }))).toBe(false);
    expect(storedPeMatches(plain, DEVICE, req({ kind: 'witness', issuer: GCE_ROOT }))).toBe(false);
    expect(storedPeMatches(chain, DEVICE, req({ kind: 'witness', issuer: 'chain:base' }))).toBe(true);
    expect(storedPeMatches({ ...chain, metadata: { verified: false, tx_hash: TX } }, DEVICE, req({ kind: 'witness', issuer: 'chain:base' }))).toBe(false);
    expect(storedPeMatches({ ...chain, metadata: { verified: true } }, DEVICE, req({ kind: 'witness', issuer: 'chain:base' }))).toBe(false);
    expect(storedPeMatches(hardware, DEVICE, req({ kind: 'witness', issuer: 'ff'.repeat(32) }))).toBe(false);
  });

  it('witness by signer: this device id selects its own non-hardware PEs; a key fingerprint selects hardware-witnessed PEs; another device nothing', () => {
    expect(storedPeMatches(plain, DEVICE, req({ kind: 'witness', signer: DEVICE }))).toBe(true);
    expect(storedPeMatches(hardware, DEVICE, req({ kind: 'witness', signer: DEVICE }))).toBe(false);
    expect(storedPeMatches(hardware, DEVICE, req({ kind: 'witness', signer: 'ab'.repeat(32) }))).toBe(true);
    expect(storedPeMatches(plain, DEVICE, req({ kind: 'witness', signer: 'ab'.repeat(32) }))).toBe(false);
    expect(storedPeMatches(plain, DEVICE, req({ kind: 'witness', signer: 'dev_other' }))).toBe(false);
  });
});

describe('findDisclosureRecords — anchored records with proofs', () => {
  it('a pe request yields exactly the carrying PE with its two-hop proof', async () => {
    const { store, pes } = await buildStore();
    const r = await findDisclosureRecords(store, req({ kind: 'pe', output_digest: DIGEST_A }));
    expect(r.skipped).toEqual([]);
    expect(r.records.map((x) => x.peId)).toEqual(['pe_disc_0']);
    expect(r.records[0].envelopeHash).toBe(pes[0].pe_hash);
    expect(r.records[0].inclusion).toBeTruthy();
    expect((r.records[0].pe as PeV2).pe_id).toBe('pe_disc_0');
  });

  it('a witness-by-issuer request yields the hardware PE only; by signer, the device\'s own PEs newest first, bounded by limit', async () => {
    const { store } = await buildStore();
    const hw = await findDisclosureRecords(store, req({ kind: 'witness', issuer: GCE_ROOT }));
    expect(hw.records.map((x) => x.peId)).toEqual(['pe_disc_1']);
    const chain = await findDisclosureRecords(store, req({ kind: 'witness', issuer: 'chain:base' }));
    expect(chain.records.map((x) => x.peId)).toEqual(['pe_disc_2']);
    const own = await findDisclosureRecords(store, req({ kind: 'witness', signer: DEVICE }));
    expect(own.records.map((x) => x.peId)).toEqual(['pe_disc_2', 'pe_disc_0']);
    const one = await findDisclosureRecords(store, req({ kind: 'witness', signer: DEVICE, limit: 1 }));
    expect(one.records.map((x) => x.peId)).toEqual(['pe_disc_2']);
  });

  it('RED: a request nothing answers yields no records; an unanchored store yields SKIPPED entries, never a record', async () => {
    const { store } = await buildStore();
    const none = await findDisclosureRecords(store, req({ kind: 'pe', output_digest: 'b8'.repeat(32) }));
    expect(none.records).toEqual([]);
    expect(none.skipped).toEqual([]);
    const { store: unanchored } = await buildStore({ anchored: false });
    const r = await findDisclosureRecords(unanchored, req({ kind: 'witness', signer: DEVICE }));
    expect(r.records).toEqual([]);
    expect(r.skipped.map((s) => s.peId).sort()).toEqual(['pe_disc_0', 'pe_disc_2']);
    for (const s of r.skipped) expect(s.detail.length).toBeGreaterThan(0);
  });
});
