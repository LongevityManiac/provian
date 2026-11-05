/**
 * attention — the single source for the app's attention center: everything that needs the
 * human's action, in one place, badge-counted. On open the human sees pending approvals, remote
 * presentation requests, linked agents needing recovery/re-key, agents asking to link, promises
 * waiting on their answer or their close-out, publication-consent requests, challenges against their
 * forum posts, and presentation requests inside their threads — each item opens its action directly.
 * Pure aggregation over the relay reads; every source degrades to empty (never throws, not even
 * synchronously), so a partial outage narrows the list rather than blanking the surface.
 *
 * An item exists exactly while the relay still returns it as waiting on THIS human: once it is
 * accepted, declined, answered, or expired the relay stops returning it (or returns it in a
 * non-actionable state, which is filtered here) and the bell clears.
 */
import RelayAPIService, {
    type HumanApprovalRequest,
    type HumanPresentationRequest,
    type AgentRecoveryAlert,
    type AgentLinkRequest,
    type RelayHumanPromiseDocument,
} from '../../services/RelayAPIService';
import {
    unreadThreads, getMyHumanJobs, getJobDispute, getHumanJobEscrowFunding, getPendingConsents,
    getMyChallenges, getPendingThreadPresentationRequests,
    type ThreadDocument, type HumanJob, type PublicationConsent, type CommonsChallenge,
    type ThreadPresentationRequest,
} from '../commons/CommonsService';
import { needsReleaseByPoster, payerCanClaimRefund } from '../commons/jobBoard';
import { agentNameFor, loadAgentNameMap, type AgentNameMap } from '../agents/agentNames';

export type AttentionKind =
    | 'approval' | 'presentation' | 'recovery' | 'recovery_anchor' | 'thread' | 'job'
    | 'link_request' | 'promise' | 'consent'
    | 'challenge' | 'thread_presentation';

/**
 * (item 9): why a human promise waits on me — `answer` (an offer / counter I have not signed)
 * or `closeout` (the other party closed it out and it is fulfilled only when I close out too).
 */
export type PromiseAttentionReason = 'answer' | 'closeout';

/**
 * why a Commons job needs this person. As the POSTER: people applied (choose one), the hire
 * is accepted but the escrow is unfunded (fund it), work was delivered (release payment), a refund
 * is claimable. As the HIRED party: the payment is in escrow and the work is not delivered yet.
 */
export type JobAttentionReason = 'applicants' | 'fund' | 'release' | 'refund' | 'deliver';

export interface AttentionItem {
    readonly kind: AttentionKind;
    /** Stable per-item id (request id / agent wallet id) for React keys + dedup. */
    readonly id: string;
    /** Raw source record, for the screen to route + render specifics. */
    readonly approval?: HumanApprovalRequest;
    readonly presentation?: HumanPresentationRequest;
    readonly recovery?: AgentRecoveryAlert;
    /**
     * Item 11: this agent has no escrow yet but the human's recovery key IS published — its
     * daemon seals to it the next time it runs; nothing for the human to do per agent.
     */
    readonly recoveryPending?: boolean;
    /** an unread thread (a message, a presentation request, a deliverable). */
    readonly thread?: ThreadDocument;
    /** a Commons job this person posted that needs them (release payment / claim a refund). */
    readonly job?: HumanJob;
    readonly jobReason?: JobAttentionReason;
    /** Item 4: an agent that connected with this human's code and is waiting to be linked. */
    readonly linkRequest?: AgentLinkRequest;
    /** Item 4: a human promise waiting on THIS party's answer (offered / countered to them). */
    readonly promise?: RelayHumanPromiseDocument;
    /** which answer the promise waits on (terms, or the second close-out signature). */
    readonly promiseReason?: PromiseAttentionReason;
    /** an open challenge against one of my forum posts, answerable until its window closes. */
    readonly challenge?: CommonsChallenge;
    /** a presentation request inside one of my threads, addressed to me, not yet presented. */
    readonly threadPresentation?: ThreadPresentationRequest;
    /** Item 4: a request to publish a PE this person is a party to. */
    readonly consent?: PublicationConsent;
    /**
     * The agent's display name for approval / presentation / link-request / recovery rows — never
     * the raw wallet id. null when the agent is not one of this human's linked agents.
     */
    readonly agentName?: string | null;
    /**
     * For time-ordering (newest first) within a priority tier; recovery alerts sort to the top of
     * the standing-condition tier. Decision requests always precede it (`compareAttentionItems`).
     */
    readonly sortAt: number;
}

