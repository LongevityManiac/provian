vi.mock('../security/requireBiometric', () => ({ requireBiometric: vi.fn().mockResolvedValue(true) }));
import { requireBiometric } from '../security/requireBiometric';
vi.mock('../security/ActionWallet', async () => ({ ActionWallet: (await import('ethers')).ethers.Wallet }));
/**
 * CrossChainSwapEngine.executeSwap — money-path sign/broadcast coverage
 * (closes the reviewer's coverage observation). Mocks only the boundaries
 * (biometric/seed, Solana RPC, the relay quote fetch) and asserts the Solana-source
 * path deserializes the relay-verified transaction (LI.FI or Jupiter), signs it with the same-seed
 * keypair, and broadcasts it — plus the fail-closed cases (missing / expired
 * quote).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Buffer } from 'buffer';
import {
    Keypair,
    PublicKey,
    TransactionMessage,
    VersionedTransaction,
    SystemProgram,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { createSyncNativeInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { Asset } from '../../store/walletStore';

const SEED = new Uint8Array(32).fill(7);
const AGENT_KP = Keypair.fromSeed(SEED);
const BLOCKHASH = bs58.encode(new Uint8Array(32).fill(3));

const mocks = vi.hoisted(() => ({
    getEVMPrivateKey: vi.fn(async () => '0x' + '11'.repeat(32)),
    approve: vi.fn(async (_spender: string, _amount: bigint) => ({ wait: async () => ({ status: 1 }) })),
    allowance: vi.fn(async () => 0n),
    sendTransaction: vi.fn(async (_tx: { to: string; data: string; value: bigint }) => ({ hash: '0xEVMHASH', wait: async () => ({ status: 1 }) })),
    proxyFetch: vi.fn(),
    requireBiometricSession: vi.fn(async () => {}),
    getSolanaSeed: vi.fn(async () => new Uint8Array(32).fill(7)),
    sendRawTransaction: vi.fn(async (_b64: string) => 'SOLANA_SIG'),
    createEnvelope: vi.fn(async (_ctx: Record<string, unknown>) => ({})),
    enqueueDeferredEnvelope: vi.fn(async (_ctx: Record<string, unknown>) => {}),
}));
// Every executed swap records a PE (Security Invariant #5); the envelope manager is the boundary.
vi.mock('../provenance/ProvenanceEnvelopeManager', () => ({
    default: { createEnvelope: mocks.createEnvelope, enqueueDeferredEnvelope: mocks.enqueueDeferredEnvelope },
}));
vi.mock('../../services/ProxyConfig', () => ({ default: { proxyFetch: mocks.proxyFetch } }));
vi.mock('../AppModeManager', () => ({ assertWalletEnabled: vi.fn() }));
vi.mock('../wallet/SeedManager', () => ({
    default: { requireBiometricSession: mocks.requireBiometricSession, getSolanaSeed: mocks.getSolanaSeed, getEVMPrivateKey: mocks.getEVMPrivateKey },
}));
// The EVM boundary: the provider, the wallet and the ERC-20 (the guard's Interface/AbiCoder stay real).
vi.mock('ethers', async (importOriginal) => {
    const real = await importOriginal<typeof import('ethers')>();
    class JsonRpcProvider { constructor(_url: string) { /* offline */ } }
    class Wallet {
        address = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
        constructor(_key: string, _provider: unknown) { /* offline */ }
        sendTransaction(tx: { to: string; data: string; value: bigint }) { return mocks.sendTransaction(tx); }
    }
    class Contract {
        constructor(_address: string, _abi: unknown, _runner: unknown) { /* offline */ }
        allowance() { return mocks.allowance(); }
        approve(spender: string, amount: bigint) { return mocks.approve(spender, amount); }
    }
    return { ...real, ethers: { ...real.ethers, JsonRpcProvider, Wallet, Contract } };
});
vi.mock('../chains/solana/SolanaRpc', () => ({
    // getAccountInfoDirect: the guard's lookup-table read (these transactions load none).
    default: { sendRawTransaction: mocks.sendRawTransaction, getAccountInfoDirect: vi.fn(async () => null) },
}));

import engine, { type CrossChainSwapParams, type DisplayedSwap } from './CrossChainSwapEngine';
import { jupiterRouteV2Ix } from './__tests__/jupiterRouteIx';
import { evmWord, lifiFeeTransfers, swiftInitOrderIx } from './__tests__/swiftOrderIx';
import { EVM_EVM, REQUIRED, assetOf, relayAnswer, type EvmEvmCapture } from './__tests__/evmEvmFixtures';
import { captureSec, evmSwiftDeadline, nowBefore } from './__tests__/swiftClock';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOL: Asset = { symbol: 'SOL', name: 'Solana', balance: '5', price: 150, chain: 'Solana', decimals: 9 };
const USDC_BASE: Asset = {
    symbol: 'USDC', name: 'USD Coin', balance: '0', price: 1, chain: 'Base',
    chainId: 8453, tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, isStablecoin: true,
};
const EVM_ADDR = '0x552008c0f6870c2f77e5cC1d2eb9bdff03e30Ea0';
const SOL_ADDR = AGENT_KP.publicKey.toBase58();

