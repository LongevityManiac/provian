/**
 * GitLab webhook handler - pure module.
 *
 * The GitLab equivalent of github-webhook.ts. Receives a GitLab project (or
 * group) webhook delivery, verifies the `X-Gitlab-Token` secret, dedups,
 * synthesizes a structural description from the payload alone (no callback to
 * GitLab - Tier A custody, we hold no token), submits a PE via the standard
 * relay path, and triggers cross-witness corroboration via CorroborationManager.
 *
 * **Differences from GitHub** (the rest is identical by design):
 *   - Auth is a constant-time compare of the `X-Gitlab-Token` header against
 *     the configured secret. GitLab does NOT HMAC-sign the body, so there is
 *     no signature-over-rawBody step. We still verify BEFORE parsing.
 *   - Attribution keys on `project.id` (GitLab has no installation_id). The
 *     user links a project to their wallet via the gitlab/installs route; the
 *     service_installs row (provider='gitlab', installation_id=project.id)
 *     maps the inbound delivery to the owning Provian user.
 *   - Delivery dedup uses `X-Gitlab-Event-UUID`.
 *
 * Order of operations is security-critical and matches github-webhook.ts:
 *   1. Config gate (503).
 *   2. Token verify, constant-time, BEFORE parse (401).
 *   3. Parse.
 *   4. Required headers + project id.
 *   5. Install lookup (404 / 410).
 *   6. Dedup (200 idempotent).
 *   7. Synthesize-or-drop (200 no-op on insufficient payload).
 *   8. PE submission via generatePE.
 *   9. Cross-witness corroboration via emitBackendCorroboration.
 */

import { Timestamp } from 'firebase-admin/firestore';
import crypto from 'crypto';
import type { AgentBankDeps } from '../agent-bank/types';
import { generatePE } from '../agent-bank/pe-utils';
import type { InputOrigin } from '../provenance/input-origins';
import { resolvableOrigin, forgeWebhookWitness, mergeInputOrigins } from '../provenance/origin-capture';
import { emitBackendCorroboration } from '../corroboration/CorroborationManager';
import { getServiceInstallByInstallationId } from './service-installs';
import type { GitLabAppConfig } from './gitlab-app-config';
import { findPEsByCommitSha, findCommitOriginsBySha } from './pe-lookup';
import {
  attributionMetadata,
  extractGitLabAuthorKeyCandidates,
  resolveAgentAuthorAttribution,
} from '../agent-attribution/author-mappings';

const PROVIDER = 'gitlab' as const;
const DELIVERIES_COLLECTION = 'witness_webhook_deliveries';
const DELIVERY_DEDUP_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days, matches GitHub.

// GitLab event header (`X-Gitlab-Event`) → action type. Anything else is
// acknowledged 200 (so GitLab stops retrying) but produces no PE.
const EVENT_TYPE_TO_ACTION_TYPE: Record<string, string> = {
  'Push Hook': 'service:gitlab_push',
  'Merge Request Hook': 'service:gitlab_mr_merged',
};

export interface GitLabWebhookResult {
  status: 200 | 400 | 401 | 404 | 410 | 503;
  body: Record<string, unknown>;
}

export interface GitLabWebhookInput {
  /** Raw request body (UTF-8). Parsed only after token verification. */
  rawBody: string;
  /** Header value `X-Gitlab-Token` - the per-webhook secret token. */
  tokenHeader: string | undefined;
  /** Header value `X-Gitlab-Event` (e.g. "Push Hook", "Merge Request Hook"). */
  eventType: string | undefined;
  /** Header value `X-Gitlab-Event-UUID` - unique per delivery, used for dedup. */
  deliveryId: string | undefined;
  /** Loaded config. Pass-through so the handler is pure. */
  config: GitLabAppConfig;
}

// -----------------------------------------------------------------------------
// Token verification (constant-time)
// -----------------------------------------------------------------------------

