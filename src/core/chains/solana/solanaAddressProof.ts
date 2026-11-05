import { isBiometricActionValid, type BiometricAction } from '../../security/biometricAction';
/**
 * Prove the Provian wallet's OWN Solana address to the relay ( follow-up).
 *
 * The relay binds a Solana address to its owner with an ed25519 proof of control, so the
 * person's Solana x402 payments and receipts settled through Provian's facilitator become
 * witnessed PEs. The address proven here is the wallet's own: the SLIP-0010 ed25519 key at
 * m/44'/501'/0'/0' of the same BIP-39 seed (origin 'native'). Proving pays nothing (a
 * record_only receipt); activity counts only from the proof's slot forward.
 *
 * POST /v1/wallet/solana-address/challenge → the six-line "Provian Solana proof of control" message
 * (check it, sign its raw UTF-8 bytes with ed25519, base58 signature)
 * POST /v1/wallet/solana-address/verify { address, challenge_id, signature, origin: 'native' }
 * GET /v1/wallet/solana-addresses
 *
 * Best-effort, non-blocking, idempotent, retried:
 * - triggered at wallet setup (AttestationScreen), at restore (registerRecoveredHumanWallet),
 * after every unlock and on the meter's foreground ticks (phoneMeterRuntime);
 * - done once per wallet: a NON-sensitive flag in AsyncStorage keyed by the EVM wallet address
 * records the Solana address proven; the relay's own list is consulted first, so a wallet
 * proven before a reinstall never signs again;
 * - it NEVER prompts: the signing key is read only inside a live SeedManager biometric session
 * (setup and restore open one; so does any signing the person does). With no live session
 * it returns `deferred_no_session` and the next trigger retries. This adds no prompt and no
 * visible copy to the app.
 *
 * SECURITY: the relay's message is signed only after `checkSolanaProofMessage` confirms it is
 * exactly the Solana proof message naming THIS wallet's Solana address on a `person:` line —
 * never an arbitrary relay string. The ed25519 seed is derived on demand from the seed in
 * SecureStore (SeedManager.getSolanaSeed, biometric-session gated), its public key must equal
 * the address being proven, it never leaves this function, and it is wiped in `finally`.
 * Nothing secret is written to AsyncStorage — only the public Solana address as the flag.
 */

import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519';
import { checkSolanaProofMessage } from './solanaProofMessage';

/** The flag key: one per EVM wallet address (lowercased). Its value is the proven Solana address. */
export const SOLANA_PROOF_FLAG_PREFIX = '@provian_solana_address_proven_v1:';

export function solanaProofFlagKey(evmAddress: string): string {
    return `${SOLANA_PROOF_FLAG_PREFIX}${evmAddress.toLowerCase()}`;
}

export type SolanaProofOutcome =
    | 'proven'
    | 'already_proven'
    | 'no_wallet'
    | 'in_flight'
    | 'deferred_unregistered'
    | 'deferred_no_session'
    | 'refused_message'
    | 'key_mismatch'
    | 'refused_by_relay'
    | 'failed';

type RelayRefusal = { ok: false; status: number; error: string };

export interface SolanaProofAppDeps {
    kv: { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> };
    /** The EVM wallet address (the flag key), or null when there is no wallet. */
    walletAddress(): Promise<string | null>;
    /** The wallet's Solana address (public material; must not prompt), or null. */
    solanaAddress(): Promise<string | null>;
    /** Is a SeedManager biometric session live? Signing happens only inside one. */
    sessionValid(): Promise<boolean>;
    /** The 32-byte ed25519 seed of m/44'/501'/0'/0' (session-gated). The caller wipes it. */
    solanaSeed(): Promise<Uint8Array>;
    relay: {
        /** Relay credentials exist AND the human wallet is registered (idempotent). */
        ready(evmAddress: string): Promise<boolean>;
        list(): Promise<string[] | null>;
        challenge(address: string): Promise<
            | { ok: true; challenge: { challengeId: string; message: string; nonce?: string; issuedAt?: number; expiresAt?: number } }
            | RelayRefusal
        >;
        verify(input: { address: string; challengeId: string; signature: string; origin: 'native' }): Promise<
            | { ok: true; provenAddress: string; alreadyProven: boolean }
            | RelayRefusal
        >;
    };
    now(): number;
    log?(message: string): void;
}

/** Relay `error` strings meaning "this binding already stands for you" (benign). */
const SAME_OWNER_ERRORS: ReadonlySet<string> = new Set([
    'already_proven',
    'address_already_proven',
    'address_already_bound_to_you',
    'already_bound_to_caller',
]);

let inFlight: Promise<SolanaProofOutcome> | null = null;
/**
 * The Solana address the relay's list said is NOT yet proven, this app run. Lets the frequent
 * no-session triggers (meter ticks) return without a network call until a session exists.
 */
let relaySaidUnproven: string | null = null;

/** Test seam: forget the per-run state. */
export function resetSolanaProofStateForTests(): void {
    inFlight = null;
    relaySaidUnproven = null;
}

/**
 * Make sure the wallet's own Solana address is proven. Never throws; never prompts.
 * Concurrent calls share one run.
 */
