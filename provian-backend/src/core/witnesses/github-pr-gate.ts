import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { Timestamp } from 'firebase-admin/firestore';
import { assertBurnRowUsable, BURN_CONSUMPTIONS_COLLECTION, PVT_BURN_RECORDS_COLLECTION } from '../commons/burn-consumption';
import { burnFinalityOf } from '../presentation/burn-finality-state';
import { signChallengeEnvelope, type ChallengeEnvelope } from '../presentation/challenge';
import { loadPresentationSigningKey } from '../presentation/signer';
import { loadCommerceAttestationKeys } from '../presentation/jws-key-material';
import { decodePresentationToken } from '../presentation/types';
import { verifyPresentation } from '../presentation/verify';
import { GITHUB_WALLET_LINKS } from './github-identity-link';
import { GitHubPrApiError, objectOf, PR_GATE_REPOSITORIES, type PrGateApi, type PrGateRepository } from './github-pr-api';
import { enqueueGitHubTask, type GitHubTask } from './github-task-queue';

export const PR_GATE_CHECK = 'Provian PR gate';
export const PR_GATE_LABEL = 'presentation-required';
export const PR_GATE_PRICE_ATOMIC = 50_000_000_000_000_000_000n;
export const PR_GATE_DOMAIN = 'provian.ai';
export const PR_GATES_COLLECTION = 'github_pr_gates_v1';
export const PR_GATE_SEEN_COLLECTION = 'github_pr_gate_presentations_v1';
export const PR_GATE_CHALLENGES_COLLECTION = 'github_pr_gate_challenges_v1';
const COMMENT_MARKER = '<!-- provian-pr-gate -->';
const SHA_RE = /^[a-f0-9]{40}$/;

export class PrGateError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
export interface PrGateDeps {
  readonly db: Firestore;
  readonly api: PrGateApi;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly verify?: typeof verifyPresentation;
}
export interface PrGateRow {
  repository: PrGateRepository;
  number: number;
  author_id: string;
  author_login: string;
  head_sha: string;
  check_sha?: string;
  base_ref?: string;
  base_sha?: string;
  merge_approval?: { review_id: number; head_sha: string; base_ref: string; base_sha: string; approved_at: number };
  state: string;
  author_wallet?: { wallet_id: string; address: string; github_id: string };
  challenge?: ChallengeEnvelope;
  cleared?: PrGateReceipt;
  pending?: PrGateReceipt | null;
}
interface PrGateReceipt { burn_id: string; presenter_id: string; amount_atomic: string; at: number; token_sha256: string }
const challengeId = (nonce: string): string => crypto.createHash('sha256').update(nonce).digest('hex');
export function prGateId(repo: PrGateRepository, number: number): string {
  if (!Number.isSafeInteger(number) || number < 1) throw new PrGateError(400, 'invalid_pr_number');
  return `${PR_GATE_REPOSITORIES[repo].id}_${number}`;
}
export function prGateUrl(repo: PrGateRepository, number: number): string {
  return `https://provian.ai/gates/pr?repo=${repo}&pr=${number}`;
}
export function prGateComment(repo: PrGateRepository, number: number, cleared: boolean): string {
  const endpoint = `https://api.provian.ai/v1/gates/github/${repo}/${number}`;

  return `${COMMENT_MARKER}\n## Provian PR gate · 50 PVT\n\n${cleared
    ? '**Presentation accepted.** This PR is cleared. Further pushes and reopening require no additional burn.'
    : '**Presentation required.** This PR remains blocked until its author presents to provian.ai with a burn of at least **50 PVT**, bound to this PR’s signed challenge.'}
\n**The repository owner, LongevityManiac, is exempt. Other PR authors present from their own wallet; another wallet cannot pay. One burn per contributor PR.** Git Witness earning is unchanged; merged commits keep earning.\n\n` +
    `**Agent:** author the PR using the agent’s own GitHub account and link that account to its own wallet, fetch \`${endpoint}/challenge\`, then run:\n\n` +
    '```sh\n' + `curl -fsS '${endpoint}/challenge' -o challenge.json\n` +
    'provian respond --challenge-json @challenge.json --rpc-url https://mainnet.base.org --tier reputation --burn-amount-atomic 50000000000000000000 --yes > response.json\n' +
    `jq '{token: .token}' response.json | curl -fsS '${endpoint}/present' -H 'Content-Type: application/json' --data-binary @-\n` + '```\n\n' +
    `**Human:** [open this PR’s gate](${prGateUrl(repo, number)}), copy its signed challenge into the app’s outside-gate presenter, burn 50 PVT, then paste the resulting token back at the gate.\n\n` +
    '**No wallet yet?** A human opens Connect an agent in the app and gives the agent its one-time install command: ' +
    '`curl -fsSL -H "x-provian-token: PROV-XXXX-XXXX" https://api.provian.ai/v1/bootstrap/agent | sh`. ' +
    'The agent then connects with `provian git-identity github-link` and authorizes the displayed code on GitHub. ' +
    'For a human wallet, [get the app](https://provian.ai/download), then open Connect → GitHub. ' +
    '[Contributing walkthrough](https://provian.ai/library/contributing) covers wallet setup and GitHub identity linking. ' +
    '**Merge approval:** clearance only unlocks merge. After clearance, the repository owner submits an **Approve** review on the current PR head. For contributor PRs, Git Witness merges to the protected branches, and it verifies that explicit review, this PR’s own clearance and all branch protections. Clearance never triggers a merge. A push requires a fresh approval, with no additional burn. ' +
    'A presentation for another PR is refused. After a verified submission, finality and clearance finish automatically. If a retry is needed, reuse the same token; do not burn again.';

}

