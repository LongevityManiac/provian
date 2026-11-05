/**
 * The paid PE Archive on the phone : upload anchored days sealed to the person, drop
 * only confirmed days older than 30 days after reading them back (and the cloud backup's copy with
 * them), drop the copies held for a linked agent once THAT agent's Archive confirmed the day, and
 * pull a dropped PE back to present it.
 *
 * Every guard ships its RED beside it : an Archive that is off or full drops nothing; a day
 * younger than 30 days is kept; an object that differs from the confirmed index, or does not match
 * the PEs held, drops nothing; no key here drops nothing; a drop plan that does not match the store
 * changes nothing.
 */
import { describe, expect, it } from 'vitest';
import { x25519 } from '@noble/curves/ed25519';
import {
    actRecordOf,
    actsRootOf,
    batchLeafOf,
    METER_GENESIS_PREV_HASH,
    peHashOf,
    PE_V2_SCHEMA,
    verifyActInclusion,
    type PeV2,
} from '../meter-wire';
import {
    buildArchiveEntries,
    bytesToB64u,
    parseArchivePart,
    sealArchivePart,
    type ArchivePartHeader,
} from '../pe-archive-wire';
import { MemoryMeterFiles } from '../meterFiles';
import type { MeterAnswer } from '../meterTransport';
import { keepDaysOf, PhoneArchiveKeeper, type PhoneArchiveTransport } from '../phoneArchive';
import { MemoryArchiveObjectCache } from '../archiveObjectCache';
import { anchoredLeafOf, foldAnchorProof, getBatchCalldata, PE_EXPORT_PE_ANCHOR, type EthCall } from '../pe-export-wire';
import { isArchivedReceived, PhonePeStore, type DeviceChainStore, type StoredPeV2 } from '../phonePeStore';
import { phonePeFact } from '../phoneProve';
import { listPresentablePes, resolvePresentedPeFacts } from '../presentablePes';
import { MemoryCloudFiles } from '../cloudFiles';
import { PE_BACKUP_MANIFEST_PREFIX, decryptFile, deriveArchiveKey, PeCloudBackup, type BackupKeyProvider } from '../peCloudBackup';
import { ACTOR, DEVICE, openStore, recordPes } from './meterTestkit';

const WALLET = 'wallet_doc_person';
const AGENT_WALLET = 'aw_linked_agent';
const AGENT_DEVICE = 'dev_' + 'b4'.repeat(32);
const AGENT_ACTOR = 'agent_linked';
const PERSON_SECRET = new Uint8Array(32).fill(0x21);
const AGENT_SECRET = new Uint8Array(32).fill(0x31);
const NOW = Date.UTC(2026, 10, 20, 12); // 2026-11-20
const OLD = Date.UTC(2026, 9, 1, 6); // 2026-10-01 (50 days old)
const RECENT = Date.UTC(2026, 10, 10, 6); // 2026-11-10 (10 days old)
const ANCHOR_CONTRACT = '0x889a59a8' + '0'.repeat(32);

let r = 7;
function rand(n: number): Uint8Array {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) { r = (r * 1103515245 + 12345) & 0x7fffffff; out[i] = r & 0xff; }
    return out;
}

const pub = (secret: Uint8Array): string => bytesToB64u(x25519.getPublicKey(secret));

/** Batch the PEs from `first` and file a verified anchor proof for `atMs`'s day. */
async function batchAndAnchor(chain: DeviceChainStore, seq: number, first: number, count: number, atMs: number): Promise<void> {
    const pes = await chain.readPes(first, count);
    const actsRoot = actsRootOf(pes.map((p) => actRecordOf(p.pe)));
    const batchHash = seq.toString(16).padStart(2, '0').repeat(32);
    const prior = await chain.lastBatch();
    await chain.recordBatch({
        seq, batch_hash: batchHash, prev_batch_hash: prior?.batch_hash ?? METER_GENESIS_PREV_HASH, acts_root: actsRoot,
        first_index: first, count, last_pe_hash: pes[pes.length - 1].pe.pe_hash, created_at_ms: atMs, accepted_at_ms: atMs + 60_000,
        actor_id: ACTOR, totals: null,
    }, null);
    await chain.recordProof({
        seq, batch_hash: batchHash, acts_root: actsRoot, actor_id: ACTOR, chain_id: 8453, anchor_contract: ANCHOR_CONTRACT,
        batch_leaf: batchLeafOf({ device_id: chain.deviceId, actor_id: ACTOR, seq, batch_hash: batchHash, acts_root: actsRoot }),
        anchor: {
            day: new Date(atMs).toISOString().slice(0, 10), anchor_batch_id: '0x' + '9'.repeat(64), leaf_index: 0, leaf_count: 1,
            leaf_hash: '0x' + '8'.repeat(64), proof: ['0x' + '7'.repeat(64)], merkle_root: '0x' + '6'.repeat(64), anchor_tx_hash: '0x' + '5'.repeat(64),
        },
        fetched_at_ms: atMs + 86_400_000,
        verified: true,
    });
}

/** Five own PEs: three on the old day (one batch), two on the recent day (one batch). */
async function twoDays(store: PhonePeStore): Promise<{ old: StoredPeV2[]; recent: StoredPeV2[] }> {
    const pes = await recordPes(store, 5);
    await batchAndAnchor(store.own(), 1, 0, 3, OLD);
    await batchAndAnchor(store.own(), 2, 3, 2, RECENT);
    return { old: pes.slice(0, 3), recent: pes.slice(3) };
}

