/**
 * the "Adverse standing event" label on a record follows the relay's one counting rule
 * (`countsAsAdverse`), so a record is never labelled adverse when it adds nothing to Standing.
 */
import { describe, it, expect } from 'vitest';
import { extractPeTrustDetail, isAdverseStandingRow } from './peTrustDetail';

const WATCHER = { standing: 'adverse', canonical_event_id: 'base:0xabc:3' };

describe('adverse Standing label', () => {
    it("a person's one-sided broken promise marks nobody (RED: it was labelled adverse)", () => {
        expect(extractPeTrustDetail({ action_type: 'promise_broken', metadata: {} }).isAdverse).toBe(false);
    });

    it('types that never counted toward Standing are not labelled (RED: each was in the old list)', () => {
        for (const t of ['escrow_disputed', 'bond_claim_filed', 'court_ruling_against', 'invalidation', 'handshake_invalidated', 'dispute_filed']) {
            expect(isAdverseStandingRow(t, WATCHER)).toBe(false);
        }
    });

    it('a bond slash is one event: the slash is labelled, its own autonomy downgrade is not', () => {
        expect(extractPeTrustDetail({ action_type: 'bond_slashed', metadata: WATCHER })).toMatchObject({ isAdverse: true, adverseType: 'bond_slashed' });
        expect(isAdverseStandingRow('bond_autonomy_downgraded', { ...WATCHER, paired_bond_slash: true })).toBe(false);
        expect(isAdverseStandingRow('bond_autonomy_downgraded', WATCHER)).toBe(true);
        // A relay-composed row of a chain-witnessed type is a record, not the event.
        expect(isAdverseStandingRow('bond_slashed', {})).toBe(false);
    });

    it('a hire dispute is labelled on the losing party only', () => {
        const refund = { resolution: 'refund_to_depositor', hire_job_id: 'hjob1' };
        expect(isAdverseStandingRow('escrow_resolved', { ...refund, role: 'recipient' })).toBe(true);
        expect(isAdverseStandingRow('escrow_resolved', { ...refund, role: 'depositor' })).toBe(false);
        expect(isAdverseStandingRow('escrow_resolved', { role: 'depositor', resolution: 'release_to_recipient', hire_job_id: 'hjob1' })).toBe(true);
        // Not a hire: a record only.
        expect(isAdverseStandingRow('escrow_resolved', { role: 'recipient', resolution: 'refund_to_depositor' })).toBe(false);
    });

    it('an upheld challenge is labelled on the challenged party only', () => {
        expect(isAdverseStandingRow('commons_challenge_resolved', { role: 'challenged', status: 'upheld', challenge_id: 'c1' })).toBe(true);
        expect(isAdverseStandingRow('commons_challenge_resolved', { role: 'challenger', status: 'upheld', challenge_id: 'c1' })).toBe(false);
        expect(isAdverseStandingRow('commons_challenge_resolved', { role: 'challenged', status: 'answered', challenge_id: 'c1' })).toBe(false);
    });

    it('a promise default is labelled on the borrower, never the lender; a verdict off Base on the loser', () => {
        expect(isAdverseStandingRow('promise_defaulted', { role: 'borrower' })).toBe(true);
        expect(isAdverseStandingRow('promise_defaulted', { role: 'lender' })).toBe(false);
        expect(isAdverseStandingRow('court_verdict', { role: 'recipient', verdict: 'refund_to_depositor', chain_id: 42161 })).toBe(true);
        expect(isAdverseStandingRow('court_verdict', { role: 'recipient', verdict: 'refund_to_depositor', chain_id: 8453 })).toBe(false);
    });

    it('an unknown shape gets no label', () => {
        expect(isAdverseStandingRow(null, null)).toBe(false);
        expect(extractPeTrustDetail({ action_type: 'bond_slashed' }).isAdverse).toBe(false);
    });
});
