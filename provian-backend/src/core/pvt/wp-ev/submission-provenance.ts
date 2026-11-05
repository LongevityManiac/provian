/**
 * WP-EV — HOW AN ACT REACHED THE RELAY, said honestly.
 *
 * ── THE QUESTION THIS ANSWERS, AND THE ONE IT REFUSES TO ─────────────────────
 * `signatureVerified` was a boolean, and a boolean cannot express the truth about a Genesis
 * grant. The relay AUTHORS those acts itself: `genesis-award-state-machine.ts` emits them
 * through `agent-bank/pe-utils.ts::generatePE` under its own authority, from a qualifying act it
 * observed. There is no earner signature on such a PE — not a missing one, not an unverified
 * one. None exists to verify.
 *
 * A boolean forces a lie either way. `false` says "we expected a signature and did not get one",
 * which gated every Genesis grant out of settlement forever. `true` says "we verified a
 * signature", which is a security claim nothing checked — and asserting it *because the server is
 * the authority* is exactly the defect that produced a false end-to-end proof in M7.
 *
 * So there are THREE admissible answers, not two, and one inadmissible one:
 *
 * earner_signed the earner's own signature was verified at record time
 * server_authored the relay authored the act; no earner signature exists or is claimed
 * unverified a signature was expected and is not verified — Unknown = Block
 * contradictory a verified signature is CLAIMED on an act that structurally has no signer
 *
 * ── PRICED, NOT GATED ────────────────────────────────────────────────────────
 * `server_authored` is fully eligible. Attestation is a multiplier, not a gate — that is the
 * tier system working as designed, and a Genesis grant is already priced by its attestation tier
 * (`software`, 0.8x) exactly like any other software-attested act. This module deliberately
 * introduces NO new economic number: see `SUBMISSION_PROVENANCE_MULTIPLIERS`.
 *
 * ── WHY `contradictory` IS A VERDICT AND NOT A SHRUG ─────────────────────────
 * It is the executable form of the rule the operator set: nothing may ever write a verification-true
 * value for a server-authored act. If a writer starts doing so, the PE does not quietly become
 * more valuable — it becomes INELIGIBLE, loudly, and `submission-provenance.test.ts` fails. The
 * incentive points the right way: a false attestation costs you the mint rather than earning you
 * one.
 *
 * Pure. Reads no database, hashes nothing, prices nothing.
 */

/** How the act reached the relay. */
export type SubmissionProvenance =
  | 'earner_signed'
  | 'server_authored'
  | 'unverified'
  | 'contradictory';

/**
 * `integration_source` values written by paths where the RELAY is the author.
 *
 * Every one of these is a server-side writer: no earner signs, and the provenance of the act is
 * the relay's own observation of it. Taken from the live writers rather than invented —
 * `agent_bank_generate_pe` is the one `canonical-agent-pe-chain.ts:125` already validates as the
 * agent-bank chain's author, and it is the path every Genesis grant travels.
 *
 * An allowlist, not a denylist, and fail-closed: a source not named here is NOT treated as
 * server-authored, so a new writer cannot acquire the classification by default. It would land
 * on `unverified` and be refused until someone classifies it deliberately.
 */
export const SERVER_AUTHORED_INTEGRATION_SOURCES: ReadonlySet<string> = new Set([
  'agent_bank_generate_pe',
  'relay_action',
  // the relay-observed `agent_linked` written by
  // `POST /v1/relay/agent/connect`. It is server-authored in the strictest
  // sense — no earner signs a connect, and the provenance of the link IS the
  // relay's own observation of the handshake. Registering it is what makes the
  // `contradictory` guard below able to fire for this source: unregistered, an
  // `attestation_verified: true` stamp would have classified as `earner_signed`
  // and settleable, which is the exact conflation this module refuses.
  'relay_agent_connect',
  'relay_authorization_decision',
  'relay_request_decision',
  'relay_work_product',
  'wallet_kill_switch',
  'coinbase_onramp_verifier',
  // 2026-08-16 seam ruling: the human `wallet_created` writer
  // (`routes/human-wallet-registration.ts` → the durable registration commit in
  // `genesis-ingress.ts`). The RELAY authors the birth certificate from a registration it
  // processed itself — no earner signature exists on the PE, exactly the Genesis-grant
  // shape this classification was built for. Unregistered, both production
  // `wallet_created` rows classified `unverified` and refused `signature_not_verified`
  // at settlement despite the record path sealing them eligible. The writer sets no
  // `attestation_verified`, so the `contradictory` guard still protects this source: a
  // future verification-true stamp on it refuses rather than mints.
  'human_wallet_registration',
]);

