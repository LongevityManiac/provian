/**
 * PE METER — which lanes can witness one act.
 *
 * "The mint-once claim and the 31-day act key exist only for act types that more than one lane
 * can witness. Single-lane act types keep no per-act document: the device's linked batches stop
 * replays, presentations verify from the batch and the on-chain anchor, and totals update per
 * batch."
 *
 * A LANE is an independent source that can report the SAME real-world occurrence: the agent's
 * observer daemon (`device`), the person's phone (`mobile`), a forge webhook (`forge`), the Base
 * chain-record lane / USDC watchers (`chain`), an institution watcher on Base (`institution_chain`),
 * a counterparty's confirmation (`counterparty`), the relay performing a Commons or registration
 * act itself (`relay`), and Provian's x402 facilitator (`facilitator`).
 *
 * Two lanes reporting one occurrence is exactly what mint-once exists for (a commit seen by the
 * daemon AND the GitHub webhook; a payment seen by the SDK's settlement watcher AND the
 * facilitator), and the act key is what lets the better witness take over, a corroboration land
 * as a top-up, and a completion find its delivery. One lane cannot report an occurrence twice:
 * a device's acts are hash-chained into its sequenced batches (a replayed batch is refused at the
 * tip, `meter-ingest.ts`), the transcript lane seeds existing files at their end (it never
 * re-observes old work on a reinstall), and the relay authors its own acts once per event.
 *
 * FAIL CLOSED: a type that is not listed here as single-lane keeps its act key and mint-once
 * claims exactly as before. Listing a type as single-lane is a claim that no second lane can
 * witness its occurrence; `act-witness-lanes.test.ts` binds the device lane's admitted types and
 * the commit / completion / chain-financial families to this table so a new lane cannot be added
 * without this table seeing it.
 */

export type WitnessLane =
  | 'device'
  | 'mobile'
  | 'forge'
  | 'chain'
  | 'institution_chain'
  | 'counterparty'
  | 'relay'
  | 'facilitator';

export interface ActWitnessEntry {
  /** Every lane that can witness ONE occurrence of this act type. */
  readonly witnesses: readonly WitnessLane[];
  /** Why (shown in the run record and the developers page). */
  readonly note: string;
}

/**
 * The table. Every row with exactly ONE witness lane is single-lane: no act key, no mint-once
 * claim. Rows with two or more keep both. Types absent from the table are treated as multi-lane.
 */
