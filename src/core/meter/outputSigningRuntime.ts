/**
 * The phone's output signer, bound to the real device key and relay (see `outputSigning.ts`).
 * The key is the PE attestation key (KeyManager, Secure Enclave / StrongBox), never the wallet key;
 * signing with it never prompts (the same key signs every PE). The "registered" marker is
 * non-sensitive (a key id + the wallet user id), so it lives in AsyncStorage.
 *
 * `ensureAppOutputKeyRegistered()` runs at wallet setup (AttestationScreen), at restore
 * (registerRecoveredHumanWallet) and on later opens (phoneMeterRuntime: unlock + foreground ticks):
 * best-effort, idempotent, never throws, never prompts. It also installs the Commons signer so a
 * person's posts, wants, job posts, deliverables and thread messages carry the signature.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import KeyManager from '../security/KeyManager';
import RelayAPIService from '../../services/RelayAPIService';
import { createAppOutputSigner, type AppOutputSigner } from './outputSigning';
import { setCommonsOutputSigner } from '../commons/commonsOutputSigning';

const REGISTERED_KEY_PREFIX = '@provian_output_key_registered_v2:';

export const appOutputSigner: AppOutputSigner = createAppOutputSigner({
    getPublicKey: () => KeyManager.getPublicKey(),
    signDigest: (digest0x) => KeyManager.signDigest(digest0x, 'auto_approve'),
    getUserId: () => RelayAPIService.getUserId(),
    register: (body) => RelayAPIService.registerOutputSigningKey(body),
    isRegistered: async (keyId, userId) => {
        try {
            return (await AsyncStorage.getItem(`${REGISTERED_KEY_PREFIX}${keyId}:${userId}`)) === '1';
        } catch {
            return false;
        }
    },
    markRegistered: async (keyId, userId) => {
        try {
            await AsyncStorage.setItem(`${REGISTERED_KEY_PREFIX}${keyId}:${userId}`, '1');
        } catch {
            // Re-registering is idempotent at the relay (200, created:false).
        }
    },
});

export type OutputKeyOutcome = 'registered' | 'deferred';

/** Register the phone's output key (if needed) and install the Commons signer. Never throws. */
export async function ensureAppOutputKeyRegistered(): Promise<OutputKeyOutcome> {
    setCommonsOutputSigner((text) => appOutputSigner.signOutput(text));
    try {
        await appOutputSigner.ensureRegistered();
        return 'registered';
    } catch {
        return 'deferred';
    }
}