interface FakePart { line: string; header: ArchivePartHeader; sha256: string; confirmed: boolean }

/** The relay's `/v1/archive/mobile/*` in memory: accounting, the 402s, confirmation, linked days. */
class FakeArchiveRelay implements PhoneArchiveTransport {
    on = true;
    paidBytes = 1_000_000_000;
    usedBytes = 0;
    turnedOnAtMs: number | null = Date.UTC(2026, 8, 1);
    confirmOnStore = true;
    ownerPub = pub(PERSON_SECRET);
    uploads = 0;
    readonly days = new Map<string, FakePart[]>(); // `${wallet}/${day}`
    linked: { wallet: string; day: string }[] = [];
    serve: (key: string, text: string) => string = (_k, t) => t;

    async getStatus(): Promise<MeterAnswer> {
        return {
            status: 200, error: null, body: {
                wallet: WALLET,
                archive: {
                    on: this.on, paid_bytes: this.paidBytes, used_bytes: this.usedBytes, turned_on_at_ms: this.turnedOnAtMs,
                    space_exhausted: this.on && this.usedBytes >= this.paidBytes, next_gb_purchasable: this.paidBytes - this.usedBytes < 100_000_000,
                },
                recipients: [{ party_id: WALLET, role: 'owner', pubkey_b64u: this.ownerPub }],
            },
        };
    }

    store(line: string, confirmed: boolean): FakePart {
        const parsed = parseArchivePart(new TextEncoder().encode(line));
        if (!parsed.ok) throw new Error(parsed.error);
        const key = `${parsed.header.wallet}/${parsed.header.day}`;
        const part: FakePart = { line, header: parsed.header, sha256: parsed.sha256, confirmed };
        this.days.set(key, [...(this.days.get(key) ?? []), part]);
        return part;
    }

    async uploadPart(line: string): Promise<MeterAnswer> {
        this.uploads += 1;
        if (!this.on) return { status: 402, body: { error: 'archive_not_on' }, error: 'off' };
        const bytes = new TextEncoder().encode(line).length;
        if (this.usedBytes + bytes > this.paidBytes) return { status: 402, body: { error: 'archive_space_exhausted' }, error: 'full' };
        this.usedBytes += bytes;
        this.store(line, this.confirmOnStore);
        return { status: 201, body: { stored: true }, error: null };
    }

    private view(wallet: string, day: string, parts: FakePart[]): Record<string, unknown> {
        return {
            wallet, day, confirmed: parts.every((p) => p.confirmed),
            pe_count: parts.reduce((n, p) => n + p.header.pe_count, 0),
            bytes: parts.reduce((n, p) => n + new TextEncoder().encode(p.line).length, 0),
            rejected_reason: null,
            parts: parts.map((p) => ({
                device_id: p.header.device_id, part: p.header.part, sha256: p.sha256, confirmed: p.confirmed, state: 'stored',
                batches: p.header.batches.map((b) => ({ seq: b.seq, batch_hash: b.batch_hash, first_index: b.first_index, count: b.count })),
            })),
        };
    }

    async listDays(wallet: string | null): Promise<MeterAnswer> {
        const w = wallet ?? WALLET;
        const days = [...this.days.entries()].filter(([k]) => k.startsWith(`${w}/`)).sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([k, parts]) => this.view(w, k.slice(w.length + 1), parts));
        return { status: 200, body: { wallet: w, days, next_after: null }, error: null };
    }

    async listLinkedDays(): Promise<MeterAnswer> {
        const days = this.linked.map(({ wallet, day }) => this.view(wallet, day, this.days.get(`${wallet}/${day}`) ?? []))
            .filter((d) => d.confirmed === true);
        return { status: 200, body: { days }, error: null };
    }

    objectReads = 0;
    async getDayObject(wallet: string, day: string): Promise<{ status: number | null; text: string | null }> {
        this.objectReads += 1;
        const parts = this.days.get(`${wallet}/${day}`);
        if (!parts) return { status: 404, text: null };
        return { status: 200, text: this.serve(`${wallet}/${day}`, parts.map((p) => p.line).join('')) };
    }
}

function keeper(store: PhonePeStore, relay: FakeArchiveRelay, secret: Uint8Array | null = PERSON_SECRET, objectCache?: MemoryArchiveObjectCache, ethCall?: EthCall): PhoneArchiveKeeper {
    return new PhoneArchiveKeeper({
        store, transport: relay, now: () => NOW, randomBytes: rand,
        messageSecretKey: async () => (secret === null ? null : new Uint8Array(secret)),
        ...(objectCache ? { objectCache } : {}),
        ...(ethCall ? { ethCall } : {}),
    });
}

/** A fake Base: PEAnchor `getBatch` answers each listed day root (absent ids are unanchored). */
function fakeBase(roots: Map<string, string>): EthCall & { calls: number } {
    const w = (hex: string): string => hex.replace(/^0x/, '').padStart(64, '0');
    const fn = (async (to: string, data: string): Promise<string> => {
        fn.calls += 1;
        expect(to).toBe(PE_EXPORT_PE_ANCHOR);
        const id = [...roots.keys()].find((k) => getBatchCalldata(k) === data);
        if (id === undefined) return '0x' + w('0') + w('0') + w('0') + w('0') + w('0');
        return '0x' + w(roots.get(id) as string) + w('1') + w('6a') + w('0') + w('1');
    }) as EthCall & { calls: number };
    fn.calls = 0;
    return fn;
}