/** The PR author comes from GitHub, never from the presenter or webhook sender. */
export async function readGitHubPr(deps: PrGateDeps, repo: PrGateRepository, number: number): Promise<PrGateRow> {
  prGateId(repo, number);
  const pr = objectOf(await deps.api.call(repo, 'GET', `/pulls/${number}`));
  const author = objectOf(pr.user); const baseRepo = objectOf(objectOf(pr.base).repo);
  const sha = objectOf(pr.head).sha;
  const baseRef = objectOf(pr.base).ref;
  const baseSha = objectOf(pr.base).sha;
  if (baseRepo.id !== PR_GATE_REPOSITORIES[repo].id || pr.number !== number ||
      !Number.isSafeInteger(author.id) || typeof author.login !== 'string' ||
      typeof sha !== 'string' || !SHA_RE.test(sha) || typeof baseRef !== 'string' ||
      typeof baseSha !== 'string' || !SHA_RE.test(baseSha) || (pr.state !== 'open' && pr.state !== 'closed')) {
    throw new PrGateError(502, 'github_pr_binding_invalid');
  }
  return { repository: repo, number, author_id: String(author.id), author_login: author.login, head_sha: sha, state: pr.state,
    // GitHub regenerates test-merge commits while evaluating checks. Publish
    // on the stable head; per-PR clearance remains the App merger's authority.
    check_sha: sha,
    base_ref: baseRef, base_sha: baseSha };
}

/** Only the repository owner's immutable GitHub account is exempt. */
export function isPrGateOwner(row: Pick<PrGateRow, 'repository' | 'author_id'>): boolean {
  return row.author_id === PR_GATE_REPOSITORIES[row.repository].ownerId;
}

