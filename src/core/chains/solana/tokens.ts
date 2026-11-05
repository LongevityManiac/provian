/**
 * Solana tokens the wallet offers beyond SOL and USDC.
 *
 * The relay's Jupiter route swaps any pair of Solana tokens and takes Provian's 0.25% fee on each
 *. These are the tokens the swap screen offers as a destination, and the wallet
 * shows once held. Decimals and token programs were read from the mint accounts on mainnet
 *; PYUSD is a Token-2022 mint.
 */
import type { Asset } from '../../../store/walletStore';
import { getActiveSolanaCluster } from './config';

export const SPL_TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const SPL_TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

export interface SolanaListedToken {
    symbol: string;
    name: string;
    mint: string;
    decimals: number;
    tokenProgram: typeof SPL_TOKEN_PROGRAM_ID | typeof SPL_TOKEN_2022_PROGRAM_ID;
    isStablecoin?: boolean;
}

const MAINNET_TOKENS: readonly SolanaListedToken[] = [
    { symbol: 'BONK', name: 'Bonk', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', decimals: 5, tokenProgram: SPL_TOKEN_PROGRAM_ID },
    { symbol: 'JUP', name: 'Jupiter', mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', decimals: 6, tokenProgram: SPL_TOKEN_PROGRAM_ID },
    { symbol: 'WIF', name: 'dogwifhat', mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', decimals: 6, tokenProgram: SPL_TOKEN_PROGRAM_ID },
    { symbol: 'PYUSD', name: 'PayPal USD', mint: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', decimals: 6, tokenProgram: SPL_TOKEN_2022_PROGRAM_ID, isStablecoin: true },
];

/** The listed tokens for the active cluster (none on devnet: these mints are mainnet-only). */
export function getListedSolanaTokens(): readonly SolanaListedToken[] {
    return getActiveSolanaCluster().isTestnet ? [] : MAINNET_TOKENS;
}

/** A listed token as a wallet Asset (balance in display units). */
export function listedTokenAsset(token: SolanaListedToken, balance = '0', price = 0): Asset {
    return {
        symbol: token.symbol,
        name: token.name,
        balance,
        price,
        chain: 'Solana',
        tokenAddress: token.mint,
        decimals: token.decimals,
        ...(token.isStablecoin ? { isStablecoin: true } : {}),
    };
}

/**
 * The destinations the swap screen offers: every held asset, plus each listed Solana token the
 * wallet does not hold yet (at a zero balance) — a swap can open the account for it.
 */
export function swapDestinationAssets(held: readonly Asset[], listed: readonly SolanaListedToken[] = getListedSolanaTokens()): Asset[] {
    const have = new Set(held.filter((a) => a.chain === 'Solana' && a.tokenAddress).map((a) => a.tokenAddress));
    return [...held, ...listed.filter((t) => !have.has(t.mint)).map((t) => listedTokenAsset(t))];
}
