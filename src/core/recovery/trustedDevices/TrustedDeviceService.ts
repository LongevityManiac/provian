import {
    TrustedDeviceDescriptor,
    StartTrustedDevicePairingResponse,
    StartTrustedDeviceRecoveryResponse,
    TrustedDeviceFactorStatus,
    WalletId,
    RecoveryId
} from '../types';
import securityLog from '../../security/securityLogger';
import KeyManager from '../../security/KeyManager';

export interface TrustedDeviceService {
    listTrustedDevices(): Promise<TrustedDeviceDescriptor[]>;
    startPairing(): Promise<StartTrustedDevicePairingResponse>;
    startTrustedDeviceRecovery(walletId: WalletId): Promise<StartTrustedDeviceRecoveryResponse>;
    getTrustedDeviceFactorStatus(recoveryId: RecoveryId): Promise<TrustedDeviceFactorStatus>;
}

/**
 * Production implementation that blocks all operations.
 * Trusted device recovery is not yet available - users should use
 * cloud backup (PIN-encrypted AES-256-GCM → iCloud Keychain on iOS, Google Drive encrypted app folder on Android)
 * or the optional seed phrase export from Settings → Security.
 */
class ProductionTrustedDeviceService implements TrustedDeviceService {
    private readonly message = 'Trusted device recovery is not yet available. Use cloud backup or the optional seed phrase export from Settings → Security.';

    async listTrustedDevices(): Promise<TrustedDeviceDescriptor[]> {
        throw new Error(this.message);
    }

    async startPairing(): Promise<StartTrustedDevicePairingResponse> {
        throw new Error(this.message);
    }

    async startTrustedDeviceRecovery(_walletId: WalletId): Promise<StartTrustedDeviceRecoveryResponse> {
        throw new Error(this.message);
    }

    async getTrustedDeviceFactorStatus(_recoveryId: RecoveryId): Promise<TrustedDeviceFactorStatus> {
        throw new Error(this.message);
    }
}

/**
 * Mock service for development only.
 */
class MockTrustedDeviceService implements TrustedDeviceService {
    private devices: TrustedDeviceDescriptor[] = [];
    private recoverySessions: Map<RecoveryId, { satisfied: boolean, approvedAt?: number }> = new Map();

    async listTrustedDevices(): Promise<TrustedDeviceDescriptor[]> {
        return [...this.devices];
    }

    async startPairing(): Promise<StartTrustedDevicePairingResponse> {
        const address = await KeyManager.getAddress();
        const walletId = address || `unknown_${Date.now()}`;
        return {
            walletId,
            pairingUrl: `https://provian.ai/pair?wallet=${walletId}&t=${Date.now()}`,
            expiresAt: Date.now() + 300000
        };
    }

    async mockAddDevice(label: string): Promise<void> {
        this.devices.push({
            id: `td_${Date.now()}`,
            createdAt: Date.now(),
            label
        });
    }

    async startTrustedDeviceRecovery(walletId: WalletId): Promise<StartTrustedDeviceRecoveryResponse> {
        const recoveryId = `rec_td_${Date.now()}`;
        this.recoverySessions.set(recoveryId, { satisfied: false });

        setTimeout(() => {
            this.recoverySessions.set(recoveryId, { satisfied: true, approvedAt: Date.now() });
            console.log(`[MockTrustedDeviceService] Recovery ${recoveryId} satisfied`);
        }, 5000);

        return {
            recoveryId,
            approveUrl: `https://provian.ai/approve-recovery?recoveryId=${recoveryId}`,
            expiresAt: Date.now() + 300000
        };
    }

    async getTrustedDeviceFactorStatus(recoveryId: RecoveryId): Promise<TrustedDeviceFactorStatus> {
        const session = this.recoverySessions.get(recoveryId);
        return {
            factorType: 'trustedDevice',
            recoveryId,
            satisfied: session?.satisfied || false,
            approvedAt: session?.approvedAt
        };
    }
}

/**
 * Factory function - returns mock in dev, production guard in prod.
 */
export function getTrustedDeviceService(): TrustedDeviceService {
    return __DEV__ ? new MockTrustedDeviceService() : new ProductionTrustedDeviceService();
}

export const trustedDeviceService = getTrustedDeviceService();
