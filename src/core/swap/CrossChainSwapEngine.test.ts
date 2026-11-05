/**
 * CrossChainSwapEngine — relay request building, fee parsing, and fail-closed
 * behaviour for both Solana-leg routes:
 *   Solana ⇄ EVM    → LI.FI   via the relay's GET  /api/proxy/lifi/quote
 *   Solana ⇄ Solana → Jupiter via the relay's POST /api/proxy/jupiter/order
 * Mocks only the network boundary (ProxyConfig.proxyFetch). The app never calls
 * li.quest or jup.ag directly and never sends a fee field: the relay sets it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Buffer } from 'buffer';
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { createSyncNativeInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { Asset } from '../../store/walletStore';

const mocks = vi.hoisted(() => ({
    proxyFetch: vi.fn(),
    apiFetch: vi.fn(),
}));
vi.mock('../../services/ProxyConfig', () => ({ default: { proxyFetch: mocks.proxyFetch } }));
vi.mock('../network/apiFetch', () => ({ apiFetch: mocks.apiFetch, default: mocks.apiFetch }));
// Keep these off the import graph for a pure quote test.
vi.mock('../wallet/SeedManager', () => ({ default: {} }));
// The signing guard reads lookup tables from the public cluster; these transactions load none.
vi.mock('../chains/solana/SolanaRpc', () => ({ default: { getAccountInfoDirect: vi.fn(async () => null) } }));
vi.mock('../AppModeManager', () => ({ assertWalletEnabled: vi.fn() }));

import engine from './CrossChainSwapEngine';
import { jupiterSwapTxBase64 } from './__tests__/jupiterRouteIx';
import { evmWord, lifiSwiftTxBase64 } from './__tests__/swiftOrderIx';
import { EVM_EVM, REQUIRED, assetOf, relayAnswer, type EvmEvmCapture } from './__tests__/evmEvmFixtures';
import { captureSec, evmSwiftDeadline, nowBefore } from './__tests__/swiftClock';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOL: Asset = { symbol: 'SOL', name: 'Solana', balance: '1', price: 150, chain: 'Solana', decimals: 9 };
const USDC_SOL: Asset = {
    symbol: 'USDC', name: 'USD Coin', balance: '100', price: 1, chain: 'Solana',
    tokenAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, isStablecoin: true,
};
const USDC_BASE: Asset = {
    symbol: 'USDC', name: 'USD Coin', balance: '100', price: 1, chain: 'Base',
    chainId: 8453, tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, isStablecoin: true,
};
const BONK: Asset = {
    symbol: 'BONK', name: 'Bonk', balance: '0', price: 0.0000036, chain: 'Solana',
    tokenAddress: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', decimals: 5,
};
const JUP: Asset = {
    symbol: 'JUP', name: 'Jupiter', balance: '0', price: 0.33, chain: 'Solana',
    tokenAddress: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', decimals: 6,
};
const WSOL = 'So11111111111111111111111111111111111111112';
const EVM_ADDR = '0x552008c0f6870c2f77e5cC1d2eb9bdff03e30Ea0';

/** A relay `solana_costs` object whose totals add up the way the relay computes them. */
function solanaCosts(o: Partial<Record<'network' | 'receiving' | 'treasury' | 'temporary' | 'other' | 'swapped' | 'balance', bigint>> = {}, measured = true) {
    const c = { network: 15000n, receiving: 0n, treasury: 0n, temporary: 0n, other: 0n, swapped: 0n, balance: 1_000_000_000n, ...o };
    const rentMin = 650_240n;
    const spend = c.network + c.receiving + c.treasury + c.other + c.swapped;
    const required = spend + (c.temporary > rentMin ? c.temporary : rentMin);
    const leftover = c.balance - spend - c.temporary;
    const sufficient = leftover >= 0n && (leftover === 0n || leftover >= rentMin);
    return {
        network_fee_lamports: String(c.network), receiving_account_lamports: String(c.receiving),
        treasury_fee_account_lamports: String(c.treasury), temporary_account_lamports: String(c.temporary),
        other_accounts_lamports: String(c.other), sol_swapped_lamports: String(c.swapped),
        spend_lamports: String(spend), required_lamports: String(required), balance_lamports: String(c.balance),
        rent_exempt_minimum_lamports: String(rentMin), sufficient,
        shortfall_lamports: String(sufficient ? 0n : required - c.balance), measured,
    };
}
const SOL_ADDR = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const LIFI_DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE';
interface EvmLifiFixture {
    source: string; expect: string;
    transactionRequest: { to: string; data: string; value: string; chainId: number };
    review: { evmAddress: string; minOutAtomic: string; provianFee: string; lifiFee: string; sellAmount: string; toAmountAtomic: string };
}
const EVM_LIFI: EvmLifiFixture[] = JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'evm-route-fixtures.json'), 'utf8')).lifi;

