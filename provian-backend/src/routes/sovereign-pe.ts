/**
 * POST /v1/pe/submit-sovereign — the sovereign lane, narrowed by.
 *
 * "an agent declaring its own work has no path to a PE,
 * minting or record-only." Standing principle: a PE exists only when something
 * other than the actor vouches for it. The agent's own EIP-191 signature over a
 * work occurrence proves WHO is speaking, never that the work happened, so this
 * route no longer records a self-signed claim at any tier. What remains is the
 * ONE submission whose evidence comes from someone other than the agent: a work
 * occurrence carrying an ADMITTED `hardware_witness` a report a non-actor key
 * (TPM / enclave / CVM / GPU root, verified to its scheme's pinned public root by
 * `core/hardware/admit.ts`) signed over THIS body. That records `hardware_rooted`.
 *
 * Refused with `actor_declared_work_is_not_a_pe` and NOTHING written (no PE, no
 * record_only row, no nonce claim):
 * - `x402_payment` (its settlementTxHash was never re-checked; Provian's chain
 * watcher witnesses x402 settlements independently);
 * - `link_spend` (the observer daemon's transcript lane witnesses the Link CLI
 * result on the agent's box);
 * - a body labelled as a self-report (`mcp_self_report` / `local_witness`);
 * - a compute_or_work occurrence with no hardware witness, or one the verifier
 * does not admit.
 * Already-sealed PEs are untouched.
 *
 * NEW-TYPE INTAKE : "the type of work is never the gate." Beside the KNOWN
 * compute_or_work family, this route also records a type the one intake rule admits on this lane
 * (`core/pvt/policy/new-type-intake.ts`): a NEVER-SEEN type, or a type the operator signed for intake on
 * this lane (`INTAKE_SIGNED_ACTION_TYPES`) whose pending-policy queue row lists only intake lanes,
 * `sovereign_hardware_witness` among them. Such a PE is
 * recorded with NO mint (record_only), lands in the pending-policy queue under
 * `sovereign_hardware_witness`, and earns only from the signed matrix row's activation forward. A
 * NAMED type outside the family stays refused (403 `named_type_witnessed_elsewhere`): its witness is
 * someone else's — a chain, the relay, a forge, a counterparty, Genesis — and a hardware report on
 * the agent's box does not witness it. Every refusal above still applies, unchanged.
 *
 * Security boundary of the admitted path (session-less, signature-authenticated):
 * - TYPE-SCOPED to the KNOWN compute_or_work family (static action-policy matrix), or to a type
 * the new-type intake admits on this lane (judged after the wallet resolves, before any write).
 * - SIGNATURE-BOUND: the recovered EIP-191 signer MUST equal agent_address.
 * - WALLET-BOUND: the signer must be a registered, `active` agent wallet.
 * - REPLAY-PROOF: single-use nonce (atomic setNx, fail-closed) + iat freshness;
 * the binding carries an `occurrence_id` so one signature never covers two acts.
 * - RATE-LIMITED per verified signer, BEFORE hardware verification runs.
 *
 * The signed canonical message is reconstructed byte-identically with the SDK
 * (`provian-agent-sdk/src/sovereign-pe.ts`). Keep the two in lockstep.
 */

import { Router, type Request, type Response } from 'express';
import {openRelayPrivateRequest} from '../core/meter/relay-private-request';
import { ethers } from 'ethers';
import type { AgentBankDeps } from '../core/agent-bank/types';
import { generatePE } from '../core/agent-bank/pe-utils';
import { normalizeInputOrigins } from '../core/provenance/input-origins';
import {
  ACTOR_DECLARED_REFUSAL_STATUS,
  actorDeclaredRefusal,
  refuseActorDeclared,
} from '../core/provenance/actor-declared-refusal';
import { isSelfReportLabelled } from '../core/provenance/device-observation-types';
import { admitHardwareWitness, hardwarePricingLift, sealedHardwareWitness, hardwareBindingNonce } from '../core/hardware/admit';
import { loadPinnedMeasurements } from '../core/hardware/pinned-measurements';
import type { AgentWalletDocument } from '../core/agent-wallet/types';
import { PROPOSED_ACTION_POLICY_ENTRIES } from '../core/pvt/policy/proposed-action-policy';
import { policyActionTypeValidationError } from '../core/pvt/policy/action-type-syntax';
import { SOVEREIGN_HARDWARE_WITNESS_SOURCE, judgeNewTypeIntake } from '../core/pvt/policy/new-type-intake';

