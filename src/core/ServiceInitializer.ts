import type { BiometricAction } from './security/biometricAction';
/**
 * ServiceInitializer - App Service Initialization
 *
 * Initializes all services in dependency order when the app starts.
 * Provides a singleton `Services` object accessible from any component.
 *
 * Initialization Order:
 * 1. KeyManager.reconcileKeyState - PE attestation key state
 * 2. AppModeManager - mode cache
 * 3. ProvenanceEnvelopeManager - recovers pending envelopes (the one critical
 *    service; everything generates PEs)
 */

import ProvenanceEnvelopeManager from './provenance/ProvenanceEnvelopeManager';
import { FootprintStore } from './footprint/FootprintStore';
import KeyManager from './security/KeyManager'; // [SEC-audit-5.4]
import { AppModeManager } from './AppModeManager';

/**
 * Service status for UI loading states.
 */
export interface ServiceStatus {
    /** Overall initialization complete */
    isReady: boolean;

    /** Individual service status */
    services: {
        provenance: boolean;
        footprint: boolean;
    };

    /** Errors encountered during initialization */
    errors: string[];

    /** Whether running in degraded mode (some services unavailable) */
    degradedMode: boolean;

    /**
     * Names of critical services that failed to initialize. Empty when no
     * critical service failed. Used by the App shell to surface a recoverable
     * error view instead of an indefinite loading spinner.
     */
    failedServices: string[];
}

/**
 * Services singleton - import this anywhere to access initialized services.
 */
export const Services = {
    provenance: ProvenanceEnvelopeManager,
};

// Track initialization status
let _status: ServiceStatus = {
    isReady: false,
    services: {
        provenance: false,
        footprint: false,
    },
    errors: [],
    degradedMode: false,
    failedServices: [],
};

// Listeners for status changes
const _statusListeners: Set<(status: ServiceStatus) => void> = new Set();

/**
 * Get current service status.
 */
export function getServiceStatus(): ServiceStatus {
    return { ..._status };
}

/**
 * Subscribe to service status updates.
 */
export function onServiceStatusChange(
    listener: (status: ServiceStatus) => void
): () => void {
    _statusListeners.add(listener);
    return () => _statusListeners.delete(listener);
}

/**
 * Update status and notify listeners.
 */
function updateStatus(updates: Partial<ServiceStatus>): void {
    _status = { ..._status, ...updates };
    _statusListeners.forEach((listener) => listener(_status));
}

/**
 * Initialize all services.
 * Call this during app startup (e.g., in App.tsx useEffect).
 */
export async function initializeServices(biometricAction?: BiometricAction): Promise<ServiceStatus> {
    console.log('[ServiceInitializer] Starting service initialization...');

    // [SEC-audit-5.4] Reconcile key state on startup - detect stale cache from
    // interrupted key deletion and clear it before wallet state is read
    try {
        await KeyManager.reconcileKeyState();
        console.log('[ServiceInitializer] ✓ Key state reconciled');
    } catch (error) {
        console.error('[ServiceInitializer] ✗ Key reconciliation failed:', error);
    }

    // [Fix #1] Initialize AppModeManager cache so getModeSync() works for wallet guards
    try {
        await AppModeManager.initialize();
        console.log('[ServiceInitializer] ✓ AppModeManager cache initialized');
    } catch (error) {
        console.error('[ServiceInitializer] ✗ AppModeManager initialization failed:', error);
    }

    const errors: string[] = [];
    const services = { ..._status.services };

    try {
        // 1. ProvenanceEnvelopeManager
        // Recovers any pending envelopes from crash WAL
        console.log('[ServiceInitializer] Initializing Provenance...');
        await ProvenanceEnvelopeManager.initialize(biometricAction);
        services.provenance = true;
        console.log('[ServiceInitializer] ✓ Provenance ready');
    } catch (error) {
        const msg = `Provenance: ${error instanceof Error ? error.message : 'Unknown error'}`;
        errors.push(msg);
        console.error('[ServiceInitializer] ✗ Provenance failed:', error);
    }

    // Determine if we're in degraded mode
    const criticalServices = ['provenance'];
    const criticalFailures = criticalServices.filter(
        (s) => !services[s as keyof typeof services]
    );
    const degradedMode = criticalFailures.length > 0;

    // All critical services must be ready
    const isReady = !degradedMode;

    updateStatus({
        isReady,
        services,
        errors,
        degradedMode,
        failedServices: criticalFailures,
    });

    if (isReady) {
        console.log('[ServiceInitializer] ✓ All services initialized successfully');
    } else if (degradedMode) {
        console.warn('[ServiceInitializer] Running in degraded mode, failed services:', criticalFailures);
    }

    return _status;
}

/**
 * Shutdown all services.
 * Call this during app shutdown.
 */
export async function shutdownServices(): Promise<void> {
    console.log('[ServiceInitializer] Shutting down services...');

    console.log('[ServiceInitializer] ✓ Services shutdown complete');

    updateStatus({
        isReady: false,
        services: {
            provenance: false,
            footprint: false,
        },
        errors: [],
        degradedMode: false,
        failedServices: [],
    });
}

/**
 * Check if services are ready.
 */
export function isServicesReady(): boolean {
    return _status.isReady;
}

export default {
    Services,
    getServiceStatus,
    onServiceStatusChange,
    initializeServices,
    shutdownServices,
    isServicesReady,
};
