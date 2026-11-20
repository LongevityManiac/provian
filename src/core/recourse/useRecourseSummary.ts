import { useCallback, useRef, useState } from 'react';
import { useWalletStore } from '../../store/walletStore';
import { readRecourseOverview, type RecourseView } from './service';

type Membership = Pick<RecourseView, 'membershipState' | 'enrolled' | 'grace' | 'unpaidAtomic'>;
type Summary = {
    label: 'recourse.title' | 'recourse.active' | 'recourse.membershipUnavailable';
    icon: 'shield-outline' | 'shield-checkmark-outline';
    month: 'due' | 'grace' | null;
};

const RECOURSE: Summary = { label: 'recourse.title', icon: 'shield-outline', month: null };
const UNAVAILABLE: Summary = { ...RECOURSE, label: 'recourse.membershipUnavailable' };

export function summarizeRecourse(view: Membership | null): Summary {
    if (view?.membershipState !== 'available') return UNAVAILABLE;
    if (!view.enrolled) return RECOURSE;
    return {
        label: 'recourse.active',
        icon: 'shield-checkmark-outline',
        month: view.grace ? 'grace' : view.unpaidAtomic !== '0' ? 'due' : null,
    };
}

export function useRecourseSummary(wallet: string | null) {
    const [read, setRead] = useState<{ wallet: string; summary: Summary }>();
    const latest = useRef(0);
    const refresh = useCallback(async () => {
        if (!wallet || useWalletStore.getState().address !== wallet) return;
        const check = ++latest.current;
        const view = await readRecourseOverview().catch(() => null);
        if (latest.current === check && useWalletStore.getState().address === wallet) {
            setRead({ wallet, summary: summarizeRecourse(view) });
        }
    }, [wallet]);
    return { summary: read?.wallet === wallet ? read.summary : RECOURSE, refresh };
}
