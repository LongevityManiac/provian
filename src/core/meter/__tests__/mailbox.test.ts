/**
 * The mailbox: PEs sealed to this person (by a linked agent, another device, the relay, or the
 * pre-meter history migration), opened with the person's message key (HKDF over the
 * mnemonic — the SAME key threads use and the app publishes), verified, filed, backed up, and only
 * THEN acknowledged.
 *
 * The boxes here are sealed by the RELAY's own sealer (`provian-backend/src/core/meter/sealed-box.ts`
 * `sealToKey`, loaded from the backend tree) and opened by the app's `openThreadMessage`, so the
 * test is a byte-compatibility check between the two implementations, plus a pinned vector.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { resolve } from 'node:path';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
vi.mock('../../wallet/SeedManager', () => ({
    default: {
        requireBiometricSession: vi.fn(async () => {}),
        getMnemonic: vi.fn(async () => MNEMONIC),
    },
}));

import { getMessageKeyPair, openThreadMessage } from '../../commons/threadCrypto';
import { peHashOf, PE_V2_SCHEMA, type PeV2 } from '../meter-wire';
import { backupCompleted, MAILBOX_BACKUP_EVERY_ITEMS, MAILBOX_PAGE_SIZE, mailboxDelayAfter, METER_MAILBOX_INTERVAL_MS, METER_MAILBOX_RETRY_MS, openMailboxItem, PhoneBatcher } from '../phoneBatcher';
import { randomBytes } from '@noble/hashes/utils';
import { MemoryCloudFiles } from '../cloudFiles';
import { MemoryMeterFiles } from '../meterFiles';
import { deriveArchiveKey, PeCloudBackup } from '../peCloudBackup';
import { FakeRelay, openStore, recordPes } from './meterTestkit';
import { cpuBudget } from '../cpuBudget';
import { drainMailboxForPhoneExport, phoneMailboxIncompleteOf } from '../phoneExport';

type Sealer = { sealToKey(pub: Uint8Array, plaintext: Uint8Array, eph?: Uint8Array): Uint8Array; toB64u(b: Uint8Array): string };
let backend: Sealer;
let kp: { secretKey: Uint8Array; publicKey: Uint8Array };

beforeAll(async () => {
    backend = (await import(resolve(__dirname, '../../../../provian-backend/src/core/meter/sealed-box.ts'))) as Sealer;
    kp = await getMessageKeyPair('test');
});

function agentPe(i: number, device = 'device_agent01'): PeV2 & { pe_hash: string } {
    const pe: PeV2 = { schema: PE_V2_SCHEMA, pe_id: `agent_pe_${i}`, device_id: device, prev_hash: 'genesis', timestamp: 1_791_000_000_000 + i, action_type: 'coding_session', attestation_depth: 'software' };
    return { ...pe, pe_hash: peHashOf(pe) };
}

function seal(text: string, pub = kp.publicKey): string {
    return backend.toB64u(backend.sealToKey(pub, new TextEncoder().encode(text)));
}

function item(id: string, pe: { pe_id: string; pe_hash?: string; device_id?: string }, box: string): Record<string, unknown> {
    return { id, to: 'human:user_1', pe_id: pe.pe_id, ...(pe.pe_hash ? { pe_hash: pe.pe_hash } : {}), box, from_device: pe.device_id ?? '', from_actor: 'agent_1', batch_hash: 'b'.repeat(64), created_at_ms: 1 };
}

describe('byte compatibility: the relay seals, the phone opens', () => {
    it('a box from the backend sealToKey opens with the app\'s message key (openThreadMessage)', () => {
        const box = seal('{"hello":"phone"}');
        expect(openThreadMessage(kp.secretKey, box)).toBe('{"hello":"phone"}');
    });

    it('pinned vector: the relay sealer reproduces these exact bytes, and the phone opens them', () => {
        const PLAINTEXT = '{"schema":"provian.pe.v2","pinned":true}';
        // Produced by provian-backend sealToKey(messageKey(MNEMONIC).publicKey, PLAINTEXT, eph = 0x07 × 32) on 2026-10-03.
        const PINNED = 'ARO-T-rq8gTH_TNY_JwAchiB0XQngSgifsZ0839_6XttElsBE6Cru9PaIRv36WsmiKv7hYbpK8SF8niQMqmojegu2tHPU8nwSEDEJX7aDD1spxhLX44m7QM';
        const resealed = backend.toB64u(backend.sealToKey(kp.publicKey, new TextEncoder().encode(PLAINTEXT), new Uint8Array(32).fill(7)));
        expect(resealed).toBe(PINNED);
        expect(openThreadMessage(kp.secretKey, PINNED)).toBe(PLAINTEXT);
    });

    it('RED: a box sealed to another key, or with one flipped byte, does not open', () => {
        const other = new Uint8Array(32).fill(9);
        const wrong = backend.toB64u(backend.sealToKey(new Uint8Array(32).fill(1).map((_, i) => i + 1), new TextEncoder().encode('x')));
        void other;
        expect(openThreadMessage(kp.secretKey, wrong)).toBeNull();
        const good = backend.sealToKey(kp.publicKey, new TextEncoder().encode('x'));
        good[good.length - 1] ^= 1;
        expect(openThreadMessage(kp.secretKey, backend.toB64u(good))).toBeNull();
    });
});

describe('openMailboxItem', () => {
    it('a PE v2 is verified: its hash, id and device must be exactly the PE the item names', () => {
        const pe = agentPe(1);
        const ok = openMailboxItem(kp.secretKey, openThreadMessage, item('m1', pe, seal(JSON.stringify(pe))));
        expect(ok).toMatchObject({ format: 'pe_v2', id: pe.pe_id, hash: pe.pe_hash });
        // RED: the item names a different hash.
        expect(openMailboxItem(kp.secretKey, openThreadMessage, item('m2', { ...pe, pe_hash: 'f'.repeat(64) }, seal(JSON.stringify(pe))))).toBeNull();
        // RED: the PE inside was altered after hashing.
        expect(openMailboxItem(kp.secretKey, openThreadMessage, item('m3', pe, seal(JSON.stringify({ ...pe, action_type: 'send' }))))).toBeNull();
        // RED: another PE id than the item names.
        expect(openMailboxItem(kp.secretKey, openThreadMessage, item('m4', { ...pe, pe_id: 'other' }, seal(JSON.stringify(pe))))).toBeNull();
        // RED: filed under a device that did not make it.
        expect(openMailboxItem(kp.secretKey, openThreadMessage, item('m5', { ...pe, device_id: 'device_else' }, seal(JSON.stringify(pe))))).toBeNull();
    });

    it('a relay-authored PE v2 (no pe_hash of its own) verifies against the hash it recomputes', () => {
        const { pe_hash: _h, ...bare } = agentPe(2, 'relay:user_1');
        void _h;
        const opened = openMailboxItem(kp.secretKey, openThreadMessage, item('m6', { pe_id: bare.pe_id, device_id: 'relay:user_1' }, seal(JSON.stringify(bare))));
        expect(opened?.hash).toBe(peHashOf(bare as PeV2));
    });

    it('a pre-meter v1 envelope (no schema) is kept VERBATIM, keyed by its id', () => {
        const v1 = { id: 'pe_legacy_1', hash: 'h'.repeat(64), prev_hash: 'GENESIS', timestamp: 1_780_000_000_000, action_type: 'wallet_created', metadata: { any: 'shape' } };
        const opened = openMailboxItem(kp.secretKey, openThreadMessage, item('m7', { pe_id: 'pe_legacy_1' }, seal(JSON.stringify(v1))));
        expect(opened).toEqual({ format: 'v1_envelope', id: 'pe_legacy_1', record: v1, hash: v1.hash });
        // A v1 envelope without its own hash is kept too (identity = sha256 of its canonical JSON).
        const noHash = { id: 'pe_legacy_2', action_type: 'x' };
        expect(openMailboxItem(kp.secretKey, openThreadMessage, item('m8', { pe_id: 'pe_legacy_2' }, seal(JSON.stringify(noHash))))?.format).toBe('v1_envelope');
    });

    it('drops only a box that does not open or is not a JSON object', () => {
        expect(openMailboxItem(kp.secretKey, openThreadMessage, item('m9', { pe_id: 'x' }, seal('not json')))).toBeNull();
        expect(openMailboxItem(kp.secretKey, openThreadMessage, item('m10', { pe_id: 'x' }, seal('[1,2]')))).toBeNull();
        expect(openMailboxItem(kp.secretKey, openThreadMessage, item('m11', { pe_id: 'x' }, 'AAAA'))).toBeNull();
    });
});

function drainer(relay: FakeRelay, store: Awaited<ReturnType<typeof openStore>>['store'], backup: () => Promise<boolean>, order: string[]) {
    return new PhoneBatcher({
        store,
        transport: {
            ...relay,
            postBatch: (b) => relay.postBatch(b),
            getTip: () => relay.getTip(),
            getProofs: (a) => relay.getProofs(a),
            getMailbox: (a, l) => relay.getMailbox(a, l),
            ackMailbox: async (ids) => { order.push(`ack:${ids.length}`); return relay.ackMailbox(ids); },
        },
        messageSecretKey: async () => kp.secretKey,
        openBox: openThreadMessage,
        backupNow: async () => { order.push('backup'); return backup(); },
    });
}

describe('drain: file → back up → THEN acknowledge', () => {
    it('acks only after the backup put every filed item in the cloud; v2 and v1 both filed; a refused box is neither filed nor acked', async () => {
        const { store } = await openStore();
        const relay = new FakeRelay();
        const pe = agentPe(1);
        const v1 = { id: 'pe_legacy_9', hash: 'a'.repeat(64), timestamp: 1, action_type: 'send' };
        relay.mailbox = [
            item('m1', pe, seal(JSON.stringify(pe))),
            item('m2', { pe_id: 'pe_legacy_9' }, seal(JSON.stringify(v1))),
            item('m3', { pe_id: 'bad' }, seal('not json')),
        ];
        const order: string[] = [];
        const report = await drainer(relay, store, async () => { await store.markUploaded(store.dirtyPaths()); return true; }, order).drainMailbox();
        expect(report).toMatchObject({ ok: true, received: 2, acked: 2, refused: 1, skipped: null });
        expect(order).toEqual(['backup', 'ack:2']);
        expect(relay.acked.flat()).toEqual(['m1', 'm2']);
        const received = await store.listReceived();
        expect(received.map((r) => [r.pe_id, r.format])).toEqual([['agent_pe_1', 'pe_v2'], ['pe_legacy_9', 'v1_envelope']]);
        expect(received[1].pe).toEqual(v1); // verbatim
    });

    it('RED: when the backup did not land, nothing is acknowledged (the relay keeps its copy; the phone keeps the filed PE)', async () => {
        const { store } = await openStore();
        const relay = new FakeRelay();
        const pe = agentPe(1);
        relay.mailbox = [item('m1', pe, seal(JSON.stringify(pe)))];
        const order: string[] = [];
        const report = await drainer(relay, store, async () => false, order).drainMailbox();
        expect(report).toMatchObject({ received: 1, acked: 0, skipped: 'not_backed_up' });
        expect(relay.acked).toEqual([]);
        expect(store.receivedCount()).toBe(1);
        // RED of the RED: a backup that claims success but leaves the file pending still acks nothing.
        const report2 = await drainer(relay, store, async () => true, order).drainMailbox();
        expect(report2.acked).toBe(0);
    });

    it('an unrelated record still pending does not hold the page back: each filed item is judged by its own file ', async () => {
        const { store } = await openStore();
        const relay = new FakeRelay();
        relay.mailbox = [item('m1', agentPe(1), seal(JSON.stringify(agentPe(1)))), item('m2', agentPe(2), seal(JSON.stringify(agentPe(2))))];
        const order: string[] = [];
        // The backup run completes and uploads what it saw, but a record written meanwhile leaves the store
        // with one pending file.
        const report = await drainer(relay, store, async () => { await store.markUploaded(store.dirtyPaths()); await recordPes(store, 1); return true; }, order).drainMailbox();
        expect(store.pendingUploadCount()).toBeGreaterThan(0);
        expect(report).toMatchObject({ received: 2, acked: 2, skipped: null });
        expect(relay.acked.flat()).toEqual(['m1', 'm2']);
    });

    it('RED: a clean mark is not proof — a page whose dirty mark was lost is acknowledged only after a backup run that completed ', async () => {
        for (const mode of ['cloud_unavailable', 'failed', 'ok'] as const) {
            // File a page, then lose its dirty marks as a crash between the chunk write and dirty.json would.
            const first = await openStore();
            const pes = [agentPe(1), agentPe(2)];
            await first.store.recordReceivedMany(pes.map((pe, i) => ({
                mailbox_id: `m${i + 1}`, pe_id: pe.pe_id, format: 'pe_v2' as const, pe, pe_hash: pe.pe_hash,
                from_device: pe.device_id, from_actor: 'agent_1', batch_hash: 'b'.repeat(64), created_at_ms: 1, received_at_ms: 1,
            })));
            await first.store.flushDirty();
            await first.files.writeAtomic('dirty.json', JSON.stringify({ paths: {}, gen: 0 }));
            const { store } = await openStore(first.files);
            expect(store.pendingUploadCount()).toBe(0);
            const relay = new FakeRelay();
            relay.mailbox = pes.map((pe, i) => item(`m${i + 1}`, pe, seal(JSON.stringify(pe))));
            const cloud = new MemoryCloudFiles();
            if (mode === 'cloud_unavailable') cloud.online = false;
            if (mode === 'failed') cloud.failWritesMatching = /.*/;
            const key = await deriveArchiveKey(MNEMONIC, 'ab'.repeat(16));
            const backup = new PeCloudBackup({ store, cloud, keys: { current: async () => ({ saltHex: 'ab'.repeat(16), key }), forSalt: async () => key, adopt: async () => undefined }, randomBytes: (n) => randomBytes(n) });
            const report = await drainer(relay, store, async () => backupCompleted(await backup.backup({ allowPrompt: false, fresh: true })), []).drainMailbox();
            if (mode === 'ok') {
                expect(report.acked).toBe(2);
                // The acknowledged PEs are really in the cloud: a new phone restores both from it alone.
                const restored = await openStore(new MemoryMeterFiles(), 'device_restored');
                const keysAgain = { current: async () => ({ saltHex: 'ab'.repeat(16), key }), forSalt: async () => key, adopt: async () => undefined };
                const back = await new PeCloudBackup({ store: restored.store, cloud, keys: keysAgain, randomBytes: (n) => randomBytes(n) }).restore();
                expect(back.received).toBe(2);
            } else {
                expect(report.acked).toBe(0);
                expect(relay.acked).toEqual([]);
            }
        }
    });

    it('no message key → nothing opened, nothing acked (skipped: no_key)', async () => {
        const { store } = await openStore();
        const relay = new FakeRelay();
        const pe = agentPe(1);
        relay.mailbox = [item('m1', pe, seal(JSON.stringify(pe)))];
        const b = new PhoneBatcher({ store, transport: relay, messageSecretKey: async () => null, openBox: openThreadMessage, backupNow: async () => true });
        expect(await b.drainMailbox()).toMatchObject({ skipped: 'no_key', acked: 0, received: 0 });
    });

    it('pages through a large mailbox (the ~9,600-PE history hand-back), backs up once per batch rather than per page, acks all; re-delivery is idempotent', async () => {
        const { store } = await openStore();
        const relay = new FakeRelay();
        const n = MAILBOX_PAGE_SIZE * 2 + 37;
        relay.mailbox = Array.from({ length: n }, (_, i) => {
            const v1 = { id: `pe_hist_${i}`, hash: i.toString(16).padStart(64, '0'), timestamp: i + 1, action_type: 'ai_conversation' };
            return item(`h${i}`, { pe_id: v1.id }, seal(JSON.stringify(v1)));
        });
        const order: string[] = [];
        const report = await drainer(relay, store, async () => { await store.markUploaded(store.dirtyPaths()); return true; }, order).drainMailbox();
        expect(report).toMatchObject({ received: n, acked: n });
        expect(relay.mailboxCalls.length).toBe(3);
        // One backup for the whole drain (live 2026-10-23: one per page starved the app's screens).
        expect(order.filter((o) => o === 'backup')).toHaveLength(1);
        expect(order.indexOf('backup')).toBeLessThan(order.findIndex((o) => o.startsWith('ack:')));
        expect(relay.acked.flat()).toHaveLength(n);
        expect(store.receivedCount()).toBe(n);
        // The relay hands the same items back (an ack was lost): filed once, acked again.
        const again = await drainer(relay, store, async () => { await store.markUploaded(store.dirtyPaths()); return true; }, []).drainMailbox();
        expect(again).toMatchObject({ received: 0, acked: n });
        expect(store.receivedCount()).toBe(n);
    });
});

