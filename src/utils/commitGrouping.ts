/**
 * commitGrouping — collapse the multiple PEs that witness ONE commit into a single
 * display row (item #5). A commit is typically recorded three ways: a
 * `coding_session` from the local device observer, a `service:github_commit` from
 * the connected GitHub account, and a `corroboration_signal` linking them. They all
 * carry the same commit SHA, and pay-once-by-SHA already holds server-side — this is
 * DISPLAY-ONLY grouping so the history reads "one commit, cross-witnessed" instead
 * of three separate rows.
 *
 * Generic over the item type so both the thin PVT history entry (dashboard) and the
 * full ProvenanceEnvelope (Activity feed) can share one grouping implementation.
 */

import type { PEDisposition } from './peDisposition';

export interface CommitGroup<T> {
    commitSha: string;
    /** All PEs of this commit, in the input order (newest-first). */
    items: T[];
    /** The representative item — the first (newest) of the group. */
    primary: T;
}

export type GroupedRow<T> =
    | { kind: 'single'; item: T }
    | { kind: 'commit'; group: CommitGroup<T> };

/**
 * Group items sharing a non-null commit SHA. Overall order is preserved by each
 * group's FIRST (newest) occurrence; non-commit items pass through as singles in
 * place. A commit witnessed only once stays a plain single row (nothing to
 * collapse) — only genuinely cross-witnessed commits (>1 PE) become a 'commit' row.
 */
export function groupByCommit<T>(
    items: T[],
    getCommitSha: (item: T) => string | null | undefined,
): GroupedRow<T>[] {
    // First pass: bucket by SHA, preserving order.
    const buckets = new Map<string, T[]>();
    for (const item of items) {
        const sha = getCommitSha(item);
        if (sha) {
            const list = buckets.get(sha);
            if (list) list.push(item);
            else buckets.set(sha, [item]);
        }
    }

    // Second pass: emit in original order, folding each SHA group at its first hit.
    const emitted = new Set<string>();
    const rows: GroupedRow<T>[] = [];
    for (const item of items) {
        const sha = getCommitSha(item);
        if (!sha) {
            rows.push({ kind: 'single', item });
            continue;
        }
        if (emitted.has(sha)) continue;
        emitted.add(sha);
        const groupItems = buckets.get(sha)!;
        if (groupItems.length <= 1) {
            rows.push({ kind: 'single', item: groupItems[0] });
        } else {
            rows.push({ kind: 'commit', group: { commitSha: sha, items: groupItems, primary: groupItems[0] } });
        }
    }
    return rows;
}

/** Short SHA for display, e.g. "abc1234". */
export function shortSha(sha: string): string {
    return sha.length > 7 ? sha.slice(0, 7) : sha;
}

const WITNESS_SOURCE: Record<string, string> = {
    coding_session: 'locally',
    'service:github_commit': 'by GitHub',
    'service:github_pr_merged': 'by GitHub',
    corroboration_signal: 'independently',
};

/**
 * Human phrase for how a commit was witnessed, from its members' action types,
 * e.g. "witnessed locally + by GitHub". De-duplicated and order-stable.
 */
export function describeCommitWitnesses(actionTypes: string[]): string {
    const seen = new Set<string>();
    const sources: string[] = [];
    for (const t of actionTypes) {
        const src = WITNESS_SOURCE[t];
        if (src && !seen.has(src)) {
            seen.add(src);
            sources.push(src);
        }
    }
    if (sources.length === 0) return 'witnessed';
    return `witnessed ${sources.join(' + ')}`;
}

// Best-of ordering for a group's overall disposition: a commit that has minted
// anywhere is minted; else earning if any member is eligible; else pending; else
// record only. Higher rank wins.
const DISPOSITION_RANK: Record<PEDisposition, number> = {
    minted: 4,
    earning: 3,
    pending: 2,
    record_only: 1,
    unknown: 0,
};

/** The strongest disposition across a commit group's members. */
export function bestDisposition(dispositions: PEDisposition[]): PEDisposition {
    let best: PEDisposition = 'unknown';
    for (const d of dispositions) {
        if (DISPOSITION_RANK[d] > DISPOSITION_RANK[best]) best = d;
    }
    return best;
}
