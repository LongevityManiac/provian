/**
 * a swap is quoted for exactly the token AND chain the user picked.
 *
 * The defect (verified live 2026-09-27): the screen routed a pair to LI.FI only when a side was
 * Solana, and otherwise called SwapService.getQuote(fromChain, fromSymbol, toSymbol, …) — dropping
 * the destination chain. 0x then resolved the buy token by symbol on the SOURCE chain:
 * - USDC on Base → ETH on Arbitrum came back as a real Base USDC → Base ETH quote (and on a Base
 * fork it executed as one; nothing reached Arbitrum), shown as "ETH";
 * - USDC on Base → USDC on Arbitrum got 0x's 400 and a MOCK 1:1 "estimated rates" quote.
 *
 * These tests drive the one router the screen uses (swapQuoteRouter.quoteSwap) against the network
 * boundary only: the relay's LI.FI route (ProxyConfig.proxyFetch) and the relay's 0x route (fetch).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Asset } from '../../../store/walletStore';

const mocks = vi.hoisted(() => ({ proxyFetch: vi.fn(), fetch: vi.fn() }));
vi.mock('../../../services/ProxyConfig', () => ({
    default: {
        proxyFetch: mocks.proxyFetch,
        getZeroXUrl: vi.fn(async (endpoint: string) => `https://relay.test/api/proxy/zerox/${endpoint}`),
        getProxyHeaders: vi.fn(async () => ({ Authorization: 'Bearer t' })),
    },
}));
vi.mock('../../network/apiFetch', () => ({ apiFetch: vi.fn(), default: vi.fn() }));
vi.mock('../../wallet/SeedManager', () => ({ default: {} }));
vi.mock('../../chains/solana/SolanaRpc', () => ({ default: { getAccountInfoDirect: vi.fn(async () => null) } }));
vi.mock('../../AppModeManager', () => ({ assertWalletEnabled: vi.fn() }));
vi.mock('../../simulation/SimulationEngine', () => ({ default: {} }));
vi.mock('../../provenance/ProvenanceEnvelopeManager', () => ({ default: {} }));

import { quoteSwap } from '../swapQuoteRouter';
import SwapService from '../SwapService';
import SwapEngine from '../SwapEngine';

interface ZeroXFixture { taker: string; buyToken: string; buyAmount: string; sellAmount: string; fees: { integratorFee: { amount: string } }; transaction: { to: string; data: string } }
const ZEROX: ZeroXFixture[] = JSON.parse(readFileSync(join(__dirname, '..', '__fixtures__', 'evm-route-fixtures.json'), 'utf8')).zerox;
const [ethToUsdcBase, usdcToWethBase] = ZEROX;
const TAKER = usdcToWethBase.taker;
const SOL_ADDR = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

const evm = (chain: 'Base' | 'Arbitrum' | 'Optimism', symbol: 'ETH' | 'USDC'): Asset => {
    const chainId = { Base: 8453, Arbitrum: 42161, Optimism: 10 }[chain];
    const usdc = { Base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', Arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', Optimism: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85' }[chain];
    return symbol === 'ETH'
        ? { symbol, name: 'Ethereum', balance: '0', price: 0, chain, chainId, decimals: 18 }
        : { symbol, name: 'USD Coin', balance: '0', price: 1, chain, chainId, tokenAddress: usdc, decimals: 6, isStablecoin: true };
};

/** A relay 0x answer (real Base quote, relay fee attached) — what 0x returns for a Base pair. */
function zeroxAnswer(f: ZeroXFixture) {
    return { ok: true, status: 200, json: async () => ({ ...f, provian_fee: { bps: 25, amount: f.fees.integratorFee.amount, token: f.buyToken } }) };
}
const zeroxError = { ok: false, status: 400, json: async () => ({ name: 'TOKEN_NOT_SUPPORTED' }) };
const lifiNoRoute = { ok: false, status: 404, json: async () => ({ message: 'No available quotes for the requested transfer' }) };

const zeroxCalls = () => mocks.fetch.mock.calls.filter((c) => String(c[0]).includes('/zerox/'));
const lifiQuery = (): URLSearchParams | null => {
    const call = mocks.proxyFetch.mock.calls.find((c) => c[0] === 'lifi');
    return call ? new URLSearchParams(String(call[1]).split('?')[1]) : null;
};

beforeEach(() => {
    mocks.proxyFetch.mockReset();
    mocks.fetch.mockReset();
    vi.stubGlobal('fetch', mocks.fetch);
    SwapEngine.stopQuoteCleanup();
});
afterEach(() => vi.unstubAllGlobals());

