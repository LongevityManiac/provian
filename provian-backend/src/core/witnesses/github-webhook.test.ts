/**
 * github-webhook handler tests.
 *
 * Covers every status code path the handler can return and the security
 * invariants: verify-before-parse (a tampered signature returns 401 and
 * never reaches the install lookup), constant-time-style behavior
 * (handler doesn't throw on length-mismatched headers), and idempotency
 * on retry.
 */

import crypto from 'crypto';
import {
  handleGitHubWebhook,
  verifyGitHubSignature,
  synthesizeFromGitHubPayload,
  checkAndMarkDelivery,
  isExpectedNonEarningGitHubEvent,
  GITHUB_APP_PLUMBING_EVENTS,
} from './github-webhook';
import type { GitHubAppConfig } from './github-app-config';
import {
  createServiceInstall,
  getServiceInstallByInstallationId,
  markServiceInstallRevoked,
} from './service-installs';
import {
  createVerifiedAuthorMapping,
  mappingDocId,
  normalizeAuthorKey,
} from '../agent-attribution/author-mappings';
import { makeCorroborationTargetDocs, makeMeterActKeyDoc } from '../../__test-helpers__/pe-doc-fixtures';
import { makeWitnessFakeDeps, type WitnessStagedAct } from './__test-helpers__/witness-fake-deps';

// -----------------------------------------------------------------------------
// In-memory deps mock
// -----------------------------------------------------------------------------

// PE METER (2026-10-03): the shared forge-witness fake (see its header). `enqueued` lists the acts
// the relay STAGED in their chain-tip transaction (`meter_relay_acts_v1` intakes: identity + the
// PE's pricing projection) — the relay keeps no readable PE, and enqueueing one throws.
function makeFakeDeps(): {
  deps: any;
  store: Map<string, Map<string, Record<string, unknown>>>;
  enqueued: WitnessStagedAct[];
} {
  return makeWitnessFakeDeps();
}

function signPayload(body: string, secret: string): string {
  const mac = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return `sha256=${mac}`;
}

const CONFIG_ENABLED: GitHubAppConfig = {
  enabled: true,
  webhookSecret: 'a'.repeat(64),
  appSlug: null, // webhook tests don't use the connect-flow slug
};
const CONFIG_DISABLED: GitHubAppConfig = { enabled: false, webhookSecret: null, appSlug: null };

/** The stable GitHub account databaseId of the fixture repo owner — the
 *  forge-account scope mappings are keyed to (octokit payload-examples value
 *  for Codertocat/octocat-style fixtures). */
const OWNER_ACCOUNT_ID = '21031067';

// Seed the install owner's `wallets` doc so the WS4 owner-capture path resolves a
// canonical accrual identity (user_id + address); without it capture fails closed
// and the owner's own commit drops. Keyed to match resolveOwnerWalletIdentity:
// the `user_id` FIELD names the owner, and the doc id is `wallet_`-shaped.
function seedOwnerWallet(
  store: Map<string, Map<string, Record<string, unknown>>>,
  ownerId: string,
): void {
  if (!store.has('wallets')) store.set('wallets', new Map());
  const docId = ownerId.startsWith('wallet_') ? ownerId : `wallet_${ownerId}`;
  store.get('wallets')!.set(docId, {
    id: docId, type: 'human', user_id: ownerId, address: `0x${ownerId}`,
  });
}

function makePushPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    after: 'abc1234567890abc1234567890abc1234567890a',
    ref: 'refs/heads/main',
    // REAL delivery shape (verified against @octokit/webhooks-types 7.6.1 +
    // payload-examples): `repository.owner` carries { login, id, type };
    // `installation` is InstallationLite { id, node_id } with NO `account`
    // field. The previous fixture invented `installation.account` — a shape
    // GitHub never sends on event deliveries — which green-lit an
    // installation.account reader that had never fired in production (the
    // self-referential-control defect; every push 08-13..08-16 dropped
    // dropped_unmapped_author because of it).
    repository: {
      full_name: 'octocat/hello-world',
      owner: { login: 'octocat', id: 21031067, type: 'User' },
    },
    // Default fixture = the OWNER's own commit on their personal repo. The repo
    // owner is a User whose login ('octocat') matches the commit author, so owner
    // auto-capture binds octocat -> the install wallet and credits the owner. Tests
    // needing a foreign/unmapped author override head_commit + commits (see the
    // unmapped-author gate). There is NO install-owner fallback: the credit comes
    // from the captured owner mapping, not from owning the install.
    head_commit: {
      id: 'abc1234567890abc1234567890abc1234567890a',
      message: 'fix typo',
      author: { email: 'octocat@users.noreply.github.com', username: 'octocat' },
    },
    commits: [
      {
        id: 'abc1234567890abc1234567890abc1234567890a',
        added: ['x.ts'], removed: [], modified: ['y.ts'],
        author: { email: 'octocat@users.noreply.github.com', username: 'octocat' },
      },
    ],
    installation: { id: 42, node_id: 'MDIzOkludGVncmF0aW9uSW5zdGFsbGF0aW9u' },
    ...overrides,
  };
}

function makePRMergedPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'closed',
    pull_request: {
      number: 7,
      merged: true,
      merge_commit_sha: 'def456def456def456def456def456def456def4',
      additions: 100,
      deletions: 20,
      changed_files: 5,
      base: { ref: 'main' },
    },
    repository: {
      full_name: 'octocat/hello-world',
      owner: { login: 'octocat', id: 21031067, type: 'User' },
    },
    installation: { id: 42, node_id: 'MDIzOkludGVncmF0aW9uSW5zdGFsbGF0aW9u' },
    ...overrides,
  };
}

// =============================================================================
// verifyGitHubSignature - security primitive
// =============================================================================

describe('verifyGitHubSignature', () => {
  const secret = 'super-secret-webhook-key-at-least-32-chars';
  const body = JSON.stringify({ a: 1, b: 2 });
  const validHeader = signPayload(body, secret);

  it('accepts a correctly-signed body', () => {
    expect(verifyGitHubSignature(body, validHeader, secret)).toBe(true);
  });

  it('rejects a tampered body (same secret)', () => {
    expect(verifyGitHubSignature(body + 'tampered', validHeader, secret)).toBe(false);
  });

  it('rejects a tampered signature digest', () => {
    const tampered = 'sha256=' + 'f'.repeat(64);
    expect(verifyGitHubSignature(body, tampered, secret)).toBe(false);
  });

  it('rejects a missing signature header', () => {
    expect(verifyGitHubSignature(body, undefined, secret)).toBe(false);
  });

  it('rejects a header without the sha256= prefix', () => {
    const mac = crypto.createHmac('sha256', secret).update(body).digest('hex');
    expect(verifyGitHubSignature(body, mac, secret)).toBe(false);
  });

  it('rejects a header with non-hex digits', () => {
    expect(verifyGitHubSignature(body, 'sha256=zzznotvalidhex', secret)).toBe(false);
  });

  it('does not throw on length-mismatched digest (returns false uniformly)', () => {
    expect(() => verifyGitHubSignature(body, 'sha256=ab', secret)).not.toThrow();
    expect(verifyGitHubSignature(body, 'sha256=ab', secret)).toBe(false);
  });

  it('rejects a signature computed with a different secret', () => {
    const wrongSecretSig = signPayload(body, 'different-secret-' + 'x'.repeat(32));
    expect(verifyGitHubSignature(body, wrongSecretSig, secret)).toBe(false);
  });
});

// =============================================================================
// synthesizeFromGitHubPayload - synthesize-or-drop logic
// =============================================================================

