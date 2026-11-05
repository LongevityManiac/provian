import {openPrivatePricing} from './private-pricing';
/**
 * PE METER — a device batch's act, turned into the accrual's pricing inputs.
 *
 * This is the per-PE body of `POST /v1/pe/submit` (routes/devices.ts) carried onto the meter,
 * gate for gate and overlay for overlay — 's refusals (self-report label, unbound body,
 * non-observation type, non-transcript link_spend), the lineage verifier, validation, the
 * attestation tier, the hardware witness, the device-witnessed / commit / chat overlays, the
 * forged-volume bound — so a metered act prices exactly as it did when it arrived alone. New-type
 * intake opens one door beside them: a non-observation type the observer daemon
 * marked as a registered gateway plugin's observation, never-seen or signed for intake on this lane
 * (`INTAKE_SIGNED_ACTION_TYPES`) with a queue row from this lane only,
 * records (record_only, queued under `device_gateway_observer`) and earns only from a signed row. What changed is only where its bytes come from (the act record) and where its
 * outcome goes (the batch), not how it is priced.
 *
 * Two facts are per batch, not per act, and are computed once: the device's attestation tier
 * and its session-lineage registry (judged in memory over the batch and written by the commit,
 * so a retried batch re-judges from the same registry and reaches the same verdicts).
 */

import type { Firestore } from 'firebase-admin/firestore';
import type { DeviceDocument } from '../../routes/middleware/device-auth';
import {
  canonicalDeviceEconomicAttestationTier,
  HARDWARE_CAPABILITIES,
  resolveAttestationTierFromSigning,
  type AttestationVerificationResult,
} from '../../routes/devices';
import type { RecordPEAccrualParams } from '../../pvt-accrual';
import { resolveX402PayerAddress, resolveX402SettlementTxHash } from '../../pvt-accrual';
import { resolveAgentChainOwnerId, type AgentChainOwnerDeps } from '../agent-wallet/agent-chain-owner';
import { admitHardwareWitness, actorKeyFingerprints, sealedHardwareWitness, hardwarePricingLift } from '../hardware/admit';
import { loadPinnedMeasurements } from '../hardware/pinned-measurements';
import { normalizeInputOrigins } from '../provenance/input-origins';
import { normalizeOutputDigests } from '../provenance/output-digests';
import {
  BUILT_IN_LANE_ONLY_ACTION_TYPES,
  carriesBuiltInLaneMarker,
  isDaemonToolOrchestrationLane,
  isDeviceObservationActionType,
  isSelfReportLabelled,
} from '../provenance/device-observation-types';
import { deriveCompositionSignals } from '../pvt/actor-stats';
import { deviceSubmitLaneHint } from '../pvt/capture-lane';
import { intakeSignedRowWitnessedFields, isSignedIntakeRowEligibleAtRecordTime } from '../pvt/class-admission-earning';
import { commitWitnessedVerifiedFields, deviceWitnessedVerifiedFields } from '../pvt/device-witnessed-earning';
import {
  DEVICE_SESSION_REGISTRY_COLLECTION,
  judgeDeviceSessionAdmission,
  nextRegistryDocument,
  type DeviceSessionRegistryDocument,
} from '../pvt/device-session-registry';
import { verifyEconomicSessionLineage, type EconomicSessionLineageClaim } from '../pvt/economic-session-lineage';
import { financialIdentityFromMetadata } from '../pvt/activity-mint-limits';
import { validateLinkSpendMetadata } from '../pvt/link-spend-witness';
import { deviceChatVerifiedFields } from '../pvt/mobile-chat-earning';
import { deviceWitnessObservedTokens, readComputeTokens } from '../pvt/origin-pricing-inputs';
import { policyActionTypeValidationError } from '../pvt/policy/action-type-syntax';
import {
  DEVICE_GATEWAY_OBSERVER_SOURCE,
  OBSERVER_PLUGIN_SOURCE,
  hasObserverPluginWitnessMarker,
  judgeNewTypeIntake,
  newTypeIntakeCache,
  type NewTypeIntakeCache,
} from '../pvt/policy/new-type-intake';
import type { WitnessClass } from '../pvt/policy/evidence-class';
import { hardwareNonceOfAct, type ActRecord } from './meter-wire';

