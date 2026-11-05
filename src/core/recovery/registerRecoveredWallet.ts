/**
 * registerRecoveredHumanWallet
 * ============================
 *
 * addendum (E2E finding #1): decouple relay-credential recovery from
 * human-wallet registration on the seed-import recovery path.
 *
 * ImportRecoveryPhraseScreen used to CHAIN the two:
 *
 * recoverRelayCredentials(addr)
 *.then(() => ensureHumanWalletRegistered(addr))
 *.catch
 *
 * so `ensureHumanWalletRegistered` ran ONLY if `recoverRelayCredentials`
 * resolved. On a first-run / biometric-less path `recoverRelayCredentials` can
 * reject (the recovery throttle, a declined biometric session, or a plain
 * network blip), and registration was then skipped entirely. The relay never
 * wrote the `type:'human'` wallet doc (see routes/human-wallet-registration.ts),
 * so the first `POST /v1/human-promises/create` 404'd — the relay's
 * `resolveHumanWallet` (core/presentation/principal.ts, via
 * routes/human-promises.ts) found no human wallet for the caller — and stayed
 * broken until an app restart triggered AppNavigator's launch-reconciliation
 * backstop.
 *
 * This runs the two legs INDEPENDENTLY. Recovery is attempted first, so a fresh
 * auth secret is in place when it succeeds; registration is then attempted
 * ALWAYS, regardless of the recovery outcome. `registerHumanWallet` goes through
 * `makeAuthenticatedRequest`, which itself auto-recovers credentials when the
 * explicit recovery leg above did not run, so registration can still succeed on
 * its own. Neither leg throws — the caller invokes this fire-and-forget,
 * non-blocking to reaching MainTabs (AppNavigator reconciles on the next launch
 * as a final backstop if both legs fail).
 */

export interface RecoveredWalletRelayDeps {
    /** Re-establish relay credentials for the recovered wallet address. */
    recoverRelayCredentials: (address: string) => Promise<unknown>;
    /**
     * Ensure the relay holds a `type:'human'` wallet doc for the address.
     * `allowAddressProof: false` forbids signing a registration proof on this attempt.
     */
    ensureHumanWalletRegistered: (
        address: string,
        options: { allowAddressProof: boolean },
    ) => Promise<void>;
    /**
     * Optional third leg: prove the restored wallet's OWN Solana address to the relay
     * (src/core/chains/solana/solanaAddressProof.ts). Runs after registration, whatever the
     * outcome of the legs above; best-effort and idempotent (it retries on later app opens).
     */
    proveSolanaAddress?: () => Promise<unknown>;
    /**
     * Optional fourth leg : register this phone's output-signing key (its PE
     * attestation key) for the restored wallet, so the person's Commons outputs are signed and
     * citable. Best-effort and idempotent (retried on later app opens); never prompts.
     */
    registerOutputSigningKey?: () => Promise<unknown>;
}

/**
 * Attempt relay-credential recovery and human-wallet registration for a
 * seed-imported wallet. Both legs are attempted; a failure of one MUST NOT skip
 * the other. Never throws.
 */
export async function registerRecoveredHumanWallet(
    address: string,
    deps: RecoveredWalletRelayDeps,
): Promise<void> {
    // Best-effort recovery first (a success seeds the auth secret registration
    // would otherwise auto-recover for itself). A rejection here must NOT abort
    // the registration leg below — that was finding #1.
    // round-robin fairness: did the relay DEFINITIVELY answer recovery (recovered, or
    // owner-missing → fresh account)? Only then may registration carry an address proof. A proof
    // can displace an unproven registration of the address — including the key holder's OWN intact
    // legacy account — so after a transient failure (503, 429 throttle, declined biometric,
    // network) a device still holding credentials for some other, empty account must NEVER sign
    // one: registration then runs proof-free (an existing registration replays; a new one 428s
    // and binds nothing). The launch backstop (AppNavigator → ensureHumanWalletRegistered) then
    // re-runs recovery itself on the 428 and signs only if THAT recovery resolves.
    let recoveryResolved = false;
    try {
        await deps.recoverRelayCredentials(address);
        recoveryResolved = true;
    } catch (err) {
        console.warn(
            '[Recovery] Relay credential recovery failed (registration still attempted):',
            err,
        );
    }

    // Registration is attempted UNCONDITIONALLY. makeAuthenticatedRequest
    // auto-recovers credentials when the leg above did not, so this can land the
    // type:'human' wallet doc even after a failed explicit recovery.
    try {
        await deps.ensureHumanWalletRegistered(address, { allowAddressProof: recoveryResolved });
    } catch (err) {
        console.warn(
            '[Recovery] Human wallet registration failed (AppNavigator reconciles on launch):',
            err,
        );
    }

    // The restored wallet's own Solana address: proven inside the biometric session restore
    // opened. Never throws, never blocks; a failure retries on a later app open.
    if (deps.proveSolanaAddress) {
        try {
            await deps.proveSolanaAddress();
        } catch (err) {
            console.warn('[Recovery] Solana address proof deferred (retried on a later app open):', err);
        }
    }

    // The phone's output-signing key, for the restored wallet (after registration, whatever its outcome).
    if (deps.registerOutputSigningKey) {
        try {
            await deps.registerOutputSigningKey();
        } catch (err) {
            console.warn('[Recovery] Output key registration deferred (retried on a later app open):', err);
        }
    }
}
