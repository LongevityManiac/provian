/**
 * The browser vault and the passkey backup: the seed opens only with the passkey's PRF secret AND
 * the PIN, a backup made in one browser opens in another with the same passkey and PIN, and every
 * wrong ingredient is refused. Runs against Node's WebCrypto with a fake passkey.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PasskeyBackupEnvelope } from '../passkeyBackup';

class MemoryStorage {
    private map = new Map<string, string>();
    get length(): number { return this.map.size; }
    key(i: number): string | null { return [...this.map.keys()][i] ?? null; }
    getItem(k: string): string | null { return this.map.has(k) ? this.map.get(k)! : null; }
    setItem(k: string, v: string): void { this.map.set(k, String(v)); }
    removeItem(k: string): void { this.map.delete(k); }
    clear(): void { this.map.clear(); }
}

const passkeyState = vi.hoisted(() => ({
    prf: new Uint8Array(32).fill(7) as Uint8Array | null,
    credentialId: new Uint8Array(16).fill(3),
    calls: [] as string[],
}));

vi.mock('../passkey', () => ({
    PRF_SALT: new Uint8Array(32),
    PasskeyUnavailableError: class extends Error {},
    PasskeyCancelledError: class extends Error {},
    webAuthnAvailable: () => true,
    rpId: () => 'app.provian.ai',
    createPasskey: async () => {
        passkeyState.calls.push('create');
        return { credentialId: passkeyState.credentialId, prf: passkeyState.prf, publicKeySpki: new Uint8Array([1, 2, 3]), publicKeyAlgorithm: -7 };
    },
    getPasskey: async () => {
        passkeyState.calls.push('get');
        return { credentialId: passkeyState.credentialId, prf: passkeyState.prf, authenticatorData: new Uint8Array(37), clientDataJSON: new Uint8Array(2), signature: new Uint8Array(70) };
    },
}));

vi.mock('../webKv', async (importOriginal) => {
    const real = await importOriginal<typeof import('../webKv')>();
    let deviceKey: CryptoKey | null = null;
    return {
        ...real,
        deviceAesKey: async () => (deviceKey ??= await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])),
    };
});

const vault = await import('../webVault');
const backup = await import('../passkeyBackup');

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ADDRESS = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';

beforeEach(() => {
    vi.stubGlobal('window', { localStorage: new MemoryStorage() });
    passkeyState.prf = new Uint8Array(32).fill(7);
    passkeyState.calls = [];
    vault.lockVault();
});

describe('browser vault', () => {
    it('stores the seed sealed and opens it again with the passkey and PIN', async () => {
        await vault.createVault('246813', 'Provian wallet');
        await vault.writeSeedItem('slot', MNEMONIC);
        const raw = window.localStorage.getItem('provian_seed:slot')!;
        expect(raw).not.toContain('abandon');
        vault.lockVault();
        await expect(vault.readSeedItem('slot')).rejects.toBeInstanceOf(vault.VaultClosedError);
        await vault.unlockVault('246813');
        expect(await vault.readSeedItem('slot')).toBe(MNEMONIC);
    });

    it('RED: a wrong PIN does not open it, and five in a row make the person wait', async () => {
        await vault.createVault('246813', 'Provian wallet');
        vault.lockVault();
        for (let i = 0; i < 4; i++) await expect(vault.unlockVault('000000')).rejects.toBeInstanceOf(vault.WrongPinError);
        await expect(vault.unlockVault('000000')).rejects.toBeInstanceOf(vault.VaultLockedOutError);
        await expect(vault.unlockVault('246813')).rejects.toBeInstanceOf(vault.VaultLockedOutError);
        expect(vault.isVaultOpen()).toBe(false);
    });

    it('RED: the right PIN with another passkey secret does not open it', async () => {
        await vault.createVault('246813', 'Provian wallet');
        vault.lockVault();
        passkeyState.prf = new Uint8Array(32).fill(8);
        await expect(vault.unlockVault('246813')).rejects.toBeInstanceOf(vault.WrongPinError);
    });

    it('RED: a passkey without PRF is refused and no vault is written', async () => {
        passkeyState.prf = null;
        await expect(vault.createVault('246813', 'Provian wallet')).rejects.toBeInstanceOf(vault.PasskeyNoPrfError);
        expect(vault.hasVault()).toBe(false);
        expect(vault.isVaultOpen()).toBe(false);
        expect(backup.canMakePasskeyBackup()).toBe(false);
    });

    it('RED: a vault cannot be opened by a passkey answer that carries no PRF secret', async () => {
        await vault.createVault('246813', 'Provian wallet');
        vault.lockVault();
        passkeyState.prf = null;
        await expect(vault.unlockVault('246813')).rejects.toBeInstanceOf(vault.PasskeyNoPrfError);
        expect(vault.isVaultOpen()).toBe(false);
    });

    it('wipe removes the vault and every seed item', async () => {
        await vault.createVault('246813', 'Provian wallet');
        await vault.writeSeedItem('slot', MNEMONIC);
        vault.wipeVault();
        expect(vault.hasVault()).toBe(false);
        expect(vault.hasSeedItem('slot')).toBe(false);
        expect(vault.isVaultOpen()).toBe(false);
    });
});

describe('passkey backup', () => {
    it('a backup made in one browser opens in another with the same passkey and PIN', async () => {
        await vault.createVault('246813', 'Provian wallet');
        let stored: Record<string, unknown> | null = null;
        await backup.makePasskeyBackup({ storePasskeyBackup: async (body) => { stored = body; } }, MNEMONIC, ADDRESS);
        expect(stored).not.toBeNull();
        const body = stored as unknown as { envelope: PasskeyBackupEnvelope; wallet_address: string; rp_id: string };
        expect(JSON.stringify(body)).not.toContain('abandon');
        expect(body.wallet_address).toBe(ADDRESS.toLowerCase());
        expect(body.rp_id).toBe('app.provian.ai');
        // The envelope shape the relay validates.
        expect(body.envelope.iv).toHaveLength(16);
        expect(body.envelope.pin_salt.length).toBeGreaterThanOrEqual(24);

        // A different browser: nothing local, the same passkey.
        vi.stubGlobal('window', { localStorage: new MemoryStorage() });
        vault.lockVault();
        passkeyState.calls = [];
        const relay = {
            passkeyBackupChallenge: async () => 'challenge',
            fetchPasskeyBackup: async () => ({ wallet_address: body.wallet_address, envelope: body.envelope as unknown as Record<string, unknown> }),
        };
        const assertion = { credentialId: passkeyState.credentialId, prf: passkeyState.prf, authenticatorData: new Uint8Array(37), clientDataJSON: new Uint8Array(2), signature: new Uint8Array(70) };
        const opened = await backup.fetchAndOpenPasskeyBackup(relay, assertion, '246813');
        expect(opened).toEqual({ mnemonic: MNEMONIC, walletAddress: ADDRESS.toLowerCase(), publicKey: null });
        // Without the passkey's public key this browser could not refresh the backup; with it, it can.
        await vault.createVaultFromPasskey('246813', assertion);
        expect(backup.canMakePasskeyBackup()).toBe(false);
        vault.wipeVault();
        await vault.createVaultFromPasskey('246813', assertion, { spki: 'AQID', algorithm: -7 });
        expect(backup.canMakePasskeyBackup()).toBe(true);
        expect(vault.isVaultOpen()).toBe(true);
        vault.lockVault();
        await vault.unlockVault('246813');
        expect(passkeyState.calls).not.toContain('create');
    });

    it('RED: the wrong PIN or another passkey cannot open a backup', async () => {
        const envelope = await backup.sealPasskeyBackup(new Uint8Array(32).fill(7), '246813', MNEMONIC, ADDRESS);
        await expect(backup.openPasskeyBackup(new Uint8Array(32).fill(7), '246814', envelope)).rejects.toBeInstanceOf(backup.PasskeyBackupWrongPinError);
        await expect(backup.openPasskeyBackup(new Uint8Array(32).fill(9), '246813', envelope)).rejects.toBeInstanceOf(backup.PasskeyBackupWrongPinError);
        await expect(backup.openPasskeyBackup(new Uint8Array(32).fill(7), '246813', envelope)).resolves.toMatchObject({ mnemonic: MNEMONIC });
    });

    it('RED: a backup the relay names for another wallet is refused', async () => {
        const envelope = await backup.sealPasskeyBackup(new Uint8Array(32).fill(7), '246813', MNEMONIC, ADDRESS);
        const relay = {
            passkeyBackupChallenge: async () => 'c',
            fetchPasskeyBackup: async () => ({ wallet_address: '0x' + '1'.repeat(40), envelope: envelope as unknown as Record<string, unknown> }),
        };
        const assertion = { credentialId: new Uint8Array(16), prf: new Uint8Array(32).fill(7), authenticatorData: new Uint8Array(37), clientDataJSON: new Uint8Array(2), signature: new Uint8Array(70) };
        await expect(backup.fetchAndOpenPasskeyBackup(relay, assertion, '246813')).rejects.toThrow('passkey_backup_wallet_mismatch');
    });
});

describe('the PIN for showing the recovery phrase', () => {
    it('is bound to the reveal action, so another action queued first cannot use it up (RED)', async () => {
        const unlock = await import('../unlockRequests');
        unlock.requirePinForAction('Show recovery phrase');
        expect(unlock.takePinForAction('Sign a transaction')).toBe(false);
        expect(unlock.takePinForAction('Show recovery phrase')).toBe(true);
        expect(unlock.takePinForAction('Show recovery phrase')).toBe(false);
    });
});
