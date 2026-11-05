/**
 * Solana Chain Configuration
 *
 * Provian treats Solana as a first-class settlement / payment surface alongside
 * the EVM L2s (Base, Arbitrum, Optimism). Unlike the EVM chains — which share a
 * single numeric-`chainId` model and one secp256k1 EOA address — Solana is a
 * distinct address space (ed25519 / base58) with its own RPC dialect, so it is
 * modelled here rather than shoehorned into the EVM `ChainConfig`.
 *
 * INVARIANTS (see CLAUDE.md):
 * - Solana is a hold / send / receive / swap surface ONLY. PVT stays an ERC-20
 *   on Base; there is no PVT-on-Solana, no minting, no PE settlement on Solana.
 * - The Solana keypair derives from the SAME BIP-39 seed the EVM keys derive
 *   from (SLIP-0010 ed25519, path m/44'/501'/0'/0'). No new seed, no new backup.
 * - Environment-aware exactly like `evm/config.ts`: mainnet-beta in production,
 *   devnet under `isTestnet()`.
 */

import { isTestnet } from '../../shared/environment';

// =============================================================================
// CLUSTER DEFINITIONS
// =============================================================================

export interface SolanaClusterConfig {
    /** CAIP-2 network id used by x402 and cross-chain routing. */
    caip2: string;
    /** Human name. */
    name: string;
    /** Short slug (used for the relay Alchemy proxy path: rpc/<alchemyNetwork>). */
    alchemyNetwork: 'solana-mainnet' | 'solana-devnet';
    /** Public fallback RPC used if the relay proxy is unavailable. */
    fallbackRpcUrl: string;
    /** Explorer base (Solscan). */
    explorerUrl: string;
    /** Canonical circle USDC SPL mint on this cluster (base58). */
    usdcMint: string;
    isTestnet: boolean;
}

/**
 * Solana mainnet-beta. The CAIP-2 id is the genesis-block hash Coinbase's x402
 * spec uses to key the `solana:` network.
 */
export const SOLANA_MAINNET: SolanaClusterConfig = {
    caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    name: 'Solana',
    alchemyNetwork: 'solana-mainnet',
    fallbackRpcUrl: 'https://api.mainnet-beta.solana.com',
    explorerUrl: 'https://solscan.io',
    usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    isTestnet: false,
};

/** Solana devnet (used under the app's testnet environment). */
export const SOLANA_DEVNET: SolanaClusterConfig = {
    caip2: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    name: 'Solana Devnet',
    alchemyNetwork: 'solana-devnet',
    fallbackRpcUrl: 'https://api.devnet.solana.com',
    explorerUrl: 'https://solscan.io',
    // Circle devnet USDC mint.
    usdcMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    isTestnet: true,
};

/**
 * Get the active Solana cluster for the current environment.
 */
export function getActiveSolanaCluster(): SolanaClusterConfig {
    return isTestnet() ? SOLANA_DEVNET : SOLANA_MAINNET;
}

// =============================================================================
// PROGRAM IDS & DECIMALS (identical across clusters)
// =============================================================================

/** Native SOL uses 9 decimals (1 SOL = 1e9 lamports). */
export const SOL_DECIMALS = 9;
/** Circle USDC on Solana uses 6 decimals, same as EVM USDC. */
export const SOLANA_USDC_DECIMALS = 6;

export const SOL_SYMBOL = 'SOL' as const;
export const SOLANA_USDC_SYMBOL = 'USDC' as const;

/** SLIP-0010 / BIP-44 Solana derivation path (Phantom / Solana CLI standard). */
export const SOLANA_DERIVATION_PATH = "m/44'/501'/0'/0'" as const;

/** The `Asset.chain` / history `ChainType` discriminator for Solana. */
export const SOLANA_CHAIN_LABEL = 'Solana' as const;

// =============================================================================
// EXPLORER
// =============================================================================

function explorerClusterQuery(): string {
    // Solscan uses ?cluster=devnet for non-mainnet; mainnet needs no query.
    return getActiveSolanaCluster().isTestnet ? '?cluster=devnet' : '';
}

export function getSolanaTxExplorerUrl(signature: string): string {
    const { explorerUrl } = getActiveSolanaCluster();
    return `${explorerUrl}/tx/${signature}${explorerClusterQuery()}`;
}

export function getSolanaAddressExplorerUrl(address: string): string {
    const { explorerUrl } = getActiveSolanaCluster();
    return `${explorerUrl}/account/${address}${explorerClusterQuery()}`;
}

/**
 * Canonical USDC mint for the active cluster. This is the ONLY SPL asset the
 * wallet holds/sends/receives/swaps as a first-class token; anything else on
 * Solana is out of scope for this surface.
 */
export function getSolanaUsdcMint(): string {
    return getActiveSolanaCluster().usdcMint;
}
