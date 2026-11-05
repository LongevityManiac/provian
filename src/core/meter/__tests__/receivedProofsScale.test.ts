/**
 * The daily received-proofs step at the size of a real backlog (findings, live 2026-10-23).
 *
 * On the operator’s phone this step held the JS thread for minutes on every launch: proving each received
 * PE rebuilt its whole batch tree (thousands of PEs → millions of interpreted SHA-256 calls, in one
 * synchronous loop), and nothing was kept until the very end, so a closed app started over.
 *
 * Pinned here:
 * - the proofs are the SAME as one-by-one proving (relay act leaves, and copies rebuilt here);
 * - each batch's tree is built once: hashing grows with N log N, not N² (RED: the one-by-one
 * builder over the same rows costs more than ten times as much);
 * - the walk gives the thread back by elapsed time, so no stretch runs past the slice by more than
 * one row (RED: unpaced, the whole run is one stretch);
 * - proven rows are kept in groups as they go, so a run cut short keeps them and the next run
 * picks up the rest (RED: one group at the end keeps nothing).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hashCount = vi.hoisted(() => ({ n: 0 }));
vi.mock('../meter-hash', async () => {
    const { sha256 } = await import('@noble/hashes/sha256');
    return { sha256Bytes: (data: Uint8Array): Uint8Array => { hashCount.n += 1; return sha256(data); } };
});

import { actLeafOf, actRecordOf, actsRootOf, batchLeafOf, merkleProofOf, METER_GENESIS_PREV_HASH } from '../meter-wire';
import { anchoredLeafOf, foldAnchorProof, inclusionFromLeaves, meterAnchorBatchIdOf, PE_EXPORT_PE_ANCHOR, type ExportBatchAnchor } from '../pe-export-wire';
import type { MeterAnswer } from '../meterTransport';
import { MemoryMeterFiles } from '../meterFiles';
import { buildPhonePeV2 } from '../phonePeBuilder';
import { PhonePeStore, type ReceivedPe, type StoredPeV2 } from '../phonePeStore';
import { attachMissingReceivedProofs, receivedInclusionOf, type RelayBatchProof } from '../receivedProofs';
import { cpuBudget, UNPACED } from '../cpuBudget';
import { DEVICE, envelope } from './meterTestkit';

const AGENT_DEVICE = 'dev_' + 'c7'.repeat(32);
const AGENT_ACTOR = 'agent_scale';
const DAY = '2026-10-22';
const MS = Date.UTC(2026, 9, 22, 6);
const h = (n: number): string => n.toString(16).padStart(2, '0').repeat(32);

async function chainOf(n: number): Promise<StoredPeV2[]> {
    const out: StoredPeV2[] = [];
    let prev = METER_GENESIS_PREV_HASH;
    for (let i = 0; i < n; i++) {
        const pe = await buildPhonePeV2({ envelope: envelope({ action_type: 'agent_tool_orchestration' }), detailHash: 'e'.repeat(64), deviceId: AGENT_DEVICE, prevHash: prev });
        out.push(pe);
        prev = pe.pe_hash;
    }
    return out;
}

interface Spec { seq: number; batchHash: string; pes: StoredPeV2[]; withLeaves: boolean }

function leafOf(s: Spec): string {
    return batchLeafOf({ device_id: AGENT_DEVICE, actor_id: AGENT_ACTOR, seq: s.seq, batch_hash: s.batchHash, acts_root: actsRootOf(s.pes.map((p) => actRecordOf(p))) });
}

/** Two batches anchored on one day: the day root folds the two anchored batch leaves. */
function recordsOf(a: Spec, b: Spec): RelayBatchProof[] {
    const la = anchoredLeafOf(leafOf(a));
    const lb = anchoredLeafOf(leafOf(b));
    const root = foldAnchorProof(la, [lb]);
    const anchor = (i: number): ExportBatchAnchor => ({
        day: DAY, anchor_batch_id: meterAnchorBatchIdOf(DAY), leaf_index: i, leaf_count: 2, leaf_hash: i === 0 ? la : lb,
        proof: [i === 0 ? lb : la], merkle_root: root, tx_hash: '0x' + '5'.repeat(64),
    } as ExportBatchAnchor);
    return [a, b].map((s, i) => ({
        batch_hash: s.batchHash, device_id: AGENT_DEVICE, actor_id: AGENT_ACTOR, seq: s.seq, acts_root: actsRootOf(s.pes.map((p) => actRecordOf(p))),
        batch_leaf: leafOf(s), day: DAY, accepted_at_ms: MS, anchored: true, chain_id: 8453, anchor_contract: PE_EXPORT_PE_ANCHOR,
        anchor: anchor(i), act_leaves: s.withLeaves ? s.pes.map((p) => actLeafOf(actRecordOf(p))) : null,
    }));
}