async function heldInFull(store: PhonePeStore, pes: readonly StoredPeV2[]): Promise<void> {
    for (const pe of pes) expect((await store.own().findPe(pe.pe_id))?.pe).toEqual(pe);
}

describe('PhoneArchiveKeeper — the person\'s own days', () => {
    it('uploads both anchored days sealed to the person, drops only the 50-day-old one, and the next backup commits that chunk as a new immutable version', async () => {
        const { store, files } = await openStore();
        const { old, recent } = await twoDays(store);
        // The cloud already holds the chunk with the old day in full.
        const cloud = new MemoryCloudFiles();
        const key = await deriveArchiveKey('legal winner thank year wave sausage worth useful legal winner thank yellow', 'ab'.repeat(16));
        const keys: BackupKeyProvider = { async current() { return { saltHex: 'ab'.repeat(16), key }; }, async forSalt() { return key; }, async adopt() { /* same salt */ } };
        const backup = new PeCloudBackup({ store, cloud, keys, randomBytes: rand });
        await backup.backup();
        const chunk = `${store.own().dir}/pes/000000.json`;
        const cloudText = (): string => {
            const manifest = [...cloud.files.keys()].filter(n => n.startsWith(PE_BACKUP_MANIFEST_PREFIX)).at(-1)!;
            const wire = JSON.parse(cloud.files.get(manifest)!);
            const index = JSON.parse(decryptFile(key, manifest, JSON.stringify({ v: 1, alg: 'AES-256-GCM', nonce: wire.nonce, data: wire.data }))) as { files: Record<string, { path: string }> };
            const name = Object.keys(index.files).find(n => index.files[n].path === chunk)!;
            return decryptFile(key, name, cloud.files.get(name)!);
        };
        expect(cloudText()).toContain(old[0].pe_hash);
        expect(cloudText()).toContain('"detail"');

        const relay = new FakeArchiveRelay();
        const report = await keeper(store, relay).run();
        expect(report).toMatchObject({ state: 'ran', uploaded_days: 2, dropped_days: 1, dropped_pes: 3, space_exhausted: false });
        expect(relay.days.get(`${WALLET}/2026-10-01`)?.[0].header.recipients.map((x) => x.party_id)).toEqual([WALLET]);
        for (const pe of old) {
            expect(await store.own().findPe(pe.pe_id)).toBeNull();
            expect(await store.own().findArchived(pe.pe_id)).toMatchObject({ archived: { day: '2026-10-01', wallet: WALLET, pe_hash: pe.pe_hash } });
        }
        await heldInFull(store, recent);
        // The phone's file and, after the next backup, the cloud's copy carry pointers, not the PEs.
        const shape = (text: string | null): string[] => (JSON.parse(text ?? '[]') as Record<string, unknown>[])
            .map((row) => (row.archived !== undefined && row.pe === undefined && row.detail === undefined ? 'pointer' : row.pe !== undefined ? 'pe' : 'other'));
        expect(shape(await files.read(chunk))).toEqual(['pointer', 'pointer', 'pointer', 'pe', 'pe']);
        expect(store.isDirty(chunk)).toBe(true);
        expect(shape(cloudText())).toEqual(['pe', 'pe', 'pe', 'pe', 'pe']);
        await backup.backup();
        expect(shape(cloudText())).toEqual(['pointer', 'pointer', 'pointer', 'pe', 'pe']);
        const { store: recovered } = await openStore(new MemoryMeterFiles(), 'recovered_phone');
        await new PeCloudBackup({ store: recovered, cloud, keys, randomBytes: rand }).restore();
        const originalChain = await recovered.chain(DEVICE);
        for (const pe of old) {
            expect(await originalChain.findPe(pe.pe_id)).toBeNull();
            expect(await originalChain.findArchived(pe.pe_id)).toMatchObject({ archived: { pe_hash: pe.pe_hash } });
        }
        const pulled = await phonePeFact(recovered, old[0].pe_id, old[0].pe_hash, keeper(recovered, relay));
        expect(pulled.ok).toBe(true);
        if (pulled.ok) {
            expect(pulled.fact.pe).toEqual(old[0]);
            expect(verifyActInclusion(pulled.fact.pe, pulled.fact.inclusion).ok).toBe(true);
        }
        // The chain still links on a fresh open (pointers keep their place), and keeps appending.
        const reopened = new PhonePeStore(files);
        await reopened.open(DEVICE);
        expect((await reopened.own().head()).count).toBe(5);
        await recordPes(reopened, 1);
        expect((await reopened.own().head()).count).toBe(6);
    });

    it('a restore from a cloud backup holding pointers rebuilds the chain (pointers re-linked, PEs re-verified)', async () => {
        const { store } = await openStore();
        await twoDays(store);
        const cloud = new MemoryCloudFiles();
        const key = await deriveArchiveKey('legal winner thank year wave sausage worth useful legal winner thank yellow', 'cd'.repeat(16));
        const keys: BackupKeyProvider = { async current() { return { saltHex: 'cd'.repeat(16), key }; }, async forSalt() { return key; }, async adopt() { /* same salt */ } };
        await keeper(store, new FakeArchiveRelay()).run();
        await new PeCloudBackup({ store, cloud, keys, randomBytes: rand }).backup();
        const { store: fresh } = await openStore(new MemoryMeterFiles(), 'device_new_phone');
        const restored = await new PeCloudBackup({ store: fresh, cloud, keys, randomBytes: rand }).restore();
        expect(restored.refusedFiles).toEqual([]);
        const chain = await fresh.chain(DEVICE);
        expect((await chain.head()).count).toBe(5);
        expect((await chain.listArchived()).length).toBe(3);
        expect((await chain.allPes()).length).toBe(2);
    });

    it('a dropped PE is pulled back from the Archive and presents with both proof hops; listed as archived', async () => {
        const { store } = await openStore();
        const { old } = await twoDays(store);
        const k = keeper(store, new FakeArchiveRelay());
        await k.run();
        const rows = await listPresentablePes(store);
        expect(rows.find((x) => x.peId === old[1].pe_id)).toMatchObject({ archivedDay: '2026-10-01', actionType: null });
        const fresh = keeper(store, (k as unknown as { options: { transport: FakeArchiveRelay } }).options.transport);
        const r = await phonePeFact(store, old[1].pe_id, old[1].pe_hash, fresh);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.fact.pe).toEqual(old[1]);
        expect(r.fact.inclusion.anchor).toMatchObject({ day: '2026-10-01', contract: ANCHOR_CONTRACT, chain_id: 8453 });
        expect(verifyActInclusion(r.fact.pe, r.fact.inclusion).ok).toBe(true);
        const facts = await resolvePresentedPeFacts(store, [{ peId: old[1].pe_id, hash: old[1].pe_hash }], fresh);
        expect(facts[0]).toMatchObject({ peId: old[1].pe_id, envelopeHash: old[1].pe_hash, pe: old[1] });
        // RED: without the archive, or with a wrong hash, it is refused (never silently missing).
        expect(await phonePeFact(store, old[1].pe_id, null)).toMatchObject({ ok: false, reason: 'archived_unavailable' });
        expect(await phonePeFact(store, old[1].pe_id, '0'.repeat(64), fresh)).toMatchObject({ ok: false, reason: 'envelope_hash_mismatch' });
        await expect(resolvePresentedPeFacts(store, [{ peId: old[1].pe_id, hash: old[1].pe_hash }], undefined)).rejects.toThrow(/archived_unavailable/);
    });

    it('a PE held in full presents from the chain; RED: an unanchored one is refused before any burn', async () => {
        const { store } = await openStore();
        const { recent } = await twoDays(store);
        const extra = await recordPes(store, 1);
        const ok = await phonePeFact(store, recent[0].pe_id, null);
        expect(ok.ok && verifyActInclusion(ok.fact.pe, ok.fact.inclusion).ok).toBe(true);
        expect(await phonePeFact(store, extra[0].pe_id, null)).toMatchObject({ ok: false, reason: 'not_batched_yet' });
    });
});