/**
 * An unsigned LI.FI transaction the signing guard accepts: paid by SOL_ADDR, wrapping its
 * own SOL, placing one Mayan Swift v2 order to EVM_ADDR on Base for USDC at the reviewed minimum —
 * so these quote tests exercise the fee/cost parsing and not the guard (its own suite covers it).
 */
const signableTx = (mintFrom: string, amountOutMin: bigint, evmAddress = EVM_ADDR) => lifiSwiftTxBase64({
    user: new PublicKey(SOL_ADDR), mintFrom, evmAddress, wormholeChain: 30,
    tokenOutWord: evmWord(USDC_BASE.tokenAddress!), amountInMin: 1n, amountOutMin,
}, [], mintFrom === WSOL
    // The route's fee transfers ( : Provian's 25 bps must be paid): 1 SOL or 20 USDC sent.
    ? { provian: 2_500_000n, lifi: 2_500_000n }
    : { provian: 50_000n, lifi: 50_000n, mint: mintFrom, decimals: 6 });
const SIGNABLE_TX = signableTx(WSOL, 11_890_250n); // floor(11_950_000 × 9950 / 10000)

function lifiResponse(overrides: Record<string, unknown> = {}) {
    return {
        ok: true,
        json: async () => ({
            id: 'quote-123',
            tool: 'mayan',
            estimate: {
                fromAmount: '1000000000',
                toAmount: '11950000',
                toAmountMin: '11890250',
                approvalAddress: '0xBRIDGE',
                gasCosts: [{ amountUSD: '0.01' }],
                feeCosts: [
                    { name: 'LIFI Fixed Fee', amount: '5000000', amountUSD: '0.75', feeSplit: { lifiFee: '2500000', integratorFee: '2500000' } },
                    { name: 'NearIntents Protocol Fee', amount: '1990', amountUSD: '0.02' },
                ],
            },
            transactionRequest: { data: SIGNABLE_TX, chainId: 1151111081099710 },
            provian_fee: { bps: 25, amount: '2500000' },
            lifi_fee: { amount: '2500000' },
            solana_costs: solanaCosts({ swapped: 1_000_000_000n, balance: 2_000_000_000n }),
            ...overrides,
        }),
    };
}

/**
 * A relay Jupiter order. Its transaction is built, as the relay builds it, from the order the
 * engine sent (pair, amount, slippage) and the quote's outAmount — the one Jupiter swap the
 * guard requires of a Jupiter route.
 */
