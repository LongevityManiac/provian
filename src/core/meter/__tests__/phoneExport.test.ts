/**
 * "Export all my PEs" (complete PE export, `provian.pe-export.v1`) and the received-PE proofs kept
 * with their rows.
 *
 * The main case builds everything a person can hold — two device chains (this phone + a restored
 * previous phone) with batches, receipts and REAL anchor proofs (keccak day trees the verifier folds),
 * positions dropped to the person's own Archive, a linked agent's PEs (held with relay act leaves,
 * held without them, a copy dropped to the agent's Archive, and one only in the agent's Archive day),
 * a relay-handed-back v1 record, pre-meter history and a not-yet-metered activity record — and
 * checks the finished file with the format's own offline verifier plus a Base read through a fake
 * eth_call: zero failures, zero gaps, every record type present.
 *
 * RED controls beside it : an archived entry that is not the PE its pointer names is never
 * emitted and is named in `incomplete`; a received PE with no obtainable proof is
 * `proof_unavailable` and named; `attachReceivedInclusions` refuses a hash mismatch and changes
 * nothing; the daily step keeps only anchored proofs.
 */
import { describe, expect, it } from 'vitest';
import type { ProvenanceEnvelope } from '../../provenance/types';
import {
    actLeafOf,
    actRecordOf,
    actsRootOf,
    batchLeafOf,
    METER_GENESIS_PREV_HASH,
    type ActInclusionProof,
} from '../meter-wire';
import {
    anchoredLeafOf,
    foldAnchorProof,
    getBatchCalldata,
    meterAnchorBatchIdOf,
    parseExport,
    PE_EXPORT_PE_ANCHOR,
    recordHashOf,
    verifyAnchorsOnChain,
    verifyExportOffline,
    type ExportBodyLine,
} from '../pe-export-wire';
import { buildArchiveEntries, type ArchivePayload } from '../pe-archive-wire';
import type { MeterAnswer } from '../meterTransport';
import { MemoryMeterFiles } from '../meterFiles';
import { buildPhonePeV2 } from '../phonePeBuilder';
import {
    isArchivedReceived,
    PhonePeStore,
    type DeviceChainStore,
    type MeterBatchReceiptWire,
    type ReceivedPe,
    type StoredPeV2,
} from '../phonePeStore';
import { buildPhonePeExport, type PhonePeExportArchive } from '../phoneExport';
import { attachMissingReceivedProofs, oneActRootOf, receivedInclusionOf, type RelayBatchProof } from '../receivedProofs';
import { PhoneBatcher } from '../phoneBatcher';
import { MemoryCloudFiles } from '../cloudFiles';
import { deriveArchiveKey, PeCloudBackup, type BackupKeyProvider } from '../peCloudBackup';
import { ACTOR, DEVICE, envelope, FakeRelay, T0 } from './meterTestkit';

const WALLET = 'wallet_doc_person';
const ADDRESS = '0x' + 'ab'.repeat(20);
const OLD_PHONE = 'device_old_phone_0001';
const AGENT_WALLET = 'aw_linked_agent';
const AGENT_DEVICE = 'dev_' + 'b4'.repeat(32);
const AGENT_ACTOR = 'agent_linked';
const OLD_DAY = '2026-10-01';
const RECENT_DAY = '2026-11-10';
const OLD_MS = Date.UTC(2026, 9, 1, 6);
const RECENT_MS = Date.UTC(2026, 10, 10, 6);
const NOW = Date.UTC(2026, 10, 20, 12);
const CUTOVER = T0;

// ─── fixtures ─────────────────────────────────────────────────────────────────────

/** Build and append `n` PEs (each with its full on-phone record as detail, committed by detail_hash). */
async function appendPes(chain: DeviceChainStore, n: number): Promise<{ pes: StoredPeV2[]; envs: ProvenanceEnvelope[] }> {
    const pes: StoredPeV2[] = [];
    const envs: ProvenanceEnvelope[] = [];
    for (let i = 0; i < n; i++) {
        const env = envelope();
        const head = await chain.head();
        const pe = await buildPhonePeV2({
            envelope: env,
            detailHash: recordHashOf(env as unknown as Record<string, unknown>),
            deviceId: chain.deviceId,
            prevHash: head.last_pe_hash,
        });
        const res = await chain.append(pe, { detail: env });
        if (!res.ok) throw new Error(`append failed: ${res.reason}`);
        pes.push(pe);
        envs.push(env);
    }
    return { pes, envs };
}

/** A chain of PEs of another device (a linked agent's), not held in any chain here. */
async function agentPes(n: number): Promise<StoredPeV2[]> {
    const out: StoredPeV2[] = [];
    let prev = METER_GENESIS_PREV_HASH;
    for (let i = 0; i < n; i++) {
        const env = envelope({ action_type: 'agent_tool_orchestration' });
        const pe = await buildPhonePeV2({ envelope: env, detailHash: 'e'.repeat(64), deviceId: AGENT_DEVICE, prevHash: prev });
        out.push(pe);
        prev = pe.pe_hash;
    }
    return out;
}

/** One day's keccak tree over batch leaves: each leaf's proof and the day root PEAnchor would hold. */
function dayTree(batchLeaves: readonly string[]): { root: string; proofs: string[][] } {
    let level = batchLeaves.map((l) => anchoredLeafOf(l));
    const proofs: string[][] = batchLeaves.map(() => []);
    let members: number[][] = batchLeaves.map((_, i) => [i]);
    while (level.length > 1) {
        const next: string[] = [];
        const nextMembers: number[][] = [];
        for (let i = 0; i < level.length; i += 2) {
            if (i + 1 >= level.length) {
                next.push(level[i]);
                nextMembers.push(members[i]);
                continue;
            }
            for (const m of members[i]) proofs[m].push(level[i + 1]);
            for (const m of members[i + 1]) proofs[m].push(level[i]);
            next.push(foldAnchorProof(level[i], [level[i + 1]]));
            nextMembers.push([...members[i], ...members[i + 1]]);
        }
        level = next;
        members = nextMembers;
    }
    return { root: level[0], proofs };
}