function relay(records: readonly RelayBatchProof[]): (hashes: readonly string[]) => Promise<MeterAnswer> {
    return async (hashes) => ({
        status: 200, error: null,
        body: {
            batches: records.filter((r) => hashes.includes(r.batch_hash)).map((r) => ({
                ...r, anchor: r.anchor === null ? null : { ...r.anchor, anchor_tx_hash: r.anchor.tx_hash, anchored_at_ms: MS + 1 },
            })),
            missing: hashes.filter((x) => !records.some((r) => r.batch_hash === x)),
        },
    });
}

function receivedRow(pe: StoredPeV2, batchHash: string, i: number): ReceivedPe {
    return {
        mailbox_id: `mb_${batchHash.slice(0, 4)}_${i}`, pe_id: pe.pe_id, format: 'pe_v2', pe, pe_hash: pe.pe_hash, from_device: AGENT_DEVICE,
        from_actor: AGENT_ACTOR, batch_hash: batchHash, created_at_ms: MS, received_at_ms: MS + 1000,
    };
}

/** A person holding `withLeaves` PEs of one batch the relay keeps leaves for, and `copies` of an older one it does not. */
async function backlog(withLeaves: number, copies: number): Promise<{ store: PhonePeStore; records: RelayBatchProof[]; a: Spec; b: Spec }> {
    const chain = await chainOf(withLeaves + copies);
    const a: Spec = { seq: 1, batchHash: h(0xa1), pes: chain.slice(0, withLeaves), withLeaves: true };
    const b: Spec = { seq: 2, batchHash: h(0xb2), pes: chain.slice(withLeaves), withLeaves: false };
    const store = new PhonePeStore(new MemoryMeterFiles());
    await store.open(DEVICE);
    await store.recordReceivedMany([...a.pes.map((p, i) => receivedRow(p, a.batchHash, i)), ...b.pes.map((p, i) => receivedRow(p, b.batchHash, i))]);
    return { store, records: recordsOf(a, b), a, b };
}

beforeEach(() => {
    hashCount.n = 0;
});

