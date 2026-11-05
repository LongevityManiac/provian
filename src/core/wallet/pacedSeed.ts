/**
 * BIP-39 mnemonic → seed (PBKDF2-HMAC-SHA512, 2048 rounds, salt "mnemonic" + passphrase, NFKD),
 * byte-identical to @scure/bip39 `mnemonicToSeedSync`, but giving the JS thread back between
 * rounds (findings, 2026-10-23). On the phone the synchronous version held the screens for
 * about a second right at unlock, where the wallet confirms its seed derives to its address.
 */
import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha512';
import { utf8ToBytes } from '@noble/hashes/utils';
import { cpuBudget, type CpuBudget } from '../meter/cpuBudget';

const ROUNDS = 2048;
/**
 * Unlock waits for this derivation, so it runs in longer slices than the meter's background work:
 * about 1.7 s on the phone instead of 1.2 s unbroken, with a frame for the screens every 40 ms.
 */
export const SEED_SLICE_MS = 40;

export async function mnemonicToSeedPaced(mnemonic: string, passphrase = '', budget: CpuBudget = cpuBudget({ sliceMs: SEED_SLICE_MS })): Promise<Uint8Array> {
    const password = utf8ToBytes(mnemonic.normalize('NFKD'));
    const salt = utf8ToBytes(`mnemonic${passphrase}`.normalize('NFKD'));
    // dkLen 64 = one SHA-512 block: T1 = U1 ^ U2 ^ … ^ U2048, U1 = PRF(P, S ‖ INT(1)), Ui = PRF(P, Ui-1).
    const prf = hmac.create(sha512, password);
    const first = new Uint8Array(salt.length + 4);
    first.set(salt);
    first[salt.length + 3] = 1;
    let u = prf.clone().update(first).digest();
    const out = u.slice();
    for (let i = 1; i < ROUNDS; i++) {
        const next = prf.clone().update(u).digest();
        u.fill(0);
        u = next;
        for (let j = 0; j < out.length; j++) out[j] ^= u[j];
        await budget.pace();
    }
    password.fill(0);
    u.fill(0);
    prf.destroy();
    return out;
}
