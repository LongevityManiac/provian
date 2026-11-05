import {openPrivatePricing} from './private-pricing';
/**
 * PE METER — the phone's lane: one act of a batch the app sends under wallet auth, mapped to the
 * same pricing inputs `POST /v1/pe/submit/mobile` used, field for field.
 *
 * A phone act's PE carries the keys the mobile submit body carried (`ai_conversation_metadata`,
 * `approval_metadata`, `tx_hash` + `chain_id`, `promise_id` + `counterparty_address`,
 * `corroboration_metadata`, `input_origins`, `output_digests`, `hardware_witness`); the act
 * record's `pricing` is that PE minus identity and free text. What changes from the single-PE
 * route is only what the meter changes everywhere: the PE is hashed and chained on the phone, the
 * relay keeps no copy, and the act's state commits with its batch:
 *
 * - a `human_approval` claims its request in the batch commit (read again there; if the request
 * moved since pricing the batch is re-sent and re-priced);
 * - a Base `send` / `swap` queues its tx hash for the chain-record lane in the batch commit;
 * - the description quality gate is gone with the description (free text never leaves the phone,
 * and since a human-typed record mints nothing anyway);
 * - the 7-day age fence is the meter's 30-day mint window.
 */

import type { Firestore } from 'firebase-admin/firestore';
import type { RecordPEAccrualParams } from '../../pvt-accrual';
import { validateAIConversationMetadata, mergeAIConversationMetadata, type AIConversationMetadata } from '../../routes/pe-submit-mobile-metadata';
import { parseHumanApprovalMetadata, HUMAN_APPROVAL_ACTION_TYPE, type HumanApprovalMetadata } from '../pe/human-approval';
import { createApprovalSealHooks } from '../pvt/human-approval-seal';
import { chainRecordEnqueue, isChainRecordChainId } from '../pvt/chain-record-watcher';
import { mobileChatVerifiedFields } from '../pvt/mobile-chat-earning';
import { isUnnamedActionTypeAtRecordTime, mobileLaneWitnessClass } from '../pvt/class-admission-earning';
import { policyActionTypeValidationError } from '../pvt/policy/action-type-syntax';
import { deriveCompositionSignals } from '../pvt/actor-stats';
import { admitHardwareWitness, sealedHardwareWitness, hardwarePricingLift } from '../hardware/admit';
import { loadPinnedMeasurements } from '../hardware/pinned-measurements';
import type { AppleAssertionDeps } from '../hardware/apple-app-attest-assertion';
import { normalizeInputOrigins } from '../provenance/input-origins';
import { normalizeOutputDigests } from '../provenance/output-digests';
import type { DeviceEconomicAttestationTier } from '../../routes/devices';
import type { MeterTxnHook } from './meter-commit';
import { MeterPreconditionChangedError } from './meter-commit';
import { hardwareNonceOfAct, type ActRecord } from './meter-wire';
import type { LaneActMapping } from './meter-ingest';

export interface MobileBatchLane {
  readonly db: Firestore;
  readonly userId: string;
  /** The authenticated wallet-auth device (the batch's device id). */
  readonly deviceId: string;
  /** Server-resolved tier: hardware only behind a verified Secure Enclave body signature. */
  readonly attestationTier: DeviceEconomicAttestationTier;
  /** The SE device id that survived verification (setup rate limiting), or null. */
  readonly deviceAttestationId: string | null;
  readonly actorAddress: string;
  readonly humanWalletDocId: string | null;
  readonly receivedAtMs: number;
  readonly privacySecret?: string;
  readonly privacyOpenings?:Record<string,string>;
  readonly appleAssertion: AppleAssertionDeps | null;
  /** Hooks committed with the batch, collected as acts are mapped. */
  readonly hooks: MeterTxnHook[];
  /** Post-commit effects (client corroboration), run once the batch committed. */
  readonly afterCommit: (() => Promise<void>)[];
}

