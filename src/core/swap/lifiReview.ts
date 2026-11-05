/**
 * The review a LI.FI route is checked against, built from what the user asked for — never from
 * the relay's estimate. Pure: no React Native, no network, no key, so the app
 * (CrossChainSwapEngine) and the fork proof (scripts/evm-crosschain-fork-proof.ts) build the
 * expectation with the same code.
 */

import { ethers } from 'ethers';
import { PublicKey } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { TOKEN_ADDRESSES } from '../chains/evm/config';
import type { Asset } from '../../store/walletStore';
import { SwapRouteRefusedError, bytes32Of, type LifiEvmSourceExpectation } from './evmSwapGuard';

export const LIFI_SOLANA_CHAIN_ID = 1151111081099710;
export const SOLANA_NATIVE_LIFI = '11111111111111111111111111111111';
export const EVM_NATIVE_LIFI = '0x0000000000000000000000000000000000000000';
/** Jupiter names native SOL by the wrapped-SOL mint. */
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/** What a review is built from: the pair, the amount entered, the slippage, this wallet. */
export interface LifiReviewParams {
    fromAsset: Asset;
    toAsset: Asset;
    amount: string;
    /** Percent, e.g. 0.5. */
    slippage: number;
    evmAddress: string;
    solanaAddress: string;
}

export function lifiChainId(asset: Asset): number {
    switch (asset.chain) {
        case 'Base': return 8453;
        case 'Arbitrum': return 42161;
        case 'Optimism': return 10;
        case 'Solana': return LIFI_SOLANA_CHAIN_ID;
        default: throw new Error(`Unsupported swap chain: ${asset.chain}`);
    }
}

export function lifiTokenAddress(asset: Asset): string {
    if (asset.chain === 'Solana') {
        if (asset.symbol === 'SOL' && !asset.tokenAddress) return SOLANA_NATIVE_LIFI;
        if (!asset.tokenAddress) throw new Error(`Missing SPL mint for ${asset.symbol}`);
        return asset.tokenAddress;
    }
    // EVM
    if (asset.symbol === 'ETH' && !asset.tokenAddress) return EVM_NATIVE_LIFI;
    if (!asset.tokenAddress) throw new Error(`Missing token address for ${asset.symbol}`);
    return asset.tokenAddress;
}

/** Native ETH on an EVM chain (no token contract). */
export function isNativeEvm(asset: Asset): boolean {
    return asset.symbol === 'ETH' && !asset.tokenAddress;
}

export function jupiterMint(asset: Asset): string {
    if (asset.symbol === 'SOL' && !asset.tokenAddress) return WSOL_MINT;
    if (!asset.tokenAddress) throw new Error(`Missing SPL mint for ${asset.symbol}`);
    return asset.tokenAddress;
}

export function decimalsFor(asset: Asset): number {
    if (typeof asset.decimals === 'number') return asset.decimals;
    if (asset.symbol === 'SOL') return 9;
    if (asset.symbol === 'ETH' || asset.symbol === 'WETH') return 18;
    if (asset.isStablecoin) return 6;
    return 18;
}

export function toAtomic(amount: string, decimals: number): string {
    // ethers.parseUnits is integer-safe and rejects malformed input.
    return ethers.parseUnits(amount, decimals).toString();
}

/** Decimals of the EVM tokens a Mayan order may take as input, by lowercase address. */
export function evmTokenDecimals(chainId: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [symbol, address] of Object.entries(TOKEN_ADDRESSES[chainId] ?? {})) {
        out[address.toLowerCase()] = symbol === 'DAI' || symbol === 'WETH' ? 18 : 6;
    }
    return out;
}

/** A Solana public key or mint as 0x + 64 hex (Mayan's bytes32 form). */
export function solanaKeyWord(base58: string): string {
    return '0x' + Buffer.from(new PublicKey(base58).toBytes()).toString('hex');
}

export const ZERO_WORD = '0x' + '0'.repeat(64);

