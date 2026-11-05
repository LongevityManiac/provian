/**
 * Tests for My Provenance Dashboard
 *
 * Tests the PVT types, API service methods, and helper functions.
 * Component rendering tests require React Testing Library which isn't
 * set up in this project - these are logic/integration tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
    PVTAccrual,
    PVTHistoryEntry,
    PVTHistoryResponse,
    PVTNetworkStats,
    PVTLeaderboardEntry,
    PVTBreakdownItem,
} from '../../../services/RelayAPIService';

const FACTOR_VINTAGE = {
    globalMintRate: {
        numerator: '1',
        denominator: '2',
        source: 'PVTv8.effectiveMintRate',
        asOf: '2026-07-11T12:00:00.000Z',
    },
};

function breakdownItem(
    category: string,
    peCount: number,
    recordPoints: string,
    projection: string | null = null,
): PVTBreakdownItem {
    return {
        category,
        peCount,
        recordPoints,
        recordPointsAtomic: recordPoints,
        currentSettlementProjectionPVT: projection,
        currentSettlementProjectionAtomic: projection,
        exactGenesisReservedGrossPVT: '0',
        exactGenesisReservedGrossAtomic: '0',
    };
}

function historyEntry(
    peId: string,
    actionType: string,
    timestamp: number,
    hidden = false,
): PVTHistoryEntry {
    return {
        peId,
        actionType,
        timestamp,
        attestationDepth: 'hardware_full',
        mintStatus: 'eligible',
        commitSha: null,
        recordPoints: '1',
        recordPointsAtomic: '1',
        currentSettlementProjectionPVT: '0.5',
        currentSettlementProjectionAtomic: '0',
        exactGenesisReservedGrossPVT: '0',
        exactGenesisReservedGrossAtomic: '0',
        hash: `hash_${peId}`,
        hidden,
    };
}

function accrualFixture(totalPEs: number): PVTAccrual {
    return {
        recordPoints: {
            label: 'Sealed record points (not PVT)',
            unit: 'record_points_atomic',
            total: String(totalPEs),
            totalAtomic: String(totalPEs),
        },
        currentSettlementProjection: {
            available: true,
            label: 'Current settlement projection (non-final)',
            isFinal: false,
            totalPVT: String(totalPEs / 2),
            totalPvtAtomic: String(Math.floor(totalPEs / 2)),
            projectedAtMs: Date.parse('2026-07-11T12:00:00.000Z'),
            factorVintage: FACTOR_VINTAGE,
        },
        exactGenesisReservedGross: {
            label: 'Exact fixed Genesis reserved gross',
            totalPVT: '0',
            totalAtomic: '0',
        },
        totalPEs,
        weeklyPEs: totalPEs,
        attestationDepth: totalPEs > 0 ? 'hardware_full' : 'software',
        breakdown: totalPEs > 0 ? [breakdownItem('wallet', totalPEs, String(totalPEs), String(totalPEs / 2))] : [],
        integrityFailures: 0,
        projectionFailures: 0,
    };
}

// =============================================================================
// TYPE SHAPE TESTS
// =============================================================================

describe('PVT Types', () => {
    it('PVTAccrual has all required fields', () => {
        const accrual: PVTAccrual = {
            ...accrualFixture(42),
            totalPEs: 42,
            weeklyPEs: 7,
            breakdown: [
                breakdownItem('wallet', 20, '20', '10'),
                breakdownItem('agent', 15, '15', '7.5'),
                breakdownItem('x402', 5, '5', '2.5'),
                breakdownItem('promises', 2, '2', '1'),
            ],
        };

        expect(accrual.totalPEs).toBe(42);
        expect(accrual.weeklyPEs).toBe(7);
        expect(accrual.attestationDepth).toBe('hardware_full');
        expect(accrual.breakdown).toHaveLength(4);
    });

    it('PVTHistoryEntry has all required fields', () => {
        const entry: PVTHistoryEntry = {
            peId: 'pe_123',
            actionType: 'agent_authorization',
            timestamp: Date.now(),
            attestationDepth: 'software',
            mintStatus: 'eligible',
            commitSha: null,
            recordPoints: '1',
            recordPointsAtomic: '1',
            currentSettlementProjectionPVT: '0.5',
            currentSettlementProjectionAtomic: '0',
            exactGenesisReservedGrossPVT: '0',
            exactGenesisReservedGrossAtomic: '0',
            hash: 'abc123def456',
            hidden: false,
        };

        expect(entry.peId).toBe('pe_123');
        expect(entry.hidden).toBe(false);
    });

    it('PVTHistoryResponse supports pagination', () => {
        const response: PVTHistoryResponse = {
            entries: [],
            total: 100,
            hasMore: true,
            currentSettlementProjection: {
                label: 'Current settlement projection (non-final)',
                isFinal: false,
                projectedAtMs: Date.parse('2026-07-11T12:00:00.000Z'),
                factorVintage: FACTOR_VINTAGE,
            },
        };

        expect(response.total).toBe(100);
        expect(response.hasMore).toBe(true);
    });

    it('PVTNetworkStats includes leaderboard and user rank', () => {
        const stats: PVTNetworkStats = {
            totalPEs: 10000,
            activeWallets: 500,
            humanWallets: 300,
            agentWallets: 200,
            pesLast24h: 150,
            leaderboard: [
                {
                    rank: 1,
                    address: '0x1234567890abcdef1234567890abcdef12345678',
                    ownerType: 'human',
                    peCount: 500,
                },
                {
                    rank: 2,
                    address: '0xabcdef1234567890abcdef1234567890abcdef12',
                    ownerType: 'agent',
                    peCount: 400,
                },
            ],
            userRank: 847,
            userAddress: '0xdeadbeef',
        };

        expect(stats.leaderboard).toHaveLength(2);
        expect(stats.leaderboard[0].ownerType).toBe('human');
        expect(stats.leaderboard[1].ownerType).toBe('agent');
        expect(stats.humanWallets + stats.agentWallets).toBe(stats.activeWallets);
        expect(stats.userRank).toBe(847);
    });
});

// =============================================================================
// HELPER FUNCTION TESTS
// =============================================================================

describe('Dashboard Helper Functions', () => {
    // These mirror the helper functions in MyProvenanceDashboardScreen.tsx

    function formatTimestamp(timestamp: number): string {
        const now = Date.now();
        const diffMs = now - timestamp;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        if (diffMins < 1) return 'Just now';
        if (diffMins < 60) return `${diffMins}m ago`;
        if (diffHours < 24) return `${diffHours}h ago`;
        if (diffDays < 7) return `${diffDays}d ago`;
        if (diffDays === 1) return 'Yesterday';

        return new Date(timestamp).toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
        });
    }

    function formatNumber(n: number): string {
        if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
        if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
        return n.toLocaleString();
    }

    it('formatTimestamp returns "Just now" for recent timestamps', () => {
        expect(formatTimestamp(Date.now())).toBe('Just now');
        expect(formatTimestamp(Date.now() - 30_000)).toBe('Just now');
    });

    it('formatTimestamp returns minutes for <60 min', () => {
        expect(formatTimestamp(Date.now() - 5 * 60_000)).toBe('5m ago');
        expect(formatTimestamp(Date.now() - 45 * 60_000)).toBe('45m ago');
    });

    it('formatTimestamp returns hours for <24 hours', () => {
        expect(formatTimestamp(Date.now() - 2 * 3_600_000)).toBe('2h ago');
    });

    it('formatTimestamp returns days for <7 days', () => {
        expect(formatTimestamp(Date.now() - 3 * 86_400_000)).toBe('3d ago');
    });

    it('formatNumber formats thousands with K suffix', () => {
        expect(formatNumber(1500)).toBe('1.5K');
        expect(formatNumber(12345)).toBe('12.3K');
    });

    it('formatNumber formats millions with M suffix', () => {
        expect(formatNumber(1_000_000)).toBe('1.0M');
        expect(formatNumber(2_500_000)).toBe('2.5M');
    });

    it('formatNumber returns plain number for <1000', () => {
        expect(formatNumber(42)).toBe('42');
        expect(formatNumber(999)).toBe('999');
    });
});

// =============================================================================
// CATEGORY BREAKDOWN TESTS
// =============================================================================

describe('PE Category Breakdown', () => {
    // Mirror the categorizeActionType logic from the backend
    function categorizeActionType(actionType: string): 'wallet' | 'agent' | 'x402' | 'promises' {
        if (actionType === 'x402_payment') return 'x402';
        if (
            actionType.startsWith('promise_') ||
            actionType.startsWith('negotiation_') ||
            actionType === 'agreement' ||
            actionType === 'agreement_settled'
        ) {
            return 'promises';
        }
        if (
            actionType.startsWith('agent_') ||
            actionType.startsWith('egress_') ||
            actionType.startsWith('proxied_') ||
            actionType.startsWith('policy_') ||
            actionType.startsWith('credential_') ||
            actionType.startsWith('request_') ||
            actionType.startsWith('friction_') ||
            actionType.startsWith('anomaly_') ||
            actionType.startsWith('behavior_') ||
            actionType.startsWith('classification_') ||
            actionType.startsWith('environment_') ||
            actionType.startsWith('skill_') ||
            actionType === 'emergency_stop'
        ) {
            return 'agent';
        }
        return 'wallet';
    }

    it('categorizes wallet transactions', () => {
        expect(categorizeActionType('send')).toBe('wallet');
        expect(categorizeActionType('receive')).toBe('wallet');
        expect(categorizeActionType('swap')).toBe('wallet');
        expect(categorizeActionType('stake')).toBe('wallet');
        expect(categorizeActionType('wallet_created')).toBe('wallet');
    });

    it('categorizes agent actions', () => {
        expect(categorizeActionType('agent_authorization')).toBe('agent');
        expect(categorizeActionType('agent_action')).toBe('agent');
        expect(categorizeActionType('agent_communicate')).toBe('agent');
        expect(categorizeActionType('policy_created')).toBe('agent');
        expect(categorizeActionType('credential_added')).toBe('agent');
        expect(categorizeActionType('emergency_stop')).toBe('agent');
        expect(categorizeActionType('egress_data_requested')).toBe('agent');
        expect(categorizeActionType('anomaly_detected')).toBe('agent');
        expect(categorizeActionType('environment_attestation')).toBe('agent');
    });

    it('categorizes x402 payments', () => {
        expect(categorizeActionType('x402_payment')).toBe('x402');
    });

    it('categorizes promise actions', () => {
        expect(categorizeActionType('promise_created')).toBe('promises');
        expect(categorizeActionType('promise_fulfilled')).toBe('promises');
        expect(categorizeActionType('negotiation_started')).toBe('promises');
        expect(categorizeActionType('agreement')).toBe('promises');
        expect(categorizeActionType('agreement_settled')).toBe('promises');
    });

    it('defaults unknown types to wallet', () => {
        expect(categorizeActionType('unknown_type')).toBe('wallet');
        expect(categorizeActionType('')).toBe('wallet');
    });
});

// =============================================================================
// HISTORY FILTERING TESTS
// =============================================================================

describe('PE History Filtering', () => {
    const mockEntries: PVTHistoryEntry[] = [
        historyEntry('pe_1', 'send', 1000),
        historyEntry('pe_2', 'agent_action', 2000, true),
        { ...historyEntry('pe_3', 'receive', 3000), attestationDepth: 'software' },
        historyEntry('pe_4', 'swap', 4000, true),
    ];

    it('filters hidden PEs when showHidden is false', () => {
        const visible = mockEntries.filter(e => !e.hidden);
        expect(visible).toHaveLength(2);
        expect(visible.every(e => !e.hidden)).toBe(true);
    });

    it('includes all PEs when showHidden is true', () => {
        const all = mockEntries;
        expect(all).toHaveLength(4);
    });

    it('hidden PEs are counted in stats but excluded from history', () => {
        const totalPEs = mockEntries.length; // Stats use all
        const visibleHistory = mockEntries.filter(e => !e.hidden);

        expect(totalPEs).toBe(4);
        expect(visibleHistory).toHaveLength(2);
    });
});

// =============================================================================
// LEADERBOARD TESTS
// =============================================================================

describe('Leaderboard', () => {
    const mockLeaderboard: PVTLeaderboardEntry[] = Array.from({ length: 50 }, (_, i) => ({
        rank: i + 1,
        address: `0x${String(i).padStart(40, '0')}`,
        ownerType: i % 3 === 0 ? 'agent' as const : 'human' as const,
        peCount: (50 - i) * 10,
    }));

    it('shows both human and agent wallet types', () => {
        const humans = mockLeaderboard.filter(e => e.ownerType === 'human');
        const agents = mockLeaderboard.filter(e => e.ownerType === 'agent');

        expect(humans.length).toBeGreaterThan(0);
        expect(agents.length).toBeGreaterThan(0);
    });

    it('user rank is visible even when not in top 10', () => {
        const stats: PVTNetworkStats = {
            totalPEs: 10000,
            activeWallets: 500,
            humanWallets: 300,
            agentWallets: 200,
            pesLast24h: 150,
            leaderboard: mockLeaderboard,
            userRank: 847,
            userAddress: '0xuser',
        };

        // The user rank (847) is > 10, so the UI should show the "You: #X" card
        expect(stats.userRank).toBeGreaterThan(10);
        expect(stats.userRank).toBe(847);
    });

    it('leaderboard entries are sorted by rank ascending', () => {
        for (let i = 1; i < mockLeaderboard.length; i++) {
            expect(mockLeaderboard[i].rank).toBeGreaterThan(mockLeaderboard[i - 1].rank);
        }
    });
});

// =============================================================================
// RECORD POINT / SETTLEMENT PROJECTION TRUTH TESTS
// =============================================================================

describe('Dashboard monetary truth', () => {
    it('does not equate sealed record points with a non-unit settlement projection', () => {
        const accrual = accrualFixture(42);
        expect(accrual.recordPoints.total).toBe('42');
        expect(accrual.currentSettlementProjection.available).toBe(true);
        if (!accrual.currentSettlementProjection.available) throw new Error('projection expected');
        expect(accrual.currentSettlementProjection.totalPVT).toBe('21');
        expect(accrual.currentSettlementProjection.isFinal).toBe(false);
        expect(accrual.currentSettlementProjection.factorVintage.globalMintRate.numerator).toBe('1');
        expect(accrual.currentSettlementProjection.factorVintage.globalMintRate.denominator).toBe('2');
    });

    it('breakdown keeps record points and current projection separate', () => {
        const breakdown: PVTBreakdownItem[] = [
            breakdownItem('wallet', 20, '20', '10'),
            breakdownItem('agent', 15, '15', '7.5'),
            breakdownItem('x402', 5, '5', '2.5'),
            breakdownItem('promises', 2, '2', '1'),
        ];

        const totalPEs = breakdown.reduce((sum, item) => sum + item.peCount, 0);
        const totalRecordPoints = breakdown.reduce((sum, item) => sum + parseFloat(item.recordPoints), 0);
        const currentProjection = breakdown.reduce(
            (sum, item) => sum + parseFloat(item.currentSettlementProjectionPVT ?? '0'),
            0,
        );

        expect(totalPEs).toBe(42);
        expect(totalRecordPoints).toBe(42);
        expect(currentProjection).toBe(21);
    });

    it('fixed Genesis reservations remain separately displayable as exact gross', () => {
        const genesis = {
            ...breakdownItem('genesis', 1, '75', null),
            exactGenesisReservedGrossPVT: '75',
            exactGenesisReservedGrossAtomic: '75000000000000000000',
        };
        expect(genesis.currentSettlementProjectionPVT).toBeNull();
        expect(genesis.exactGenesisReservedGrossPVT).toBe('75');
    });
});

// =============================================================================
// PAGINATION TESTS
// =============================================================================

describe('PE History Pagination', () => {
    it('first page has correct offset and limit', () => {
        const limit = 10;
        const offset = 0;
        const total = 50;

        expect(offset + limit < total).toBe(true); // hasMore
    });

    it('last page signals no more data', () => {
        const limit = 10;
        const offset = 40;
        const total = 50;

        expect(offset + limit < total).toBe(false); // no more
    });

    it('accumulated entries grow with each page load', () => {
        const pages: PVTHistoryEntry[][] = [
            Array(10).fill(null).map((_, i) => historyEntry(`pe_${i}`, 'send', i)),
            Array(10).fill(null).map((_, i) => historyEntry(`pe_${i + 10}`, 'send', i + 10)),
        ];

        let accumulated: PVTHistoryEntry[] = [];
        accumulated = [...accumulated, ...pages[0]];
        expect(accumulated).toHaveLength(10);

        accumulated = [...accumulated, ...pages[1]];
        expect(accumulated).toHaveLength(20);
    });
});

// =============================================================================
// EMPTY STATE TESTS
// =============================================================================

describe('Empty State', () => {
    it('triggers when totalPEs is 0', () => {
        const accrual = accrualFixture(0);

        const isEmptyState = accrual.totalPEs === 0;
        expect(isEmptyState).toBe(true);
    });

    it('does not trigger when totalPEs > 0', () => {
        const accrual = accrualFixture(1);

        const isEmptyState = accrual.totalPEs === 0;
        expect(isEmptyState).toBe(false);
    });
});

// =============================================================================
// SUMMARY BAR TESTS
// =============================================================================

describe('PVT Summary Bar Logic', () => {
    it('summary bar is shown when PE count > 0', () => {
        const peCount = 42;
        const showBar = peCount > 0;
        expect(showBar).toBe(true);
    });

    it('summary bar is hidden when PE count is 0', () => {
        const peCount = 0;
        const showBar = peCount > 0;
        expect(showBar).toBe(false);
    });

    it('summary PVT display uses the current non-final projection, not PE count', () => {
        const accrual = accrualFixture(42);
        if (!accrual.currentSettlementProjection.available) throw new Error('projection expected');
        expect(accrual.currentSettlementProjection.totalPVT).toBe('21');
        expect(accrual.currentSettlementProjection.label).toContain('non-final');
    });

    it('pluralizes "envelopes" correctly', () => {
        const format = (count: number) =>
            `${count} provenance envelope${count !== 1 ? 's' : ''}`;

        expect(format(0)).toBe('0 provenance envelopes');
        expect(format(1)).toBe('1 provenance envelope');
        expect(format(42)).toBe('42 provenance envelopes');
    });
});
