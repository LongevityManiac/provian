/**
 * The app-wide half of pending thread drafts : while the app is open, every 30 s and
 * whenever it returns to the foreground, send any kept draft whose recipient now has a message key —
 * so a message written before the other side turned on messaging goes out on its own, wherever the
 * person is in the app. Never prompts (pendingThreadDrafts.ts).
 */
import React from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import useCommonsStore from '../../store/commonsStore';
import { flushPendingThreadDrafts } from './pendingThreadDrafts';

const POLL_MS = 30_000;

export function usePendingThreadDraftFlush(): void {
    const myId = useCommonsStore((s) => s.profile?.wallet_id ?? null);
    React.useEffect(() => {
        if (!myId) return;
        const flush = () => { void flushPendingThreadDrafts(myId); };
        flush();
        const id = setInterval(flush, POLL_MS);
        const sub = AppState.addEventListener('change', (state: AppStateStatus) => { if (state === 'active') flush(); });
        return () => { clearInterval(id); sub.remove(); };
    }, [myId]);
}