function jupiterResponse(overrides: Record<string, unknown> = {}) {
    const quote = (overrides.quote as { outAmount: string } | undefined) ?? {
        inAmount: '100000000',
        outAmount: '12037241',
        otherAmountThreshold: '11977055',
        priceImpactPct: '0.0001',
        routePlan: [{ swapInfo: { label: 'BisonFi' } }],
    };
    return {
        ok: true,
        json: async () => ({
            quote,
            swapTransaction: (() => {
                const calls = mocks.proxyFetch.mock.calls;
                const order = JSON.parse((calls[calls.length - 1] as [string, string, { body: string }])[2].body) as {
                    userPublicKey: string; inputMint: string; outputMint: string; amount: string; slippageBps: number;
                };
                return jupiterSwapTxBase64({
                    user: new PublicKey(order.userPublicKey), inputMint: order.inputMint, outputMint: order.outputMint,
                    inAmount: BigInt(order.amount), outAmount: BigInt(quote.outAmount), slippageBps: order.slippageBps,
                });
            })(),
            lastValidBlockHeight: 1,
            prioritizationFeeLamports: 10000,
            provian_fee: { bps: 25, amount: '30168', side: 'output', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
            solana_costs: solanaCosts({ swapped: 100_000_000n, temporary: 2_039_280n }),
            ...overrides,
        }),
    };
}

beforeEach(() => {
    mocks.proxyFetch.mockReset();
    mocks.apiFetch.mockReset();
});
afterEach(() => {
    vi.useRealTimers();
});

/**
 * Run at the moment a live capture was taken ( ): the Swift order's deadline
 * is checked against the clock, so a live quote is only valid within its hour.
 */
function atMoment(unixSec: number): void {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(unixSec * 1000);
}

describe('CrossChainSwapEngine — LI.FI (Solana ⇄ EVM) through the relay', () => {
    it('calls the relay LI.FI route (never li.quest) with routing fields only, no fee fields', async () => {
        mocks.proxyFetch.mockResolvedValue(lifiResponse());
        await engine.getQuote({
            fromAsset: SOL, toAsset: USDC_BASE, amount: '1', slippage: 0.5,
            evmAddress: EVM_ADDR, solanaAddress: SOL_ADDR,
        });
        expect(mocks.apiFetch).not.toHaveBeenCalled();
        const [service, path] = mocks.proxyFetch.mock.calls[0] as [string, string];
        expect(service).toBe('lifi');
        const q = new URLSearchParams(path.split('?')[1]);
        expect(path.startsWith('quote?')).toBe(true);
        expect(q.get('fromChain')).toBe('1151111081099710'); // Solana
        expect(q.get('toChain')).toBe('8453'); // Base
        expect(q.get('fromToken')).toBe('11111111111111111111111111111111'); // native SOL
        expect(q.get('fromAmount')).toBe('1000000000'); // 1 SOL @ 9dp
        expect(q.get('fromAddress')).toBe(SOL_ADDR);
        expect(q.get('toAddress')).toBe(EVM_ADDR);
        expect(q.get('slippage')).toBe('0.005');
        expect(q.has('fee')).toBe(false);
        expect(q.has('integrator')).toBe(false);
    });

    it('shows the relay-verified Provian fee, LI.FI\'s own fee, and bridge fees each under its own name', async () => {
        mocks.proxyFetch.mockResolvedValue(lifiResponse());
        const q = await engine.getQuote({
            fromAsset: SOL, toAsset: USDC_BASE, amount: '1', slippage: 0.5,
            evmAddress: EVM_ADDR, solanaAddress: SOL_ADDR,
        });
        expect(q).not.toBeNull();
        expect(q!.crossChain).toBe(true);
        expect(q!.provianFee).toBe('0.0025'); // 2_500_000 lamports = 0.0025 SOL = 25 bps of 1 SOL
        expect(q!.provianFeeToken).toBe('SOL'); // taken from the tokens sent
        expect(q!.otherFees).toEqual([
            { kind: 'lifi', amount: '0.0025', token: 'SOL' },
            { kind: 'bridge', usd: 0.02 },
        ]);
        expect(q!.toAmount).toBe('11.95');
        expect(q!.netToAmount).toBe('11.95'); // LI.FI toAmount is already net of every fee
        expect(q!.guaranteedAmount).toBe('11.89025'); // the order's enforced minimum
        // A Solana-source swap shows its network fee in SOL as the relay measured it.
        expect(q!.fee).toBe('0.000015');
        expect(q!.feeToken).toBe('SOL');
        expect(q!.solanaCosts?.lamports.swapped).toBe('1000000000');
        expect(q!.provider).toContain('lifi');
    });

    it('FAIL CLOSED: a quote without the relay-verified Provian fee is never shown', async () => {
        mocks.proxyFetch.mockResolvedValue(lifiResponse({ provian_fee: undefined }));
        const q = await engine.getQuote({
            fromAsset: SOL, toAsset: USDC_BASE, amount: '1', slippage: 0.5,
            evmAddress: EVM_ADDR, solanaAddress: SOL_ADDR,
        });
        expect(q).toBeNull();
    });

    it('FAIL CLOSED: returns null on no route / relay refusal', async () => {
        mocks.proxyFetch.mockResolvedValue({ ok: false, json: async () => ({}) });
        const q = await engine.getQuote({
            fromAsset: SOL, toAsset: USDC_BASE, amount: '1', slippage: 0.5,
            evmAddress: EVM_ADDR, solanaAddress: SOL_ADDR,
        });
        expect(q).toBeNull();
    });

    it('FAIL CLOSED: returns null when a required chain address is missing', async () => {
        mocks.proxyFetch.mockResolvedValue(lifiResponse());
        const q = await engine.getQuote({
            fromAsset: SOL, toAsset: USDC_BASE, amount: '1', slippage: 0.5,
            evmAddress: '', solanaAddress: SOL_ADDR, // no EVM dest address
        });
        expect(q).toBeNull();
        expect(mocks.proxyFetch).not.toHaveBeenCalled();
    });

    it('FAIL CLOSED: returns null when the response has no transactionRequest', async () => {
        mocks.proxyFetch.mockResolvedValue(lifiResponse({ transactionRequest: undefined }));
        const q = await engine.getQuote({
            fromAsset: SOL, toAsset: USDC_BASE, amount: '1', slippage: 0.5,
            evmAddress: EVM_ADDR, solanaAddress: SOL_ADDR,
        });
        expect(q).toBeNull();
    });
});

describe('CrossChainSwapEngine — LI.FI cost labelling', () => {
    it('a Solana rent deposit is never folded into "Bridge Fees"; on a Solana source it is a named SOL cost', async () => {
        // feeCosts as LI.FI returned them for Solana 20 USDC → Base USDC on 2026-09-25.
        mocks.proxyFetch.mockResolvedValue(lifiResponse({
            estimate: {
                fromAmount: '20000000', toAmount: '19893772', toAmountMin: '19794303',
                gasCosts: [{ amountUSD: '0.0010' }],
                feeCosts: [
                    { name: 'LIFI Fixed Fee', amount: '100000', amountUSD: '0.1004', included: true, feeSplit: { lifiFee: '50000', integratorFee: '50000' } },
                    { name: 'Rent Exemption Deposit', amount: '1488440', amountUSD: '0.1775', included: false },
                    { name: 'NearIntents Protocol Fee', amount: '1990', amountUSD: '0.0020', included: true },
                    { name: '1ClickSwap API Fee', amount: '1990', amountUSD: '0.0020', included: true },
                    { name: 'NearIntents App Fee', amount: '3980', amountUSD: '0.0040', included: true },
                ],
            },
            transactionRequest: { data: signableTx(USDC_SOL.tokenAddress!, 19_794_303n), chainId: 1151111081099710 },
            provian_fee: { bps: 25, amount: '50000' },
            lifi_fee: { amount: '50000' },
            solana_costs: solanaCosts({ other: 1_488_440n }),
        }));
        const q = await engine.getQuote({
            fromAsset: USDC_SOL, toAsset: USDC_BASE, amount: '20', slippage: 0.5,
            evmAddress: EVM_ADDR, solanaAddress: SOL_ADDR,
        });
        expect(q!.provianFee).toBe('0.05');
        expect(q!.provianFeeToken).toBe('USDC');
        const kinds = q!.otherFees.map((c) => c.kind);
        // The relay's SOL costs name the deposit exactly; the USD row is not shown twice.
        expect(kinds).toEqual(['lifi', 'bridge']);
        expect(q!.otherFees.find((c) => c.kind === 'bridge')!.usd).toBeCloseTo(0.008); // solver fees only
        expect(q!.solanaCosts!.lamports.other).toBe('1488440');
    });

    it('an EVM-source swap (no Solana costs) keeps the rent row in USD', async () => {
        // The real Base USDC → Solana USDC LI.FI answer (Mayan Swift v2, 2026-09-27).
        const real = EVM_LIFI.find((f) => f.source.includes('none-8453-usdc-to-usdc'))!;
        atMoment(nowBefore(evmSwiftDeadline(real.transactionRequest.data)));
        mocks.proxyFetch.mockResolvedValue(lifiResponse({
            transactionRequest: real.transactionRequest,
            estimate: {
                approvalAddress: LIFI_DIAMOND,
                fromAmount: '20000000', toAmount: '19893772', toAmountMin: real.review.minOutAtomic,
                feeCosts: [{ name: 'Rent Exemption Deposit', amount: '1488440', amountUSD: '0.1775', included: false }],
            },
            provian_fee: { bps: 25, amount: real.review.provianFee },
            lifi_fee: { amount: real.review.lifiFee },
            solana_costs: undefined,
        }));
        const q = await engine.getQuote({
            fromAsset: USDC_BASE, toAsset: USDC_SOL, amount: '20', slippage: 0.5,
            evmAddress: real.review.evmAddress, solanaAddress: SOL_ADDR,
        });
        expect(q!.solanaCosts).toBeUndefined();
        expect(q!.otherFees).toEqual([{ kind: 'lifi', amount: '0.05', token: 'USDC' }, { kind: 'rent', usd: 0.1775 }]);
    });

    it('RED: a Solana-source LI.FI quote without SOL costs, or with costs that do not add up, is not shown', async () => {
        mocks.proxyFetch.mockResolvedValue(lifiResponse({ solana_costs: undefined }));
        expect(await engine.getQuote({
            fromAsset: SOL, toAsset: USDC_BASE, amount: '1', slippage: 0.5, evmAddress: EVM_ADDR, solanaAddress: SOL_ADDR,
        })).toBeNull();
        mocks.proxyFetch.mockResolvedValue(lifiResponse({
            solana_costs: { ...solanaCosts({ swapped: 1_000_000_000n }), spend_lamports: '1' },
        }));
        expect(await engine.getQuote({
            fromAsset: SOL, toAsset: USDC_BASE, amount: '1', slippage: 0.5, evmAddress: EVM_ADDR, solanaAddress: SOL_ADDR,
        })).toBeNull();
    });
});

describe('CrossChainSwapEngine — Jupiter (Solana ⇄ Solana) through the relay', () => {
    it('same-chain Solana goes to the relay Jupiter route, never LI.FI, with no fee fields', async () => {
        mocks.proxyFetch.mockResolvedValue(jupiterResponse());
        await engine.getQuote({
            fromAsset: SOL, toAsset: USDC_SOL, amount: '0.1', slippage: 0.5,
            evmAddress: EVM_ADDR, solanaAddress: SOL_ADDR,
        });
        const [service, path, init] = mocks.proxyFetch.mock.calls[0] as [string, string, { method: string; body: string }];
        expect(service).toBe('jupiter');
        expect(path).toBe('order');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({
            inputMint: 'So11111111111111111111111111111111111111112',
            outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            amount: '100000000',
            slippageBps: 50,
            userPublicKey: SOL_ADDR,
        });
    });

    it('SOL→USDC: the fee is the relay-verified USDC amount; receive = outAmount', async () => {
        mocks.proxyFetch.mockResolvedValue(jupiterResponse());
        const q = await engine.getQuote({
            fromAsset: SOL, toAsset: USDC_SOL, amount: '0.1', slippage: 0.5,
            evmAddress: EVM_ADDR, solanaAddress: SOL_ADDR,
        });
        expect(q).not.toBeNull();
        expect(q!.provider).toBe('jupiter');
        expect(q!.provianFee).toBe('0.030168');
        expect(q!.provianFeeToken).toBe('USDC');
        expect(q!.otherFees).toEqual([]); // Jupiter charges no protocol fee
        expect(q!.netToAmount).toBe('12.037241');
        expect(q!.guaranteedAmount).toBe('11.977055');
        expect(q!.feeToken).toBe('SOL');
        expect(q!.fee).toBe('0.000015'); // the relay-measured network fee
        expect(q!.solanaCosts!.lamports.temporary).toBe('2039280');
    });

    it('USDC→SOL: the fee is taken from the USDC sent', async () => {
        mocks.proxyFetch.mockResolvedValue(jupiterResponse({
            quote: { inAmount: '20000000', outAmount: '165065524', otherAmountThreshold: '164240196' },
            provian_fee: { bps: 25, amount: '50000', side: 'input', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
        }));
        const q = await engine.getQuote({
            fromAsset: USDC_SOL, toAsset: SOL, amount: '20', slippage: 0.5,
            evmAddress: EVM_ADDR, solanaAddress: SOL_ADDR,
        });
        expect(q!.provianFee).toBe('0.05');
        expect(q!.provianFeeToken).toBe('USDC');
        expect(q!.netToAmount).toBe('0.165065524');
    });

    it('RED : an order whose transaction does not match its quote is never shown', async () => {
        const tx = (o: Partial<{ out: bigint; inAmt: bigint; slip: number; outMint: string }>) => jupiterSwapTxBase64({
            user: new PublicKey(SOL_ADDR), inputMint: WSOL, outputMint: o.outMint ?? USDC_SOL.tokenAddress!,
            inAmount: o.inAmt ?? 100_000_000n, outAmount: o.out ?? 12_037_241n, slippageBps: o.slip ?? 50,
        });
        const quoteWith = async (swapTransaction: string) => {
            mocks.proxyFetch.mockResolvedValue(jupiterResponse({ swapTransaction }));
            return engine.getQuote({
                fromAsset: SOL, toAsset: USDC_SOL, amount: '0.1', slippage: 0.5, evmAddress: EVM_ADDR, solanaAddress: SOL_ADDR,
            });
        };
        expect(await quoteWith(tx({}))).not.toBeNull(); // control: the matching transaction is shown
        expect(await quoteWith(tx({ out: 12_037_240n }))).toBeNull(); // promises less than the quote
        expect(await quoteWith(tx({ inAmt: 100_000_001n }))).toBeNull(); // sells more than asked
        expect(await quoteWith(tx({ slip: 51 }))).toBeNull(); // more slippage than chosen
        expect(await quoteWith(tx({ outMint: BONK.tokenAddress! }))).toBeNull(); // another token
    });

    it('FAIL CLOSED: no relay-verified fee, or a relay refusal, means no quote', async () => {
        mocks.proxyFetch.mockResolvedValue(jupiterResponse({ provian_fee: undefined }));
        expect(await engine.getQuote({
            fromAsset: SOL, toAsset: USDC_SOL, amount: '0.1', slippage: 0.5, evmAddress: EVM_ADDR, solanaAddress: SOL_ADDR,
        })).toBeNull();
        mocks.proxyFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({ code: 'solana_fee_account_uninitialized' }) });
        expect(await engine.getQuote({
            fromAsset: SOL, toAsset: USDC_SOL, amount: '0.1', slippage: 0.5, evmAddress: EVM_ADDR, solanaAddress: SOL_ADDR,
        })).toBeNull();
    });
});

