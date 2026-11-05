/**
 * rekeyInFlight — a per-agent guard so a re-key cannot be launched twice.
 *
 * the operator re-keyed Atlas, then re-keyed it AGAIN before restoring the first — the second re-key
 * rotated the address a second time and invalidated the API credentials issued by the first,
 * costing a manual credential reissue. This guard refuses a second re-key while one is in flight
 * (running on this device) OR within a short cooldown after a successful one (so the first re-key is
 * restored on the agent's host before another is started). It fails OPEN after a staleness window so
 * a crashed/abandoned re-key never permanently blocks recovery.
 *
 * State is in-memory (survives navigation) and mirrored to AsyncStorage (survives an app restart
 * within the window). A failed re-key clears the state so the human can immediately retry.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const storageKey = (walletId: string): string => `@provian_rekey_state_${walletId}`;

/** A running re-key auto-clears after this long, so a crash never strands recovery. */
const IN_FLIGHT_STALE_MS = 15 * 60 * 1000;
/** After a successful re-key, hold new re-keys this long (restore the first on the host first). */
const COOLDOWN_MS = 10 * 60 * 1000;

interface RekeyState {
    readonly phase: 'in_flight' | 'completed';
    readonly at: number;
}

const mem = new Map<string, RekeyState>();

export type RekeyBlock =
    | { readonly blocked: false }
    | { readonly blocked: true; readonly reason: 'in_flight' | 'cooldown' };

async function persist(walletId: string, state: RekeyState | null): Promise<void> {
    try {
        if (state) await AsyncStorage.setItem(storageKey(walletId), JSON.stringify(state));
        else await AsyncStorage.removeItem(storageKey(walletId));
    } catch {
        // best-effort — the in-memory map still guards within the session.
    }
}

async function read(walletId: string): Promise<RekeyState | null> {
    const inMem = mem.get(walletId);
    if (inMem) return inMem;
    try {
        const raw = await AsyncStorage.getItem(storageKey(walletId));
        if (raw) {
            const parsed = JSON.parse(raw) as RekeyState;
            if (parsed && (parsed.phase === 'in_flight' || parsed.phase === 'completed') && typeof parsed.at === 'number') {
                mem.set(walletId, parsed);
                return parsed;
            }
        }
    } catch {
        // ignore — treat as no state.
    }
    return null;
}

/** Mark a re-key as started (call before the biometric gate). */
export async function beginRekey(walletId: string): Promise<void> {
    const state: RekeyState = { phase: 'in_flight', at: Date.now() };
    mem.set(walletId, state);
    await persist(walletId, state);
}

/** Mark a re-key as successfully completed → starts the cooldown. */
export async function completeRekey(walletId: string): Promise<void> {
    const state: RekeyState = { phase: 'completed', at: Date.now() };
    mem.set(walletId, state);
    await persist(walletId, state);
}

/** Clear the guard (a failed/abandoned re-key) so the human can retry immediately. */
export async function clearRekey(walletId: string): Promise<void> {
    mem.delete(walletId);
    await persist(walletId, null);
}

/** Whether a NEW re-key for this agent should be refused right now, and why. */
export async function checkRekeyBlocked(walletId: string): Promise<RekeyBlock> {
    const state = await read(walletId);
    if (!state) return { blocked: false };
    const age = Date.now() - state.at;
    if (state.phase === 'in_flight') {
        if (age > IN_FLIGHT_STALE_MS) {
            await clearRekey(walletId);
            return { blocked: false };
        }
        return { blocked: true, reason: 'in_flight' };
    }
    // completed → cooldown
    if (age > COOLDOWN_MS) {
        await clearRekey(walletId);
        return { blocked: false };
    }
    return { blocked: true, reason: 'cooldown' };
}
