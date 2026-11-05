/**
 * AppModeManager - wallet-mode guard surface.
 *
 * the multi-mode hub ('promises' / 'ai-controls' path selection) is GONE.
 * Provian is a unified wallet, so the only live mode is 'wallet'. This module is
 * kept as the single wallet-guard surface (assertWalletEnabled / isWalletModeActive)
 * consumed by the money paths (SwapEngine, CrossChainSwapEngine, TransactionService,
 * HumanJobEscrowFunder, SolanaTransactionService) and warmed by ServiceInitializer.
 *
 * SOURCE OF TRUTH: walletStore.walletMode (Zustand, persisted as
 * `provian-wallet-storage`), set to 'wallet' by completeOnboarding. There is no
 * setMode here anymore — mode is not user-selectable.
 */

import { useWalletStore, normalizeWalletMode } from '../store/walletStore';

/** The only live app mode. (The 'promises' / 'ai-controls' modes were retired.) */
export type AppMode = 'wallet';

// =============================================================================
// WALLET LOCKOUT FLAG
// =============================================================================

/**
 * WALLET_ENABLED controls whether wallet functions can execute.
 */
const WALLET_ENABLED = true;

// Cached mode for synchronous access (warmed during initialization)
let cachedMode: AppMode | null = null;

// =============================================================================
// APP MODE MANAGER
// =============================================================================

export const AppModeManager = {
    /**
     * Get the app mode (async). Reads from walletStore (the single source of truth).
     */
    async getMode(): Promise<AppMode | null> {
        const raw = useWalletStore.getState().walletMode;
        cachedMode = normalizeWalletMode(raw);
        return cachedMode;
    },

    /**
     * Get the app mode synchronously.
     * Returns the cached value (warmed during initialize()) or reads from walletStore.
     */
    getModeSync(): AppMode | null {
        if (cachedMode !== null) return cachedMode;
        const raw = useWalletStore.getState().walletMode;
        cachedMode = normalizeWalletMode(raw);
        return cachedMode;
    },

    /**
     * Clear the app mode. Resets walletStore onboarding state.
     */
    async clearMode(): Promise<void> {
        useWalletStore.getState().resetOnboarding();
        cachedMode = null;
    },

    /**
     * Initialize the cache (call on app startup).
     * Reads from walletStore to warm the cachedMode for synchronous access.
     */
    async initialize(): Promise<void> {
        const raw = useWalletStore.getState().walletMode;
        cachedMode = normalizeWalletMode(raw);
    },
};

// =============================================================================
// WALLET GUARDS
// =============================================================================

/**
 * Check if wallet features are enabled.
 */
export function isWalletEnabled(): boolean {
    return WALLET_ENABLED;
}

/**
 * Check if the current mode is wallet mode AND wallet is enabled.
 */
export function isWalletModeActive(): boolean {
    if (!WALLET_ENABLED) return false;
    return AppModeManager.getModeSync() === 'wallet';
}

/**
 * Assert that wallet operations are enabled.
 * Throws an error if wallet is disabled or not in wallet mode.
 * Use this at the top of any function that should only run in wallet mode.
 *
 * @param operation - Name of the operation being attempted (for logging)
 */
export function assertWalletEnabled(operation: string): void {
    if (!WALLET_ENABLED) {
        console.error(`[BLOCKED] Wallet operation "${operation}" attempted - wallet is not yet available`);
        throw new Error('Wallet features are not enabled.');
    }

    const mode = AppModeManager.getModeSync();
    if (mode !== 'wallet') {
        console.error(`[BLOCKED] Wallet operation "${operation}" attempted in ${mode || 'unknown'} mode`);
        throw new Error('This feature requires wallet mode.');
    }
}

export default AppModeManager;
