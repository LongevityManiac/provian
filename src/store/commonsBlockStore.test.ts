import { describe, it, expect, vi, beforeEach } from 'vitest';

const mem = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: async (k: string) => mem.get(k) ?? null,
        setItem: async (k: string, v: string) => { mem.set(k, v); },
    },
}));

import { COMMONS_BLOCKED_KEY, parseBlocked, useCommonsBlockStore, withoutBlocked, profilesWithoutBlocked } from './commonsBlockStore';

describe('Block hides an author on this phone', () => {
    beforeEach(async () => {
        mem.clear();
        await useCommonsBlockStore.getState().load();
    });

    it("a blocked author's posts and replies are hidden; everyone else's stay", async () => {
        const posts = [{ author_wallet_id: 'a', id: 1 }, { author_wallet_id: 'b', id: 2 }, { author_wallet_id: 'a', id: 3 }];
        expect(withoutBlocked(posts, useCommonsBlockStore.getState().blocked)).toHaveLength(3);
        await useCommonsBlockStore.getState().block('a', 'Spammer');
        expect(withoutBlocked(posts, useCommonsBlockStore.getState().blocked).map((p) => p.id)).toEqual([2]);
        await useCommonsBlockStore.getState().unblock('a');
        expect(withoutBlocked(posts, useCommonsBlockStore.getState().blocked)).toHaveLength(3);
    });

    it("a blocked author drops out of the People directory too (RED: an unfiltered list keeps them)", async () => {
        const people = [{ wallet_id: 'a', n: 1 }, { wallet_id: 'b', n: 2 }];
        await useCommonsBlockStore.getState().block('a', 'Spammer');
        expect(profilesWithoutBlocked(people, useCommonsBlockStore.getState().blocked).map((p) => p.n)).toEqual([2]);
    });

    it('the block survives a restart (it is persisted), and a malformed record reads as no blocks', async () => {
        await useCommonsBlockStore.getState().block('a', null);
        useCommonsBlockStore.setState({ blocked: {}, loaded: false });
        await useCommonsBlockStore.getState().load();
        expect(Object.keys(useCommonsBlockStore.getState().blocked)).toEqual(['a']);
        expect(JSON.parse(mem.get(COMMONS_BLOCKED_KEY) ?? '[]')).toHaveLength(1);
        expect(parseBlocked('{not json')).toEqual({});
        expect(parseBlocked('[{"walletId":""},{"x":1}]')).toEqual({});
    });
});