/** The actual author's unique verified wallet, pinned on this PR's first challenge. */
export async function resolvePrAuthor(deps: PrGateDeps, row: PrGateRow, walletId?: string): Promise<{ id: string; address: string } | null> {
  if (isPrGateOwner(row)) return null;
  // The GitHub PR's actual author is authoritative. A wallet-signed request cannot
  // turn an App-bot-authored PR into an agent-authored PR.
  if (row.author_login.endsWith('[bot]')) return null;
  const links = await deps.db.collection(GITHUB_WALLET_LINKS).where('github_id', '==', row.author_id).limit(100).get();
  if (links.docs.length >= 100) return null;
  const revoked = (await deps.db.collection('github_identity_revocations_v1').doc(row.author_id).get()).data();
  const candidates = links.docs.map((d) => d.data()).filter((d) => d.verified_by === 'github_user_oauth' &&
    d.revoked_at === null && Number(d.verified_at) > Number(revoked?.revoked_at ?? 0));
  const owners = [...new Set(candidates.map((d) => d.wallet_id as unknown))];
  if (owners.length !== 1 || typeof owners[0] !== 'string') return null;
  const id = owners[0];
  if (walletId && walletId !== id) return null;
  const saved = (await deps.db.collection(PR_GATES_COLLECTION).doc(prGateId(row.repository, row.number)).get()).data();
  const pinned = saved?.author_wallet;
  if (pinned && (pinned.github_id !== row.author_id || pinned.wallet_id !== id)) return null;
  const agent = await deps.db.collection('agent_wallets').doc(id).get();
  const a = objectOf(agent.data());
  if (a.status === 'active' && typeof a.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a.address)) return !pinned || pinned.address === a.address.toLowerCase() ? { id, address: a.address.toLowerCase() } : null;
  const wallet = await deps.db.collection('wallets').doc(id).get();
  const data = objectOf(wallet.data()); const address = typeof data.address === 'string' ? data.address : data.wallet_address;
  return wallet.exists && typeof address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(address) && (!pinned || pinned.address === address.toLowerCase())
    ? { id, address: address.toLowerCase() } : null;
}

export async function issuePrGateChallenge(deps: PrGateDeps, repo: PrGateRepository, number: number, walletId?: string): Promise<ChallengeEnvelope> {
  const row = await readGitHubPr(deps, repo, number);
  if (isPrGateOwner(row)) throw new PrGateError(409, 'repository_owner_exempt');
  await finalizePrGatePending(deps, repo, number);
  if (row.state !== 'open') throw new PrGateError(409, 'pr_not_open');
  const presenter = await resolvePrAuthor(deps, row, walletId);
  if (!presenter) throw new PrGateError(428, 'link_github_identity_to_wallet');
  const signing = loadPresentationSigningKey(deps.env);
  if (!signing.ok) throw new PrGateError(503, 'gate_signing_unavailable');
  const now = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const ref = deps.db.collection(PR_GATES_COLLECTION).doc(prGateId(repo, number));
  return deps.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref); const saved = snap.data() as PrGateRow | undefined;
    if (saved?.cleared) throw new PrGateError(409, 'pr_already_cleared');
    if (saved?.pending) throw new PrGateError(425, 'burn_finality_pending_retry_same_token');
    if (saved?.challenge && saved.author_id === row.author_id && saved.challenge.presenter === presenter.address &&
        saved.challenge.expiresAt !== undefined && saved.challenge.expiresAt > now + 60) return saved.challenge;
    const challenge = signChallengeEnvelope({ audience: PR_GATE_DOMAIN,
      challenge: `github-pr:${PR_GATE_REPOSITORIES[repo].id}:${number}:${row.author_id}:${crypto.randomBytes(32).toString('hex')}`,
      requester: { type: 'domain', id: PR_GATE_DOMAIN, kid: signing.key.kid },
      presenter: presenter.address, issuedAt: now, expiresAt: now + 900, predicates: [], disclosures: [],
    }, signing.key.privateKey);
    // Renewing a quote never invalidates an earlier still-live signed challenge.
    tx.create(deps.db.collection(PR_GATE_CHALLENGES_COLLECTION).doc(challengeId(challenge.challenge)), {
      pr_id: ref.id, author_id: row.author_id, presenter_id: presenter.id, envelope: challenge,
      expire_at: Timestamp.fromMillis((now + 900 + 3600) * 1000),
    });
    if (saved?.author_wallet && (saved.author_wallet.wallet_id !== presenter.id || saved.author_wallet.address !== presenter.address || saved.author_wallet.github_id !== row.author_id)) throw new PrGateError(403, 'author_wallet_mismatch');
    tx.set(ref, { ...row, challenge, author_wallet: { wallet_id: presenter.id, address: presenter.address, github_id: row.author_id } }, { merge: true });
    return challenge;
  });
}