export interface AttentionCounts {
    readonly approvals: number;
    readonly presentations: number;
    readonly recovery: number;
    readonly threads: number;
    readonly jobs: number;
    readonly linkRequests: number;
    readonly promises: number;
    readonly consents: number;
    readonly challenges: number;
    readonly threadPresentations: number;
}

export interface AttentionSnapshot {
    readonly items: readonly AttentionItem[];
    readonly count: number;
    readonly counts: AttentionCounts;
}

const ZERO_COUNTS: AttentionCounts = {
    approvals: 0, presentations: 0, recovery: 0, threads: 0, jobs: 0, linkRequests: 0, promises: 0, consents: 0,
    challenges: 0, threadPresentations: 0,
};
const EMPTY: AttentionSnapshot = { items: [], count: 0, counts: ZERO_COUNTS };

/**
 * Run one source so that NOTHING it does can fail the aggregate: a rejected promise, a synchronous
 * throw, or a missing method all degrade to the fallback.
 */
async function safely<T>(read: () => Promise<T> | T, fallback: T): Promise<T> {
    try {
        return await read();
    } catch {
        return fallback;
    }
}

/**
 * the Commons jobs that need this person, as poster or as the hired party (see
 * JobAttentionReason). One `/jobs/mine` read, plus one escrow read per in-progress undelivered job
 * and one dispute read per disputed job (few by nature). Every read degrades: an unreadable escrow
 * adds no item (never a guessed "fund" / "deliver").
 */
async function loadJobAttention(): Promise<{ job: HumanJob; reason: JobAttentionReason }[]> {
    const mine = await getMyHumanJobs({ limit: 50 });
    const out: { job: HumanJob; reason: JobAttentionReason }[] = [];
    const disputed: HumanJob[] = [];
    const escrowChecks: { job: HumanJob; reason: 'fund' | 'deliver' }[] = [];
    for (const job of mine.posted) {
        if (needsReleaseByPoster(job, job.poster_wallet_id)) out.push({ job, reason: 'release' });
        else if (job.status === 'disputed') disputed.push(job);
        else if (job.status === 'open' && !job.accepted_applicant_wallet_id && job.applicant_count > 0) out.push({ job, reason: 'applicants' });
        else if (job.status === 'in_progress' && job.accepted_applicant_wallet_id && job.escrow_id && !job.completion_pe_id) escrowChecks.push({ job, reason: 'fund' });
    }
    for (const job of mine.assigned) {
        if (job.status === 'in_progress' && job.escrow_id && !job.completion_pe_id) escrowChecks.push({ job, reason: 'deliver' });
    }
    const [views, escrows] = await Promise.all([
        Promise.all(disputed.map((job) => getJobDispute(job.job_id).catch(() => null))),
        Promise.all(escrowChecks.map(({ job }) => getHumanJobEscrowFunding(job.job_id).catch(() => null))),
    ]);
    disputed.forEach((job, i) => {
        if (payerCanClaimRefund(job, views[i], job.poster_wallet_id)) out.push({ job, reason: 'refund' });
    });
    escrowChecks.forEach(({ job, reason }, i) => {
        const status = escrows[i]?.status;
        // Poster: accepted but unfunded. Hired: the payment is in escrow, so the work can start.
        // Funding is only possible before the escrow's deadline: createEscrow reverts InvalidDeadline
        // after it, so a lapsed unfunded hire is not an action (never a permanent badge).
        const deadline = escrows[i]?.auto_release_at;
        if (reason === 'fund' && status === 'created' && typeof deadline === 'number' && deadline > Date.now()) out.push({ job, reason });
        if (reason === 'deliver' && status === 'funded') out.push({ job, reason });
    });
    return out;
}

/**
 * A presentation request is actionable by the human when it awaits the human — `requested` (compose
 * predicates) or `presented` (verify). `challenged` (waiting on the agent), `verified`, `declined`,
 * and `expired` need no human action, so they are not counted.
 */