/**
 * The server-authored sources for which `attestation_verified: true` is EXPECTED and HONEST.
 *
 * M9 — this set exists because conflated two different things the flag can mean, and the
 * conflation broke a live earning path. For most server-authored writers the flag could only be
 * claiming "the earner's submission signature was verified", which is impossible when there is no
 * submission signature — so `true` is a contradiction and is refused. But `coinbase_onramp_verifier`
 * sets it (`server.ts`, in the same `buildAccrualParams`/`buildOnrampStoredDoc` pair that stamps
 * the source) to record that THE RELAY ITSELF verified the underlying on-chain event. That is a
 * verification that genuinely happened; it is simply the relay's, not the earner's.
 *
 * Pre-M8, `signatureVerified: Boolean(attestation_verified)` made those PEs eligible and they
 * settled. M8 turned them `contradictory` and therefore permanently refused — a live path made
 * unsettleable by a rule meant to catch liars. Naming the relay-verified sources restores the
 * prior behaviour without weakening the guard for anyone else: it is a strict SUBSET of the
 * server-authored allowlist, and a source outside it that claims verification is still
 * `contradictory`.
 *
 * This changes no economics: the resulting provenance is `server_authored`, whose multiplier is
 * 1.0, and the act is still priced by its attestation tier.
 */
export const RELAY_VERIFIED_INTEGRATION_SOURCES: ReadonlySet<string> = new Set([
  'coinbase_onramp_verifier',
]);

export interface SubmissionProvenanceInput {
  /**
   * `pe_history.attestation_verified` verbatim. `undefined` is distinct from `false` on
   * purpose — most writers never set it at all, and the two mean different things to a reader
   * even though `pe-history.ts` stores both as `false`.
   */
  readonly attestationVerified: boolean | undefined;
  /** `provenance_envelopes.integration_source` verbatim. */
  readonly integrationSource: string | null;
  /**
   * An explicitly recorded provenance, for writers that state it rather than implying it.
   * Preferred over inference when present and recognized; an unrecognized value is ignored
   * rather than trusted, so a typo cannot mint.
   */
  readonly recordedProvenance?: string | null;
}

/**
 * Classify how an act reached the relay.
 *
 * Order matters and the contradiction check comes FIRST. A server-authored PE that also claims a
 * verified signature must never be silently downgraded to either of the honest answers: the
 * whole point is that someone asserted something impossible, and that is worth surfacing.
 */
export function classifySubmissionProvenance(
  input: SubmissionProvenanceInput,
): SubmissionProvenance {
  const serverAuthored = typeof input?.integrationSource === 'string'
    && SERVER_AUTHORED_INTEGRATION_SOURCES.has(input.integrationSource);
  // A relay-verified source is a server-authored source whose `attestation_verified: true` is the
  // relay's own verification of the underlying event, not a claim about an earner signature that
  // does not exist. Honest, so not a contradiction. See the set's own note.
  const relayVerified = typeof input?.integrationSource === 'string'
    && RELAY_VERIFIED_INTEGRATION_SOURCES.has(input.integrationSource);

  if (serverAuthored && !relayVerified && input.attestationVerified === true) return 'contradictory';

  // An explicitly recorded value wins over inference — but only for the two honest answers, and
  // only when it does not contradict the source. Nothing may declare itself `earner_signed` on a
  // server-authored path.
  const recorded = input?.recordedProvenance;
  if (recorded === 'server_authored') return 'server_authored';
  if (recorded === 'earner_signed' && !serverAuthored) return 'earner_signed';

  if (serverAuthored) return 'server_authored';
  if (input?.attestationVerified === true) return 'earner_signed';
  return 'unverified';
}

/** The two provenances an act may settle under. */
export function isSettleableProvenance(provenance: SubmissionProvenance): boolean {
  return provenance === 'earner_signed' || provenance === 'server_authored';
}

/**
 * What each provenance is worth, as a multiplier.
 *
 * BOTH ADMISSIBLE VALUES ARE 1.0, AND THAT IS A DELIBERATE NON-CHOICE. Discounting a
 * server-authored act relative to an earner-signed one is an economic decision, and no such
 * discount has been approved — so this layer applies none rather than inventing a number. What
 * already prices these PEs is the ATTESTATION TIER: a Genesis grant is `software` (0.8x) exactly
 * like any other software-attested act, which is the tier system doing the job it was built for.
 *
 * This table exists so the dimension is NAMED and settable, not so it can be quietly tuned. The
 * two inadmissible values are 0 because they do not settle at all; that is not a price.
 */
export const SUBMISSION_PROVENANCE_MULTIPLIERS: Readonly<Record<SubmissionProvenance, number>> =
  Object.freeze({
    earner_signed: 1.0,
    server_authored: 1.0,
    unverified: 0,
    contradictory: 0,
  });
