/**
 * The QR handoff mailbox: each side acts only with its own token, the receiver alone picks up the
 * sealed seed, one join / one seal / one pickup, nothing stays after pickup, cancel or expiry, and
 * nothing but labels, a public key, a MAC and ciphertext is ever stored.
 */
import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import {
    HANDOFF_TTL_MS,
    WALLET_HANDOFFS_COLLECTION,
    cancelHandoff,
    handoffState,
    joinHandoff,
    openHandoff,
    sealHandoff,
    takeHandoff,
} from './wallet-qr-move';

type Data = Record<string, unknown>;

function memoryDb() {
    const store = new Map<string, Data>();
    const docRef = (id: string) => ({
        id,
        async get() {
            const data = store.get(id);
            return { id, exists: data !== undefined, data: () => (data ? JSON.parse(JSON.stringify(data)) : undefined), ref: docRef(id) };
        },
        async set(data: Data) { store.set(id, JSON.parse(JSON.stringify(data))); },
        async update(data: Data) { store.set(id, { ...store.get(id), ...JSON.parse(JSON.stringify(data)) }); },
        async delete() { store.delete(id); },
    });
    const db = {
        collection: (name: string) => {
            expect(name).toBe(WALLET_HANDOFFS_COLLECTION);
            return {
                doc: (id: string) => docRef(id),
                where: (field: string, op: string, value: number) => ({
                    limit: (n: number) => ({
                        async get() {
                            const docs = [...store.entries()].filter(([, d]) => op === '<' && (d[field] as number) < value).slice(0, n)
                                .map(([id]) => ({ id, ref: docRef(id) }));
                            return { docs, size: docs.length };
                        },
                    }),
                }),
            };
        },
        async runTransaction<T>(fn: (tx: unknown) => Promise<T>) {
            const writes: Array<() => Promise<void>> = [];
            const tx = {
                get: (ref: ReturnType<typeof docRef>) => ref.get(),
                update: (ref: ReturnType<typeof docRef>, data: Data) => { writes.push(() => ref.update(data)); },
                delete: (ref: ReturnType<typeof docRef>) => { writes.push(() => ref.delete()); },
            };
            const result = await fn(tx);
            for (const write of writes) await write();
            return result;
        },
    } as unknown as Firestore;
    return { db, store };
}

const b64 = (n: number) => crypto.randomBytes(n).toString('base64url');
const WEB = { label: 'Chrome on macOS', platform: 'web' };
const PHONE = { label: 'iPhone 15 Pro', platform: 'ios' };
const KEY = () => ({ receiver_key: b64(32), receiver_key_mac: b64(32) });
const ENVELOPE = () => ({ v: 1, epk: b64(32), iv: b64(12), ct: b64(120) });