describe('a pick across EVM chains is never a same-chain 0x swap', () => {
    it('RED: USDC on Base → ETH on Arbitrum is asked of LI.FI for Arbitrum; 0x (which would quote Base USDC → Base ETH) is never called', async () => {
        mocks.fetch.mockResolvedValue(zeroxAnswer(usdcToWethBase)); // what the old path got back
        mocks.proxyFetch.mockResolvedValue(lifiNoRoute);
        const q = await quoteSwap({ fromAsset: evm('Base', 'USDC'), toAsset: evm('Arbitrum', 'ETH'), amount: '10', slippage: 0.5, evmAddress: TAKER, solanaAddress: SOL_ADDR });
        expect(zeroxCalls()).toHaveLength(0);
        const lifi = lifiQuery();
        expect(lifi?.get('fromChain')).toBe('8453');
        expect(lifi?.get('toChain')).toBe('42161');
        expect(lifi?.get('toToken')).toBe('0x0000000000000000000000000000000000000000'); // native ETH on Arbitrum
        expect(lifi?.get('toAddress')).toBe(TAKER);
        // No LI.FI route → no quote. Never a Base quote shown as "ETH".
        expect(q).toBeNull();
    });

    it('RED: USDC on Base → USDC on Arbitrum never produces a mock "estimated" price', async () => {
        mocks.fetch.mockResolvedValue(zeroxError); // 0x refuses a same-token pair: the old path's mock trigger
        mocks.proxyFetch.mockResolvedValue(lifiNoRoute);
        const q = await quoteSwap({ fromAsset: evm('Base', 'USDC'), toAsset: evm('Arbitrum', 'USDC'), amount: '10', slippage: 0.5, evmAddress: TAKER, solanaAddress: SOL_ADDR });
        expect(q).toBeNull();
        expect(zeroxCalls()).toHaveLength(0);
        expect(lifiQuery()?.get('toChain')).toBe('42161');
    });

    for (const [from, to] of [['Base', 'Arbitrum'], ['Base', 'Optimism'], ['Arbitrum', 'Base'], ['Arbitrum', 'Optimism'], ['Optimism', 'Base'], ['Optimism', 'Arbitrum']] as const) {
        for (const [sell, buy] of [['ETH', 'ETH'], ['ETH', 'USDC'], ['USDC', 'ETH'], ['USDC', 'USDC']] as const) {
            it(`${sell} on ${from} → ${buy} on ${to}: LI.FI for the destination chain, never 0x`, async () => {
                mocks.fetch.mockResolvedValue(zeroxError);
                mocks.proxyFetch.mockResolvedValue(lifiNoRoute);
                await quoteSwap({ fromAsset: evm(from, sell), toAsset: evm(to, buy), amount: sell === 'ETH' ? '0.01' : '10', slippage: 0.5, evmAddress: TAKER, solanaAddress: SOL_ADDR });
                expect(zeroxCalls()).toHaveLength(0);
                const lifi = lifiQuery();
                expect(lifi?.get('fromChain')).toBe(String(evm(from, sell).chainId));
                expect(lifi?.get('toChain')).toBe(String(evm(to, buy).chainId));
                expect(lifi?.get('toToken')).toBe(buy === 'ETH' ? '0x0000000000000000000000000000000000000000' : evm(to, 'USDC').tokenAddress);
            });
        }
    }
});

describe('same-chain EVM stays on 0x, and 0x never returns a mock', () => {
    it('ETH → USDC on Base is a live 0x quote for Base (LI.FI is not asked)', async () => {
        mocks.fetch.mockResolvedValue(zeroxAnswer(ethToUsdcBase));
        const q = await quoteSwap({ fromAsset: evm('Base', 'ETH'), toAsset: evm('Base', 'USDC'), amount: '0.01', slippage: 0.5, evmAddress: TAKER, solanaAddress: SOL_ADDR });
        expect(q).not.toBeNull();
        expect(q!.isMock).toBeFalsy();
        expect(q!.provider).toBe('0x');
        expect(new URL(String(zeroxCalls()[0][0])).searchParams.get('chainId')).toBe('8453');
        expect(mocks.proxyFetch).not.toHaveBeenCalled();
    });

    it('RED: a 0x failure (400, no liquidity, no relay fee, network error) is no quote — never a mock price', async () => {
        const base = { fromAsset: evm('Base', 'ETH'), toAsset: evm('Base', 'USDC'), amount: '0.01', slippage: 0.5, evmAddress: TAKER, solanaAddress: SOL_ADDR };
        for (const answer of [
            zeroxError,
            { ok: true, status: 200, json: async () => ({ liquidityAvailable: false }) },
            { ok: true, status: 200, json: async () => ({ ...ethToUsdcBase }) }, // no provian_fee
        ]) {
            mocks.fetch.mockResolvedValueOnce(answer);
            expect(await quoteSwap(base)).toBeNull();
        }
        mocks.fetch.mockRejectedValueOnce(new Error('offline'));
        expect(await quoteSwap(base)).toBeNull();
    });
});

describe('defence in depth: 0x refuses a destination on another chain', () => {
    it('RED: SwapService.getQuote with the destination on Arbitrum is null and never reaches 0x', async () => {
        mocks.fetch.mockResolvedValue(zeroxAnswer(usdcToWethBase));
        expect(await SwapService.getQuote('Base', 'USDC', 'ETH', '10', 0.5, TAKER, 'Arbitrum')).toBeNull();
        expect(zeroxCalls()).toHaveLength(0);
    });

    it('RED: a symbol-only call that names no destination chain never reaches 0x', async () => {
        mocks.fetch.mockResolvedValue(zeroxAnswer(usdcToWethBase));
        const symbolOnly = SwapEngine.getQuote as unknown as (...a: unknown[]) => Promise<unknown>;
        expect(await symbolOnly.call(SwapEngine, 'Base', 'USDC', 'ETH', '10', 0.5, TAKER)).toBeNull();
        expect(zeroxCalls()).toHaveLength(0);
    });

    it('control: the same call naming Base as the destination does reach 0x', async () => {
        mocks.fetch.mockResolvedValue(zeroxAnswer(ethToUsdcBase));
        expect(await SwapService.getQuote('Base', 'ETH', 'USDC', '0.01', 0.5, TAKER, 'Base')).not.toBeNull();
        expect(zeroxCalls()).toHaveLength(1);
    });
});
