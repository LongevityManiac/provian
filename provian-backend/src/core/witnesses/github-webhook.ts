/**
 * GitHub App webhook handler - pure module.
 *
 * Step 4b of the GitHub App connector. Receives a GitHub-signed webhook
 * delivery, verifies it, dedups, synthesizes a structural description
 * from the payload alone, submits a PE via the standard relay
 * submission helper, and triggers cross-witness corroboration through
 * the single live corroboration path (CorroborationManager).
 *
 * **Order of operations is security-critical** (see handleGitHubWebhook
 * below). In particular:
 *
 *   1. Config gate (503 if not configured).
 *   2. Signature verify against rawBody using constant-time compare,
 *      BEFORE the body is parsed (401 on failure).
 *   3. Parse only after signature passes.
 *      Provian's own repository PR gate then reconciles its checks through a
 *      repository-scoped App token. That path does not record or price work.
 *   4. Install lookup (404 / 410).
 *   5. Dedup (200 idempotent on repeat).
 *   6. Synthesize-or-drop description (200 no-op on insufficient
 *      payload - never a placeholder PE).
 *   7. PE submission via generatePE (same path as every other
 *      server-side PE; no validation bypass).
 *   8. Bidirectional corroboration via emitBackendCorroboration.
 *
 * The express wrapper that mounts this lives in
 * routes/witnesses-github.ts and is the thinnest possible dispatch.
 */

import { Timestamp } from 'firebase-admin/firestore';
import crypto from 'crypto';
import { bumpOpsCounter } from '../observability/ops-counters';
import type { AgentBankDeps } from '../agent-bank/types';
import { generatePE, type GeneratePEParams } from '../agent-bank/pe-utils';
import type { InputOrigin } from '../provenance/input-origins';
import { resolvableOrigin, urlOrigins, forgeWebhookWitness, mergeInputOrigins } from '../provenance/origin-capture';
import { relayObservationWitness, RELAY_WITNESS_FORGE_WEBHOOK } from '../pvt/relay-observation-witness';
import { emitBackendCorroboration } from '../corroboration/CorroborationManager';
import {
  getServiceInstallByInstallationId,
  stampServiceInstallForgeAccount,
} from './service-installs';
import type { GitHubAppConfig } from './github-app-config';
import { GitHubPrApi, isPrGateRepository, objectOf, PR_GATE_REPOSITORIES } from './github-pr-api';
import { revokeGitHubIdentity } from './github-identity-link';
import { approvePrMerge, mergeApprovedPr, syncPrGate } from './github-pr-gate';
import { findPEsByCommitSha, findCommitOriginsBySha } from './pe-lookup';
import {
  attributionMetadata,
  createOwnerCaptureMapping,
  extractGitHubAuthorKeyCandidates,
  extractGitHubSenderKeyCandidates,
  normalizeAuthorKey,
  resolveAgentAuthorAttribution,
} from '../agent-attribution/author-mappings';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const PROVIDER = 'github' as const;
const prGateApi = new GitHubPrApi();
const DELIVERIES_COLLECTION = 'witness_webhook_deliveries';
const DELIVERY_DEDUP_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days - GitHub retries inside a few hours; this is generous.

// Supported event-type → action-type mapping. Anything outside this map
// is acknowledged 200 (so GitHub stops retrying) but does NOT produce a
// PE - the connector is intentionally narrow at launch.
const EVENT_TYPE_TO_ACTION_TYPE: Record<string, string> = {
  push: 'service:github_commit',
  pull_request: 'service:github_pr_merged',
};

// -----------------------------------------------------------------------------
// Result type
// -----------------------------------------------------------------------------

/**
 * Handler result. The HTTP status and a small JSON body. The body never
 * contains payload echo - it's bounded to internal status fields so
 * an attacker cannot use a 200 to confirm payload contents.
 */
export interface GitHubWebhookResult {
  status: 200 | 400 | 401 | 404 | 410 | 503;
  body: Record<string, unknown>;
}

/**
 * Handler input. The express wrapper assembles this from the request.
 * Decoupled so the handler is unit-testable without an express request.
 */
export interface GitHubWebhookInput {
  /** The raw request body, exactly as bytes-encoded UTF-8 - used for HMAC. */
  rawBody: string;
  /** Header value `X-Hub-Signature-256` (lowercase or original case). */
  signatureHeader: string | undefined;
  /** Header value `X-GitHub-Event`. */
  eventType: string | undefined;
  /** Header value `X-GitHub-Delivery` - the per-delivery unique ID GitHub assigns. */
  deliveryId: string | undefined;
  /** Loaded config. Pass-through so the handler is pure (no env reads). */
  config: GitHubAppConfig;
  /** Internal durable worker context, never read from an HTTP payload. */
  durable?: {
    receivedAt: number;
    preparedPE?: GeneratePEParams;
    preparePE: (params: GeneratePEParams) => Promise<GeneratePEParams>;
  };
}

// -----------------------------------------------------------------------------
// Signature verification (constant-time)
// -----------------------------------------------------------------------------

