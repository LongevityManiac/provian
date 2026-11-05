/**
 * Shared Environment Utilities
 *
 * Single source of truth for environment detection across all chain configs.
 * Avoids DRY violations from copy-pasted environment code.
 */

// =============================================================================
// TYPES
// =============================================================================

export type Environment = 'development' | 'production';

// =============================================================================
// STATE
// =============================================================================

let environmentOverride: Environment | null = null;

// =============================================================================
// FUNCTIONS
// =============================================================================

/**
 * Get current environment based on __DEV__ global.
 * In React Native, __DEV__ is true for development builds.
 */
export function getEnvironment(): Environment {
    // @ts-ignore - __DEV__ is a React Native global
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
        return 'development';
    }
    return 'production';
}

/**
 * Override the environment for testing purposes.
 * Pass null to clear the override.
 */
export function setEnvironmentOverride(env: Environment | null): void {
    environmentOverride = env;
}

/**
 * Get current environment, respecting any override.
 */
export function getCurrentEnvironment(): Environment {
    return environmentOverride ?? getEnvironment();
}

/**
 * Check if current environment is testnet/devnet.
 * Returns true for development environment.
 */
export function isTestnet(): boolean {
    return getCurrentEnvironment() === 'development';
}