function presentationNeedsHuman(status: HumanPresentationRequest['status']): boolean {
    return status === 'requested' || status === 'presented';
}

/** A relay expiry of 0 means "none stated"; a positive expiry at or before now is expired. */
function isLive(expiresAtMs: number | null | undefined, nowMs: number): boolean {
    return typeof expiresAtMs !== 'number' || expiresAtMs <= 0 || expiresAtMs > nowMs;
}

/** The promise statuses in which the terms are still being agreed (pending/offered/countered). */
const PROMISE_NEGOTIATING = new Set(['pending', 'offered', 'countered']);

/**
 * Item 4: does this human promise wait on MY answer? Only while the terms are being agreed
 * (pending / offered / countered), only if I am a party, and only if I have NOT signed the current
 * terms — the relay moves `digest` on every counter, so the party who countered has signed the new
 * digest and the OTHER party is the one who must accept, counter, or decline. The creator of a
 * fresh offer has signed it (nothing to do); the promise expires out of the list at `expires_at`.
 */
export function promiseNeedsMyAnswer(doc: RelayHumanPromiseDocument, myAddress: string, nowMs: number): boolean {
    const me = myAddress.toLowerCase();
    if (!me || !PROMISE_NEGOTIATING.has(doc.status)) return false;
    if (!isLive(doc.expires_at, nowMs)) return false;
    const creator = (doc.creator_address ?? '').toLowerCase();
    const acceptor = (doc.acceptor_address ?? '').toLowerCase();
    if (me !== creator && me !== acceptor) return false;
    const mine = Object.entries(doc.parties ?? {}).find(([addr]) => addr.toLowerCase() === me)?.[1];
    return !mine || mine.signed_digest !== doc.digest;
}

/** The promise statuses in which a close-out signature can still be posted (the relay's gate). */
const PROMISE_CLOSABLE = new Set(['accepted', 'disputed']);

/**
 * (item 9): does this human promise wait on MY close-out? The relay makes a promise
 * `fulfilled` only once BOTH parties have posted a close-out signature, so once the other party has
 * closed it out it waits on me — until I close out too (→ `fulfilled`, off the bell) or it expires.
 * Nothing is waiting while neither party has closed out, or after I have.
 */
export function promiseNeedsMyCloseout(doc: RelayHumanPromiseDocument, myAddress: string, nowMs: number): boolean {
    const me = myAddress.toLowerCase();
    if (!me || !PROMISE_CLOSABLE.has(doc.status)) return false;
    if (!isLive(doc.expires_at, nowMs)) return false;
    const creator = (doc.creator_address ?? '').toLowerCase();
    const acceptor = (doc.acceptor_address ?? '').toLowerCase();
    if (!acceptor || (me !== creator && me !== acceptor)) return false;
    const other = me === creator ? acceptor : creator;
    const closed = new Set(Object.keys(doc.closeout ?? {}).map((a) => a.toLowerCase()));
    return closed.has(other) && !closed.has(me);
}

/** (item 9): an open challenge against my post, still inside its answer window. */
export function challengeNeedsMyAnswer(c: CommonsChallenge, nowMs: number): boolean {
    return c.status === 'open' && typeof c.window_expires_at === 'number' && c.window_expires_at > nowMs;
}

/** (item 9): a thread presentation request addressed to me, still waiting, not expired. */
function threadPresentationNeedsMe(r: ThreadPresentationRequest, nowMs: number): boolean {
    return r.status === 'challenged' && typeof r.thread_id === 'string' && r.thread_id.length > 0
        && typeof r.expires_at_ms === 'number' && r.expires_at_ms > nowMs;
}

/** Item 4: a publication-consent request still waiting on someone (the relay scopes it to me). */
function consentIsPending(c: PublicationConsent, nowMs: number): boolean {
    if (!isLive(c.expires_at, nowMs) || c.resolved_at) return false;
    return Object.values(c.consent_status ?? {}).some((s) => s === 'pending');
}