describe('CrossChainSwapEngine — Jupiter non-USDC pairs ', () => {
    it('SOL→BONK: the fee is in SOL (the relay names wSOL), with the SOL costs by name', async () => {
        mocks.proxyFetch.mockResolvedValue(jupiterResponse({
            quote: { inAmount: '100000000', outAmount: '415000000000', otherAmountThreshold: '412925000000' },
            provian_fee: { bps: 25, amount: '250000', side: 'input', mint: WSOL },
            solana_costs: solanaCosts({ swapped: 99_750_000n, receiving: 2_039_280n, temporary: 2_039_280n }),
        }));
        const q = await engine.getQuote({
            fromAsset: SOL, toAsset: BONK, amount: '0.1', slippage: 0.5, evmAddress: EVM_ADDR, solanaAddress: SOL_ADDR,
        });
        const body = JSON.parse((mocks.proxyFetch.mock.calls[0] as [string, string, { body: string }])[2].body);
        expect(body.outputMint).toBe(BONK.tokenAddress);
        expect(q!.provianFee).toBe('0.00025');
        expect(q!.provianFeeToken).toBe('SOL');
        expect(q!.provianFeeUsd).toBeCloseTo(0.0375); // 0.00025 SOL at the asset price
        expect(q!.netToAmount).toBe('4150000.0');
        expect(q!.solanaCosts!.lamports.receiving).toBe('2039280');
    });

    it('BONK→JUP: the fee is in the input token (BONK)', async () => {
        mocks.proxyFetch.mockResolvedValue(jupiterResponse({
            quote: { inAmount: '10000000000', outAmount: '107000', otherAmountThreshold: '106465' },
            provian_fee: { bps: 25, amount: '25000000', side: 'input', mint: BONK.tokenAddress },
            solana_costs: solanaCosts({ receiving: 2_039_280n, treasury: 2_039_280n }),
        }));
        const q = await engine.getQuote({
            fromAsset: { ...BONK, balance: '100000' }, toAsset: JUP, amount: '100000', slippage: 0.5,
            evmAddress: EVM_ADDR, solanaAddress: SOL_ADDR,
        });
        expect(q!.provianFee).toBe('250.0'); // ethers.formatUnits keeps one decimal
        expect(q!.provianFeeToken).toBe('BONK');
        expect(q!.netToAmount).toBe('0.107');
        expect(q!.solanaCosts!.lamports.treasury).toBe('2039280');
    });

    it('RED: a fee mint on neither side of the pair is not shown', async () => {
        mocks.proxyFetch.mockResolvedValue(jupiterResponse({
            provian_fee: { bps: 25, amount: '30168', side: 'output', mint: JUP.tokenAddress },
        }));
        expect(await engine.getQuote({
            fromAsset: SOL, toAsset: USDC_SOL, amount: '0.1', slippage: 0.5, evmAddress: EVM_ADDR, solanaAddress: SOL_ADDR,
        })).toBeNull();
        mocks.proxyFetch.mockResolvedValue(jupiterResponse({
            provian_fee: { bps: 25, amount: '30168', side: 'output' }, // no mint named
        }));
        expect(await engine.getQuote({
            fromAsset: SOL, toAsset: USDC_SOL, amount: '0.1', slippage: 0.5, evmAddress: EVM_ADDR, solanaAddress: SOL_ADDR,
        })).toBeNull();
    });

    it('RED: an order without SOL costs is not shown (the screen could not say whether SOL suffices)', async () => {
        mocks.proxyFetch.mockResolvedValue(jupiterResponse({ solana_costs: undefined }));
        expect(await engine.getQuote({
            fromAsset: SOL, toAsset: USDC_SOL, amount: '0.1', slippage: 0.5, evmAddress: EVM_ADDR, solanaAddress: SOL_ADDR,
        })).toBeNull();
    });

    it('carries an insufficient-SOL answer through to the screen with the exact shortfall', async () => {
        mocks.proxyFetch.mockResolvedValue(jupiterResponse({
            provian_fee: { bps: 25, amount: '250000', side: 'input', mint: WSOL },
            solana_costs: solanaCosts({ swapped: 99_750_000n, receiving: 2_039_280n, temporary: 2_039_280n, balance: 50_000_000n }),
        }));
        const q = await engine.getQuote({
            fromAsset: SOL, toAsset: BONK, amount: '0.1', slippage: 0.5, evmAddress: EVM_ADDR, solanaAddress: SOL_ADDR,
        });
        expect(q!.solanaCosts!.sufficient).toBe(false);
        expect(q!.solanaCosts!.shortfallLamports).toBe(String(99_750_000 + 15_000 + 2_039_280 + 2_039_280 - 50_000_000));
    });
});

