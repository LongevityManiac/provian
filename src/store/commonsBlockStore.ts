/**
 * Commons Block — hide an author's content on this device.
 *
 * Blocking is local and private: the blocked author is not told, nothing is sent to Provian, and
 * nothing is signed or burned. A blocked author's posts, replies and profile are hidden on this
 * phone until they are unblocked (Settings → Blocked in the Commons, or their profile). The list is
 * not sensitive, so it lives in AsyncStorage.
 */
import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const COMMONS_BLOCKED_KEY = '@provian_commons_blocked_v1';

export interface BlockedAuthor {
    readonly walletId: string;
    readonly name: string | null;
    readonly blockedAtMs: number;
}

interface BlockState {
    readonly blocked: Readonly<Record<string, BlockedAuthor>>;
    readonly loaded: boolean;
    load(): Promise<void>;
    block(walletId: string, name: string | null): Promise<void>;
    unblock(walletId: string): Promise<void>;
}

export function parseBlocked(raw: string | null): Record<string, BlockedAuthor> {
    if (!raw) return {};
    try {
        const list = JSON.parse(raw) as unknown;
        if (!Array.isArray(list)) return {};
        const out: Record<string, BlockedAuthor> = {};
        for (const item of list) {
            const b = item as Partial<BlockedAuthor>;
            if (typeof b.walletId !== 'string' || b.walletId.length === 0) continue;
            out[b.walletId] = { walletId: b.walletId, name: typeof b.name === 'string' ? b.name : null, blockedAtMs: typeof b.blockedAtMs === 'number' ? b.blockedAtMs : 0 };
        }
        return out;
    } catch {
        return {};
    }
}

async function persist(blocked: Record<string, BlockedAuthor>): Promise<void> {
    await AsyncStorage.setItem(COMMONS_BLOCKED_KEY, JSON.stringify(Object.values(blocked)));
}

export const useCommonsBlockStore = create<BlockState>((set, get) => ({
    blocked: {},
    loaded: false,
    load: async () => {
        const raw = await AsyncStorage.getItem(COMMONS_BLOCKED_KEY).catch(() => null);
        set({ blocked: parseBlocked(raw), loaded: true });
    },
    block: async (walletId, name) => {
        const next = { ...get().blocked, [walletId]: { walletId, name, blockedAtMs: Date.now() } };
        set({ blocked: next });
        await persist(next);
    },
    unblock: async (walletId) => {
        const next = { ...get().blocked };
        delete next[walletId];
        set({ blocked: next });
        await persist(next);
    },
}));

/** Items whose author is not blocked (posts, replies, threads — anything with an author wallet). */
export function withoutBlocked<T extends { readonly author_wallet_id: string }>(
    items: readonly T[],
    blocked: Readonly<Record<string, BlockedAuthor>>,
): T[] {
    return items.filter((item) => blocked[item.author_wallet_id] === undefined);
}

/** Directory entries (profiles, agents) that are not a blocked author. */
export function profilesWithoutBlocked<T extends { readonly wallet_id: string }>(
    profiles: readonly T[],
    blocked: Readonly<Record<string, BlockedAuthor>>,
): T[] {
    return profiles.filter((profile) => blocked[profile.wallet_id] === undefined);
}