interface BatchSpec { device: string; actor: string; seq: number; batchHash: string; pes: StoredPeV2[]; firstIndex: number; day: string }

function leafOf(b: BatchSpec): string {
    return batchLeafOf({ device_id: b.device, actor_id: b.actor, seq: b.seq, batch_hash: b.batchHash, acts_root: actsRootOf(b.pes.map((p) => actRecordOf(p))) });
}

/** Every batch's anchor, from the day trees of all batches anchored on each day. */
function anchorsFor(specs: readonly BatchSpec[]): Map<string, { day: string; anchor_batch_id: string; leaf_index: number; leaf_count: number; leaf_hash: string; proof: string[]; merkle_root: string; anchor_tx_hash: string }> {
    const out = new Map<string, { day: string; anchor_batch_id: string; leaf_index: number; leaf_count: number; leaf_hash: string; proof: string[]; merkle_root: string; anchor_tx_hash: string }>();
    const days = [...new Set(specs.map((s) => s.day))];
    for (const day of days) {
        const onDay = specs.filter((s) => s.day === day);
        const tree = dayTree(onDay.map(leafOf));
        onDay.forEach((s, i) => {
            out.set(s.batchHash, {
                day, anchor_batch_id: meterAnchorBatchIdOf(day), leaf_index: i, leaf_count: onDay.length,
                leaf_hash: anchoredLeafOf(leafOf(s)), proof: tree.proofs[i], merkle_root: tree.root, anchor_tx_hash: '0x' + '5'.repeat(64),
            });
        });
    }
    return out;
}

function receiptOf(b: BatchSpec): MeterBatchReceiptWire {
    return {
        schema: 'provian.pe-batch-receipt.v1', device_id: b.device, actor_id: b.actor, seq: b.seq, batch_hash: b.batchHash,
        acts_root: actsRootOf(b.pes.map((p) => actRecordOf(p))), batch_leaf: leafOf(b), accepted_at_ms: Date.parse(`${b.day}T06:01:00Z`),
        acts: b.pes.map((p, i) => ({ pe_id: p.pe_id, pe_hash: p.pe_hash, relay_pe_id: `rpe_${p.pe_id}`, leaf_index: i, disposition: 'eligible', reason: 'ok', record_points_atomic: '1', mint_status: 'eligible' })),
        totals: { eligible_points_atomic: String(b.pes.length), acts: b.pes.length, eligible: b.pes.length },
    };
}

/** File a batch of this phone's (or a restored phone's) chain with its receipt and verified proof. */
async function fileBatch(chain: DeviceChainStore, b: BatchSpec, anchor: ReturnType<typeof anchorsFor> extends Map<string, infer A> ? A : never): Promise<void> {
    const prior = await chain.lastBatch();
    const actsRoot = actsRootOf(b.pes.map((p) => actRecordOf(p)));
    await chain.recordBatch({
        seq: b.seq, batch_hash: b.batchHash, prev_batch_hash: prior?.batch_hash ?? METER_GENESIS_PREV_HASH, acts_root: actsRoot,
        first_index: b.firstIndex, count: b.pes.length, last_pe_hash: b.pes[b.pes.length - 1].pe_hash,
        created_at_ms: Date.parse(`${b.day}T06:00:00Z`), accepted_at_ms: Date.parse(`${b.day}T06:01:00Z`), actor_id: b.actor, totals: null,
    }, receiptOf(b));
    await chain.recordProof({
        seq: b.seq, batch_hash: b.batchHash, batch_leaf: leafOf(b), acts_root: actsRoot, actor_id: b.actor,
        chain_id: 8453, anchor_contract: PE_EXPORT_PE_ANCHOR, anchor, fetched_at_ms: NOW, verified: true,
    });
}

function payloadOf(wallet: string, day: string, device: string, b: BatchSpec, anchor: { anchor_batch_id: string; leaf_index: number; proof: string[]; merkle_root: string; anchor_tx_hash: string }): ArchivePayload {
    const { entries } = buildArchiveEntries(day, [{
        device_id: device, actor_id: b.actor, seq: b.seq, batch_hash: b.batchHash, acts_root: actsRootOf(b.pes.map((p) => actRecordOf(p))),
        batch_leaf: leafOf(b), first_index: b.firstIndex, pes: b.pes,
        anchor: { day, anchor_batch_id: anchor.anchor_batch_id, leaf_index: anchor.leaf_index, proof: anchor.proof, merkle_root: anchor.merkle_root, tx_hash: anchor.anchor_tx_hash },
    }]);
    return { schema: 'provian.pe-archive-payload.v1', wallet, day, device_id: device, part: 0, entries };
}

class FakeExportArchive implements PhonePeExportArchive {
    readonly days = new Map<string, ArchivePayload[]>();
    linked: { wallet: string; day: string }[] = [];
    pulls: string[] = [];
    async readStatus(): Promise<{ wallet: string; on: boolean }> {
        return { wallet: WALLET, on: true };
    }
    async listDayKeys(scope: 'own' | 'linked'): Promise<{ wallet: string; day: string }[]> {
        if (scope === 'linked') return this.linked;
        return [...this.days.keys()].filter((k) => k.startsWith(`${WALLET}/`)).map((k) => ({ wallet: WALLET, day: k.slice(WALLET.length + 1) }));
    }
    async pullDay(wallet: string, day: string, partyId: string): Promise<{ ok: true; payloads: ArchivePayload[] } | { ok: false; reason: string }> {
        this.pulls.push(`${wallet}/${day}@${partyId}`);
        const p = this.days.get(`${wallet}/${day}`);
        return p ? { ok: true, payloads: p } : { ok: false, reason: 'archive_day_unreadable:404' };
    }
}