describe('synthesizeFromGitHubPayload — generic forge events (Trust Layer §2.8)', () => {
  const base = { repository: { full_name: 'acme/widgets' }, sender: { login: 'alice', id: 42 } };
  it('an unmapped event becomes service:github_<event> with STRUCTURE-ONLY metadata and its own canonical id', () => {
    const s = synthesizeFromGitHubPayload('issues', {
      ...base, action: 'opened',
      issue: { node_id: 'I_kwDOABC123', number: 7, title: 'SECRET TITLE', body: 'SECRET BODY' },
    });
    expect(s).not.toBeNull();
    expect(s!.actionType).toBe('service:github_issues');
    expect(s!.commitSha).toBeNull();
    expect(s!.canonicalEventId).toBe('github:acme/widgets:issues:issue:I_kwDOABC123:opened');
    expect(s!.metadata).toEqual({
      event_type: 'issues', action: 'opened', repo: 'acme/widgets', sender_login: 'alice',
      subject: 'issue:I_kwDOABC123', synthesized_description: 'issues opened on acme/widgets',
    });
    expect(JSON.stringify(s)).not.toContain('SECRET'); // never a title/body
    expect(s!.input_origins?.map((o) => o.origin_identifier)).toEqual(['repo:acme/widgets']);
  });
  it('a release / workflow_run / a bare event with no subject still synthesizes (subject falls back to "event")', () => {
    expect(synthesizeFromGitHubPayload('release', { ...base, action: 'published', release: { id: 99 } })!.canonicalEventId)
      .toBe('github:acme/widgets:release:release:99:published');
    expect(synthesizeFromGitHubPayload('star', { ...base, action: 'created' })!.canonicalEventId)
      .toBe('github:acme/widgets:star:event:created');
  });
  it('RED — no repository, no sender, a ping, or a malformed event name → null (nothing to attribute)', () => {
    expect(synthesizeFromGitHubPayload('issues', { sender: { login: 'a' } })).toBeNull();
    expect(synthesizeFromGitHubPayload('issues', { repository: { full_name: 'x/y' } })).toBeNull();
    expect(synthesizeFromGitHubPayload('ping', base)).toBeNull();
    expect(synthesizeFromGitHubPayload('Issues Comment', base)).toBeNull();
  });
  it('RED — a commit-less push / an unmerged PR event is DROPPED, never re-labelled as a generic act', () => {
    expect(synthesizeFromGitHubPayload('push', base)).toBeNull();
    expect(synthesizeFromGitHubPayload('pull_request', { ...base, action: 'opened', pull_request: { node_id: 'PR_1', merged: false } })).toBeNull();
  });
});

describe("the App's own plumbing (check_suite / check_run / lifecycle) is never an act", () => {
  const checkSuite = {
    action: 'requested', repository: { full_name: 'acme/widgets' }, sender: { login: 'alice', id: 42 },
    check_suite: { id: 7001, node_id: 'CS_kwDOABC', head_sha: 'a'.repeat(40) },
    check_run: { id: 8001, node_id: 'CR_kwDOABC' },
  };
  it('the plumbing set names the check events and the lifecycle events', () => {
    expect([...GITHUB_APP_PLUMBING_EVENTS].sort()).toEqual(
      ['check_run', 'check_suite', 'installation', 'installation_repositories', 'ping']);
  });
  it('every plumbing event synthesizes to null and is logged as expected, never as an invalid earning event', () => {
    let evaluated = 0;
    for (const event of GITHUB_APP_PLUMBING_EVENTS) {
      expect(synthesizeFromGitHubPayload(event, checkSuite)).toBeNull();
      expect(isExpectedNonEarningGitHubEvent(event, checkSuite)).toBe(true);
      evaluated += 1;
    }
    expect(evaluated).toBe(5); // not a pass over an empty population
  });
  it('RED control — the SAME payload under a work event still synthesizes, so the null above is the plumbing guard', () => {
    const s = synthesizeFromGitHubPayload('issues', { ...checkSuite, issue: { node_id: 'I_1' } });
    expect(s?.actionType).toBe('service:github_issues');
    expect(isExpectedNonEarningGitHubEvent('issues', checkSuite)).toBe(false);
    // A check object never stands in as another event's subject.
    expect(synthesizeFromGitHubPayload('workflow_dispatch', checkSuite)!.metadata.subject).toBeNull();
  });
});

describe('synthesizeFromGitHubPayload', () => {
  it('synthesizes a push event into service:github_commit with structural metadata', () => {
    const out = synthesizeFromGitHubPayload('push', makePushPayload());
    expect(out).not.toBeNull();
    expect(out!.actionType).toBe('service:github_commit');
    expect(out!.commitSha).toBe('abc1234567890abc1234567890abc1234567890a');
    expect(out!.description).toContain('abc1234');
    expect(out!.description).toContain('octocat/hello-world/main');
    expect(out!.metadata.commit_sha).toBe('abc1234567890abc1234567890abc1234567890a');
    expect(out!.metadata.repo).toBe('octocat/hello-world');
    expect(out!.metadata.branch).toBe('main');
  });

  it('synthesizes a PR-merged event into service:github_pr_merged', () => {
    const out = synthesizeFromGitHubPayload('pull_request', makePRMergedPayload());
    expect(out).not.toBeNull();
    expect(out!.actionType).toBe('service:github_pr_merged');
    expect(out!.commitSha).toBe('def456def456def456def456def456def456def4');
    expect(out!.description).toContain('PR #7');
    expect(out!.description).toContain('100+/20-');
  });

  it('returns null for an unsupported event type', () => {
    const out = synthesizeFromGitHubPayload('star', { installation: { id: 1 } });
    expect(out).toBeNull();
  });

  it('returns null for a push payload missing required fields', () => {
    const out = synthesizeFromGitHubPayload('push', { installation: { id: 1 } });
    expect(out).toBeNull();
  });

  it('returns null for a PR event that is not a merge', () => {
    const out = synthesizeFromGitHubPayload(
      'pull_request',
      makePRMergedPayload({
        action: 'closed',
        pull_request: { ...(makePRMergedPayload().pull_request as object), merged: false },
      }),
    );
    expect(out).toBeNull();
  });

  it('is deterministic - same payload yields same description string', () => {
    const a = synthesizeFromGitHubPayload('push', makePushPayload());
    const b = synthesizeFromGitHubPayload('push', makePushPayload());
    expect(a!.description).toBe(b!.description);
  });
});

// =============================================================================
// checkAndMarkDelivery - dedup primitive
// =============================================================================

describe('checkAndMarkDelivery', () => {
  it('returns false on first sight, true on second', async () => {
    const { deps } = makeFakeDeps();
    const key = { userId: 'user_1', provider: 'github' as const, deliveryId: 'd1' };
    expect(await checkAndMarkDelivery(deps, key)).toBe(false);
    expect(await checkAndMarkDelivery(deps, key)).toBe(true);
    expect(await checkAndMarkDelivery(deps, key)).toBe(true);
  });

  it('treats different delivery ids as distinct', async () => {
    const { deps } = makeFakeDeps();
    const k1 = { userId: 'user_1', provider: 'github' as const, deliveryId: 'd1' };
    const k2 = { userId: 'user_1', provider: 'github' as const, deliveryId: 'd2' };
    expect(await checkAndMarkDelivery(deps, k1)).toBe(false);
    expect(await checkAndMarkDelivery(deps, k2)).toBe(false);
  });
});

// =============================================================================
// handleGitHubWebhook - full handler, every status path
// =============================================================================

describe('handleGitHubWebhook - check_suite / check_run deliveries', () => {
  const deliver = async (eventType: string) => {
    const { deps, enqueued, store } = makeFakeDeps();
    await createServiceInstall(deps.db, { user_id: 'user_1', provider: 'github', installation_id: '42' });
    seedOwnerWallet(store, 'user_1');
    const body = JSON.stringify({
      action: eventType === 'issues' ? 'opened' : 'requested',
      repository: { full_name: 'octocat/hello-world', owner: { login: 'octocat', id: 21031067, type: 'User' } },
      sender: { login: 'octocat', id: 21031067, type: 'User' },
      installation: { id: 42, node_id: 'MDIzOkludGVncmF0aW9uSW5zdGFsbGF0aW9u' },
      check_suite: { id: 7001, node_id: 'CS_kwDOABC', head_sha: 'a'.repeat(40) },
      check_run: { id: 8001, node_id: 'CR_kwDOABC' },
      issue: { node_id: 'I_kwDOABC' },
    });
    const result = await handleGitHubWebhook(deps, {
      rawBody: body, signatureHeader: signPayload(body, CONFIG_ENABLED.webhookSecret!),
      eventType, deliveryId: `d-${eventType}`, config: CONFIG_ENABLED,
    });
    return { result, enqueued, store };
  };
  it.each(['check_suite', 'check_run'])('%s is acknowledged with no act, no PE and no pending-policy queue row', async (eventType) => {
    const { result, enqueued, store } = await deliver(eventType);
    expect(result.status).toBe(200);
    expect(result.body.dropped).toBe(true);
    expect(enqueued).toHaveLength(0);
    expect(store.get('pe_chain_tips')?.size ?? 0).toBe(0);
    expect(store.get('pvt_pending_policy_queue')?.size ?? 0).toBe(0);
    expect(store.get('pvt_pending_policy_observations')?.size ?? 0).toBe(0);
  });
  it('RED control — the same delivery as a work event stages an act through the same path', async () => {
    const { result, enqueued } = await deliver('issues');
    expect(result.status).toBe(200);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].pe.action_type).toBe('service:github_issues');
  });
});

