/**
 * The whole phone loop under Vitest: record → PE v2 chain → batch → receipt → backup → restore on
 * a "new phone", the pre-meter migration (copied, never re-chained), and the relay-handed
 * `firstEnvelope` from registration filed durably. RED controls per.
 */
import { describe, it, expect } from 'vitest';
import { randomBytes } from '@noble/hashes/utils';
import type { ProvenanceEnvelope } from '../../provenance/types';
import { MemoryCloudFiles } from '../cloudFiles';
import { peHashOf, PE_V2_SCHEMA, type PeV2 } from '../meter-wire';
import { MemoryMeterFiles } from '../meterFiles';
import { deriveArchiveKey, type BackupKeyProvider } from '../peCloudBackup';
import type { PhoneArchiveTransport } from '../phoneArchive';
import { METER_CUTOVER_KEY, PhoneMeter, RETIRED_SUBMIT_KEYS, type KeyValue } from '../phoneMeter';
import { RELAY_AUTHORED_INBOX_KEY, stageRelayAuthoredPe, validateRelayAuthoredPe } from '../relayAuthoredInbox';
import { envelope, FakeRelay, T0 } from './meterTestkit';

const MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

class MemKv implements KeyValue {
    readonly m = new Map<string, string>();
    async getItem(k: string) { return this.m.get(k) ?? null; }
    async setItem(k: string, v: string) { this.m.set(k, v); }
    async removeItem(k: string) { this.m.delete(k); }
}

async function keys(salt = 'ab'.repeat(16)): Promise<BackupKeyProvider> {
    return {
        current: async () => ({ saltHex: salt, key: await deriveArchiveKey(MNEMONIC, salt) }),
        forSalt: async (s) => deriveArchiveKey(MNEMONIC, s),
        adopt: async () => {},
    };
}

function meterFor(opts: { device: string; cloud: MemoryCloudFiles; relay: FakeRelay; hot?: ProvenanceEnvelope[]; kv?: MemKv; now?: () => number }) {
    const hot = opts.hot ?? [];
    const restored: ProvenanceEnvelope[] = [];
    const kv = opts.kv ?? new MemKv();
    return {
        kv,
        restored,
        hot,
        meter: (async () => new PhoneMeter({
            files: new MemoryMeterFiles(),
            cloud: opts.cloud,
            transport: opts.relay,
            backupKeys: await keys(),
            kv,
            activity: {
                hot: async () => hot,
                archived: async () => [],
                restore: async (envs) => { restored.push(...envs); return envs.length; },
            },
            deviceId: async () => opts.device,
            detailHash: async () => 'd'.repeat(64),
            messageSecretKey: async () => null,
            openBox: () => null,
            randomBytes: (n) => randomBytes(n),
            isForeground: () => true,
            now: opts.now ?? (() => T0 + 50_000_000),
        }))(),
    };
}

