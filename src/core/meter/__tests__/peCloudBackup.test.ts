/**
 * The encrypted PE backup in the person's own cloud, and the restore that rebuilds the store from
 * it with no relay at all. The key is the seed-derived PE archive key (HKDF-SHA256 over the
 * mnemonic, 'provian-pe-archive-v2'), exactly as PECloudSync derives it. RED controls per.
 */
import { describe, it, expect } from 'vitest';
import { randomBytes } from '@noble/hashes/utils';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { MemoryCloudFiles } from '../cloudFiles';
import { peHashOf, PE_V2_SCHEMA, type PeV2 } from '../meter-wire';
import { MemoryMeterFiles } from '../meterFiles';
import {
    cloudNameOf,
    decryptFile,
    deriveArchiveKey,
    encryptFile,
    PE_BACKUP_INDEX_NAME,
    PE_BACKUP_MANIFEST_PREFIX,
    PE_BACKUP_INDEX_SCHEMA,
    PeCloudBackup,
    checkedTextHash,
    sha256HexOfUtf8,
    type BackupKey,
    type BackupKeyProvider,
} from '../peCloudBackup';
import { PhonePeStore, type StoredPe } from '../phonePeStore';
import { DEVICE, envelope, FakeRelay, openStore, recordPes } from './meterTestkit';
import { PhoneBatcher } from '../phoneBatcher';
import { cpuBudget } from '../cpuBudget';
import { invalidateSeedDerivedCaches } from '../../security/seedDerivedCache';

const MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const SALT = 'ab'.repeat(16);

async function keysFor(mnemonic: string, salt = SALT): Promise<BackupKeyProvider & { adopted: BackupKey[] }> {
    const adopted: BackupKey[] = [];
    const key = await deriveArchiveKey(mnemonic, salt);
    return {
        adopted,
        async current() { return { saltHex: salt, key }; },
        async forSalt(s) { return deriveArchiveKey(mnemonic, s); },
        async adopt(k) { adopted.push(k); },
    };
}

function backupOf(store: PhonePeStore, cloud: MemoryCloudFiles, keys: BackupKeyProvider): PeCloudBackup {
    return new PeCloudBackup({ store, cloud, keys, randomBytes: (n) => randomBytes(n) });
}

describe('the cloud file format', () => {
    it('the key is HKDF-SHA256(mnemonic, salt, "provian-pe-archive-v2") — the PECloudSync archive key', async () => {
        const expected = hkdf(sha256, utf8ToBytes(MNEMONIC), hexToBytes(SALT), utf8ToBytes('provian-pe-archive-v2'), 32);
        expect(await deriveArchiveKey(MNEMONIC, SALT)).toEqual(expected);
    });

    it('AES-256-GCM round trip; RED: a wrong key, a flipped byte, or a file presented under another name fails', async () => {
        const key = await deriveArchiveKey(MNEMONIC, SALT);
        const wire = encryptFile(key, 'pe_aaa', 'secret record', randomBytes(12));
        expect(decryptFile(key, 'pe_aaa', wire)).toBe('secret record');
        expect(wire).not.toContain('secret');
        const wrong = await deriveArchiveKey('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong', SALT);
        expect(() => decryptFile(wrong, 'pe_aaa', wire)).toThrow();
        expect(() => decryptFile(key, 'pe_bbb', wire)).toThrow(); // name is the AAD: no swapping files
        const parsed = JSON.parse(wire) as { data: string };
        const flipped = JSON.stringify({ ...JSON.parse(wire), data: (parsed.data[0] === 'A' ? 'B' : 'A') + parsed.data.slice(1) });
        expect(() => decryptFile(key, 'pe_aaa', flipped)).toThrow();
    });
});

