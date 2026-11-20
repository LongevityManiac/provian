import { useCallback, useEffect, useRef, useState } from 'react';
import { useIsFocused } from '@react-navigation/native';
import { useWalletStore } from '../../store/walletStore';
import { getLastRecourseOverview, readRecourseOverview, type RecourseView } from './service';

type Membership = Pick<RecourseView, 'membershipState' | 'membershipTransition' | 'membershipApprovalPending' | 'enrolled' | 'grace' | 'unpaidAtomic'>;
type Summary = {
    label: 'recourse.title' | 'recourse.active';
    detail?: 'recourse.membershipUnavailable' | 'recourse.membershipInProgress' | 'recourse.continueJoining';
    icon: 'shield-outline' | 'shield-checkmark-outline';
    month: 'due' | 'grace' | null;
};

const RECOURSE: Summary = { label: 'recourse.title', icon: 'shield-outline', month: null };
export function summarizeRecourse(view: Membership | null): Summary {
    if (view?.membershipState === 'in_progress') return {
        ...RECOURSE, detail: view.membershipTransition === 'join' && !view.membershipApprovalPending
            ? 'recourse.continueJoining' : 'recourse.membershipInProgress',
    };
    if (view?.membershipState !== 'available') return { ...RECOURSE, detail: 'recourse.membershipUnavailable' };
    if (!view.enrolled) return RECOURSE;
    return {
        label: 'recourse.active',
        icon: 'shield-checkmark-outline',
        month: view.grace ? 'grace' : view.unpaidAtomic !== '0' ? 'due' : null,
    };
}

export function useRecourseSummary(wallet: string | null) {
    const focused = useIsFocused();
    const [read, setRead] = useState<{ wallet: string; summary: Summary }>();
    const latest = useRef(0);
    const refresh = useCallback(async () => {
        if (!wallet || useWalletStore.getState().address !== wallet) return;
        const check = ++latest.current;
        const view = await readRecourseOverview().catch(() => null);
        if (latest.current === check && useWalletStore.getState().address === wallet) {
            setRead(previous => ({
                wallet,
                summary: view === null && previous?.wallet === wallet &&
                    (previous.summary.detail === 'recourse.continueJoining' || previous.summary.detail === 'recourse.membershipInProgress')
                    ? previous.summary : summarizeRecourse(view),
            }));
        }
    }, [wallet]);
    const cached = getLastRecourseOverview(wallet);
    const summary = read?.wallet === wallet ? read.summary : cached ? summarizeRecourse(cached) : RECOURSE;
    useEffect(() => {
        if (!focused || !summary.detail) return;
        const timer = setTimeout(() => { void refresh(); }, summary.detail === 'recourse.membershipUnavailable' ? 30_000 : 8_000);
        return () => clearTimeout(timer);
    }, [focused, read, refresh, summary.detail]);
    return { summary, refresh };
}