describe('PhoneArchiveKeeper — RED: nothing is deleted unless confirmed, 30+ days old, read back and matched', () => {
    it('RED: an Archive that is OFF (never paid) uploads nothing and drops nothing', async () => {
        const { store } = await openStore();
        const { old, recent } = await twoDays(store);
        const relay = new FakeArchiveRelay();
        relay.on = false;
        relay.paidBytes = 0;
        expect(await keeper(store, relay).run()).toMatchObject({ state: 'off', uploaded_days: 0, dropped_days: 0, dropped_pes: 0 });
        expect(relay.uploads).toBe(0);
        await heldInFull(store, [...old, ...recent]);
    });

    it('RED: an EXHAUSTED Archive (next GB unpaid) keeps every day here and in the backup, and says so; paying resumes it', async () => {
        const { store } = await openStore();
        const { old, recent } = await twoDays(store);
        const relay = new FakeArchiveRelay();
        relay.paidBytes = 10;
        const k = keeper(store, relay);
        expect(await k.run()).toMatchObject({ uploaded_days: 0, dropped_days: 0, dropped_pes: 0, space_exhausted: true });
        await heldInFull(store, [...old, ...recent]);
        expect(await k.state()).toMatchObject({ on: true, space_exhausted: true });
        relay.paidBytes = 1_000_000_000;
        expect(await k.run()).toMatchObject({ uploaded_days: 2, dropped_days: 1, dropped_pes: 3, space_exhausted: false });
    });

    it('RED: a stored day that is NOT confirmed is not dropped', async () => {
        const { store } = await openStore();
        const { old } = await twoDays(store);
        const relay = new FakeArchiveRelay();
        relay.confirmOnStore = false;
        expect(await keeper(store, relay).run()).toMatchObject({ uploaded_days: 2, dropped_days: 0 });
        await heldInFull(store, old);
    });

    it('RED: an object that differs from the confirmed index drops nothing; no key here drops nothing', async () => {
        const { store } = await openStore();
        const { old } = await twoDays(store);
        const relay = new FakeArchiveRelay();
        relay.serve = () => '{"tampered":true}\n';
        expect((await keeper(store, relay).run()).dropped_days).toBe(0);
        await heldInFull(store, old);
        relay.serve = (_k, t) => t;
        expect((await keeper(store, relay, null).run()).dropped_days).toBe(0);
        await heldInFull(store, old);
        // A confirmed index whose sha is not the object's part: refused by name.
        const part = relay.days.get(`${WALLET}/2026-10-01`)![0];
        part.sha256 = 'f'.repeat(64);
        const report = await keeper(store, relay).run();
        expect(report.dropped_days).toBe(0);
        expect(report.detail).toBe('archive_object_differs_from_confirmed_index');
        await heldInFull(store, old);
    });

    it('RED: a drop plan naming a PE that is not the one held changes nothing', async () => {
        const { store, files } = await openStore();
        const { old } = await twoDays(store);
        const chunk = `${store.own().dir}/pes/000000.json`;
        const before = await files.read(chunk);
        await expect(store.own().dropArchivedDay({
            day: '2026-10-01', wallet: WALLET,
            pes: [{ index: 0, pe_id: old[0].pe_id, pe_hash: old[0].pe_hash }, { index: 1, pe_id: old[1].pe_id, pe_hash: 'e'.repeat(64) }],
        })).rejects.toThrow(/pe_store_archive_drop_mismatch/);
        expect(await files.read(chunk)).toBe(before);
    });
});

