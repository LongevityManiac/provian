import { describe, it, expect } from 'vitest';
import {
    formatActionType,
    getActionTypeDisplay,
    getActionTypeDescription,
    hasActionTypeDescription,
    PROVENANCE_ENVELOPE_OVERVIEW,
} from '../actionTypeDisplay';
import { normalizeMintStatus, buildEarningChip } from '../peDisposition';
import { groupByCommit, describeCommitWitnesses, bestDisposition, shortSha } from '../commitGrouping';

describe('formatActionType — no leaked internals (#2)', () => {
    it('never leaks a raw namespaced/underscored internal string', () => {
        expect(formatActionType('service:github_commit')).toBe('GitHub Commit');
        expect(formatActionType('ai_conversation')).toBe('AI Conversation');
        expect(formatActionType('x402_payment')).toBe('x402 Payment');
        expect(formatActionType('service:gitlab_push')).toBe('Gitlab Push');
        // No colon, no underscore, no leading namespace survives.
        for (const s of ['service:github_commit', 'ai_conversation', 'x402_payment']) {
            const out = formatActionType(s);
            expect(out).not.toContain(':');
            expect(out).not.toContain('_');
        }
    });
    it('title-cases each word and applies the acronym dictionary', () => {
        expect(formatActionType('agent_work_product_code')).toBe('Agent Work Product Code');
        expect(formatActionType('pvt_batch_minted')).toBe('PVT Batch Minted');
    });
    it('empty / falsy input is safe', () => {
        expect(formatActionType('')).toBe('Unknown Action');
    });
});

describe('getActionTypeDisplay — the new compute/work types resolve to real icons+labels', () => {
    it('ai_conversation / commit / coding_session are no longer the generic fallback', () => {
        for (const t of ['ai_conversation', 'service:github_commit', 'coding_session', 'corroboration_signal']) {
            const d = getActionTypeDisplay(t);
            expect(d.icon).not.toBe('document-outline');
            expect(d.label).not.toMatch(/[:_]/);
        }
    });
    it('an unknown type still gets a clean fallback label (no leaked internals)', () => {
        const d = getActionTypeDisplay('service:some_future_type');
        expect(d.icon).toBe('document-outline');
        expect(d.label).toBe('Some Future Type');
    });
});

describe('getActionTypeDescription — every PE can explain itself', () => {
    it('specific types get specific copy; unknown falls back to the overview', () => {
        expect(hasActionTypeDescription('ai_conversation')).toBe(true);
        expect(getActionTypeDescription('ai_conversation')).toMatch(/content-free/i);
        expect(getActionTypeDescription('some_unknown_type')).toBe(PROVENANCE_ENVELOPE_OVERVIEW);
    });
});

describe('normalizeMintStatus — the 17-value enum collapses correctly', () => {
    it('maps every value into the small display set', () => {
        expect(normalizeMintStatus('eligible')).toBe('earning');
        expect(normalizeMintStatus('minting')).toBe('earning');
        expect(normalizeMintStatus('minted')).toBe('minted');
        expect(normalizeMintStatus('deferred')).toBe('pending');
        expect(normalizeMintStatus('epoch_headroom_deferred')).toBe('pending');
        expect(normalizeMintStatus('record_only')).toBe('record_only');
        expect(normalizeMintStatus('ineligible')).toBe('record_only');
        expect(normalizeMintStatus('corroborated_duplicate')).toBe('record_only');
        expect(normalizeMintStatus('x402_unverified')).toBe('record_only');
    });
    it('null / unrecognized → unknown (no earning claim)', () => {
        expect(normalizeMintStatus(null)).toBe('unknown');
        expect(normalizeMintStatus(undefined)).toBe('unknown');
        expect(normalizeMintStatus('some_new_status')).toBe('unknown');
    });
});

describe('buildEarningChip — NEVER shows a record-points number (money safety)', () => {
    it('record_only → "No separate mint", never a number', () => {
        const chip = buildEarningChip({ mintStatus: 'record_only', currentSettlementProjectionPVT: null });
        expect(chip?.label).toBe('No separate mint');
        expect(chip?.label).not.toMatch(/PVT/);
    });
    it('eligible with a projection → shows the projection amount; without → no number', () => {
        expect(buildEarningChip({ mintStatus: 'eligible', currentSettlementProjectionPVT: '1.2' })?.label)
            .toBe('Earns ~1.2 PVT · pending');
        expect(buildEarningChip({ mintStatus: 'eligible', currentSettlementProjectionPVT: null })?.label)
            .toBe('Earning · pending');
        // "0.0"/"0" are treated as no-amount, never shown.
        expect(buildEarningChip({ mintStatus: 'eligible', currentSettlementProjectionPVT: '0.0' })?.label)
            .toBe('Earning · pending');
    });
    it('minted → "Minted ✓"; pending → "Pending"; unknown → null (no chip)', () => {
        expect(buildEarningChip({ mintStatus: 'minted' })?.label).toBe('Minted ✓');
        expect(buildEarningChip({ mintStatus: 'deferred' })?.label).toBe('Pending');
        expect(buildEarningChip({ mintStatus: null })).toBeNull();
    });
});

interface Row { peId: string; actionType: string; commitSha: string | null }

describe('groupByCommit — collapse cross-witnessed commits (#5)', () => {
    const rows: Row[] = [
        { peId: 'p1', actionType: 'ai_conversation', commitSha: null },
        { peId: 'p2', actionType: 'coding_session', commitSha: 'abc1234def' },
        { peId: 'p3', actionType: 'service:github_commit', commitSha: 'abc1234def' },
        { peId: 'p4', actionType: 'send', commitSha: null },
        { peId: 'p5', actionType: 'coding_session', commitSha: 'lonecommit' },
    ];
    it('folds same-SHA PEs into one commit row, preserves order, singles pass through', () => {
        const grouped = groupByCommit(rows, (r) => r.commitSha);
        // p1 (single), the abc commit group (folded at p2's position), p4 (single),
        // p5 (lone commit → single, nothing to collapse).
        expect(grouped.map((g) => g.kind)).toEqual(['single', 'commit', 'single', 'single']);
        const commitRow = grouped[1];
        expect(commitRow.kind).toBe('commit');
        if (commitRow.kind === 'commit') {
            expect(commitRow.group.items.map((r) => r.peId)).toEqual(['p2', 'p3']);
            expect(commitRow.group.commitSha).toBe('abc1234def');
        }
    });
    it('witness phrasing + short sha + best disposition', () => {
        expect(describeCommitWitnesses(['coding_session', 'service:github_commit']))
            .toBe('witnessed locally + by GitHub');
        expect(shortSha('abc1234def')).toBe('abc1234');
        expect(bestDisposition(['record_only', 'earning', 'pending'])).toBe('earning');
        expect(bestDisposition(['pending', 'minted', 'earning'])).toBe('minted');
    });
});
