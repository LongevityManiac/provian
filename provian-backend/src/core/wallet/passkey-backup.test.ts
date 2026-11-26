/**
 * Passkey backup: Provian keeps only ciphertext and the passkey's public key, and hands a backup
 * out only for a user-verified assertion of that passkey over a fresh single-use challenge, made
 * on the web app's origin. Real P-256 signatures, built the way a browser builds them.
 */
import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import {
    CHALLENGE_SWEEP_LIMIT,
    PASSKEY_BACKUP_CHALLENGES_COLLECTION,
    PASSKEY_BACKUPS_COLLECTION,
    PasskeyBackupError,
    deletePasskeyBackups,
    fetchPasskeyBackup,
    issuePasskeyChallenge,
    listPasskeyBackups,
    storePasskeyBackup,
    validateEnvelope,
    verifyAssertionSignature,
} from './passkey-backup';

type Data = Record<string, unknown>;

function memoryDb() {
    const store = new Map<string, Map<string, Data>>();
    const col = (name: string) => {
        if (!store.has(name)) store.set(name, new Map());
        return store.get(name)!;
    };
    const docRef = (name: string, id: string) => ({
        id,
        async get() {
            const data = col(name).get(id);
            return { id, exists: data !== undefined, data: () => (data ? JSON.parse(JSON.stringify(data)) : undefined), ref: docRef(name, id) };
        },
        async set(data: Data) { col(name).set(id, JSON.parse(JSON.stringify(data))); },
        async delete() { col(name).delete(id); },
    });
    const matches = (actual: unknown, op: string, value: unknown) =>
        op === '<' ? (actual as number) < (value as number) : actual === value;
    const query = (name: string, field: string, op: string, value: unknown, max = Infinity) => ({
        limit: (n: number) => query(name, field, op, value, n),
        async get() {
            const docs = [...col(name).entries()].filter(([, d]) => matches(d[field], op, value)).slice(0, max)
                .map(([id, d]) => ({ id, data: () => ({ ...d }), ref: docRef(name, id) }));
            return { size: docs.length, docs };
        },
    });
    const db = {
        collection: (name: string) => ({
            doc: (id: string) => docRef(name, id),
            where: (field: string, op: string, value: unknown) => query(name, field, op, value),
        }),
        async runTransaction<T>(fn: (tx: { get: (ref: ReturnType<typeof docRef>) => Promise<unknown>; delete: (ref: ReturnType<typeof docRef>) => void }) => Promise<T>) {
            const deletes: ReturnType<typeof docRef>[] = [];
            const result = await fn({ get: ref => ref.get(), delete: ref => { deletes.push(ref); } });
            for (const ref of deletes) await ref.delete();
            return result;
        },
    } as unknown as Firestore;
    return { db, col };
}

const ADDRESS = '0x' + '12'.repeat(20);
const ORIGIN = 'https://app.provian.ai';
const RP_ID = 'app.provian.ai';

function b64url(buf: Buffer): string {
    return buf.toString('base64url');
}

function passkey() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const spki = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64');
    const credentialId = b64url(crypto.randomBytes(32));
    return { privateKey, spki, credentialId };
}

function assertion(key: ReturnType<typeof passkey>, challenge: string, opts: { origin?: string; rpId?: string; flags?: number; type?: string } = {}) {
    const clientData = Buffer.from(JSON.stringify({ type: opts.type ?? 'webauthn.get', challenge, origin: opts.origin ?? ORIGIN, crossOrigin: false }));
    const authData = Buffer.concat([
        crypto.createHash('sha256').update(opts.rpId ?? RP_ID).digest(),
        Buffer.from([opts.flags ?? 0x05]),
        Buffer.from([0, 0, 0, 7]),
    ]);
    const signature = crypto.sign('sha256', Buffer.concat([authData, crypto.createHash('sha256').update(clientData).digest()]), key.privateKey);
    return { credential_id: key.credentialId, authenticator_data: b64url(authData), client_data_json: b64url(clientData), signature: b64url(signature) };
}

const envelope = () => ({
    v: 1, kdf: 'pbkdf2-sha256+hkdf-sha256', iterations: 600000,
    pin_salt: crypto.randomBytes(32).toString('base64'), iv: crypto.randomBytes(12).toString('base64'),
    ct: crypto.randomBytes(80).toString('base64'),
});