/** A linked agent's day: its PEs sealed to the agent AND this person, as its daemon uploads it. */
function agentDay(relay: FakeArchiveRelay, day: string, n: number, confirmed = true): StoredPeV2[] {
    const pes: StoredPeV2[] = [];
    let prev = METER_GENESIS_PREV_HASH;
    for (let i = 0; i < n; i++) {
        const base: PeV2 = {
            schema: PE_V2_SCHEMA, pe_id: `pe_agent_${day}_${i}`, device_id: AGENT_DEVICE, prev_hash: prev,
            timestamp: OLD + i, action_type: 'agent_tool_orchestration', description: `agent turn ${i}`,
            metadata: { tool_count: 1 }, compute: null,
        } as PeV2;
        const pe = { ...base, pe_hash: peHashOf(base) } as StoredPeV2;
        pes.push(pe);
        prev = pe.pe_hash;
    }
    const actsRoot = actsRootOf(pes.map(actRecordOf));
    const batchHash = 'ab'.repeat(32);
    const { entries, refs } = buildArchiveEntries(day, [{
        device_id: AGENT_DEVICE, actor_id: AGENT_ACTOR, seq: 1, batch_hash: batchHash, acts_root: actsRoot,
        batch_leaf: batchLeafOf({ device_id: AGENT_DEVICE, actor_id: AGENT_ACTOR, seq: 1, batch_hash: batchHash, acts_root: actsRoot }),
        first_index: 0, pes,
        anchor: { day, anchor_batch_id: '0x' + '9'.repeat(64), leaf_index: 0, proof: [], merkle_root: '0x' + '6'.repeat(64), tx_hash: null },
    }], ANCHOR_CONTRACT);
    const sealed = sealArchivePart({
        wallet: AGENT_WALLET, day, device_id: AGENT_DEVICE, part: 0, entries, refs, randomBytes: rand,
        recipients: [{ party_id: AGENT_WALLET, pubkey_b64u: pub(AGENT_SECRET) }, { party_id: WALLET, pubkey_b64u: pub(PERSON_SECRET) }],
    });
    relay.store(sealed.line, confirmed);
    relay.linked.push({ wallet: AGENT_WALLET, day });
    return pes;
}

async function fileCopies(store: PhonePeStore, pes: readonly StoredPeV2[]): Promise<void> {
    for (const pe of pes) {
        await store.recordReceived({
            mailbox_id: `mb_${pe.pe_id}`, pe_id: pe.pe_id, pe, pe_hash: pe.pe_hash, from_device: AGENT_DEVICE,
            from_actor: AGENT_ACTOR, batch_hash: 'ab'.repeat(32), created_at_ms: OLD, received_at_ms: OLD,
        });
    }
}