describe('handleGitHubWebhook - status code matrix', () => {
  it('returns 503 when config is disabled (no PE created, no DB writes)', async () => {
    const { deps, enqueued } = makeFakeDeps();
    const body = JSON.stringify(makePushPayload());
    const result = await handleGitHubWebhook(deps, {
      rawBody: body,
      signatureHeader: signPayload(body, CONFIG_ENABLED.webhookSecret!),
      eventType: 'push',
      deliveryId: 'd1',
      config: CONFIG_DISABLED,
    });
    expect(result.status).toBe(503);
    expect(enqueued).toHaveLength(0);
  });

  it('returns 401 on tampered signature BEFORE any DB lookup', async () => {
    const { deps, store, enqueued } = makeFakeDeps();
    // Install exists in the DB - if signature verification ordering were wrong,
    // a 404 would betray that the lookup happened.
    await createServiceInstall(deps.db, { user_id: 'user_1', provider: 'github', installation_id: '42' });

    const body = JSON.stringify(makePushPayload());
    const badSig = 'sha256=' + 'f'.repeat(64);
    const result = await handleGitHubWebhook(deps, {
      rawBody: body,
      signatureHeader: badSig,
      eventType: 'push',
      deliveryId: 'd1',
      config: CONFIG_ENABLED,
    });
    expect(result.status).toBe(401);
    expect(enqueued).toHaveLength(0);
    // The delivery dedup collection should NOT have been written -
    // signature verification rejected before any side effect.
    expect(store.get('witness_webhook_deliveries')?.size ?? 0).toBe(0);
  });

  it('returns 401 when signature header is missing', async () => {
    const { deps } = makeFakeDeps();
    await createServiceInstall(deps.db, { user_id: 'user_1', provider: 'github', installation_id: '42' });
    const body = JSON.stringify(makePushPayload());
    const result = await handleGitHubWebhook(deps, {
      rawBody: body,
      signatureHeader: undefined,
      eventType: 'push',
      deliveryId: 'd1',
      config: CONFIG_ENABLED,
    });
    expect(result.status).toBe(401);
  });

  it('returns 404 when installation_id has no install row', async () => {
    const { deps, enqueued } = makeFakeDeps();
    const body = JSON.stringify(makePushPayload({ installation: { id: 999 } }));
    const result = await handleGitHubWebhook(deps, {
      rawBody: body,
      signatureHeader: signPayload(body, CONFIG_ENABLED.webhookSecret!),
      eventType: 'push',
      deliveryId: 'd1',
      config: CONFIG_ENABLED,
    });
    expect(result.status).toBe(404);
    expect(enqueued).toHaveLength(0);
  });

  it('returns 410 when install is revoked', async () => {
    const { deps, enqueued } = makeFakeDeps();
    await createServiceInstall(deps.db, { user_id: 'user_1', provider: 'github', installation_id: '42' });
    await markServiceInstallRevoked(deps.db, 'github', '42');
    const body = JSON.stringify(makePushPayload());
    const result = await handleGitHubWebhook(deps, {
      rawBody: body,
      signatureHeader: signPayload(body, CONFIG_ENABLED.webhookSecret!),
      eventType: 'push',
      deliveryId: 'd1',
      config: CONFIG_ENABLED,
    });
    expect(result.status).toBe(410);
    expect(enqueued).toHaveLength(0);
  });

  it('returns 200 for a signature-verified ping (GitHub connectivity check: no PE, no install lookup)', async () => {
    const { deps, enqueued, store } = makeFakeDeps();
    // NO install row exists - a ping is app-level and must not require one.
    const body = JSON.stringify({ zen: 'Keep it logically awesome.', hook_id: 1, app_id: 123 });
    const result = await handleGitHubWebhook(deps, {
      rawBody: body,
      signatureHeader: signPayload(body, CONFIG_ENABLED.webhookSecret!),
      eventType: 'ping',
      deliveryId: 'ping-d1',
      config: CONFIG_ENABLED,
    });
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(enqueued).toHaveLength(0);
    // No install lookup, no dedup write - the ping short-circuits before both.
    expect(store.get('witness_webhook_deliveries')?.size ?? 0).toBe(0);
  });

  // NEGATIVE CONTROL (standing doctrine: a new assertion is not evidence until
  // its RED control is recorded). Were the ping ack placed BEFORE signature
  // verification - a blanket 200 on event=ping - the test above would still be
  // green. This control fixes that: a ping with a bad signature must be rejected
  // 401, proving the ack lives strictly behind the HMAC gate. Moving the step-4a
  // short-circuit above step 2 turns this test RED.
  it('returns 401 for a ping with an invalid signature (ack is behind the signature gate)', async () => {
    const { deps, enqueued } = makeFakeDeps();
    const body = JSON.stringify({ zen: 'Anything added dilutes everything else.', hook_id: 1 });
    const result = await handleGitHubWebhook(deps, {
      rawBody: body,
      signatureHeader: 'sha256=' + 'f'.repeat(64),
      eventType: 'ping',
      deliveryId: 'ping-bad',
      config: CONFIG_ENABLED,
    });
    expect(result.status).toBe(401);
    expect(enqueued).toHaveLength(0);
  });

  it('returns 400 when X-GitHub-Event header is missing', async () => {
    const { deps } = makeFakeDeps();
    await createServiceInstall(deps.db, { user_id: 'user_1', provider: 'github', installation_id: '42' });
    const body = JSON.stringify(makePushPayload());
    const result = await handleGitHubWebhook(deps, {
      rawBody: body,
      signatureHeader: signPayload(body, CONFIG_ENABLED.webhookSecret!),
      eventType: undefined,
      deliveryId: 'd1',
      config: CONFIG_ENABLED,
    });
    expect(result.status).toBe(400);
  });

  it('returns 400 when payload is invalid JSON', async () => {
    const { deps } = makeFakeDeps();
    const body = '{ not valid json';
    const result = await handleGitHubWebhook(deps, {
      rawBody: body,
      signatureHeader: signPayload(body, CONFIG_ENABLED.webhookSecret!),
      eventType: 'push',
      deliveryId: 'd1',
      config: CONFIG_ENABLED,
    });
    expect(result.status).toBe(400);
  });

  it('returns 200 idempotent on duplicate delivery (only one PE created)', async () => {
    const { deps, enqueued, store } = makeFakeDeps();
    await createServiceInstall(deps.db, { user_id: 'user_1', provider: 'github', installation_id: '42' });
    seedOwnerWallet(store, 'user_1');
    const body = JSON.stringify(makePushPayload());
    const sig = signPayload(body, CONFIG_ENABLED.webhookSecret!);

    const first = await handleGitHubWebhook(deps, {
      rawBody: body, signatureHeader: sig, eventType: 'push', deliveryId: 'd1', config: CONFIG_ENABLED,
    });
    const tipsAfterFirst = JSON.stringify([...store.get('pe_chain_tips')!.entries()]);
    expect(tipsAfterFirst).not.toBe('[]'); // a real tip advanced (the comparison below is not over an empty population)
    const second = await handleGitHubWebhook(deps, {
      rawBody: body, signatureHeader: sig, eventType: 'push', deliveryId: 'd1', config: CONFIG_ENABLED,
    });

    expect(first.status).toBe(200);
    expect(first.body.pe_id).toBeDefined();
    expect(second.status).toBe(200);
    expect(second.body.idempotent).toBe(true);
    // Exactly one staged act, and the chain tip did not move on redelivery.
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].peId).toBe(first.body.pe_id);
    expect(JSON.stringify([...store.get('pe_chain_tips')!.entries()])).toBe(tipsAfterFirst);
  });

  it('returns 200 no-op when payload is missing fields required for synthesis (no placeholder PE)', async () => {
    const { deps, enqueued } = makeFakeDeps();
    await createServiceInstall(deps.db, { user_id: 'user_1', provider: 'github', installation_id: '42' });
    // Payload has installation but no after/ref/repository - synthesizer returns null
    const insufficientBody = JSON.stringify({ installation: { id: 42 }, commits: [] });
    const result = await handleGitHubWebhook(deps, {
      rawBody: insufficientBody,
      signatureHeader: signPayload(insufficientBody, CONFIG_ENABLED.webhookSecret!),
      eventType: 'push',
      deliveryId: 'd1',
      config: CONFIG_ENABLED,
    });
    expect(result.status).toBe(200);
    expect(result.body.dropped).toBe(true);
    expect(enqueued).toHaveLength(0);
  });

  it('creates one software-tier PE on a valid push and stores commit_sha for corroboration', async () => {
    const { deps, enqueued, store } = makeFakeDeps();
    await createServiceInstall(deps.db, { user_id: 'user_1', provider: 'github', installation_id: '42' });
    seedOwnerWallet(store, 'user_1');
    const body = JSON.stringify(makePushPayload());
    const result = await handleGitHubWebhook(deps, {
      rawBody: body,
      signatureHeader: signPayload(body, CONFIG_ENABLED.webhookSecret!),
      eventType: 'push',
      deliveryId: 'd1',
      config: CONFIG_ENABLED,
    });
    expect(result.status).toBe(200);
    expect(enqueued).toHaveLength(1);
    const pe = enqueued[0].pe;
    expect(pe.action_type).toBe('service:github_commit');
    expect(pe.attestation_type).toBe('software');
    const metadata = pe.metadata as Record<string, unknown>;
    expect(metadata.commit_sha).toBe('abc1234567890abc1234567890abc1234567890a');
    expect(metadata.witness).toBe('github_webhook');
    expect(metadata.delivery_id).toBe('d1');
  });

  // Finding 11 (audit 2026-08-05): the HMAC-authenticated push is a trusted server verification,
  // so the PE now stamps metadata.verified (a SEPARATE necessary condition to mint — pe-utils
  //) and routes through the durable ordinary intake. Pre-fix it stamped neither and sealed
  // record_only (0 PVT permanently). RED: metadata.verified was absent before this change.
  it('stamps metadata.verified on the verified webhook witness (finding 11)', async () => {
    const { deps, enqueued, store } = makeFakeDeps();
    await createServiceInstall(deps.db, { user_id: 'user_1', provider: 'github', installation_id: '42' });
    seedOwnerWallet(store, 'user_1');
    const body = JSON.stringify(makePushPayload());
    const result = await handleGitHubWebhook(deps, {
      rawBody: body,
      signatureHeader: signPayload(body, CONFIG_ENABLED.webhookSecret!),
      eventType: 'push',
      deliveryId: 'd-verified',
      config: CONFIG_ENABLED,
    });
    expect(result.status).toBe(200);
    const metadata = enqueued[0].pe.metadata as Record<string, unknown>;
    expect(metadata.verified).toBe(true);
  });

  it('credits a verified author mapping to the agent wallet automatically', async () => {
    const { deps, enqueued } = makeFakeDeps();
    await createServiceInstall(deps.db, { user_id: 'user_1', provider: 'github', installation_id: '42' });
    // Seed at the SHARED doc-id derivation (mappingDocId digests the stable
    // forge-account scope) — binding to the module's single source instead of
    // re-declaring the keying rule here (self-referential control).
    const atlasKey = normalizeAuthorKey({ type: 'email', value: 'atlas@example.com' })!;
    const atlasMappingId = mappingDocId({
      provider: 'github', forgeAccountId: OWNER_ACCOUNT_ID, authorKey: atlasKey,
    });
    await deps.db.collection('agent_author_mappings').doc(atlasMappingId).set({
      mapping_id: atlasMappingId,
      provider: 'github',
      forge_account_id: OWNER_ACCOUNT_ID,
      forge_account_login: 'octocat',
      source_owner_wallet_id: 'user_1',
      agent_wallet_id: 'wallet_aw_atlas',
      agent_id: 'atlas',
      agent_address: '0xatlas',
      author_key_type: 'email',
      author_key: 'atlas@example.com',
      author_key_hash: 'hash_atlas',
      verified_by: 'agent_wallet_signature',
      status: 'active',
    });

    const payload = makePushPayload({
      head_commit: {
        id: 'abc1234567890abc1234567890abc1234567890a',
        message: 'fix typo',
        author: { email: 'Atlas@Example.com', username: 'Atlas' },
      },
      commits: [
        {
          id: 'abc1234567890abc1234567890abc1234567890a',
          added: ['x.ts'],
          removed: [],
          modified: ['y.ts'],
          author: { email: 'Atlas@Example.com', username: 'Atlas' },
        },
      ],
    });
    const body = JSON.stringify(payload);
    const result = await handleGitHubWebhook(deps, {
      rawBody: body,
      signatureHeader: signPayload(body, CONFIG_ENABLED.webhookSecret!),
      eventType: 'push',
      deliveryId: 'd1',
      config: CONFIG_ENABLED,
    });

    expect(result.status).toBe(200);
    expect(enqueued).toHaveLength(1);
    const pe = enqueued[0].pe;
    expect(pe.wallet_id).toBe('wallet_aw_atlas');
    expect(pe.agent_id).toBe('atlas');
    // The chain owner (the old envelope's user_id) is the intake's actor id.
    expect(pe.actor_id).toBe('atlas');
    expect(pe.actor_address).toBe('0xatlas');
    const metadata = pe.metadata as Record<string, unknown>;
    expect(metadata.attribution).toMatchObject({
      mode: 'verified_author_mapping',
      provider: 'github',
      source_owner_wallet_id: 'user_1',
      forge_account_id: OWNER_ACCOUNT_ID,
      agent_wallet_id: 'wallet_aw_atlas',
      agent_id: 'atlas',
      mapping_id: atlasMappingId,
      author_key_type: 'email',
      author_key_hash: 'hash_atlas',
      verified_by: 'agent_wallet_signature',
    });
  });

  it('drops (200 no-op, no PE) when the commit author has no mapping and is not the repo owner', async () => {
    const { deps, enqueued } = makeFakeDeps();
    await createServiceInstall(deps.db, { user_id: 'user_1', provider: 'github', installation_id: '42' });
    // A collaborator (NOT the account owner octocat) pushes a fully-synthesizable
    // commit, but their author identity has no mapping -> not attributable to anyone
    // we can name -> no PE (Unknown = Block). Owner auto-capture binds octocat, but
    // this commit is by 'stranger', so re-resolution still finds nothing.
    const payload = makePushPayload({
      head_commit: {
        id: 'abc1234567890abc1234567890abc1234567890a', message: 'drive-by',
        author: { email: 'stranger@example.com', username: 'stranger' },
      },
      commits: [{
        id: 'abc1234567890abc1234567890abc1234567890a',
        added: ['z.ts'], removed: [], modified: [],
        author: { email: 'stranger@example.com', username: 'stranger' },
      }],
    });
    const body = JSON.stringify(payload);
    const result = await handleGitHubWebhook(deps, {
      rawBody: body, signatureHeader: signPayload(body, CONFIG_ENABLED.webhookSecret!),
      eventType: 'push', deliveryId: 'd-stranger', config: CONFIG_ENABLED,
    });
    expect(result.status).toBe(200);
    expect(result.body.dropped).toBe(true);
    expect(result.body.reason).toBe('unmapped_author');
    expect(enqueued).toHaveLength(0);
  });

  // NEGATIVE CONTROL (standing doctrine): isolates the install-owner FALLBACK from
  // any other drop reason. Re-introducing `?? install.user_id` at the attribution
  // site turns this RED — the stranger's commit would then mint to the install
  // owner (user_1). A bare "enqueued.length === 0" does not prove the fallback is
  // gone; asserting no PE is credited to the install owner does.
  it('does NOT credit the install owner for an unmapped author\'s commit (no fallback)', async () => {
    const { deps, enqueued } = makeFakeDeps();
    await createServiceInstall(deps.db, { user_id: 'user_1', provider: 'github', installation_id: '42' });
    const payload = makePushPayload({
      head_commit: {
        id: 'abc1234567890abc1234567890abc1234567890a', message: 'drive-by',
        author: { email: 'stranger@example.com', username: 'stranger' },
      },
      commits: [{
        id: 'abc1234567890abc1234567890abc1234567890a',
        added: ['z.ts'], removed: [], modified: [],
        author: { email: 'stranger@example.com', username: 'stranger' },
      }],
    });
    const body = JSON.stringify(payload);
    await handleGitHubWebhook(deps, {
      rawBody: body, signatureHeader: signPayload(body, CONFIG_ENABLED.webhookSecret!),
      eventType: 'push', deliveryId: 'd-stranger-2', config: CONFIG_ENABLED,
    });
    const creditedToOwner = enqueued.some(
      (e) => e.pe.wallet_id === 'user_1' || e.pe.user_id === 'user_1',
    );
    expect(creditedToOwner).toBe(false);
  });

  it('auto-captures the repo owner (User install) so their own commit credits them with no prior mapping', async () => {
    const { deps, enqueued, store } = makeFakeDeps();
    await createServiceInstall(deps.db, { user_id: 'user_1', provider: 'github', installation_id: '42' });
    seedOwnerWallet(store, 'user_1');
    // No pre-seeded mapping. Default fixture = octocat's own commit on octocat's
    // personal repo -> owner auto-capture binds octocat -> user_1 and credits them.
    // Removing the capture step turns this RED (the owner's own push would drop).
    const body = JSON.stringify(makePushPayload());
    const result = await handleGitHubWebhook(deps, {
      rawBody: body, signatureHeader: signPayload(body, CONFIG_ENABLED.webhookSecret!),
      eventType: 'push', deliveryId: 'd-owner', config: CONFIG_ENABLED,
    });
    expect(result.status).toBe(200);
    expect(result.body.dropped).toBeUndefined();
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].pe.wallet_id).toBe('user_1');
    const attribution = (enqueued[0].pe.metadata as Record<string, unknown>).attribution as Record<string, unknown>;
    expect(attribution.mode).toBe('verified_author_mapping');
    expect(attribution.verified_by).toBe('repo_owner_capture');
    // The owner mapping is now persisted, active, bound to the install wallet,
    // and scoped to the STABLE forge account (not the ephemeral wallet).
    const mappings = [...(store.get('agent_author_mappings')?.values() ?? [])];
    const owner = mappings.find((m) => m.author_key === 'octocat');
    expect(owner).toBeDefined();
    expect(owner?.status).toBe('active');
    expect(owner?.verified_by).toBe('repo_owner_capture');
    expect(owner?.agent_wallet_id).toBe('user_1');
    expect(owner?.forge_account_id).toBe(OWNER_ACCOUNT_ID);
  });

  // THE PRODUCTION DEFECT AS A PERMANENT CONTROL (2026-08-16 audit item 2b).
  // Real GitHub App event deliveries carry InstallationLite { id, node_id }
  // with NO `account` — the default fixture above IS that shape — while the
  // owner's account rides on `repository.owner`. Pre-fix, capture read the
  // nonexistent `installation.account`, so this exact test failed with
  // { dropped: true, reason: 'unmapped_author' }: owner capture had NEVER
  // fired in production and every push 08-13..08-16 dropped, the operator’s included.
  it('owner capture works when installation carries NO account (real GitHub App delivery shape)', async () => {
    const { deps, enqueued, store } = makeFakeDeps();
    await createServiceInstall(deps.db, { user_id: 'user_1', provider: 'github', installation_id: '42' });
    seedOwnerWallet(store, 'user_1');
    const payload = makePushPayload();
    // Prove the fixture really is the real shape (guards against a fixture
    // regression re-arming the invented installation.account).
    expect((payload.installation as Record<string, unknown>).account).toBeUndefined();
    const body = JSON.stringify(payload);
    const result = await handleGitHubWebhook(deps, {
      rawBody: body, signatureHeader: signPayload(body, CONFIG_ENABLED.webhookSecret!),
      eventType: 'push', deliveryId: 'd-real-shape', config: CONFIG_ENABLED,
    });
    expect(result.status).toBe(200);
    expect(result.body.dropped).toBeUndefined();
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].pe.wallet_id).toBe('user_1');
  });

  // NEGATIVE CONTROL (guard-that-can-fail): capture reads repository.owner and
  // ONLY repository.owner. A payload carrying the legacy invented
  // installation.account but NO repository.owner must NOT capture — if someone
  // reintroduced the installation.account reader, this would go green for the
  // wrong reason on the test above and RED here.
  it('does NOT capture from installation.account when repository.owner is absent', async () => {
    const { deps, enqueued, store } = makeFakeDeps();
    await createServiceInstall(deps.db, { user_id: 'user_1', provider: 'github', installation_id: '42' });
    const payload = makePushPayload({
      repository: { full_name: 'octocat/hello-world' }, // no owner
      installation: { id: 42, account: { login: 'octocat', type: 'User' } },
    });
    const body = JSON.stringify(payload);
    const result = await handleGitHubWebhook(deps, {
      rawBody: body, signatureHeader: signPayload(body, CONFIG_ENABLED.webhookSecret!),
      eventType: 'push', deliveryId: 'd-no-repo-owner', config: CONFIG_ENABLED,
    });
    expect(result.status).toBe(200);
    expect(result.body.dropped).toBe(true);
    expect(result.body.reason).toBe('unmapped_author');
    expect(enqueued).toHaveLength(0);
    expect(store.get('agent_author_mappings')?.size ?? 0).toBe(0);
  });

  // Author-only attribution: pushing is not authoring. This is the control for the
  // residual double-mint (pusher's webhook PE + author's own daemon PE). Restoring
  // the pusher/sender lines to extractGitHubAuthorKeyCandidates turns this RED.
  it('does NOT credit the owner for a commit they merely PUSHED (author-only, not pusher/sender)', async () => {
    const { deps, enqueued, store } = makeFakeDeps();
    // The owner's wallets doc EXISTS, so step 8a's owner auto-capture would succeed and bind
    // octocat — this control is only RED-capable when the capture can fire.
    seedOwnerWallet(store, 'user_1');
    await createServiceInstall(deps.db, { user_id: 'user_1', provider: 'github', installation_id: '42' });
    // Owner octocat PUSHES a commit AUTHORED by an unregistered stranger (a merge /
    // integration): sender.login = octocat, but the git author is stranger. Earning
    // follows the git AUTHOR only, so octocat is NOT credited -> the commit drops.
    const payload = makePushPayload({
      head_commit: {
        id: 'abc1234567890abc1234567890abc1234567890a', message: 'merge stranger work',
        author: { email: 'stranger@example.com', username: 'stranger' },
      },
      commits: [{
        id: 'abc1234567890abc1234567890abc1234567890a', added: ['s.ts'], removed: [], modified: [],
        author: { email: 'stranger@example.com', username: 'stranger' },
      }],
      pusher: { name: 'octocat', email: 'octocat@users.noreply.github.com' },
      sender: { login: 'octocat' },
    });
    const body = JSON.stringify(payload);
    const result = await handleGitHubWebhook(deps, {
      rawBody: body, signatureHeader: signPayload(body, CONFIG_ENABLED.webhookSecret!),
      eventType: 'push', deliveryId: 'd-pushed-by-owner', config: CONFIG_ENABLED,
    });
    expect(result.status).toBe(200);
    expect(result.body.dropped).toBe(true);
    expect(result.body.reason).toBe('unmapped_author');
    expect(enqueued).toHaveLength(0);
    expect(enqueued.some((e) => e.pe.wallet_id === 'user_1')).toBe(false);
  });
});