/**
 * An EVM asset the wallet can bridge, resolved against the canonical token table, never against
 * the asset list: native ETH, or a token whose address is in TOKEN_ADDRESSES for its own chain
 * (, Unknown = Block). Decimals come from the same table (USDC / USDC.e / USDT 6, DAI / WETH
 * 18), never from the asset object.
 */
export interface CanonicalEvmAsset {
    chainId: number;
    /** 'native' for ETH, else the token's address on `chainId`. */
    token: 'native' | string;
    decimals: number;
}
export function canonicalEvmAsset(asset: Asset): CanonicalEvmAsset | null {
    if (asset.chain === 'Solana') return null;
    const chainId = lifiChainId(asset);
    if (isNativeEvm(asset)) return { chainId, token: 'native', decimals: 18 };
    if (!asset.tokenAddress) return null;
    const entry = Object.entries(TOKEN_ADDRESSES[chainId] ?? {})
        .find(([, address]) => address.toLowerCase() === asset.tokenAddress!.toLowerCase());
    if (!entry) return null;
    return { chainId, token: entry[1], decimals: entry[0] === 'DAI' || entry[0] === 'WETH' ? 18 : 6 };
}

/**
 * What an EVM-source LI.FI transaction must do, from what the user asked for (never from the
 * relay's estimate): spend exactly the amount entered, send its value only for native ETH, and
 * pay this wallet — its Solana key, or its own EVM address on the EVM chain picked — the
 * reviewed token at least the reviewed minimum.
 */
export type EvmReviewed = Pick<LifiEvmSourceExpectation, 'minOutAtomic' | 'provianFee' | 'lifiFee' | 'toAmountAtomic'>;

/**
 * The slippage the review displays, in basis points, rounded DOWN: a fractional basis point never
 * loosens the minimum the bridge order must meet (round 3).
 */
export function displayedBps(slippagePercent: number): number {
    return Math.floor(slippagePercent * 100 + 1e-9);
}
export function evmSourceExpectation(params: LifiReviewParams, txValue: string | undefined, reviewed: EvmReviewed): LifiEvmSourceExpectation {
    const source = canonicalEvmAsset(params.fromAsset);
    if (!source) throw new SwapRouteRefusedError('lifi_wrong_sell_token', 'source token is not one this wallet knows on its chain');
    if (txValue !== undefined && !/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(txValue)) {
        throw new SwapRouteRefusedError('lifi_wrong_value', 'transaction value is malformed');
    }
    let destination: LifiEvmSourceExpectation['destination'];
    let destToken: string;
    let destDecimals: number;
    if (params.toAsset.chain === 'Solana') {
        const toSol = params.toAsset.symbol === 'SOL' && !params.toAsset.tokenAddress;
        destination = { kind: 'solana', solanaReceiver: solanaKeyWord(params.solanaAddress) };
        destToken = toSol ? ZERO_WORD : solanaKeyWord(jupiterMint(params.toAsset));
        destDecimals = decimalsFor(params.toAsset);
    } else {
        // the token picked, on the chain picked — resolved from the canonical table.
        const target = canonicalEvmAsset(params.toAsset);
        if (!target) throw new SwapRouteRefusedError('lifi_wrong_buy_token', 'destination token is not one this wallet knows on its chain');
        if (target.chainId === source.chainId) throw new SwapRouteRefusedError('lifi_same_chain', 'same-chain swaps are not bridged');
        destination = { kind: 'evm', chainId: target.chainId };
        destToken = target.token === 'native' ? ZERO_WORD : bytes32Of(target.token);
        destDecimals = target.decimals;
    }
    return {
        sellToken: source.token,
        sellAmount: BigInt(toAtomic(params.amount, source.decimals)),
        value: txValue ? BigInt(txValue) : 0n,
        evmAddress: params.evmAddress,
        destination,
        destToken,
        destDecimals,
        minOutAtomic: reviewed.minOutAtomic,
        provianFee: reviewed.provianFee,
        lifiFee: reviewed.lifiFee,
        slippageBps: displayedBps(params.slippage),
        toAmountAtomic: reviewed.toAmountAtomic,
    };
}
