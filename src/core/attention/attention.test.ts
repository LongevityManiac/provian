/**
 * attention — aggregation for the attention center. RED controls : the filter test
 * would pass vacuously over an empty list, so it asserts a `challenged` request is EXCLUDED while a
 * `requested`/`presented` one is INCLUDED; the ordering tests assert decision requests (a link request) sort above recovery.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getWalletApprovalRequests = vi.fn();
const getWalletPresentationRequests = vi.fn();
const getAgentRecoveryAlerts = vi.fn();
const getLinkRequests = vi.fn();
const listMyHumanPromises = vi.fn();
const getLinkedAgentIdentities = vi.fn();
const getHumanRecoveryAnchor = vi.fn();

vi.mock('../../services/RelayAPIService', () => ({
    default: {
        getWalletApprovalRequests: () => getWalletApprovalRequests(),
        getWalletPresentationRequests: () => getWalletPresentationRequests(),
        getAgentRecoveryAlerts: () => getAgentRecoveryAlerts(),
        getLinkRequests: () => getLinkRequests(),
        listMyHumanPromises: () => listMyHumanPromises(),
        getLinkedAgentIdentities: () => getLinkedAgentIdentities(),
        getCachedLinkedAgentIdentities: () => null,
        getHumanRecoveryAnchor: () => getHumanRecoveryAnchor(),
    },
}));

const unreadThreads = vi.fn();
const getMyHumanJobs = vi.fn();
const getJobDispute = vi.fn();
const getHumanJobEscrowFunding = vi.fn();
const getPendingConsents = vi.fn();
const getMyChallenges = vi.fn();
const getPendingThreadPresentationRequests = vi.fn();
vi.mock('../commons/CommonsService', () => ({
    unreadThreads: () => unreadThreads(),
    getMyHumanJobs: (p: unknown) => getMyHumanJobs(p),
    getJobDispute: (id: string) => getJobDispute(id),
    getHumanJobEscrowFunding: (id: string) => getHumanJobEscrowFunding(id),
    getPendingConsents: () => getPendingConsents(),
    getMyChallenges: () => getMyChallenges(),
    getPendingThreadPresentationRequests: () => getPendingThreadPresentationRequests(),
}));

import * as attention from './attention';
const { loadAttention } = attention;

beforeEach(() => {
    getWalletApprovalRequests.mockReset().mockResolvedValue([]);
    getWalletPresentationRequests.mockReset().mockResolvedValue([]);
    getAgentRecoveryAlerts.mockReset().mockResolvedValue([]);
    getHumanRecoveryAnchor.mockReset().mockResolvedValue(undefined);
    unreadThreads.mockReset().mockResolvedValue({ threads: [] });
    getMyHumanJobs.mockReset().mockResolvedValue({ posted: [], assigned: [], total: 0, has_more: false });
    getJobDispute.mockReset().mockResolvedValue(null);
    getHumanJobEscrowFunding.mockReset().mockResolvedValue(null);
    getLinkRequests.mockReset().mockResolvedValue({ link_requests: [], count: 0 });
    listMyHumanPromises.mockReset().mockResolvedValue({ promises: [], myAddress: ME });
    getLinkedAgentIdentities.mockReset().mockResolvedValue({ linked_agents: [] });
    getPendingConsents.mockReset().mockResolvedValue({ consents: [] });
    getMyChallenges.mockReset().mockResolvedValue({ challenges: [], present_to_prefix: '' });
    getPendingThreadPresentationRequests.mockReset().mockResolvedValue({ requests: [], count: 0 });
});

const ME = '0x00000000000000000000000000000000000000aa';
const THEM = '0x00000000000000000000000000000000000000bb';
const NOW_PLUS = () => Date.now() + 86_400_000;
const NOW_MINUS = () => Date.now() - 1000;

describe('loadAttention', () => {
    it('is empty when nothing needs action (RED control for the counts below)', async () => {
        const snap = await loadAttention();
        expect(snap.count).toBe(0);
        expect(snap.items).toEqual([]);
    });

    it('counts approvals + actionable presentations + recovery; EXCLUDES a challenged (agent-side) request', async () => {
        getWalletApprovalRequests.mockResolvedValue([{ request_id: 'apr_1', agent_wallet_id: 'aw', action_description: 'x', action_description_sha256: 'sha256:0', subject_pe_id: null, created_at_ms: 100, expires_at_ms: 0 }]);
        getWalletPresentationRequests.mockResolvedValue([
            { request_id: 'preq_r', agent_wallet_id: 'aw', tier: 'reputation', status: 'requested', note: null, created_at_ms: 200, expires_at_ms: 0, audience: null, challenge: null, predicates: null, presentation_token: null, verdict: null },
            { request_id: 'preq_p', agent_wallet_id: 'aw', tier: 'reputation', status: 'presented', note: null, created_at_ms: 300, expires_at_ms: 0, audience: 'a', challenge: 'c', predicates: [], presentation_token: 'tok', verdict: null },
            { request_id: 'preq_c', agent_wallet_id: 'aw', tier: 'reputation', status: 'challenged', note: null, created_at_ms: 400, expires_at_ms: 0, audience: 'a', challenge: 'c', predicates: [], presentation_token: null, verdict: null },
        ]);
        getAgentRecoveryAlerts.mockResolvedValue([{ agent_wallet_id: 'aw', agent_name: 'Atlas', reason: 'at_rest_secret_missing' }]);

        const snap = await loadAttention();
        // 1 approval + 2 actionable presentations (challenged excluded) + 1 recovery = 4.
        expect(snap.count).toBe(4);
        expect(snap.counts).toEqual({ approvals: 1, presentations: 2, recovery: 1, threads: 0, jobs: 0, linkRequests: 0, promises: 0, consents: 0, challenges: 0, threadPresentations: 0 });
        // RED control: the challenged request must NOT appear.
        expect(snap.items.some((i) => i.presentation?.request_id === 'preq_c')).toBe(false);
        // the three decision requests come first; recovery leads the standing-condition tier.
        expect(snap.items.slice(0, 3).map((i) => i.kind).sort()).toEqual(['approval', 'presentation', 'presentation']);
        expect(snap.items[3].kind).toBe('recovery');
    });

    it(' a pending LINK REQUEST sorts FIRST, above "Agent needs recovery" (RED control: time order alone puts recovery first)', async () => {
        getAgentRecoveryAlerts.mockResolvedValue([
            { agent_wallet_id: 'aw_a', agent_name: 'Fleet A', reason: 'escrow_missing' },
            { agent_wallet_id: 'aw_b', agent_name: 'Fleet B', reason: 'escrow_missing' },
        ]);
        getLinkRequests.mockResolvedValue({ link_requests: [
            { request_id: 'inv_new', invite_id: 'inv_new', agent_wallet_id: 'aw_new', agent_name: 'Research Bot', agent_pe_count: 0, created_at: 10, expires_at: NOW_PLUS() },
        ], count: 1 });
        unreadThreads.mockResolvedValue({ threads: [{ thread_id: 'th_1', last_message_at: Date.now() }] });
        const snap = await loadAttention();
        expect(snap.items.map((i) => i.kind)).toEqual(['link_request', 'recovery', 'recovery', 'thread']);
        // RED control: the fixture discriminates — the pre- comparator (sortAt only) puts
        // recovery (MAX_SAFE_INTEGER) above the link request, so the assertion above is not vacuous.
        const timeOnly = [...snap.items].sort((x, y) => y.sortAt - x.sortAt);
        expect(timeOnly[0].kind).toBe('recovery');
        expect(timeOnly.findIndex((i) => i.kind === 'link_request')).toBeGreaterThan(0);
    });

    it('attentionPriority: every decision-request kind is tier 0; standing conditions are tier 1', () => {
        for (const k of ['link_request', 'approval', 'presentation', 'promise', 'consent', 'challenge', 'thread_presentation'] as const) {
            expect(attention.attentionPriority(k)).toBe(0);
        }
        for (const k of ['recovery', 'job', 'thread'] as const) {
            expect(attention.attentionPriority(k)).toBe(1);
        }
        // Within a tier, newest first.
        expect(attention.compareAttentionItems({ kind: 'approval', sortAt: 1 }, { kind: 'promise', sortAt: 2 })).toBeGreaterThan(0);
        expect(attention.compareAttentionItems({ kind: 'consent', sortAt: 1 }, { kind: 'recovery', sortAt: Number.MAX_SAFE_INTEGER })).toBeLessThan(0);
    });

    it('lists delivered work to release and a claimable refund; EXCLUDES a pending release and an open dispute', async () => {
        const base = { title: 'T', description: 'D', category: 'other', skills_required: [], location: { type: 'remote' }, compensation_type: 'fixed', applicant_count: 1, posted_at: 10 };
        getMyHumanJobs.mockResolvedValue({
            posted: [
                { ...base, job_id: 'j_release', poster_wallet_id: 'user_me', status: 'in_progress', completion_pe_id: 'pe_1' },
                { ...base, job_id: 'j_pending', poster_wallet_id: 'user_me', status: 'in_progress', completion_pe_id: 'pe_2', payment_release_pending: true },
                { ...base, job_id: 'j_refund', poster_wallet_id: 'user_me', status: 'disputed' },
                { ...base, job_id: 'j_open_dispute', poster_wallet_id: 'user_me', status: 'disputed' },
            ],
            assigned: [], total: 4, has_more: false,
        });
        getJobDispute.mockImplementation(async (id: string) => (
            id === 'j_refund'
                ? { refund_claimable: true, resolution: null }
                : { refund_claimable: false, resolution: null }
        ));
        const snap = await loadAttention();
        expect(snap.counts.jobs).toBe(2);
        const ids = snap.items.filter((i) => i.kind === 'job').map((i) => `${i.jobReason}:${i.job?.job_id}`).sort();
        expect(ids).toEqual(['refund:j_refund', 'release:j_release']);
        // RED controls: a release the relay is still observing and a dispute still with the admin are not actions.
        expect(snap.items.some((i) => i.job?.job_id === 'j_pending')).toBe(false);
        expect(snap.items.some((i) => i.job?.job_id === 'j_open_dispute')).toBe(false);
    });

    it('every job step that needs THIS person is in the bell — applicants, fund, deliver', async () => {
        const base = { title: 'T', description: 'D', category: 'other', skills_required: [], location: { type: 'remote' }, compensation_type: 'fixed', applicant_count: 0, posted_at: 10 };
        getMyHumanJobs.mockResolvedValue({
            posted: [
                { ...base, job_id: 'p_applied', poster_wallet_id: 'user_me', status: 'open', applicant_count: 2 },
                { ...base, job_id: 'p_quiet', poster_wallet_id: 'user_me', status: 'open', applicant_count: 0 },
                { ...base, job_id: 'p_unfunded', poster_wallet_id: 'user_me', status: 'in_progress', accepted_applicant_wallet_id: 'w_x', escrow_id: 'e1' },
                { ...base, job_id: 'p_funded', poster_wallet_id: 'user_me', status: 'in_progress', accepted_applicant_wallet_id: 'w_x', escrow_id: 'e2' },
                { ...base, job_id: 'p_lapsed', poster_wallet_id: 'user_me', status: 'in_progress', accepted_applicant_wallet_id: 'w_x', escrow_id: 'e7' },
            ],
            assigned: [
                { ...base, job_id: 'a_funded', poster_wallet_id: 'aw', accepted_applicant_wallet_id: 'user_me', status: 'in_progress', escrow_id: 'e3' },
                { ...base, job_id: 'a_unfunded', poster_wallet_id: 'aw', accepted_applicant_wallet_id: 'user_me', status: 'in_progress', escrow_id: 'e4' },
                { ...base, job_id: 'a_delivered', poster_wallet_id: 'aw', accepted_applicant_wallet_id: 'user_me', status: 'in_progress', escrow_id: 'e5', completion_pe_id: 'pe' },
                { ...base, job_id: 'a_unreadable', poster_wallet_id: 'aw', accepted_applicant_wallet_id: 'user_me', status: 'in_progress', escrow_id: 'e6' },
            ],
            total: 8, has_more: false,
        });
        const escrowStatus: Record<string, string> = { p_unfunded: 'created', p_funded: 'funded', p_lapsed: 'created', a_funded: 'funded', a_unfunded: 'created', a_delivered: 'funded' };
        getHumanJobEscrowFunding.mockImplementation(async (id: string) => {
            if (id === 'a_unreadable') throw new Error('down');
            // p_lapsed: its escrow deadline has passed — createEscrow would revert InvalidDeadline.
            return { status: escrowStatus[id], auto_release_at: id === 'p_lapsed' ? Date.now() - 1000 : Date.now() + 86_400_000 };
        });
        const snap = await loadAttention();
        const ids = snap.items.filter((i) => i.kind === 'job').map((i) => `${i.jobReason}:${i.job?.job_id}`).sort();
        expect(ids).toEqual(['applicants:p_applied', 'deliver:a_funded', 'fund:p_unfunded']);
        // RED controls: an open job nobody applied to, a funded poster job, an unfunded hire (the
        // hired party waits), delivered work, a lapsed unfunded hire (unfundable), and an unreadable
        // escrow add NOTHING (never a guess, never a permanent badge).
        for (const quiet of ['p_quiet', 'p_funded', 'p_lapsed', 'a_unfunded', 'a_delivered', 'a_unreadable']) {
            expect(snap.items.some((i) => i.job?.job_id === quiet), quiet).toBe(false);
        }
        // The one read carries both roles (no role filter).
        expect(getMyHumanJobs).toHaveBeenCalledWith({ limit: 50 });
    });

    it('degrades to empty when a source throws (never rejects)', async () => {
        getWalletApprovalRequests.mockRejectedValue(new Error('down'));
        const snap = await loadAttention();
        expect(snap.count).toBe(0);
    });
});

/**
 * Item 4 — every pending request that needs the human's action shows on the bell. RED controls:
 * each new source asserts that the NON-actionable twins (expired, already answered, not addressed
 * to me) are EXCLUDED, so a pass over an always-empty or always-full list is impossible.
 */