describe('a long drain never holds the screens (live, 2026-10-23: the app froze while a backlog filed)', () => {
    function backlogOf(n: number, tag: string): Record<string, unknown>[] {
        return Array.from({ length: n }, (_, i) => {
            const v1 = { id: `pe_${tag}_${i}`, hash: i.toString(16).padStart(64, '0'), timestamp: i + 1, action_type: 'ai_conversation' };
            return item(`${tag}${i}`, { pe_id: v1.id }, seal(JSON.stringify(v1)));
        });
    }

    it('gives the thread back by elapsed time: no stretch opens more than one slice of boxes (RED: a slice that never ends is one stretch)', async () => {
        const n = MAILBOX_PAGE_SIZE * 3 + 20;
        const SLICE = 10; // the clock is the work: one tick per box opened
        const run = async (sliceMs: number): Promise<{ stretches: number[]; opened: number }> => {
            const { store } = await openStore();
            const relay = new FakeRelay();
            relay.mailbox = backlogOf(n, 'y');
            let opened = 0;
            let since = 0;
            const stretches: number[] = [];
            const b = new PhoneBatcher({
                store, transport: relay, messageSecretKey: async () => kp.secretKey,
                openBox: (secret, box) => { opened += 1; return openThreadMessage(secret, box); },
                backupNow: async () => { await store.markUploaded(store.dirtyPaths()); return true; },
                budget: () => cpuBudget({ sliceMs, now: () => opened, yieldToUi: async () => { stretches.push(opened - since); since = opened; } }),
            });
            expect(await b.drainMailbox()).toMatchObject({ received: n, acked: n });
            stretches.push(opened - since);
            return { stretches, opened };
        };
        const paced = await run(SLICE);
        expect(paced.opened).toBe(n);
        expect(paced.stretches.length).toBeGreaterThan(n / SLICE - 1);
        expect(Math.max(...paced.stretches)).toBeLessThanOrEqual(SLICE + 1);
        // RED control: the same measurement with a slice that never ends sees one unbroken stretch.
        const unpaced = await run(Number.POSITIVE_INFINITY);
        expect(unpaced.stretches).toEqual([n]);
    });

    it('reports how many records are left to file, counting down, and clears when filing ends (RED: an older relay with no count shows no number)', async () => {
        const n = MAILBOX_PAGE_SIZE * 2 + 30;
        const seen: (number | null | 'done')[] = [];
        const { store } = await openStore();
        const relay = new FakeRelay();
        relay.mailbox = backlogOf(n, 'p');
        const b = new PhoneBatcher({
            store, transport: relay, messageSecretKey: async () => kp.secretKey, openBox: openThreadMessage,
            backupNow: async () => { await store.markUploaded(store.dirtyPaths()); return true; },
            onMailboxProgress: (p) => { seen.push(p === null ? 'done' : p.remaining); },
        });
        await b.drainMailbox();
        const counts = seen.filter((x): x is number => typeof x === 'number');
        expect(counts[0]).toBe(n);
        expect(counts).toEqual([...counts].sort((x, y) => y - x));
        expect(counts).toContain(n - MAILBOX_PAGE_SIZE);
        expect(seen[seen.length - 1]).toBe('done');

        const older = new FakeRelay();
        older.countWaiting = false;
        older.mailbox = backlogOf(5, 'q');
        const seenOld: (number | null | 'done')[] = [];
        const other = await openStore();
        await new PhoneBatcher({
            store: other.store, transport: older, messageSecretKey: async () => kp.secretKey, openBox: openThreadMessage,
            backupNow: async () => { await other.store.markUploaded(other.store.dirtyPaths()); return true; },
            onMailboxProgress: (p) => { seenOld.push(p === null ? 'done' : p.remaining); },
        }).drainMailbox();
        expect(seenOld[0]).toBeNull();
        expect(seenOld[seenOld.length - 1]).toBe('done');
        // Nothing waiting: the line never shows.
        const empty: unknown[] = [];
        const none = await openStore();
        await new PhoneBatcher({
            store: none.store, transport: new FakeRelay(), messageSecretKey: async () => kp.secretKey, openBox: openThreadMessage,
            onMailboxProgress: (p) => { empty.push(p); },
        }).drainMailbox();
        expect(empty.filter((p) => p !== null)).toEqual([]);
    });

    it('closing the app mid-drain loses nothing and files nothing twice: what was not acknowledged stays on the relay and the next unlock finishes it', async () => {
        const n = MAILBOX_PAGE_SIZE * 3 + 7;
        const { files, store } = await openStore();
        const relay = new FakeRelay();
        relay.mailbox = backlogOf(n, 'k');
        // The app is closed while the third page is being fetched: two pages filed, none backed up or acknowledged.
        let pages = 0;
        const killed = new PhoneBatcher({
            store,
            transport: { ...relay, postBatch: (x) => relay.postBatch(x), getTip: () => relay.getTip(), getProofs: (x) => relay.getProofs(x), getMailbox: async (a, l) => { if (++pages === 3) throw new Error('app closed'); return relay.getMailbox(a, l); }, ackMailbox: (ids) => relay.ackMailbox(ids) },
            messageSecretKey: async () => kp.secretKey, openBox: openThreadMessage,
            backupNow: async () => { await store.markUploaded(store.dirtyPaths()); return true; },
        });
        expect(await killed.drainMailbox()).toMatchObject({ ok: false });
        expect(relay.acked).toEqual([]);
        expect(store.receivedCount()).toBe(MAILBOX_PAGE_SIZE * 2);

        // Next launch: the store is reopened from disk and the relay still holds every item.
        const reopened = await openStore(files);
        const next = new PhoneBatcher({
            store: reopened.store, transport: relay, messageSecretKey: async () => kp.secretKey, openBox: openThreadMessage,
            backupNow: async () => { await reopened.store.markUploaded(reopened.store.dirtyPaths()); return true; },
        });
        expect(await next.drainMailbox()).toMatchObject({ ok: true, received: n - MAILBOX_PAGE_SIZE * 2, acked: n });
        expect(reopened.store.receivedCount()).toBe(n);
        const ids = (await reopened.store.listReceivedRows()).map((r) => r.mailbox_id);
        expect(new Set(ids).size).toBe(n);
        expect(new Set(relay.acked.flat()).size).toBe(n);
    });
});

