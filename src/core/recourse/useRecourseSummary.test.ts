import { describe, expect, it, vi } from 'vitest';
import { summarizeRecourse } from './useRecourseSummary';

vi.mock('./service', () => ({ readRecourseView: vi.fn() }));
vi.mock('../../store/walletStore', () => ({ useWalletStore: {} }));

const member = { membershipState: 'available', enrolled: true, grace: false, unpaidAtomic: '0' } as const;

describe('wallet Recourse summary', () => {
    it('shows the plain shield for a non-member or an unconfirmed membership', () => {
        const plain = { label: 'recourse.title', icon: 'shield-outline', month: null };
        expect(summarizeRecourse(null)).toEqual(plain);
        expect(summarizeRecourse({ ...member, enrolled: false, unpaidAtomic: '1' })).toEqual(plain);
        expect(summarizeRecourse({ ...member, membershipState: 'unavailable' })).toEqual(plain);
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
