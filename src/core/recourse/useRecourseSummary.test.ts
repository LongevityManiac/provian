import { describe, expect, it, vi } from 'vitest';
import { summarizeRecourse } from './useRecourseSummary';

vi.mock('./service', () => ({ readRecourseOverview: vi.fn() }));
vi.mock('../../store/walletStore', () => ({ useWalletStore: {} }));

const member = { membershipState: 'available', enrolled: true, grace: false, unpaidAtomic: '0' } as const;

describe('wallet Recourse summary', () => {
    it('distinguishes non-membership from a failed check', () => {
        const plain = { label: 'recourse.title', icon: 'shield-outline', month: null };
        const unavailable = { ...plain, detail: 'recourse.membershipUnavailable' };
        expect(summarizeRecourse(null)).toEqual(unavailable);
        expect(summarizeRecourse({ ...member, enrolled: false, unpaidAtomic: '1' })).toEqual(plain);
        expect(summarizeRecourse({ ...member, membershipState: 'unavailable' })).toEqual(unavailable);
    });

    it('keeps a pending join unchecked and exposes a separate continuation label', () => {
        expect(summarizeRecourse({ ...member, membershipState: 'in_progress', membershipTransition: 'join' })).toEqual({
            label: 'recourse.title', detail: 'recourse.continueJoining', icon: 'shield-outline', month: null,
        });
    });

    it('shows protection through grace and distinguishes a due month from a current member', () => {
        expect(summarizeRecourse(member)).toEqual({
            label: 'recourse.active', icon: 'shield-checkmark-outline', month: null,
        });
        expect(summarizeRecourse({ ...member, unpaidAtomic: '1' }).month).toBe('due');
        expect(summarizeRecourse({ ...member, grace: true, unpaidAtomic: '1' })).toEqual({
            label: 'recourse.active', icon: 'shield-checkmark-outline', month: 'grace',
        });
    });
});