describe('PhoneArchiveKeeper — copies this person holds for a linked agent', () => {
    it('drops the copies once the agent\'s Archive confirmed the day (even with the person\'s own Archive off), and the cloud copy follows', async () => {
        const { store, files } = await openStore();
        const relay = new FakeArchiveRelay();
        relay.on = false; // the person's own Archive is off: the agent's decides for its days
        const pes = agentDay(relay, '2026-10-01', 3);
        await fileCopies(store, pes);
        expect(store.receivedArchivedCount()).toBe(0);
        const cloud = new MemoryCloudFiles();
        const key = await deriveArchiveKey('legal winner thank year wave sausage worth useful legal winner thank yellow', 'ab'.repeat(16));
        const keys: BackupKeyProvider = { async current() { return { saltHex: 'ab'.repeat(16), key }; }, async forSalt() { return key; }, async adopt() {} };
        await new PeCloudBackup({ store, cloud, keys, randomBytes: rand }).backup();
        const report = await keeper(store, relay).run();
        expect(report).toMatchObject({ state: 'off', dropped_linked_copies: 3 });
        expect(await store.listReceived()).toEqual([]);
        // The custody card counts them as kept in the Archive, not on this phone — also after a restart.
        expect(store.receivedCount()).toBe(3);
        expect(store.receivedArchivedCount()).toBe(3);
        const reopened = new PhonePeStore(files);
        await reopened.open(DEVICE);
        expect(reopened.receivedArchivedCount()).toBe(3);
        expect((await reopened.summary()).receivedArchived).toBe(3);
        const rows = await store.listReceivedRows();
        expect(rows.every(isArchivedReceived)).toBe(true);
        const chunk = `received/${DEVICE}/000000.json`;
        expect(store.isDirty(chunk)).toBe(true);
        await new PeCloudBackup({ store, cloud, keys, randomBytes: rand }).backup();
        const { store: restored } = await openStore(new MemoryMeterFiles(), 'restored_phone');
        await new PeCloudBackup({ store: restored, cloud, keys, randomBytes: rand }).restore();
        expect(await restored.listReceived()).toEqual([]);
        expect((await restored.listReceivedRows()).every(isArchivedReceived)).toBe(true);
        expect(restored.receivedArchivedCount()).toBe(3);
        const pulled = await keeper(restored, relay).pullDay(AGENT_WALLET, '2026-10-01', WALLET);
        expect(pulled).toMatchObject({ ok: true });
        if (pulled.ok) expect(pulled.payloads.flatMap(p => p.entries).find(e => e.pe.pe_id === pes[0].pe_id)?.pe).toEqual(pes[0]);
        expect(await files.read(chunk)).not.toContain('agent turn');
        // The mailbox can never file one of them again (its id is still known).
        expect((await store.recordReceived({
            mailbox_id: `mb_${pes[0].pe_id}`, pe_id: pes[0].pe_id, pe: pes[0], pe_hash: pes[0].pe_hash, from_device: AGENT_DEVICE,
            from_actor: AGENT_ACTOR, batch_hash: 'ab'.repeat(32), created_at_ms: OLD, received_at_ms: OLD,
        })).filed).toBe(false);
    });

    it('RED: an unconfirmed agent day, a day younger than 30 days, or a copy the archived day does not carry exactly drops nothing', async () => {
        const { store } = await openStore();
        const relay = new FakeArchiveRelay();
        await fileCopies(store, agentDay(relay, '2026-10-02', 2, false));
        await fileCopies(store, agentDay(relay, '2026-11-01', 2));
        expect((await keeper(store, relay).run()).dropped_linked_copies).toBe(0);
        expect(await store.listReceived()).toHaveLength(4);

        const { store: other } = await openStore();
        const relay2 = new FakeArchiveRelay();
        const pes = agentDay(relay2, '2026-10-01', 2);
        const altered = { ...pes[1], description: 'not what the agent archived' } as StoredPeV2;
        await fileCopies(other, [pes[0], altered]);
        const report = await keeper(other, relay2).run();
        expect(report.dropped_linked_copies).toBe(0);
        expect(report.detail).toBe('archive_day_does_not_match_held_copies');
        expect(await other.listReceived()).toHaveLength(2);
    });

    it('RED: without this person\'s key here, no copy is dropped', async () => {
        const { store } = await openStore();
        const relay = new FakeArchiveRelay();
        await fileCopies(store, agentDay(relay, '2026-10-01', 2));
        expect((await keeper(store, relay, null).run()).dropped_linked_copies).toBe(0);
        expect(await store.listReceived()).toHaveLength(2);
        expect(relay.objectReads).toBe(0); // no key, no download
    });

    it('a run that stopped for want of the key runs again right after unlock, not a day later ', async () => {
        const { store } = await openStore();
        const relay = new FakeArchiveRelay();
        relay.on = false;
        await fileCopies(store, agentDay(relay, '2026-10-01', 2));
        let key: Uint8Array | null = null; // a cold start: the keeper runs before Face ID
        const k = new PhoneArchiveKeeper({ store, transport: relay, now: () => NOW, randomBytes: rand, messageSecretKey: async () => key });
        expect(await k.tick()).toMatchObject({ dropped_linked_copies: 0, detail: 'owner_key_unavailable' });
        expect(await k.tick()).toBeNull(); // next scheduled run is a day away
        key = new Uint8Array(PERSON_SECRET); // the person unlocks
        expect(k.keyAvailable()).toBe(true);
        expect(await k.tick()).toMatchObject({ dropped_linked_copies: 2 });
        expect(await store.listReceived()).toEqual([]);
        expect(k.keyAvailable()).toBe(false); // nothing blocked now: unlocking again does not re-run
    });
});

/**
 *. A proof build may SHORTEN the local window (never lengthen it) so a confirmed day can be
 * shown leaving the phone and its cloud copy now, not 30 days from now. Everything else is
 * unchanged: only CONFIRMED days, pulled back and matched PE by PE, ever drop.
 */
describe('PhoneArchiveKeeper — the local window may only be shortened ', () => {
    function shortKeeper(store: PhonePeStore, relay: FakeArchiveRelay, localKeepDays: number): PhoneArchiveKeeper {
        return new PhoneArchiveKeeper({
            store, transport: relay, now: () => NOW, randomBytes: rand, localKeepDays,
            messageSecretKey: async () => new Uint8Array(PERSON_SECRET),
        });
    }

    it('keepDaysOf: unset or anything outside 0..30 is the ruled 30', () => {
        expect(keepDaysOf(undefined)).toBe(30);
        expect(keepDaysOf(0)).toBe(0);
        expect(keepDaysOf(5)).toBe(5);
        expect(keepDaysOf(30)).toBe(30);
        expect(keepDaysOf(31)).toBe(30);
        expect(keepDaysOf(-1)).toBe(30);
        expect(keepDaysOf(2.5)).toBe(30);
        expect(keepDaysOf('5')).toBe(30);
    });

    it('a 5-day window drops the 10-day-old confirmed day too; the default keeps it', async () => {
        const a = await openStore();
        const da = await twoDays(a.store);
        expect(await shortKeeper(a.store, new FakeArchiveRelay(), 5).run()).toMatchObject({ uploaded_days: 2, dropped_days: 2, dropped_pes: 5 });
        for (const pe of [...da.old, ...da.recent]) expect(await a.store.own().findPe(pe.pe_id)).toBeNull();

        const b = await openStore();
        const db = await twoDays(b.store);
        expect(await keeper(b.store, new FakeArchiveRelay()).run()).toMatchObject({ uploaded_days: 2, dropped_days: 1, dropped_pes: 3 });
        await heldInFull(b.store, db.recent);
    });

    it('RED: a window above 30 is ignored (it cannot keep days longer than ruled)', async () => {
        const { store } = await openStore();
        const { recent } = await twoDays(store);
        expect(await shortKeeper(store, new FakeArchiveRelay(), 60).run()).toMatchObject({ dropped_days: 1, dropped_pes: 3 });
        await heldInFull(store, recent);
    });

    it('RED: even a 0-day window drops nothing that is not confirmed', async () => {
        const { store } = await openStore();
        const { old, recent } = await twoDays(store);
        const relay = new FakeArchiveRelay();
        relay.confirmOnStore = false;
        expect(await shortKeeper(store, relay, 0).run()).toMatchObject({ uploaded_days: 2, dropped_days: 0 });
        await heldInFull(store, [...old, ...recent]);
    });
});