const OUTSIDER = Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey;
const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

/**
 * Build an UNSIGNED v0 transaction whose fee payer is the wallet keypair: it wraps the wallet's
 * own SOL (what a Jupiter/LI.FI swap does first), which the guard allows. `extra` appends
 * instructions a compromised relay could add.
 */
function unsignedSolanaTxBase64(extra: 'none' | 'sol_out' | 'usdc_out' = 'none', jupiterSwap = false, swiftOrder = !jupiterSwap): string {
    const me = AGENT_KP.publicKey;
    const wsol = getAssociatedTokenAddressSync(WSOL, me);
    const instructions = [
        SystemProgram.transfer({ fromPubkey: me, toPubkey: wsol, lamports: 1 }),
        createSyncNativeInstruction(wsol),
    ];
    // A Jupiter route carries its one Jupiter swap: 1 SOL → USDC, the quote below, 50 bps.
    if (jupiterSwap) {
        instructions.push(jupiterRouteV2Ix({
            user: me, inputMint: WSOL.toBase58(), outputMint: USDC_MINT.toBase58(),
            inAmount: 1_000_000_000n, outAmount: 150_000_000n, slippageBps: 50,
        }));
    }
    // A LI.FI route pays Provian's 25 bps of the 1 SOL sent ( : a fee floor), then
    // places its one Mayan Swift v2 order: 1 SOL → Base USDC to EVM_ADDR, at least 149 USDC.
    if (swiftOrder) {
        instructions.unshift(...lifiFeeTransfers(me, { provian: 2_500_000n, lifi: 0n }));
        instructions.push(swiftInitOrderIx({
            user: me, mintFrom: WSOL.toBase58(), evmAddress: EVM_ADDR, wormholeChain: 30,
            tokenOutWord: evmWord(USDC_BASE.tokenAddress!), amountInMin: 1n, amountOutMin: 149_250_000n,
        }));
    }
    if (extra === 'sol_out') instructions.push(SystemProgram.transfer({ fromPubkey: me, toPubkey: OUTSIDER, lamports: 5_000_000_000 }));
    if (extra === 'usdc_out') {
        instructions.push(createTransferCheckedInstruction(
            getAssociatedTokenAddressSync(USDC_MINT, me), USDC_MINT, getAssociatedTokenAddressSync(USDC_MINT, OUTSIDER), me, 1_000_000n, 6,
        ));
    }
    const msg = new TransactionMessage({ payerKey: me, recentBlockhash: BLOCKHASH, instructions }).compileToV0Message();
    const vtx = new VersionedTransaction(msg);
    return Buffer.from(vtx.serialize()).toString('base64');
}

function lifiQuoteWithSolanaTx(extra: 'none' | 'sol_out' | 'usdc_out' = 'none') {
    return {
        ok: true,
        json: async () => ({
            id: 'quote-solsrc',
            tool: 'mayan',
            estimate: { fromAmount: '1000000000', toAmount: '150000000', toAmountMin: '149250000' },
            transactionRequest: { data: unsignedSolanaTxBase64(extra) },
            provian_fee: { bps: 25, amount: '2500000' },
            solana_costs: {
                network_fee_lamports: '15000', receiving_account_lamports: '0', treasury_fee_account_lamports: '0',
                temporary_account_lamports: '0', other_accounts_lamports: '0', sol_swapped_lamports: '1000000000',
                spend_lamports: '1000015000', required_lamports: '1000665240', balance_lamports: '5000000000',
                rent_exempt_minimum_lamports: '650240', sufficient: true, shortfall_lamports: '0', measured: true,
            },
        }),
    };
}