export interface DeviceBatchLane {
  readonly db: Firestore;
  readonly device: DeviceDocument;
  readonly ownerId: string;
  readonly signatureAuthenticated: boolean;
  readonly bodyBound: boolean;
  readonly attestationTier: string;
  readonly receivedAtMs: number;
  readonly privacySecret?: string;
  readonly privacyOpenings?:Record<string,string>;
  /** In-memory session-lineage registry for this batch (written by the commit). */
  lineage: DeviceSessionRegistryDocument | null;
  lineageTouched: boolean;
  /** New-type intake: one pending-policy queue read per gateway type per batch. */
  readonly intakeCache?: NewTypeIntakeCache;
}

export async function openDeviceBatchLane(input: {
  readonly db: Firestore;
  readonly cache: AgentChainOwnerDeps['cache'];
  readonly device: DeviceDocument;
  readonly signatureAuthenticated: boolean;
  readonly bodyBound: boolean;
  readonly receivedAtMs: number;
  readonly privacySecret?: string;
  readonly privacyOpenings?:Record<string,string>;
}): Promise<DeviceBatchLane> {
  const { db, cache, device, signatureAuthenticated } = input;
  const ownerId = await resolveAgentChainOwnerId({ db, cache }, device);
  // the standing rule : an SE device on its bearer secret is never hardware-priced.
  const seDeviceOnBearer = !signatureAuthenticated && device.signing_method === 'secure_enclave_p256';
  let walletSecLevel: string | null = null;
  if (!seDeviceOnBearer && device.owner_type === 'human' && HARDWARE_CAPABILITIES.includes(device.attestation_capability)) {
    try {
      const q = await db.collection('wallets').where('user_id', '==', ownerId).limit(1).get();
      if (!q.empty) {
        const data = q.docs[0].data();
        walletSecLevel = data.attested_security_level || data.security_level || null;
      }
    } catch {
      walletSecLevel = null; // no evidence → the resolver downgrades fail-closed
    }
  }
  const attestation: AttestationVerificationResult = seDeviceOnBearer
    ? { verifiedCapability: 'software', downgraded: true, reason: 'se_device_bearer_auth_software' }
    : resolveAttestationTierFromSigning({
      signingMethod: signatureAuthenticated ? device.signing_method : 'bearer',
      ownerType: device.owner_type,
      platform: device.platform,
      claimedCapability: device.attestation_capability,
      walletSecurityLevel: walletSecLevel,
      attestedSecurityLevel: device.attested_security_level ?? null,
    });
  const lineageSnap = await db.collection(DEVICE_SESSION_REGISTRY_COLLECTION).doc(device.device_id).get();
  return {
    db,
    device,
    ownerId,
    signatureAuthenticated,
    bodyBound: input.bodyBound,
    attestationTier: canonicalDeviceEconomicAttestationTier(attestation.verifiedCapability),
    receivedAtMs: input.receivedAtMs,
    privacySecret: input.privacySecret,
    privacyOpenings: input.privacyOpenings,
    lineage: lineageSnap.exists ? (lineageSnap.data() as DeviceSessionRegistryDocument) : null,
    lineageTouched: false,
    intakeCache: newTypeIntakeCache(),
  };
}

export type DeviceActMapping =
  | { readonly ok: true; readonly params: RecordPEAccrualParams; readonly note?: string; readonly walletId?: string | null }
  | { readonly ok: false; readonly reason: string };