export async function acceptPrGatePresentation(deps: PrGateDeps, repo: PrGateRepository, number: number, token: string): Promise<void> {
  if (typeof token !== 'string' || token.length > 256 * 1024) throw new PrGateError(400, 'invalid_token');
  const row = await readGitHubPr(deps, repo, number);
  if (isPrGateOwner(row)) throw new PrGateError(409, 'repository_owner_exempt');
  if (row.state !== 'open') throw new PrGateError(409, 'pr_not_open');
  const ref = deps.db.collection(PR_GATES_COLLECTION).doc(prGateId(repo, number));
  const saved = (await ref.get()).data() as PrGateRow | undefined;
  const digest = crypto.createHash('sha256').update(token).digest('hex');
  if (saved?.cleared) {
    const author = await resolvePrAuthor(deps, row, saved.cleared.presenter_id);
    if (!author) throw new PrGateError(403, 'author_wallet_mismatch');
    if (saved.cleared.token_sha256 === digest && saved.author_id === row.author_id) return;
    throw new PrGateError(409, 'pr_already_cleared');
  }
  if (saved?.pending) {
    if (!await resolvePrAuthor(deps, row, saved.pending.presenter_id)) throw new PrGateError(403, 'author_wallet_mismatch');
    if (saved.pending.token_sha256 !== digest || saved.author_id !== row.author_id) throw new PrGateError(409, 'pr_presentation_pending');
    await finalizePrGatePending(deps, repo, number);
    const result = (await ref.get()).data() as PrGateRow | undefined;
    if (!result?.cleared) throw new PrGateError(result?.pending ? 425 : 409,
      result?.pending ? 'burn_finality_pending_retry_same_token' : 'burn_revoked');
    return;
  }
  const presentation = decodePresentationToken(token);
  if (!presentation || presentation.tier !== 'reputation' || typeof presentation.payload?.chal !== 'string') throw new PrGateError(403, 'reputation_presentation_required');
  const issuedRef = deps.db.collection(PR_GATE_CHALLENGES_COLLECTION).doc(challengeId(presentation.payload.chal));
  const issued = (await issuedRef.get()).data();
  const envelope = issued?.envelope as ChallengeEnvelope | undefined;
  if (!envelope || issued?.pr_id !== ref.id || issued.author_id !== row.author_id) throw new PrGateError(403, 'challenge_mismatch');
  const presenter = await resolvePrAuthor(deps, row, typeof issued?.presenter_id === 'string' ? issued.presenter_id : '');
  if (!presenter || presenter.address !== envelope.presenter) throw new PrGateError(403, 'author_wallet_mismatch');
  const keys = loadCommerceAttestationKeys(deps.env);
  if (!keys.ok) throw new PrGateError(503, 'presentation_keys_unavailable');
  // Same cryptographic verification and fail-closed expectations as the reference gate.
  const checked = await (deps.verify ?? verifyPresentation)(presentation, { publicKeys: keys.keys,
    expectedAudience: PR_GATE_DOMAIN, expectedChallenge: envelope.challenge, expectedPresenter: presenter.id,
    expectedRequester: { type: 'domain', id: PR_GATE_DOMAIN }, challengeDeadline: envelope.expiresAt,
    nowSeconds: Math.floor((deps.now?.() ?? Date.now()) / 1000),
  });
  if (!checked.valid) throw new PrGateError(403, checked.reason);
  if (!checked.requester || checked.requester.type !== 'domain' || checked.requester.id !== PR_GATE_DOMAIN ||
      checked.payload.presenter_address !== presenter.address) throw new PrGateError(403, 'requester_or_presenter_mismatch');
  const burnId = checked.presentation_id;
  if (!/^[a-f0-9]{64}$/.test(burnId)) throw new PrGateError(403, 'burn_id_invalid');
  const burnRef = deps.db.collection(PVT_BURN_RECORDS_COLLECTION).doc(burnId);
  const consumptionRef = deps.db.collection(BURN_CONSUMPTIONS_COLLECTION).doc(burnId);
  const seenRef = deps.db.collection(PR_GATE_SEEN_COLLECTION).doc(burnId);
  const final = await deps.db.runTransaction(async (tx) => {
    const [current, burn, consumption, seen, issuedSnap] = await Promise.all([tx.get(ref), tx.get(burnRef), tx.get(consumptionRef), tx.get(seenRef), tx.get(issuedRef)]);
    const currentRow = current.data() as PrGateRow | undefined;
    if (currentRow?.cleared) {
      if (currentRow.cleared.token_sha256 === digest && currentRow.author_id === row.author_id) return true;
      throw new PrGateError(409, 'pr_already_cleared');
    }
    if (currentRow?.pending) throw new PrGateError(409, 'pr_presentation_pending');
    if (issuedSnap.data()?.pr_id !== ref.id || issuedSnap.data()?.author_id !== row.author_id) throw new PrGateError(403, 'challenge_not_issued_for_pr');
    if (seen.exists) throw new PrGateError(403, 'presentation_replayed');
    const burnRow = burn.data();
    assertBurnRowUsable(burnRow, presenter.id, PR_GATE_PRICE_ATOMIC);
    const consumed = consumption.data();
    if (consumed?.product !== 'presentation' || consumed.wallet_id !== presenter.id) throw new PrGateError(403, 'burn_not_consumed_by_presentation');
    const receipt = { burn_id: burnId, presenter_id: presenter.id,
      amount_atomic: String(burnRow.amount_atomic), at: deps.now?.() ?? Date.now(), token_sha256: digest };
    const final = burnFinalityOf(burnRow) === 'final';
    tx.create(seenRef, { pr: ref.id, author_id: row.author_id, token_sha256: digest, verified_at: receipt.at, final });
    tx.set(ref, { ...row, ...(final ? { cleared: receipt } : { pending: receipt }) }, { merge: true });
    return final;
  });
  if (!final) throw new PrGateError(425, 'burn_finality_pending_retry_same_token');
}