/** Like `batchAndAnchor`, with an anchor proof that really folds up to its root (for "intact"). */
async function batchAndAnchorProven(chain: DeviceChainStore, seq: number, first: number, count: number, atMs: number, rootOverride?: string): Promise<string> {
    const pes = await chain.readPes(first, count);
    const actsRoot = actsRootOf(pes.map((p) => actRecordOf(p.pe)));
    const batchHash = seq.toString(16).padStart(2, '0').repeat(32);
    const prior = await chain.lastBatch();
    const batchLeaf = batchLeafOf({ device_id: chain.deviceId, actor_id: ACTOR, seq, batch_hash: batchHash, acts_root: actsRoot });
    const sibling = '0x' + '7'.repeat(64);
    await chain.recordBatch({
        seq, batch_hash: batchHash, prev_batch_hash: prior?.batch_hash ?? METER_GENESIS_PREV_HASH, acts_root: actsRoot,
        first_index: first, count, last_pe_hash: pes[pes.length - 1].pe.pe_hash, created_at_ms: atMs, accepted_at_ms: atMs + 60_000,
        actor_id: ACTOR, totals: null,
    }, null);
    await chain.recordProof({
        seq, batch_hash: batchHash, acts_root: actsRoot, actor_id: ACTOR, chain_id: 8453, anchor_contract: ANCHOR_CONTRACT,
        batch_leaf: batchLeaf,
        anchor: {
            day: new Date(atMs).toISOString().slice(0, 10), anchor_batch_id: '0x' + '9'.repeat(64), leaf_index: 0, leaf_count: 2,
            leaf_hash: anchoredLeafOf(batchLeaf), proof: [sibling], merkle_root: rootOverride ?? foldAnchorProof(anchoredLeafOf(batchLeaf), [sibling]),
            anchor_tx_hash: '0x' + '5'.repeat(64),
        },
        fetched_at_ms: atMs + 86_400_000,
        verified: true,
    });
    return foldAnchorProof(anchoredLeafOf(batchLeaf), [sibling]).toLowerCase();
}

describe('PhoneArchiveKeeper — one pull serves repeated use (2026-10-07)', () => {
    it('a dropped PE presented from three fresh keepers sharing the cache pulls the day ONCE; RED: without the cache, every keeper pulls it', async () => {
        const { store } = await openStore();
        const { old } = await twoDays(store);
        const relay = new FakeArchiveRelay();
        const cache = new MemoryArchiveObjectCache();
        await keeper(store, relay, PERSON_SECRET, cache).run();
        const afterRun = relay.objectReads;
        expect(cache.puts).toBe(0); // the drop check never puts a dropped day back on the phone
        for (const pe of [old[0], old[1], old[2]]) {
            const r = await keeper(store, relay, PERSON_SECRET, cache).findArchivedPe(pe.pe_id);
            expect(r.ok).toBe(true);
        }
        expect(relay.objectReads - afterRun).toBe(1);

        const before = relay.objectReads;
        for (const pe of [old[0], old[1], old[2]]) expect((await keeper(store, relay).findArchivedPe(pe.pe_id)).ok).toBe(true);
        expect(relay.objectReads - before).toBe(3);
    });

    it('the drop check ignores a cached copy that differs from the confirmed index and never fills the cache', async () => {
        const { store } = await openStore();
        await twoDays(store);
        const relay = new FakeArchiveRelay();
        const cache = new MemoryArchiveObjectCache();
        cache.entries.set(`${WALLET}/2026-10-01`, 'not the confirmed object\n');
        const report = await keeper(store, relay, PERSON_SECRET, cache).run();
        expect(report.dropped_days).toBe(1);
        expect(relay.objectReads).toBeGreaterThanOrEqual(1);
        expect(cache.entries.get(`${WALLET}/2026-10-01`)).toBe('not the confirmed object\n');
        expect(cache.puts).toBe(0);
    });

    it('a cached copy that will not open is replaced by the relay\'s copy (and the PE still presents)', async () => {
        const { store } = await openStore();
        const { old } = await twoDays(store);
        const relay = new FakeArchiveRelay();
        const cache = new MemoryArchiveObjectCache();
        await keeper(store, relay, PERSON_SECRET, cache).run();
        cache.entries.set(`${WALLET}/2026-10-01`, 'garbage\n');
        const reads = relay.objectReads;
        expect((await keeper(store, relay, PERSON_SECRET, cache).findArchivedPe(old[0].pe_id)).ok).toBe(true);
        expect(relay.objectReads - reads).toBe(1);
        expect(cache.entries.get(`${WALLET}/2026-10-01`)).not.toBe('garbage\n');
    });
});