describe('backup', () => {
    it('uploads every record file encrypted; nothing readable reaches the cloud; the index is written last', async () => {
        const { store } = await openStore();
        await recordPes(store, 3, { intent_text: 'Paid Maria for tamales' });
        await store.addLegacy([envelope({ intent_text: 'legacy private note' })]);
        const cloud = new MemoryCloudFiles();
        const report = await backupOf(store, cloud, await keysFor(MNEMONIC)).backup();
        expect(report).toMatchObject({ ok: true, state: 'ok' });
        expect(store.pendingUploadCount()).toBe(0);
        const all = [...cloud.files.values()].join('\n');
        for (const secret of ['tamales', 'legacy private note', 'private words', DEVICE, '"pe_hash"']) expect(all).not.toContain(secret);
        const names = [...cloud.files.keys()];
        expect(names.filter(n => n.startsWith(PE_BACKUP_MANIFEST_PREFIX))).toHaveLength(1);
        expect(names.at(-1)?.startsWith(PE_BACKUP_MANIFEST_PREFIX)).toBe(true);
        for (const n of names) expect(n).toMatch(/^pe_/);
    });

    it('is append-friendly: a second backup after one new PE re-uploads only the chunk that grew (+ the index)', async () => {
        const { store } = await openStore();
        await recordPes(store, 70);
        const cloud = new MemoryCloudFiles();
        const backup = backupOf(store, cloud, await keysFor(MNEMONIC));
        await backup.backup();
        const before = cloud.writes;
        await recordPes(store, 1);
        await backup.backup();
        // chunk 000001 (PE 64..70) + the index. Chunk 000000 (full) is untouched.
        expect(cloud.writes - before).toBe(2);
        await backup.backup(); // nothing changed → nothing written
        expect(cloud.writes - before).toBe(2);
    });

    it('cloud unavailable / key not obtainable silently → nothing uploaded, files stay pending, state says why', async () => {
        const { store } = await openStore();
        await recordPes(store, 1);
        const off = new MemoryCloudFiles();
        off.online = false;
        expect((await backupOf(store, off, await keysFor(MNEMONIC)).backup()).state).toBe('cloud_unavailable');
        const locked: BackupKeyProvider = { current: async () => null, forSalt: async () => null, adopt: async () => {} };
        expect((await backupOf(store, new MemoryCloudFiles(), locked).backup()).state).toBe('waiting_for_unlock');
        expect(store.pendingUploadCount()).toBeGreaterThan(0);
    });

    it('RED: a write that fails mid-backup leaves its file pending (not marked uploaded) and the index unwritten', async () => {
        const { store } = await openStore();
        await recordPes(store, 2);
        const cloud = new MemoryCloudFiles();
        cloud.failWritesMatching = /^pe_(?!index)/;
        const report = await backupOf(store, cloud, await keysFor(MNEMONIC)).backup();
        expect(report.state).toBe('failed');
        expect(store.pendingUploadCount()).toBeGreaterThan(0);
        expect(cloud.files.has(PE_BACKUP_INDEX_NAME)).toBe(false);
    });

    it('restores independently committed phones even when they started under different salts)', async () => {
        const a = await openStore(new MemoryMeterFiles(), 'device_phone_a');
        await recordPes(a.store, 2);
        const cloud = new MemoryCloudFiles();
        await backupOf(a.store, cloud, await keysFor(MNEMONIC, 'aa'.repeat(16))).backup();
        const b = await openStore(new MemoryMeterFiles(), 'device_phone_b');
        await recordPes(b.store, 1);
        const keysB = await keysFor(MNEMONIC, 'bb'.repeat(16));
        expect((await backupOf(b.store, cloud, keysB).backup()).state).toBe('ok');
        expect(keysB.adopted.map(k => k.saltHex)).toEqual(['aa'.repeat(16)]);
        // One index, both phones' chains in it.
        const restored = await openStore(new MemoryMeterFiles(), 'device_new');
        const report = await backupOf(restored.store, cloud, await keysFor(MNEMONIC)).restore();
        expect(report.devices.map((d) => d.deviceId).sort()).toEqual(['device_phone_a', 'device_phone_b']);
    });
});