function relayRecord(b: BatchSpec, anchor: ReturnType<typeof anchorsFor> extends Map<string, infer A> ? A : never, withLeaves: boolean, anchored = true): RelayBatchProof {
    return {
        batch_hash: b.batchHash, device_id: b.device, actor_id: b.actor, seq: b.seq, acts_root: actsRootOf(b.pes.map((p) => actRecordOf(p))),
        batch_leaf: leafOf(b), day: b.day, accepted_at_ms: Date.parse(`${b.day}T06:01:00Z`), anchored, chain_id: 8453,
        anchor_contract: PE_EXPORT_PE_ANCHOR,
        anchor: anchored ? { day: anchor.day, anchor_batch_id: anchor.anchor_batch_id, leaf_index: anchor.leaf_index, leaf_count: anchor.leaf_count, leaf_hash: anchor.leaf_hash, proof: anchor.proof, merkle_root: anchor.merkle_root, tx_hash: anchor.anchor_tx_hash } : null,
        act_leaves: withLeaves ? b.pes.map((p) => actLeafOf(actRecordOf(p))) : null,
    };
}

/**
 * The relay's `/v1/meter/mobile/batch-proofs` over a set of batch records (wire shape, as JSON):
 * by batch hash, and by one-act `acts_root` for relay-authored batches only (`relay:` device, one act).
 */
function fakeBatchProofs(records: readonly RelayBatchProof[], calls: string[][] = [], rootCalls: string[][] = []): (hashes: readonly string[], roots?: readonly string[]) => Promise<MeterAnswer> {
    return async (hashes, roots = []) => {
        calls.push([...hashes]);
        if (roots.length > 0) rootCalls.push([...roots]);
        const byHash = records.filter((r) => hashes.includes(r.batch_hash));
        const byRoot = records.filter((r) => roots.includes(r.acts_root) && r.device_id.startsWith('relay:') && r.act_leaves !== null && r.act_leaves.length === 1);
        const found = [...byHash, ...byRoot.filter((r) => !byHash.includes(r))];
        return {
            status: 200, error: null,
            body: {
                batches: found.map((r) => ({
                    batch_hash: r.batch_hash, device_id: r.device_id, actor_id: r.actor_id, seq: r.seq, acts_root: r.acts_root, batch_leaf: r.batch_leaf,
                    day: r.day, accepted_at_ms: r.accepted_at_ms, anchored: r.anchored, chain_id: r.chain_id, anchor_contract: r.anchor_contract,
                    anchor: r.anchor === null ? null : { ...r.anchor, anchor_tx_hash: r.anchor.tx_hash, anchored_at_ms: NOW },
                    act_leaves: r.act_leaves,
                })),
                missing: hashes.filter((h) => !byHash.some((r) => r.batch_hash === h)),
                ...(roots.length > 0 ? { missing_acts_roots: roots.filter((x) => !byRoot.some((r) => r.acts_root === x)) } : {}),
            },
        };
    };
}

function received(pe: StoredPeV2, batchHash: string, mailboxId: string): ReceivedPe {
    return {
        mailbox_id: mailboxId, pe_id: pe.pe_id, format: 'pe_v2', pe, pe_hash: pe.pe_hash, from_device: pe.device_id,
        from_actor: AGENT_ACTOR, batch_hash: batchHash, created_at_ms: RECENT_MS, received_at_ms: RECENT_MS + 1000,
    };
}

const h = (n: number): string => n.toString(16).padStart(2, '0').repeat(32);