const SOVEREIGN_WORK_CANONICAL_TAG = 'provian_sovereign_work_v1';
const FRESHNESS_WINDOW_MS = 5 * 60 * 1000; // ±5 minutes
const NONCE_TTL_S = 600; // 10 minutes (> freshness window, so a stale replay is rejected by iat anyway)
/**
 * C3 — COUPLING CONSTRAINT. Read this before raising the number below.
 *
 * `pe_chain_tips/{user}` is a single document per user, and advancing it is the
 * per-user hash chain's total order — that serialisation IS the tamper-evident
 * chain, not an implementation detail. Firestore sustains roughly ONE
 * transaction per second per document, so a single user's durable PE rate has a
 * structural ceiling of about 1 PE/sec (1,000/sec absolute, via strict
 * millisecond monotonicity).
 *
 * Today's transport limits — 30/min per verified sovereign signer, 60/min per
 * device — keep every caller a comfortable ~30-60x under that. Raise either
 * above ~60/min and chain-tip contention becomes the FIRST thing to break, not
 * the throughput you were trying to buy: transactions start retrying against
 * each other and latency climbs before the limit is ever reached.
 *
 * There is no code change owed here today, and none is hidden — the ceiling is
 * inherent to per-user chain ordering, so lifting it means changing how that
 * order is maintained, which is architecture rather than tuning. This comment
 * exists so the interaction cannot be rediscovered the hard way.
 */
const RATE_LIMIT_PER_MIN = 30; // per verified signer

const NONCE_RE = /^0x[0-9a-fA-F]{64}$/;
const OCCURRENCE_ID_RE = /^[A-Za-z0-9_.:@/=+-]{8,200}$/;

/**
 * The KNOWN compute_or_work family, derived once from the static action-policy matrix.
 * Read-only consumption of `PROPOSED_ACTION_POLICY_ENTRIES` — this file imports the
 * matrix, it never changes it (no new "emitted" action_type literal here; the accepted
 * type comes from the request and is checked against this set). Gating on the STATIC set
 * deliberately confines the session-less channel to the known family, never an arbitrary
 * runtime-registered compute_or_work type.
 */
const SOVEREIGN_WORK_TYPES: ReadonlySet<string> = new Set(
  PROPOSED_ACTION_POLICY_ENTRIES
    .filter((e) => e.evidence_requirement === 'verified_compute_or_work')
    .map((e) => e.action_type),
);

interface SovereignPEBody {
  /** §2.9: the hardware-witness slot (verified against its scheme root; nonce = sha256 of this body minus the slot). */
  hardware_witness?: unknown;
  action_type?: unknown;
  agent_address?: unknown;
  occurrence_id?: unknown;
  nonce?: unknown;
  iat?: unknown;
  signature?: unknown;
  metadata?: unknown;
  /**
   * Prompt 1 (forward-only): external input origins the work consumed. UNSIGNED
   * — it is NOT part of the sovereign binding (which covers action_type /
   * agent_address / occurrence_id|payer / nonce / iat only), matching the x402
   * precedent where resource.url / payTo ride as unsigned metadata. It is
   * carried as pure provenance on the stored PE chain doc (hashed by
   * canonicalAgentPeHash) with ZERO mint effect. Binding it into the signature
   * is a later, money-adjacent concern (pricing) and would move the canonical
   * message format — deliberately out of scope here.
   */
  input_origins?: unknown;
  /** Trust Layer build §2.3: forward-only output digests (stored unhashed beside input_origins). */
  output_digests?: unknown;
}

