/**
 * Abundance → Recent History: the same records as Your Proof Trail, newest first, across every
 * source.
 *
 * Two sources feed the list: the PEs this phone holds (`localHistoryEntries`) and the relay's
 * priced history (`/v1/pvt/history`), which also carries the person's acts from their other
 * devices, such as a computer coding all day. The list used to show every local PE before any
 * relay row, so a computer's newest work sat below the phone's oldest PE. The pager merges the two
 * by time instead.
 *
 * The relay is read a page at a time, newest first, by its keyset cursor (so acts that arrive at
 * the top between two reads never shift a page). Until it has been read to the end, a local PE
 * older than the oldest relay row read so far is held back: a relay row not yet read could be newer
 * than it, and showing it would put a record out of order.
 */

import type { PVTHistoryEntry } from '../../services/RelayAPIService';

export interface RelayHistoryPage {
    readonly entries: readonly PVTHistoryEntry[];
    readonly hasMore: boolean;
    readonly total: number;
    /** The relay's keyset cursor for the page after this one; null or absent at the end. */
    readonly nextCursor?: string | null;
}

/** Reads one relay page: the first with `cursor` null, each later one with the cursor the page before it returned. */
export type RelayHistoryFetch = (limit: number, cursor: string | null) => Promise<RelayHistoryPage | null>;

export interface RecentHistoryView {
    readonly entries: PVTHistoryEntry[];
    readonly hasMore: boolean;
    readonly total: number;
    /** Nothing to show: no local PE and the relay could not be read. */
    readonly failed: boolean;
}

/** Newest first; equal times fall back to the id so the order is stable. */
export function compareNewestFirst(a: PVTHistoryEntry, b: PVTHistoryEntry): number {
    return b.timestamp - a.timestamp || (a.peId < b.peId ? -1 : a.peId > b.peId ? 1 : 0);
}

export class RecentHistoryPager {
    private readonly local: PVTHistoryEntry[];
    private readonly localKeys = new Set<string>();
    private readonly relay: PVTHistoryEntry[] = [];
    private readonly relayIds = new Set<string>();
    private relayCursor: string | null = null;
    private relayPagesRead = 0;
    private relayDone = false;
    private relayTotal = 0;
    /** The relay's FIRST page could not be read (a later page failing keeps what is shown). */
    private firstPageFailed = false;
    /** Every relay id read so far, including rows that are the same act as a phone PE. */
    private readonly relaySeen = new Set<string>();
    /** The oldest relay row read so far (deduplicated or not): nothing older is shown before the relay is read past it. */
    private frontier: PVTHistoryEntry | null = null;
    private limit = 0;

    constructor(
        local: readonly PVTHistoryEntry[],
        private readonly fetchRelay: RelayHistoryFetch,
        private readonly pageSize: number,
        private readonly relayPageSize: number = pageSize,
    ) {
        this.local = [...local].sort(compareNewestFirst);
        // A relay row is the SAME act as a local PE when its hash, its client pe_id or its id
        // matches (relay ids are `pe_m_…`, local ids the device's uuid).
        for (const e of this.local) {
            this.localKeys.add(e.peId);
            if (e.hash) this.localKeys.add(e.hash);
        }
    }

    /** The first page. */
    async first(): Promise<RecentHistoryView> {
        this.limit = this.pageSize;
        await this.fill();
        return this.view();
    }

    /** One more page. */
    async more(): Promise<RecentHistoryView> {
        this.limit += this.pageSize;
        await this.fill();
        return this.view();
    }

    private sameAsLocal(e: PVTHistoryEntry): boolean {
        return this.localKeys.has(e.peId)
            || (!!e.hash && this.localKeys.has(e.hash))
            || (!!e.clientPeId && this.localKeys.has(e.clientPeId));
    }

    private async fetchNext(): Promise<void> {
        const data = await this.fetchRelay(this.relayPageSize, this.relayCursor);
        if (!data) {
            // The relay could not be read: show what is already in hand, all of it.
            if (this.relayPagesRead === 0) this.firstPageFailed = true;
            this.relayDone = true;
            return;
        }
        this.relayPagesRead += 1;
        this.relayCursor = data.nextCursor ?? null;
        this.relayTotal = data.total;
        // Keyset pages never repeat a row; a page with no row not read before (a relay that ignored
        // the cursor) ends the read rather than asking for it again.
        let fresh = 0;
        for (const e of data.entries) {
            if (!this.relaySeen.has(e.peId)) { this.relaySeen.add(e.peId); fresh += 1; }
        }
        if (fresh === 0) {
            this.relayDone = true;
            return;
        }
        for (const e of data.entries) {
            if (!this.frontier || compareNewestFirst(e, this.frontier) > 0) this.frontier = e;
            if (this.relayIds.has(e.peId) || this.sameAsLocal(e)) continue;
            this.relayIds.add(e.peId);
            this.relay.push(e);
        }
        if (!data.hasMore || data.entries.length === 0 || this.relayCursor === null) this.relayDone = true;
    }

    private async fill(): Promise<void> {
        if (this.relayPagesRead === 0 && !this.relayDone) await this.fetchNext();
        while (!this.relayDone && this.merged().length < this.limit) await this.fetchNext();
    }

    /** Every record that can be shown in order now. */
    private merged(): PVTHistoryEntry[] {
        const all = [...this.local, ...this.relay].sort(compareNewestFirst);
        const frontier = this.frontier;
        if (this.relayDone || !frontier) return all;
        return all.filter((e) => compareNewestFirst(e, frontier) <= 0);
    }

    private view(): RecentHistoryView {
        const merged = this.merged();
        const entries = merged.slice(0, this.limit);
        return {
            entries,
            hasMore: merged.length > this.limit || !this.relayDone,
            // The relay's lifetime count largely overlaps the PEs this phone holds.
            total: Math.max(this.local.length, this.relayTotal, merged.length),
            failed: this.firstPageFailed && this.local.length === 0,
        };
    }
}