// =============================================================================
// Re-install orphan proofing (2026-08-16 re-key) — mappings are scoped to the
// STABLE forge account (repository.owner.id), never the ephemeral wallet or
// installation_id. This suite reproduces the 08-13 production orphan mechanism
// (GitHub-side uninstall/reinstall mints a NEW installation_id AND the connect
// flow re-points user_id to a NEW wallet) and proves attribution survives it.
// =============================================================================

describe('handleGitHubWebhook - re-install never orphans author mappings', () => {
  const ATLAS_KEY = { type: 'email' as const, value: 'atlas@example.com' };

  function atlasPush(installationId: number): Record<string, unknown> {
    return makePushPayload({
      head_commit: {
        id: 'abc1234567890abc1234567890abc1234567890a', message: 'feat',
        author: { email: 'atlas@example.com', username: 'atlasbot' },
      },
      commits: [{
        id: 'abc1234567890abc1234567890abc1234567890a',
        added: ['a.ts'], removed: [], modified: [],
        author: { email: 'atlas@example.com', username: 'atlasbot' },
      }],
      installation: { id: installationId, node_id: 'MDIz' },
    });
  }

  async function seedExplicitAtlasMapping(deps: any, forgeAccountId: string): Promise<void> {
    await createVerifiedAuthorMapping(deps.db, {
      provider: 'github',
      forgeAccountId,
      forgeAccountLogin: 'octocat',
      sourceOwnerWalletId: 'wallet_A',
      agentWalletId: 'wallet_aw_atlas',
      agentId: 'atlas',
      agentAddress: '0xatlas',
      authorKey: normalizeAuthorKey(ATLAS_KEY)!,
    });
  }

  it('an explicit agent mapping still attributes after a reinstall (new installation_id) re-pointed to a NEW wallet', async () => {
    const { deps, enqueued } = makeFakeDeps();
    // Era 1: install 42 owned by wallet_A vouches Atlas's identity.
    await createServiceInstall(deps.db, { user_id: 'wallet_A', provider: 'github', installation_id: '42' });
    await seedExplicitAtlasMapping(deps, OWNER_ACCOUNT_ID);
    // Era 2: GitHub-side reinstall mints installation 777; connect flow binds
    // it to a NEW wallet (wallet_B). Same repository owner (same forge account).
    await createServiceInstall(deps.db, { user_id: 'wallet_B', provider: 'github', installation_id: '777' });

    const body = JSON.stringify(atlasPush(777));
    const result = await handleGitHubWebhook(deps, {
      rawBody: body, signatureHeader: signPayload(body, CONFIG_ENABLED.webhookSecret!),
      eventType: 'push', deliveryId: 'd-reinstall', config: CONFIG_ENABLED,
    });
    expect(result.status).toBe(200);
    expect(result.body.dropped).toBeUndefined();
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].pe.wallet_id).toBe('wallet_aw_atlas');
    const attribution = (enqueued[0].pe.metadata as Record<string, unknown>).attribution as Record<string, unknown>;
    expect(attribution.forge_account_id).toBe(OWNER_ACCOUNT_ID);
    // Provenance records the CURRENT install owner, while credit follows the mapping.
    expect(attribution.source_owner_wallet_id).toBe('wallet_B');
  });

  // RED CONTROL for the test above (guard-that-can-fail / scope containment):
  // the same push does NOT match a mapping registered under a DIFFERENT forge
  // account. This is what stops the re-key from widening into a global
  // registry — and it is exactly the pre-fix owner-scoped resolver's failure
  // shape, so restoring `.where('source_owner_wallet_id', ...)` semantics (or
  // ignoring the scope in the doc id) flips one of these two tests.
  it('does NOT match a mapping registered under a different forge account (scope containment)', async () => {
    const { deps, enqueued } = makeFakeDeps();
    await createServiceInstall(deps.db, { user_id: 'wallet_B', provider: 'github', installation_id: '777' });
    await seedExplicitAtlasMapping(deps, '999999'); // some OTHER GitHub account's repos

    const body = JSON.stringify(atlasPush(777));
    const result = await handleGitHubWebhook(deps, {
      rawBody: body, signatureHeader: signPayload(body, CONFIG_ENABLED.webhookSecret!),
      eventType: 'push', deliveryId: 'd-wrong-scope', config: CONFIG_ENABLED,
    });
    expect(result.status).toBe(200);
    expect(result.body.dropped).toBe(true);
    expect(result.body.reason).toBe('unmapped_author');
    expect(enqueued).toHaveLength(0);
  });

  it('rebinds a repo_owner_capture mapping to the CURRENT install owner after a re-point (owner identity follows the install)', async () => {
    const { deps, enqueued, store } = makeFakeDeps();
    // Era 1: capture binds octocat -> wallet_A.
    await createServiceInstall(deps.db, { user_id: 'wallet_A', provider: 'github', installation_id: '42' });
    seedOwnerWallet(store, 'wallet_A');
    const body1 = JSON.stringify(makePushPayload());
    await handleGitHubWebhook(deps, {
      rawBody: body1, signatureHeader: signPayload(body1, CONFIG_ENABLED.webhookSecret!),
      eventType: 'push', deliveryId: 'd-era1', config: CONFIG_ENABLED,
    });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].pe.wallet_id).toBe('wallet_A');

    // Era 2: reinstall (new installation_id) bound to wallet_B (the 08-13 shape).
    await createServiceInstall(deps.db, { user_id: 'wallet_B', provider: 'github', installation_id: '777' });
    seedOwnerWallet(store, 'wallet_B');
    const body2 = JSON.stringify(makePushPayload({ installation: { id: 777, node_id: 'MDIz' } }));
    const result = await handleGitHubWebhook(deps, {
      rawBody: body2, signatureHeader: signPayload(body2, CONFIG_ENABLED.webhookSecret!),
      eventType: 'push', deliveryId: 'd-era2', config: CONFIG_ENABLED,
    });
    expect(result.status).toBe(200);
    expect(result.body.dropped).toBeUndefined();
    // Same commit sha in both eras, so era 2 also (correctly) emits a
    // cross-witness corroboration_signal PE against the era-1 PE — count only
    // the commit PEs here.
    const commitPEs = enqueued.filter((e) => e.pe.action_type === 'service:github_commit');
    expect(commitPEs).toHaveLength(2);
    expect(commitPEs[1].pe.wallet_id).toBe('wallet_B');

    // ONE mapping doc (same forge-scoped id), now rebound to wallet_B.
    const mappings = [...(store.get('agent_author_mappings')?.values() ?? [])];
    expect(mappings).toHaveLength(1);
    expect(mappings[0].verified_by).toBe('repo_owner_capture');
    expect(mappings[0].agent_wallet_id).toBe('wallet_B');
    expect(mappings[0].source_owner_wallet_id).toBe('wallet_B');
    expect(mappings[0].status).toBe('active');
  });

  // NEGATIVE CONTROL (explicit outranks capture, and rebind must not touch it):
  // an agent_wallet_signature mapping for the owner's own identity is NEVER
  // rebound by a re-point — attribution keeps following the signed mapping and
  // the doc stays byte-unchanged.
  it('does NOT rebind an explicit agent_wallet_signature mapping on re-point', async () => {
    const { deps, enqueued, store } = makeFakeDeps();
    await createServiceInstall(deps.db, { user_id: 'wallet_A', provider: 'github', installation_id: '42' });
    // The owner's own identity (octocat) is EXPLICITLY routed to an agent wallet.
    await createVerifiedAuthorMapping(deps.db, {
      provider: 'github',
      forgeAccountId: OWNER_ACCOUNT_ID,
      forgeAccountLogin: 'octocat',
      sourceOwnerWalletId: 'wallet_A',
      agentWalletId: 'wallet_aw_atlas',
      agentId: 'atlas',
      agentAddress: '0xatlas',
      authorKey: normalizeAuthorKey({ type: 'username', value: 'octocat' })!,
    });
    const before = JSON.stringify(
      [...(store.get('agent_author_mappings')!.values())][0],
    );

    // Re-point to wallet_B, then the owner pushes their own commit.
    await createServiceInstall(deps.db, { user_id: 'wallet_B', provider: 'github', installation_id: '777' });
    const body = JSON.stringify(makePushPayload({ installation: { id: 777, node_id: 'MDIz' } }));
    const result = await handleGitHubWebhook(deps, {
      rawBody: body, signatureHeader: signPayload(body, CONFIG_ENABLED.webhookSecret!),
      eventType: 'push', deliveryId: 'd-explicit-hold', config: CONFIG_ENABLED,
    });
    expect(result.status).toBe(200);
    expect(enqueued).toHaveLength(1);
    // Credit follows the SIGNED mapping, not the new install owner.
    expect(enqueued[0].pe.wallet_id).toBe('wallet_aw_atlas');
    const after = JSON.stringify(
      [...(store.get('agent_author_mappings')!.values())][0],
    );
    expect(after).toBe(before); // byte-unchanged — not rebound
  });
});