/** The whole person: two chains, the Archive, a linked agent, legacy. */
async function person(): Promise<{
    store: PhonePeStore;
    files: MemoryMeterFiles;
    archive: FakeExportArchive;
    relayRecords: RelayBatchProof[];
    hot: ProvenanceEnvelope[];
    own: { pes: StoredPeV2[]; envs: ProvenanceEnvelope[] };
    ownBatch1: BatchSpec;
    agent: StoredPeV2[];
    anchors: ReturnType<typeof anchorsFor>;
}> {
    const files = new MemoryMeterFiles();
    const store = new PhonePeStore(files);
    await store.open(DEVICE);
    const own = await appendPes(store.own(), 6);
    const oldChain = await store.chain(OLD_PHONE);
    const old = await appendPes(oldChain, 2);
    const agent = await agentPes(7);

    const ownBatch1: BatchSpec = { device: DEVICE, actor: ACTOR, seq: 1, batchHash: h(1), pes: own.pes.slice(0, 3), firstIndex: 0, day: OLD_DAY };
    const ownBatch2: BatchSpec = { device: DEVICE, actor: ACTOR, seq: 2, batchHash: h(2), pes: own.pes.slice(3, 5), firstIndex: 3, day: RECENT_DAY };
    const oldBatch: BatchSpec = { device: OLD_PHONE, actor: ACTOR, seq: 1, batchHash: h(3), pes: old.pes, firstIndex: 0, day: OLD_DAY };
    const agentA: BatchSpec = { device: AGENT_DEVICE, actor: AGENT_ACTOR, seq: 1, batchHash: h(4), pes: agent.slice(0, 3), firstIndex: 0, day: RECENT_DAY };
    const agentB: BatchSpec = { device: AGENT_DEVICE, actor: AGENT_ACTOR, seq: 2, batchHash: h(5), pes: agent.slice(3, 5), firstIndex: 3, day: RECENT_DAY };
    const agentC: BatchSpec = { device: AGENT_DEVICE, actor: AGENT_ACTOR, seq: 3, batchHash: h(6), pes: agent.slice(5, 7), firstIndex: 5, day: OLD_DAY };
    const anchors = anchorsFor([ownBatch1, ownBatch2, oldBatch, agentA, agentB, agentC]);
    const a = (b: BatchSpec): NonNullable<ReturnType<typeof anchors.get>> => {
        const x = anchors.get(b.batchHash);
        if (!x) throw new Error('no anchor');
        return x;
    };
    await fileBatch(store.own(), ownBatch1, a(ownBatch1));
    await fileBatch(store.own(), ownBatch2, a(ownBatch2));
    await fileBatch(oldChain, oldBatch, a(oldBatch));
    // own PE #5 is recorded but not batched yet (pending, never a failure)

    // The old day of this phone's chain is in the person's Archive and dropped here (pointers).
    const archive = new FakeExportArchive();
    archive.days.set(`${WALLET}/${OLD_DAY}`, [payloadOf(WALLET, OLD_DAY, DEVICE, ownBatch1, a(ownBatch1))]);
    await store.own().dropArchivedDay({ day: OLD_DAY, wallet: WALLET, pes: ownBatch1.pes.map((p, i) => ({ index: i, pe_id: p.pe_id, pe_hash: p.pe_hash })) });

    // A linked agent's PEs sealed to the person.
    await store.recordReceivedMany([
        received(agent[0], agentA.batchHash, 'mb_a0'),
        received(agent[1], agentA.batchHash, 'mb_a1'),
        received(agent[3], agentB.batchHash, 'mb_b3'),
        received(agent[4], agentB.batchHash, 'mb_b4'),
        received(agent[5], agentC.batchHash, 'mb_c5'),
    ]);
    // The agent's old day is in ITS Archive (sealed to the person too); the person's copy dropped.
    archive.days.set(`${AGENT_WALLET}/${OLD_DAY}`, [payloadOf(AGENT_WALLET, OLD_DAY, AGENT_DEVICE, agentC, a(agentC))]);
    archive.linked = [{ wallet: AGENT_WALLET, day: OLD_DAY }];
    await store.dropReceivedArchived(OLD_DAY, AGENT_WALLET, [{ mailbox_id: 'mb_c5', pe_hash: agent[5].pe_hash }]);
    // A pre-meter record the relay handed back.
    await store.recordReceivedMany([{
        mailbox_id: 'mb_v1', pe_id: 'v1_env_1', format: 'v1_envelope',
        pe: { id: 'v1_env_1', hash: 'f'.repeat(64), prev_hash: 'GENESIS', timestamp: T0 - 99_000_000, action_type: 'wallet_created' },
        pe_hash: 'f'.repeat(64), from_device: 'relay:user_1', from_actor: 'user_1', batch_hash: '', created_at_ms: T0, received_at_ms: T0,
    }]);
    // Legacy: one pre-meter record kept by the store; the activity tiers hold every metered record
    // (their details) plus one current record not metered yet.
    await store.addLegacy([envelope({ timestamp: T0 - 50_000_000 })]);
    const notYet = envelope({ timestamp: T0 + 9_999_999 });
    const hot = [...own.envs, ...old.envs, notYet];
    const relayRecords = [relayRecord(agentA, a(agentA), true), relayRecord(agentB, a(agentB), false)];
    return { store, files, archive, relayRecords, hot, own, ownBatch1, agent, anchors };
}

function deps(p: Awaited<ReturnType<typeof person>>, over: Partial<Parameters<typeof buildPhonePeExport>[0]> = {}): Parameters<typeof buildPhonePeExport>[0] {
    return {
        store: p.store,
        archive: p.archive,
        batchProofs: fakeBatchProofs(p.relayRecords),
        activity: { hot: async () => p.hot, archived: async () => [] },
        cutoverMs: CUTOVER,
        owner: { walletId: WALLET, address: ADDRESS },
        appVersion: '9.9.9 (test)',
        mailbox: { waiting: 0, truncated: false, reason: null },
        now: () => NOW,
        ...over,
    };
}

function byType<T extends ExportBodyLine['type']>(body: readonly ExportBodyLine[], type: T): Extract<ExportBodyLine, { type: T }>[] {
    return body.filter((l): l is Extract<ExportBodyLine, { type: T }> => l.type === type);
}

/** getBatch's ABI return for a root: (root, peCount, timestamp, epoch, exists). */
function getBatchResult(root: string): string {
    const w = (hex: string): string => hex.replace(/^0x/, '').padStart(64, '0');
    return '0x' + w(root) + w('1') + w('6a') + w('0') + w('1');
}

// ─── the complete export ─────────────────────────────────────────────────────────

