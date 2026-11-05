/**
 * : the backfill's MONETARY gate.
 *
 * The backfill runs from an operator's shell, not from the relay. The accrual
 * it drives prices each receive PE with `loadRuntimeMonetaryPolicy`, which
 * validates the signed `pvt_policy_activations/monetary` document with the
 * approval verifier configured from `FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY` /
 * `FRANK_PVT_APPROVAL_SSH_KEY_SHA256` Cloud Run env, absent from a laptop
 * shell (the / trap). Without them the loader fails closed to the
 * INACTIVE record-only policy, so every recovered receive would seal
 * `record_only` (0 PVT) under a deterministic PE id and a completed claim:
 * permanent, with no repair path. The same holds for a template digest that
 * differs between this tree and the live document.
 *
 * So `--execute` refuses, before any claim or admission is written, unless:
 * - `NODE_ENV` is not `test` (the loader's test branch materializes an active
 * policy with no document at all — never what prod computes);
 * - the activation document resolves `quiet_active` under the SAME resolver
 * the relay's boot probe uses (`resolveMonetaryActivationStatus`), with the
 * approval env present and the template digest this tree computes EQUAL to
 * the one the live document pins;
 * - the activity-mapping pause is off (the live watcher honours it);
 * - and, per transfer, the policy the loader returns at that transfer's block
 * timestamp (the PE's record time) is the ACTIVE vintage with an eligible
 * `receive` row. A transfer that fails this is refused with no claim.
 *
 * The dry run reports the same preflight and, per row, the projected mint
 * disposition and record points from the ONE pricing truth
 * (`estimateFromRecordPath`), so the operator sees what `--execute` would seal.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { isActivityMappingEnabled } from './activity-mapping-config';
import { canonicalLogIdentity } from './institution-funding-watcher';
import type { InboundTransferLog, WatchedWallet } from './inbound-usdc-watcher';
import { resolveActionPolicyAtRecordTime } from './policy/action-policy-gate';
import {
  approvalVerifierConfigFromEnv,
  type SshApprovalVerifierConfig,
} from './policy/approval-signature';
import {
  readMonetaryActivationDocument,
  resolveMonetaryActivationStatus,
} from './policy/monetary-activation-status';
import type { LinkageState } from './policy/monetary-accounting';
import { estimateFromRecordPath } from './policy/record-path-estimate';
import { resolveReceiveAuthorship } from './policy/receive-authorship';
import { loadRuntimeMonetaryPolicy } from './policy/runtime-monetary-policy';

const BASE_CHAIN_ID = 8453;
// The policy row this gate READS. A named constant, not an inline `actionType: '...'` literal, because
// this module never emits a PE: the matrix generator's static-emitter scan must not list it.
const RECEIVE_ACTION_TYPE = 'receive';

export interface BackfillMonetaryPreflight {
  /** True only when `--execute` may write anything. */
  readonly admits_execute: boolean;
  /** The first refusal, named; null when admitted. */
  readonly refusal: string | null;
  readonly node_env: string | null;
  readonly approval_env_present: boolean;
  readonly activation_verdict: string;
  readonly digest_match: boolean;
  readonly computed_template_sha256: string;
  readonly pinned_template_sha256: string | null;
  /** The activation's pinned policy version; the active loader output must carry it. */
  readonly policy_version: string | null;
  readonly effective_at_ms: number | null;
  readonly activity_mapping_enabled: boolean;
}

export interface BackfillMonetaryProjection {
  /** The PE's record time: the transfer's block timestamp. */
  readonly recorded_at_ms: number;
  readonly policy_version: string;
  /** The loader returned the ACTIVE vintage with an eligible `receive` row. */
  readonly policy_active: boolean;
  readonly mint_disposition: string;
  readonly mint_reason_code: string;
  readonly record_points_atomic: string;
  /** an unsolicited receive seals record_only in prod too. Null when unresolvable. */
  readonly receive_authored: boolean | null;
  readonly linkage_state: LinkageState;
}

export interface BackfillMonetaryProjectionInput {
  readonly wallet: WatchedWallet;
  readonly log: InboundTransferLog;
  readonly recordedAtMs: number;
  /** From the preflight; null means no activation, so nothing can be active. */
  readonly pinnedPolicyVersion: string | null;
}

export interface BackfillMonetaryGate {
  preflight(): Promise<BackfillMonetaryPreflight>;
  project(input: BackfillMonetaryProjectionInput): Promise<BackfillMonetaryProjection>;
}

export interface ProductionBackfillMonetaryGateOptions {
  /** Defaults to `process.env`, read at call time. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Defaults to `approvalVerifierConfigFromEnv()`, read at call time. */
  readonly verifierConfig?: SshApprovalVerifierConfig | null;
  readonly now?: () => number;
}

/** True when the loader's output is the pinned ACTIVE vintage, never the inactive one. */
export function isActivePolicyVersion(loaded: string, pinned: string | null): boolean {
  if (pinned === null || pinned.length === 0) return false;
  return loaded === pinned || loaded.startsWith(`${pinned}+`);
}

