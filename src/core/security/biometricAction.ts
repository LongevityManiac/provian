import { AppState, Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { authenticateBiometricAction, requireBiometric } from './requireBiometric';
import type { ProvianSecureSeedModule } from '../../../modules/provian-secure-seed';
import { translate } from '../../i18n/translate';

/** A capability for ONE approved action. Never persisted or obtained from ambient state. */
export interface BiometricAction { readonly nativeId: string | null }
interface Grant { live: boolean; native: ProvianSecureSeedModule | null }
const grants = new WeakMap<BiometricAction, Grant>();
const running = new Set<BiometricAction>();
let queue: Promise<unknown> = Promise.resolve();
let backgroundEpoch = 0;

export class BiometricSessionRequiredError extends Error {
    readonly code = 'BIOMETRIC_SESSION_REQUIRED';
    /** English text for dApp replies and PE records; `message` is the on-screen copy. */
    readonly englishMessage = 'A live biometric action is required to access wallet secrets.';
    constructor() {
        super(translate('biometricErrors.sessionRequired', 'A live biometric action is required to access wallet secrets.'));
        this.name = 'BiometricSessionRequiredError';
    }
}

export function isBiometricActionValid(action?: BiometricAction): boolean {
    return !!action && grants.get(action)?.live === true;
}

export function assertBiometricAction(action?: BiometricAction): asserts action is BiometricAction {
    if (!isBiometricActionValid(action)) throw new BiometricSessionRequiredError();
}

export function revokeBiometricActions(): void {
    for (const action of running) {
        const grant = grants.get(action);
        if (grant) {
            grant.live = false;
            if (action.nativeId) void grant.native?.endActionAsync(action.nativeId).catch(() => undefined);
        }
    }
}

AppState?.addEventListener?.('change', (state) => {
    // iOS Face ID itself makes the application inactive. Only a real background revokes.
    if (state === 'background') { backgroundEpoch++; revokeBiometricActions(); }
});

/**
 * New actions serialize, but NEVER coalesce. Only an explicitly passed capability can reuse an
 * approval. The native module authenticates once and keeps its context/DEKs only until finally.
 */
export async function withBiometricAction<T>(
    reason: string,
    fn: (action: BiometricAction) => Promise<T>,
    existing?: BiometricAction,
    biometricOnly = false,
): Promise<T> {
    if (existing) {
        assertBiometricAction(existing);
        return fn(existing);
    }
    const start = async (): Promise<T> => {
        if (AppState?.currentState === 'background') throw new BiometricSessionRequiredError();
        const epoch = backgroundEpoch;
        const mod = requireOptionalNativeModule<ProvianSecureSeedModule>('ProvianSecureSeed');
        const native = mod?.beginActionAsync ? mod : null;
        let pendingAndroidCredential = false;
        const nativeId = native
            ? await authenticateBiometricAction(fallback => {
                pendingAndroidCredential = fallback && Platform.OS === 'android';
                return native.beginActionAsync(reason, fallback, '');
            }, biometricOnly)
            : (await requireBiometric(reason, biometricOnly), null);
        // Android's legacy credential Activity pauses React Native during the FIRST prompt.
        // Native retains only an empty pending authentication and waits for onResume before
        // unwrapping. Already granted actions remain revoked on every background transition.
        if (pendingAndroidCredential && backgroundEpoch !== epoch && String(AppState?.currentState) === 'background') {
            await new Promise<void>(resolve => {
                const timeout = setTimeout(() => { subscription?.remove(); resolve(); }, 3000);
                const subscription = AppState.addEventListener('change', state => {
                    if (state === 'active') { clearTimeout(timeout); subscription.remove(); resolve(); }
                });
            });
        }
        if (backgroundEpoch !== epoch && !(pendingAndroidCredential && AppState?.currentState === 'active')) {
            if (nativeId) await native?.endActionAsync(nativeId);
            throw new BiometricSessionRequiredError();
        }
        const action: BiometricAction = Object.freeze({ nativeId });
        const grant: Grant = { live: true, native };
        grants.set(action, grant);
        running.add(action);
        try {
            const result = await fn(action);
            // Reads/signers validate at the point of use. A transaction already submitted before
            // backgrounding must still report its eventual receipt, rather than a false failure.
            return result;
        } finally {
            grant.live = false;
            running.delete(action);
            if (nativeId) await native?.endActionAsync(nativeId);
        }
    };
    const run = queue.then(start, start);
    queue = run.catch(() => undefined);
    return run;
}