describe('a backup that must include what the caller just filed (findings, mailbox on unlock)', () => {
    /** A cloud whose first write waits until released, so a second backup starts while the first runs. */
    class GatedCloud extends MemoryCloudFiles {
        release: () => void = () => undefined;
        private gate: Promise<void> | null = new Promise<void>((r) => { this.release = r; });
        override async write(name: string, text: string): Promise<void> {
            const g = this.gate;
            if (g) { this.gate = null; await g; }
            return super.write(name, text);
        }
    }

    const overlapping = async (fresh: boolean) => {
        const { store } = await openStore();
        await recordPes(store, 1);
        const cloud = new GatedCloud();
        const backup = backupOf(store, cloud, await keysFor(MNEMONIC));
        const scheduled = backup.backup(); // e.g. the foreground tick, started before the mailbox page was filed
        await new Promise((r) => setTimeout(r, 0));
        await recordPes(store, 1, { intent_text: 'filed while the first backup ran' });
        const mine = backup.backup({ allowPrompt: false, ...(fresh ? { fresh: true } : {}) });
        cloud.release();
        await scheduled;
        await mine;
        return store.pendingUploadCount();
    };

    it('fresh: waits for the backup in flight, then runs one that includes the new files', async () => {
        expect(await overlapping(true)).toBe(0);
    });

    it('RED: without fresh the caller gets the earlier run back and its new files are still pending', async () => {
        expect(await overlapping(false)).toBeGreaterThan(0);
    });
});

