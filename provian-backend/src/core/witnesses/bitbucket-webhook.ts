/**
 * Bitbucket webhook handler - pure module.
 *
 * The Bitbucket equivalent of github-webhook.ts / gitlab-webhook.ts. Receives
 * a Bitbucket webhook delivery, verifies the `X-Hub-Signature` HMAC over the
 * raw body, dedups, synthesizes a structural description from the payload
 * alone (no callback to Bitbucket - Tier A custody, we hold no token), submits
 * a PE via the standard relay path, and triggers cross-witness corroboration
 * via CorroborationManager.
 *
 * **Auth model:** Bitbucket signs each delivery with HMAC-SHA256 over the raw
 * body keyed by the per-webhook secret, sent as `X-Hub-Signature: sha256=<hex>`
 * (same scheme as GitHub, different header name). So verification is identical
 * to github-webhook.ts `verifyGitHubSignature` - an HMAC compare over rawBody,
 * BEFORE the body is parsed. (GitLab differs: verbatim-token compare, no HMAC.)
 *
 * **Attribution:** Bitbucket has no installation_id. Like GitLab keys on
 * project.id, this keys on the repository UUID (rename-stable). The user links
 * a repo to their wallet via the bitbucket/installs route; the service_installs
 * row (provider='bitbucket', installation_id=<normalized repo uuid>) maps the
 * inbound delivery to the owning Provian user. Delivery dedup uses
 * `X-Request-UUID`.
 *
 * **Scope:** Bitbucket **Cloud** event shapes (`repo:push`,
 * `pullrequest:fulfilled`). Data Center keys (`repo:refs_changed`, `pr:merged`)
 * have a different payload and are a tracked follow-up; unrecognized shapes are
 * acknowledged 200 (so Bitbucket stops retrying) but produce no PE.
 *
 * Order of operations is security-critical and matches the GitHub/GitLab
 * handlers:
 *   1. Config gate (503).
 *   2. Signature verify over rawBody, constant-time, BEFORE parse (401).
 *   3. Parse.
 *   4. Required headers + repository.
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
import type { BitbucketAppConfig } from './bitbucket-app-config';
import { findPEsByCommitSha, findCommitOriginsBySha } from './pe-lookup';
import {
  attributionMetadata,
  extractBitbucketAuthorKeyCandidates,
  resolveAgentAuthorAttribution,
} from '../agent-attribution/author-mappings';

const PROVIDER = 'bitbucket' as const;
const DELIVERIES_COLLECTION = 'witness_webhook_deliveries';
const DELIVERY_DEDUP_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days, matches GitHub/GitLab.

// Bitbucket Cloud event key (`X-Event-Key`) → action type. Anything else is
// acknowledged 200 (so Bitbucket stops retrying) but produces no PE.
const EVENT_KEY_TO_ACTION_TYPE: Record<string, string> = {
  'repo:push': 'service:bitbucket_push',
  'pullrequest:fulfilled': 'service:bitbucket_pr_merged',
};

export interface BitbucketWebhookResult {
  status: 200 | 400 | 401 | 404 | 410 | 503;
  body: Record<string, unknown>;
}

export interface BitbucketWebhookInput {
  /** Raw request body (UTF-8). Signed bytes - parsed only after signature verification. */
  rawBody: string;
  /** Header value `X-Hub-Signature` - `sha256=<hex>` HMAC over rawBody. */
  signatureHeader: string | undefined;
  /** Header value `X-Event-Key` (e.g. "repo:push", "pullrequest:fulfilled"). */
  eventKey: string | undefined;
  /** Header value `X-Request-UUID` - unique per delivery, used for dedup. */
  deliveryId: string | undefined;
  /** Loaded config. Pass-through so the handler is pure. */
  config: BitbucketAppConfig;
}

// -----------------------------------------------------------------------------
// Signature verification (constant-time HMAC over rawBody)
// -----------------------------------------------------------------------------

/**
 * Verify Bitbucket's `X-Hub-Signature` header against the raw body using the
 * app-wide webhook secret. Constant-time compare via `crypto.timingSafeEqual`
 * after length-matching. Identical scheme to github-webhook.ts
 * `verifyGitHubSignature`; the only difference is the header name at the call
 * site. Returns false (NOT throws) for every failure mode; caller maps to 401.
 */
