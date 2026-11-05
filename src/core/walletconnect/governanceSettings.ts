/**
 * governanceSettings — the owner-tunable WalletConnect governance settings type
 * and defaults, in a ZERO-dependency module.
 *
 * Kept separate from WalletConnectGovernance.ts (which pulls in the full
 * agent-governance pipeline) so that walletStore — imported across the whole
 * app — can persist these settings without dragging the governance runtime
 * (and its potential import cycles) into every module that touches the store.
 *
 * This is the single source of truth for the shape + defaults; both the store
 * and the governance wrapper import from here.
 */

/**
 * Owner-tunable controls for the human WalletConnect governance pipeline.
 * See WalletConnectGovernance.ts for how each maps onto evaluateCryptoTransaction.
 */
export interface WalletConnectGovernanceSettings {
    /** Token approvals always route to hard_confirm. */
    requireApprovalConfirm: boolean;
    /** What to do with an UNLIMITED approval / permit (the classic drain vector). */
    unlimitedApprovalPolicy: 'block' | 'hard_confirm';
    /** What to do with an UNKNOWN / undecodable contract interaction. */
    unknownContractPolicy: 'block' | 'hard_confirm';
    /** Per-transaction cap in USD. 0 = disabled. Applies to priceable (stablecoin) value. */
    perTransactionLimitUsd: number;
    /** Daily cap in USD. 0 = disabled. Applies to priceable (stablecoin) value. */
    dailyLimitUsd: number;
}

/**
 * Safe defaults: approvals confirm, unlimited blocked, unknown ⇒ hard_confirm,
 * caps disabled. Biometric is enforced unconditionally by the service and is
 * NOT represented here (it is not owner-disablable).
 */
export const DEFAULT_WC_GOVERNANCE_SETTINGS: WalletConnectGovernanceSettings = {
    requireApprovalConfirm: true,
    unlimitedApprovalPolicy: 'block',
    unknownContractPolicy: 'hard_confirm',
    perTransactionLimitUsd: 0,
    dailyLimitUsd: 0,
};