describe('QR handoff mailbox', () => {
    it('browser first: the web app sends, the phone receives, and nothing stays after pickup', async () => {
        const { db, store } = memoryDb();
        const web = await openHandoff(db, { mode: 'send', device: WEB });
        const key = KEY();
        const phone = await joinHandoff(db, { id: web.id, device: PHONE, ...key });
        expect(phone.peer_device).toEqual(WEB);
        expect(phone.receiver_key).toBeNull();
        const seen = await handoffState(db, { id: web.id, token: web.token });
        expect(seen).toMatchObject({ joined: true, sealed: false, peer_device: PHONE, ...key });
        expect(await takeHandoff(db, { id: web.id, token: phone.token })).toEqual({ envelope: null });
        const envelope = ENVELOPE();
        await sealHandoff(db, { id: web.id, token: web.token, envelope });
        expect(await takeHandoff(db, { id: web.id, token: phone.token })).toEqual({ envelope });
        expect(store.size).toBe(0);
        await expect(takeHandoff(db, { id: web.id, token: phone.token })).rejects.toMatchObject({ status: 404 });
    });

    it('phone first: the web app receives, the phone sends', async () => {
        const { db, store } = memoryDb();
        const key = KEY();
        const web = await openHandoff(db, { mode: 'receive', device: WEB, ...key });
        const phone = await joinHandoff(db, { id: web.id, device: PHONE });
        // The phone gets the web app's key and MAC, to check against the code before it seals.
        expect(phone).toMatchObject({ mode: 'receive', peer_device: WEB, ...key });
        await sealHandoff(db, { id: web.id, token: phone.token, envelope: ENVELOPE() });
        expect((await takeHandoff(db, { id: web.id, token: web.token })).envelope).not.toBeNull();
        expect(store.size).toBe(0);
    });

    it('only labels, the receiver key, its MAC, token hashes and ciphertext are stored', async () => {
        const { db, store } = memoryDb();
        const web = await openHandoff(db, { mode: 'send', device: WEB });
        const phone = await joinHandoff(db, { id: web.id, device: PHONE, ...KEY() });
        await sealHandoff(db, { id: web.id, token: web.token, envelope: ENVELOPE() });
        const [record] = [...store.values()];
        expect(Object.keys(record).sort()).toEqual(['created_at', 'creator_device', 'creator_token_sha256', 'envelope', 'expires_at', 'joiner_device', 'joiner_token_sha256', 'mode', 'receiver_key', 'receiver_key_mac']);
        expect(JSON.stringify(record)).not.toContain(web.token);
        expect(JSON.stringify(record)).not.toContain(phone.token);
        expect(JSON.stringify(record)).not.toContain(web.id);
    });

    it('RED: a stranger, a second phone, the wrong side or a second seal is refused', async () => {
        const { db } = memoryDb();
        const web = await openHandoff(db, { mode: 'send', device: WEB });
        await expect(sealHandoff(db, { id: web.id, token: web.token, envelope: ENVELOPE() })).rejects.toMatchObject({ status: 409, code: 'handoff_not_joined' });
        const phone = await joinHandoff(db, { id: web.id, device: PHONE, ...KEY() });
        await expect(joinHandoff(db, { id: web.id, device: PHONE, ...KEY() })).rejects.toMatchObject({ status: 409, code: 'handoff_already_joined' });
        await expect(handoffState(db, { id: web.id, token: b64(32) })).rejects.toMatchObject({ status: 401 });
        // The receiving phone cannot seal; the sending web app cannot pick up.
        await expect(sealHandoff(db, { id: web.id, token: phone.token, envelope: ENVELOPE() })).rejects.toMatchObject({ status: 403 });
        await expect(takeHandoff(db, { id: web.id, token: web.token })).rejects.toMatchObject({ status: 403 });
        await sealHandoff(db, { id: web.id, token: web.token, envelope: ENVELOPE() });
        await expect(sealHandoff(db, { id: web.id, token: web.token, envelope: ENVELOPE() })).rejects.toMatchObject({ status: 409, code: 'handoff_already_sealed' });
    });

    it('RED: the receiver key must come from the receiving side, and malformed input is refused', async () => {
        const { db } = memoryDb();
        await expect(openHandoff(db, { mode: 'send', device: WEB, ...KEY() })).rejects.toMatchObject({ code: 'receiver_key_unexpected' });
        await expect(openHandoff(db, { mode: 'receive', device: WEB })).rejects.toMatchObject({ code: 'receiver_key_invalid' });
        const web = await openHandoff(db, { mode: 'receive', device: WEB, ...KEY() });
        // A phone that scanned from the other screen is told so, and the session is not used up.
        await expect(joinHandoff(db, { id: web.id, device: PHONE, ...KEY() })).rejects.toMatchObject({ status: 409, code: 'handoff_wrong_direction' });
        await joinHandoff(db, { id: web.id, device: PHONE });
        const sendFirst = await openHandoff(db, { mode: 'send', device: WEB });
        await expect(joinHandoff(db, { id: sendFirst.id, device: PHONE })).rejects.toMatchObject({ status: 409, code: 'handoff_wrong_direction' });
        await expect(joinHandoff(db, { id: sendFirst.id, device: PHONE, receiver_key: 'short', receiver_key_mac: 'short' })).rejects.toMatchObject({ code: 'receiver_key_invalid' });
        await joinHandoff(db, { id: sendFirst.id, device: PHONE, ...KEY() });
        for (const device of [null, { label: '', platform: 'ios' }, { label: 'x'.repeat(65), platform: 'ios' }, { label: 'a\u0007b', platform: 'ios' }, { label: 'ok', platform: 'windows' }]) {
            await expect(openHandoff(db, { mode: 'send', device })).rejects.toMatchObject({ code: 'device_invalid' });
        }
        await expect(openHandoff(db, { mode: 'other', device: WEB })).rejects.toMatchObject({ code: 'mode_invalid' });
        const send = await openHandoff(db, { mode: 'send', device: WEB });
        await joinHandoff(db, { id: send.id, device: PHONE, ...KEY() });
        for (const envelope of [null, { ...ENVELOPE(), v: 2 }, { ...ENVELOPE(), iv: b64(16) }, { ...ENVELOPE(), ct: b64(4000) }]) {
            await expect(sealHandoff(db, { id: send.id, token: send.token, envelope })).rejects.toMatchObject({ code: 'envelope_invalid' });
        }
    });

    it('cancel and expiry delete the session; opening a session sweeps expired ones', async () => {
        const { db, store } = memoryDb();
        const a = await openHandoff(db, { mode: 'send', device: WEB });
        await cancelHandoff(db, { id: a.id, token: a.token });
        expect(store.size).toBe(0);
        const now = Date.now();
        const old = await openHandoff(db, { mode: 'send', device: WEB }, now - HANDOFF_TTL_MS - 1000);
        await expect(handoffState(db, { id: old.id, token: old.token }, now)).rejects.toMatchObject({ status: 410 });
        expect(store.size).toBe(0);
        await openHandoff(db, { mode: 'send', device: WEB }, now - HANDOFF_TTL_MS - 1000);
        expect(store.size).toBe(1);
        await openHandoff(db, { mode: 'send', device: WEB }, now);
        // RED: without the sweep the expired session would still be here.
        expect(store.size).toBe(1);
    });
});