export const ACT_WITNESS_LANES: Readonly<Record<string, ActWitnessEntry>> = Object.freeze({
  // ── The observer daemon's lanes (observation types) ─────────────────────────────────
  compute_session: { witnesses: ['device'], note: 'the daemon on the machine that ran it' },
  inference_session: { witnesses: ['device'], note: 'the daemon (model proxy is the minting witness on a proxied device; transcript/OTel supplement inside the same device)' },
  agent_tool_orchestration: { witnesses: ['device'], note: 'the daemon\'s transcript / OTel lanes on one machine' },
  agent_api_orchestration: { witnesses: ['device'], note: 'the daemon\'s transcript / OTel lanes on one machine' },
  ai_conversation: { witnesses: ['device'], note: 'one session on one device (a phone chat and a desktop chat are different occurrences)' },
  link_spend: { witnesses: ['device'], note: 'the transcript lane only; the spend request id is seen once' },
  coding_session: { witnesses: ['device', 'forge'], note: 'a commit: the daemon\'s post-commit hook AND the forge push webhook (takeover)' },
  // ── The phone ──────────────────────────────────────────────────────────────────────────────
  human_approval: { witnesses: ['mobile'], note: 'the approving phone; the approval request is claimed in the batch commit' },
  // ── Forge webhooks (the commit's second witness) ─────────────────────────────────────────
  'service:github_commit': { witnesses: ['forge', 'device'], note: 'the commit the daemon may also see' },
  'service:github_pr_merged': { witnesses: ['forge', 'device'], note: 'the merge commit' },
  'service:gitlab_push': { witnesses: ['forge', 'device'], note: 'the commit' },
  'service:gitlab_mr_merged': { witnesses: ['forge', 'device'], note: 'the merge commit' },
  'service:bitbucket_push': { witnesses: ['forge', 'device'], note: 'the commit' },
  'service:bitbucket_pr_merged': { witnesses: ['forge', 'device'], note: 'the merge commit' },
  // ── Chain-financial (one transaction, many observers) ─────────────────────────────────────
  send: { witnesses: ['chain', 'mobile', 'relay'], note: 'chain-record lane + USDC watchers + the app record + transfer/record' },
  swap: { witnesses: ['chain', 'mobile', 'relay'], note: 'chain-record lane + USDC watchers + the app record + swap/record' },
  receive: { witnesses: ['chain', 'facilitator'], note: 'the inbound USDC watcher / chain-record inbound scan AND Provian\'s x402 facilitator (the seller\'s side of a settlement) see one transfer' },
  x402_payment: { witnesses: ['chain', 'facilitator'], note: 'the outbound USDC watcher AND Provian\'s x402 facilitator see one payment (both seal under the x402 claim: payer, settlement tx)' },
  agent_token_transfer: { witnesses: ['relay', 'chain'], note: 'transfer/record AND the chain-record lane' },
  agent_native_transfer: { witnesses: ['relay', 'chain'], note: 'transfer/record AND the chain-record lane' },
  // ── Completions (an on-chain release and a counterparty confirmation) ─────────────
  human_job_delivered: { witnesses: ['counterparty', 'institution_chain'], note: 'the poster\'s confirmation or the escrow release' },
  human_job_completed: { witnesses: ['counterparty', 'institution_chain'], note: 'corroborates the delivery' },
  escrow_completed: { witnesses: ['institution_chain', 'counterparty'], note: 'the release the confirmation also witnesses' },
  escrow_resolved: { witnesses: ['institution_chain', 'counterparty'], note: 'the resolution the confirmation also witnesses' },
  promise_fulfilled: { witnesses: ['counterparty', 'mobile'], note: 'both parties\' close-out signatures' },
  // ── The relay's own acts (one event, authored once) ──────────────────────────────────────
  commons_post_created: { witnesses: ['relay'], note: 'the relay performs the post' },
  commons_post_replied: { witnesses: ['relay'], note: 'the relay performs the reply' },
  commons_vote_cast: { witnesses: ['relay'], note: 'the relay performs the vote' },
  commons_post_flagged: { witnesses: ['relay'], note: 'the relay performs the flag' },
  commons_claim_challenged: { witnesses: ['relay'], note: 'the relay records the challenge' },
  commons_challenge_answered: { witnesses: ['relay'], note: 'the relay records the answer' },
  commons_thread_message: { witnesses: ['relay'], note: 'the relay delivers the message' },
  want_posted: { witnesses: ['relay'], note: 'the relay posts the want' },
  job_posted: { witnesses: ['relay'], note: 'the relay posts the job' },
  human_job_posted: { witnesses: ['relay'], note: 'the relay posts the job' },
});

/** True only for a type the table lists with exactly one witness lane. */
export function isSingleLaneActType(actionType: string): boolean {
  const entry = Object.prototype.hasOwnProperty.call(ACT_WITNESS_LANES, actionType)
    ? ACT_WITNESS_LANES[actionType]
    : undefined;
  return entry !== undefined && entry.witnesses.length === 1;
}

/** The lanes recorded for a type, or null when the table does not list it (treated as multi-lane). */
export function witnessLanesOf(actionType: string): readonly WitnessLane[] | null {
  return Object.prototype.hasOwnProperty.call(ACT_WITNESS_LANES, actionType)
    ? ACT_WITNESS_LANES[actionType].witnesses
    : null;
}