function jupiterOrderWithSolanaTx(extra: 'none' | 'sol_out' | 'usdc_out' = 'none') {
    return {
        ok: true,
        json: async () => ({
            quote: { inAmount: '1000000000', outAmount: '150000000', otherAmountThreshold: '149000000' },
            swapTransaction: unsignedSolanaTxBase64(extra, true),
            lastValidBlockHeight: 1,
            provian_fee: { bps: 25, amount: '375000', side: 'output', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
            solana_costs: {
                network_fee_lamports: '15000', receiving_account_lamports: '0', treasury_fee_account_lamports: '0',
                temporary_account_lamports: '0', other_accounts_lamports: '0', sol_swapped_lamports: '1000000000',
                spend_lamports: '1000015000', required_lamports: '1000665240', balance_lamports: '5000000000',
                rent_exempt_minimum_lamports: '650240', sufficient: true, shortfall_lamports: '0', measured: true,
            },
        }),
    };
}

const USDC_SOL: Asset = {
    symbol: 'USDC', name: 'USD Coin', balance: '0', price: 1, chain: 'Solana',
    tokenAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, isStablecoin: true,
};

/**
 * The screen's view of a swap ( ): executeSwap signs only the route for the
 * pair and amount on screen. `quoteFor` asks for a quote exactly as the screen does and records
 * that pair and amount as what is shown.
 */
let lastShown: DisplayedSwap | null = null;
const shownOf = (p: Pick<CrossChainSwapParams, 'fromAsset' | 'toAsset' | 'amount'>): DisplayedSwap => ({ fromAsset: p.fromAsset, toAsset: p.toAsset, amount: p.amount });
async function quoteFor(p: CrossChainSwapParams) {
    lastShown = shownOf(p);
    return engine.getQuote(p);
}
const shown = (): DisplayedSwap => lastShown!;
function atMoment(unixSec: number): void {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(unixSec * 1000);
}
afterEach(() => {
    vi.useRealTimers();
});

beforeEach(() => {
    vi.mocked(requireBiometric).mockClear();
    mocks.proxyFetch.mockReset();
    mocks.sendRawTransaction.mockClear();
    mocks.createEnvelope.mockClear();
    mocks.enqueueDeferredEnvelope.mockClear();
    mocks.getSolanaSeed.mockResolvedValue(new Uint8Array(32).fill(7));
    mocks.requireBiometricSession.mockResolvedValue(undefined);
});

describe('CrossChainSwapEngine.executeSwap — Solana source', () => {
    it('deserializes LI.FI tx, signs with the same-seed keypair, and broadcasts', async () => {
        mocks.proxyFetch.mockResolvedValue(lifiQuoteWithSolanaTx());
        const quote = await quoteFor({
            fromAsset: SOL, toAsset: USDC_BASE, amount: '1', slippage: 0.5,
            evmAddress: EVM_ADDR, solanaAddress: SOL_ADDR,
        });
        expect(quote).not.toBeNull();

        const result = await engine.executeSwap(quote!.id, shown());
        expect(result.success).toBe(true);
        expect(result.transactionHash).toBe('SOLANA_SIG');
        expect(vi.mocked(requireBiometric)).toHaveBeenCalledTimes(1);

        // The broadcast payload must be a SIGNED tx carrying the agent's signature.
        const sentB64 = mocks.sendRawTransaction.mock.calls.at(-1)?.[0] as string;
        const sent = VersionedTransaction.deserialize(new Uint8Array(Buffer.from(sentB64, 'base64')));
        const signerIdx = sent.message.staticAccountKeys.findIndex(k => k.equals(AGENT_KP.publicKey));
        expect(signerIdx).toBe(0);
        expect(sent.signatures[0].some(b => b !== 0)).toBe(true); // actually signed
    });

    it('Jupiter (Solana⇄Solana): signs the relay-built transaction with the same-seed keypair and broadcasts', async () => {
        mocks.proxyFetch.mockResolvedValue(jupiterOrderWithSolanaTx());
        const quote = await quoteFor({
            fromAsset: SOL, toAsset: USDC_SOL, amount: '1', slippage: 0.5,
            evmAddress: EVM_ADDR, solanaAddress: SOL_ADDR,
        });
        expect(quote).not.toBeNull();
        expect(quote!.provider).toBe('jupiter');
        const result = await engine.executeSwap(quote!.id, shown());
        expect(result.success).toBe(true);
        expect(vi.mocked(requireBiometric)).toHaveBeenCalledTimes(1);
        const sentB64 = mocks.sendRawTransaction.mock.calls.at(-1)?.[0] as string;
        const sent = VersionedTransaction.deserialize(new Uint8Array(Buffer.from(sentB64, 'base64')));
        expect(sent.message.staticAccountKeys[0].equals(AGENT_KP.publicKey)).toBe(true);
        expect(sent.signatures[0].some(b => b !== 0)).toBe(true);
        // The swap leaves a PE (a record: a Solana signature is not an EVM hash, so none rides).
        expect(mocks.createEnvelope).toHaveBeenCalledWith(expect.objectContaining({
            actionType: 'swap', assetSymbol: 'SOL', amount: '1', chainId: 'solana', txHash: 'SOLANA_SIG',
        }), expect.toSatisfy((value: unknown) => value === undefined || (typeof value === 'object' && value !== null && 'nativeId' in value)));
    });

    it('RED: a PE write that fails after the swap is sent is queued for reconciliation, never dropped', async () => {
        mocks.createEnvelope.mockRejectedValueOnce(new Error('keychain locked'));
        mocks.proxyFetch.mockResolvedValue(jupiterOrderWithSolanaTx());
        const quote = await quoteFor({
            fromAsset: SOL, toAsset: USDC_SOL, amount: '1', slippage: 0.5,
            evmAddress: EVM_ADDR, solanaAddress: SOL_ADDR,
        });
        const result = await engine.executeSwap(quote!.id, shown());
        expect(result.success).toBe(true);
        expect(mocks.enqueueDeferredEnvelope).toHaveBeenCalledWith(expect.objectContaining({ actionType: 'swap', txHash: 'SOLANA_SIG' }));
    });

    it('FAIL CLOSED: unknown quote id throws (never signs/broadcasts)', async () => {
        await expect(engine.executeSwap('does-not-exist', shownOf({ fromAsset: SOL, toAsset: USDC_BASE, amount: '1' }))).rejects.toThrow(/expired|new quote/i);
        expect(mocks.sendRawTransaction).not.toHaveBeenCalled();
    });

    it('FAIL CLOSED: a no-route quote is null and cannot be executed', async () => {
        mocks.proxyFetch.mockResolvedValue({ ok: false, json: async () => ({}) });
        const q = await quoteFor({
            fromAsset: SOL, toAsset: USDC_BASE, amount: '1', slippage: 0.5,
            evmAddress: EVM_ADDR, solanaAddress: SOL_ADDR,
        });
        expect(q).toBeNull();
        expect(mocks.sendRawTransaction).not.toHaveBeenCalled();
    });
});

/**
 * RED controls. Before the guard, executeSwap deserialized and signed ANY transaction the
 * relay returned (signAndSendSolana had no program or transfer check), so every case below was
 * signed and broadcast. The quote is taken with a clean transaction and the cached route is then
 * swapped for a malicious one — the relay answering differently between review and sign — so the
 * refusal proven here is the sign-time check, not the quote-time one.
 */
/** The real Base 20 USDC → SOL LI.FI answer (Mayan Swift v2, captured 2026-09-27). */
interface EvmLifiFixture {
    source: string;
    transactionRequest: { to: string; data: string; value: string; chainId: number };
    review: { evmAddress: string; minOutAtomic: string; provianFee: string; lifiFee: string; sellAmount: string; toAmountAtomic: string };
}
const REAL_EVM: EvmLifiFixture = (JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'evm-route-fixtures.json'), 'utf8')).lifi as EvmLifiFixture[])
    .find((f) => f.source.includes('none-8453-usdc-to-sol'))!;
const DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE';
function realEvmQuote(fromAmount = REAL_EVM.review.sellAmount) {
    return {
        ok: true,
        json: async () => ({
            id: 'quote-evmsrc', tool: 'mayan',
            // estimate.fromAmount is the relay's number: the approval must never be taken from it.
            estimate: { fromAmount, toAmount: REAL_EVM.review.toAmountAtomic, toAmountMin: REAL_EVM.review.minOutAtomic, approvalAddress: DIAMOND },
            transactionRequest: { ...REAL_EVM.transactionRequest },
            provian_fee: { bps: 25, amount: REAL_EVM.review.provianFee },
            lifi_fee: { amount: REAL_EVM.review.lifiFee },
        }),
    };
}
const EVM_PARAMS = {
    fromAsset: USDC_BASE, toAsset: SOL, amount: '20', slippage: 0.5,
    evmAddress: REAL_EVM.review.evmAddress, solanaAddress: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
};

describe('CrossChainSwapEngine.executeSwap — LI.FI EVM source approves and sends exactly what was reviewed (round 2)', () => {
    beforeEach(() => {
    vi.mocked(requireBiometric).mockClear();
        atMoment(nowBefore(evmSwiftDeadline(REAL_EVM.transactionRequest.data)));
        mocks.approve.mockClear();
        mocks.sendTransaction.mockClear();
        mocks.requireBiometricSession.mockClear();
    });

    it('control: the real route approves exactly the amount entered, to the Diamond, and sends value 0', async () => {
        mocks.proxyFetch.mockResolvedValue(realEvmQuote());
        const quote = await quoteFor(EVM_PARAMS);
        expect(quote).not.toBeNull();
        const result = await engine.executeSwap(quote!.id, shown());
        expect(result.success).toBe(true);
        expect(mocks.approve).toHaveBeenCalledWith(DIAMOND, 20_000_000n);
        expect(mocks.sendTransaction.mock.calls[0][0].value).toBe(0n);
    });

    it('RED: over-approval — the relay\'s estimate names twice the amount; the approval stays the amount reviewed', async () => {
        // Old code approved BigInt(estimate.fromAmount): 40_000_000.
        mocks.proxyFetch.mockResolvedValue(realEvmQuote('40000000'));
        const quote = await quoteFor(EVM_PARAMS);
        const result = await engine.executeSwap(quote!.id, shown());
        expect(result.success).toBe(true);
        expect(mocks.approve).toHaveBeenCalledTimes(1);
        expect(mocks.approve.mock.calls[0][1]).toBe(20_000_000n);
    });

    it('RED: value — an ERC-20 route swapped for one sending ETH is refused before biometric', async () => {
        mocks.proxyFetch.mockResolvedValue(realEvmQuote());
        const quote = await quoteFor(EVM_PARAMS);
        (engine as unknown as { routeCache: Map<string, { quote: { transactionRequest: { value: string } } }> })
            .routeCache.get(quote!.id)!.quote.transactionRequest.value = '0x1';
        const result = await engine.executeSwap(quote!.id, shown());
        expect(result.success).toBe(false);
        expect(mocks.requireBiometricSession).not.toHaveBeenCalled();
        expect(mocks.approve).not.toHaveBeenCalled();
        expect(mocks.sendTransaction).not.toHaveBeenCalled();
    });

    it('RED: the calldata swapped between review and sign (another Solana receiver) is refused before biometric', async () => {
        mocks.proxyFetch.mockResolvedValue(realEvmQuote());
        const quote = await quoteFor(EVM_PARAMS);
        const cached = (engine as unknown as { routeCache: Map<string, { quote: { transactionRequest: { data: string } } }> }).routeCache.get(quote!.id)!;
        const me = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
        const mine = Buffer.from(bs58.decode(me)).toString('hex');
        cached.quote.transactionRequest.data = cached.quote.transactionRequest.data.split(mine).join('ab'.repeat(32));
        const result = await engine.executeSwap(quote!.id, shown());
        expect(result.success).toBe(false);
        expect(mocks.requireBiometricSession).not.toHaveBeenCalled();
        expect(mocks.sendTransaction).not.toHaveBeenCalled();
    });
});

