/**
 * The phone's PE store: one PE v2 chain per device, never pruned. Every guard ships its RED
 * control.
 */
import { describe, it, expect } from 'vitest';
import { METER_GENESIS_PREV_HASH, peHashOf, type PeV2 } from '../meter-wire';
import { MemoryMeterFiles } from '../meterFiles';
import { buildPhonePeV2 } from '../phonePeBuilder';
import { appendRefusal, PeStoreCorruptError, PhonePeStore, verifyDeviceChain, type StoredPe, type StoredPeV2 } from '../phonePeStore';
import { DEVICE, envelope, openStore, recordPes } from './meterTestkit';

describe('PE v2 chain on the phone', () => {
    it('chains every PE to the previous one from genesis, each with its own recomputable hash', async () => {
        const { store } = await openStore();
        const pes = await recordPes(store, 5);
        expect(pes[0].prev_hash).toBe(METER_GENESIS_PREV_HASH);
        for (let i = 1; i < pes.length; i++) expect(pes[i].prev_hash).toBe(pes[i - 1].pe_hash);
        for (const pe of pes) expect(peHashOf(pe)).toBe(pe.pe_hash);
        const all = await store.own().allPes();
        expect(all.map((e) => e.index)).toEqual([0, 1, 2, 3, 4]);
        expect(verifyDeviceChain(DEVICE, all)).toEqual({ ok: true });
    });

    it('is idempotent by pe_id: appending the same PE again answers the stored one, the chain does not grow', async () => {
        const { store } = await openStore();
        const [first] = await recordPes(store, 1);
        const again = await store.own().append(first);
        expect(again.ok && again.replay).toBe(true);
        expect((await store.own().head()).count).toBe(1);
    });

    it('survives a reload: the chain re-verifies from the files and continues', async () => {
        const { files, store } = await openStore();
        await recordPes(store, 70); // crosses a chunk boundary (64)
        const reopened = new PhonePeStore(files);
        await reopened.open(DEVICE);
        expect((await reopened.own().head()).count).toBe(70);
        await recordPes(reopened, 1);
        expect(verifyDeviceChain(DEVICE, await reopened.own().allPes())).toEqual({ ok: true });
    });

    it('RED: a PE that does not extend the head, carries another device, or whose hash was tampered is refused', async () => {
        const { store } = await openStore();
        await recordPes(store, 2);
        const head = await store.own().head();
        const good = await buildPhonePeV2({ envelope: envelope(), detailHash: 'd'.repeat(64), deviceId: DEVICE, prevHash: head.last_pe_hash });
        expect(appendRefusal(head, DEVICE, good)).toBeNull();

        const forked = await buildPhonePeV2({ envelope: envelope(), detailHash: 'd'.repeat(64), deviceId: DEVICE, prevHash: METER_GENESIS_PREV_HASH });
        expect(appendRefusal(head, DEVICE, forked)).toBe('prev_hash_mismatch');
        const res = await store.own().append(forked);
        expect(res.ok).toBe(false);

        const otherDevice = await buildPhonePeV2({ envelope: envelope(), detailHash: 'd'.repeat(64), deviceId: 'device_other', prevHash: head.last_pe_hash });
        expect(appendRefusal(head, DEVICE, otherDevice)).toBe('device_mismatch');

        const tampered = { ...good, action_type: 'send' } as StoredPeV2;
        expect(appendRefusal(head, DEVICE, tampered)).toBe('pe_hash_mismatch');
        expect((await store.own().head()).count).toBe(2);
    });

    it('RED: a stored chain whose link was edited on disk refuses to load (never silently re-linked)', async () => {
        const { files, store } = await openStore();
        await recordPes(store, 3);
        const path = 'chains/device_aaaa1111/pes/000000.json';
        const rows = JSON.parse((await files.read(path)) as string) as StoredPe[];
        const edited = rows.map((r, i) => (i === 2 ? { ...r, pe: { ...r.pe, prev_hash: METER_GENESIS_PREV_HASH } } : r));
        await files.writeAtomic(path, JSON.stringify(edited));
        const reopened = new PhonePeStore(files);
        await expect(reopened.open(DEVICE)).rejects.toBeInstanceOf(PeStoreCorruptError);
    });

    it('never deletes a record file: removing anything but a transient file is refused', async () => {
        const files = new MemoryMeterFiles();
        await expect(files.removeTransient('chains/device_aaaa1111/pes/000000.json')).rejects.toThrow(/refuse_remove/);
        await expect(files.removeTransient('chains/device_aaaa1111/inflight.json')).resolves.toBeUndefined();
    });

    it('importPes verifies every link from the current head and imports nothing on a break', async () => {
        const source = await openStore(new MemoryMeterFiles(), 'device_source');
        await recordPes(source.store, 4);
        const rows = await source.store.own().allPes();
        const target = await openStore();
        const chain = await target.store.chain('device_source');
        // RED: a gap (row 2 missing) refuses the whole import.
        await expect(chain.importPes([rows[0], rows[1], rows[3]])).rejects.toBeInstanceOf(PeStoreCorruptError);
        expect((await chain.head()).count).toBe(0);
        // RED: a tampered PE refuses the whole import.
        const bad = rows.map((r, i) => (i === 1 ? { ...r, pe: { ...r.pe, timestamp: r.pe.timestamp + 1 } } : r));
        await expect(chain.importPes(bad)).rejects.toBeInstanceOf(PeStoreCorruptError);
        expect((await chain.head()).count).toBe(0);
        // GREEN: the intact chain imports, and re-importing it is a no-op.
        expect(await chain.importPes(rows)).toEqual({ imported: 4 });
        expect(await chain.importPes(rows)).toEqual({ imported: 0 });
    });

    it('received and legacy records are idempotent and counted', async () => {
        const { store } = await openStore();
        const pe = { schema: 'provian.pe.v2', pe_id: 'p1', device_id: 'device_agent', prev_hash: 'genesis', timestamp: 1, action_type: 'x' } as PeV2;
        const item = { mailbox_id: 'm1', pe_id: 'p1', format: 'pe_v2' as const, pe, pe_hash: peHashOf(pe), from_device: 'device_agent', from_actor: 'agent_1', batch_hash: '', created_at_ms: 1, received_at_ms: 2 };
        expect((await store.recordReceived(item)).filed).toBe(true);
        expect((await store.recordReceived({ ...item, mailbox_id: 'm2' })).filed).toBe(false); // same PE, second delivery
        expect(store.receivedCount()).toBe(1);
        const env = envelope();
        expect(await store.addLegacy([env, env])).toBe(1);
        expect(await store.addLegacy([env])).toBe(0);
        expect(store.legacyCount()).toBe(1);
        const s = await store.summary();
        expect(s).toMatchObject({ received: 1, legacy: 1 });
    });
});
