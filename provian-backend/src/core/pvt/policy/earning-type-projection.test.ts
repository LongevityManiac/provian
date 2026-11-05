import {setPolicyRuling} from '../__test-helpers__/policy-ruling-fixture';
/**
 * Earning-type projection + rulings sidecar + reconciler.
 *
 * "Live" must come ONLY from the served matrix + a matched activation digest,
 * never from an admin write — the decision-8 property. Each guard on the
 * rulings sidecar ships with its RED control.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../__test-helpers__/fake-firestore';
import { observePendingPolicyAction, listPendingPolicyActions } from './pending-policy-queue';
import {
  markPolicyRulingLive,
  getPolicyRuling,
} from './policy-rulings';
import {
  projectEarningTypes,
  projectEarningType,
  addBusinessDays,
  listAllPendingPolicyActions,
} from './earning-type-projection';
import { reconcileLiveActionTypes } from './action-type-reconciler';
import { PROPOSED_ACTION_POLICY_ENTRIES } from './proposed-action-policy';

const NOW = Date.UTC(2026, 8, 7, 12); // Monday 2026-09-07
const RECORD_ONLY_TYPE = PROPOSED_ACTION_POLICY_ENTRIES
  .find((e) => e.mint_disposition === 'record_only')!.action_type;

function db(): Firestore {
  return createFakeFirestore() as unknown as Firestore;
}

async function seedQueue(d: Firestore, actionType: string, at = NOW - 10 * 24 * 3600 * 1000): Promise<void> {
  await observePendingPolicyAction(d, {
    actionType, peId: `pe_${actionType}`, integrationSource: 'sdk', now: at,
  }, async () => ({ delivered: true }));
}

async function setDigestMatch(d: Firestore, match: boolean, effectiveAtMs = NOW - 1000): Promise<void> {
  await d.collection('system_status').doc('monetary_activation')
    .set({ digest_match: match, effective_at_ms: effectiveAtMs });
}

describe('earning-type projection', () => {
  it('addBusinessDays skips weekends', () => {
    // Fri 2026-09-04 + 3 business days = Wed 2026-09-09
    const fri = Date.UTC(2026, 8, 4, 12);
    expect(new Date(addBusinessDays(fri, 3)).getUTCDate()).toBe(9);
  });

  it('a queued type: pending queue, no ruling, no matrix → queued with a 3-business-day deadline', async () => {
    const d = db();
    await setDigestMatch(d, true);
    const seenAt = NOW - 8 * 24 * 3600 * 1000;
    await seedQueue(d, 'thirdparty:novel_type', seenAt);
    const view = await projectEarningType(d, 'thirdparty:novel_type', NOW);
    expect(view?.status).toBe('queued');
    expect(view?.first_seen_at).toBe(seenAt);
    expect(view?.review_deadline_ms).toBe(addBusinessDays(seenAt, 3));
    expect(view?.past_review_promise).toBe(true);
  });

  it('a live matrix type (mintable) with digest_match true → live with weight + effective date', async () => {
    const d = db();
    await setDigestMatch(d, true, 1785715200000);
    const view = await projectEarningType(d, 'wallet_created', NOW);
    expect(view?.status).toBe('live');
    expect(view?.weight_bps).toBeGreaterThan(0);
    expect(view?.effective_at_ms).toBe(1785715200000);
  });

  it('the SAME matrix type with digest_match FALSE → building, never live (decision 8 property)', async () => {
    const d = db();
    await setDigestMatch(d, false);
    const view = await projectEarningType(d, 'wallet_created', NOW);
    expect(view?.status).toBe('building');
    expect(view?.reason_code).toBe('awaiting_activation');
  });

  it('a record_only matrix row → declined (records, never earns)', async () => {
    const d = db();
    await setDigestMatch(d, true);
    const view = await projectEarningType(d, RECORD_ONLY_TYPE, NOW);
    expect(view?.status).toBe('declined');
    expect(view?.weight_bps).toBe(0);
  });

  it('a building ruling with no matrix row → building with the issue link', async () => {
    const d = db();
    await setDigestMatch(d, true);
    await seedQueue(d, 'thirdparty:will_build');
    await setPolicyRuling(d, {
      actionType: 'thirdparty:will_build', ruling: 'building',
      issueUrl: 'https://github.com/x/y/issues/new?title=z', operatorId: 'op:1', now: NOW,
    });
    const view = await projectEarningType(d, 'thirdparty:will_build', NOW);
    expect(view?.status).toBe('building');
    expect(view?.issue_url).toContain('github.com');
  });

  it('a building ruling carrying a PROPOSED eligible disposition still projects building — the sidecar prices nothing, and digest_match false is never live', async () => {
    const d = db();
    await setDigestMatch(d, false); // even with a mismatch AND an eligible proposal…
    await seedQueue(d, 'thirdparty:proposed_eligible');
    await setPolicyRuling(d, {
      actionType: 'thirdparty:proposed_eligible', ruling: 'building',
      issueUrl: 'https://github.com/x/y/issues/new?title=z',
      proposedDisposition: 'eligible', proposedWeightBps: 20000,
      operatorId: 'op:1', now: NOW,
    });
    const view = await projectEarningType(d, 'thirdparty:proposed_eligible', NOW);
    expect(view?.status).toBe('building'); // …the proposal never makes it live
    expect(view?.status).not.toBe('live');
  });

  it('an alias ruling → declined with the canonical type', async () => {
    const d = db();
    await setDigestMatch(d, true);
    await seedQueue(d, 'thirdparty:typo_type');
    await setPolicyRuling(d, {
      actionType: 'thirdparty:typo_type', ruling: 'alias',
      canonicalType: 'agent_work_product_code', reasonCode: 'typo', operatorId: 'op:1', now: NOW,
    });
    const view = await projectEarningType(d, 'thirdparty:typo_type', NOW);
    expect(view?.status).toBe('declined');
    expect(view?.canonical_type).toBe('agent_work_product_code');
  });

  it('the full projection has a footer with the live template digest + digest_match, and no "accepted" state', async () => {
    const d = db();
    await setDigestMatch(d, true);
    await seedQueue(d, 'thirdparty:novel_type');
    const projection = await projectEarningTypes(d, NOW);
    expect(projection.footer.template_digest).toMatch(/^sha256:|^[0-9a-f]{64}/);
    expect(projection.footer.digest_match).toBe(true);
    expect(projection.footer.matrix_entry_count).toBeGreaterThan(10);
    // The union covers matrix + queue; no status is ever "accepted".
    const statuses = new Set(projection.types.map((t) => t.status));
    for (const s of statuses) expect(['live', 'building', 'queued', 'declined']).toContain(s);
    expect(projection.review_promise).toContain('3 business days');
  });
});

describe('reconciler — building → live', () => {
  it('marks a building ruling live once its type is a mintable matrix row + digest_match true; idempotent', async () => {
    const d = db();
    await setDigestMatch(d, true);
    // 'wallet_created' is a mintable matrix row; simulate a building ruling for it.
    await setPolicyRuling(d, { actionType: 'wallet_created', ruling: 'building', issueUrl: 'https://g/i', operatorId: 'op:1' });
    const first = await reconcileLiveActionTypes(d, NOW);
    expect(first.newly_live).toEqual(['wallet_created']);
    // second run: already live, nothing new
    const second = await reconcileLiveActionTypes(d, NOW + 1000);
    expect(second.newly_live).toEqual([]);
    expect((await getPolicyRuling(d, 'wallet_created'))?.live_at).toBe(NOW);
  });

  it('RED CONTROL — does NOTHING while digest_match is false', async () => {
    const d = db();
    await setDigestMatch(d, false);
    await setPolicyRuling(d, { actionType: 'wallet_created', ruling: 'building', issueUrl: 'https://g/i', operatorId: 'op:1' });
    const result = await reconcileLiveActionTypes(d, NOW);
    expect(result.digest_match).toBe(false);
    expect(result.newly_live).toEqual([]);
    expect((await getPolicyRuling(d, 'wallet_created'))?.live_at).toBeNull();
  });
});

describe('earning-type projection — correct at any number of types (L648)', () => {
  // 450 queued identifiers: above the old 100-row single page AND above two full 200-row pages,
  // so the read must follow the cursor at least twice and stop on a short final page.
  const QUEUED = 450;
  const queuedType = (i: number): string => `thirdparty:scale_${String(i).padStart(4, '0')}`;

  async function seedMany(d: Firestore): Promise<void> {
    for (let i = 0; i < QUEUED; i += 1) {
      // Distinct first_seen_at so the queue's (first_seen_at, id) order is the seeding order.
      await seedQueue(d, queuedType(i), NOW - 30 * 24 * 3600 * 1000 + i * 1000);
    }
  }

  it('RED CONTROL — the population is real: the queue\'s default single page truncates it', async () => {
    const d = db();
    await seedMany(d);
    // This is exactly the read projectEarningTypes used to make. If this ever returns all 450
    // the test below proves nothing about truncation.
    const onePage = await listPendingPolicyActions(d);
    expect(onePage.length).toBe(100);
    expect(onePage.length).toBeLessThan(QUEUED);
  });

  it('every queued type appears in the projection and its counts, however many there are', async () => {
    const d = db();
    await setDigestMatch(d, true);
    await seedMany(d);

    const all = await listAllPendingPolicyActions(d);
    expect(all.length).toBe(QUEUED);
    expect(new Set(all.map((r) => r.action_type)).size).toBe(QUEUED);

    const projection = await projectEarningTypes(d, NOW);
    const queuedViews = projection.types.filter((t) => t.action_type.startsWith('thirdparty:scale_'));
    expect(queuedViews.length).toBe(QUEUED);
    for (const v of queuedViews) expect(v.status).toBe('queued');
    // The last-seeded (the one any page cap drops first) is present.
    expect(projection.types.some((t) => t.action_type === queuedType(QUEUED - 1))).toBe(true);
    // Counts cover the whole union: matrix rows + every queued type.
    const total = projection.counts.live + projection.counts.building
      + projection.counts.queued + projection.counts.declined;
    expect(total).toBe(projection.types.length);
    expect(projection.types.length).toBe(PROPOSED_ACTION_POLICY_ENTRIES.length + QUEUED);
    expect(projection.counts.queued).toBeGreaterThanOrEqual(QUEUED);
  });

  it('RED CONTROL — a queue cursor that does not advance is refused, never looped on or truncated', async () => {
    const d = db();
    const stuck = {
      collection: (name: string) => {
        if (name !== 'pvt_pending_policy_queue') return (d as unknown as { collection: (n: string) => unknown }).collection(name);
        // Every page returns the same 201 rows → the same nextCursor forever.
        const row = { id: 'a'.repeat(64), data: () => ({ action_type: 'thirdparty:stuck', first_seen_at: 1 }) };
        const docs = Array.from({ length: 201 }, () => row);
        const q = {
          where: () => q, orderBy: () => q, startAfter: () => q, limit: () => q,
          count: () => ({ get: async () => ({ data: () => ({ count: 201 }) }) }),
          get: async () => ({ docs, size: docs.length }),
        };
        return q;
      },
    } as unknown as Firestore;
    await expect(listAllPendingPolicyActions(stuck)).rejects.toThrow('earning_type_queue_cursor_did_not_advance');
  });
});
