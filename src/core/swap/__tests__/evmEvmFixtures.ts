/**
 * live LI.FI EVM → EVM captures (__fixtures__/evm-evm-route-fixtures.json, written by
 * scripts/evm-crosschain-fork-proof.ts --capture with the relay's exact query) and the pieces the
 * tests build from them: the wallet assets picked, and the answer the relay returns for a capture.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOKEN_ADDRESSES } from '../../chains/evm/config';
import type { Asset } from '../../../store/walletStore';

export type EvmChainId = 8453 | 42161 | 10;
export interface EvmEvmCapture {
    pair: string;
    extra: boolean;
    capturedAt: string;
    sourceChainId: EvmChainId;
    destChainId: EvmChainId;
    sell: string;
    buy: string;
    amount: string;
    request: Record<string, string>;
    blockBefore: number;
    status: number;
    message?: string;
    quote?: {
        id?: string;
        tool?: string;
        estimate: {
            fromAmount: string; toAmount: string; toAmountMin: string; approvalAddress?: string;
            feeCosts: Array<{ name?: string; amount?: string; amountUSD?: string; included?: boolean; feeSplit?: unknown }>;
            gasCosts: Array<{ amountUSD?: string }>;
        };
        transactionRequest: { to: string; data: string; value: string; chainId: number; gasLimit?: string };
    };
    relay?: { provianFee: string; lifiFee: string } | { refused: string };
}
export interface EvmEvmFixtureFile {
    user: string;
    slippagePercent: number;
    forkBlocks: Partial<Record<EvmChainId, number>>;
    captures: EvmEvmCapture[];
}

export const EVM_EVM: EvmEvmFixtureFile = JSON.parse(
    readFileSync(join(__dirname, '..', '__fixtures__', 'evm-evm-route-fixtures.json'), 'utf8'),
);

const CHAIN_NAME: Record<EvmChainId, 'Base' | 'Arbitrum' | 'Optimism'> = { 8453: 'Base', 42161: 'Arbitrum', 10: 'Optimism' };

/** The wallet asset for a symbol on a chain, as BalanceService lists it. */
export function assetOf(chain: EvmChainId, symbol: string): Asset {
    const tokenAddress = symbol === 'ETH' ? undefined : TOKEN_ADDRESSES[chain][symbol];
    if (symbol !== 'ETH' && !tokenAddress) throw new Error(`${symbol} is not listed on ${chain}`);
    const decimals = symbol === 'ETH' || symbol === 'DAI' || symbol === 'WETH' ? 18 : 6;
    return { symbol, name: symbol, balance: '0', price: 0, chain: CHAIN_NAME[chain], chainId: chain, tokenAddress, decimals };
}

/** The 24 required pairs (ETH / USDC in and out, all six directions) that LI.FI quoted. */
export const REQUIRED = EVM_EVM.captures.filter((c) => !c.extra);

export function relayFees(c: EvmEvmCapture): { provianFee: string; lifiFee: string } {
    if (!c.relay || 'refused' in c.relay) throw new Error(`${c.pair}: the relay refused this quote`);
    return c.relay;
}

/** What the relay's /api/proxy/lifi/quote returns for a capture: LI.FI's answer plus the verified fees. */
export function relayAnswer(c: EvmEvmCapture) {
    const fees = relayFees(c);
    return {
        // A deep copy: a test that edits the cached route must never edit the shared capture.
        ...structuredClone(c.quote!),
        provian_fee: { bps: 25, amount: fees.provianFee },
        lifi_fee: { amount: fees.lifiFee },
    };
}