describe('CrossChainSwapEngine.executeSwap — signing guard', () => {
    type Cache = Map<string, { kind: string; order?: { swapTransaction: string }; quote?: { transactionRequest: { data?: string; to?: string; chainId?: number }; estimate: { approvalAddress?: string } } }>;
    const cache = () => (engine as unknown as { routeCache: Cache }).routeCache;
    beforeEach(() => {
    vi.mocked(requireBiometric).mockClear();
        atMoment(nowBefore(evmSwiftDeadline(REAL_EVM.transactionRequest.data)));
        mocks.requireBiometricSession.mockClear();
        mocks.getSolanaSeed.mockClear();
    });

    it('RED: a Jupiter transaction carrying an extra SOL transfer out is refused, never signed', async () => {
        mocks.proxyFetch.mockResolvedValue(jupiterOrderWithSolanaTx());
        const quote = await quoteFor({ fromAsset: SOL, toAsset: USDC_SOL, amount: '1', slippage: 0.5, evmAddress: EVM_ADDR, solanaAddress: SOL_ADDR });
        cache().get(quote!.id)!.order!.swapTransaction = unsignedSolanaTxBase64('sol_out', true);
        const result = await engine.executeSwap(quote!.id, shown());
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/not in the route.*Nothing was signed/);
        expect(mocks.requireBiometricSession).not.toHaveBeenCalled();
        expect(mocks.getSolanaSeed).not.toHaveBeenCalled();
        expect(mocks.sendRawTransaction).not.toHaveBeenCalled();
    });

    it('RED: a LI.FI Solana transaction carrying an extra SPL transfer out is refused, never signed', async () => {
        mocks.proxyFetch.mockResolvedValue(lifiQuoteWithSolanaTx());
        const quote = await quoteFor({ fromAsset: SOL, toAsset: USDC_BASE, amount: '1', slippage: 0.5, evmAddress: EVM_ADDR, solanaAddress: SOL_ADDR });
        cache().get(quote!.id)!.quote!.transactionRequest.data = unsignedSolanaTxBase64('usdc_out');
        const result = await engine.executeSwap(quote!.id, shown());
        expect(result.success).toBe(false);
        expect(mocks.sendRawTransaction).not.toHaveBeenCalled();
    });

    it('a malicious transaction is not even offered for review', async () => {
        mocks.proxyFetch.mockResolvedValue(jupiterOrderWithSolanaTx('sol_out'));
        const quote = await quoteFor({ fromAsset: SOL, toAsset: USDC_SOL, amount: '1', slippage: 0.5, evmAddress: EVM_ADDR, solanaAddress: SOL_ADDR });
        expect(quote).toBeNull();
    });

    it('RED: a LI.FI EVM-source transaction to anything but the LI.FI Diamond is refused before approve/sign', async () => {
        mocks.proxyFetch.mockResolvedValue(realEvmQuote());
        const quote = await quoteFor(EVM_PARAMS);
        expect(quote).not.toBeNull();
        cache().get(quote!.id)!.quote!.transactionRequest.to = '0x000000000000000000000000000000000000dEaD';
        const result = await engine.executeSwap(quote!.id, shown());
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/not the LI.FI Diamond/);
        expect(mocks.requireBiometricSession).not.toHaveBeenCalled();
    });
});