describe('the PE export drains the mailbox first, and names what stays on the relay', () => {
    function bigMailbox(n: number): Record<string, unknown>[] {
        return Array.from({ length: n }, (_, i) => {
            const v1 = { id: `pe_hist_${i}`, hash: i.toString(16).padStart(64, '0'), timestamp: i + 1, action_type: 'ai_conversation' };
            return item(`h${i}`, { pe_id: v1.id }, seal(JSON.stringify(v1)));
        });
    }

    it('with the cloud behind, the export\'s drain files EVERY page (nothing acked); the scheduled drain stops at the first', async () => {
        const n = MAILBOX_BACKUP_EVERY_ITEMS + MAILBOX_PAGE_SIZE * 2 + 5;
        // The control: the scheduled drain stops at its first backup (one batch) when the backup is behind.
        const scheduled = await openStore();
        const relayA = new FakeRelay();
        relayA.mailbox = bigMailbox(n);
        await drainer(relayA, scheduled.store, async () => false, []).drainMailbox();
        expect(scheduled.store.receivedCount()).toBe(MAILBOX_BACKUP_EVERY_ITEMS);
        expect(relayA.acked).toEqual([]);
        // The export's drain files all of it, and still acknowledges nothing the cloud does not hold.
        const { store } = await openStore();
        const relay = new FakeRelay();
        relay.mailbox = bigMailbox(n);
        const b = drainer(relay, store, async () => false, []);
        const state = await drainMailboxForPhoneExport({
            drain: () => b.drainMailbox({ fileWithoutBackup: true }),
            getMailbox: (a, l) => relay.getMailbox(a, l),
            filedIds: async () => new Set((await store.listReceivedRows()).map((r) => r.mailbox_id)),
        });
        expect(store.receivedCount()).toBe(n);
        expect(relay.acked).toEqual([]);
        expect(state).toEqual({ waiting: 0, truncated: false, reason: null });
        expect(phoneMailboxIncompleteOf(state)).toEqual([]);
    }, 60_000); // seals and files 1,205 items

    it('RED: items the key cannot open stay on the relay and are counted by name in the export', async () => {
        const { store } = await openStore();
        const relay = new FakeRelay();
        const pe = agentPe(1);
        relay.mailbox = [item('m1', pe, seal(JSON.stringify(pe))), item('m2', { pe_id: 'x' }, seal('not json')), item('m3', { pe_id: 'y' }, 'AAAA')];
        const b = drainer(relay, store, async () => { await store.markUploaded(store.dirtyPaths()); return true; }, []);
        const state = await drainMailboxForPhoneExport({
            drain: () => b.drainMailbox({ fileWithoutBackup: true }),
            getMailbox: (a, l) => relay.getMailbox(a, l),
            filedIds: async () => new Set((await store.listReceivedRows()).map((r) => r.mailbox_id)),
        });
        expect(store.receivedCount()).toBe(1);
        expect(state).toEqual({ waiting: 2, truncated: false, reason: expect.stringMatching(/^unopenable: 2 item/) });
        expect(phoneMailboxIncompleteOf(state)).toEqual([{ what: 'mailbox: 2 PE(s) sealed to you still waiting on the relay', reason: state.reason }]);
    });

    it('RED: no key (Face ID declined) → every waiting item is counted; an unreadable mailbox is "not counted", never empty', async () => {
        const { store } = await openStore();
        const relay = new FakeRelay();
        const pe = agentPe(1);
        relay.mailbox = [item('m1', pe, seal(JSON.stringify(pe)))];
        const b = new PhoneBatcher({ store, transport: relay, messageSecretKey: async () => null, openBox: openThreadMessage, backupNow: async () => true });
        const noKey = await drainMailboxForPhoneExport({
            drain: () => b.drainMailbox({ fileWithoutBackup: true }),
            getMailbox: (a, l) => relay.getMailbox(a, l),
            filedIds: async () => new Set(),
        });
        expect(noKey).toEqual({ waiting: 1, truncated: false, reason: expect.stringMatching(/^no_message_key:/) });
        const down = await drainMailboxForPhoneExport({
            drain: async () => ({ ok: false, received: 0, skipped: null, refused: 0 }),
            getMailbox: async () => ({ status: null, body: null, error: 'offline' }),
            filedIds: async () => new Set(),
        });
        expect(down.waiting).toBeNull();
        expect(phoneMailboxIncompleteOf(down)[0].reason).toMatch(/^mailbox_not_counted: mailbox_unreachable/);
        expect(phoneMailboxIncompleteOf(undefined)[0].reason).toMatch(/^mailbox_not_checked:/);
    });
});