describe('restore — rebuild the store from the cloud alone', () => {
    async function populated() {
        const { store } = await openStore();
        const relay = new FakeRelay();
        await recordPes(store, 5);
        await new PhoneBatcher({ store, transport: relay, resendDelayMs: 0 }).flush();
        await recordPes(store, 2); // two not yet batched
        const pe: PeV2 = { schema: PE_V2_SCHEMA, pe_id: 'agent_pe', device_id: 'device_agent', prev_hash: 'genesis', timestamp: 5, action_type: 'coding_session' };
        await store.recordReceived({ mailbox_id: 'm1', pe_id: 'agent_pe', format: 'pe_v2', pe, pe_hash: peHashOf(pe), from_device: 'device_agent', from_actor: 'agent_1', batch_hash: '', created_at_ms: 1, received_at_ms: 2 });
        await store.recordReceived({ mailbox_id: 'm2', pe_id: 'pe_legacy_1', format: 'v1_envelope', pe: { id: 'pe_legacy_1', hash: 'c'.repeat(64) }, pe_hash: 'c'.repeat(64), from_device: '', from_actor: '', batch_hash: '', created_at_ms: 1, received_at_ms: 2 });
        await store.addLegacy([envelope(), envelope()]);
        const cloud = new MemoryCloudFiles();
        await backupOf(store, cloud, await keysFor(MNEMONIC)).backup();
        return { store, cloud };
    }

    it('a new phone (new device id) gets every chain re-verified, receipts, received PEs (v2 + v1) and legacy history — no relay involved', async () => {
        const { store: original, cloud } = await populated();
        const fresh = await openStore(new MemoryMeterFiles(), 'device_new_phone');
        const keys = await keysFor(MNEMONIC, 'cd'.repeat(16)); // a fresh install has its own salt until it reads the cloud's
        const report = await backupOf(fresh.store, cloud, keys).restore();
        expect(report.found).toBe(true);
        expect(report.refusedFiles).toEqual([]);
        expect(report.devices).toEqual([{ deviceId: DEVICE, pes: 7, imported: 7 }]);
        expect(report.received).toBe(2);
        expect(report.legacy).toBe(2);
        expect(report.envelopes.length).toBe(7 + 2); // full on-phone records for the activity screens
        expect(keys.adopted.map((k) => k.saltHex)).toEqual([SALT]);
        const restoredChain = await fresh.store.chain(DEVICE);
        expect((await restoredChain.allPes()).map((e) => e.pe.pe_hash)).toEqual((await original.own().allPes()).map((e) => e.pe.pe_hash));
        expect(await restoredChain.listReceipts()).toEqual(await original.own().listReceipts());
        // The restored chain is history of another device; this phone's own chain starts at genesis.
        expect((await fresh.store.own().head()).count).toBe(0);
        // Restoring twice changes nothing.
        const again = await backupOf(fresh.store, cloud, keys).restore();
        expect(again.devices[0].imported).toBe(0);
        expect(fresh.store.receivedCount()).toBe(2);
    });

    it('the restored store survives a reload (the other-device chain, received and legacy directories are listed and re-verified)', async () => {
        const { cloud } = await populated();
        const files = new MemoryMeterFiles();
        const fresh = await openStore(files, 'device_new_phone');
        await backupOf(fresh.store, cloud, await keysFor(MNEMONIC)).restore();
        const reopened = new PhonePeStore(files);
        await reopened.open('device_new_phone');
        expect(reopened.deviceIds().sort()).toEqual([DEVICE, 'device_new_phone'].sort());
        expect(reopened.receivedCount()).toBe(2);
        expect(reopened.legacyCount()).toBe(2);
    });

    it('RED: a tampered chain in the cloud (re-encrypted with the right key, so it decrypts) is refused whole — nothing of that device imported', async () => {
        const { cloud } = await populated();
        const key = await deriveArchiveKey(MNEMONIC, SALT);
        const manifest = [...cloud.files.keys()].find(n => n.startsWith(PE_BACKUP_MANIFEST_PREFIX))!;
        const indexWire = JSON.parse(cloud.files.get(manifest)!) as { nonce: string; data: string };
        const index = JSON.parse(decryptFile(key, manifest, JSON.stringify({ v: 1, alg: 'AES-256-GCM', nonce: indexWire.nonce, data: indexWire.data }))) as { files: Record<string, { path: string; sha256: string }> };
        const name = Object.keys(index.files).find(n => index.files[n].path === `chains/${DEVICE}/pes/000000.json`)!;
        const rows = JSON.parse(decryptFile(key, name, cloud.files.get(name)!)) as StoredPe[];
        rows[3] = { ...rows[3], pe: { ...rows[3].pe, action_type: 'send' } };
        // Also fix the index sha so only the chain check can catch it.
        const text = JSON.stringify(rows);
        cloud.files.set(name, encryptFile(key, name, text, randomBytes(12)));
        const { bytesToHex } = await import('@noble/hashes/utils');
        index.files[name].sha256 = bytesToHex(sha256(utf8ToBytes(text)));
        const box = JSON.parse(encryptFile(key, manifest, JSON.stringify(index), randomBytes(12))) as { nonce: string; data: string };
        cloud.files.set(manifest, JSON.stringify({ ...JSON.parse(cloud.files.get(manifest)!), nonce: box.nonce, data: box.data }));

        const fresh = await openStore(new MemoryMeterFiles(), 'device_new_phone');
        const report = await backupOf(fresh.store, cloud, await keysFor(MNEMONIC)).restore();
        expect(report.devices).toEqual([]);
        expect(report.refusedFiles.some((f) => f.startsWith(`chains/${DEVICE}:`))).toBe(true);
        expect((await (await fresh.store.chain(DEVICE)).head()).count).toBe(0);
        expect(report.received).toBe(2); // other records still come back
    });

    it('RED: a file that is not the version the index names is refused', async () => {
        const { cloud } = await populated();
        const key = await deriveArchiveKey(MNEMONIC, SALT);
        // Replace a legacy file's content (valid ciphertext under the right key) without updating the index.
        const target = [...cloud.files.keys()].find((n) => !n.startsWith(PE_BACKUP_MANIFEST_PREFIX) && n !== PE_BACKUP_INDEX_NAME && decryptFile(key, n, cloud.files.get(n)!).includes('"envelope_id"') && !decryptFile(key, n, cloud.files.get(n)!).includes('"index"'))!;
        cloud.files.set(target, encryptFile(key, target, '[]', randomBytes(12)));
        const fresh = await openStore(new MemoryMeterFiles(), 'device_new_phone');
        const report = await backupOf(fresh.store, cloud, await keysFor(MNEMONIC)).restore();
        expect(report.refusedFiles.some((f) => f.endsWith(':not_the_indexed_version'))).toBe(true);
    });

    it('RED: the wrong recovery phrase cannot read the backup (restore throws, nothing imported)', async () => {
        const { cloud } = await populated();
        const fresh = await openStore(new MemoryMeterFiles(), 'device_new_phone');
        await expect(backupOf(fresh.store, cloud, await keysFor('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong')).restore()).rejects.toThrow();
        expect(fresh.store.receivedCount()).toBe(0);
    });

    it('restores the existing v1 format and retains it unchanged through a new backup', async () => {
        const { cloud } = await populated();
        const key = await deriveArchiveKey(MNEMONIC, SALT);
        const manifest = [...cloud.files.keys()].find(n => n.startsWith(PE_BACKUP_MANIFEST_PREFIX))!;
        const wire = JSON.parse(cloud.files.get(manifest)!);
        const index = JSON.parse(decryptFile(key, manifest, JSON.stringify({ v: 1, alg: 'AES-256-GCM', nonce: wire.nonce, data: wire.data })));
        const oldCloud = new MemoryCloudFiles();
        const files: Record<string, unknown> = {};
        for (const [name, entry] of Object.entries(index.files) as [string, { path: string }][]) {
            const oldName = cloudNameOf(entry.path);
            oldCloud.files.set(oldName, encryptFile(key, oldName, decryptFile(key, name, cloud.files.get(name)!), randomBytes(12)));
            files[oldName] = entry;
        }
        const box = JSON.parse(encryptFile(key, PE_BACKUP_INDEX_NAME, JSON.stringify({ ...index, files }), randomBytes(12)));
        oldCloud.files.set(PE_BACKUP_INDEX_NAME, JSON.stringify({ ...wire, schema: PE_BACKUP_INDEX_SCHEMA, nonce: box.nonce, data: box.data }));
        const before = new Map(oldCloud.files);
        const fresh = await openStore(new MemoryMeterFiles(), 'new_phone');
        const backup = backupOf(fresh.store, oldCloud, await keysFor(MNEMONIC));
        expect((await backup.restore()).devices[0].pes).toBe(7);
        expect((await backup.backup()).ok).toBe(true);
        for (const [name, text] of before) expect(oldCloud.files.get(name)).toBe(text);
        const next = await openStore(new MemoryMeterFiles(), 'next_phone');
        expect((await backupOf(next.store, oldCloud, await keysFor(MNEMONIC)).restore()).devices.find(d => d.deviceId === DEVICE)?.pes).toBe(7);
    });

    it('an empty cloud is "nothing found", not an error', async () => {
        const fresh = await openStore(new MemoryMeterFiles(), 'device_new_phone');
        const report = await backupOf(fresh.store, new MemoryCloudFiles(), await keysFor(MNEMONIC)).restore();
        expect(report.found).toBe(false);
    });
});