describe('CrossChainSwapEngine.executeSwap — EVM → EVM: approves and sends exactly what was reviewed', () => {
    /** A live capture, with the clock at the moment it was taken. */
    const pick = (pair: string) => {
        const c = REQUIRED.find((x) => x.pair === pair)!;
        atMoment(captureSec(c.capturedAt));
        return c;
    };
    const paramsOf = (c: EvmEvmCapture) => ({
        fromAsset: assetOf(c.sourceChainId, c.sell), toAsset: assetOf(c.destChainId, c.buy), amount: c.amount,
        slippage: EVM_EVM.slippagePercent, evmAddress: EVM_EVM.user, solanaAddress: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
    });
    beforeEach(() => {
    vi.mocked(requireBiometric).mockClear();
        mocks.approve.mockClear();
        mocks.sendTransaction.mockClear();
        mocks.requireBiometricSession.mockClear();
    });

    it('USDC on Base → ETH on Arbitrum: approves exactly 20 USDC to the Diamond, sends the reviewed calldata with value 0', async () => {
        const c = pick('8453-USDC-42161-ETH');
        mocks.proxyFetch.mockResolvedValue({ ok: true, json: async () => relayAnswer(c) });
        const quote = await quoteFor(paramsOf(c));
        expect(quote).not.toBeNull();
        const result = await engine.executeSwap(quote!.id, shown());
        expect(result.success).toBe(true);
        expect(mocks.approve).toHaveBeenCalledWith(DIAMOND, 20_000_000n);
        const sent = mocks.sendTransaction.mock.calls[0][0];
        expect(sent.to).toBe(DIAMOND);
        expect(sent.data).toBe(c.quote!.transactionRequest.data);
        expect(sent.value).toBe(0n);
        // The source-chain transaction rides the PE, so on Base the relay re-reads it.
        expect(mocks.createEnvelope).toHaveBeenCalledWith(expect.objectContaining({ actionType: 'swap', chainId: 8453, txHash: '0xEVMHASH' }), expect.objectContaining({ nativeId: null }));
    });

    it('ETH on Arbitrum → USDC on Optimism: no approval, value exactly the 0.01 ETH entered', async () => {
        const c = pick('42161-ETH-10-USDC');
        mocks.proxyFetch.mockResolvedValue({ ok: true, json: async () => relayAnswer(c) });
        const quote = await quoteFor(paramsOf(c));
        const result = await engine.executeSwap(quote!.id, shown());
        expect(result.success).toBe(true);
        expect(mocks.approve).not.toHaveBeenCalled();
        expect(mocks.sendTransaction.mock.calls[0][0].value).toBe(10_000_000_000_000_000n);
    });

    it('RED: the calldata swapped between review and sign for an order to another chain is refused before biometric', async () => {
        const c = pick('8453-USDC-42161-ETH');
        const other = pick('8453-USDC-10-ETH');
        mocks.proxyFetch.mockResolvedValue({ ok: true, json: async () => relayAnswer(c) });
        const quote = await quoteFor(paramsOf(c));
        const cached = (engine as unknown as { routeCache: Map<string, { quote: { transactionRequest: { data: string } } }> }).routeCache.get(quote!.id)!;
        cached.quote.transactionRequest.data = other.quote!.transactionRequest.data;
        const result = await engine.executeSwap(quote!.id, shown());
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/Nothing was signed/);
        expect(mocks.requireBiometricSession).not.toHaveBeenCalled();
        expect(mocks.approve).not.toHaveBeenCalled();
        expect(mocks.sendTransaction).not.toHaveBeenCalled();
    });
});

/**
 * — the route behind the quote on screen is the one signed.
 *
 * Before: routes were cached under the relay-chosen quote.id, so a late answer for a pair or an
 * amount no longer on screen, carrying the same id, overwrote the route behind the displayed
 * quote, and executeSwap(id) signed it. Now the engine keys every answer itself and executeSwap
 * takes the swap on screen and refuses any route that is not it.
 */