/** A fresh verified submission waits durably for chain finality; token expiry cannot strand it. */
export async function finalizePrGatePending(deps: PrGateDeps, repo: PrGateRepository, number: number): Promise<void> {
  const ref = deps.db.collection(PR_GATES_COLLECTION).doc(prGateId(repo, number));
  await deps.db.runTransaction(async (tx) => {
    const current = await tx.get(ref); const row = current.data() as PrGateRow | undefined;
    const pending = row?.pending;
    if (!pending || row.cleared) return;
    const burnRef = deps.db.collection(PVT_BURN_RECORDS_COLLECTION).doc(pending.burn_id);
    const seenRef = deps.db.collection(PR_GATE_SEEN_COLLECTION).doc(pending.burn_id);
    const [burn, seen] = await Promise.all([tx.get(burnRef), tx.get(seenRef)]);
    if (burnFinalityOf(burn.data()) === 'failed') { tx.update(ref, { pending: null }); return; }
    if (burnFinalityOf(burn.data()) !== 'final') return;
    assertBurnRowUsable(burn.data(), pending.presenter_id, PR_GATE_PRICE_ATOMIC);
    if (seen.data()?.pr !== ref.id || seen.data()?.token_sha256 !== pending.token_sha256) throw new PrGateError(403, 'pending_receipt_mismatch');
    tx.update(ref, { cleared: { ...pending, at: deps.now?.() ?? Date.now() }, pending: null });
    tx.update(seenRef, { final: true });
  });
}