describe('a backup run stays off the JS thread on a large store (findings, 2026-10-23)', () => {
    class CountingCloud extends MemoryCloudFiles {
        reads: string[] = [];
        override async read(name: string): Promise<string | null> {
            this.reads.push(name);
            return super.read(name);
        }
    }

    it('hashes each record file through the injected (native) digest, with the same hashes the restore checks', async () => {
        const { store } = await openStore();
        await recordPes(store, 5);
        const cloud = new MemoryCloudFiles();
        const hashed: number[] = [];
        const backup = new PeCloudBackup({
            store, cloud, keys: await keysFor(MNEMONIC), randomBytes: (n) => randomBytes(n),
            hashText: async (text) => { hashed.push(text.length); return sha256HexOfUtf8(text); },
        });
        expect(await backup.backup()).toMatchObject({ ok: true, state: 'ok' });
        const held = (await Promise.all(store.allRecordPaths().map((p) => store.files.read(p)))).filter((t) => t !== null);
        expect(held.length).toBeGreaterThan(0);
        expect(hashed.length).toBe(held.length);
        const fresh = new PhonePeStore(new MemoryMeterFiles());
        await fresh.open('device_new_phone');
        await backupOf(fresh, cloud, await keysFor(MNEMONIC)).restore();
        expect(await (await fresh.chain(DEVICE)).head()).toEqual(await store.own().head());
    });

    it('checkedTextHash uses the native digest only when it agrees with the JS digest (RED: a wrong or failing native digest never reaches the index)', async () => {
        const text = '{"pe":"é✓ record"}';
        let calls = 0;
        const good = checkedTextHash(async (t) => { calls += 1; return sha256HexOfUtf8(t); });
        expect(await good(text)).toBe(sha256HexOfUtf8(text));
        expect(calls).toBe(2); // the one-time check, then the text
        const lying = checkedTextHash(async () => 'f'.repeat(64));
        expect(await lying(text)).toBe(sha256HexOfUtf8(text));
        const throwing = checkedTextHash(async () => { throw new Error('native unavailable'); });
        expect(await throwing(text)).toBe(sha256HexOfUtf8(text));
        // Agrees on the check, then returns something that is not a digest for one text: the JS digest is used.
        let n = 0;
        const flaky = checkedTextHash(async (t) => (++n === 1 ? sha256HexOfUtf8(t) : 'not-hex'));
        expect(await flaky(text)).toBe(sha256HexOfUtf8(text));
    });

    it('reads and decrypts each immutable snapshot once per session, not on every run (RED: a new session reads them all again)', async () => {
        const { store } = await openStore();
        const cloud = new CountingCloud();
        const keys = await keysFor(MNEMONIC);
        const backup = backupOf(store, cloud, keys);
        for (let i = 0; i < 4; i += 1) {
            await recordPes(store, 1);
            await backup.backup();
        }
        const snapshots = [...cloud.files.keys()].filter((k) => k.startsWith(PE_BACKUP_MANIFEST_PREFIX));
        expect(snapshots.length).toBe(4);
        cloud.reads = [];
        await recordPes(store, 1);
        expect(await backup.backup()).toMatchObject({ ok: true });
        expect(cloud.reads.filter((r) => snapshots.includes(r))).toEqual([]);
        // RED control: a new session (new instance) has no cache and reads every snapshot.
        cloud.reads = [];
        await recordPes(store, 1);
        expect(await backupOf(store, cloud, keys).backup()).toMatchObject({ ok: true });
        expect(cloud.reads.filter((r) => snapshots.includes(r)).sort()).toEqual([...snapshots].sort());
    });

    it('RED: a cached snapshot is never reused under another wallet\'s key — the AEAD check runs again and refuses it', async () => {
        const { store } = await openStore();
        const cloud = new CountingCloud();
        // One provider whose seed changes mid-session (Delete All Data, then another wallet restored).
        let mnemonic = MNEMONIC;
        const keys: BackupKeyProvider = {
            async current() { return { saltHex: SALT, key: await deriveArchiveKey(mnemonic, SALT) }; },
            async forSalt(s) { return deriveArchiveKey(mnemonic, s); },
            async adopt() { /* same salt */ },
        };
        const backup = backupOf(store, cloud, keys);
        await recordPes(store, 2);
        expect(await backup.backup()).toMatchObject({ ok: true });
        mnemonic = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
        const fresh = new PhonePeStore(new MemoryMeterFiles());
        await fresh.open('device_other_wallet');
        // Same instance, other key: the snapshot this session wrote and cached must not be accepted.
        await expect(new PeCloudBackup({ store: fresh, cloud, keys, randomBytes: (n) => randomBytes(n) }).restore()).rejects.toThrow();
        const reused = backup as unknown as { readIndexes(o: { allowPrompt: boolean }): Promise<unknown> };
        await expect(reused.readIndexes({ allowPrompt: false })).rejects.toThrow('backup_indexes_unreadable');
        // A seed change also forgets the cache outright.
        // A seed change also forgets the cache outright: fill it under the right key, then invalidate.
        mnemonic = MNEMONIC;
        await reused.readIndexes({ allowPrompt: false });
        cloud.reads = [];
        await reused.readIndexes({ allowPrompt: false });
        expect(cloud.reads.some((r) => r.startsWith(PE_BACKUP_MANIFEST_PREFIX))).toBe(false); // cached
        invalidateSeedDerivedCaches();
        await reused.readIndexes({ allowPrompt: false });
        expect(cloud.reads.some((r) => r.startsWith(PE_BACKUP_MANIFEST_PREFIX))).toBe(true);
    });

    it('paces its walk over the store by elapsed time (RED: a slice that never ends is one stretch)', async () => {
        const { store } = await openStore();
        await recordPes(store, 3 * 64 + 5);
        await store.addLegacy([envelope()]);
        const run = async (sliceMs: number): Promise<number> => {
            let ticks = 0;
            let yields = 0;
            await recordPes(store, 1);
            const b = new PeCloudBackup({
                store, cloud: new MemoryCloudFiles(), keys: await keysFor(MNEMONIC), randomBytes: (n) => randomBytes(n),
                budget: () => cpuBudget({ sliceMs, now: () => ticks++, yieldToUi: async () => { yields += 1; } }),
            });
            expect(await b.backup()).toMatchObject({ ok: true });
            return yields;
        };
        expect(await run(2)).toBeGreaterThanOrEqual(2);
        expect(await run(Number.POSITIVE_INFINITY)).toBe(0);
    });
});