describe('CrossChainSwapEngine.executeSwap — : only the swap on screen is signed', () => {
    const TREASURY_SOL = '5PHJDHYveHA1LhqiWpCDRVEgSezDgPBMyL1rwAoMBTco';
    beforeEach(() => {
    vi.mocked(requireBiometric).mockClear();
        mocks.approve.mockClear();
        mocks.sendTransaction.mockClear();
        mocks.sendRawTransaction.mockClear();
        mocks.requireBiometricSession.mockClear();
        mocks.getSolanaSeed.mockClear();
    });

    /** A relay LI.FI answer for `sol` SOL → Base USDC (Mayan Swift v2, fees paid), with the relay's own `id`. */
    function solToBaseUsdc(sol: bigint, id: string, deadline?: bigint) {
        const lamports = sol * 1_000_000_000n;
        const fee = (lamports * 25n) / 10_000n;
        const toAmount = sol * 150_000_000n;
        const toAmountMin = (toAmount * 9950n) / 10_000n;
        const me = AGENT_KP.publicKey;
        const wsol = getAssociatedTokenAddressSync(WSOL, me);
        const tx = Buffer.from(new VersionedTransaction(new TransactionMessage({
            payerKey: me, recentBlockhash: BLOCKHASH,
            instructions: [
                ...lifiFeeTransfers(me, { provian: fee, lifi: fee }),
                SystemProgram.transfer({ fromPubkey: me, toPubkey: wsol, lamports: 1 }),
                createSyncNativeInstruction(wsol),
                swiftInitOrderIx({
                    user: me, mintFrom: WSOL.toBase58(), evmAddress: EVM_ADDR, wormholeChain: 30,
                    tokenOutWord: evmWord(USDC_BASE.tokenAddress!), amountInMin: 1n, amountOutMin: toAmountMin, deadline,
                }),
            ],
        }).compileToV0Message()).serialize()).toString('base64');
        return {
            ok: true,
            json: async () => ({
                id, tool: 'mayan',
                estimate: { fromAmount: String(lamports), toAmount: String(toAmount), toAmountMin: String(toAmountMin) },
                transactionRequest: { data: tx },
                provian_fee: { bps: 25, amount: String(fee) },
                lifi_fee: { amount: String(fee) },
                solana_costs: {
                    network_fee_lamports: '15000', receiving_account_lamports: '0', treasury_fee_account_lamports: '0',
                    temporary_account_lamports: '0', other_accounts_lamports: '0', sol_swapped_lamports: '1000000000',
                    spend_lamports: '1000015000', required_lamports: '1000665240', balance_lamports: '5000000000',
                    rent_exempt_minimum_lamports: '650240', sufficient: true, shortfall_lamports: '0', measured: true,
                },
            }),
        };
    }
    /** The lamports the broadcast transaction pays Provian's treasury: which amount's route was signed. */
    function signedTreasuryLamports(): bigint {
        const sentB64 = mocks.sendRawTransaction.mock.calls.at(-1)?.[0] as string;
        const vtx = VersionedTransaction.deserialize(new Uint8Array(Buffer.from(sentB64, 'base64')));
        const keys = vtx.message.staticAccountKeys.map((k) => k.toBase58());
        for (const ix of vtx.message.compiledInstructions) {
            if (keys[ix.programIdIndex] !== SystemProgram.programId.toBase58()) continue;
            const d = Buffer.from(ix.data);
            if (d.readUInt32LE(0) === 2 && keys[ix.accountKeyIndexes[1]] === TREASURY_SOL) return d.readBigUInt64LE(4);
        }
        throw new Error('the signed transaction pays the treasury nothing');
    }
    const SOL_PARAMS = (amount: string): CrossChainSwapParams => ({
        fromAsset: SOL, toAsset: USDC_BASE, amount, slippage: 0.5, evmAddress: EVM_ADDR, solanaAddress: SOL_ADDR,
    });

    it("RED : a late answer for a STALE PAIR with the same relay id does not replace the route behind the quote on screen", async () => {
        // On screen: USDC on Base → ETH on Arbitrum. A late answer for the pair picked before
        // (USDC on Base → ETH on Optimism) arrives with the same relay id.
        const shownPair = REQUIRED.find((c) => c.pair === '8453-USDC-42161-ETH')!;
        const stalePair = REQUIRED.find((c) => c.pair === '8453-USDC-10-ETH')!;
        atMoment(captureSec(shownPair.capturedAt));
        const paramsOf = (c: EvmEvmCapture): CrossChainSwapParams => ({
            fromAsset: assetOf(c.sourceChainId, c.sell), toAsset: assetOf(c.destChainId, c.buy), amount: c.amount,
            slippage: EVM_EVM.slippagePercent, evmAddress: EVM_EVM.user, solanaAddress: SOL_ADDR,
        });
        mocks.proxyFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ...relayAnswer(shownPair), id: 'X' }) });
        const onScreen = await engine.getQuote(paramsOf(shownPair));
        mocks.proxyFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ...relayAnswer(stalePair), id: 'X' }) });
        const late = await engine.getQuote(paramsOf(stalePair)); // the screen drops it; it must not replace anything
        expect(onScreen).not.toBeNull();
        expect(late).not.toBeNull();
        expect(onScreen!.id).not.toBe('X'); // the engine's own key, never the relay's
        expect(late!.id).not.toBe(onScreen!.id);

        const result = await engine.executeSwap(onScreen!.id, shownOf(paramsOf(shownPair)));
        expect(result.success).toBe(true);
        expect(mocks.sendTransaction.mock.calls[0][0].data).toBe(shownPair.quote!.transactionRequest.data);
        expect(mocks.sendTransaction.mock.calls[0][0].data).not.toBe(stalePair.quote!.transactionRequest.data);
    });

    it("RED : a late answer for a STALE AMOUNT (1000 SOL) with the same relay id — the 100 SOL on screen is what is signed", async () => {
        mocks.proxyFetch.mockResolvedValueOnce(solToBaseUsdc(100n, 'X'));
        const onScreen = await engine.getQuote(SOL_PARAMS('100'));
        mocks.proxyFetch.mockResolvedValueOnce(solToBaseUsdc(1000n, 'X'));
        const late = await engine.getQuote(SOL_PARAMS('1000'));
        expect(onScreen).not.toBeNull();
        expect(late).not.toBeNull();

        const result = await engine.executeSwap(onScreen!.id, shownOf(SOL_PARAMS('100')));
        expect(result.success).toBe(true);
        // Provian's 25 bps of 100 SOL (0.25 SOL), not of 1000 SOL: the 100 SOL route was signed.
        expect(signedTreasuryLamports()).toBe(250_000_000n);
    });

    it('RED: executeSwap refuses a route that is not the swap on screen — another amount, destination chain, or source — before biometric', async () => {
        mocks.proxyFetch.mockResolvedValueOnce(solToBaseUsdc(1000n, 'X'));
        const q = await engine.getQuote(SOL_PARAMS('1000'));
        expect(q).not.toBeNull();
        const r1 = await engine.executeSwap(q!.id, shownOf(SOL_PARAMS('100')));
        expect(r1.success).toBe(false);
        expect(r1.error).toMatch(/sends 1000, not the 100 shown.*Nothing was signed/);
        const r2 = await engine.executeSwap(q!.id, shownOf({ ...SOL_PARAMS('1000'), toAsset: { ...USDC_BASE, chain: 'Arbitrum' } }));
        expect(r2.success).toBe(false);
        expect(r2.error).toMatch(/buys USDC on Base, not the USDC on Arbitrum shown/);
        const r3 = await engine.executeSwap(q!.id, shownOf({ ...SOL_PARAMS('1000'), fromAsset: USDC_SOL }));
        expect(r3.success).toBe(false);
        expect(mocks.requireBiometricSession).not.toHaveBeenCalled();
        expect(mocks.getSolanaSeed).not.toHaveBeenCalled();
        expect(mocks.sendRawTransaction).not.toHaveBeenCalled();
        // Control: the same route, with the swap on screen matching it, is signed.
        const ok = await engine.executeSwap(q!.id, shownOf(SOL_PARAMS('1000')));
        expect(ok.success).toBe(true);
    });

    it('RED: a Swift order whose deadline is 2^64 − 1 is never offered; one swapped in between review and sign is refused before biometric', async () => {
        mocks.proxyFetch.mockResolvedValueOnce(solToBaseUsdc(1n, 'X', 2n ** 64n - 1n));
        expect(await engine.getQuote(SOL_PARAMS('1'))).toBeNull();
        mocks.proxyFetch.mockResolvedValueOnce(solToBaseUsdc(1n, 'X'));
        const q = await engine.getQuote(SOL_PARAMS('1'));
        expect(q).not.toBeNull();
        const far = (await solToBaseUsdc(1n, 'X', 2n ** 64n - 1n).json()) as { transactionRequest: { data: string } };
        (engine as unknown as { routeCache: Map<string, { quote: { transactionRequest: { data: string } } }> })
            .routeCache.get(q!.id)!.quote.transactionRequest.data = far.transactionRequest.data;
        const result = await engine.executeSwap(q!.id, shownOf(SOL_PARAMS('1')));
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/deadline.*Nothing was signed/);
        expect(mocks.requireBiometricSession).not.toHaveBeenCalled();
        expect(mocks.sendRawTransaction).not.toHaveBeenCalled();
    });
});