// =============================================================================
// Forge-account stamp (step 5.5) — the install row learns which GitHub account
// it serves from the first HMAC-verified delivery.
// =============================================================================

describe('handleGitHubWebhook - forge-account stamp on the install row', () => {
  it('stamps forge_account_id + login from a verified delivery, idempotently', async () => {
    const { deps } = makeFakeDeps();
    await createServiceInstall(deps.db, { user_id: 'user_1', provider: 'github', installation_id: '42' });

    const body = JSON.stringify(makePushPayload());
    await handleGitHubWebhook(deps, {
      rawBody: body, signatureHeader: signPayload(body, CONFIG_ENABLED.webhookSecret!),
      eventType: 'push', deliveryId: 'd-stamp-1', config: CONFIG_ENABLED,
    });
    const afterFirst = await getServiceInstallByInstallationId(deps.db, 'github', '42');
    expect(afterFirst?.forge_account_id).toBe(OWNER_ACCOUNT_ID);
    expect(afterFirst?.forge_account_login).toBe('octocat');

    // Second delivery: values unchanged (idempotent re-stamp).
    await handleGitHubWebhook(deps, {
      rawBody: body, signatureHeader: signPayload(body, CONFIG_ENABLED.webhookSecret!),
      eventType: 'push', deliveryId: 'd-stamp-2', config: CONFIG_ENABLED,
    });
    const afterSecond = await getServiceInstallByInstallationId(deps.db, 'github', '42');
    expect(afterSecond?.forge_account_id).toBe(OWNER_ACCOUNT_ID);
    expect(afterSecond?.forge_account_login).toBe('octocat');
  });

  // NEGATIVE CONTROL (the stamp lives strictly behind the HMAC gate): a
  // delivery with a bad signature must leave the row untouched — otherwise a
  // forged payload could re-scope contributor registration. Moving the stamp
  // above step 2 turns this RED.
  it('a 401 delivery does NOT stamp the install row', async () => {
    const { deps } = makeFakeDeps();
    await createServiceInstall(deps.db, { user_id: 'user_1', provider: 'github', installation_id: '42' });
    const body = JSON.stringify(makePushPayload());
    const result = await handleGitHubWebhook(deps, {
      rawBody: body, signatureHeader: 'sha256=' + 'f'.repeat(64),
      eventType: 'push', deliveryId: 'd-stamp-bad', config: CONFIG_ENABLED,
    });
    expect(result.status).toBe(401);
    const install = await getServiceInstallByInstallationId(deps.db, 'github', '42');
    expect(install?.forge_account_id).toBeUndefined();
    expect(install?.forge_account_login).toBeUndefined();
  });
});