/** Reconcile from GitHub's current state, never from a stale webhook head. */
export async function syncPrGate(deps: PrGateDeps, repo: PrGateRepository, number: number): Promise<void> {
  const lockRef = deps.db.collection('github_pr_gate_locks_v1').doc(String(PR_GATE_REPOSITORIES[repo].id));
  const lease = crypto.randomUUID(); const now = deps.now?.() ?? Date.now();
  await deps.db.runTransaction(async (tx) => {
    const snap = await tx.get(lockRef);
    if (Number(snap.data()?.until ?? 0) > now) throw new PrGateError(503, 'gate_sync_busy_retry');
    tx.set(lockRef, { token: lease, until: now + 180_000 });
  });
  const api = deps.api;
  // Every real API call has a 15s socket deadline. Stop issuing calls after 90s,
  // well before the 180s lease can be reassigned; renew ownership before writes.
  const guarded: PrGateDeps = { ...deps, api: { call: async (r, method, suffix, body) => {
    const at = deps.now?.() ?? Date.now();
    if (at - now > 90_000) throw new PrGateError(503, 'gate_sync_deadline_retry');
    await deps.db.runTransaction(async (tx) => {
      const lock = (await tx.get(lockRef)).data();
      if (lock?.token !== lease || Number(lock.until) - at < 30_000) throw new PrGateError(503, 'gate_sync_lease_lost');
    });
    return api.call(r, method, suffix, body);
  } } };
  try {
    const row = await readGitHubPr(guarded, repo, number);
    if (row.state !== 'open' || isPrGateOwner(row)) return;
    const ref = deps.db.collection(PR_GATES_COLLECTION).doc(prGateId(repo, number));
    await deps.db.runTransaction(async (tx) => {
      const saved = (await tx.get(ref)).data() as PrGateRow | undefined;
      if (saved?.author_id && saved.author_id !== row.author_id) throw new PrGateError(403, 'github_pr_author_changed');
      tx.set(ref, row, { merge: true });
    });
    await finalizePrGatePending(deps, repo, number);
    const saved = (await ref.get()).data() as PrGateRow;
    const cleared = !!saved.cleared && !!await resolvePrAuthor(deps, row, saved.cleared.presenter_id);
    const checkSha = row.check_sha ?? row.head_sha;
    const externalId = `provian-pr:${prGateId(repo, number)}:${checkSha}`;
    const runs = objectOf(await guarded.api.call(repo, 'GET', `/commits/${checkSha}/check-runs?check_name=${encodeURIComponent(PR_GATE_CHECK)}&per_page=100`));
    if (!Array.isArray(runs.check_runs)) throw new Error('github_checks_invalid');
    const existing = runs.check_runs.map(objectOf).find((r) => r.external_id === externalId &&
      objectOf(r.app).id === Number(deps.env?.GITHUB_APP_ID ?? process.env.GITHUB_APP_ID ?? '4570525'));
    const check = existing ?? objectOf(await guarded.api.call(repo, 'POST', '/check-runs', {
      name: PR_GATE_CHECK, external_id: externalId, head_sha: checkSha, status: 'queued', details_url: prGateUrl(repo, number),
    }));
    if (!Number.isSafeInteger(check.id)) throw new Error('github_check_id_invalid');
    const commentBody = prGateComment(repo, number, cleared);
    // Recover an interrupted create by locating the App's marked comment before retrying.
    let comment: Record<string, unknown> | undefined;
    for (let page = 1; ; page++) {
      if (page > 20) throw new PrGateError(503, 'comment_scan_limit');
      const result = await guarded.api.call(repo, 'GET', `/issues/${number}/comments?per_page=100&page=${page}`);
      if (!Array.isArray(result)) throw new Error('github_comments_invalid');
      comment = result.map(objectOf).find((c) => objectOf(c.user).type === 'Bot' &&
        (objectOf(c.performed_via_github_app).id === Number(deps.env?.GITHUB_APP_ID ?? process.env.GITHUB_APP_ID ?? '4570525') ||
          objectOf(c.user).login === 'provian-git-witness[bot]') &&
        typeof c.body === 'string' && c.body.startsWith(COMMENT_MARKER));
      if (comment || result.length < 100) break;
    }
    if (comment) {
      if (comment.body !== commentBody) await guarded.api.call(repo, 'PATCH', `/issues/comments/${comment.id}`, { body: commentBody });
    } else await guarded.api.call(repo, 'POST', `/issues/${number}/comments`, { body: commentBody });
    if (cleared) {
      try { await guarded.api.call(repo, 'DELETE', `/issues/${number}/labels/${PR_GATE_LABEL}`); }
      catch (e) { if (!(e instanceof GitHubPrApiError) || e.status !== 404) throw e; }
    } else {
      await guarded.api.call(repo, 'POST', `/issues/${number}/labels`, { labels: [PR_GATE_LABEL] });
    }
    // Checks describe a commit; the App independently enforces this PR’s stored
    // clearance and the owner's current-head review before every merge.
    const output = { title: cleared ? 'Presentation accepted; owner review required' : '50 PVT presentation required',
      summary: cleared ? 'This PR is cleared. Clearance never merges it. The repository owner must approve its current head after clearance.'
        : `This PR has not presented. ${prGateUrl(repo, number)} · one 50 PVT burn per PR. The App refuses merge without this PR’s clearance.` };
    const payload = { name: PR_GATE_CHECK, external_id: externalId, details_url: prGateUrl(repo, number),
      status: 'completed', conclusion: cleared ? 'success' : 'action_required', output };
    await guarded.api.call(repo, 'PATCH', `/check-runs/${check.id}`, payload);
  } finally {
    await deps.db.runTransaction(async (tx) => {
      const snap = await tx.get(lockRef);
      if (snap.data()?.token === lease) tx.delete(lockRef);
    });
  }
}