describe('PhoneMeter', () => {
    it('records each new act as a PE v2, sends it, files the receipt, and backs it all up', async () => {
        const cloud = new MemoryCloudFiles();
        const relay = new FakeRelay();
        const kv = new MemKv();
        kv.m.set(RETIRED_SUBMIT_KEYS[0], '[{"envelope_id":"old"}]');
        const { meter: m } = meterFor({ device: 'device_phone1', cloud, relay, kv });
        const meter = await m;
        await meter.start();
        expect(kv.m.has(RETIRED_SUBMIT_KEYS[0])).toBe(false); // the retired submit queue is gone
        const cutover = Number(kv.m.get(METER_CUTOVER_KEY));
        await meter.record([envelope({ timestamp: cutover + 1 }), envelope({ timestamp: cutover + 2 })]);
        // Daily batches : recording sends nothing by itself...
        expect(await meter.status()).toMatchObject({ ownPes: 2, unsentPes: 2, batches: 0 });
        // ...and the latest acts go at once before a presentation or payout.
        expect(await meter.sendBeforeUse()).toBe('sent');
        const status = await meter.status();
        expect(status).toMatchObject({ ownPes: 2, unsentPes: 0, batches: 1 });
        await meter.backupNow({ allowPrompt: false });
        expect((await meter.status()).backup).toMatchObject({ state: 'ok', pending_files: 0 });
        expect(cloud.files.size).toBeGreaterThan(1);
    });

    it('pre-meter history is copied as legacy, never chained or metered; RED: a post-cut-over act IS chained', async () => {
        const relay = new FakeRelay();
        const old = [envelope({ timestamp: T0 + 1 }), envelope({ timestamp: T0 + 2 })];
        const { meter: m, hot } = meterFor({ device: 'device_phone1', cloud: new MemoryCloudFiles(), relay, hot: [...old] });
        const meter = await m;
        await meter.start();
        let s = await meter.status();
        expect(s).toMatchObject({ legacyRecords: 2, ownPes: 0 });
        expect(relay.posted).toEqual([]);
        // Recording the same old envelopes again changes nothing.
        await meter.record(old);
        expect((await meter.status()).ownPes).toBe(0);
        const fresh = envelope({ timestamp: T0 + 60_000_000 });
        hot.push(fresh);
        await meter.record([fresh]);
        s = await meter.status();
        expect(s.ownPes).toBe(1);
    });

    it('restore on a new phone brings every PE back from the cloud alone, and a restored act is never metered again', async () => {
        const cloud = new MemoryCloudFiles();
        const relay = new FakeRelay();
        const a = meterFor({ device: 'device_phone_a', cloud, relay });
        const meterA = await a.meter;
        await meterA.start();
        const cut = Number(a.kv.m.get(METER_CUTOVER_KEY));
        const acts = [envelope({ timestamp: cut + 1 }), envelope({ timestamp: cut + 2 }), envelope({ timestamp: cut + 3 })];
        await meterA.record(acts);
        await meterA.backupNow({ allowPrompt: false });
        const postsBefore = relay.posted.length;

        // Phone A is lost. Phone B: same wallet, new relay device id, an empty store.
        // B's cut-over is EARLIER than the acts (clock skew / same install): only the chain lookup stops a re-meter.
        const b = meterFor({ device: 'device_phone_b', cloud, relay, now: () => T0 });
        const meterB = await b.meter;
        const report = await meterB.restoreAfterRecovery();
        expect(report.devices).toEqual([{ deviceId: 'device_phone_a', pes: 3, imported: 3 }]);
        expect(b.restored.map((e) => e.envelope_id)).toEqual(acts.map((e) => e.envelope_id));
        // The app later hands the same envelopes to the recorder (e.g. its catch-up): nothing new is chained or sent.
        await meterB.record(acts);
        const s = await meterB.status();
        expect(s.ownPes).toBe(0);
        expect(s.otherDevicePes).toBe(3);
        expect(relay.posted.length).toBe(postsBefore);
    });

    it('registration\'s firstEnvelope: held durably, filed into the store (idempotent by pe_id), and included in the backup', async () => {
        const kv = new MemKv();
        const firstEnvelope: PeV2 = {
            schema: PE_V2_SCHEMA, pe_id: 'pe_wallet_created_1', device_id: 'relay:user_1', prev_hash: 'genesis', timestamp: T0, action_type: 'wallet_created',
            content: { wallet_id: 'wallet_1', user_id: 'user_1', actor_address: '0xabc', attestation_type: 'software', metadata: {} },
        };
        // RED: a relay PE whose hash does not recompute, or from a non-relay device, is refused.
        expect(validateRelayAuthoredPe({ ...firstEnvelope, pe_hash: 'f'.repeat(64) })).toBeNull();
        expect(validateRelayAuthoredPe({ ...firstEnvelope, device_id: 'device_x' })).toBeNull();
        expect(await stageRelayAuthoredPe(firstEnvelope, 'wallet_register', kv)).toBe(true);
        expect(await stageRelayAuthoredPe(firstEnvelope, 'wallet_register', kv)).toBe(true); // a replay of register
        expect(JSON.parse(kv.m.get(RELAY_AUTHORED_INBOX_KEY)!)).toHaveLength(1);

        const cloud = new MemoryCloudFiles();
        const { meter: m } = meterFor({ device: 'device_phone1', cloud, relay: new FakeRelay(), kv });
        const meter = await m;
        await meter.start();
        expect(kv.m.has(RELAY_AUTHORED_INBOX_KEY)).toBe(false);
        const received = await meter.store.listReceived();
        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject({ pe_id: 'pe_wallet_created_1', pe_hash: peHashOf(firstEnvelope), from_device: 'relay:user_1' });
        // Handed again (a register replay rebuilds it identically): still one.
        await stageRelayAuthoredPe(firstEnvelope, 'wallet_register', kv);
        await meter.fileRelayAuthored();
        expect(meter.store.receivedCount()).toBe(1);
        await meter.backupNow({ allowPrompt: false });
        // A new phone restores it from the cloud.
        const b = meterFor({ device: 'device_phone_2', cloud, relay: new FakeRelay() });
        const report = await (await b.meter).restoreAfterRecovery();
        expect(report.received).toBe(1);
    });
});