describe('CrossChainSwapEngine — an unmeasured "affordable" answer is not offered (review #1)', () => {
    const P = { amount: '0.1', slippage: 0.5, evmAddress: EVM_ADDR, solanaAddress: SOL_ADDR };

    it('RED: Jupiter — the relay could not simulate the tx, yet top-level figures say it fits → no quote', async () => {
        mocks.proxyFetch.mockResolvedValue(jupiterResponse({ solana_costs: solanaCosts({ swapped: 100_000_000n }, false) }));
        expect(await engine.getQuote({ fromAsset: SOL, toAsset: USDC_SOL, ...P })).toBeNull();
    });

    it('RED: LI.FI Solana source — same rule (a bridge opens accounts the top level cannot see)', async () => {
        mocks.proxyFetch.mockResolvedValue(lifiResponse({ solana_costs: solanaCosts({ swapped: 1_000_000_000n, balance: 2_000_000_000n }, false) }));
        expect(await engine.getQuote({ fromAsset: SOL, toAsset: USDC_BASE, ...P, amount: '1' })).toBeNull();
    });

    it('an unmeasured SHORTFALL is still shown, so the screen can say how much SOL to add', async () => {
        mocks.proxyFetch.mockResolvedValue(jupiterResponse({ solana_costs: solanaCosts({ swapped: 100_000_000n, balance: 0n }, false) }));
        const q = await engine.getQuote({ fromAsset: SOL, toAsset: USDC_SOL, ...P });
        expect(q!.solanaCosts!.sufficient).toBe(false);
        expect(q!.solanaCosts!.measured).toBe(false);
    });
});

