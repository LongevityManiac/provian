/**
 * PolicyEvaluator tests - non-financial friction wiring + crypto action-type gate.
 *
 * Covers:
 *  - Fix F7: a computed forceHardConfirm signal must drive the lane to hard_confirm
 *            (it was previously dropped, leaking to soft_confirm / auto_approve).
 *  - Fix F5: the crypto action types (transfer/swap/approve) are only permitted
 *            when present in capabilities.allowedActionTypes (the property the
 *            policy wizard now sets when crypto is enabled).
 *  - Fix F3: share_data of a sensitive data type forces hard_confirm even when the
 *            configured allowlists pass (so it can never auto-approve).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// PolicyEvaluator transitively pulls in AsyncStorage (SpendingPolicy usage
// store) + expo-crypto + ProvenanceEnvelopeManager. Mock them so the module
// graph loads under vitest.
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
}));
vi.mock('expo-crypto', () => ({
    digestStringAsync: vi.fn().mockImplementation((_algo: string, data: string) =>
        Promise.resolve(`hash_${Buffer.from(data).toString('base64')}`)),
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
}));
vi.mock('../provenance/ProvenanceEnvelopeManager', () => ({
    default: { createEnvelope: vi.fn().mockResolvedValue({ envelope_id: 'test-envelope-id' }) },
}));

// evaluatePolicy reads usage/limits from SpendingPolicyManager; stub them so the
// test is hermetic (no AsyncStorage).
vi.mock('./SpendingPolicy', () => ({
    default: {
        getCurrentUsage: vi.fn().mockResolvedValue({ daily: 0, weekly: 0, monthly: 0 }),
        getRemainingLimits: vi.fn().mockResolvedValue({ daily: 1000, weekly: 5000, monthly: 20000 }),
    },
}));

import { evaluatePolicy, evaluateNonFinancialAction } from './PolicyEvaluator';
import { DEFAULT_POLICY_TEMPLATE, SpendingPolicy } from './types';
import type { AgentSpendRequest } from './spendRequest';

function makePolicy(overrides: Partial<SpendingPolicy> = {}): SpendingPolicy {
    return {
        ...DEFAULT_POLICY_TEMPLATE,
        id: 'policy-test',
        agentId: 'agent-test',
        name: 'Test Policy',
        createdAt: 0,
        updatedAt: 0,
        // Neutralize category checks so they don't mask the assertions under test.
        categories: { allowed: [], blocked: [], mode: 'blocklist' },
        merchants: { allowlist: [], blocklist: [], mode: 'any' },
        ...overrides,
    } as SpendingPolicy;
}

describe('PolicyEvaluator', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('Fix F7 - forceHardConfirm drives the lane', () => {
        it('routes a communicate action to hard_confirm when the capability is disabled', async () => {
            const policy = makePolicy({
                capabilities: {
                    ...DEFAULT_POLICY_TEMPLATE.capabilities,
                    canCommunicate: false, // disabled => forceHardConfirm
                    allowedActionTypes: ['communicate'], // allowlisted so we don't block on action type
                },
            });
            const request: AgentSpendRequest = {
                agentId: 'agent-test',
                actionType: 'communicate',
                merchant: 'communication',
                amount: 0,
                currency: 'USD',
                purpose: 'send message',
            };

            const result = await evaluatePolicy(request, policy);
            // No hard violation, low risk, amount 0 - pre-fix this leaked to soft_confirm.
            expect(result.violations).toHaveLength(0);
            expect(result.suggestedLane).toBe('hard_confirm');
        });
    });

    describe('Fix F5 - crypto action-type gate', () => {
        it('blocks a transfer when transfer is not in allowedActionTypes', async () => {
            const policy = makePolicy({
                capabilities: {
                    ...DEFAULT_POLICY_TEMPLATE.capabilities,
                    canSpendCrypto: true,
                    allowedActionTypes: ['purchase', 'subscription', 'api_usage'], // crypto NOT listed
                },
            });
            const request: AgentSpendRequest = {
                agentId: 'agent-test',
                actionType: 'transfer',
                merchant: '0xrecipient',
                amount: 50,
                currency: 'USD',
                purpose: 'crypto transfer',
            };

            const result = await evaluatePolicy(request, policy);
            expect(result.violations.some((v) => v.type === 'action_type_not_allowed')).toBe(true);
            expect(result.suggestedLane).toBe('block');
        });

        it('permits a transfer when transfer IS in allowedActionTypes (the wizard fix)', async () => {
            const policy = makePolicy({
                capabilities: {
                    ...DEFAULT_POLICY_TEMPLATE.capabilities,
                    canSpendCrypto: true,
                    allowedActionTypes: ['purchase', 'subscription', 'api_usage', 'transfer', 'swap', 'approve'],
                },
            });
            const request: AgentSpendRequest = {
                agentId: 'agent-test',
                actionType: 'transfer',
                merchant: '0xrecipient',
                amount: 50,
                currency: 'USD',
                purpose: 'crypto transfer',
            };

            const result = await evaluatePolicy(request, policy);
            expect(result.violations.some((v) => v.type === 'action_type_not_allowed')).toBe(false);
            expect(result.passed).toBe(true);
            expect(result.suggestedLane).not.toBe('block');
        });
    });

    describe('Fix F3 - sensitive data forces confirmation', () => {
        const policy = makePolicy({
            capabilities: {
                ...DEFAULT_POLICY_TEMPLATE.capabilities,
                canShareData: true,
                allowedActionTypes: ['share_data'],
            },
            dataSharing: {
                allowedDataTypes: ['medical', 'documents'],
                blockedDataTypes: [],
                allowedRecipients: ['partner'],
                requireRecoverable: false,
            },
        });

        it('forces hard_confirm for a sensitive data type even when allowlists pass', () => {
            const request: AgentSpendRequest = {
                agentId: 'agent-test',
                actionType: 'share_data',
                merchant: 'partner',
                amount: 0,
                currency: 'USD',
                purpose: 'share medical data',
                metadata: { dataType: 'medical', recipient: 'partner', isRecoverable: true },
            };
            const result = evaluateNonFinancialAction(request, policy);
            expect(result.violations).toHaveLength(0);
            expect(result.forceHardConfirm).toBe(true);
        });

        it('does not force hard_confirm for a non-sensitive allowed data type', () => {
            const request: AgentSpendRequest = {
                agentId: 'agent-test',
                actionType: 'share_data',
                merchant: 'partner',
                amount: 0,
                currency: 'USD',
                purpose: 'share documents',
                metadata: { dataType: 'documents', recipient: 'partner', isRecoverable: true },
            };
            const result = evaluateNonFinancialAction(request, policy);
            expect(result.violations).toHaveLength(0);
            expect(result.forceHardConfirm).toBe(false);
        });
    });
});