async function linkageStateOf(db: Firestore, walletId: string): Promise<LinkageState> {
  try {
    const snap = await db.collection('agent_wallets').doc(walletId).get();
    if (!snap.exists) return 'unverifiable';
    const linked = (snap.data() as Record<string, unknown>).linked_human_user_id;
    return typeof linked === 'string' && linked.length > 0 ? 'beneficiary_linked' : 'unlinked';
  } catch {
    return 'unverifiable';
  }
}

export function productionBackfillMonetaryGate(
  db: Firestore,
  options: ProductionBackfillMonetaryGateOptions = {},
): BackfillMonetaryGate {
  const envOf = (): Readonly<Record<string, string | undefined>> => options.env ?? process.env;
  const now = options.now ?? Date.now;
  return {
    async preflight(): Promise<BackfillMonetaryPreflight> {
      const env = envOf();
      const nodeEnv = env.NODE_ENV ?? null;
      const verifierConfig = options.verifierConfig === undefined
        ? approvalVerifierConfigFromEnv()
        : options.verifierConfig;
      const approvalEnvPresent = typeof env.FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY === 'string'
        && env.FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY.trim() !== ''
        && typeof env.FRANK_PVT_APPROVAL_SSH_KEY_SHA256 === 'string'
        && env.FRANK_PVT_APPROVAL_SSH_KEY_SHA256.trim() !== ''
        && verifierConfig !== null;
      const document = await readMonetaryActivationDocument(db);
      const resolution = resolveMonetaryActivationStatus({
        document,
        approvalPublicKeyRaw: env.FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY,
        approvalKeySha256Raw: env.FRANK_PVT_APPROVAL_SSH_KEY_SHA256,
        nowMs: now(),
        verifierConfig,
      });
      const pinnedVersion = typeof document === 'object' && document !== null
        && typeof (document as Record<string, unknown>).policy_version === 'string'
        ? (document as Record<string, unknown>).policy_version as string
        : null;
      const mapping = await isActivityMappingEnabled(db);

      let refusal: string | null = null;
      if (nodeEnv === 'test') refusal = 'node_env_test_materializes_policy_without_activation';
      else if (!approvalEnvPresent) refusal = 'approval_verifier_env_absent';
      else if (!resolution.digest_match) refusal = 'monetary_template_digest_mismatch';
      else if (resolution.verdict !== 'quiet_active') refusal = `monetary_activation_${resolution.verdict}`;
      else if (pinnedVersion === null) refusal = 'monetary_activation_policy_version_absent';
      else if (!mapping) refusal = 'activity_mapping_disabled';

      return {
        admits_execute: refusal === null,
        refusal,
        node_env: nodeEnv,
        approval_env_present: approvalEnvPresent,
        activation_verdict: resolution.verdict,
        digest_match: resolution.digest_match,
        computed_template_sha256: resolution.computed_template_sha256,
        pinned_template_sha256: resolution.pinned_template_sha256,
        policy_version: pinnedVersion,
        effective_at_ms: resolution.effective_at_ms,
        activity_mapping_enabled: mapping,
      };
    },

    async project(input: BackfillMonetaryProjectionInput): Promise<BackfillMonetaryProjection> {
      const recordedAtMs = input.recordedAtMs;
      // The SAME two calls the accrual makes, at the PE's record time.
      const resolution = await resolveActionPolicyAtRecordTime(db, {
        actionType: RECEIVE_ACTION_TYPE,
        recordedAtMs,
        witnessClass: 'chain_witnessed',
      });
      const policy = await loadRuntimeMonetaryPolicy(db, recordedAtMs, resolution);
      const policyActive = isActivePolicyVersion(policy.policyVersion, input.pinnedPolicyVersion)
        && policy.actions.receive?.mintDisposition === 'eligible';

      const authorship = await resolveReceiveAuthorship(db, {
        economicActorId: input.wallet.agentId,
        walletAddress: input.wallet.address,
        counterpartyAddress: input.log.fromAddress.toLowerCase(),
      });
      const receiveAuthored = authorship.unresolvable ? null : authorship.authored;
      const linkageState = await linkageStateOf(db, input.wallet.walletId);
      const estimate = await estimateFromRecordPath(db, {
        actionType: RECEIVE_ACTION_TYPE,
        witnessClass: 'chain_witnessed',
        evidenceState: 'verified',
        chainVerifiedSettlement: true,
        counterpartyAddress: input.log.fromAddress.toLowerCase(),
        canonicalEventId: canonicalLogIdentity(BASE_CHAIN_ID, input.log.txHash, input.log.logIndex),
        durableSubmissionPath: true,
        receiveAuthored: receiveAuthored === true,
        linkageState,
        recordedAtMs,
      });
      return {
        recorded_at_ms: recordedAtMs,
        policy_version: policy.policyVersion,
        policy_active: policyActive,
        mint_disposition: estimate.mint_disposition,
        mint_reason_code: estimate.mint_reason_code,
        record_points_atomic: estimate.record_points_atomic,
        receive_authored: receiveAuthored,
        linkage_state: linkageState,
      };
    },
  };
}
