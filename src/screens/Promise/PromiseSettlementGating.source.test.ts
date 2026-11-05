/**
 * P4-11 (Pass-4 reachability): PromiseDetail and PromiseList rendered
 * Mark Fulfilled / Dispute / Mark Broken for `pending` promises, but
 * pending -> fulfilled/broken/disputed all throw assertValidTransition, so
 * every one Alert'd "Failed to update promise" with no valid action. Settlement
 * actions must be gated on `accepted`; pending promises show accept/decline
 * (recipient) or an awaiting note (creator).
 *
 * The Vitest harness has no React renderer wired up, so this pins the fix at the
 * source level (same strategy as CommonsDashboard.test.ts / CommonsGovernance).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DETAIL = readFileSync(resolve(__dirname, 'PromiseDetailScreen.tsx'), 'utf8');
const LIST = readFileSync(resolve(__dirname, 'PromiseListScreen.tsx'), 'utf8');

describe('PromiseDetailScreen - settlement gating (P4-11)', () => {
    it('gates the settlement block (Dispute / Mark Broken) on accepted status', () => {
        expect(DETAIL).toContain("{promise.status === 'accepted' && (");
    });

    it('no longer shows settlement actions for every non-recipient (the old !isRecipientPending gate)', () => {
        expect(DETAIL).not.toContain('{!isRecipientPending && (');
    });

    it('shows a creator-pending awaiting note instead of a throwing Fulfill button', () => {
        expect(DETAIL).toContain("promise.status === 'pending' ?");
        expect(DETAIL).toContain("t('promise.awaitingAcceptance'");
    });

    it('keeps the P4-06 recipient accept/decline branch first', () => {
        expect(DETAIL).toContain('isRecipientPending ?');
        expect(DETAIL).toContain("t('promise.accept')");
        expect(DETAIL).toContain("t('promise.decline')");
    });
});

describe('PromiseListScreen - long-press action sheet gating (P4-11)', () => {
    it('opens the Fulfill/Dispute action sheet only for accepted promises', () => {
        expect(LIST).toContain("promise.status === 'accepted'");
    });

    it('no longer opens the throwing action sheet for pending promises', () => {
        expect(LIST).not.toContain("['pending', 'accepted'].includes(promise.status)");
    });
});
