/**
 * Abundance → Recent History shows the same records as Your Proof Trail, newest first, across
 * every source. The defect: every PE the phone holds was listed before any
 * relay row, so a computer's work from today sat below the phone's oldest PE while Proof Trail
 * (which sorts both sources together) showed it at the top.
 */
import { describe, it, expect } from 'vitest';
import type { PVTHistoryEntry } from '../../../services/RelayAPIService';
import { RecentHistoryPager, compareNewestFirst, type RelayHistoryFetch } from '../recentHistory';

function row(peId: string, timestamp: number, extra: Partial<PVTHistoryEntry> = {}): PVTHistoryEntry {
    return {
        peId,
        actionType: 'coding_session',
        timestamp,
        attestationDepth: 'software',
        mintStatus: 'eligible',
        commitSha: null,
        recordPoints: '1.0',
        recordPointsAtomic: null,
        currentSettlementProjectionPVT: null,
        currentSettlementProjectionAtomic: null,
        exactGenesisReservedGrossPVT: '0.0',
        exactGenesisReservedGrossAtomic: null,
        hash: `h_${peId}`,
        hidden: false,
        ...extra,
    } as PVTHistoryEntry;
}

/**
 * The relay's `/v1/pvt/history`: newest first, paged by keyset cursor (the last row's time and id,
 * as `listRecentActKeys` encodes it). `live` is read at every call, so a test can add acts at the
 * top between two reads.
 */
function relayOf(live: PVTHistoryEntry[], calls: (string | null)[] = []): RelayHistoryFetch {
    return async (limit, cursor) => {
        calls.push(cursor);
        const sorted = [...live].sort(compareNewestFirst);
        const start = cursor === null ? 0 : sorted.findIndex((e) => `${e.timestamp}:${e.peId}` === cursor) + 1;
        const entries = sorted.slice(start, start + limit);
        const hasMore = start + limit < sorted.length;
        const last = entries[entries.length - 1];
        return { entries, hasMore, total: sorted.length, nextCursor: hasMore && last ? `${last.timestamp}:${last.peId}` : null };
    };
}

/** Your Proof Trail's order: both sources together, newest first (ActivityLogScreen). */
function proofTrail(local: PVTHistoryEntry[], relay: PVTHistoryEntry[]): PVTHistoryEntry[] {
    const ids = new Set(local.map((e) => e.peId));
    return [...local, ...relay.filter((e) => !ids.has(e.peId))].sort(compareNewestFirst);
}

async function readAll(pager: RecentHistoryPager): Promise<PVTHistoryEntry[]> {
    let view = await pager.first();
    for (let guard = 0; view.hasMore && guard < 100; guard++) view = await pager.more();
    return view.entries;
}