describe('CrossChainSwapEngine — round 2: the review shows what the bridge order enforces', () => {
    const real = EVM_LIFI.find((f) => f.source.includes('none-8453-usdc-to-sol'))!;
    const evmQuote = (over: Record<string, unknown> = {}) => lifiResponse({
        transactionRequest: real.transactionRequest,
        estimate: { approvalAddress: LIFI_DIAMOND, fromAmount: '20000000', toAmount: real.review.toAmountAtomic, toAmountMin: real.review.minOutAtomic, feeCosts: [] },
        provian_fee: { bps: 25, amount: real.review.provianFee },
        lifi_fee: { amount: real.review.lifiFee },
        solana_costs: undefined,
        ...over,
    });
    const P = { fromAsset: USDC_BASE, toAsset: SOL, amount: '20', slippage: 0.5, evmAddress: real.review.evmAddress, solanaAddress: SOL_ADDR };
    const atRealCapture = () => atMoment(nowBefore(evmSwiftDeadline(real.transactionRequest.data)));

    it('EVM → Solana: the real quote is shown with the minimum its Swift order enforces', async () => {
        atRealCapture();
        mocks.proxyFetch.mockResolvedValue(evmQuote());
        const q = await engine.getQuote(P);
        expect(q).not.toBeNull();
        // SOL: 9 decimals, Mayan keeps 8 — the enforced minimum is the reviewed one to 10 lamports.
        const shown = BigInt(Math.round(parseFloat(q!.guaranteedAmount!) * 1e9));
        expect(shown / 10n).toBe(BigInt(real.review.minOutAtomic) / 10n);
    });

    it('RED: EVM → Solana paying another Solana address than this wallet\'s is not shown', async () => {
        atRealCapture();
        mocks.proxyFetch.mockResolvedValue(evmQuote());
        expect(await engine.getQuote({ ...P, solanaAddress: 'So11111111111111111111111111111111111111112' })).toBeNull();
    });

    it('RED: EVM → Solana whose estimate claims a higher minimum than the order enforces is not shown', async () => {
        atRealCapture();
        mocks.proxyFetch.mockResolvedValue(evmQuote({
            estimate: { approvalAddress: LIFI_DIAMOND, fromAmount: '20000000', toAmount: '999000000', toAmountMin: '990000000', feeCosts: [] },
        }));
        expect(await engine.getQuote(P)).toBeNull();
    });

    it('RED: EVM → Solana with fees above those the review shows is not shown', async () => {
        atRealCapture();
        mocks.proxyFetch.mockResolvedValue(evmQuote({ lifi_fee: { amount: '0' } }));
        expect(await engine.getQuote(P)).toBeNull();
    });

    it('RED: Solana → EVM whose order guarantees less than the review shows is not shown', async () => {
        mocks.proxyFetch.mockResolvedValue(lifiResponse({ transactionRequest: { data: signableTx(WSOL, 11_889_999n), chainId: 1151111081099710 } }));
        expect(await engine.getQuote({ fromAsset: SOL, toAsset: USDC_BASE, amount: '1', slippage: 0.5, evmAddress: EVM_ADDR, solanaAddress: SOL_ADDR })).toBeNull();
    });

    it('RED (round 3): Solana → EVM with an honest toAmount but toAmountMin and the order minimum at 10% of it is not shown', async () => {
        mocks.proxyFetch.mockResolvedValue(lifiResponse({
            estimate: { fromAmount: '1000000000', toAmount: '11950000', toAmountMin: '1195000', feeCosts: [] },
            transactionRequest: { data: signableTx(WSOL, 1_195_000n), chainId: 1151111081099710 },
        }));
        expect(await engine.getQuote({ fromAsset: SOL, toAsset: USDC_BASE, amount: '1', slippage: 0.5, evmAddress: EVM_ADDR, solanaAddress: SOL_ADDR })).toBeNull();
        // The same order is shown when the screen's slippage covers it (90%): the floor is the displayed one.
        mocks.proxyFetch.mockResolvedValue(lifiResponse({
            estimate: { fromAmount: '1000000000', toAmount: '11950000', toAmountMin: '1195000', feeCosts: [] },
            transactionRequest: { data: signableTx(WSOL, 1_195_000n), chainId: 1151111081099710 },
        }));
        expect(await engine.getQuote({ fromAsset: SOL, toAsset: USDC_BASE, amount: '1', slippage: 90, evmAddress: EVM_ADDR, solanaAddress: SOL_ADDR })).not.toBeNull();
    });

    it('RED: Solana → EVM paying another EVM address is not shown', async () => {
        mocks.proxyFetch.mockResolvedValue(lifiResponse({
            transactionRequest: { data: signableTx(WSOL, 11_890_000n, '0x000000000000000000000000000000000000dEaD'), chainId: 1151111081099710 },
        }));
        expect(await engine.getQuote({ fromAsset: SOL, toAsset: USDC_BASE, amount: '1', slippage: 0.5, evmAddress: EVM_ADDR, solanaAddress: SOL_ADDR })).toBeNull();
    });

    it('a same-chain EVM pair is never bridged, and an EVM token outside the canonical table for its chain is never requested', async () => {
        mocks.proxyFetch.mockResolvedValue(evmQuote());
        // Same chain: 0x's, never LI.FI's.
        expect(await engine.getQuote({ ...P, toAsset: { ...USDC_BASE, symbol: 'ETH', tokenAddress: undefined, decimals: 18 } })).toBeNull();
        // Base's USDC address presented as an Arbitrum token: not Arbitrum's USDC, so no route.
        expect(await engine.getQuote({ ...P, toAsset: { ...USDC_BASE, chain: 'Arbitrum', chainId: 42161 } })).toBeNull();
        // A source token the table does not know on its chain: no route.
        expect(await engine.getQuote({ ...P, fromAsset: { ...USDC_BASE, tokenAddress: '0x000000000000000000000000000000000000dEaD' } })).toBeNull();
        expect(mocks.proxyFetch).not.toHaveBeenCalled();
    });
});