export function ensureSolanaAddressProvenWith(deps: SolanaProofAppDeps): Promise<SolanaProofOutcome> {
    if (inFlight) return inFlight;
    const run = runOnce(deps).catch((err: unknown): SolanaProofOutcome => {
        deps.log?.(`[SolanaProof] failed: ${err instanceof Error ? err.message : String(err)}`);
        return 'failed';
    }).finally(() => { inFlight = null; });
    inFlight = run;
    return run;
}

async function runOnce(deps: SolanaProofAppDeps): Promise<SolanaProofOutcome> {
    const evm = await deps.walletAddress();
    const sol = await deps.solanaAddress();
    if (!evm || !sol) return 'no_wallet';
    const flagKey = solanaProofFlagKey(evm);
    if ((await deps.kv.getItem(flagKey)) === sol) return 'already_proven';

    const session = await deps.sessionValid();
    if (!session && relaySaidUnproven === sol) return 'deferred_no_session';

    if (!(await deps.relay.ready(evm))) return 'deferred_unregistered';

    // Ask the relay first (no key needed): a binding that already stands — proven before a
    // reinstall, or by another of this person's devices — is recorded and never re-signed.
    const proven = await deps.relay.list();
    if (proven && proven.includes(sol)) {
        await deps.kv.setItem(flagKey, sol);
        return 'already_proven';
    }
    if (proven) relaySaidUnproven = sol;

    // Never prompt for this background step: sign only inside a live biometric session (read
    // again — the list call may have outlived the session that was live a moment ago).
    if (!session || !(await deps.sessionValid())) return 'deferred_no_session';

    const challenge = await deps.relay.challenge(sol);
    if (!challenge.ok) {
        deps.log?.(`[SolanaProof] challenge refused: ${challenge.error}`);
        return challenge.status === 409 ? 'refused_by_relay' : 'failed';
    }
    const c = challenge.challenge;
    const verdict = checkSolanaProofMessage(
        { message: c.message, nonce: c.nonce, issued_at: c.issuedAt, expires_at: c.expiresAt },
        { address: sol, subject: { kind: 'person' } },
        deps.now(),
    );
    if (!verdict.ok) {
        // The one gate in front of the wallet key: an unexpected message is never signed.
        deps.log?.(`[SolanaProof] refused to sign: ${verdict.reason}`);
        return 'refused_message';
    }

    let signature: string;
    const seed = await deps.solanaSeed();
    try {
        if (bs58.encode(ed25519.getPublicKey(seed)) !== sol) return 'key_mismatch';
        signature = bs58.encode(ed25519.sign(new TextEncoder().encode(c.message), seed));
    } finally {
        seed.fill(0);
    }

    const result = await deps.relay.verify({ address: sol, challengeId: c.challengeId, signature, origin: 'native' });
    if (result.ok) {
        await deps.kv.setItem(flagKey, sol);
        return result.alreadyProven ? 'already_proven' : 'proven';
    }
    if (result.status === 409 && SAME_OWNER_ERRORS.has(result.error)) {
        await deps.kv.setItem(flagKey, sol);
        return 'already_proven';
    }
    deps.log?.(`[SolanaProof] verify refused: ${result.error}`);
    return result.status === 409 ? 'refused_by_relay' : 'failed';
}

/** Production wiring. Every import is lazy so nothing loads at module import time. */
export function ensureSolanaAddressProven(biometricAction?: BiometricAction): Promise<SolanaProofOutcome> {
    return ensureSolanaAddressProvenWith({
        kv: {
            async getItem(key) {
                const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
                return AsyncStorage.getItem(key);
            },
            async setItem(key, value) {
                const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
                await AsyncStorage.setItem(key, value);
            },
        },
        async walletAddress() {
            const { useWalletStore } = await import('../../../store/walletStore');
            const { address, onboardingComplete } = useWalletStore.getState();
            return onboardingComplete && address ? address : null;
        },
        async solanaAddress() {
            const { useWalletStore } = await import('../../../store/walletStore');
            const fromStore = useWalletStore.getState().solanaAddress;
            if (fromStore) return fromStore;
            // Public material: the persisted address, else SeedManager's public-address cache (a
            // legacy item without an auth ACL is read without a prompt) — never the gated seed path.
            const WalletCreationService = (await import('../../wallet/WalletCreationService')).default;
            return WalletCreationService.getInstance().getSolanaAddress(biometricAction);
        },
        async sessionValid() {
            const SeedManager = (await import('../../wallet/SeedManager')).default;
            return isBiometricActionValid(biometricAction);
        },
        async solanaSeed() {
            const SeedManager = (await import('../../wallet/SeedManager')).default;
            return SeedManager.getSolanaSeed(biometricAction);
        },
        relay: {
            async ready(evmAddress) {
                const relay = (await import('../../../services/RelayAPIService')).default;
                if (!(await relay.isRegistered())) return false;
                await relay.ensureHumanWalletRegistered(evmAddress, undefined, biometricAction);
                return true;
            },
            async list() {
                const relay = (await import('../../../services/RelayAPIService')).default;
                return relay.listOwnSolanaAddresses(biometricAction);
            },
            async challenge(address) {
                const relay = (await import('../../../services/RelayAPIService')).default;
                return relay.requestOwnSolanaAddressChallenge(address, biometricAction);
            },
            async verify(input) {
                const relay = (await import('../../../services/RelayAPIService')).default;
                return relay.verifyOwnSolanaAddress(input, biometricAction);
            },
        },
        now: () => Date.now(),
        log: (message) => console.warn(message),
    });
}