describe('received proofs at the size of a real backlog', () => {
    it('each proof is exactly what one-by-one proving builds, for relay leaves and for copies rebuilt here', async () => {
        const { store, records, a, b } = await backlog(90, 40);
        const report = await attachMissingReceivedProofs(store, relay(records), { budget: UNPACED, attachEvery: 25 });
        expect(report).toMatchObject({ ok: true, considered: 130, attached: 130, notAnchoredYet: 0 });
        const rows = new Map((await store.listReceivedRows()).map((r) => [r.pe_hash, r]));
        for (const [spec, record] of [[a, records[0]], [b, records[1]]] as const) {
            const leaves = spec.pes.map((p) => actLeafOf(actRecordOf(p)));
            spec.pes.forEach((pe, at) => {
                const expected = inclusionFromLeaves({
                    leaves, at, device_id: AGENT_DEVICE, actor_id: AGENT_ACTOR, seq: spec.seq, batch_hash: spec.batchHash, acts_root: record.acts_root, anchor: record.anchor,
                });
                expect(rows.get(pe.pe_hash)?.inclusion).toEqual(expected);
                expect(expected.act_proof).toEqual(merkleProofOf(leaves, at));
            });
        }
    });

    it('builds each batch tree once: hashing stays near N log N (RED: proving one by one costs over ten times as much)', async () => {
        const { store, records, a, b } = await backlog(400, 200);
        hashCount.n = 0;
        await attachMissingReceivedProofs(store, relay(records), { budget: UNPACED });
        const shared = hashCount.n;

        // RED control: the one-by-one builder (a fresh tree per row) over the same rows.
        hashCount.n = 0;
        const rows = (await store.listReceivedRows()) as ReceivedPe[];
        for (const row of rows) {
            const isA = row.batch_hash === a.batchHash;
            const copies = rows.filter((r) => r.batch_hash === row.batch_hash) as (ReceivedPe & { pe: StoredPeV2 })[];
            const out = receivedInclusionOf(row as ReceivedPe & { pe: StoredPeV2 }, isA ? records[0] : records[1], copies);
            expect(out.status).toBe('anchored');
        }
        const oneByOne = hashCount.n;
        expect(b.pes.length + a.pes.length).toBe(600);
        expect(oneByOne).toBeGreaterThan(shared * 10);
        // The bound itself: per row a handful of hashes to verify, plus two trees (about 2 per leaf each).
        expect(shared).toBeLessThan(600 * 60);
    }, 120_000);

    it('gives the thread back by elapsed time; no stretch runs much past the slice (RED: a slice that never ends is one stretch)', async () => {
        const { store, records } = await backlog(300, 100);
        // The clock is the work itself: one tick per SHA-256, the cost that froze the phone.
        const SLICE = 200;
        const stretches: number[] = [];
        let since = 0;
        hashCount.n = 0;
        const budget = cpuBudget({
            sliceMs: SLICE,
            now: () => hashCount.n,
            yieldToUi: async () => { stretches.push(hashCount.n - since); since = hashCount.n; },
        });
        await attachMissingReceivedProofs(store, relay(records), { budget });
        stretches.push(hashCount.n - since);
        expect(stretches.length).toBeGreaterThan(20);
        // At most one slice plus one row — and the one row that builds a batch tree (two hashes per
        // leaf of a 300-act batch, plus each act's leaf when rebuilt from copies here).
        expect(Math.max(...stretches)).toBeLessThan(SLICE + 1_000);

        // RED control: the same measurement with a slice that never ends sees one unbroken stretch.
        const again = await backlog(300, 100);
        const none: number[] = [];
        hashCount.n = 0;
        await attachMissingReceivedProofs(again.store, relay(again.records), {
            budget: cpuBudget({ sliceMs: Number.POSITIVE_INFINITY, now: () => hashCount.n, yieldToUi: async () => { none.push(hashCount.n); } }),
        });
        expect(none).toEqual([]);
        expect(hashCount.n).toBeGreaterThan(SLICE + 1_000);
    }, 120_000);

    it('keeps proven rows in groups as it goes: a run cut short keeps them, the next run finishes the rest (RED: one group at the end keeps none)', async () => {
        const { store, records } = await backlog(80, 40);
        const real = store.attachReceivedInclusions.bind(store);
        let calls = 0;
        const spy = vi.spyOn(store, 'attachReceivedInclusions').mockImplementation(async (items, options) => {
            calls += 1;
            if (calls === 3) throw new Error('app closed');
            return real(items, options);
        });
        await expect(attachMissingReceivedProofs(store, relay(records), { budget: UNPACED, attachEvery: 40 })).rejects.toThrow('app closed');
        const kept = (await store.listReceivedRows()).filter((r) => r.inclusion !== undefined).length;
        expect(kept).toBe(80);
        spy.mockRestore();
        const next = await attachMissingReceivedProofs(store, relay(records), { budget: UNPACED, attachEvery: 40 });
        expect(next).toMatchObject({ considered: 40, attached: 40 });
        expect((await store.listReceivedRows()).every((r) => r.inclusion !== undefined)).toBe(true);

        // RED control: one group for the whole run — cut short, nothing is kept.
        const red = await backlog(80, 40);
        vi.spyOn(red.store, 'attachReceivedInclusions').mockImplementation(async () => { throw new Error('app closed'); });
        await expect(attachMissingReceivedProofs(red.store, relay(red.records), { budget: UNPACED, attachEvery: 1_000 })).rejects.toThrow('app closed');
        expect((await red.store.listReceivedRows()).filter((r) => r.inclusion !== undefined).length).toBe(0);
    }, 120_000);
});