describe('prompt policy — a Face ID / passcode prompt only when it can achieve something', () => {
    async function promptProbe(opts: { unlocked: boolean; online: boolean; keyAsks?: boolean[] }) {
        const asked: boolean[] = [];
        const cloud = new MemoryCloudFiles();
        cloud.online = opts.online;
        const base = await keys();
        const meter = new PhoneMeter({
            files: new MemoryMeterFiles(),
            cloud,
            transport: new FakeRelay(),
            backupKeys: {
                current: async (o) => { asked.push(o.allowPrompt); return base.current(o); },
                forSalt: base.forSalt,
                adopt: base.adopt,
            },
            kv: new MemKv(),
            activity: { hot: async () => [], archived: async () => [], restore: async () => 0 },
            deviceId: async () => 'device_probe',
            detailHash: async () => 'd'.repeat(64),
            messageSecretKey: async () => null,
            openBox: () => null,
            randomBytes: (n) => randomBytes(n),
            isForeground: () => true,
            isUnlocked: () => opts.unlocked,
            ensureMessageKeyPublished: async (o) => { opts.keyAsks?.push(o.allowPrompt); return true; },
            now: () => T0 + 50_000_000,
        });
        await meter.tick('foreground'); // never backed up → long overdue
        await meter.backupNow({ allowPrompt: true }); // the Settings button
        return asked;
    }

    it('unlocked, cloud on: the overdue foreground backup and the button may prompt', async () => {
        expect(await promptProbe({ unlocked: true, online: true })).toContain(true);
    });

    it('RED: on the lock screen (not unlocked) nothing ever prompts', async () => {
        expect(await promptProbe({ unlocked: false, online: true })).not.toContain(true);
    });

    it('RED: with the cloud off nothing prompts (there is nothing to unlock a key for)', async () => {
        expect(await promptProbe({ unlocked: true, online: false })).not.toContain(true);
    });

    it('the Backup button may prompt for the message key (the backup prompt does not open the seed)', async () => {
        const keyAsks: boolean[] = [];
        await promptProbe({ unlocked: true, online: true, keyAsks });
        expect(keyAsks.at(-1)).toBe(true);
    });

    it('the button still publishes the key with the cloud off (agents can reach the person regardless)', async () => {
        const keyAsks: boolean[] = [];
        await promptProbe({ unlocked: true, online: false, keyAsks });
        expect(keyAsks.at(-1)).toBe(true);
    });

    it('RED: on the lock screen the key publish never prompts', async () => {
        const keyAsks: boolean[] = [];
        await promptProbe({ unlocked: false, online: true, keyAsks });
        expect(keyAsks).not.toContain(true);
    });

    async function keeperKeyAsks(unlocked: boolean, foreground: boolean): Promise<boolean[]> {
        const asks: boolean[] = [];
        const meter = new PhoneMeter({
            files: new MemoryMeterFiles(),
            cloud: new MemoryCloudFiles(),
            transport: new FakeRelay(),
            archiveTransport: {} as PhoneArchiveTransport,
            backupKeys: await keys(),
            kv: new MemKv(),
            activity: { hot: async () => [], archived: async () => [], restore: async () => 0 },
            deviceId: async () => 'device_probe',
            detailHash: async () => 'd'.repeat(64),
            messageSecretKey: async (o) => { asks.push(o.allowPrompt); return null; },
            openBox: () => null,
            randomBytes: (n) => randomBytes(n),
            isForeground: () => foreground,
            isUnlocked: () => unlocked,
            now: () => T0 + 50_000_000,
        });
        // A confirmed day waiting to be verified: the keeper needs the key before it fetches anything.
        expect(await meter.archive!.pullDay('wallet_x', '2026-10-01', 'wallet_x')).toEqual({ ok: false, reason: 'owner_key_unavailable' });
        return asks;
    }

    it('the PE Archive keeper may ask for the message key in front and unlocked, like the mailbox ', async () => {
        expect(await keeperKeyAsks(true, true)).toEqual([true]);
    });

    it('RED: the keeper never prompts on the lock screen or in the background', async () => {
        expect(await keeperKeyAsks(false, true)).toEqual([false]);
        expect(await keeperKeyAsks(true, false)).toEqual([false]);
    });
});