describe('a skipped drain never consumes the day ', () => {
    const HOUR = 60 * 60 * 1000;
    function clocked(relay: FakeRelay, store: Awaited<ReturnType<typeof openStore>>['store'], key: { current: Uint8Array | null }, backup: () => Promise<boolean>) {
        let clock = 1_800_000_000_000;
        const batcher = new PhoneBatcher({
            store, transport: relay, now: () => clock, resendDelayMs: 0,
            messageSecretKey: async () => key.current, openBox: openThreadMessage, backupNow: backup,
        });
        return { batcher, advance: (ms: number) => { clock += ms; } };
    }
    const backedUp = (store: Awaited<ReturnType<typeof openStore>>['store']) => async () => { await store.markUploaded(store.dirtyPaths()); return true; };

    it('no key at the daily check (still locked) → tried again within the hour, not a day later; a complete drain then waits the day', async () => {
        const { store } = await openStore();
        const relay = new FakeRelay();
        const pe = agentPe(1);
        relay.mailbox = [item('m1', pe, seal(JSON.stringify(pe)))];
        const key: { current: Uint8Array | null } = { current: null };
        const { batcher, advance } = clocked(relay, store, key, backedUp(store));
        await batcher.tick('foreground');
        expect(relay.mailboxCalls).toHaveLength(1);
        expect(store.receivedCount()).toBe(0);
        key.current = kp.secretKey; // the person unlocked
        advance(HOUR + 1);
        await batcher.tick('timer');
        expect(relay.mailboxCalls).toHaveLength(2);
        expect(store.receivedCount()).toBe(1);
        expect(relay.acked.flat()).toEqual(['m1']);
        advance(2 * HOUR);
        await batcher.tick('timer');
        expect(relay.mailboxCalls).toHaveLength(2); // complete → next check a day out
    });

    it('a drain stopped because the backup has not caught up is retried within the hour too', async () => {
        const { store } = await openStore();
        const relay = new FakeRelay();
        const pe = agentPe(1);
        relay.mailbox = [item('m1', pe, seal(JSON.stringify(pe)))];
        let cloud = false;
        const { batcher, advance } = clocked(relay, store, { current: kp.secretKey }, async () => {
            if (!cloud) return false;
            await store.markUploaded(store.dirtyPaths());
            return true;
        });
        await batcher.tick('timer');
        expect(relay.acked).toEqual([]);
        cloud = true;
        advance(HOUR + 1);
        await batcher.tick('timer');
        expect(relay.acked.flat()).toEqual(['m1']);
    });

    it('right after an unlock the mailbox is drained whatever the schedule says, and the day counts from there', async () => {
        const { store } = await openStore();
        const relay = new FakeRelay();
        const key: { current: Uint8Array | null } = { current: kp.secretKey };
        const { batcher, advance } = clocked(relay, store, key, backedUp(store));
        await batcher.tick('timer'); // empty mailbox: a complete drain, next due in a day
        expect(relay.mailboxCalls).toHaveLength(1);
        const pe = agentPe(2);
        relay.mailbox = [item('m2', pe, seal(JSON.stringify(pe)))];
        advance(HOUR);
        await batcher.tick('timer');
        expect(relay.mailboxCalls).toHaveLength(1); // not due
        expect(await batcher.drainAfterUnlock()).toMatchObject({ ok: true, received: 1, acked: 1, skipped: null });
        expect(relay.mailboxCalls).toHaveLength(2);
        advance(2 * HOUR);
        await batcher.tick('timer');
        expect(relay.mailboxCalls).toHaveLength(2);
    });

    it('mailboxDelayAfter: only a complete drain books the day', () => {
        expect(mailboxDelayAfter({ ok: true, received: 3, acked: 3, skipped: null, refused: 0 })).toBe(METER_MAILBOX_INTERVAL_MS);
        expect(mailboxDelayAfter({ ok: true, received: 0, acked: 0, skipped: 'no_key', refused: 0 })).toBe(METER_MAILBOX_RETRY_MS);
        expect(mailboxDelayAfter({ ok: true, received: 1, acked: 0, skipped: 'not_backed_up', refused: 0 })).toBe(METER_MAILBOX_RETRY_MS);
        expect(mailboxDelayAfter({ ok: false, received: 0, acked: 0, skipped: null, refused: 0 })).toBe(METER_MAILBOX_RETRY_MS);
    });
});

describe('the drain backs up what it just filed (findings, review of the first live unlock)', () => {
    it('RED: the phone meter hands the drain a fresh backup, never the scheduled run already in flight', () => {
        // Live 2026-10-23: one unlock filed 199 of 1,625, then the drain got the foreground backup's
        // earlier result back, saw its page still pending, and stopped for an hour.
        const src = readFileSync(resolve(__dirname, '../phoneMeter.ts'), 'utf8');
        expect(src).toMatch(/backupNow: async \(\) => backupCompleted\(await this\.backupNow\(\{ allowPrompt: false, fresh: true \}\)\),/);
        expect(src).toMatch(/this\.backup\.backup\(\{ allowPrompt, biometricAction: options\.biometricAction, fresh: options\.fresh \}\)/);
    });
});