describe('CrossChainSwapEngine — Base ⇄ Arbitrum ⇄ Optimism through the relay\'s LI.FI route (live quotes)', () => {
    const NAME = { 8453: 'Base', 42161: 'Arbitrum', 10: 'Optimism' } as const;
    const paramsOf = (c: EvmEvmCapture, over: Partial<{ evmAddress: string }> = {}) => ({
        fromAsset: assetOf(c.sourceChainId, c.sell), toAsset: assetOf(c.destChainId, c.buy), amount: c.amount,
        slippage: EVM_EVM.slippagePercent, evmAddress: EVM_EVM.user, solanaAddress: SOL_ADDR, ...over,
    });
    const answer = (c: EvmEvmCapture) => ({ ok: true, json: async () => relayAnswer(c) });

    for (const c of REQUIRED) {
        it(`${c.sell} on ${NAME[c.sourceChainId]} → ${c.buy} on ${NAME[c.destChainId]}: requested for the chain picked, shown with the order's own minimum`, async () => {
            atMoment(captureSec(c.capturedAt));
            mocks.proxyFetch.mockResolvedValue(answer(c));
            const q = await engine.getQuote(paramsOf(c));
            expect(q).not.toBeNull();
            const [service, path] = mocks.proxyFetch.mock.calls[0] as [string, string];
            expect(service).toBe('lifi');
            const sent = new URLSearchParams(path.split('?')[1]);
            // Exactly the relay query this live quote answered (the relay adds integrator/fee/bridges itself).
            for (const k of ['fromChain', 'toChain', 'fromToken', 'toToken', 'fromAmount', 'fromAddress', 'toAddress', 'slippage']) {
                expect(sent.get(k), k).toBe(c.request[k]);
            }
            expect(sent.has('fee') || sent.has('integrator')).toBe(false);
            expect(q!.route).toEqual([c.sell, `${NAME[c.sourceChainId]}→${NAME[c.destChainId]}`, c.buy]);
            expect(Number(q!.guaranteedAmount)).toBeGreaterThan(0);
            expect(Number(q!.guaranteedAmount)).toBeLessThanOrEqual(Number(q!.toAmount));
            expect(q!.isMock).toBeFalsy();
        });
    }

    const baseArbUsdcEth = REQUIRED.find((c) => c.pair === '8453-USDC-42161-ETH')!;
    const baseOpUsdcEth = REQUIRED.find((c) => c.pair === '8453-USDC-10-ETH')!;
    const baseArbUsdcUsdc = REQUIRED.find((c) => c.pair === '8453-USDC-42161-USDC')!;

    it('RED: the relay answering with an order for ANOTHER destination chain (Optimism for an Arbitrum pick) is not shown', async () => {
        atMoment(captureSec(baseOpUsdcEth.capturedAt));
        mocks.proxyFetch.mockResolvedValue(answer(baseOpUsdcEth));
        expect(await engine.getQuote(paramsOf(baseArbUsdcEth))).toBeNull();
    });

    it('RED: the relay answering with ANOTHER destination token (USDC for an ETH pick) is not shown', async () => {
        atMoment(captureSec(baseArbUsdcUsdc.capturedAt));
        mocks.proxyFetch.mockResolvedValue(answer(baseArbUsdcUsdc));
        expect(await engine.getQuote(paramsOf(baseArbUsdcEth))).toBeNull();
    });

    it('RED: an order paying another EVM address than this wallet\'s is not shown', async () => {
        atMoment(captureSec(baseArbUsdcEth.capturedAt));
        mocks.proxyFetch.mockResolvedValue(answer(baseArbUsdcEth));
        // Control: at its moment, for this wallet, it is shown.
        expect(await engine.getQuote(paramsOf(baseArbUsdcEth))).not.toBeNull();
        expect(await engine.getQuote(paramsOf(baseArbUsdcEth, { evmAddress: '0x552008c0f6870c2f77e5cC1d2eb9bdff03e30Ea0' }))).toBeNull();
    });
});
