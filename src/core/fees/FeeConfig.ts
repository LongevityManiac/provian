/**
 * Fee Configuration — the app-side record of Provian's swap fee.
 *
 * Every swap through Provian charges 0.25% (25 bps), human and agent, on every
 * route: same-chain EVM (0x), same-chain Solana (Jupiter), and cross-chain
 * (LI.FI). The fee is set and verified ON THE RELAY
 * (provian-backend/src/core/swap/swap-fees.ts); the app never builds a fee
 * itself and only displays the fee the relay-verified quote carries. Sends and
 * receives carry no Provian fee — only network gas.
 *
 * The recipients below mirror the relay's pinned values for reference; the
 * relay is the enforcement point.
 */

/** Provian's swap fee in basis points (0.25%). */
export const PROVIAN_SWAP_FEE_BPS = 25;

/** The same rate as a fraction. */
export const PROVIAN_SWAP_FEE_PERCENT = PROVIAN_SWAP_FEE_BPS / 10_000;

// Provian treasury (EVM). Deliberately NOT the excluded administrative EOA
// 0xD395c8f59131a4736aa4d9eE6e5dEb8fDA07Ce0a: that key has an unresolved plaintext-exposure
// history (docs/SECRET_INVENTORY_2026-05-15.md), so it must not receive live value.
export const PROVIAN_EVM_TREASURY = '0x086e0F377af1245B8888540f39e99A42a7daF1dA';

/** Provian treasury (Solana): the Solana address of the same account as the EVM treasury. */
export const PROVIAN_SOLANA_TREASURY = '5PHJDHYveHA1LhqiWpCDRVEgSezDgPBMyL1rwAoMBTco';

/** The Solana treasury's USDC token account — the Jupiter fee account. */
export const PROVIAN_SOLANA_USDC_FEE_ACCOUNT = 'E8WkRWFrrpJH2nvVDB3jTnLrRJQqpCT8qftV4vU7QQkB';