function obj(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Any trace of the observer's gateway-plugin marker — its `source`, or an `observer_plugin` name —
 * whether or not the name is well formed (a malformed marker is still a plugin's act).
 */
function carriesObserverPluginMarker(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata) return false;
  return metadata.source === OBSERVER_PLUGIN_SOURCE || Object.prototype.hasOwnProperty.call(metadata, 'observer_plugin');
}

/** Map one act to its pricing inputs, or name why the device route would have refused it. */
export async function deviceActToAccrualParams(
  lane: DeviceBatchLane,
  act: ActRecord,
  relayPeId: string,
): Promise<DeviceActMapping> {
  const { device } = lane;
  const pricing = openPrivatePricing(act,lane.privacyOpenings?.[act.pe_id]??lane.privacySecret);
  const actionType = act.action_type;
  if (device.owner_type !== 'agent' && ['agent_tool_orchestration', 'agent_api_orchestration', 'link_spend'].includes(actionType)) return { ok: false, reason: 'tool_capture_agents_only' };

  const metadata = obj(pricing.metadata) ?? undefined;
  const compute = obj(pricing.compute);
  const executionEnv = obj(pricing.execution_env);

  // §2.9 the hardware witness, nonce-bound to THIS act record.
  let witnessClass: WitnessClass = 'device_tier';
  const hardwareAdmission = await admitHardwareWitness(pricing.hardware_witness, {
    bindingNonce: Buffer.from(hardwareNonceOfAct(act), 'hex'),
    actorKeyFingerprints: actorKeyFingerprints([device.signing_public_key]),
    nowMs: lane.receivedAtMs,
    appleAppId: process.env.APPLE_APP_ATTEST_APP_ID ?? null,
  });
  const sealedHardware = sealedHardwareWitness(hardwareAdmission);
  // Measured observer: a TPM / cloud report lifts only under a measurement the signed release channel pins.
  if (hardwarePricingLift(hardwareAdmission, hardwareAdmission.admitted ? await loadPinnedMeasurements(lane.db) : undefined)) witnessClass = 'hardware_rooted';

  // PEs prove provenance.
  if (isSelfReportLabelled(metadata)) return { ok: false, reason: 'actor_declared:self_report_source' };
  if (!lane.bodyBound && !hardwareAdmission.admitted) return { ok: false, reason: 'actor_declared:device_body_not_bound' };
  // New-type intake (, A2 — the gateway witness): a type outside the observation
  // lanes is admitted only when the observer daemon itself (never the plugin) marked the act as a
  // registered plugin's observation AND the type passes the one intake rule (never-seen, or entered
  // through this lane). It records with no mint until the operator signs a row for it. Anything else is
  // refused exactly as before.
  let intakeAdmitted = false;
  if (!isDeviceObservationActionType(actionType)) {
    if (!hasObserverPluginWitnessMarker(metadata)) return { ok: false, reason: 'actor_declared:action_type_not_observed' };
    const verdict = await judgeNewTypeIntake(lane.db, { actionType, laneSource: DEVICE_GATEWAY_OBSERVER_SOURCE }, lane.intakeCache);
    if (!verdict.admitted) {
      // Unknown = Block, but never a SEALED refusal: a refused act is committed into the device's
      // hash-chained batch and its resend gets the same receipt. A queue read failure therefore
      // fails the whole batch (the route answers 500), and the daemon resends it.
      if (verdict.reason === 'intake_queue_unreadable') throw new Error('new_type_intake_queue_unreadable');
      return { ok: false, reason: verdict.reason === 'invalid_action_type' ? 'invalid_action_type' : `actor_declared:${verdict.reason}` };
    }
    intakeAdmitted = true;
  }
  // The observer stamps its gateway-plugin marker on EVERY PE a third-party plugin hands it (
  // follow-up, 2026-10-23); only its built-in lanes carry a lane marker. A plugin-marked act that also
  // names a built-in lane, or is of a type only a built-in lane witnesses (a transcript-witnessed
  // `link_spend`, a daemon lane's tool orchestration), is the plugin claiming a lane it is not.
  if (carriesObserverPluginMarker(metadata)) {
    if (carriesBuiltInLaneMarker(metadata)) return { ok: false, reason: 'actor_declared:observer_plugin_names_built_in_lane' };
    if (BUILT_IN_LANE_ONLY_ACTION_TYPES.has(actionType)) return { ok: false, reason: 'actor_declared:observer_plugin_built_in_lane_type' };
  }
  if (actionType === 'link_spend' && metadata?.source !== 'transcript') {
    return { ok: false, reason: 'actor_declared:link_spend_not_transcript_witnessed' };
  }
  // one program, one lane. A tool-call PE that names no daemon lane is a retired
  // per-harness / per-framework integration (or anything else holding the device credential).
  if (actionType === 'agent_tool_orchestration' && !isDaemonToolOrchestrationLane(metadata)) {
    return { ok: false, reason: 'tool_orchestration_not_daemon_lane' };
  }

  // witnessed capture context, judged in memory over the batch.
  // carried: a REJECTED lineage claim never costs the record. The single-PE route retried
  // without the claim; the meter prices the act without it and tells the device why, with the
  // ordinal the relay would admit, so its next session resynchronises.
  let verifiedSessionLineageId: string | null = null;
  let note: string | undefined;
  if (pricing.economic_session_lineage !== undefined && pricing.economic_session_lineage !== null) {
    const verdict = verifyEconomicSessionLineage(
      pricing.economic_session_lineage,
      device.device_id ?? null,
      [device.owner_user_id, device.owner_wallet_id, device.owner_address],
    );
    if (!verdict.ok) {
      note = `lineage_rejected:${verdict.reason}`;
    } else {
      const claim = pricing.economic_session_lineage as EconomicSessionLineageClaim;
      const admission = judgeDeviceSessionAdmission(lane.lineage, claim, lane.receivedAtMs);
      if (!admission.ok) {
        note = `lineage_rejected:${admission.reason}:expected_ordinal=${admission.expectedOrdinal ?? 'none'}`;
      } else {
        lane.lineage = nextRegistryDocument(lane.lineage, device.device_id, claim, admission, lane.receivedAtMs);
        lane.lineageTouched = true;
        verifiedSessionLineageId = verdict.lineageId;
      }
    }
  }


  const actionTypeError = policyActionTypeValidationError(actionType);
  if (actionTypeError) return { ok: false, reason: 'invalid_action_type' };
  if (actionType === 'link_spend') {
    const linkSpend = validateLinkSpendMetadata(metadata);
    if (!linkSpend.ok) return { ok: false, reason: `link_spend_invalid:${linkSpend.code}` };
  }
  if (actionType === 'agent_tool_orchestration'
    && (typeof metadata?.tool_count !== 'number' || (metadata.tool_count as number) < 1)) {
    return { ok: false, reason: 'agent_tool_orchestration_requires_tool_count' };
  }
  if (actionType === 'agent_api_orchestration'
    && (typeof metadata?.api_count !== 'number' || (metadata.api_count as number) < 1)) {
    return { ok: false, reason: 'agent_api_orchestration_requires_api_count' };
  }

  const replicationPack = obj(pricing.replication_pack);
  const replicationPackData: RecordPEAccrualParams['replication_pack'] = replicationPack
    && typeof replicationPack.input_hash === 'string' && typeof replicationPack.output_hash === 'string'
    ? {
      input_hash: replicationPack.input_hash,
      output_hash: replicationPack.output_hash,
      model_id: (replicationPack.model_id as string) || null,
      model_checkpoint_hash: (replicationPack.model_checkpoint_hash as string) || null,
      pack_hash: (replicationPack.pack_hash as string) || null,
    }
    : undefined;
  const attestationDepth = replicationPackData ? 'software_verified' : lane.attestationTier;
  const nullStateFlags = Array.isArray(metadata?.null_state_flags) ? (metadata?.null_state_flags as unknown[]) : [];
  const noObservableOutput = actionType === 'compute_session' && nullStateFlags.includes('no_observable_output');
  const nativeFinancialIdentity = financialIdentityFromMetadata(actionType, metadata);
  const commitSha = typeof metadata?.commit_sha === 'string' ? metadata.commit_sha : null;

  const witnessedVerifiedFields = deviceWitnessedVerifiedFields({
    actionType, bodyBound: lane.bodyBound, metadata, sessionLineageId: verifiedSessionLineageId,
  });
  const commitWitnessedFields = commitWitnessedVerifiedFields({ actionType, bodyBound: lane.bodyBound, commitSha });
  const aiConversationVerifiedFields = deviceChatVerifiedFields({
    actionType,
    bodyBound: lane.bodyBound,
    sessionFingerprintHash: typeof metadata?.session_fingerprint_hash === 'string' ? metadata.session_fingerprint_hash : null,
    surface: typeof metadata?.surface === 'string' ? metadata.surface : null,
  });
  // A4: an intake type earns once its SIGNED row is in force at the act's record time — never before.
  const intakeEarningFields = intakeAdmitted
    ? intakeSignedRowWitnessedFields({
      actionType,
      intakeAdmitted,
      signedRowEligible: await isSignedIntakeRowEligibleAtRecordTime(lane.db, { actionType, recordedAtMs: act.timestamp, witnessClass }),
      witnessClass,
      witnessId: device.device_id ? `device:${device.device_id}` : null,
      bodyDigestHex: hardwareNonceOfAct(act),
    })
    : {};
  const inputOrigins = normalizeInputOrigins(pricing.input_origins);
  const outputDigests = normalizeOutputDigests(pricing.output_digests);

  const params: RecordPEAccrualParams = {
    peId: relayPeId,
    userId: lane.ownerId,
    actionType,
    // The same integration source as the single-PE device route: it feeds the capture-lane
    // derivation and every source-keyed rule, so a metered act prices byte-identically. A gateway
    // plugin's intake act is filed under its own lane source (the queue row names the lane).
    integrationSource: intakeAdmitted ? DEVICE_GATEWAY_OBSERVER_SOURCE : 'device_pe_submit',
    captureLane: deviceSubmitLaneHint(metadata?.tool),
    economicSessionLineageId: verifiedSessionLineageId,
    attestationDepth,
    peHash: act.pe_hash,
    timestamp: act.timestamp,
    replication_pack: replicationPackData,
    isDevicePE: true,
    deviceId: device.device_id || null,
    deviceAttestationId: device.device_id || null,
    attestation_verified: true,
    noObservableOutput,
    commitSha,
    ownerType: device.owner_type,
    walletAddress: device.owner_address || null,
    citedPeIds: null,
    parentGoalPeId: typeof pricing.parent_goal_pe_id === 'string' ? pricing.parent_goal_pe_id : null,
    x402PayerAddress: resolveX402PayerAddress(actionType, metadata),
    x402SettlementTxHash: resolveX402SettlementTxHash(actionType, metadata),
    counterpartyAddress: nativeFinancialIdentity.counterparty,
    ...witnessedVerifiedFields,
    ...commitWitnessedFields,
    ...aiConversationVerifiedFields,
    ...intakeEarningFields,
    inputOrigins,
    submissionWitness: lane.bodyBound && device.device_id
      ? { identity: device.device_id, tier: attestationDepth }
      : null,
    witnessObservedTokens: deviceWitnessObservedTokens({ bodyBound: lane.bodyBound, compute }),
    bodyDeclaredTokens: readComputeTokens(compute),
    compositionSignals: deriveCompositionSignals(metadata, executionEnv, {
      witnessClass,
      sealedHardwareWitness: sealedHardware,
    }),
    outputDigests,
    witnessClass,
    witnessedAtMs: lane.receivedAtMs,
  };
  return { ok: true, params, walletId: device.owner_wallet_id ?? null, ...(note ? { note } : {}) };
}

/** The lineage registry row to write with the batch commit (null when no act touched it). */
export function laneLineageWrite(lane: DeviceBatchLane): { readonly ref: FirebaseFirestore.DocumentReference; readonly doc: DeviceSessionRegistryDocument } | null {
  if (!lane.lineageTouched || lane.lineage === null) return null;
  return {
    ref: lane.db.collection(DEVICE_SESSION_REGISTRY_COLLECTION).doc(lane.device.device_id),
    doc: lane.lineage,
  };
}