export async function sweepPrGates(deps: PrGateDeps,
  enqueue: (task: GitHubTask) => Promise<void> = enqueueGitHubTask): Promise<{ checked: number }> {
  let checked = 0;
  for (const repo of Object.keys(PR_GATE_REPOSITORIES) as PrGateRepository[]) {
    for (let page = 1; ; page++) {
      const rows = await deps.api.call(repo, 'GET', `/pulls?state=open&per_page=100&page=${page}`);
      if (!Array.isArray(rows)) throw new Error('github_pulls_invalid');
      for (const row of rows) { const number = Number(objectOf(row).number); await syncPrGate(deps, repo, number);
        const saved = (await deps.db.collection(PR_GATES_COLLECTION).doc(prGateId(repo, number)).get()).data() as PrGateRow | undefined;
        if (saved?.pending) await enqueue({ kind: 'pr_gate', repo, number, burnId: saved.pending.burn_id });
        await mergeApprovedPr(deps, repo, number); checked++; }
      if (rows.length < 100) break;
    }
  }
  return { checked };
}

/** Record explicit owner approval only after this PR has already cleared. */
export async function approvePrMerge(deps: PrGateDeps, repo: PrGateRepository, number: number, reviewId: number,
  context: { head_sha: string; base_ref: string; base_sha: string }): Promise<boolean> {
  if (!Number.isSafeInteger(reviewId) || reviewId < 1) throw new PrGateError(400, 'invalid_review');
  const row = await readGitHubPr(deps, repo, number);
  if (isPrGateOwner(row)) return false;
  const review = objectOf(await deps.api.call(repo, 'GET', `/pulls/${number}/reviews/${reviewId}`));
  const at = typeof review.submitted_at === 'string' ? Date.parse(review.submitted_at) : NaN;
  if (row.state !== 'open' || row.head_sha !== context.head_sha || row.base_ref !== context.base_ref || row.base_sha !== context.base_sha || review.id !== reviewId || objectOf(review.user).id !== Number(PR_GATE_REPOSITORIES[repo].ownerId) ||
      review.state !== 'APPROVED' || review.commit_id !== row.head_sha || !Number.isFinite(at)) return false;
  const ref = deps.db.collection(PR_GATES_COLLECTION).doc(prGateId(repo, number));
  return deps.db.runTransaction(async (tx) => {
    const saved = (await tx.get(ref)).data() as PrGateRow | undefined;
    // Strict ordering refuses a pre-clearance review, including ambiguous same-second timestamps.
    if (!saved?.cleared || saved.author_id !== row.author_id || at <= saved.cleared.at) return false;
    tx.update(ref, { merge_approval: { review_id: reviewId, head_sha: row.head_sha, base_ref: context.base_ref, base_sha: context.base_sha, approved_at: at } });
    return true;
  });
}