describe('buildPhonePeExport — one file with everything the person holds', () => {
    it('verifies with zero failures and zero gaps, carries every record type, and its day roots match Base', async () => {
        const p = await person();
        const result = await buildPhonePeExport(deps(p));
        expect(result.incomplete).toEqual([]);
        expect(result.complete).toBe(true);
        expect(result.verdict).toBe('offline_ok');
        const parsed = parseExport(result.text);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        const report = verifyExportOffline(parsed.body);
        expect(report.failures).toEqual([]);
        expect(report.gaps).toEqual([]);
        expect(result.report.failures).toEqual([]);

        // Header: owner, both chains (this phone first), the Archive days pulled.
        expect(parsed.header.owner).toEqual({ kind: 'human', wallet_id: WALLET, address: ADDRESS });
        expect(parsed.header.producer).toEqual({ kind: 'app', version: '9.9.9 (test)' });
        expect(parsed.header.devices).toEqual([DEVICE, OLD_PHONE]);
        expect(parsed.header.archive.state).toBe('on');
        expect(parsed.header.archive.days.map((d) => `${d.wallet}/${d.day}:${d.pulled}`).sort())
            .toEqual([`${AGENT_WALLET}/${OLD_DAY}:true`, `${WALLET}/${OLD_DAY}:true`]);
        expect(result.fileName).toBe('provian-pe-export-wallet_doc_person-20261120T120000Z.jsonl');

        // pe lines: 6 own (3 pulled back from the Archive, 2 anchored here, 1 not batched) + 2 restored.
        const pe = byType(parsed.body, 'pe');
        expect(pe.map((l) => `${l.device_id}#${l.index}:${l.source}:${l.status}`)).toEqual([
            `${DEVICE}#0:archive:anchored`, `${DEVICE}#1:archive:anchored`, `${DEVICE}#2:archive:anchored`,
            `${DEVICE}#3:device:anchored`, `${DEVICE}#4:device:anchored`, `${DEVICE}#5:device:not_batched_yet`,
            `${OLD_PHONE}#0:device:anchored`, `${OLD_PHONE}#1:device:anchored`,
        ]);
        // Every own PE carries its private detail (from the store, or matched from the activity record).
        expect(pe.every((l) => l.detail !== undefined)).toBe(true);
        expect(report.counts.pe).toEqual({ total: 8, proven_to_root: 7, pending: 1 });

        // batch lines: both chains' batches, each with its receipt and its anchor.
        const batches = byType(parsed.body, 'batch');
        expect(batches.map((b) => `${b.device_id}#${b.seq}`)).toEqual([`${DEVICE}#1`, `${DEVICE}#2`, `${OLD_PHONE}#1`]);
        expect(batches.every((b) => b.receipt !== null && b.anchor !== null)).toBe(true);
        expect(report.counts.batch).toEqual({ total: 3, proven_to_root: 3, pending: 0 });

        // received: with relay act leaves (a0, a1), rebuilt from held copies (b3, b4), the copy dropped
        // to the agent's Archive (c5), and the agent's archived PE the person never held (c6).
        const rec = byType(parsed.body, 'received');
        expect(rec.map((l) => `${l.pe.pe_id === p.agent[6].pe_id ? 'c6' : l.mailbox_id}:${l.source}:${l.status}`).sort()).toEqual([
            'c6:archive:anchored', 'mb_a0:device:anchored', 'mb_a1:device:anchored', 'mb_b3:device:anchored', 'mb_b4:device:anchored', 'mb_c5:archive:anchored',
        ]);
        expect(report.counts.received).toEqual({ total: 6, proven_to_root: 6, pending: 0 });

        // legacy: the handed-back v1 record, the store's pre-meter record, the not-yet-metered one —
        // and none of the records that are a PE's detail.
        const legacy = byType(parsed.body, 'legacy');
        expect(legacy.map((l) => `${l.source}:${l.status}`).sort()).toEqual(['device_history:not_yet_metered', 'device_history:pre_meter', 'handed_back:pre_meter']);
        const metered = new Set(pe.map((l) => l.pe.pe_id));
        expect(legacy.some((l) => metered.has(l.id))).toBe(false);
        expect(report.counts.legacy).toEqual({ total: 3, hash_checked: 2, hash_unverifiable: 1, unanchorable: 3 }); // the handed-back fixture is synthetic: no writer recipe reproduces it

        // The day roots the file rests on are the ones on Base (fake eth_call over the same trees).
        const roots = new Map([...p.anchors.values()].map((x) => [x.anchor_batch_id, x.merkle_root]));
        const checks = await verifyAnchorsOnChain(report.anchors, async (to, data) => {
            expect(to).toBe(PE_EXPORT_PE_ANCHOR);
            const id = [...roots.keys()].find((k) => getBatchCalldata(k) === data);
            if (id === undefined) throw new Error('unknown day');
            return getBatchResult(roots.get(id) as string);
        });
        expect(checks.length).toBe(2);
        expect(checks.every((c) => c.ok)).toBe(true);

        // The proofs fetched for the received PEs were KEPT with their rows (the relay drops them later).
        const rows = (await p.store.listReceivedRows()).filter((r): r is ReceivedPe => !isArchivedReceived(r) && r.format !== 'v1_envelope');
        expect(rows.map((r) => [r.mailbox_id, r.inclusion?.anchor?.day ?? null])).toEqual([
            ['mb_a0', RECENT_DAY], ['mb_a1', RECENT_DAY], ['mb_b3', RECENT_DAY], ['mb_b4', RECENT_DAY],
        ]);
        // Each Archive day pulled once, with the person's wallet as the party.
        expect(p.archive.pulls.sort()).toEqual([`${AGENT_WALLET}/${OLD_DAY}@${WALLET}`, `${WALLET}/${OLD_DAY}@${WALLET}`]);
    });

    it('RED: a pointer whose archived entry is a different PE is never emitted; it is named in `incomplete` and the chain shows the gap', async () => {
        const p = await person();
        const [payload] = p.archive.days.get(`${WALLET}/${OLD_DAY}`) ?? [];
        // The Archive answers with another PE at position 1 (a different hash than the pointer names).
        const impostor = (await agentPes(1))[0];
        p.archive.days.set(`${WALLET}/${OLD_DAY}`, [{
            ...payload,
            entries: payload.entries.map((e) => (e.index === 1 ? { ...e, pe: { ...impostor, device_id: DEVICE } } : e)),
        }]);
        const result = await buildPhonePeExport(deps(p));
        const parsed = parseExport(result.text);
        if (!parsed.ok) throw new Error(parsed.error);
        const pe = byType(parsed.body, 'pe');
        expect(pe.some((l) => l.device_id === DEVICE && l.index === 1)).toBe(false);
        expect(pe.some((l) => l.pe.pe_id === impostor.pe_id)).toBe(false);
        expect(result.incomplete).toContainEqual({ what: `pe ${DEVICE}#1`, reason: 'archive_entry_does_not_match_pointer' });
        expect(parsed.end.incomplete).toContainEqual({ what: `pe ${DEVICE}#1`, reason: 'archive_entry_does_not_match_pointer' });
        expect(result.gapsInHeldChains).toBe(1);
        expect(result.complete).toBe(false);
        // Nothing else broke: the rest still verifies.
        expect(result.report.failures).toEqual([]);
    });

    it('RED: mailbox PEs still waiting on the relay are named, and the phone\'s verdict is offline_incomplete — never offline_ok', async () => {
        const p = await person();
        const result = await buildPhonePeExport(deps(p, { mailbox: { waiting: 4, truncated: false, reason: 'no_message_key: test' } }));
        expect(result.incomplete).toEqual([{ what: 'mailbox: 4 PE(s) sealed to you still waiting on the relay', reason: 'no_message_key: test' }]);
        // Everything in the file still verifies — the only difference is what it names as missing.
        expect(result.report.failures).toEqual([]);
        expect(result.report.counts.pe.total).toBe(8);
        expect(result.complete).toBe(false);
        expect(result.verdict).toBe('offline_incomplete');
        const parsed = parseExport(result.text);
        if (!parsed.ok) throw new Error(parsed.error);
        expect(parsed.end.incomplete).toEqual(result.incomplete);
        // An export given no mailbox state at all says the mailbox was not checked.
        const unchecked = await buildPhonePeExport(deps(p, { mailbox: undefined }));
        expect(unchecked.incomplete.map((i) => i.reason)).toEqual([expect.stringMatching(/^mailbox_not_checked:/)]);
        expect(unchecked.verdict).toBe('offline_incomplete');
    });

    it('a handed-back record dropped from this phone is named not_held_on_this_phone (never silently missing)', async () => {
        const p = await person();
        // Force the (defensive) state: the v1 row carries an Archive pointer instead of its record.
        const rows = await p.store.listReceivedRows();
        const v1 = rows.find((r) => r.mailbox_id === 'mb_v1');
        expect(v1).toBeDefined();
        const patched = rows.map((r) => (r.mailbox_id === 'mb_v1' ? { ...r, pe: undefined, archived: { day: OLD_DAY, wallet: AGENT_WALLET } } : r));
        const store = new Proxy(p.store, { get: (t, k) => (k === 'listReceivedRows' ? async () => patched : Reflect.get(t, k, t)) }) as typeof p.store;
        const result = await buildPhonePeExport(deps(p, { store }));
        expect(result.incomplete).toContainEqual({ what: 'handed-back record v1_env_1', reason: 'not_held_on_this_phone' });
        expect(result.verdict).toBe('offline_incomplete');
    });

    it('RED: an Archive day that cannot be pulled is listed unpulled with its reason, and its pointers are named', async () => {
        const p = await person();
        p.archive.days.delete(`${WALLET}/${OLD_DAY}`);
        const result = await buildPhonePeExport(deps(p));
        expect(result.header.archive.days).toContainEqual({ wallet: WALLET, day: OLD_DAY, pulled: false, reason: 'archive_day_unreadable:404' });
        expect(result.incomplete).toContainEqual({ what: `archive day ${WALLET} ${OLD_DAY}`, reason: 'archive_day_unreadable:404' });
        expect(result.incomplete).toContainEqual({ what: `pe ${DEVICE}#0`, reason: 'archive_day_unreadable:404' });
        expect(result.complete).toBe(false);
    });

    it('RED: a received PE whose proof cannot be obtained is proof_unavailable and named in `incomplete`', async () => {
        const p = await person();
        // The relay no longer holds batch B (dropped 30 days after its anchor) and nothing was kept.
        const result = await buildPhonePeExport(deps(p, { batchProofs: fakeBatchProofs(p.relayRecords.filter((r) => r.batch_hash !== h(5))) }));
        const parsed = parseExport(result.text);
        if (!parsed.ok) throw new Error(parsed.error);
        const b3 = byType(parsed.body, 'received').find((l) => l.mailbox_id === 'mb_b3');
        expect(b3).toMatchObject({ status: 'proof_unavailable', inclusion: null });
        expect(result.incomplete).toContainEqual({ what: `proof of received ${p.agent[3].pe_id}`, reason: 'relay_no_longer_holds_batch' });
        expect(result.complete).toBe(false);
        expect(result.report.failures).toEqual([]);
        // A relay-handed PE (no batch hash) the relay holds no one-act batch for is named, never guessed.
        const direct = await buildPhonePeV2({ envelope: envelope({ action_type: 'wallet_created' }), detailHash: 'c'.repeat(64), deviceId: 'relay:user_1', prevHash: METER_GENESIS_PREV_HASH });
        await p.store.recordReceived({ mailbox_id: 'direct:relay:user_1:x', pe_id: direct.pe_id, pe: direct, pe_hash: direct.pe_hash, from_device: 'relay:user_1', from_actor: 'user_1', batch_hash: '', created_at_ms: T0, received_at_ms: T0 });
        const again = await buildPhonePeExport(deps(p));
        expect(again.incomplete).toContainEqual({ what: `proof of received ${direct.pe_id}`, reason: 'relay_holds_no_batch_for_direct_pe' });
    });

    it('a relay-authored PE handed over directly (no batch hash) is proven through its one-act root, and its batch hash is filled', async () => {
        const p = await person();
        const direct = await buildPhonePeV2({ envelope: envelope({ action_type: 'wallet_created' }), detailHash: 'c'.repeat(64), deviceId: 'relay:user_1', prevHash: METER_GENESIS_PREV_HASH });
        await p.store.recordReceived({ mailbox_id: 'direct:relay:user_1:x', pe_id: direct.pe_id, pe: direct, pe_hash: direct.pe_hash, from_device: 'relay:user_1', from_actor: 'user_1', batch_hash: '', created_at_ms: T0, received_at_ms: T0 });
        const spec: BatchSpec = { device: 'relay:user_1', actor: 'user_1', seq: 1, batchHash: h(9), pes: [direct], firstIndex: 0, day: '2026-11-12' };
        expect(oneActRootOf(direct)).toBe(actsRootOf([actRecordOf(direct)]));
        const anchor = anchorsFor([spec]).get(h(9));
        if (!anchor) throw new Error('no anchor');
        const rootCalls: string[][] = [];
        const result = await buildPhonePeExport(deps(p, { batchProofs: fakeBatchProofs([...p.relayRecords, relayRecord(spec, anchor, true)], [], rootCalls) }));
        expect(rootCalls).toEqual([[oneActRootOf(direct)]]);
        const parsed = parseExport(result.text);
        if (!parsed.ok) throw new Error(parsed.error);
        const line = byType(parsed.body, 'received').find((l) => l.mailbox_id === 'direct:relay:user_1:x');
        expect(line).toMatchObject({ status: 'anchored', batch_hash: h(9) });
        expect(result.incomplete).toEqual([]);
        expect(result.report.failures).toEqual([]);
        // The proof is kept with the row (and its batch hash filled), so the next export asks for nothing.
        const row = (await p.store.listReceivedRows()).find((r) => r.mailbox_id === 'direct:relay:user_1:x');
        expect(row?.batch_hash).toBe(h(9));
        expect(row?.inclusion?.batch.batch_hash).toBe(h(9));
    });

    it('a direct relay PE whose batch record predates act_leaves still proves (the one held copy IS the batch)', async () => {
        const p = await person();
        const direct = await buildPhonePeV2({ envelope: envelope({ action_type: 'wallet_created' }), detailHash: 'c'.repeat(64), deviceId: 'relay:user_1', prevHash: METER_GENESIS_PREV_HASH });
        await p.store.recordReceived({ mailbox_id: 'direct:relay:user_1:x', pe_id: direct.pe_id, pe: direct, pe_hash: direct.pe_hash, from_device: 'relay:user_1', from_actor: 'user_1', batch_hash: '', created_at_ms: T0, received_at_ms: T0 });
        const spec: BatchSpec = { device: 'relay:user_1', actor: 'user_1', seq: 1, batchHash: h(9), pes: [direct], firstIndex: 0, day: '2026-11-12' };
        const anchor = anchorsFor([spec]).get(h(9));
        if (!anchor) throw new Error('no anchor');
        // The fake answers roots only for records whose act_leaves name one act; a pre-deploy record has
        // none, so this call answers its root itself.
        const legacyRecord = relayRecord(spec, anchor, false);
        const call = async (hashes: readonly string[], roots: readonly string[] = []): Promise<MeterAnswer> => {
            const base = await fakeBatchProofs(p.relayRecords)(hashes, []);
            const body = base.body as { batches: unknown[]; missing: string[] };
            const hit = roots.includes(legacyRecord.acts_root);
            const extra = hit ? (await fakeBatchProofs([{ ...legacyRecord }])([legacyRecord.batch_hash], [])).body as { batches: unknown[] } : { batches: [] };
            return { status: 200, error: null, body: { batches: [...body.batches, ...extra.batches], missing: body.missing, missing_acts_roots: roots.filter((r) => r !== legacyRecord.acts_root) } };
        };
        const result = await buildPhonePeExport(deps(p, { batchProofs: call }));
        const parsed = parseExport(result.text);
        if (!parsed.ok) throw new Error(parsed.error);
        expect(byType(parsed.body, 'received').find((l) => l.mailbox_id === 'direct:relay:user_1:x')).toMatchObject({ status: 'anchored', batch_hash: h(9) });
        expect(result.report.failures).toEqual([]);
    });

    it('RED: a one-act root answered with a batch of another device is refused, not attached', async () => {
        const p = await person();
        const direct = await buildPhonePeV2({ envelope: envelope({ action_type: 'wallet_created' }), detailHash: 'c'.repeat(64), deviceId: 'relay:user_1', prevHash: METER_GENESIS_PREV_HASH });
        await p.store.recordReceived({ mailbox_id: 'direct:relay:user_1:x', pe_id: direct.pe_id, pe: direct, pe_hash: direct.pe_hash, from_device: 'relay:user_1', from_actor: 'user_1', batch_hash: '', created_at_ms: T0, received_at_ms: T0 });
        // A relay answering the root with a record from ANOTHER device (here: the PE's device is relay:user_1).
        const spec: BatchSpec = { device: 'relay:someone_else', actor: 'someone_else', seq: 1, batchHash: h(9), pes: [direct], firstIndex: 0, day: '2026-11-12' };
        const anchor = anchorsFor([spec]).get(h(9));
        if (!anchor) throw new Error('no anchor');
        const result = await buildPhonePeExport(deps(p, { batchProofs: fakeBatchProofs([...p.relayRecords, relayRecord(spec, anchor, true)]) }));
        const parsed = parseExport(result.text);
        if (!parsed.ok) throw new Error(parsed.error);
        const line = byType(parsed.body, 'received').find((l) => l.mailbox_id === 'direct:relay:user_1:x');
        expect(line?.status).not.toBe('anchored');
        expect(line?.inclusion ?? null).toBeNull();
        expect((await p.store.listReceivedRows()).find((r) => r.mailbox_id === 'direct:relay:user_1:x')?.batch_hash).toBe('');
    });

    it('a day not anchored yet is pending (not_anchored_yet), never a failure and never incomplete', async () => {
        const p = await person();
        const unanchored = p.relayRecords.map((r) => (r.batch_hash === h(4) ? { ...r, anchored: false, anchor: null } : r));
        const result = await buildPhonePeExport(deps(p, { batchProofs: fakeBatchProofs(unanchored) }));
        const parsed = parseExport(result.text);
        if (!parsed.ok) throw new Error(parsed.error);
        expect(byType(parsed.body, 'received').find((l) => l.mailbox_id === 'mb_a0')?.status).toBe('not_anchored_yet');
        expect(result.report.failures).toEqual([]);
        expect(result.incomplete).toEqual([]);
        expect(result.report.pending.some((x) => x.status === 'not_anchored_yet')).toBe(true);
    });
});

