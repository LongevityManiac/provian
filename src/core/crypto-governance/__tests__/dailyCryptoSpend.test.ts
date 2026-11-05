/**
 * WS5: daily crypto-spend accumulator + its wiring into the governance engine.
 *
 * Proves the audit fix: previously metadata.dailyCryptoSpent was read but never
 * written, so the daily on-chain cap only blocked a single tx that alone
 * exceeded the limit — many sub-limit transfers drained past it. Now the engine
 * reads a persistent accumulator, so cumulative spend is enforced.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mem } = vi.hoisted(() => ({ mem: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => (mem.has(k) ? mem.get(k)! : null)),
        setItem: vi.fn(async (k: string, v: string) => { mem.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { mem.delete(k); }),
    },
}));
vi.mock('expo-crypto', () => ({
    digestStringAsync: vi.fn().mockImplementation((_a: string, d: string) =>
        Promise.resolve(`hash_${Buffer.from(d).toString('base64')}`)),
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
}));
vi.mock('../../provenance/ProvenanceEnvelopeManager', () => ({
    default: { createEnvelope: vi.fn().mockResolvedValue({ envelope_id: 'e1' }) },
}));
vi.mock('../SpendingPolicy', () => ({
    default: {
        getCurrentUsage: vi.fn().mockResolvedValue({ daily: 0, weekly: 0, monthly: 0 }),
        getRemainingLimits: vi.fn().mockResolvedValue({ daily: 1e9, weekly: 1e9, monthly: 1e9 }),
    },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
    getDailyCryptoSpentUsd,
    recordDailyCryptoSpendUsd,
} from '../DailyCryptoSpendTracker';
import { evaluateCryptoTransaction, DEFAULT_CRYPTO_SPENDING_CONTROLS } from '../CryptoSpendingGovernance';
import type { CryptoSpendingControls } from '../CryptoSpendingGovernance';
import type { CryptoTransactionInput } from '../CryptoTransactionClassifier';
import { DEFAULT_POLICY_TEMPLATE } from '../types';
import type { SpendingPolicy } from '../types';
import type { AgentSpendRequest } from '../spendRequest';

const SCOPE = 'wallet-owner';
const DAY1 = Date.UTC(2026, 5, 1, 12, 0, 0);
const DAY2 = Date.UTC(2026, 5, 2, 12, 0, 0);

beforeEach(() => { mem.clear(); });

describe('DailyCryptoSpendTracker', () => {
    it('accumulates spend across multiple records within a UTC day', async () => {
        await recordDailyCryptoSpendUsd(SCOPE, 'tx1', 30, DAY1);
        await recordDailyCryptoSpendUsd(SCOPE, 'tx2', 25, DAY1);
        expect(await getDailyCryptoSpentUsd(SCOPE, DAY1)).toBe(55);
    });

    it('dedupes by requestHash (a re-recorded tx does not double-count)', async () => {
        await recordDailyCryptoSpendUsd(SCOPE, 'tx1', 30, DAY1);
        await recordDailyCryptoSpendUsd(SCOPE, 'tx1', 30, DAY1);
        expect(await getDailyCryptoSpentUsd(SCOPE, DAY1)).toBe(30);
    });

    it('resets at the UTC day boundary', async () => {
        await recordDailyCryptoSpendUsd(SCOPE, 'tx1', 80, DAY1);
        expect(await getDailyCryptoSpentUsd(SCOPE, DAY1)).toBe(80);
        expect(await getDailyCryptoSpentUsd(SCOPE, DAY2)).toBe(0);
    });

    it('ignores non-positive amounts', async () => {
        await recordDailyCryptoSpendUsd(SCOPE, 'tx0', 0, DAY1);
        await recordDailyCryptoSpendUsd(SCOPE, 'txneg', -5, DAY1);
        expect(await getDailyCryptoSpentUsd(SCOPE, DAY1)).toBe(0);
    });

    // WS11: a failed AsyncStorage write previously swallowed silently. The cap
    // still fails toward allowing (best-effort), but the failure must now be
    // OBSERVABLE - securityLog.warn routes to console.warn under __DEV__.
    it('logs (does not silently swallow) a persistence failure', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('quota exceeded'));
            // Must not throw - fail toward allowing is preserved.
            await expect(
                recordDailyCryptoSpendUsd(SCOPE, 'txwritefail', 10, DAY1),
            ).resolves.toBeUndefined();
            expect(warnSpy).toHaveBeenCalled();
            const logged = warnSpy.mock.calls.map(c => c.join(' ')).join('\n');
            expect(logged).toContain('DailyCryptoSpendTracker');
            expect(logged.toLowerCase()).toContain('under-count');
        } finally {
            warnSpy.mockRestore();
        }
    });
});

describe('engine reads the accumulator (cumulative cap enforced)', () => {
    function policy(): SpendingPolicy {
        return {
            ...DEFAULT_POLICY_TEMPLATE,
            id: 'p', agentId: SCOPE, name: 'p', createdAt: 0, updatedAt: 0,
            categories: { allowed: [], blocked: [], mode: 'blocklist' },
            merchants: { allowlist: [], blocklist: [], mode: 'any' },
            limits: { perTransaction: 1e9, daily: 1e9, weekly: 1e9, monthly: 1e9 },
            capabilities: {
                ...DEFAULT_POLICY_TEMPLATE.capabilities,
                canSpendCrypto: true,
                allowedActionTypes: ['transfer', 'approve', 'swap', 'purchase', 'subscription', 'api_usage'],
            },
        } as SpendingPolicy;
    }
    function controls(): CryptoSpendingControls {
        return {
            ...DEFAULT_CRYPTO_SPENDING_CONTROLS,
            dailyOnChainLimit: 100,
            perTransactionLimit: 10_000,
            maxApprovalAmount: 1e9,
            allowedChains: [],
            contractBlocklist: [],
            blockedCategories: [],
            highFrictionCategories: [],
        } as CryptoSpendingControls;
    }
    function req(amount: number): AgentSpendRequest {
        return { agentId: SCOPE, actionType: 'transfer', merchant: 'm', amount, currency: 'USD', purpose: 'p' } as AgentSpendRequest;
    }
    const txInput: CryptoTransactionInput = { to: '0x000000000000000000000000000000000000dead', value: '0', data: '0x', chain: 'base', chainId: 8453 };

    function dailyViolation(result: { allViolations: { message: string }[] }): boolean {
        return result.allViolations.some(v => v.message.includes('Daily on-chain spend'));
    }

    it('blocks a sub-limit tx once cumulative spend would cross the daily cap', async () => {
        // Seed $80 already spent today; a $30 tx (each well under the $10k
        // per-tx limit) would push the day to $110 > $100 cap.
        await recordDailyCryptoSpendUsd(SCOPE, 'prior', 80);
        const result = await evaluateCryptoTransaction(req(30), policy(), txInput, controls());
        expect(dailyViolation(result)).toBe(true);
        expect(result.finalLane).toBe('block');
    });

    it('allows the same tx when cumulative spend stays under the cap', async () => {
        // No prior spend: $30 <= $100, so the daily cap does not fire.
        const result = await evaluateCryptoTransaction(req(30), policy(), txInput, controls());
        expect(dailyViolation(result)).toBe(false);
    });
});