describe('PhoneArchiveKeeper — "Pull back" proves a day intact (2026-10-07)', () => {
    const ANCHOR_ID = '0x' + '9'.repeat(64);

    async function provenDay(opts: { rootOverride?: string; base?: 'true' | 'other' | 'missing' | 'throws' | 'none' } = {}) {
        const { store } = await openStore();
        await recordPes(store, 3);
        // `root` is what the batch really folds to: what PEAnchor on Base holds for the day.
        const root = await batchAndAnchorProven(store.own(), 1, 0, 3, OLD, opts.rootOverride);
        const relay = new FakeArchiveRelay();
        const cache = new MemoryArchiveObjectCache();
        const mode = opts.base ?? 'true';
        const base = mode === 'true' ? fakeBase(new Map([[ANCHOR_ID, root]]))
            : mode === 'other' ? fakeBase(new Map([[ANCHOR_ID, '0x' + '7'.repeat(64)]]))
            : mode === 'missing' ? fakeBase(new Map())
            : mode === 'throws' ? Object.assign(async () => { throw new Error('rpc down'); }, { calls: 0 }) as EthCall & { calls: number }
            : undefined;
        const k = keeper(store, relay, PERSON_SECRET, cache, base);
        await k.run();
        const days = await k.archivedDays('own', WALLET);
        return { k, relay, cache, base, day: days!.find((d) => d.day === '2026-10-01')! };
    }

    it('pulls the day once, opens every part, folds every batch to its root, reads that root back from PEAnchor on Base; a second pull back reads nothing from the bucket', async () => {
        const { k, relay, base, day } = await provenDay();
        expect(day).toMatchObject({ confirmed: true, peCount: 3 });
        const reads = relay.objectReads;
        expect(await k.verifyDay(day, WALLET)).toMatchObject({ ok: true, peCount: 3, parts: 1, anchors: 1, fromCache: false });
        expect(await k.verifyDay(day, WALLET)).toMatchObject({ ok: true, peCount: 3, fromCache: true });
        expect(relay.objectReads - reads).toBe(1);
        expect(base!.calls).toBe(2);
    });

    it('RED: a day root Base does not hold is not intact — the copy\'s own roots are not evidence', async () => {
        const { k, day } = await provenDay({ base: 'other' });
        expect(await k.verifyDay(day, WALLET)).toMatchObject({ ok: false, reason: `anchor_onchain_root_differs:${ANCHOR_ID}` });
    });

    it('RED: a day root Base never anchored is not intact', async () => {
        const { k, day } = await provenDay({ base: 'missing' });
        expect(await k.verifyDay(day, WALLET)).toMatchObject({ ok: false, reason: `anchor_day_not_anchored_on_chain:${ANCHOR_ID}` });
    });

    it('RED: an unreadable Base is "could not confirm", never intact', async () => {
        const { k, day } = await provenDay({ base: 'throws' });
        const out = await k.verifyDay(day, WALLET);
        expect(out.ok).toBe(false);
        expect(out.ok ? '' : out.reason).toMatch(/^anchor_rpc_error:rpc down:/);
    });

    it('RED: with no chain reader a day is never reported intact (and nothing is pulled)', async () => {
        const { k, relay, day } = await provenDay({ base: 'none' });
        const reads = relay.objectReads;
        expect(await k.verifyDay(day, WALLET)).toEqual({ ok: false, reason: 'anchor_check_unavailable' });
        expect(relay.objectReads).toBe(reads);
    });

    it('RED: a day the relay has not checked (or rejected) is not intact, and is not pulled', async () => {
        const { k, relay, day } = await provenDay();
        const reads = relay.objectReads;
        expect(await k.verifyDay({ ...day, confirmed: false }, WALLET)).toEqual({ ok: false, reason: 'day_not_yet_checked' });
        expect(await k.verifyDay({ ...day, rejectedReason: 'part_object_missing' }, WALLET)).toEqual({ ok: false, reason: 'part_object_missing' });
        expect(relay.objectReads).toBe(reads);
    });

    it('RED: a batch whose proof does not reach the anchored root is not intact', async () => {
        const { k, day } = await provenDay({ rootOverride: '0x' + '6'.repeat(64) });
        expect(await k.verifyDay(day, WALLET)).toMatchObject({ ok: false, reason: 'batch_not_in_anchored_root:1' });
    });

    it('RED: a served object whose parts are not the ones the relay checked is not intact', async () => {
        const { k, relay, day } = await provenDay();
        relay.serve = () => relay.days.get(`${WALLET}/2026-10-01`)!.map((p) => p.line).join('').replace(/"part":0/, '"part":0 ');
        const result = await k.verifyDay({ ...day, partShas: ['f'.repeat(64)] }, WALLET);
        expect(result.ok).toBe(false);
    });

    it('RED: without this person\'s key nothing is opened', async () => {
        const { relay, day } = await provenDay();
        const { store } = await openStore();
        const noKey = keeper(store, relay, null, undefined, fakeBase(new Map()));
        expect(await noKey.verifyDay(day, WALLET)).toMatchObject({ ok: false, reason: 'owner_key_unavailable' });
    });
});
