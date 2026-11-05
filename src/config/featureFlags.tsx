/**
 * Feature Flags - Launch Configuration
 *
 * Controls which features are enabled in the app.
 *
 * LAUNCH STRATEGY:
 * - Phase 1: Fiat spending + Promise path
 * - Phase 2: Crypto spending, wallet, staking, swaps
 *
 * All features are now live.
 */

// =====================
// FEATURE FLAGS
// =====================

export const FEATURES = {
    // ==================
    // PHASE 1 - LAUNCH
    // ==================

    /**
     * Promise Path - IOU/promise tracking without crypto.
     * Lightweight mode for non-crypto users.
     */
    AGENT_PROMISE_PATH: true,

    // ==================
    // PHASE 2 - LIVE
    // ==================

    /**
     * Crypto Wallet UI - Full crypto wallet interface.
     */
    CRYPTO_WALLET_UI: true,

    /**
     * Multi-Chain Support - EVM (Base, Arbitrum, Optimism) plus Solana
     * (SOL + USDC on Solana, hold/send/receive/swap).
     */
    MULTI_CHAIN_SUPPORT: true,

    /**
     * Recovery System - PIN-encrypted cloud backup (AES-256-GCM) of the
     * BIP-39 seed to iCloud Keychain on iOS or to Google Drive's app data
     * folder on Android. Optional seed phrase export is available in
     * Settings as an offline escape hatch.
     */
    RECOVERY_SYSTEM: true,

    /**
     * Swap Engine - In-app token swaps.
     */
    SWAP_ENGINE: true,
} as const;

// =====================
// FEATURE METADATA
// =====================

export interface FeatureMetadata {
    name: string;
    description: string;
    phase: 'launch' | 'coming_soon' | 'dev';
    comingSoonMessage?: string;
}

export const FEATURE_METADATA: Record<keyof typeof FEATURES, FeatureMetadata> = {
    AGENT_PROMISE_PATH: {
        name: 'Promise Path',
        description: 'Track IOUs and promises without crypto',
        phase: 'launch',
    },
    CRYPTO_WALLET_UI: {
        name: 'Crypto Wallet',
        description: 'Full cryptocurrency wallet interface',
        phase: 'launch',
    },
    MULTI_CHAIN_SUPPORT: {
        name: 'Multi-Chain',
        description: 'EVM support (Base, Arbitrum, Optimism) plus Solana',
        phase: 'launch',
    },
    RECOVERY_SYSTEM: {
        name: 'Recovery System',
        description: 'PIN-encrypted cloud backup (iCloud / Google) + optional seed phrase fallback',
        phase: 'launch',
    },
    SWAP_ENGINE: {
        name: 'Swap',
        description: 'Swap tokens within the app',
        phase: 'launch',
    },
};

// =====================
// HELPER FUNCTIONS
// =====================

/**
 * Check if a feature is enabled.
 */
export function isFeatureEnabled(feature: keyof typeof FEATURES): boolean {
    return FEATURES[feature];
}

/**
 * Check if a feature is coming soon (disabled but planned).
 */
export function isComingSoon(feature: keyof typeof FEATURES): boolean {
    return FEATURE_METADATA[feature]?.phase === 'coming_soon';
}

/**
 * Get the coming soon message for a feature.
 */
export function getComingSoonMessage(feature: keyof typeof FEATURES): string {
    return (
        FEATURE_METADATA[feature]?.comingSoonMessage ||
        'This feature is coming soon!'
    );
}

/**
 * Get all features in a specific phase.
 */
export function getFeaturesByPhase(phase: 'launch' | 'coming_soon' | 'dev'): Array<keyof typeof FEATURES> {
    return (Object.keys(FEATURES) as Array<keyof typeof FEATURES>).filter(
        (key) => FEATURE_METADATA[key]?.phase === phase
    );
}

/**
 * Get feature metadata.
 */
export function getFeatureMetadata(feature: keyof typeof FEATURES): FeatureMetadata {
    return FEATURE_METADATA[feature];
}

// =====================
// FEATURE GATES
// =====================

/**
 * Higher-order component to gate UI by feature flag.
 * Returns null if feature is disabled.
 */
export function withFeatureGate<P extends object>(
    feature: keyof typeof FEATURES,
    Component: React.ComponentType<P>
): React.FC<P> {
    return function FeatureGatedComponent(props: P) {
        if (!isFeatureEnabled(feature)) {
            return null;
        }
        return <Component {...props} />;
    };
}

// =====================
// RUNTIME CONFIG
// =====================

/**
 * Runtime configuration that can be updated remotely.
 * These override the static feature flags.
 */
export interface RuntimeConfig {
    /** Override feature flags */
    featureOverrides?: Partial<typeof FEATURES>;

    /** Maintenance mode */
    maintenanceMode?: boolean;

    /** Maintenance message */
    maintenanceMessage?: string;

    /** Minimum app version required */
    minAppVersion?: string;

    /** Force update message */
    forceUpdateMessage?: string;
}

let runtimeConfig: RuntimeConfig = {};

/**
 * Set runtime configuration (typically from remote config).
 */
export function setRuntimeConfig(config: RuntimeConfig): void {
    runtimeConfig = config;
}

/**
 * Get runtime configuration.
 */
export function getRuntimeConfig(): RuntimeConfig {
    return runtimeConfig;
}

/**
 * Check feature with runtime override support.
 */
export function isFeatureEnabledWithOverrides(feature: keyof typeof FEATURES): boolean {
    // Check runtime override first
    if (runtimeConfig.featureOverrides?.[feature] !== undefined) {
        return runtimeConfig.featureOverrides[feature];
    }
    // Fall back to static flag
    return FEATURES[feature];
}