describe('PhoneMeter.exportAllPes drains the relay mailbox first', () => {
    async function meterWith(relay: FakeRelay, open: boolean): Promise<PhoneMeter> {
        return new PhoneMeter({
            files: new MemoryMeterFiles(),
            cloud: new MemoryCloudFiles(),
            transport: relay,
            backupKeys: await keys(),
            kv: new MemKv(),
            activity: { hot: async () => [], archived: async () => [], restore: async (envs) => envs.length },
            deviceId: async () => 'device_phone_export',
            detailHash: async () => 'd'.repeat(64),
            // A stand-in sealed box: the "box" is the plaintext, opened only when `open`.
            messageSecretKey: async () => (open ? new Uint8Array(32) : null),
            openBox: (_secret, box) => (open ? box : null),
            randomBytes: (n) => randomBytes(n),
            isForeground: () => true,
            now: () => T0 + 50_000_000,
        });
    }
    function sealedPe(i: number): { item: Record<string, unknown>; pe: PeV2 & { pe_hash: string } } {
        const draft: PeV2 = { schema: PE_V2_SCHEMA, pe_id: `agent_pe_${i}`, device_id: 'device_agent01', prev_hash: 'genesis', timestamp: T0 + i, action_type: 'coding_session' };
        const pe = { ...draft, pe_hash: peHashOf(draft) };
        return { pe, item: { id: `mb_${i}`, pe_id: pe.pe_id, pe_hash: pe.pe_hash, box: JSON.stringify(pe), from_device: pe.device_id, from_actor: 'agent_1', batch_hash: '', created_at_ms: T0 } };
    }

    it('a PE waiting in the mailbox is filed and lands in the file as a received line', async () => {
        const relay = new FakeRelay();
        const { item, pe } = sealedPe(1);
        relay.mailbox = [item];
        const meter = await meterWith(relay, true);
        const result = await meter.exportAllPes({ owner: { walletId: 'w_person', address: null }, appVersion: 't' });
        expect(result.text).toContain(pe.pe_hash);
        expect(result.counts.received).toBe(1);
        expect(result.incomplete.some((i) => i.what.startsWith('mailbox'))).toBe(false);
    });

    it('RED: without the message key the waiting PE is named by count and the verdict is offline_incomplete', async () => {
        const relay = new FakeRelay();
        relay.mailbox = [sealedPe(1).item, sealedPe(2).item];
        const meter = await meterWith(relay, false);
        const result = await meter.exportAllPes({ owner: { walletId: 'w_person', address: null }, appVersion: 't' });
        expect(result.counts.received).toBe(0);
        expect(result.incomplete).toContainEqual({ what: 'mailbox: 2 PE(s) sealed to you still waiting on the relay', reason: expect.stringMatching(/^no_message_key:/) });
        expect(result.complete).toBe(false);
        expect(result.verdict).toBe('offline_incomplete');
    });
});

describe('PhoneMeter.afterUnlock files the mailbox with the key the unlock cached ', () => {
    it('locked at the daily check → nothing filed; the unlock then files every waiting copy without a prompt of its own', async () => {
        const relay = new FakeRelay();
        const draft: PeV2 = { schema: PE_V2_SCHEMA, pe_id: 'agent_pe_unlock', device_id: 'device_agent01', prev_hash: 'genesis', timestamp: T0 + 1, action_type: 'coding_session' };
        const pe = { ...draft, pe_hash: peHashOf(draft) };
        relay.mailbox = [{ id: 'mb_unlock', pe_id: pe.pe_id, pe_hash: pe.pe_hash, box: JSON.stringify(pe), from_device: pe.device_id, from_actor: 'agent_1', batch_hash: '', created_at_ms: T0 }];
        let keyCached = false;
        const meter = new PhoneMeter({
            files: new MemoryMeterFiles(),
            cloud: new MemoryCloudFiles(),
            transport: relay,
            backupKeys: await keys(),
            kv: new MemKv(),
            activity: { hot: async () => [], archived: async () => [], restore: async (envs) => envs.length },
            deviceId: async () => 'device_phone_unlock',
            detailHash: async () => 'd'.repeat(64),
            // The runtime's supplier: the cached key, or nothing — it never prompts on its own.
            messageSecretKey: async () => (keyCached ? new Uint8Array(32) : null),
            openBox: (_secret, box) => box,
            randomBytes: (n) => randomBytes(n),
            isForeground: () => true,
            isUnlocked: () => keyCached,
            now: () => T0 + 50_000_000,
        });
        await meter.tick('foreground'); // the app came forward on the lock screen
        expect((await meter.status()).receivedPes).toBe(0);
        keyCached = true; // WalletLock's Face ID derived and cached the key
        await meter.afterUnlock();
        expect((await meter.status()).receivedPes).toBe(1);
        expect(relay.acked.flat()).toEqual(['mb_unlock']);
    });
});