async function stored(mem: ReturnType<typeof memoryDb>) {
    const key = passkey();
    await storePasskeyBackup(mem.db, { userId: 'user_1', accountWalletAddress: ADDRESS, body: {
        credential_id: key.credentialId, public_key_spki: key.spki, public_key_alg: -7, rp_id: RP_ID,
        wallet_address: ADDRESS, envelope: envelope(),
    } });
    return key;
}

const ENV = process.env.NODE_ENV;
beforeAll(() => { process.env.NODE_ENV = 'production'; });
afterAll(() => { process.env.NODE_ENV = ENV; });

describe('passkey backup', () => {
    it('stores ciphertext and the public key only, then hands it to its passkey', async () => {
        const mem = memoryDb();
        const key = await stored(mem);
        const [record] = [...mem.col(PASSKEY_BACKUPS_COLLECTION).values()];
        expect(Object.keys(record).sort()).toEqual(['created_at', 'credential_id', 'envelope', 'public_key_alg', 'public_key_spki', 'rp_id', 'updated_at', 'user_id', 'wallet_address']);
        const { challenge } = await issuePasskeyChallenge(mem.db);
        const result = await fetchPasskeyBackup(mem.db, assertion(key, challenge));
        expect(result.wallet_address).toBe(ADDRESS);
        expect(result.envelope.v).toBe(1);
        // The passkey's public key comes back, so the restoring browser can refresh the backup.
        expect(result.public_key_spki).toBe(key.spki);
        expect(result.public_key_alg).toBe(-7);
        expect(await listPasskeyBackups(mem.db, 'user_1')).toHaveLength(1);
    });

    it('RED: a challenge works once', async () => {
        const mem = memoryDb();
        const key = await stored(mem);
        const { challenge } = await issuePasskeyChallenge(mem.db);
        await fetchPasskeyBackup(mem.db, assertion(key, challenge));
        await expect(fetchPasskeyBackup(mem.db, assertion(key, challenge))).rejects.toMatchObject({ code: 'challenge_unknown_or_expired' });
    });

    it('RED: an expired or invented challenge is refused', async () => {
        const mem = memoryDb();
        const key = await stored(mem);
        const { challenge } = await issuePasskeyChallenge(mem.db, Date.now() - 10 * 60 * 1000);
        await expect(fetchPasskeyBackup(mem.db, assertion(key, challenge))).rejects.toMatchObject({ code: 'challenge_unknown_or_expired' });
        await expect(fetchPasskeyBackup(mem.db, assertion(key, b64url(crypto.randomBytes(32))))).rejects.toMatchObject({ code: 'challenge_unknown_or_expired' });
    });

    it('RED: another key, another origin, another RP, no user verification, wrong type are each refused', async () => {
        const mem = memoryDb();
        const key = await stored(mem);
        const other = { ...passkey(), credentialId: key.credentialId };
        const cases: [ReturnType<typeof assertion>, string][] = [];
        for (const [build, code] of [
            [(c: string) => assertion(other, c), 'assertion_signature_invalid'],
            [(c: string) => assertion(key, c, { origin: 'https://evil.example' }), 'assertion_origin_not_allowed'],
            [(c: string) => assertion(key, c, { rpId: 'evil.example' }), 'assertion_rp_mismatch'],
            [(c: string) => assertion(key, c, { flags: 0x01 }), 'assertion_user_not_verified'],
            [(c: string) => assertion(key, c, { type: 'webauthn.create' }), 'assertion_type_invalid'],
        ] as const) {
            const { challenge } = await issuePasskeyChallenge(mem.db);
            cases.push([build(challenge), code]);
        }
        for (const [input, code] of cases) {
            await expect(fetchPasskeyBackup(mem.db, input)).rejects.toMatchObject({ code });
        }
    });

    it('RED: a tampered client data or authenticator data breaks the signature', () => {
        const key = passkey();
        const good = assertion(key, 'abc');
        const authData = Buffer.from(good.authenticator_data, 'base64url');
        authData[36] ^= 1;
        expect(() => verifyAssertionSignature({ public_key_spki: key.spki, public_key_alg: -7, rp_id: RP_ID },
            { ...good, authenticator_data: b64url(authData) }, { challenge: 'abc', origins: [ORIGIN] })).toThrow('assertion_signature_invalid');
        expect(() => verifyAssertionSignature({ public_key_spki: key.spki, public_key_alg: -7, rp_id: RP_ID },
            good, { challenge: 'abc', origins: [ORIGIN] })).not.toThrow();
    });

    it('RED: a backup can name only the account\'s own wallet, and a credential stays with its account', async () => {
        const mem = memoryDb();
        const key = passkey();
        const body = { credential_id: key.credentialId, public_key_spki: key.spki, public_key_alg: -7, rp_id: RP_ID, wallet_address: ADDRESS, envelope: envelope() };
        await expect(storePasskeyBackup(mem.db, { userId: 'user_1', accountWalletAddress: '0x' + '99'.repeat(20), body }))
            .rejects.toMatchObject({ status: 403, code: 'wallet_address_not_this_account' });
        await storePasskeyBackup(mem.db, { userId: 'user_1', accountWalletAddress: ADDRESS, body });
        await expect(storePasskeyBackup(mem.db, { userId: 'user_2', accountWalletAddress: ADDRESS, body }))
            .rejects.toMatchObject({ status: 409, code: 'credential_belongs_to_another_account' });
    });

    it('RED: a localhost RP is refused in production', async () => {
        const mem = memoryDb();
        const key = passkey();
        await expect(storePasskeyBackup(mem.db, { userId: 'user_1', accountWalletAddress: ADDRESS, body: {
            credential_id: key.credentialId, public_key_spki: key.spki, public_key_alg: -7, rp_id: 'localhost', wallet_address: ADDRESS, envelope: envelope(),
        } })).rejects.toMatchObject({ code: 'rp_id_not_allowed' });
    });

    it('RED: malformed envelopes and keys are refused', () => {
        expect(() => validateEnvelope({ ...envelope(), iterations: 10 })).toThrow(PasskeyBackupError);
        expect(() => validateEnvelope({ ...envelope(), v: 2 })).toThrow(PasskeyBackupError);
        expect(() => validateEnvelope({ ...envelope(), ct: 'not base64 !' })).toThrow(PasskeyBackupError);
        expect(() => validateEnvelope(envelope())).not.toThrow();
    });

    it('Delete erases every backup of the account', async () => {
        const mem = memoryDb();
        await stored(mem);
        await stored(mem);
        expect(await deletePasskeyBackups(mem.db, 'user_1')).toBe(2);
        expect(mem.col(PASSKEY_BACKUPS_COLLECTION).size).toBe(0);
        const { challenge } = await issuePasskeyChallenge(mem.db);
        await expect(fetchPasskeyBackup(mem.db, assertion(passkey(), challenge))).rejects.toMatchObject({ status: 404 });
    });

    it('issuing a challenge clears expired unused ones and keeps live ones (RED: an expired one left behind fails)', async () => {
        const mem = memoryDb();
        const now = Date.now();
        const live = await issuePasskeyChallenge(mem.db, now - 60 * 1000);
        for (let i = 0; i < 3; i++) mem.col(PASSKEY_BACKUP_CHALLENGES_COLLECTION).set(`expired_${i}`, { expires_at: now - 1000 * (i + 1), created_at: now - 10 * 60 * 1000 });
        expect(mem.col(PASSKEY_BACKUP_CHALLENGES_COLLECTION).size).toBe(4);
        await issuePasskeyChallenge(mem.db, now);
        const remaining = [...mem.col(PASSKEY_BACKUP_CHALLENGES_COLLECTION).values()];
        expect(remaining).toHaveLength(2);
        expect(remaining.every(doc => Number(doc.expires_at) >= now)).toBe(true);
        // The live challenge still works after the sweep.
        const key = await stored(mem);
        await expect(fetchPasskeyBackup(mem.db, assertion(key, live.challenge), now)).resolves.toMatchObject({ wallet_address: ADDRESS });
        expect(CHALLENGE_SWEEP_LIMIT).toBeGreaterThan(1);
    });
});