/** The approval requests an act of this batch has already verified (one claim per request per batch). */
const APPROVAL_REQUESTS_CLAIMED = new WeakMap<MobileBatchLane, Set<string>>();
function approvalRequestsClaimedIn(lane: MobileBatchLane): Set<string> {
  let set = APPROVAL_REQUESTS_CLAIMED.get(lane);
  if (!set) {
    set = new Set<string>();
    APPROVAL_REQUESTS_CLAIMED.set(lane, set);
  }
  return set;
}

function obj(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Map one phone act to its pricing inputs, or name why the mobile route would have refused it. */
export async function mobileActToAccrualParams(
  lane: MobileBatchLane,
  act: ActRecord,
  relayPeId: string,
): Promise<LaneActMapping> {
  const pricing = openPrivatePricing(act,lane.privacyOpenings?.[act.pe_id]??lane.privacySecret);
  const actionType = act.action_type;
  if (policyActionTypeValidationError(actionType)) return { ok: false, reason: 'invalid_action_type' };

  let chat: AIConversationMetadata | null = null;
  if (actionType === 'ai_conversation') {
    const result = validateAIConversationMetadata(pricing.ai_conversation_metadata);
    if (!result.ok) return { ok: false, reason: `ai_conversation_metadata_invalid:${result.field}` };
    chat = result.value;
  }
  let approval: HumanApprovalMetadata | null = null;
  if (actionType === HUMAN_APPROVAL_ACTION_TYPE) {
    approval = parseHumanApprovalMetadata(pricing.approval_metadata);
    if (approval === null) return { ok: false, reason: 'approval_metadata_invalid' };
  }

  const hardware = await admitHardwareWitness(pricing.hardware_witness, {
    bindingNonce: Buffer.from(hardwareNonceOfAct(act), 'hex'),
    actorKeyFingerprints: new Set<string>(),
    nowMs: lane.receivedAtMs,
    appleAppId: process.env.APPLE_APP_ATTEST_APP_ID ?? null,
    ...(lane.appleAssertion ? { appleAssertion: lane.appleAssertion } : {}),
  });
  const sealedHardware = sealedHardwareWitness(hardware);
  const witnessClass = mobileLaneWitnessClass({
    hardwareAdmitted: hardwarePricingLift(hardware, hardware.admitted ? await loadPinnedMeasurements(lane.db) : undefined),
    unnamedActionType: await isUnnamedActionTypeAtRecordTime(lane.db, { actionType, recordedAtMs: act.timestamp }),
  });

  // / an approval mints only against a REAL pending request, claimed with the batch.
  // One claim per request per batch (fix run 2026-10-24): a later act in the same batch for a
  // request an earlier act already verified records without minting and writes nothing, so the
  // request's stamp names the act that minted.
  let approvalFields: Partial<RecordPEAccrualParams> = {};
  const claimedInBatch = approvalRequestsClaimedIn(lane);
  if (approval !== null && approval.request_id !== null && claimedInBatch.has(approval.request_id)) {
    approvalFields = {};
  } else if (approval !== null) {
    const priced = createApprovalSealHooks({
      db: lane.db, approval, callerUserId: lane.userId, approvalPeId: relayPeId, clientPeId: act.pe_id, nowMs: lane.receivedAtMs,
    });
    await lane.db.runTransaction(async (txn) => { await priced.precondition?.(txn); }, { readOnly: true });
    const pricedVerdict = priced.verdict();
    approvalFields = priced.accrualFields(actionType);
    if (pricedVerdict?.ok === true) claimedInBatch.add(pricedVerdict.verified.requestId);
    const committed = createApprovalSealHooks({
      db: lane.db, approval, callerUserId: lane.userId, approvalPeId: relayPeId, clientPeId: act.pe_id, nowMs: lane.receivedAtMs,
    });
    lane.hooks.push({
      read: async (txn) => {
        await committed.precondition?.(txn);
        const now = committed.verdict();
        const sameOutcome = (now?.ok ?? false) === (pricedVerdict?.ok ?? false)
          && (now !== null && now.ok ? now.verified.claim : null) === (pricedVerdict !== null && pricedVerdict.ok ? pricedVerdict.verified.claim : null);
        if (!sameOutcome) throw new MeterPreconditionChangedError(`human_approval_request:${approval?.request_id ?? 'none'}`);
      },
      write: (txn) => committed.secondaryWrite(txn),
    });
  }

  // a send / swap on a chain the chain-record lane reads (Base, Arbitrum One, OP
  // Mainnet) queues its hash (a pointer) for the lane.
  if ((actionType === 'send' || actionType === 'swap') && lane.humanWalletDocId
    && isChainRecordChainId(pricing.chain_id) && typeof pricing.tx_hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(pricing.tx_hash)) {
    const enqueue = chainRecordEnqueue(lane.db, {
      txHash: pricing.tx_hash,
      walletId: lane.humanWalletDocId,
      source: actionType === 'send' ? 'app_send_record' : 'app_swap_record',
      ownerType: 'human',
      chainId: pricing.chain_id,
    });
    lane.hooks.push({ read: (txn) => enqueue.read(txn), write: (txn) => enqueue.write(txn, relayPeId) });
  }

  // F-A1-3: promise_fulfilled carries its promise id + the counterparty for the mutual-naming bind.
  const counterparty = actionType === 'promise_fulfilled'
    && typeof pricing.counterparty_address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(pricing.counterparty_address)
    ? pricing.counterparty_address
    : null;

  const mergedChat = mergeAIConversationMetadata(chat);
  const params: RecordPEAccrualParams = {
    peId: relayPeId,
    userId: lane.userId,
    actionType,
    integrationSource: 'mobile_pe_submit',
    attestationDepth: lane.attestationTier,
    peHash: act.pe_hash,
    timestamp: act.timestamp,
    isDevicePE: true,
    deviceAttestationId: lane.deviceAttestationId,
    deviceId: lane.deviceId,
    attestation_verified: true,
    ownerType: 'human',
    walletAddress: lane.actorAddress,
    counterpartyAddress: counterparty,
    ...mobileChatVerifiedFields({
      actionType,
      sessionFingerprintHash: chat?.session_fingerprint_hash ?? null,
      surface: chat?.surface ?? null,
    }),
    ...approvalFields,
    inputOrigins: normalizeInputOrigins(pricing.input_origins),
    submissionWitness: { identity: lane.deviceId, tier: lane.attestationTier },
    witnessObservedTokens: null,
    bodyDeclaredTokens: null,
    compositionSignals: deriveCompositionSignals(mergedChat, null, {
      witnessClass,
      sealedHardwareWitness: sealedHardware,
    }),
    outputDigests: normalizeOutputDigests(pricing.output_digests),
    witnessClass,
    witnessedAtMs: lane.receivedAtMs,
  };

  // Pass-2 #31: a client corroboration applies to its target after the batch commits.
  if (actionType === 'corroboration_signal') {
    const meta = obj(pricing.corroboration_metadata);
    if (meta) {
      lane.afterCommit.push(async () => {
        const { parseClientCorroborationMetadata } = await import('../corroboration/clientCorroboration');
        const { applyClientCorroboration } = await import('../corroboration/CorroborationManager');
        const parsed = parseClientCorroborationMetadata(meta);
        if (!parsed) return;
        await applyClientCorroboration({ db: lane.db }, {
          targetPeId: parsed.target_pe_id,
          targetPeHash: parsed.target_pe_hash,
          signalType: parsed.signal_type,
          corroboratingParty: parsed.corroborating_party,
          submitterIdentities: [lane.userId, lane.actorAddress],
          corroboratingPeId: relayPeId,
          evidenceRef: parsed.evidence_ref,
        });
      });
    }
  }
  return { ok: true, params, walletId: lane.humanWalletDocId };
}