describe('loadAttention — item 4 sources', () => {
    const promise = (over: Record<string, unknown>) => ({
        promise_id: 'p', digest: 'd2', status: 'countered', creator_address: ME, acceptor_address: THEM,
        parties: {
            [ME]: { address: ME, role: 'creator', signature: 's', signed_digest: 'd1', signed_at: 1, terms_ciphertext: 'c' },
            [THEM]: { address: THEM, role: 'acceptor', signature: 's', signed_digest: 'd2', signed_at: 2, terms_ciphertext: 'c' },
        },
        closeout: {}, created_at: 1, updated_at: 5, expires_at: NOW_PLUS(),
        ...over,
    });

    it('pending agent LINK REQUESTS appear (named, openable); an expired one does not', async () => {
        getLinkRequests.mockResolvedValue({ link_requests: [
            { request_id: 'inv_live', invite_id: 'inv_live', agent_wallet_id: 'aw_1', agent_name: 'Atlas', agent_pe_count: 3, created_at: 10, expires_at: NOW_PLUS() },
            { request_id: 'inv_old', invite_id: 'inv_old', agent_wallet_id: 'aw_2', agent_name: 'Old', agent_pe_count: 0, created_at: 5, expires_at: NOW_MINUS() },
        ], count: 2 });
        const snap = await loadAttention();
        expect(snap.counts.linkRequests).toBe(1);
        const item = snap.items.find((i) => i.kind === 'link_request');
        expect(item?.linkRequest?.invite_id).toBe('inv_live');
        expect(item?.agentName).toBe('Atlas');
        // RED control: the expired request is not an action.
        expect(snap.items.some((i) => i.linkRequest?.request_id === 'inv_old')).toBe(false);
    });

    it('a PROMISE waits on me only when I have not signed the current terms; never when I countered, made a fresh offer, or it is settled / expired / not mine', async () => {
        listMyHumanPromises.mockResolvedValue({ myAddress: ME, promises: [
            promise({ promise_id: 'p_countered_to_me' }),
            // I countered: I signed the new digest, THEY must answer.
            promise({ promise_id: 'p_i_countered', parties: {
                [ME]: { address: ME, role: 'creator', signature: 's', signed_digest: 'd2', signed_at: 3, terms_ciphertext: 'c' },
                [THEM]: { address: THEM, role: 'acceptor', signature: 's', signed_digest: 'd1', signed_at: 2, terms_ciphertext: 'c' } } }),
            // My fresh offer: I created and signed it; nobody has answered yet.
            promise({ promise_id: 'p_my_offer', status: 'pending', digest: 'd1', acceptor_address: null, parties: {
                [ME]: { address: ME, role: 'creator', signature: 's', signed_digest: 'd1', signed_at: 1, terms_ciphertext: 'c' } } }),
            promise({ promise_id: 'p_accepted', status: 'accepted' }),
            promise({ promise_id: 'p_expired', expires_at: NOW_MINUS() }),
            promise({ promise_id: 'p_not_mine', creator_address: '0xcc', acceptor_address: '0xdd' }),
        ] });
        const snap = await loadAttention();
        expect(snap.items.filter((i) => i.kind === 'promise').map((i) => i.promise?.promise_id)).toEqual(['p_countered_to_me']);
        expect(snap.counts.promises).toBe(1);
    });

    it('an OFFERED promise to me (I am the acceptor, not yet signed) waits on me — not on its creator', async () => {
        const offered = promise({ promise_id: 'p_offered', status: 'offered', digest: 'd1', creator_address: THEM, acceptor_address: ME, parties: {
            [THEM]: { address: THEM, role: 'creator', signature: 's', signed_digest: 'd1', signed_at: 1, terms_ciphertext: 'c' } } });
        listMyHumanPromises.mockResolvedValue({ myAddress: ME, promises: [offered] });
        expect((await loadAttention()).counts.promises).toBe(1);
        // RED control: the same offer seen by its creator does not wait on them.
        listMyHumanPromises.mockResolvedValue({ myAddress: THEM, promises: [offered] });
        expect((await loadAttention()).counts.promises).toBe(0);
    });

    it('pending PUBLICATION CONSENT requests appear; resolved or expired ones do not', async () => {
        getPendingConsents.mockResolvedValue({ consents: [
            { consent_id: 'c_live', pe_id: 'pe1', requesting_wallet_id: 'w', consenting_wallet_ids: ['me'], consent_status: { me: 'pending' }, redaction_config: {}, institution: 'x', requested_at: 7, expires_at: NOW_PLUS() },
            { consent_id: 'c_done', pe_id: 'pe2', requesting_wallet_id: 'w', consenting_wallet_ids: ['me'], consent_status: { me: 'approved' }, redaction_config: {}, institution: 'x', requested_at: 6, expires_at: NOW_PLUS(), resolved_at: 8 },
            { consent_id: 'c_old', pe_id: 'pe3', requesting_wallet_id: 'w', consenting_wallet_ids: ['me'], consent_status: { me: 'pending' }, redaction_config: {}, institution: 'x', requested_at: 5, expires_at: NOW_MINUS() },
        ] });
        const snap = await loadAttention();
        expect(snap.items.filter((i) => i.kind === 'consent').map((i) => i.consent?.consent_id)).toEqual(['c_live']);
        expect(snap.counts.consents).toBe(1);
    });

    it('approval and presentation rows carry the agent NAME from the linked agents (never the wallet id); an expired approval is dropped', async () => {
        getLinkedAgentIdentities.mockResolvedValue({ linked_agents: [{ wallet_id: 'aw_atlas', agent_id: 'a', display_name: 'Atlas Prime' }] });
        getWalletApprovalRequests.mockResolvedValue([
            { request_id: 'apr_live', agent_wallet_id: 'aw_atlas', action_description: 'x', action_description_sha256: 'h', subject_pe_id: null, created_at_ms: 100, expires_at_ms: NOW_PLUS() },
            { request_id: 'apr_old', agent_wallet_id: 'aw_atlas', action_description: 'x', action_description_sha256: 'h', subject_pe_id: null, created_at_ms: 90, expires_at_ms: NOW_MINUS() },
            { request_id: 'apr_stranger', agent_wallet_id: 'aw_unknown', action_description: 'x', action_description_sha256: 'h', subject_pe_id: null, created_at_ms: 80, expires_at_ms: 0 },
        ]);
        getWalletPresentationRequests.mockResolvedValue([
            { request_id: 'preq', agent_wallet_id: 'aw_atlas', tier: 'reputation', status: 'requested', note: null, created_at_ms: 200, expires_at_ms: 0, audience: null, challenge: null, predicates: null, presentation_token: null, verdict: null },
        ]);
        const snap = await loadAttention();
        expect(snap.items.find((i) => i.approval?.request_id === 'apr_live')?.agentName).toBe('Atlas Prime');
        expect(snap.items.find((i) => i.presentation?.request_id === 'preq')?.agentName).toBe('Atlas Prime');
        // Not one of my linked agents: no name (the screen says "An agent"), never the raw id.
        expect(snap.items.find((i) => i.approval?.request_id === 'apr_stranger')?.agentName).toBeNull();
        // RED control: an expired approval is not an action.
        expect(snap.items.some((i) => i.approval?.request_id === 'apr_old')).toBe(false);
        expect(snap.counts.approvals).toBe(2);
    });

    it('one source failing (or throwing synchronously) narrows the list instead of blanking it', async () => {
        getLinkRequests.mockRejectedValue(new Error('down'));
        listMyHumanPromises.mockImplementation(() => { throw new Error('sync throw'); });
        getPendingConsents.mockRejectedValue(new Error('not a member'));
        getAgentRecoveryAlerts.mockResolvedValue([{ agent_wallet_id: 'aw', agent_name: 'Atlas', reason: 'escrow_missing' }]);
        const snap = await loadAttention();
        expect(snap.count).toBe(1);
        expect(snap.items[0].kind).toBe('recovery');
    });

    it(' item 9: a promise the OTHER party closed out waits on my close-out; clears once I close out, and never waits on the party who closed', async () => {
        const closedByThem = promise({ promise_id: 'p_closeout', status: 'accepted', digest: 'd2', parties: {
            [ME]: { address: ME, role: 'creator', signature: 's', signed_digest: 'd2', signed_at: 3, terms_ciphertext: 'c' },
            [THEM]: { address: THEM, role: 'acceptor', signature: 's', signed_digest: 'd2', signed_at: 2, terms_ciphertext: 'c' } },
            closeout: { [THEM]: { address: THEM, signature: 'x', signed_at: 9 } } });
        listMyHumanPromises.mockResolvedValue({ myAddress: ME, promises: [closedByThem] });
        const snap = await loadAttention();
        const item = snap.items.find((i) => i.kind === 'promise');
        expect(item?.promise?.promise_id).toBe('p_closeout');
        expect(item?.promiseReason).toBe('closeout');
        expect(attention.attentionPriority('promise')).toBe(0);
        // RED control: the party who closed it out is not waiting on itself.
        listMyHumanPromises.mockResolvedValue({ myAddress: THEM, promises: [closedByThem] });
        expect((await loadAttention()).counts.promises).toBe(0);
        // Both closed → fulfilled on the relay; even a stale 'accepted' copy with both signatures is not an action.
        const both = { ...closedByThem, closeout: { ...closedByThem.closeout, [ME]: { address: ME, signature: 'y', signed_at: 10 } } };
        listMyHumanPromises.mockResolvedValue({ myAddress: ME, promises: [both, { ...both, promise_id: 'p_ful', status: 'fulfilled' }] });
        expect((await loadAttention()).counts.promises).toBe(0);
        // Expired → off the bell.
        listMyHumanPromises.mockResolvedValue({ myAddress: ME, promises: [{ ...closedByThem, expires_at: NOW_MINUS() }] });
        expect((await loadAttention()).counts.promises).toBe(0);
    });

    it('promiseNeedsMyCloseout matches addresses case-insensitively (RED: a checksummed key still counts as the other party)', () => {
        const doc = promise({ status: 'disputed', closeout: { [THEM.toUpperCase().replace('0X', '0x')]: { address: THEM, signature: 'x', signed_at: 1 } } });
        expect(attention.promiseNeedsMyCloseout(doc as never, ME.toUpperCase().replace('0X', '0x'), Date.now())).toBe(true);
        expect(attention.promiseNeedsMyCloseout({ ...doc, status: 'countered' } as never, ME, Date.now())).toBe(false);
    });

    it(' item 9: an OPEN challenge against my post is on the bell until answered, upheld, or its window closes', async () => {
        const ch = (over: Record<string, unknown>) => ({
            challenge_id: 'ch', pe_id: 'pe', post_id: 'post_1', challenger_wallet_id: 'w_other', author_wallet_id: 'me', reason: null,
            predicate: { field: 'work.sealed_count', op: 'gte', threshold: 1 }, stake_burn_id: 'b', stake_amount_atomic: '1',
            stake_status: 'reserved', audience: 'a', challenge_nonce: 'n', status: 'open', window_expires_at: NOW_PLUS(), created_at: 50,
            ...over,
        });
        getMyChallenges.mockResolvedValue({ present_to_prefix: 'x', challenges: [
            ch({ challenge_id: 'ch_open' }),
            ch({ challenge_id: 'ch_answered', status: 'answered' }),
            ch({ challenge_id: 'ch_upheld', status: 'upheld' }),
            ch({ challenge_id: 'ch_lapsed', window_expires_at: NOW_MINUS() }),
        ] });
        const snap = await loadAttention();
        expect(snap.items.filter((i) => i.kind === 'challenge').map((i) => i.challenge?.challenge_id)).toEqual(['ch_open']);
        expect(snap.counts.challenges).toBe(1);
        expect(attention.attentionPriority('challenge')).toBe(0);
    });

    it(' item 9: a thread presentation request addressed to me is on the bell until presented or expired', async () => {
        const r = (over: Record<string, unknown>) => ({
            request_id: 'tr', requester_id: 'w_other', presenter_id: 'me', thread_id: 'thr_1', tier: 'reputation', status: 'challenged',
            audience: 'w_other', challenge: 'c', predicates: [], verdict: null, created_at_ms: 70, expires_at_ms: NOW_PLUS(),
            ...over,
        });
        getPendingThreadPresentationRequests.mockResolvedValue({ count: 4, requests: [
            r({ request_id: 'tr_live' }),
            r({ request_id: 'tr_verified', status: 'verified' }),
            r({ request_id: 'tr_expired', expires_at_ms: NOW_MINUS() }),
            r({ request_id: 'tr_no_thread', thread_id: null }),
        ] });
        const snap = await loadAttention();
        expect(snap.items.filter((i) => i.kind === 'thread_presentation').map((i) => i.threadPresentation?.request_id)).toEqual(['tr_live']);
        expect(snap.counts.threadPresentations).toBe(1);
        expect(attention.attentionPriority('thread_presentation')).toBe(0);
    });

    it('RED control: with the two new sources failing, the rest of the bell still loads', async () => {
        getMyChallenges.mockRejectedValue(new Error('not a member'));
        getPendingThreadPresentationRequests.mockImplementation(() => { throw new Error('sync'); });
        getAgentRecoveryAlerts.mockResolvedValue([{ agent_wallet_id: 'aw', agent_name: 'Atlas', reason: 'escrow_missing' }]);
        const snap = await loadAttention();
        expect(snap.count).toBe(1);
        expect(snap.counts.challenges).toBe(0);
        expect(snap.counts.threadPresentations).toBe(0);
    });

    it('item 11: agents with no escrow and no published recovery key → ONE publish item for the human (no per-agent tap needed)', async () => {
        getAgentRecoveryAlerts.mockResolvedValue([
            { agent_wallet_id: 'aw1', agent_name: 'Scout', reason: 'escrow_missing' },
            { agent_wallet_id: 'aw2', agent_name: 'Ranger', reason: 'escrow_missing' },
            { agent_wallet_id: 'aw3', agent_name: 'Atlas', reason: 'at_rest_secret_missing' },
        ]);
        getHumanRecoveryAnchor.mockResolvedValue(null);
        const snap = await loadAttention();
        expect(snap.items.filter((i) => i.kind === 'recovery_anchor')).toHaveLength(1);
        // Review r2 #2: every agent row stays (it opens re-key — an agent whose machine is gone never escrows itself).
        expect(snap.items.filter((i) => i.kind === 'recovery').map((i) => i.recovery?.agent_wallet_id)).toEqual(['aw1', 'aw2', 'aw3']);
        expect(snap.items.filter((i) => i.kind === 'recovery').every((i) => i.recoveryPending === false)).toBe(true);
        expect(snap.counts.recovery).toBe(4);
    });

    it('item 11: once the key is published, those agents escrow themselves — their rows say so, and no publish item', async () => {
        getAgentRecoveryAlerts.mockResolvedValue([{ agent_wallet_id: 'aw1', agent_name: 'Scout', reason: 'escrow_missing' }]);
        getHumanRecoveryAnchor.mockResolvedValue('E75P6uryBMf9M1j8nAByGIHRdCeBKCJ-xnTzf3_pe20');
        const snap = await loadAttention();
        expect(snap.items.map((i) => i.kind)).toEqual(['recovery']);
        expect(snap.items[0].recoveryPending).toBe(true);
    });

    it('item 11 RED control: an unreadable relay never hides an agent\'s row or claims the key is missing', async () => {
        getAgentRecoveryAlerts.mockResolvedValue([{ agent_wallet_id: 'aw1', agent_name: 'Scout', reason: 'escrow_missing' }]);
        getHumanRecoveryAnchor.mockResolvedValue(undefined);
        const snap = await loadAttention();
        expect(snap.items.map((i) => i.kind)).toEqual(['recovery']);
        expect(snap.items[0].recoveryPending).toBe(false);
    });

    it('the module still exports the aggregator the bell and the tab badge share', () => {
        expect(typeof attention.loadAttention).toBe('function');
    });
});