// ─── the received-proof rows ────────────────────────────────────────────────────

describe('received PE proofs kept with the row', () => {
    it('the daily step keeps only anchored proofs, and a backup restore keeps the field', async () => {
        const p = await person();
        const unanchoredB = p.relayRecords.map((r) => (r.batch_hash === h(5) ? { ...r, anchored: false, anchor: null } : r));
        const calls: string[][] = [];
        const transport = new FakeRelay();
        const call = fakeBatchProofs(unanchoredB, calls);
        Object.assign(transport, { getBatchProofs: call });
        const batcher = new PhoneBatcher({ store: p.store, transport, now: () => NOW });
        expect(await batcher.fetchReceivedProofs()).toEqual({ ok: true, attached: 2 });
        expect(calls).toEqual([[h(4), h(5)]]);
        const rows = new Map((await p.store.listReceivedRows()).map((r) => [r.mailbox_id, r]));
        expect(rows.get('mb_a0')?.inclusion?.anchor?.contract).toBe(PE_EXPORT_PE_ANCHOR);
        expect(rows.get('mb_b3')?.inclusion).toBeUndefined(); // not anchored yet: asked again tomorrow
        // A row that already carries its proof is not asked for again.
        await batcher.fetchReceivedProofs();
        expect(calls[1]).toEqual([h(5)]);
        const chunk = p.store.receivedPathOf('mb_a0');
        expect(chunk !== null && p.store.isDirty(chunk)).toBe(true);

        // Backup → restore on a new phone: the proof is still with its row.
        const cloud = new MemoryCloudFiles();
        const key = await deriveArchiveKey('legal winner thank year wave sausage worth useful legal winner thank yellow', 'ef'.repeat(16));
        const keys: BackupKeyProvider = { async current() { return { saltHex: 'ef'.repeat(16), key }; }, async forSalt() { return key; }, async adopt() { /* same salt */ } };
        let r = 3;
        const rand = (n: number): Uint8Array => Uint8Array.from({ length: n }, () => { r = (r * 1103515245 + 12345) & 0x7fffffff; return r & 0xff; });
        await new PeCloudBackup({ store: p.store, cloud, keys, randomBytes: rand }).backup();
        const fresh = new PhonePeStore(new MemoryMeterFiles());
        await fresh.open('device_new_phone');
        await new PeCloudBackup({ store: fresh, cloud, keys, randomBytes: rand }).restore();
        const restored = new Map((await fresh.listReceivedRows()).map((x) => [x.mailbox_id, x]));
        expect(restored.get('mb_a0')?.inclusion).toEqual(rows.get('mb_a0')?.inclusion);
        expect(restored.get('mb_c5')).toMatchObject({ archived: { day: OLD_DAY, wallet: AGENT_WALLET } });
    });

    it('a restored row carrying a proof gives it to the same PE held here without one', async () => {
        const p = await person();
        await attachMissingReceivedProofs(p.store, fakeBatchProofs(p.relayRecords));
        const withProof = (await p.store.listReceivedRows()).find((x) => x.mailbox_id === 'mb_a1') as ReceivedPe;
        expect(withProof.inclusion).toBeDefined();
        const other = new PhonePeStore(new MemoryMeterFiles());
        await other.open(DEVICE);
        await other.recordReceivedMany([received(p.agent[1], h(4), 'mb_a1_other')]);
        await other.importReceived('device_other', [withProof]);
        const row = (await other.listReceivedRows()).find((x) => x.pe_hash === p.agent[1].pe_hash);
        expect(row?.mailbox_id).toBe('mb_a1_other');
        expect(row?.inclusion).toEqual(withProof.inclusion);
    });

    it('RED: attachReceivedInclusions refuses a pe_hash mismatch (or a proof of another batch) and changes nothing', async () => {
        const p = await person();
        const report = await attachMissingReceivedProofs(p.store, fakeBatchProofs([]));
        expect(report.attached).toBe(0);
        const built = receivedInclusionOf({ pe: p.agent[0], from_device: AGENT_DEVICE, batch_hash: h(4) }, p.relayRecords[0], []);
        expect(built.status).toBe('anchored');
        const proof = built.inclusion as ActInclusionProof;
        expect(proof).toBeDefined();
        const before = new Map(p.files.files);
        const dirtyBefore = p.store.dirtyPaths();
        // Wrong hash for the row.
        await expect(p.store.attachReceivedInclusions([{ mailbox_id: 'mb_a0', pe_hash: '0'.repeat(64), inclusion: proof }])).rejects.toThrow(/pe_store_inclusion_mismatch/);
        // Right hash, but a proof of a different act (mb_a1's row with mb_a0's proof).
        await expect(p.store.attachReceivedInclusions([{ mailbox_id: 'mb_a1', pe_hash: p.agent[1].pe_hash, inclusion: proof }])).rejects.toThrow(/act_not_in_batch/);
        // A valid item beside an invalid one: nothing is written for either.
        await expect(p.store.attachReceivedInclusions([
            { mailbox_id: 'mb_a0', pe_hash: p.agent[0].pe_hash, inclusion: proof },
            { mailbox_id: 'mb_missing', pe_hash: p.agent[0].pe_hash, inclusion: proof },
        ])).rejects.toThrow(/not held here/);
        expect(new Map(p.files.files)).toEqual(before);
        expect(p.store.dirtyPaths()).toEqual(dirtyBefore);
        expect(((await p.store.listReceivedRows()).find((x) => x.mailbox_id === 'mb_a0') as ReceivedPe).inclusion).toBeUndefined();
        // The control: the same proof on its own row is accepted.
        expect(await p.store.attachReceivedInclusions([{ mailbox_id: 'mb_a0', pe_hash: p.agent[0].pe_hash, inclusion: proof }])).toEqual({ attached: 1 });
    });
});