/** Byte-identical to the SDK's buildSovereignWorkCanonicalMessage (compute/work). */
function buildSovereignWorkCanonicalMessage(f: {
  action_type: string; agent_address: string; occurrence_id: string; nonce: string; iat: number;
}): string {
  return [
    SOVEREIGN_WORK_CANONICAL_TAG,
    `action_type=${f.action_type}`,
    `agent_address=${f.agent_address.toLowerCase()}`,
    `iat=${f.iat}`,
    `nonce=${f.nonce.toLowerCase()}`,
    `occurrence_id=${f.occurrence_id}`,
  ].join('\n');
}

export function createSovereignPERouter(deps: AgentBankDeps): Router {
  const { db, cache } = deps;
  const router = Router();

  router.post('/', async (req: Request, res: Response): Promise<void> => {
    // The single-use nonce is claimed (setNx) BEFORE generatePE so two concurrent
    // identical envelopes can't both record. If generatePE throws after the claim, we
    // release the nonce so a retry of the same envelope can re-record (#31); nulled once
    // the PE is durably written so a post-write error never releases a live nonce.
    let claimedNonceKey: string | null = null;
    try {
      const body = openRelayPrivateRequest(req.body ?? {},'/v1/pe/submit-sovereign') as SovereignPEBody;
      const { action_type, agent_address, occurrence_id, nonce, iat, signature } = body;

      // 1. the families whose witness is someone else's refuse outright,
      //    before any read or side effect.
      if (action_type === 'x402_payment') {
        refuseActorDeclared(res, 'x402_payment_is_chain_witnessed',
          'A self-reported x402 payment is not a PE. Provian\'s chain watcher witnesses the on-chain '
          + 'settlement of an x402 payment; nothing needs to be submitted.');
        return;
      }
      if (action_type === 'link_spend') {
        refuseActorDeclared(res, 'link_spend_is_transcript_witnessed',
          'A self-reported Link spend is not a PE. The observer daemon on the agent\'s machine witnesses '
          + 'the Link CLI spend-request result; nothing needs to be submitted.');
        return;
      }
      // 2. Type syntax. Any well-formed action_type may be submitted (new-type intake); which
      //    types this lane records is judged at step 7b, once the signer's wallet resolves.
      const actionTypeError = policyActionTypeValidationError(action_type);
      if (typeof action_type !== 'string' || actionTypeError !== null) {
        res.status(400).json({
          error: actionTypeError ?? 'action_type is required',
          code: 'SOVEREIGN_PE_TYPE_NOT_ALLOWED',
        });
        return;
      }
      const workFamily = SOVEREIGN_WORK_TYPES.has(action_type);
      if (isSelfReportLabelled(body.metadata)) {
        refuseActorDeclared(res, 'self_report_source');
        return;
      }
      // 3. no non-actor witness slot → the body is the agent's own claim.
      if (body.hardware_witness === undefined || body.hardware_witness === null) {
        refuseActorDeclared(res, 'no_non_actor_witness',
          'A sovereign submission signed only by the agent is its own claim about its work, and is not a PE. '
          + 'This route records only an occurrence carrying an admitted hardware_witness (a report a non-actor '
          + 'hardware root signed over this body). Work on the agent\'s machine is recorded by the observer daemon.');
        return;
      }

      // 4. Shape checks.
      if (
        typeof agent_address !== 'string'
        || typeof nonce !== 'string'
        || typeof signature !== 'string'
        || typeof iat !== 'number'
        || !Number.isFinite(iat)
      ) {
        res.status(400).json({ error: 'missing or invalid fields', code: 'SOVEREIGN_PE_BAD_REQUEST' });
        return;
      }
      if (!NONCE_RE.test(nonce)) {
        res.status(400).json({ error: 'nonce must be 0x followed by 64 hex chars', code: 'SOVEREIGN_PE_BAD_NONCE' });
        return;
      }
      if (typeof occurrence_id !== 'string' || !OCCURRENCE_ID_RE.test(occurrence_id)) {
        res.status(400).json({
          error: 'a sovereign submission requires occurrence_id (8-200 chars, [A-Za-z0-9_.:@/=+-])',
          code: 'SOVEREIGN_PE_BAD_OCCURRENCE',
        });
        return;
      }

      // 5. Freshness window.
      if (Math.abs(Date.now() - iat) > FRESHNESS_WINDOW_MS) {
        res.status(400).json({ error: 'iat is outside the freshness window', code: 'SOVEREIGN_PE_STALE' });
        return;
      }

      // 6. Recover the signer from the EIP-191 signature over the canonical work message.
      const message = buildSovereignWorkCanonicalMessage({ action_type, agent_address, occurrence_id, nonce, iat });
      let recovered: string;
      try {
        recovered = ethers.verifyMessage(message, signature);
      } catch {
        res.status(401).json({ error: 'invalid signature', code: 'SOVEREIGN_PE_BAD_SIGNATURE' });
        return;
      }
      const signerLower = recovered.toLowerCase();
      if (signerLower !== agent_address.toLowerCase()) {
        res.status(401).json({ error: 'recovered signer does not match agent_address', code: 'SOVEREIGN_PE_SIGNER_MISMATCH' });
        return;
      }

      // 7. Resolve the sovereign agent wallet by its on-chain address (stored LOWERCASE).
      let checksummed: string;
      try {
        checksummed = ethers.getAddress(recovered);
      } catch {
        res.status(401).json({ error: 'invalid signer address', code: 'SOVEREIGN_PE_BAD_SIGNATURE' });
        return;
      }
      const snap = await db.collection('agent_wallets').where('address', '==', signerLower).limit(1).get();
      if (snap.empty) {
        res.status(404).json({ error: 'no agent wallet for the signer address', code: 'SOVEREIGN_PE_WALLET_NOT_FOUND' });
        return;
      }
      const wallet = snap.docs[0].data() as AgentWalletDocument;
      if (wallet.status !== 'active') {
        res.status(403).json({ error: 'agent wallet is not active', code: 'SOVEREIGN_PE_WALLET_INACTIVE' });
        return;
      }

      // 7b. New-type intake (, A1). Outside the compute_or_work family the type must
      //     pass the one intake rule on THIS lane: never-seen (static, no read), or signed for intake
      //     on this lane and entered through it (one queue read). Any other named type is refused; a queue
      //     read failure refuses (Unknown = Block). Judged before the rate limit and the hardware
      //     verification, so a refusal writes nothing.
      if (!workFamily) {
        const intake = await judgeNewTypeIntake(db, { actionType: action_type, laneSource: SOVEREIGN_HARDWARE_WITNESS_SOURCE });
        if (!intake.admitted) {
          if (intake.reason === 'intake_queue_unreadable') {
            res.status(503).json({ error: 'new-type intake unavailable; retry', code: 'SOVEREIGN_PE_INTAKE_UNAVAILABLE' });
            return;
          }
          if (intake.reason === 'relay_owned_namespace') {
            refuseActorDeclared(res, 'relay_owned_namespace',
              `${action_type} is in a namespace the relay names for its own witness lanes (a forge webhook, the commit `
              + 'family); no hardware report on the agent\'s machine witnesses it, so this route does not record it.');
            return;
          }
          refuseActorDeclared(res, 'named_type_witnessed_elsewhere',
            `${action_type} is a named type whose witness is someone else's (a chain, the relay, a forge, a counterparty, `
            + 'Genesis, or the observer daemon), not a hardware report on the agent\'s machine, so this route does not '
            + 'record it. This route records a compute_or_work occurrence, or a never-seen type for review, carrying an '
            + 'admitted hardware_witness.');
          return;
        }
      }

      // 8. Per-signer rate limit (keyed to the VERIFIED signer), before hardware verification.
      const rl = await cache.checkRateLimit(`sovereign_pe_rate:${signerLower}`, RATE_LIMIT_PER_MIN, 60);
      if (!rl.allowed) {
        res.status(429).json({ error: 'rate limit exceeded', code: 'SOVEREIGN_PE_RATE_LIMITED', retryAfter: rl.retryAfter });
        return;
      }

      // 9. the non-actor witness must be ADMITTED (nonce-bound to this body,
      //    chained to its scheme's pinned public root). A present-but-unverifiable
      //    report is refused here, before the nonce is claimed: an unadmitted report
      //    leaves only the agent's own claim, which is never a PE.
      const sovereignHardware = await admitHardwareWitness(body.hardware_witness, {
        bindingNonce: hardwareBindingNonce(body),
        actorKeyFingerprints: new Set<string>(),
        nowMs: Date.now(),
      });
      if (!sovereignHardware.admitted) {
        res.status(ACTOR_DECLARED_REFUSAL_STATUS).json({
          ...actorDeclaredRefusal('hardware_witness_not_admitted',
            'The hardware_witness did not verify, so this submission is only the agent\'s own claim, which is not '
            + 'a PE.'),
          hardware_witness_reason: sovereignHardware.verdict?.reason ?? null,
        });
        return;
      }
      const sealedSovereignHardware = sealedHardwareWitness(sovereignHardware);

      // 10. Single-use nonce (atomic, fail-closed). False = already used OR cache down.
      const nonceKey = `sovereign_pe_nonce:${signerLower}:${nonce.toLowerCase()}`;
      const claimed = await cache.setNx(nonceKey, '1', NONCE_TTL_S);
      if (!claimed) {
        res.status(409).json({ error: 'nonce already used or replay protection unavailable', code: 'SOVEREIGN_PE_NONCE_USED' });
        return;
      }
      claimedNonceKey = nonceKey;

      // 11. The hardware-rooted work PE. The metadata is built entirely server-side —
      //     the client cannot inject `verified`, and no agent-written text (description)
      //     is sealed: the hardware report vouches for this body, not for prose. Mint-once
      //     is enforced by the (binding_signer, occurrence_id) occurrence claim, co-committed
      //     with pe_history; the deterministic canonical event satisfies the
      //     verified_compute_or_work canonical-event gate. A new-type intake PE rides the same
      //     binding: it seals record_only (no named row) and is queued under
      //     `sovereign_hardware_witness` (the accrual files a verified sovereign occurrence there);
      // once the operator signs an eligible row for its type, the same durable path, canonical event
      //     and occurrence claim mint it once — from the row's activation forward only.
      const metadata: Record<string, unknown> = {
        sovereign_work: true,
        occurrence_id,
        binding_signature: signature,
        binding_signer: checksummed,
        verified: true,
        ...(sealedSovereignHardware ? { hardware_witness: sealedSovereignHardware } : {}),
      };
      const generated = await generatePE(deps, {
        walletId: wallet.id,
        agentId: wallet.agent_id,
        actorAddress: checksummed,
        actionType: action_type,
        ownerType: 'agent',
        observedCanonicalEventId: `sovereign_work:${signerLower}:${occurrence_id}`,
        durableViaOrdinaryIntake: true,
        metadata,
        input_origins: normalizeInputOrigins(body.input_origins),
        output_digests: body.output_digests,
        // Measured observer: a TPM / cloud report lifts only under a measurement the signed release channel pins.
        witnessClass: hardwarePricingLift(sovereignHardware, await loadPinnedMeasurements(deps.db)) ? 'hardware_rooted' : 'device_tier',
        sealedHardwareWitness: sealedSovereignHardware, // the attested-facts source
      });

      // PE durably written — the nonce now legitimately guards replay of THIS envelope.
      claimedNonceKey = null;
      res.status(201).json({ pe_id: generated.peId, recorded: true, family: workFamily ? 'compute_or_work' : 'new_type_intake' });
    } catch (error) {
      if (claimedNonceKey) {
        await cache.del(claimedNonceKey).catch(() => { /* best effort; TTL reclaims it */ });
      }
      console.error('[SovereignPE] submission error:', error);
      res.status(409).json({ error: 'could not record sovereign PE; retry', code: 'SOVEREIGN_PE_CONTENTION' });
    }
  });

  return router;
}