/**
 * Verify GitHub's X-Hub-Signature-256 header against the raw body using
 * the app-wide webhook secret. Constant-time compare via
 * `crypto.timingSafeEqual` after length-matching.
 *
 * Returns false (NOT throws) for every failure mode: missing header,
 * malformed header, wrong length, wrong digest. Caller maps to 401.
 */
export function verifyGitHubSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  webhookSecret: string,
): boolean {
  if (!signatureHeader || typeof signatureHeader !== 'string') return false;
  if (!signatureHeader.startsWith('sha256=')) return false;

  const provided = signatureHeader.slice('sha256='.length);
  // hex digits only - anything else means malformed
  if (!/^[0-9a-fA-F]+$/.test(provided)) return false;

  const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');

  // Length-check before timingSafeEqual (timingSafeEqual throws on
  // length mismatch, so the length check is itself a side-channel-safe
  // early-out - both halves of the conditional return false uniformly).
  if (provided.length !== expected.length) return false;

  try {
    return crypto.timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Synthesizer
// -----------------------------------------------------------------------------

/**
 * Result of attempting to synthesize a structural description + metadata
 * from a webhook payload. When `null`, the payload was missing fields
 * needed to produce a real description - the caller drops the event
 * rather than submitting a placeholder PE.
 */
export interface SynthesizedEvent {
  actionType: string;
  description: string;
  /** The commit this event is about, or null for a generic (non-commit) forge event. */
  commitSha: string | null;
  metadata: Record<string, unknown>;
  /**
   * (generic forge events): the event's own identity — mint-once anchor for a
   * non-commit event (`github:<repo>:<event>:<object>:<action>`). Null on commit events (their
   * anchor is the commit sha).
   */
  canonicalEventId?: string | null;
  /**
   * Prompt 2: the external artifacts this commit/merge consumed — the public
   * repo, the PARENT (`before`) commit, and the commit's URL domain — as
   * resolvable `input_origins`, witnessed by the HMAC-verified webhook
   * (forge_webhook). Folded into the PE's canonical doc by `generatePE`. When
   * this push is the mint-winner over a device `coding_session` for the same
   * commit, the backend takeover unions the device's rich origins onto the
   * winning record (`commit-takeover`), so neither witness's origins are stranded.
   */
  input_origins?: InputOrigin[];
  /**
   * Fact-base fixes item 4 (2026-09-23): the subset of `input_origins` the relay DERIVED from the
   * HMAC-verified event itself — the repository and the parent commit. The head commit URL's domain
   * is the forge's own host (the witness, not a consumed party) and is NOT here; neither is anything
   * unioned in from a device. Only these are witnessed at pricing.
   */
  relay_derived_origins?: InputOrigin[];
}

/**
 * Synthesize a deterministic structural description + metadata from a
 * GitHub webhook payload. Pure: same payload → same output, no network,
 * no LLM, no clock-dependence.
 *
 * Returns null when the payload is missing fields needed to produce a
 * real description. Caller drops the event in that case - substituting
 * a generic fallback string would hit the relay's blocklist or get
 * down-weighted by novelty decay (per UNIVERSAL_PE_SUBMISSION_SPEC §7.6
 * synthesize-or-omit).
 */
export function synthesizeFromGitHubPayload(
  eventType: string,
  payload: Record<string, unknown>,
): SynthesizedEvent | null {
  const actionType = EVENT_TYPE_TO_ACTION_TYPE[eventType];
  if (actionType) {
    // A COMMIT-family event (push / pull_request) is synthesized only from its commit; a
    // commit-less push (a ref create/delete) or an unmerged PR event is DROPPED, never re-labelled
    // as a generic act (Unknown = Block: the family's evidence is the commit).
    if (eventType === 'push') return synthesizePush(payload);
    if (eventType === 'pull_request') return synthesizePullRequestMerged(payload);
    return null;
  }
  // Every other HMAC-verified forge event is a GENERIC forge-witnessed act
  // (`service:github_<event>`) — a never-seen one records record_only and queues for a signed
  // policy row; nothing here is a catalog of event names. The App's own plumbing is not an act.
  return synthesizeGenericGitHubEvent(eventType, payload);
}

/**
 * The App's own plumbing: its lifecycle notifications and its check machinery (GitHub sends
 * `check_suite` / `check_run` to any App holding the checks permission, on every push, so the App
 * can run its own checks). None of these is anyone's work and none names a type: the receiver
 * acknowledges each with no act, no PE and no pending-policy queue row.
 */
export const GITHUB_APP_PLUMBING_EVENTS: ReadonlySet<string> = new Set([
  'ping', 'installation', 'installation_repositories', 'check_suite', 'check_run',
]);

const GITHUB_EVENT_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
/** Top-level payload objects whose GitHub `node_id`/`id` identifies the event's subject. */
const GITHUB_SUBJECT_KEYS = [
  'issue', 'pull_request', 'release', 'discussion', 'comment', 'review',
  'workflow_run', 'workflow_job', 'deployment', 'deployment_status', 'package', 'milestone', 'label',
  'project', 'projects_v2_item', 'alert', 'commit', 'ref',
] as const;

/**
 * A generic GitHub event → `service:github_<event>` with STRUCTURE-ONLY metadata (event name,
 * action, repo, sender login, the subject's opaque GitHub id). Never a title, body, comment,
 * diff, or any free text (privacy invariant). Null when the payload names no repository or no
 * sender (nothing to attribute), or the event name is not a plain identifier.
 */
export function synthesizeGenericGitHubEvent(
  eventType: string,
  payload: Record<string, unknown>,
): SynthesizedEvent | null {
  if (!GITHUB_EVENT_NAME_RE.test(eventType) || GITHUB_APP_PLUMBING_EVENTS.has(eventType)) return null;
  const repository = payload.repository as Record<string, unknown> | undefined;
  const fullName = repository && typeof repository.full_name === 'string' ? repository.full_name : null;
  const sender = payload.sender as Record<string, unknown> | undefined;
  const senderLogin = sender && typeof sender.login === 'string' ? sender.login : null;
  if (!fullName || !senderLogin) return null;
  const action = typeof payload.action === 'string' && /^[a-z_]{1,32}$/.test(payload.action) ? payload.action : null;
  let subject: string | null = null;
  for (const key of GITHUB_SUBJECT_KEYS) {
    const v = payload[key];
    // A ref NAME is user-authored text (a private branch name is a private identifier): the
    // subject carries its sha256, never the name (§3 metadata-only invariant).
    if (typeof v === 'string' && key === 'ref') { subject = `ref_sha256:${crypto.createHash('sha256').update(v).digest('hex')}`; break; }
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const id = typeof o.node_id === 'string' ? o.node_id : (typeof o.id === 'number' || typeof o.id === 'string' ? String(o.id) : null);
      if (id) { subject = `${key}:${id}`; break; }
    }
  }
  const actionType = `service:github_${eventType}`;
  const description = `${eventType}${action ? ` ${action}` : ''} on ${fullName}`;
  const forgeWitness = forgeWebhookWitness('github_app');
  const canonicalEventId = `github:${fullName}:${eventType}:${subject ?? 'event'}${action ? `:${action}` : ''}`;
  return {
    actionType,
    description,
    commitSha: null,
    canonicalEventId,
    input_origins: [resolvableOrigin(`repo:${fullName}`, forgeWitness)],
    relay_derived_origins: [resolvableOrigin(`repo:${fullName}`, forgeWitness)],
    metadata: {
      event_type: eventType,
      action,
      repo: fullName,
      sender_login: senderLogin,
      subject,
      synthesized_description: description,
    },
  };
}

function synthesizePush(payload: Record<string, unknown>): SynthesizedEvent | null {
  const after = typeof payload.after === 'string' ? payload.after : null;
  const ref = typeof payload.ref === 'string' ? payload.ref : null;
  const repository = payload.repository as Record<string, unknown> | undefined;
  const fullName = repository && typeof repository.full_name === 'string' ? repository.full_name : null;
  const headCommit = payload.head_commit as Record<string, unknown> | undefined;
  const commits = Array.isArray(payload.commits) ? payload.commits : null;

  if (!after || !ref || !fullName || !headCommit || !commits) return null;

  // Aggregate file/line counts across the commits in the push. GitHub
  // includes per-commit added/removed/modified arrays.
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
  const shortSha = after.slice(0, 7);
  const description =
    `push ${shortSha} to ${fullName}/${branch}: ${commits.length} commit(s) across ${totalFilesChanged} files`;

  // Prompt 2 — origins this push consumed: the repo, the PARENT (`before`)
  // commit (dropped until now, even though the payload always carries it), and
  // the head commit's URL domain. All PUBLIC, resolvable facts; the HMAC-verified
  // webhook is the voucher → forge_webhook witness.
  const before = typeof payload.before === 'string' ? payload.before : null;
  const headUrl = typeof headCommit.url === 'string' ? headCommit.url : null;
  const forgeWitness = forgeWebhookWitness('github_app');
  const relay_derived_origins = [resolvableOrigin(`repo:${fullName}`, forgeWitness)];
  // `before` is all-zeros for a brand-new branch (no parent) — exclude that.
  if (before && /^[0-9a-f]{7,64}$/i.test(before) && !/^0+$/.test(before)) {
    relay_derived_origins.push(resolvableOrigin(`commit:${before.toLowerCase()}`, forgeWitness));
  }
  const input_origins = [...relay_derived_origins];
  if (headUrl) input_origins.push(...urlOrigins(headUrl, forgeWitness));

  return {
    actionType: 'service:github_commit',
    description,
    commitSha: after,
    input_origins,
    relay_derived_origins,
    metadata: {
      commit_sha: after,
      repo: fullName,
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

function synthesizePullRequestMerged(payload: Record<string, unknown>): SynthesizedEvent | null {
  if (payload.action !== 'closed') return null;
  const pr = payload.pull_request as Record<string, unknown> | undefined;
  if (!pr || pr.merged !== true) return null;
  const mergeCommitSha = typeof pr.merge_commit_sha === 'string' ? pr.merge_commit_sha : null;
  const number = typeof pr.number === 'number' ? pr.number : null;
  const additions = typeof pr.additions === 'number' ? pr.additions : null;
  const deletions = typeof pr.deletions === 'number' ? pr.deletions : null;
  const changedFiles = typeof pr.changed_files === 'number' ? pr.changed_files : null;
  const repository = payload.repository as Record<string, unknown> | undefined;
  const fullName = repository && typeof repository.full_name === 'string' ? repository.full_name : null;
  const base = pr.base as Record<string, unknown> | undefined;
  const baseRef = base && typeof base.ref === 'string' ? base.ref : null;

  if (
    !mergeCommitSha ||
    number == null ||
    additions == null ||
    deletions == null ||
    changedFiles == null ||
    !fullName ||
    !baseRef
  ) {
    return null;
  }

  const shortSha = mergeCommitSha.slice(0, 7);
  const description =
    `PR #${number} merged ${shortSha} into ${fullName}/${baseRef}: ${additions}+/${deletions}- across ${changedFiles} files`;

  return {
    actionType: 'service:github_pr_merged',
    description,
    commitSha: mergeCommitSha,
    metadata: {
      commit_sha: mergeCommitSha,
      repo: fullName,
      branch: baseRef,
      pr_number: number,
      additions,
      deletions,
      files_changed: changedFiles,
      synthesized_description: description,
    },
  };
}

// -----------------------------------------------------------------------------
// Delivery-level dedup
// -----------------------------------------------------------------------------

/**
 * Atomic check-and-mark for delivery-level dedup. Returns true if the
 * delivery had already been recorded (caller treats as idempotent 200
 * no-op); returns false on first sight (caller proceeds with PE
 * submission).
 *
 * Uses (user_id, provider, delivery_id) as the unique key - defined in
 * service-installs.ts as `ServiceInstallEventDedupKey`. GitHub guarantees
 * `X-GitHub-Delivery` is unique per delivery attempt, and the same logical
 * delivery is retried with the same id on transient receive failures.
 */
export async function checkAndMarkDelivery(
  deps: { db: AgentBankDeps['db'] },
  key: { userId: string; provider: 'github'; deliveryId: string },
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
      // Field-based TTL: deploy script must configure a TTL policy on
      // `expires_at` to prune old delivery records. Without TTL the
      // collection grows monotonically; with TTL it stays bounded.
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

/**
 * Pure GitHub webhook handler. Returns the response status + body. The
 * express wrapper translates this into an HTTP response.
 *
 * Order of operations is exact and not to be reordered - every reorder
 * is a security regression (parse-before-verify gives an attacker
 * arbitrary-JSON ingest at the relay; lookup-before-verify creates a
 * timing oracle on installation_id existence; description-before-dedup
 * causes duplicate PEs on retries).
 */
export async function handleGitHubWebhook(
  deps: AgentBankDeps,
  input: GitHubWebhookInput,
): Promise<GitHubWebhookResult> {
  // (1) Config gate - refuse to act when the connector isn't configured.
  if (!input.config.enabled || !input.config.webhookSecret) {
    return { status: 503, body: { error: 'github_webhook_not_configured' } };
  }

  // (2) Signature verify BEFORE parse, constant-time compare.
  if (!verifyGitHubSignature(input.rawBody, input.signatureHeader, input.config.webhookSecret)) {
    // Ops observability (Part D): drop-reason counters make the 08-16 git-witness breakage
    // class (a commit that should mint silently dropped) a first-class metric. Structure-only.
    bumpOpsCounter('gitwitness.invalid_signature');
    return { status: 401, body: { error: 'invalid_signature' } };
  }

  // (3) Parse - only now, after signature passes.
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(input.rawBody);
  } catch {
    bumpOpsCounter('gitwitness.invalid_json');
    return { status: 400, body: { error: 'invalid_json' } };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    bumpOpsCounter('gitwitness.invalid_payload_shape');
    return { status: 400, body: { error: 'invalid_payload_shape' } };
  }

  // (4) Required headers + identifiers
  if (!input.eventType || !input.deliveryId) {
    return { status: 400, body: { error: 'missing_required_headers' } };
  }

  // The repository's own presentation gate is separate from Git Witness earning.
  // Only authenticated App deliveries for our two exact repository ids enter it.
  if (process.env.GITHUB_PR_GATE_ENABLED === 'true' && input.eventType === 'pull_request' &&
      ['opened', 'reopened', 'synchronize', 'edited', 'ready_for_review'].includes(String(payload.action))) {
    const repository = objectOf(payload.repository);
    const name = typeof repository.name === 'string' ? repository.name : '';
    if (isPrGateRepository(name) && repository.id === PR_GATE_REPOSITORIES[name].id &&
        repository.full_name === PR_GATE_REPOSITORIES[name].name) {
      try { await syncPrGate({ db: deps.db, api: prGateApi }, name, Number(objectOf(payload.pull_request).number)); }
      catch { return { status: 503, body: { error: 'pr_gate_sync_pending' } }; }
    }
  }

  if (input.eventType === 'github_app_authorization' && payload.action === 'revoked') {
    const id = objectOf(payload.sender).id;
    if (!Number.isSafeInteger(id)) return { status: 400, body: { error: 'invalid_github_identity' } };
    await revokeGitHubIdentity({ db: deps.db }, String(id));
    return { status: 200, body: { ok: true } };
  }
  if (process.env.GITHUB_PR_GATE_ENABLED === 'true' && input.eventType === 'pull_request_review') {
    const repository = objectOf(payload.repository); const name = repository.name;
    if (payload.action === 'submitted' && isPrGateRepository(name) && repository.id === PR_GATE_REPOSITORIES[name].id &&
        repository.full_name === PR_GATE_REPOSITORIES[name].name &&
        objectOf(payload.sender).id === Number(PR_GATE_REPOSITORIES[name].ownerId)) {
      try {
        const number = Number(objectOf(payload.pull_request).number);
        const pr = objectOf(payload.pull_request); const base = objectOf(pr.base);
        const approved = await approvePrMerge({ db: deps.db, api: prGateApi }, name, number, Number(objectOf(payload.review).id), {
          head_sha: String(objectOf(pr.head).sha ?? ''), base_ref: String(base.ref ?? ''), base_sha: String(base.sha ?? ''),
        });
        const merged = approved && await mergeApprovedPr({ db: deps.db, api: prGateApi }, name, number);
        if (approved && !merged) return { status: 503, body: { error: 'pr_gate_merge_pending' } };
        return { status: 200, body: { ok: true, merged } };
      } catch { return { status: 503, body: { error: 'pr_gate_approval_pending' } }; }
    }
    return { status: 200, body: { ok: true } };
  }

  // (4a) GitHub connectivity ping. GitHub sends event `ping` when the App's
  // webhook is first configured, and again on manual redelivery from the App's
  // Advanced -> Recent Deliveries tab. It is an APP-LEVEL delivery with no
  // `installation` object, so it can never carry a codebase event - acknowledge
  // it 200 so GitHub marks the endpoint healthy, but emit NO PE and touch no
  // install / dedup state. Placed AFTER signature verification (step 2): an
  // unsigned or wrongly-signed ping still returns 401, so this ack is proof the
  // shared secret is wired, never a bypass. Every non-ping event continues to
  // require an installation id below.
  if (input.eventType === 'ping') {
    return { status: 200, body: { ok: true, ping: true } };
  }

  const installation = (payload as Record<string, unknown>).installation as
    | Record<string, unknown>
    | undefined;
  const installationIdRaw = installation && installation.id;
  const installationId =
    typeof installationIdRaw === 'number'
      ? String(installationIdRaw)
      : typeof installationIdRaw === 'string'
        ? installationIdRaw
        : null;
  if (!installationId) {
    return { status: 400, body: { error: 'missing_installation_id' } };
  }

  // (5) Install lookup
  const install = await getServiceInstallByInstallationId(deps.db, PROVIDER, installationId);
  if (!install) {
    return { status: 404, body: { error: 'install_not_found' } };
  }
  if (install.revoked_at !== null) {
    return { status: 410, body: { error: 'install_revoked' } };
  }

  // (5.5) Stamp the STABLE forge account this install serves, from the
  // HMAC-verified payload's `repository.owner` (an installation is bound to
  // exactly one account, so the owner is stable per install). The stamp is
  // what scopes author mappings and authorizes explicit contributor
  // registration — it must only ever derive from a signature-verified
  // delivery, which is why it sits behind steps 2/5 and never in the connect
  // flow (the relay holds no GitHub App private key by design, so the
  // webhook is the only trustworthy source). Idempotent; before dedup so a
  // retried first delivery still teaches a row the initial attempt missed.
  const repoOwner = extractRepositoryOwnerAccount(payload);
  if (repoOwner) {
    await stampServiceInstallForgeAccount(deps.db, PROVIDER, installationId, {
      id: repoOwner.id,
      login: repoOwner.login,
    });
  }

  // (6) Dedup BEFORE we synthesize / submit. GitHub retries deliveries.
  // The durable worker marks completion AFTER processing; an interrupted attempt stays retryable.
  const alreadySeen = input.durable
    ? (await deps.db.collection(DELIVERIES_COLLECTION).doc(`${PROVIDER}_${install.user_id}_${input.deliveryId}`).get()).exists
    : await checkAndMarkDelivery(deps, { userId: install.user_id, provider: PROVIDER, deliveryId: input.deliveryId });
  if (alreadySeen) {
    return { status: 200, body: { idempotent: true } };
  }

  // (7) Synthesize or drop. If the event type isn't supported, or the
  // payload doesn't carry enough structure to produce a real
  // description, we acknowledge 200 (GitHub stops retrying) but emit
  // NO PE - placeholders would hit the relay blocklist or be down-
  // weighted to nothing.
  const synthesized = synthesizeFromGitHubPayload(input.eventType, payload);
  if (!synthesized) {
    const expected = isExpectedNonEarningGitHubEvent(input.eventType, payload);
    bumpOpsCounter(expected ? 'gitwitness.ignored_non_earning_event' : 'gitwitness.dropped_invalid_earning_event');
    // Structured log without payload echo
    console[expected ? 'info' : 'warn']('[GitHubWebhook] synthesis_outcome', {
      outcome: expected ? 'ignored_non_earning_event' : 'invalid_earning_event',
      event_type: input.eventType,
      delivery_id: input.deliveryId,
      installation_id: installationId,
    });
    return { status: 200, body: { dropped: true, reason: 'unsynthesizable_or_unsupported_event' } };
  }

  // (8) Resolve attribution by the commit's git-AUTHOR identity. We credit the
  // author, NEVER the repo connector: a commit whose author has no verified mapping
  // is not attributable to anyone we can name, so we do not mint it (Unknown =
  // Block). This is what stops a repo owner being credited for a collaborator's or
  // agent's commits, and — together with the per-wallet mint-once claim — stops one
  // commit minting to two different wallets (the committer's daemon + the owner's
  // webhook). Registration of contributor identities is the agent-signature flow in
  // routes/agent-attribution.ts.
  // Mappings are scoped to the STABLE forge account (repository.owner.id), so
  // they survive GitHub-side reinstalls (new installation_id) and wallet
  // re-points (the 08-13 production orphan mechanism). A payload without a
  // repository owner cannot resolve any scope and drops below — fail-closed,
  // identical to today's unmapped drop (Unknown = Block).
  // A commit-family event (push / merged PR) attributes to its git AUTHOR only — never the
  // pusher/sender. A generic event (issue, release, review…) has no author; its SENDER did the act.
  const candidates = synthesized.commitSha === null
    ? extractGitHubSenderKeyCandidates(payload)
    : extractGitHubAuthorKeyCandidates(payload);
  let attribution = repoOwner
    ? await resolveAgentAuthorAttribution(deps.db, {
      provider: PROVIDER,
      forgeAccountId: repoOwner.id,
      sourceOwnerWalletId: install.user_id,
      candidates,
    })
    : null;

  // (8a) Owner auto-capture + rebind. When nothing resolves, opportunistically
  // bind the repo OWNER's own identity (personal/User installs only) from this
  // signed payload's `repository.owner` and re-resolve, so the owner's own
  // first commit credits them with zero setup. This can never credit the owner
  // for someone else's commit: it only creates a mapping for the owner's OWN
  // GitHub account, and re-resolution still matches solely on this commit's
  // author. A non-owner author stays unmapped and drops below.
  //
  // The REBIND leg: when resolution returns a 'repo_owner_capture' mapping
  // pointing at a wallet that is NOT the current install owner, the install
  // was re-pointed since capture — owner-capture mappings follow the CURRENT
  // owner (conductor decision 4), so re-run capture (which rebinds inside
  // createOwnerCaptureMapping) and re-resolve. Explicit
  // 'agent_wallet_signature' mappings are never rebound.
  const staleOwnerCapture = attribution !== null
    && attribution.verifiedBy === 'repo_owner_capture'
    && attribution.agentWalletId !== install.user_id;
  if (repoOwner && (!attribution || staleOwnerCapture)) {
    const captured = await maybeCaptureRepoOwner(deps, install.user_id, repoOwner);
    if (captured) {
      attribution = await resolveAgentAuthorAttribution(deps.db, {
        provider: PROVIDER,
        forgeAccountId: repoOwner.id,
        sourceOwnerWalletId: install.user_id,
        candidates,
      });
    }
  }

  // (9) Record to the AUTHOR's wallet — only when attribution resolved. attestation
  // tier is software by construction (no device key on this path). service:* is
  // external_proof_priced; : this software-tier
  // witness EARNS the family's software discount — 3.0x weight x 0.8x software = 2.4x,
  // eligible — priced down by novelty decay, and chain-verified corroboration lifts it
  // to the family's flat 1.0x (the full 3.0x). A bare relay submission carrying no
  // server-verified binding still floors at pending_evidence via the evidence gate.
  // Step (10)'s cross-witness corroboration below remains a provenance record on the
  // target PE.
  let peId: string | undefined;
  let peHash: string | undefined;
  const preparedPE = input.durable?.preparedPE;
  if (attribution || preparedPE) {
    // Prompt 2 — ORDER-INDEPENDENCE (device-first): if a device `coding_session`
    // for this commit already recorded (the common order — the local hook fires
    // on commit, the webhook arrives seconds later), union its rich origins
    // (parent, deps, files) into THIS forge PE's canonical origins so the
    // mint-winner carries the union. The forge-first order is unioned at
    // corroboration time (commit-takeover.ts). Best-effort; never blocks the seal.
    let unionedOrigins = synthesized.input_origins;
    if (synthesized.commitSha) {
      try {
        const prior = await findCommitOriginsBySha(deps.db, synthesized.commitSha);
        if (prior.length > 0) unionedOrigins = mergeInputOrigins(synthesized.input_origins, prior);
      } catch (err) {
        console.warn('[github-webhook] prior-commit origin union failed (non-blocking):', err);
      }
    }
    const candidate: GeneratePEParams = preparedPE ?? {
      walletId: attribution!.agentWalletId,
      agentId: attribution!.agentId,
      actorAddress: attribution!.agentAddress,
      actionType: synthesized.actionType,
      // Prompt 2: the resolvable origins the webhook witnessed (repo, parent
      // commit, URL) UNIONED with any prior same-commit device origins; generatePE
      // normalizes + hashes them on the canonical doc.
      input_origins: unionedOrigins,
      // Fact-base fixes item 4 (2026-09-23): the HMAC-verified webhook witnesses EXACTLY the origins
      // the relay derived from it (repo, parent commit) — never the unioned device origins or the
      // forge's own URL host.
      ...(synthesized.relay_derived_origins && synthesized.relay_derived_origins.length > 0
        ? { relayObservation: { witness: relayObservationWitness(RELAY_WITNESS_FORGE_WEBHOOK, 'github_app'), derivedOrigins: synthesized.relay_derived_origins } }
        : {}),
      // Audit 2026-08-05 (finding 11): route the verified webhook witness through the durable
      // ordinary intake (crash-recoverable seal), and stamp verified — the HMAC-authenticated
      // webhook IS a trusted server verification that the commit happened. Both remain
      // SEPARATE necessary conditions (pe-utils, /). (3b) made the service:*
      // rows lineage-optional; prices the software-tier verified emit
      // at the family's 0.8x software discount (eligible, 2.4x after the 3.0x weight), with
      // chain-verified corroboration lifting to the flat 1.0x. This receiver stays gated on
      // loadGitHubAppConfig().enabled (GITHUB_APP_WEBHOOK_SECRET).
      durableViaOrdinaryIntake: true,
      // : the HMAC-verified webhook is the forge witness (explicit — a generic
      // event carries no commit for the identifier-type derivation to read). A non-commit event's
      // mint-once anchor is its own GitHub identity (canonicalEventId), never the delivery id.
      witnessClass: 'forge_witnessed',
      ...(synthesized.canonicalEventId ? { observedCanonicalEventId: synthesized.canonicalEventId } : {}),
      metadata: {
        ...synthesized.metadata,
        verified: true,
        delivery_id: input.deliveryId,
        installation_id: installationId,
        witness: 'github_webhook',
        attribution: attributionMetadata(PROVIDER, install.user_id, attribution!),
      },
    };
    const params = input.durable ? await input.durable.preparePE(candidate) : candidate;
    const generated = await generatePE(deps, params);
    peId = generated.peId;
    peHash = generated.peHash;
  } else {
    // No attributable author — hold, do not mint. Ack 200 so GitHub stops retrying;
    // the delivery was already deduped (step 6), so this drop is forward-only per
    // delivery (a mapping added later does not retro-mint an old redelivery). No
    // payload echo in the log (matches the unsynthesizable drop).
    // Ops observability (Part D): this is the exact 08-16 breakage class — a commit that
    // should mint silently dropped for want of an author mapping. Count it (structure-only).
    const bot = isUnmappedGitHubBot(input.eventType, payload);
    bumpOpsCounter(bot ? 'gitwitness.unmapped_bot_actor' : 'gitwitness.dropped_unmapped_author');
    console[bot ? 'info' : 'warn']('[GitHubWebhook] attribution_outcome', {
      outcome: bot ? 'unmapped_bot_actor' : 'unmapped_author',
      event_type: input.eventType,
      delivery_id: input.deliveryId,
      installation_id: installationId,
    });
  }

  // (10) Bidirectional cross-witness corroboration via the LIVE CorroborationManager
  // path (GATE 0 decision: one corroboration mechanism, not two). This fires WHETHER
  // OR NOT we minted, because it only emits mint-free signals against prior PEs for
  // the same commit hash — so an unmapped author's commit still corroborates that
  // author's own device-witness (daemon) PE. corroboratingParty is `'github_app'`
  // (a system actor), distinct from any user wallet id, so the self-corroboration
  // guard doesn't reject the cross-witness case.
  if (synthesized.commitSha) {
    // findPEsByCommitSha reads provenance_envelopes (the only collection with
    // both metadata.commit_sha AND the canonical hash) and returns the hash +
    // chain owner, so no second read is needed. CorroborationManager validates
    // the target against pe_history.peHash (== this hash) and writes the status
    // back there.
    // F25 (S2 2026-09-10): scope the corroboration to the owner THIS delivery
    // attributes the commit to. The forge witness names an owner — the verified
    // commit-author's agent when mapped, else the install owner whose repo the
    // commit landed in — and the device witness is the target PE's chain owner;
    // both must name the SAME owner before a status is written. Without this,
    // any GitHub App installer could lift ANY wallet's PE that merely names a
    // commit SHA to the corroborated tier by pushing that commit to their own
    // repo (a cross-wallet grant). Unmatched owner ⇒ skip (Unknown = Block).
    //
    // Compare in the AGENT-ID namespace: findPEsByCommitSha returns match.userId
    // as the target PE's stored `user_id`, which generatePE sets to the agent_id
    // (buildStoredDoc: user_id = agentId), and agent device-witness PEs likewise
    // store user_id = the chain owner = agent_id. So the attributed owner is
    // attribution.agentId (the agent_id), NOT agentWalletId (the wallets doc id, a
    // different namespace) — comparing agentWalletId would mismatch EVERY mapped
    // agent's own PE and over-suppress its legitimate corroboration (Sec. Invariant
    // #8). The unmapped fallback is install.user_id, unchanged.
    const attributedOwner = preparedPE?.agentId ?? attribution?.agentId ?? install.user_id;
    const matches = await findPEsByCommitSha(deps.db, synthesized.commitSha);
    for (const match of matches) {
      if (peId && match.envelopeId === peId) continue; // skip the PE we just created
      if (!match.hash) continue; // can't emit a corroboration without a target hash
      if (match.userId !== attributedOwner) continue; // F25: same-owner (agent-id namespace)
      await emitBackendCorroboration(deps, {
        targetPeId: match.envelopeId,
        targetPeHash: match.hash,
        signalType: 'github_webhook_attestation',
        corroboratingParty: 'github_app',
        evidence: `delivery=${input.deliveryId},commit=${synthesized.commitSha}`,
        evidenceRef: input.deliveryId,
        walletId: match.userId,
        agentId: match.agentId,
        actorAddress: '',
        ...(input.durable ? {
          peIdOverride: `pe_ghc_${crypto.createHash('sha256').update(`${input.deliveryId}:${match.envelopeId}`).digest('hex')}`,
          timestampOverride: input.durable.receivedAt,
        } : {}),
      });
    }
  }

  if (!peId) {
    return { status: 200, body: { dropped: true, reason: 'unmapped_author' } };
  }
  return { status: 200, body: { pe_id: peId, pe_hash: peHash } };
}

/**
 * The GitHub account that owns the delivering repository, from
 * `payload.repository.owner` the field GitHub ACTUALLY sends on push and
 * pull_request App deliveries. (2026-08-16 fix: the previous reader used
 * `payload.installation.account`, which does not exist on event deliveries —
 * GitHub App events carry only InstallationLite `{ id, node_id }` so owner
 * auto-capture had never fired in production and every push since
 * dropped `dropped_unmapped_author`, the operator’s own included.)
 *
 * `owner.id` is the account's stable databaseId — the forge-account scope
 * mappings are keyed to. Returns null when the payload carries no usable
 * owner (capture and resolution then skip; the delivery drops exactly as an
 * unmapped author does today — fail-closed, never a wrong-wallet guess).
 */
function extractRepositoryOwnerAccount(
  payload: Record<string, unknown>,
): { id: string; login: string | null; type: string | null } | null {
  const repository = payload.repository as Record<string, unknown> | undefined;
  const owner = repository && (repository.owner as Record<string, unknown> | undefined);
  if (!owner || typeof owner !== 'object') return null;
  const idRaw = owner.id;
  const id = typeof idRaw === 'number' && Number.isFinite(idRaw)
    ? String(idRaw)
    : typeof idRaw === 'string' && idRaw.length > 0
      ? idRaw
      : null;
  if (!id) return null;
  return {
    id,
    login: typeof owner.login === 'string' && owner.login.length > 0 ? owner.login : null,
    type: typeof owner.type === 'string' ? owner.type : null,
  };
}

/**
 * Auto-capture (or rebind — see createOwnerCaptureMapping) the repo OWNER's
 * git identity from a signed push payload, so the owner's own commits stay
 * attributable after the install-owner fallback was removed. Only fires for
 * PERSONAL (User-account) repos, where `repository.owner.login` is the
 * owner's own GitHub username; for Organization repos there is no single
 * owner, so contributors register explicitly. Idempotent. Returns true if an
 * owner mapping now exists for the captured identity.
 */
async function maybeCaptureRepoOwner(
  deps: AgentBankDeps,
  ownerWalletId: string,
  repoOwner: { id: string; login: string | null; type: string | null },
): Promise<boolean> {
  if (repoOwner.type !== 'User') return false;
  if (!repoOwner.login) return false;
  const authorKey = normalizeAuthorKey({ type: 'username', value: repoOwner.login });
  if (!authorKey) return false;
  // createOwnerCaptureMapping returns null when the owner's wallets doc can't be
  // resolved to a canonical user_id (WS4 fail-closed). Treat that as "not
  // captured" so the caller re-resolves to null and the commit drops unmapped,
  // rather than minting to a mis-keyed identity (Unknown = Block).
  const mapping = await createOwnerCaptureMapping(deps.db, {
    provider: PROVIDER,
    forgeAccountId: repoOwner.id,
    forgeAccountLogin: repoOwner.login,
    ownerWalletId,
    authorKey,
  });
  return mapping !== null;
}

/** The App's plumbing and other routine notifications carry no work. Malformed earning events remain visible. */
export function isExpectedNonEarningGitHubEvent(event: string, payload: Record<string, unknown>): boolean {
  if (event === 'pull_request') return payload.action !== 'closed' || objectOf(payload.pull_request).merged !== true;
  if (event === 'push') return (payload.created === true || payload.deleted === true)
    && Array.isArray(payload.commits) && payload.commits.length === 0;
  return GITHUB_APP_PLUMBING_EVENTS.has(event);
}
function isUnmappedGitHubBot(event: string, payload: Record<string, unknown>): boolean {
  const actor = event === 'pull_request' ? objectOf(objectOf(payload.pull_request).user)
    : event === 'push' ? objectOf(objectOf(payload.head_commit).author) : objectOf(payload.sender);
  // GitHub's account login is distinct from arbitrary commit author names/emails.
  const login = event === 'push' ? actor.username : actor.login;
  return actor.type === 'Bot' || (typeof login === 'string' && /^[a-z0-9-]+\[bot\]$/i.test(login));
}