describe('RecentHistoryPager', () => {
    // The phone holds yesterday's PEs; the computer's coding acts from today are on the relay.
    const phone = Array.from({ length: 15 }, (_, i) => row(`phone_${i}`, 1_000 + i));
    const computer = Array.from({ length: 30 }, (_, i) => row(`pe_m_computer_${i}`, 5_000 + i));

    it('RED→GREEN: the record at the top of Proof Trail is at the top of Recent History', async () => {
        const view = await new RecentHistoryPager(phone, relayOf(computer), 10).first();
        const trail = proofTrail(phone, computer);
        expect(view.entries[0].peId).toBe(trail[0].peId);
        expect(view.entries[0].peId).toBe('pe_m_computer_29');
        expect(view.entries.map((e) => e.peId)).toEqual(trail.slice(0, 10).map((e) => e.peId));
    });

    it('every page, read to the end, is Proof Trail\'s list in Proof Trail\'s order, once each', async () => {
        // Interleaved times: phone and computer acts alternate through the day.
        const local = Array.from({ length: 12 }, (_, i) => row(`phone_${i}`, 10 * i + 5));
        const relay = Array.from({ length: 23 }, (_, i) => row(`pe_m_${i}`, 7 * i));
        const all = await readAll(new RecentHistoryPager(local, relayOf(relay), 4, 5));
        expect(all.map((e) => e.peId)).toEqual(proofTrail(local, relay).map((e) => e.peId));
    });

    it('never shows a phone PE before a newer relay row that has not been read yet', async () => {
        const local = [row('phone_old', 50)];
        const relay = Array.from({ length: 20 }, (_, i) => row(`pe_m_${i}`, 100 + i));
        const pager = new RecentHistoryPager(local, relayOf(relay), 5, 5);
        const first = await pager.first();
        expect(first.entries.map((e) => e.peId)).toEqual(['pe_m_19', 'pe_m_18', 'pe_m_17', 'pe_m_16', 'pe_m_15']);
        expect(first.hasMore).toBe(true);
        const all = await readAll(new RecentHistoryPager(local, relayOf(relay), 5, 5));
        expect(all[all.length - 1].peId).toBe('phone_old');
    });

    it('a phone PE newer than every relay row is first', async () => {
        const view = await new RecentHistoryPager([row('phone_now', 9_999)], relayOf(computer), 10).first();
        expect(view.entries[0].peId).toBe('phone_now');
    });

    it('a relay row that is the same act as a phone PE (hash or client id) is listed once', async () => {
        const local = [row('uuid_a', 200, { hash: 'aa' }), row('uuid_b', 100, { hash: 'bb' })];
        const relay = [
            row('pe_m_a', 200, { hash: 'aa' }),
            row('pe_m_b', 100, { hash: 'zz', clientPeId: 'uuid_b' }),
            row('pe_m_c', 300),
        ];
        const all = await readAll(new RecentHistoryPager(local, relayOf(relay), 10));
        expect(all.map((e) => e.peId)).toEqual(['pe_m_c', 'uuid_a', 'uuid_b']);
    });

    it('relay unreadable: the phone\'s PEs still show; with none, the view reports failure', async () => {
        const down: RelayHistoryFetch = async () => null;
        const withLocal = await new RecentHistoryPager(phone, down, 10).first();
        expect(withLocal.failed).toBe(false);
        expect(withLocal.entries[0].peId).toBe('phone_14');
        expect((await new RecentHistoryPager([], down, 10).first()).failed).toBe(true);
    });

    it(' : a relay failure on a later page keeps the rows already shown', async () => {
        const relay = Array.from({ length: 120 }, (_, i) => row(`pe_m_${i}`, 10_000 - i));
        const ok = relayOf(relay);
        const flaky: RelayHistoryFetch = async (limit, cursor) => (cursor === null ? ok(limit, cursor) : null);
        const pager = new RecentHistoryPager([], flaky, 10, 50);
        let view = await pager.first();
        for (let i = 0; i < 5; i++) view = await pager.more();
        expect(view.failed).toBe(false);
        expect(view.entries).toHaveLength(50);
        expect(view.entries[0].peId).toBe('pe_m_0');
        expect(view.hasMore).toBe(false);
    });

    it(' : acts that arrive at the top between two reads never end or reorder the read', async () => {
        const live = Array.from({ length: 200 }, (_, i) => row(`pe_m_${i}`, 10_000 - i));
        const pager = new RecentHistoryPager([row('phone_old', 10)], relayOf(live), 50, 50);
        await pager.first();
        // A computer's batch of 60 acts lands before the next tap.
        for (let i = 0; i < 60; i++) live.push(row(`pe_m_new_${i}`, 20_000 + i));
        let view = await pager.more();
        for (let guard = 0; view.hasMore && guard < 20; guard++) view = await pager.more();
        const ids = view.entries.map((e) => e.peId);
        // Every original row is listed once, in order, and the phone PE (oldest) is last.
        expect(ids.filter((id) => id.startsWith('pe_m_') && !id.startsWith('pe_m_new_'))).toEqual(live.slice(0, 200).map((e) => e.peId));
        expect(ids[ids.length - 1]).toBe('phone_old');
        expect(new Set(ids).size).toBe(ids.length);
    });

    it(' : a relay that answers the same page again (cursor ignored) ends the read after one more request', async () => {
        const rows = Array.from({ length: 10 }, (_, i) => row(`pe_m_${i}`, 10_000 - i));
        const calls: (string | null)[] = [];
        const stuck: RelayHistoryFetch = async (limit, cursor) => {
            calls.push(cursor);
            return { entries: rows.slice(0, limit), hasMore: true, total: 5_000, nextCursor: 'same' };
        };
        const all = await readAll(new RecentHistoryPager([], stuck, 10, 10));
        expect(all.map((e) => e.peId)).toEqual(rows.map((e) => e.peId));
        expect(calls.length).toBe(2);
    });

    it('stops reading the relay at its end (no endless fetch on an empty page)', async () => {
        const calls: (string | null)[] = [];
        const view = await new RecentHistoryPager(phone, relayOf([], calls), 10).first();
        expect(calls).toEqual([null]);
        expect(view.hasMore).toBe(true);
        expect((await readAll(new RecentHistoryPager(phone, relayOf([]), 10))).length).toBe(15);
    });
});