/**
 * Constant-time compare of the inbound `X-Gitlab-Token` against the configured
 * secret. GitLab sends the secret verbatim (no HMAC), so this is a direct
 * comparison - length-checked first because timingSafeEqual throws on length
 * mismatch. Returns false for every failure mode; caller maps to 401.
 */
export function verifyGitLabToken(
  tokenHeader: string | undefined,
  webhookSecret: string,
): boolean {
  if (!tokenHeader || typeof tokenHeader !== 'string') return false;
  const provided = Buffer.from(tokenHeader, 'utf8');
  const expected = Buffer.from(webhookSecret, 'utf8');
  if (provided.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(provided, expected);
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Synthesizer
// -----------------------------------------------------------------------------

export interface SynthesizedEvent {
  actionType: string;
  description: string;
  commitSha: string;
  metadata: Record<string, unknown>;
  /** Prompt 2: resolvable origins (repo, parent commit) witnessed by the
   * HMAC-verified webhook (forge_webhook). Folded into the PE by generatePE. */
  input_origins?: InputOrigin[];
}

export function synthesizeFromGitLabPayload(
  eventType: string,
  payload: Record<string, unknown>,
): SynthesizedEvent | null {
  const actionType = EVENT_TYPE_TO_ACTION_TYPE[eventType];
  if (!actionType) return null;
  if (eventType === 'Push Hook') return synthesizePush(payload);
  if (eventType === 'Merge Request Hook') return synthesizeMergeRequestMerged(payload);
  return null;
}

function getProject(payload: Record<string, unknown>): { id: string; fullName: string } | null {
  const project = payload.project as Record<string, unknown> | undefined;
  if (!project) return null;
  const idRaw = project.id;
  const id =
    typeof idRaw === 'number' ? String(idRaw) : typeof idRaw === 'string' ? idRaw : null;
  const fullName =
    typeof project.path_with_namespace === 'string' ? project.path_with_namespace : null;
  if (!id || !fullName) return null;
  return { id, fullName };
}

function synthesizePush(payload: Record<string, unknown>): SynthesizedEvent | null {
  const after = typeof payload.after === 'string' ? payload.after : null;
  const ref = typeof payload.ref === 'string' ? payload.ref : null;
  const project = getProject(payload);
  const commits = Array.isArray(payload.commits) ? payload.commits : null;

  if (!after || !ref || !project || !commits) return null;
  // A branch delete pushes the zero-sha as `after`; GitLab also sends
  // total_commits_count 0. Drop it - nothing was authored.
  if (/^0+$/.test(after)) return null;

  let addedFiles = 0;
  let removedFiles = 0;
  let modifiedFiles = 0;
  for (const c of commits) {
    const cm = c as Record<string, unknown>;
    if (Array.isArray(cm.added)) addedFiles += cm.added.length;
    if (Array.isArray(cm.removed)) removedFiles += cm.removed.length;
    if (Array.isArray(cm.modified)) modifiedFiles += cm.modified.length;
  }
  const totalFilesChanged = addedFiles + removedFiles + modifiedFiles;
  if (totalFilesChanged === 0 && commits.length === 0) return null;

  const branch = ref.replace(/^refs\/heads\//, '');
  const shortSha = after.slice(0, 8);
  const description =
    `push ${shortSha} to ${project.fullName}/${branch}: ${commits.length} commit(s) across ${totalFilesChanged} files`;

  // Prompt 2 — repo + parent (`before`) commit as resolvable origins, forge_webhook witness.
  const before = typeof payload.before === 'string' ? payload.before : null;
  const glWitness = forgeWebhookWitness(`gitlab:${project.id}`);
  const input_origins = [resolvableOrigin(`repo:${project.fullName}`, glWitness)];
  if (before && /^[0-9a-f]{7,64}$/i.test(before) && !/^0+$/.test(before)) {
    input_origins.push(resolvableOrigin(`commit:${before.toLowerCase()}`, glWitness));
  }

  return {
    actionType: 'service:gitlab_push',
    description,
    commitSha: after,
    input_origins,
    metadata: {
      commit_sha: after,
      repo: project.fullName,
      project_id: project.id,
      branch,
      commits_in_push: commits.length,
      files_added: addedFiles,
      files_removed: removedFiles,
      files_modified: modifiedFiles,
      files_changed: totalFilesChanged,
      synthesized_description: description,
    },
  };
}

function synthesizeMergeRequestMerged(payload: Record<string, unknown>): SynthesizedEvent | null {
  const attrs = payload.object_attributes as Record<string, unknown> | undefined;
  if (!attrs) return null;
  // GitLab emits Merge Request Hook on every state change; only `merge` counts.
  if (attrs.action !== 'merge') return null;
  const mergeCommitSha =
    typeof attrs.merge_commit_sha === 'string' ? attrs.merge_commit_sha : null;
  const iid = typeof attrs.iid === 'number' ? attrs.iid : null;
  const targetBranch = typeof attrs.target_branch === 'string' ? attrs.target_branch : null;
  const project = getProject(payload);

  // GitLab's MR webhook does not carry additions/deletions/changed_files by
  // default, so they are not required (and recorded as null). The merge
  // commit sha, MR iid, target branch, and project are required for a real
  // structural description.
  if (!mergeCommitSha || iid == null || !targetBranch || !project) return null;

  const shortSha = mergeCommitSha.slice(0, 8);
  const description =
    `MR !${iid} merged ${shortSha} into ${project.fullName}/${targetBranch}`;

  return {
    actionType: 'service:gitlab_mr_merged',
    description,
    commitSha: mergeCommitSha,
    metadata: {
      commit_sha: mergeCommitSha,
      repo: project.fullName,
      project_id: project.id,
      branch: targetBranch,
      mr_iid: iid,
      synthesized_description: description,
    },
  };
}

// -----------------------------------------------------------------------------
// Delivery-level dedup
// -----------------------------------------------------------------------------

export async function checkAndMarkDelivery(
  deps: { db: AgentBankDeps['db'] },
  key: { userId: string; provider: 'gitlab'; deliveryId: string },
): Promise<boolean> {
  const docId = `${key.provider}_${key.userId}_${key.deliveryId}`;
  const ref = deps.db.collection(DELIVERIES_COLLECTION).doc(docId);
  return await deps.db.runTransaction(async (tx: any) => {
    const snap = await tx.get(ref);
    if (snap.exists) return true;
    const now = Date.now();
    tx.set(ref, {
      provider: key.provider,
      user_id: key.userId,
      delivery_id: key.deliveryId,
      processed_at: now,
      expires_at: now + DELIVERY_DEDUP_TTL_MS,
      // Firestore TTL deletes only on a Timestamp field: the numeric `expires_at` above never
      // expired (its policy matched a number). `expire_at` is what the TTL policy targets.
      expire_at: Timestamp.fromMillis(now + DELIVERY_DEDUP_TTL_MS),
    });
    return false;
  });
}

// -----------------------------------------------------------------------------
// The handler
// -----------------------------------------------------------------------------

export async function handleGitLabWebhook(
  deps: AgentBankDeps,
  input: GitLabWebhookInput,
): Promise<GitLabWebhookResult> {
  // (1) Config gate
  if (!input.config.enabled || !input.config.webhookSecret) {
    return { status: 503, body: { error: 'gitlab_webhook_not_configured' } };
  }

  // (2) Parse. B2 (, per-install secrets) inverted the old
  // verify-before-parse order OF NECESSITY: the secret a delivery must match
  // is the INSTALL's own, and the install key (project id) lives in the body.
  // The parse is a bounded JSON.parse (express's global body limit) with no
  // processing of attacker-controlled content beyond field reads; NOTHING
  // else happens before a secret verifies — see the ordering note at (4).
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(input.rawBody);
  } catch {
    return { status: 400, body: { error: 'invalid_json' } };
  }
  if (!payload || typeof payload !== 'object') {
    return { status: 400, body: { error: 'invalid_payload_shape' } };
  }

  // (3) Required headers + project id (GitLab's per-user install key).
  if (!input.eventType || !input.deliveryId) {
    return { status: 400, body: { error: 'missing_required_headers' } };
  }
  const project = getProject(payload);
  if (!project) {
    return { status: 400, body: { error: 'missing_project_id' } };
  }

  // (4) Install lookup, then VERIFY — the invariants, enumeration-safe:
  //  - an install WITH a per-install secret verifies against ITS OWN secret
  //    and never the app-wide one (a secret holder can forge deliveries only
  //    against their own install);
  //  - a LEGACY secret-less row (registered pre-B2) grandfathers onto the
  //    app-wide secret until re-registered — that secret was never
  //    distributed to a third party;
  //  - an UNREGISTERED project id answers 401 unless the caller presents the
  //    app-wide (operator) secret, so an unauthenticated probe cannot
  //    enumerate which projects are registered (the old order got this for
  //    free by verifying first; this preserves it);
  //  - revocation (410) is disclosed only AFTER a successful verify.
  const install = await getServiceInstallByInstallationId(deps.db, PROVIDER, project.id);
  if (!install) {
    if (!verifyGitLabToken(input.tokenHeader, input.config.webhookSecret)) {
      return { status: 401, body: { error: 'invalid_token' } };
    }
    return { status: 404, body: { error: 'install_not_found' } };
  }
  const perInstallSecret = typeof install.webhook_secret === 'string' && install.webhook_secret.length > 0
    ? install.webhook_secret
    : null;
  const verified = perInstallSecret !== null
    ? verifyGitLabToken(input.tokenHeader, perInstallSecret)
    : verifyGitLabToken(input.tokenHeader, input.config.webhookSecret);
  if (!verified) {
    return { status: 401, body: { error: 'invalid_token' } };
  }
  if (install.revoked_at !== null) {
    return { status: 410, body: { error: 'install_revoked' } };
  }

  // (6) Dedup BEFORE synthesize / submit.
  const alreadySeen = await checkAndMarkDelivery(deps, {
    userId: install.user_id,
    provider: PROVIDER,
    deliveryId: input.deliveryId,
  });
  if (alreadySeen) {
    return { status: 200, body: { idempotent: true } };
  }

  // (7) Synthesize or drop.
  const synthesized = synthesizeFromGitLabPayload(input.eventType, payload);
  if (!synthesized) {
    console.warn('[GitLabWebhook] dropped_unsynthesizable', {
      event_type: input.eventType,
      delivery_id: input.deliveryId,
      project_id: project.id,
    });
    return { status: 200, body: { dropped: true, reason: 'unsynthesizable_or_unsupported_event' } };
  }

  // (8) Submit the PE through the standard server-side path. attestation tier
  // is software (no device key on this path). service:* is external_proof_priced;
  // prices this software-tier witness at the family's 0.8x
  // software discount — 3.0x weight x 0.8x = 2.4x, eligible — priced down by novelty
  // decay, with chain-verified corroboration lifting to the flat 1.0x. Cross-witness
  // mint-once dedup still runs inside recordPEAccrual off metadata.commit_sha (see
  // commit-mint-claim.ts): if the local observer already recorded this commit,
  // this PE records as 'corroborated_duplicate'.
  const attribution = await resolveAgentAuthorAttribution(deps.db, {
    provider: PROVIDER,
    // For gitlab the self-serve installation_id IS the stable GitLab project
    // id (routes/witnesses-gitlab.ts) — it survives a wallet re-point, so it
    // is the forge-account scope directly (no stamp needed).
    forgeAccountId: install.installation_id,
    sourceOwnerWalletId: install.user_id,
    candidates: extractGitLabAuthorKeyCandidates(payload),
  });
  const targetWalletId = attribution?.agentWalletId ?? install.user_id;
  const targetAgentId = attribution?.agentId ?? targetWalletId;

  // Prompt 2 — order-independence (device-first): union any prior same-commit
  // device origins into this forge PE's canonical origins. Forge-first is unioned
  // at corroboration time (commit-takeover.ts). Best-effort, never blocks.
  let glUnionedOrigins = synthesized.input_origins;
  try {
    const prior = await findCommitOriginsBySha(deps.db, synthesized.commitSha);
    if (prior.length > 0) glUnionedOrigins = mergeInputOrigins(synthesized.input_origins, prior);
  } catch (err) {
    console.warn('[gitlab-webhook] prior-commit origin union failed (non-blocking):', err);
  }

  const { peId, peHash } = await generatePE(deps, {
    walletId: targetWalletId,
    agentId: targetAgentId,
    actorAddress: attribution?.agentAddress ?? '',
    actionType: synthesized.actionType,
    // Prompt 2: resolvable origins (repo, parent commit) the webhook witnessed,
    // unioned with any prior same-commit device origins (device-first order).
    input_origins: glUnionedOrigins,
    // A per-install secret authenticates this delivery, but its holder can name
    // an arbitrary repo or commit. It does not independently witness origins.
    // The GitHub App's app-wide secret and chain watchers provide that stronger
    // origin evidence. A valid named webhook event still prices at the family's
    // software discount (2.4x), with independent corroboration lifting to 3.0x.
    durableViaOrdinaryIntake: true,
    metadata: {
      ...synthesized.metadata,
      verified: true,
      delivery_id: input.deliveryId,
      installation_id: project.id,
      witness: 'gitlab_webhook',
      attribution: attributionMetadata(PROVIDER, install.user_id, attribution),
    },
  });

  // (9) Bidirectional cross-witness corroboration via CorroborationManager.
  // corroboratingParty is the system actor 'gitlab_app' (distinct from the
  // user's wallet id, so the self-corroboration guard does not reject it).
  if (synthesized.commitSha) {
    // findPEsByCommitSha reads provenance_envelopes (the only collection with
    // both metadata.commit_sha AND the canonical hash) and returns the hash +
    // chain owner; CorroborationManager validates against pe_history.peHash and
    // writes the status back there. (No second read needed.)
    const matches = await findPEsByCommitSha(deps.db, synthesized.commitSha);
    for (const match of matches) {
      if (match.envelopeId === peId) continue;
      if (!match.hash) continue;
      // F25 (S2 2026-09-10): scope corroboration to the owner this delivery
      // attributes the commit to. Compare in the AGENT-ID namespace: match.userId
      // is the target PE's stored user_id (= agent_id; generatePE sets user_id =
      // agentId, and the minted PE here uses agentId = targetAgentId), so the
      // attributed owner is targetAgentId (= attribution.agentId when mapped, else
      // install.user_id), NOT targetWalletId (the wallets doc id) — comparing the
      // wallet doc id would over-suppress every mapped agent's own corroboration
      // (Sec. Invariant #8). Forge + device witness must name the same owner, else
      // any installer could lift a foreign PE by re-pushing its commit SHA.
      if (match.userId !== targetAgentId) continue;
      await emitBackendCorroboration(deps, {
        targetPeId: match.envelopeId,
        targetPeHash: match.hash,
        signalType: 'gitlab_webhook_attestation',
        corroboratingParty: 'gitlab_app',
        evidence: `delivery=${input.deliveryId},commit=${synthesized.commitSha}`,
        evidenceRef: input.deliveryId,
        walletId: match.userId,
        agentId: match.agentId,
        actorAddress: '',
      });
    }
  }

  return { status: 200, body: { pe_id: peId, pe_hash: peHash } };
}