// =============================================================================
// Cross-witness corroboration - bidirectional
// =============================================================================

describe('handleGitHubWebhook - cross-witness corroboration via CorroborationManager', () => {
  // PE METER: a prior act recorded after the meter landed has no envelope and no pe_history row —
  // its priced row lives on its 31-day act key, which is where the commit lookup finds it.
  it('upgrades a prior METERED device-witness act for the same commit when the webhook arrives second (act key)', async () => {
    const { deps, store } = makeFakeDeps();
    await createServiceInstall(deps.db, { user_id: 'user_1', provider: 'github', installation_id: '42' });
    if (!store.has('meter_act_keys_v1')) store.set('meter_act_keys_v1', new Map());
    store.get('meter_act_keys_v1')!.set('pe_prior_device', makeMeterActKeyDoc({
      peId: 'pe_prior_device',
      actorId: 'user_1',
      peHash: 'priorhash',
      commitSha: 'abc1234567890abc1234567890abc1234567890a',
    }));

    const body = JSON.stringify(makePushPayload());
    const result = await handleGitHubWebhook(deps, {
      rawBody: body,
      signatureHeader: signPayload(body, CONFIG_ENABLED.webhookSecret!),
      eventType: 'push',
      deliveryId: 'd1',
      config: CONFIG_ENABLED,
    });
    expect(result.status).toBe(200);

    const upgraded = (store.get('meter_act_keys_v1')!.get('pe_prior_device') as { row: Record<string, unknown> }).row;
    expect(upgraded.corroboration_status).toBe('service_grant_attested');
    expect(upgraded.corroboration_source).toBe('d1');
  });

  it('upgrades a prior device-witness PE for the same commit when the webhook arrives second (PRE-METER row)', async () => {
    const { deps, store } = makeFakeDeps();
    await createServiceInstall(deps.db, { user_id: 'user_1', provider: 'github', installation_id: '42' });

    // Seed a prior device-witness PE for the same commit hash. The two docs use
    // their REAL production shapes: the envelope carries hash + metadata.commit_sha;
    // the pe_history mirror carries peHash (== hash), NO hash/metadata. (Built via
    // the shared fixture builder so the shapes can't silently drift.)
    const prior = makeCorroborationTargetDocs({
      peId: 'pe_prior_device',
      userId: 'user_1',
      hash: 'priorhash',
      commitSha: 'abc1234567890abc1234567890abc1234567890a',
    });
    if (!store.has('provenance_envelopes')) store.set('provenance_envelopes', new Map());
    store.get('provenance_envelopes')!.set('pe_prior_device', prior.envelope);
    if (!store.has('pe_history')) store.set('pe_history', new Map());
    store.get('pe_history')!.set('pe_prior_device', prior.history);

    const body = JSON.stringify(makePushPayload());
    const result = await handleGitHubWebhook(deps, {
      rawBody: body,
      signatureHeader: signPayload(body, CONFIG_ENABLED.webhookSecret!),
      eventType: 'push',
      deliveryId: 'd1',
      config: CONFIG_ENABLED,
    });
    expect(result.status).toBe(200);

    const upgraded = store.get('pe_history')!.get('pe_prior_device')!;
    // CorroborationManager writes `service_grant_attested` to corroboration_status
    expect(upgraded.corroboration_status).toBe('service_grant_attested');
    // And records the evidence reference
    expect(upgraded.corroboration_source).toBe('d1');
  });

  it('fires against PRODUCTION-shaped docs: pe_history has peHash (no hash/metadata), envelope has hash+commit_sha', async () => {
    // This is the regression for the prod bug: cross-witness corroboration read
    // commit_sha + hash from pe_history, but production pe_history (writePEHistory)
    // has NEITHER a `metadata` map NOR a top-level `hash` — only `peHash`. The
    // commit_sha + canonical hash live ONLY on the immutable provenance_envelopes
    // doc. This seeds the two collections in their REAL shapes and proves the
    // upgrade fires. (Pre-fix: findPEsByCommitSha queried pe_history.metadata →
    // [] → never fired.)
    const { deps, store } = makeFakeDeps();
    await createServiceInstall(deps.db, { user_id: 'user_1', provider: 'github', installation_id: '42' });

    const sha = 'abc1234567890abc1234567890abc1234567890a';
    // Immutable envelope: carries metadata.commit_sha AND the canonical `hash`.
    if (!store.has('provenance_envelopes')) store.set('provenance_envelopes', new Map());
    store.get('provenance_envelopes')!.set('pe_prod', {
      id: 'pe_prod',
      user_id: 'user_1',
      agent_id: 'user_1',
      hash: 'prodhash',
      action_type: 'coding_session',
      metadata: { commit_sha: sha },
    });
    // Derived pe_history (writePEHistory shape): peHash, userId — NO `hash`, NO `metadata`.
    if (!store.has('pe_history')) store.set('pe_history', new Map());
    store.get('pe_history')!.set('pe_prod', {
      peId: 'pe_prod',
      userId: 'user_1',
      peHash: 'prodhash',
      corroboration_status: 'none',
    });

    const body = JSON.stringify(makePushPayload());
    const result = await handleGitHubWebhook(deps, {
      rawBody: body,
      signatureHeader: signPayload(body, CONFIG_ENABLED.webhookSecret!),
      eventType: 'push',
      deliveryId: 'd9',
      config: CONFIG_ENABLED,
    });
    expect(result.status).toBe(200);

    const upgraded = store.get('pe_history')!.get('pe_prod')!;
    expect(upgraded.corroboration_status).toBe('service_grant_attested');
    expect(upgraded.corroboration_source).toBe('d9');
  });

  it('does not self-corroborate the PE it just created', async () => {
    const { deps, store, enqueued } = makeFakeDeps();
    await createServiceInstall(deps.db, { user_id: 'user_1', provider: 'github', installation_id: '42' });
    seedOwnerWallet(store, 'user_1');
    const body = JSON.stringify(makePushPayload());
    await handleGitHubWebhook(deps, {
      rawBody: body,
      signatureHeader: signPayload(body, CONFIG_ENABLED.webhookSecret!),
      eventType: 'push',
      deliveryId: 'd1',
      config: CONFIG_ENABLED,
    });
    // The just-created PE records normally ('none') but must NOT be upgraded by
    // its own emission (no self-corroboration). PE METER: its priced row lives on its act key,
    // which carries the same commit_sha — so the commit lookup DOES return it as a match and the
    // webhook's own-PE skip is what keeps it 'none'.
    const newPeId = enqueued[0].peId;
    const newKey = store.get('meter_act_keys_v1')!.get(newPeId) as { row: Record<string, unknown> } | undefined;
    expect(newKey?.row.commit_sha).toBe('abc1234567890abc1234567890abc1234567890a');
    const newPe = newKey?.row;
    expect(newPe?.corroboration_status).toBe('none');
    expect(newPe?.corroboration_status).not.toBe('service_grant_attested');
  });

  // F25 (S2 2026-09-10) RED control: a prior PE owned by a DIFFERENT wallet that
  // merely NAMES the same commit SHA must NOT be corroborated by this delivery.
  // Pre-fix, findPEsByCommitSha's matches were corroborated regardless of owner,
  // so any installer could lift a foreign wallet's PE by re-pushing its SHA.
  it('does NOT corroborate a foreign wallet\'s PE for the same commit (cross-wallet scope)', async () => {
    const { deps, store } = makeFakeDeps();
    await createServiceInstall(deps.db, { user_id: 'user_1', provider: 'github', installation_id: '42' });

    // The install belongs to user_1, but this prior PE is owned by user_2 (a
    // different wallet). The delivery attributes the commit to user_1, so user_2's
    // PE must stay uncorroborated.
    const foreign = makeCorroborationTargetDocs({
      peId: 'pe_foreign',
      userId: 'user_2',
      hash: 'foreignhash',
      commitSha: 'abc1234567890abc1234567890abc1234567890a',
    });
    if (!store.has('provenance_envelopes')) store.set('provenance_envelopes', new Map());
    store.get('provenance_envelopes')!.set('pe_foreign', foreign.envelope);
    if (!store.has('pe_history')) store.set('pe_history', new Map());
    store.get('pe_history')!.set('pe_foreign', foreign.history);

    const body = JSON.stringify(makePushPayload());
    await handleGitHubWebhook(deps, {
      rawBody: body,
      signatureHeader: signPayload(body, CONFIG_ENABLED.webhookSecret!),
      eventType: 'push',
      deliveryId: 'd_xwallet',
      config: CONFIG_ENABLED,
    });

    const untouched = store.get('pe_history')!.get('pe_foreign')!;
    expect(untouched.corroboration_status).toBe('none');
    expect(untouched.corroboration_status).not.toBe('service_grant_attested');
  });

  // F25 (S2 reviewer) POSITIVE control with DISTINCT namespaces — the gap the S2
  // review caught: the scope check must compare match.userId against the AGENT-ID,
  // not the wallets doc id. A prior device-witness PE owned by a MAPPED agent has
  // user_id = agent_id ('atlas'), which differs from the wallets doc id
  // ('wallet_aw_atlas'). Comparing the wallet doc id (the pre-review code) skipped
  // this match and silently dropped every mapped agent's own corroboration
  // (Sec. Invariant #8). The cross-wallet skip test above cannot catch this because
  // its fixture conflated userId==wallet_id==user_1 (a vacuous positive), so this is
  // the non-vacuous companion: same owner, wallet-id != agent-id, MUST corroborate.
  it('DOES corroborate a mapped agent\'s own prior PE when wallet-id != agent-id (same owner, distinct namespaces)', async () => {
    const { deps, store } = makeFakeDeps();
    await createServiceInstall(deps.db, { user_id: 'user_1', provider: 'github', installation_id: '42' });

    // Verified author mapping: agent_wallet_id 'wallet_aw_atlas' != agent_id 'atlas'.
    const atlasKey = normalizeAuthorKey({ type: 'email', value: 'atlas@example.com' })!;
    const atlasMappingId = mappingDocId({ provider: 'github', forgeAccountId: OWNER_ACCOUNT_ID, authorKey: atlasKey });
    await deps.db.collection('agent_author_mappings').doc(atlasMappingId).set({
      mapping_id: atlasMappingId, provider: 'github', forge_account_id: OWNER_ACCOUNT_ID,
      forge_account_login: 'octocat', source_owner_wallet_id: 'user_1',
      agent_wallet_id: 'wallet_aw_atlas', agent_id: 'atlas', agent_address: '0xatlas',
      author_key_type: 'email', author_key: 'atlas@example.com', author_key_hash: 'hash_atlas',
      verified_by: 'agent_wallet_signature', status: 'active',
    });

    // Atlas's OWN prior device-witness PE for the commit — user_id is the AGENT ID.
    const sha = 'abc1234567890abc1234567890abc1234567890a';
    const own = makeCorroborationTargetDocs({ peId: 'pe_atlas_device', userId: 'atlas', hash: 'atlashash', commitSha: sha });
    if (!store.has('provenance_envelopes')) store.set('provenance_envelopes', new Map());
    store.get('provenance_envelopes')!.set('pe_atlas_device', own.envelope);
    if (!store.has('pe_history')) store.set('pe_history', new Map());
    store.get('pe_history')!.set('pe_atlas_device', own.history);

    const payload = makePushPayload({
      head_commit: { id: sha, message: 'fix', author: { email: 'Atlas@Example.com', username: 'Atlas' } },
      commits: [{ id: sha, added: ['x.ts'], removed: [], modified: ['y.ts'], author: { email: 'Atlas@Example.com', username: 'Atlas' } }],
    });
    const body = JSON.stringify(payload);
    const result = await handleGitHubWebhook(deps, {
      rawBody: body, signatureHeader: signPayload(body, CONFIG_ENABLED.webhookSecret!),
      eventType: 'push', deliveryId: 'd_ownagent', config: CONFIG_ENABLED,
    });
    expect(result.status).toBe(200);

    const upgraded = store.get('pe_history')!.get('pe_atlas_device')!;
    // Post-fix (compare agent-id 'atlas' == match.userId): fires.
    // Pre-fix (compare wallet-doc-id 'wallet_aw_atlas' != 'atlas'): stayed 'none' (the bug).
    expect(upgraded.corroboration_status).toBe('service_grant_attested');
    expect(upgraded.corroboration_source).toBe('d_ownagent');
  });
});