export function verifyBitbucketSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  webhookSecret: string,
): boolean {
  if (!signatureHeader || typeof signatureHeader !== 'string') return false;
  if (!signatureHeader.startsWith('sha256=')) return false;

  const provided = signatureHeader.slice('sha256='.length);
  if (!/^[0-9a-fA-F]+$/.test(provided)) return false;

  const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');

  // Length-check before timingSafeEqual (it throws on length mismatch); both
  // halves of the conditional return false uniformly.
  if (provided.length !== expected.length) return false;

  try {
    return crypto.timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Repository / UUID helpers
// -----------------------------------------------------------------------------

/**
 * Normalize a Bitbucket repository UUID for use as the install key: strip the
 * surrounding braces Bitbucket wraps it in (`{...}`) and lowercase it. Applied
 * consistently at both the install-registration site (route) and the inbound
 * delivery site (here) so the Firestore doc id matches.
 */
export function normalizeRepoUuid(raw: string): string {
  return raw.replace(/^\{/, '').replace(/\}$/, '').toLowerCase();
}

function getRepository(
  payload: Record<string, unknown>,
): { uuid: string; fullName: string } | null {
  const repo = payload.repository as Record<string, unknown> | undefined;
  if (!repo) return null;
  const uuidRaw = typeof repo.uuid === 'string' ? repo.uuid : null;
  const fullName = typeof repo.full_name === 'string' ? repo.full_name : null;
  if (!uuidRaw || !fullName) return null;
  return { uuid: normalizeRepoUuid(uuidRaw), fullName };
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
   * HMAC-verified webhook (forge_webhook). */
  input_origins?: InputOrigin[];
}

export function synthesizeFromBitbucketPayload(
  eventKey: string,
  payload: Record<string, unknown>,
): SynthesizedEvent | null {
  const actionType = EVENT_KEY_TO_ACTION_TYPE[eventKey];
  if (!actionType) return null;
  if (eventKey === 'repo:push') return synthesizePush(payload);
  if (eventKey === 'pullrequest:fulfilled') return synthesizePrMerged(payload);
  return null;
}

function synthesizePush(payload: Record<string, unknown>): SynthesizedEvent | null {
  const repo = getRepository(payload);
  const push = payload.push as Record<string, unknown> | undefined;
  const changes = push && Array.isArray(push.changes) ? push.changes : null;
  if (!repo || !changes) return null;

  // A push delivery can carry multiple branch changes. Use the first branch
  // change with a non-null `new` target as the representative head commit, and
  // count commits across all branch changes. Branch/tag deletions have
  // `closed: true` / `new: null` and are skipped (nothing was authored).
  let headSha: string | null = null;
  let branch: string | null = null;
  let parentSha: string | null = null;
  let totalCommits = 0;
  for (const ch of changes) {
    const c = ch as Record<string, unknown>;
    if (c.closed === true) continue;
    const next = c.new as Record<string, unknown> | undefined;
    if (!next || next.type !== 'branch') continue;
    const target = next.target as Record<string, unknown> | undefined;
    const hash = target && typeof target.hash === 'string' ? target.hash : null;
    const name = typeof next.name === 'string' ? next.name : null;
    if (!hash || !name) continue;
    if (/^0+$/.test(hash)) continue;
    if (headSha === null) {
      headSha = hash;
      branch = name;
      // The branch change's `old` target is the PARENT commit (an origin).
      const old = c.old as Record<string, unknown> | undefined;
      const oldTarget = old && old.target as Record<string, unknown> | undefined;
      parentSha = oldTarget && typeof oldTarget.hash === 'string' ? oldTarget.hash : null;
    }
    if (Array.isArray(c.commits)) totalCommits += c.commits.length;
  }
  if (!headSha || !branch) return null;

  const shortSha = headSha.slice(0, 8);
  const description =
    `push ${shortSha} to ${repo.fullName}/${branch}: ${totalCommits} commit(s)`;

  // Prompt 2 — repo + parent commit as resolvable origins, forge_webhook witness.
  const bbWitness = forgeWebhookWitness(`bitbucket:${repo.uuid ?? repo.fullName}`);
  const input_origins = [resolvableOrigin(`repo:${repo.fullName}`, bbWitness)];
  if (parentSha && /^[0-9a-f]{7,64}$/i.test(parentSha) && !/^0+$/.test(parentSha)) {
    input_origins.push(resolvableOrigin(`commit:${parentSha.toLowerCase()}`, bbWitness));
  }

  return {
    actionType: 'service:bitbucket_push',
    description,
    commitSha: headSha,
    input_origins,
    metadata: {
      commit_sha: headSha,
      repo: repo.fullName,
      repo_uuid: repo.uuid,
      branch,
      commits_in_push: totalCommits,
      // Bitbucket's push payload does not enumerate per-file changes; null by design.
      files_changed: null,
      synthesized_description: description,
    },
  };
}

function synthesizePrMerged(payload: Record<string, unknown>): SynthesizedEvent | null {
  const repo = getRepository(payload);
  const pr = payload.pullrequest as Record<string, unknown> | undefined;
  if (!repo || !pr) return null;
  // pullrequest:fulfilled fires only on merge, but double-check the state so a
  // mis-routed delivery can't synthesize a merge that didn't happen.
  if (typeof pr.state === 'string' && pr.state !== 'MERGED') return null;

  const mergeCommit = pr.merge_commit as Record<string, unknown> | undefined;
  const mergeSha =
    mergeCommit && typeof mergeCommit.hash === 'string' ? mergeCommit.hash : null;
  const id = typeof pr.id === 'number' ? pr.id : null;
  const dest = pr.destination as Record<string, unknown> | undefined;
  const destBranch = dest && (dest.branch as Record<string, unknown> | undefined);
  const targetBranch =
    destBranch && typeof destBranch.name === 'string' ? destBranch.name : null;

  if (!mergeSha || id == null || !targetBranch) return null;

  const shortSha = mergeSha.slice(0, 8);
  const description =
    `PR #${id} merged ${shortSha} into ${repo.fullName}/${targetBranch}`;

  return {
    actionType: 'service:bitbucket_pr_merged',
    description,
    commitSha: mergeSha,
    metadata: {
      commit_sha: mergeSha,
      repo: repo.fullName,
      repo_uuid: repo.uuid,
      branch: targetBranch,
      pr_id: id,
      synthesized_description: description,
    },
  };
}

// -----------------------------------------------------------------------------
// Delivery-level dedup
// -----------------------------------------------------------------------------

export async function checkAndMarkDelivery(
  deps: { db: AgentBankDeps['db'] },
  key: { userId: string; provider: 'bitbucket'; deliveryId: string },
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

export async function handleBitbucketWebhook(
  deps: AgentBankDeps,
  input: BitbucketWebhookInput,
): Promise<BitbucketWebhookResult> {
  // (1) Config gate
  if (!input.config.enabled || !input.config.webhookSecret) {
    return { status: 503, body: { error: 'bitbucket_webhook_not_configured' } };
  }

  // (2) Parse. B2 (, per-install secrets) inverted the old
  // verify-before-parse order OF NECESSITY: the HMAC key a delivery must
  // match is the INSTALL's own, and the install key (repo uuid) lives in the
  // body. Bounded JSON.parse (express's global body limit), field reads
  // only; nothing else happens before a signature verifies — see (4).
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(input.rawBody);
  } catch {
    return { status: 400, body: { error: 'invalid_json' } };
  }
  if (!payload || typeof payload !== 'object') {
    return { status: 400, body: { error: 'invalid_payload_shape' } };
  }

  // (3) Required headers + repository (Bitbucket's per-user install key).
  if (!input.eventKey || !input.deliveryId) {
    return { status: 400, body: { error: 'missing_required_headers' } };
  }
  const repo = getRepository(payload);
  if (!repo) {
    return { status: 400, body: { error: 'missing_repository' } };
  }

  // (4) Install lookup, then VERIFY — the invariants, enumeration-safe
  // (mirrors gitlab-webhook.ts): per-install secret verifies ONLY its own
  // install; legacy secret-less rows grandfather onto the app-wide secret;
  // an unregistered repo uuid answers 401 unless the app-wide (operator)
  // secret signed the delivery, so probes cannot enumerate registrations;
  // revocation (410) is disclosed only after a successful verify.
  const install = await getServiceInstallByInstallationId(deps.db, PROVIDER, repo.uuid);
  if (!install) {
    if (!verifyBitbucketSignature(input.rawBody, input.signatureHeader, input.config.webhookSecret)) {
      return { status: 401, body: { error: 'invalid_signature' } };
    }
    return { status: 404, body: { error: 'install_not_found' } };
  }
  const perInstallSecret = typeof install.webhook_secret === 'string' && install.webhook_secret.length > 0
    ? install.webhook_secret
    : null;
  const verified = perInstallSecret !== null
    ? verifyBitbucketSignature(input.rawBody, input.signatureHeader, perInstallSecret)
    : verifyBitbucketSignature(input.rawBody, input.signatureHeader, input.config.webhookSecret);
  if (!verified) {
    return { status: 401, body: { error: 'invalid_signature' } };
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
  const synthesized = synthesizeFromBitbucketPayload(input.eventKey, payload);
  if (!synthesized) {
    console.warn('[BitbucketWebhook] dropped_unsynthesizable', {
      event_key: input.eventKey,
      delivery_id: input.deliveryId,
      repo_uuid: repo.uuid,
    });
    return { status: 200, body: { dropped: true, reason: 'unsynthesizable_or_unsupported_event' } };
  }

  // (8) Submit the PE through the standard server-side path. Attestation tier
  // is software (no device key on this path). service:* is external_proof_priced;
  // prices this software-tier witness at the family's 0.8x
  // software discount — 3.0x weight x 0.8x = 2.4x, eligible — priced down by novelty
  // decay, with chain-verified corroboration lifting to the flat 1.0x. Cross-witness
  // mint-once dedup still runs inside recordPEAccrual off metadata.commit_sha (see
  // commit-mint-claim.ts): if the local observer already recorded this commit,
  // this PE records as 'corroborated_duplicate'.
  const attribution = await resolveAgentAuthorAttribution(deps.db, {
    provider: PROVIDER,
    // For bitbucket the self-serve installation_id IS the stable repo uuid
    // (routes/witnesses-bitbucket.ts) — it survives a wallet re-point, so it
    // is the forge-account scope directly (no stamp needed).
    forgeAccountId: install.installation_id,
    sourceOwnerWalletId: install.user_id,
    candidates: extractBitbucketAuthorKeyCandidates(payload),
  });
  const targetWalletId = attribution?.agentWalletId ?? install.user_id;
  const targetAgentId = attribution?.agentId ?? targetWalletId;

  // Prompt 2 — order-independence (device-first): union any prior same-commit
  // device origins into this forge PE's canonical origins. Forge-first is unioned
  // at corroboration time (commit-takeover.ts). Best-effort, never blocks.
  let bbUnionedOrigins = synthesized.input_origins;
  try {
    const prior = await findCommitOriginsBySha(deps.db, synthesized.commitSha);
    if (prior.length > 0) bbUnionedOrigins = mergeInputOrigins(synthesized.input_origins, prior);
  } catch (err) {
    console.warn('[bitbucket-webhook] prior-commit origin union failed (non-blocking):', err);
  }

  const { peId, peHash } = await generatePE(deps, {
    walletId: targetWalletId,
    agentId: targetAgentId,
    actorAddress: attribution?.agentAddress ?? '',
    actionType: synthesized.actionType,
    // Prompt 2: resolvable origins (repo, parent commit) the webhook witnessed,
    // unioned with any prior same-commit device origins (device-first order).
    input_origins: bbUnionedOrigins,
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
      installation_id: repo.uuid,
      witness: 'bitbucket_webhook',
      attribution: attributionMetadata(PROVIDER, install.user_id, attribution),
    },
  });

  // (9) Bidirectional cross-witness corroboration via CorroborationManager.
  // corroboratingParty is the system actor 'bitbucket_app' (distinct from the
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
        signalType: 'bitbucket_webhook_attestation',
        corroboratingParty: 'bitbucket_app',
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
