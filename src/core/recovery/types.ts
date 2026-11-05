export type TrustedDeviceId = string;
export type WalletId = string;
export type RecoveryId = string;

export interface TrustedDeviceDescriptor {
    id: TrustedDeviceId;
    createdAt: number;
    label?: string; // e.g. "Mom's Phone", "iPad", etc.
}

export interface StartTrustedDevicePairingResponse {
    walletId: WalletId;
    pairingUrl: string; // e.g. https://provian.ai/pair?data=...
    expiresAt: number;
}

export interface StartTrustedDeviceRecoveryResponse {
    recoveryId: RecoveryId;
    approveUrl: string; // e.g. https://provian.ai/approve-recovery?recoveryId=...
    expiresAt: number;
}

// [Opus-audit M-2] Added factorType discriminator for type-safe factor checking
export interface TrustedDeviceFactorStatus {
    factorType: 'trustedDevice';  // [Opus-audit M-2]
    recoveryId: RecoveryId;
    satisfied: boolean;
    approvedAt?: number;
}

// [Opus-audit M-2] All factor types now use explicit factorType discriminator
// This enables type-safe pattern matching without relying on 'in' checks
export type RecoveryFactorResult =
    | TrustedDeviceFactorStatus
    | { factorType: 'passkey'; satisfied: boolean }
    | { factorType: 'cloud'; satisfied: boolean }
    | { factorType: 'breakglass'; satisfied: boolean };

export interface RecoveryPolicy {
    requiredFactors: number; // Total number of methods enabled during setup
    passkeyEnabled: boolean; // Passkey recovery (synced via iCloud/Google)
    trustedDevicesEnabled: boolean;
    cloudBackupEnabled: boolean;
    breakGlassEnabled: boolean;
    minDistinctFactors: number; // Minimum number of distinct factors required to recover (e.g. 2)
}