/**
 * (the operator ): a REQUEST that waits on this human's decision — an agent asking to link,
 * an approval, a presentation request, a promise waiting on my answer, a publication consent —
 * sorts FIRST. It expires if the human does not act, and nothing else can act for them. Standing
 * conditions (an agent needing recovery, a job step, an unread thread) follow. Within a tier the
 * existing order holds: recovery alerts at the top of theirs, then newest first.
 */
const DECISION_REQUEST_KINDS: ReadonlySet<AttentionKind> = new Set<AttentionKind>([
    'link_request', 'approval', 'presentation', 'promise', 'consent', 'challenge', 'thread_presentation',
]);

/** 0 = a request waiting on the human's decision; 1 = everything else. Lower sorts first. */
export function attentionPriority(kind: AttentionKind): 0 | 1 {
    return DECISION_REQUEST_KINDS.has(kind) ? 0 : 1;
}

/** The one ordering the bell uses: decision requests first, then by `sortAt` newest-first. */
export function compareAttentionItems(
    x: Pick<AttentionItem, 'kind' | 'sortAt'>,
    y: Pick<AttentionItem, 'kind' | 'sortAt'>,
): number {
    const tier = attentionPriority(x.kind) - attentionPriority(y.kind);
    return tier !== 0 ? tier : y.sortAt - x.sortAt;
}

