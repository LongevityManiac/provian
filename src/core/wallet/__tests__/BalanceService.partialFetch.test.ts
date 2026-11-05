/**
 * [Audit Pass-3 #42] Partial token-fetch must not drop a still-held token.
 *
 * Bug: when a chain's native ETH read succeeds but ONE ERC-20 read fails, the
 * merge took the fresh (partial) asset set — which no longer contains the failed
 * token — and never fell back to the prior snapshot, so a real holding vanished
 * from totals and the Send/Swap pickers under a generic "may be outdated" banner.
 * (review #5 only preserved the prior snapshot when a chain FULLY failed.)
 *
 * Fix: restore each failed-but-still-held token from the prior snapshot.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const BASE = 8453;
const USDC_ADDR = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PVT_ADDR = '0x1111111111111111111111111111111111111111';

vi.mock('../../shared/environment', () => ({ isTestnet: () => false }));

vi.mock('../../prices/PriceService', () => ({
    default: { getPrices: vi.fn().mockResolvedValue({}) },
}));

vi.mock('../../chains/evm/config', () => ({
    getActiveChains: () => [
        { chainId: BASE, name: 'Base', rpcUrl: 'https://mainnet.base.org' },
    ],
    getTokenAddresses: () => ({ USDC: USDC_ADDR }),
    PVT9_TOKEN: { symbol: 'PVT', name: 'Provian Value Token', chainId: 8453, address: '0x1111111111111111111111111111111111111111', decimals: 18 },
}));

// Prior snapshot lives in module scope so the mock and the assertions share it.
let priorAssets: unknown[] = [];
let evmBalanceGate: Promise<void> | null = null;
let evmBalanceFails = false;
vi.mock('../../../store/walletStore', () => ({
    useWalletStore: {
        getState: () => ({
            assets: priorAssets,
            setAssets: (assets: unknown[]) => { priorAssets = assets; },
        }),
    },
}));

vi.mock('../../../services/RelayAPIService', () => ({
    default: { getPVTBalance: vi.fn().mockResolvedValue(null) },
}));

// Real ethers for formatUnits/formatEther; mock only the network surface.
vi.mock('ethers', async (importOriginal) => {
    const actual = await importOriginal<typeof import('ethers')>();
    class MockProvider {
        constructor(public url: string) {}
        async getBalance(_addr: string) {
            if (evmBalanceGate) await evmBalanceGate;
            if (evmBalanceFails) throw new Error('Base RPC unavailable');
            return 100000000000000000n;
        } // 0.1 ETH
    }
    class MockContract {
        constructor(public address: string, _abi: unknown, _provider: unknown) {}
        async balanceOf(_addr: string): Promise<bigint> {
            return 5_000_000n; // 5 USDC (6 decimals)
        }
        async decimals(): Promise<number> {
            return this.address === USDC_ADDR ? 6 : 18;
        }
    }
    return {
        ...actual,
        ethers: { ...actual.ethers, JsonRpcProvider: MockProvider, Contract: MockContract },
    };
});

import BalanceService from '../BalanceService';
import relayService from '../../../services/RelayAPIService';

const ADDR = '0xAbC0000000000000000000000000000000000001';

beforeEach(() => {
    priorAssets = [];
    evmBalanceGate = null;
    evmBalanceFails = false;
    vi.mocked(relayService.getPVTBalance).mockResolvedValue(null);
    // Clear coalescing/provider caches on the singleton between tests.
    BalanceService.clearProviders();
});

describe('BalanceService partial token-fetch fallback (#42)', () => {
    it('restores a failed token from the prior snapshot instead of dropping it', async () => {
        // The user held 42 PVT last refresh.
        priorAssets = [
            { symbol: 'PVT', name: 'Provian Value Token', balance: '42.000000', price: 0, chain: 'Base', chainId: BASE, tokenAddress: PVT_ADDR, decimals: 18, isPVT: true },
        ];

        const { assets, failedChainIds } = await BalanceService.fetchAllBalancesDetailed(ADDR);

        const symbols = assets.map((a) => a.symbol).sort();
        // ETH + USDC come back fresh; PVT (failed) is restored from prior.
        expect(symbols).toEqual(['ETH', 'PVT', 'USDC']);

        const pvt = assets.find((a) => a.symbol === 'PVT');
        expect(pvt?.balance).toBe('42.000000'); // the prior-snapshot value, not dropped

        const usdc = assets.find((a) => a.symbol === 'USDC');
        expect(usdc?.balance).toBe('5.00'); // fresh

        // The chain is still flagged failed so the "may be outdated" banner shows.
        expect(failedChainIds).toContain(BASE);
    });

    it('does not invent a token that was never held when its read fails', async () => {
        // No prior PVT holding: a failed PVT read simply omits PVT (nothing to restore).
        priorAssets = [];
        const { assets } = await BalanceService.fetchAllBalancesDetailed(ADDR);
        const symbols = assets.map((a) => a.symbol).sort();
        expect(symbols).toEqual(['ETH', 'USDC']);
        expect(assets.find((a) => a.symbol === 'PVT')).toBeUndefined();
    });

    it('publishes a fresh PVT balance before a slow EVM chain finishes', async () => {
        let releaseEvm!: () => void;
        evmBalanceGate = new Promise<void>((resolve) => { releaseEvm = resolve; });
        vi.mocked(relayService.getPVTBalance).mockResolvedValue({
            balance: '7', balance_raw: '7000000000000000000',
        });

        const pending = BalanceService.fetchAllBalancesDetailed(ADDR);
        await vi.waitFor(() => {
            expect(priorAssets.some((asset: any) => asset.isPVT && asset.balance === '7.0000')).toBe(true);
        });
        releaseEvm();
        const { assets, failedChainIds } = await pending;
        expect(assets.find((asset) => asset.isPVT)?.balance).toBe('7.0000');
        expect(failedChainIds).toEqual([]);
    });

    it('keeps one fresh PVT tile when the Base RPC fails', async () => {
        evmBalanceFails = true;
        priorAssets = [
            { symbol: 'PVT', balance: '42.0000', chain: 'Base', chainId: BASE, isPVT: true },
        ];
        vi.mocked(relayService.getPVTBalance).mockResolvedValue({
            balance: '7', balance_raw: '7000000000000000000',
        });

        const { assets, failedChainIds } = await BalanceService.fetchAllBalancesDetailed(ADDR);
        expect(assets.filter((asset) => asset.isPVT)).toHaveLength(1);
        expect(assets.find((asset) => asset.isPVT)?.balance).toBe('7.0000');
        expect(failedChainIds).toContain(BASE);
    });
});
