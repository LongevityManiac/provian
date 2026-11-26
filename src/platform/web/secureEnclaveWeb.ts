/**
 * The device identity key on the web: a P-256 key that identifies THIS BROWSER in the PE chain.
 *
 * On a phone the key is generated inside the Secure Enclave / StrongBox and never leaves it. A
 * browser has no such hardware the page can sign raw digests with (WebCrypto ECDSA always hashes
 * its input), so the key is generated in software, held only encrypted under this browser's own
 * non-extractable key, and reported as software-backed. The relay prices a web device at the
 * software tier.
 */
import { p256 } from '@noble/curves/p256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import * as SecureStore from './secureStoreWeb';

const itemFor = (keyId: string): string => `provian_web_p256_${keyId}`;

function strip0x(value: string): string {
    return value.startsWith('0x') ? value.slice(2) : value;
}

async function privateKey(keyId: string): Promise<Uint8Array | null> {
    const stored = await SecureStore.getItemAsync(itemFor(keyId));
    return stored ? hexToBytes(stored) : null;
}

export const secureEnclaveWeb = {
    async generateKey(keyId: string): Promise<{ publicKeyX: string; publicKeyY: string }> {
        if (await privateKey(keyId)) throw new Error('KEY_EXISTS');
        const secret = p256.utils.randomPrivateKey();
        await SecureStore.setItemAsync(itemFor(keyId), bytesToHex(secret));
        const point = p256.getPublicKey(secret, false);
        return { publicKeyX: bytesToHex(point.slice(1, 33)), publicKeyY: bytesToHex(point.slice(33, 65)) };
    },
    async signDigest(keyId: string, digest: string): Promise<{ r: string; s: string }> {
        const secret = await privateKey(keyId);
        if (!secret) throw new Error('KEY_NOT_FOUND');
        const sig = p256.sign(hexToBytes(strip0x(digest)), secret, { lowS: true, prehash: false });
        return { r: sig.r.toString(16).padStart(64, '0'), s: sig.s.toString(16).padStart(64, '0') };
    },
    async signDigestDer(keyId: string, digest: string): Promise<string> {
        const secret = await privateKey(keyId);
        if (!secret) throw new Error('KEY_NOT_FOUND');
        return p256.sign(hexToBytes(strip0x(digest)), secret, { lowS: true, prehash: false }).toDERHex();
    },
    async hasKey(keyId: string): Promise<boolean> {
        return (await privateKey(keyId)) !== null;
    },
    async deleteKey(keyId: string): Promise<void> {
        await SecureStore.deleteItemAsync(itemFor(keyId));
    },
    async isHardwareBacked(): Promise<boolean> {
        return false;
    },
    async getKeyBacking(): Promise<'software'> {
        return 'software';
    },
    async isCloudBackupAvailable(): Promise<boolean> {
        return false;
    },
};