/** A durable review intent may retry transient failures; clearance alone never creates one. */
export async function mergeApprovedPr(deps: PrGateDeps, repo: PrGateRepository, number: number): Promise<boolean> {
  const ref = deps.db.collection(PR_GATES_COLLECTION).doc(prGateId(repo, number));
  const saved = (await ref.get()).data() as PrGateRow | undefined;
  const approval = saved?.merge_approval;
  if (!saved?.cleared || !approval) return false;
  const row = await readGitHubPr(deps, repo, number);
  if (isPrGateOwner(row) || !await resolvePrAuthor(deps, row, saved.cleared.presenter_id)) return false;
  const allowedBranches: readonly string[] = PR_GATE_REPOSITORIES[repo].branches;
  if (row.state !== 'open' || row.author_id !== saved.author_id || row.head_sha !== approval.head_sha ||
      !row.base_ref || !allowedBranches.includes(row.base_ref) || row.base_ref !== approval.base_ref || row.base_sha !== approval.base_sha) return false;
  let latest: Record<string, unknown> | undefined;
  for (let page = 1; ; page++) {
    if (page > 20) throw new PrGateError(503, 'review_scan_limit');
    const reviews = await deps.api.call(repo, 'GET', `/pulls/${number}/reviews?per_page=100&page=${page}`);
    if (!Array.isArray(reviews)) throw new PrGateError(502, 'github_reviews_invalid');
    for (const value of reviews) {
      const review = objectOf(value);
      if (objectOf(review.user).id === Number(PR_GATE_REPOSITORIES[repo].ownerId) && review.state !== 'PENDING' &&
          Number.isSafeInteger(review.id) && (!latest || Number(review.id) > Number(latest.id))) latest = review;
    }
    if (reviews.length < 100) break;
  }
  if (latest?.id !== approval.review_id || latest.state !== 'APPROVED' || latest.commit_id !== row.head_sha ||
      typeof latest.submitted_at !== 'string' || Date.parse(latest.submitted_at) !== approval.approved_at ||
      approval.approved_at <= saved.cleared.at) return false;
  // Refresh this PR's commit-scoped display before merge. The separate branch
  // protections enforce current code-owner approval and checks atomically at GitHub.
  await syncPrGate(deps, repo, number);
  const fresh = (await ref.get()).data() as PrGateRow | undefined;
  if (!fresh?.cleared || fresh.author_id !== row.author_id || fresh.merge_approval?.review_id !== approval.review_id ||
      fresh.merge_approval.head_sha !== row.head_sha || fresh.head_sha !== row.head_sha ||
      fresh.base_ref !== approval.base_ref || fresh.base_sha !== approval.base_sha) return false;
  const last = await readGitHubPr(deps, repo, number);
  if (last.state !== 'open' || last.author_id !== row.author_id || last.head_sha !== row.head_sha ||
      last.base_ref !== approval.base_ref || last.base_sha !== approval.base_sha) return false;
  try {
    const result = objectOf(await deps.api.call(repo, 'PUT', `/pulls/${number}/merge`, { sha: row.head_sha, merge_method: 'merge' }));
    return result.merged === true;
  } catch (error) {
    if (error instanceof GitHubPrApiError && [403, 405, 409].includes(error.status)) return false;
    throw error;
  }
}