/** Load the current attention items: decision requests first, then recovery, then newest. */
export async function loadAttention(): Promise<AttentionSnapshot> {
    try {
        const now = Date.now();
        const [approvals, presentations, recovery, threads, jobs, linkReqs, promises, consents, challenges, threadPresentations, names] = await Promise.all([
            safely(() => RelayAPIService.getWalletApprovalRequests(), [] as HumanApprovalRequest[]),
            safely(() => RelayAPIService.getWalletPresentationRequests(), [] as HumanPresentationRequest[]),
            safely(() => RelayAPIService.getAgentRecoveryAlerts(), [] as AgentRecoveryAlert[]),
            safely(() => unreadThreads().then((r) => r.threads), [] as ThreadDocument[]),
            safely(() => loadJobAttention(), [] as { job: HumanJob; reason: JobAttentionReason }[]),
            safely(() => RelayAPIService.getLinkRequests().then((r) => r?.link_requests ?? []), [] as AgentLinkRequest[]),
            safely(() => RelayAPIService.listMyHumanPromises(), null as { promises: RelayHumanPromiseDocument[]; myAddress: string } | null),
            safely(() => getPendingConsents().then((r) => r?.consents ?? []), [] as PublicationConsent[]),
            safely(() => getMyChallenges().then((r) => r?.challenges ?? []), [] as CommonsChallenge[]),
            safely(() => getPendingThreadPresentationRequests().then((r) => r?.requests ?? []), [] as ThreadPresentationRequest[]),
            safely(() => loadAgentNameMap(), new Map() as AgentNameMap),
        ]);
        // Item 11: whether this human's ONE recovery key is on the relay. Read only when an agent
        // lacks an escrow (the one case it decides); undefined = unreadable, never "not published".
        const recoveryAlertsRaw = Array.isArray(recovery) ? recovery : [];
        const anyEscrowMissing = recoveryAlertsRaw.some((r) => r.reason === 'escrow_missing');
        const anchor = anyEscrowMissing
            ? await safely(() => RelayAPIService.getHumanRecoveryAnchor(), undefined as string | null | undefined)
            : undefined;

        const liveApprovals = (Array.isArray(approvals) ? approvals : []).filter((a) => isLive(a.expires_at_ms, now));
        const livePresentations = (Array.isArray(presentations) ? presentations : [])
            .filter((p) => presentationNeedsHuman(p.status) && isLive(p.expires_at_ms, now));
        const liveLinkRequests = (Array.isArray(linkReqs) ? linkReqs : [])
            .filter((r) => typeof r.expires_at === 'number' && r.expires_at > now);
        const myPromises: { promise: RelayHumanPromiseDocument; reason: PromiseAttentionReason }[] = [];
        if (promises && Array.isArray(promises.promises)) {
            for (const p of promises.promises) {
                if (promiseNeedsMyAnswer(p, promises.myAddress, now)) myPromises.push({ promise: p, reason: 'answer' });
                else if (promiseNeedsMyCloseout(p, promises.myAddress, now)) myPromises.push({ promise: p, reason: 'closeout' });
            }
        }
        const openChallenges = (Array.isArray(challenges) ? challenges : []).filter((c) => challengeNeedsMyAnswer(c, now));
        const liveThreadPresentations = (Array.isArray(threadPresentations) ? threadPresentations : [])
            .filter((r) => threadPresentationNeedsMe(r, now));
        const liveConsents = (Array.isArray(consents) ? consents : []).filter((c) => consentIsPending(c, now));
        // Not published: ONE item for the human — publishing fixes every such agent at once, no
        // per-agent tap. Every agent row stays (and still opens re-key): an agent whose machine is
        // gone never escrows itself, and re-key is its only way back. Published: those rows say the
        // agent will seal its copy the next time it runs.
        const anchorUnpublished = anchor === null;
        const recoveryAlerts = recoveryAlertsRaw;
        const unread = Array.isArray(threads) ? threads : [];
        const jobItems = Array.isArray(jobs) ? jobs : [];

        const items: AttentionItem[] = [];
        if (anchorUnpublished && anyEscrowMissing) {
            items.push({ kind: 'recovery_anchor', id: 'recovery_anchor', sortAt: Number.MAX_SAFE_INTEGER });
        }
        for (const r of recoveryAlerts) {
            items.push({
                kind: 'recovery', id: `recovery:${r.agent_wallet_id}`, recovery: r,
                recoveryPending: r.reason === 'escrow_missing' && typeof anchor === 'string',
                agentName: agentNameFor(r.agent_wallet_id, names) ?? r.agent_name, sortAt: Number.MAX_SAFE_INTEGER,
            });
        }
        for (const a of liveApprovals) {
            items.push({ kind: 'approval', id: `approval:${a.request_id}`, approval: a, agentName: agentNameFor(a.agent_wallet_id, names), sortAt: a.created_at_ms });
        }
        for (const p of livePresentations) {
            items.push({ kind: 'presentation', id: `presentation:${p.request_id}`, presentation: p, agentName: agentNameFor(p.agent_wallet_id, names), sortAt: p.created_at_ms });
        }
        for (const r of liveLinkRequests) {
            // Not linked yet, so the name the agent sent is the only name there is.
            items.push({ kind: 'link_request', id: `link_request:${r.request_id}`, linkRequest: r, agentName: r.agent_name || null, sortAt: r.created_at });
        }
        for (const { promise: p, reason } of myPromises) {
            items.push({ kind: 'promise', id: `promise:${p.promise_id}`, promise: p, promiseReason: reason, sortAt: p.updated_at });
        }
        for (const c of openChallenges) {
            items.push({ kind: 'challenge', id: `challenge:${c.challenge_id}`, challenge: c, sortAt: c.created_at });
        }
        for (const r of liveThreadPresentations) {
            items.push({ kind: 'thread_presentation', id: `thread_presentation:${r.request_id}`, threadPresentation: r, sortAt: r.created_at_ms });
        }
        for (const c of liveConsents) {
            items.push({ kind: 'consent', id: `consent:${c.consent_id}`, consent: c, sortAt: c.requested_at });
        }
        for (const th of unread) {
            items.push({ kind: 'thread', id: `thread:${th.thread_id}`, thread: th, sortAt: th.last_message_at });
        }
        for (const j of jobItems) {
            items.push({ kind: 'job', id: `job:${j.reason}:${j.job.job_id}`, job: j.job, jobReason: j.reason, sortAt: j.job.completed_at ?? j.job.disputed_at ?? j.job.posted_at });
        }
        items.sort(compareAttentionItems);

        return {
            items,
            count: items.length,
            counts: {
                approvals: liveApprovals.length,
                presentations: livePresentations.length,
                recovery: recoveryAlerts.length + (anchorUnpublished && anyEscrowMissing ? 1 : 0),
                threads: unread.length,
                jobs: jobItems.length,
                linkRequests: liveLinkRequests.length,
                promises: myPromises.length,
                consents: liveConsents.length,
                challenges: openChallenges.length,
                threadPresentations: liveThreadPresentations.length,
            },
        };
    } catch {
        return EMPTY;
    }
}
