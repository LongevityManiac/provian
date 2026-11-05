/**
 * bitbucket-webhook handler tests. Mirrors gitlab-webhook.test.ts / the GitHub
 * suite: covers the status-code matrix and the security invariants -
 * verify-before-parse (a bad X-Hub-Signature returns 401 and never reaches the
 * install lookup), HMAC compare over the raw body, idempotency on retry,
 * synthesize-or-drop, and the cross-witness corroboration emission.
 */

import crypto from 'crypto';
import {
  handleBitbucketWebhook,
  verifyBitbucketSignature,
  synthesizeFromBitbucketPayload,
  checkAndMarkDelivery,
  normalizeRepoUuid,
} from './bitbucket-webhook';
import { makeCorroborationTargetDocs, makeMeterActKeyDoc } from '../../__test-helpers__/pe-doc-fixtures';
import type { BitbucketAppConfig } from './bitbucket-app-config';
import { createServiceInstall, markServiceInstallRevoked } from './service-installs';
import { makeWitnessFakeDeps, type WitnessStagedAct } from './__test-helpers__/witness-fake-deps';

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

const SECRET = 'bitbucket-webhook-secret-at-least-32-characters';
const CONFIG_ENABLED: BitbucketAppConfig = { enabled: true, webhookSecret: SECRET, baseUrl: null };
const CONFIG_DISABLED: BitbucketAppConfig = { enabled: false, webhookSecret: null, baseUrl: null };

const REPO_UUID_BRACED = '{9970a9b6-2d86-413f-8555-da8e1ac0e542}';
const REPO_UUID = normalizeRepoUuid(REPO_UUID_BRACED); // '9970a9b6-...'
const PUSH_SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
const MERGE_SHA = 'def456def456def456def456def456def456def4';

function sign(rawBody: string, secret: string = SECRET): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function makePushPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    push: {
      changes: [
        {
          new: { type: 'branch', name: 'main', target: { hash: PUSH_SHA } },
          old: { type: 'branch', name: 'main' },
          commits: [{ hash: PUSH_SHA, message: 'do the thing' }],
          closed: false,
        },
      ],
    },
    repository: { uuid: REPO_UUID_BRACED, full_name: 'workspace/repo' },
    ...overrides,
  };
}

function makePrMergedPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pullrequest: {
      id: 7,
      state: 'MERGED',
      merge_commit: { hash: MERGE_SHA },
      destination: { branch: { name: 'main' } },
    },
    repository: { uuid: REPO_UUID_BRACED, full_name: 'workspace/repo' },
    ...overrides,
  };
}

// =============================================================================
// verifyBitbucketSignature
// =============================================================================

describe('verifyBitbucketSignature', () => {
  it('accepts a correct HMAC signature over the raw body', () => {
    const raw = JSON.stringify(makePushPayload());
    expect(verifyBitbucketSignature(raw, sign(raw), SECRET)).toBe(true);
  });
  it('rejects a tampered body', () => {
    const raw = JSON.stringify(makePushPayload());
    const sig = sign(raw);
    expect(verifyBitbucketSignature(raw + ' ', sig, SECRET)).toBe(false);
  });
  it('rejects a missing or malformed header', () => {
    const raw = JSON.stringify(makePushPayload());
    expect(verifyBitbucketSignature(raw, undefined, SECRET)).toBe(false);
    expect(verifyBitbucketSignature(raw, 'sha1=deadbeef', SECRET)).toBe(false);
    expect(verifyBitbucketSignature(raw, 'sha256=nothex!!', SECRET)).toBe(false);
  });
  it('does not throw on a length-mismatched digest (false uniformly)', () => {
    const raw = JSON.stringify(makePushPayload());
    expect(() => verifyBitbucketSignature(raw, 'sha256=abcd', SECRET)).not.toThrow();
    expect(verifyBitbucketSignature(raw, 'sha256=abcd', SECRET)).toBe(false);
  });
});

// =============================================================================
// synthesizeFromBitbucketPayload
// =============================================================================

describe('synthesizeFromBitbucketPayload', () => {
  it('synthesizes repo:push into service:bitbucket_push', () => {
    const out = synthesizeFromBitbucketPayload('repo:push', makePushPayload());
    expect(out).not.toBeNull();
    expect(out!.actionType).toBe('service:bitbucket_push');
    expect(out!.commitSha).toBe(PUSH_SHA);
    expect(out!.description).toContain('workspace/repo/main');
    expect(out!.metadata.commit_sha).toBe(PUSH_SHA);
    expect(out!.metadata.repo_uuid).toBe(REPO_UUID);
    expect(out!.metadata.branch).toBe('main');
  });

  it('synthesizes pullrequest:fulfilled into service:bitbucket_pr_merged', () => {
    const out = synthesizeFromBitbucketPayload('pullrequest:fulfilled', makePrMergedPayload());
    expect(out).not.toBeNull();
    expect(out!.actionType).toBe('service:bitbucket_pr_merged');
    expect(out!.commitSha).toBe(MERGE_SHA);
    expect(out!.description).toContain('PR #7');
    expect(out!.metadata.pr_id).toBe(7);
  });

  it('returns null for an unsupported event key', () => {
    expect(synthesizeFromBitbucketPayload('issue:created', makePushPayload())).toBeNull();
  });

  it('returns null for a branch-delete push (closed change, no new)', () => {
    const out = synthesizeFromBitbucketPayload('repo:push', {
      push: { changes: [{ new: null, old: { type: 'branch', name: 'main' }, closed: true }] },
      repository: { uuid: REPO_UUID_BRACED, full_name: 'workspace/repo' },
    });
    expect(out).toBeNull();
  });

  it('returns null for a PR that is not merged', () => {
    const out = synthesizeFromBitbucketPayload(
      'pullrequest:fulfilled',
      makePrMergedPayload({
        pullrequest: { id: 7, state: 'OPEN', destination: { branch: { name: 'main' } } },
      }),
    );
    expect(out).toBeNull();
  });

  it('is deterministic', () => {
    const a = synthesizeFromBitbucketPayload('repo:push', makePushPayload());
    const b = synthesizeFromBitbucketPayload('repo:push', makePushPayload());
    expect(a!.description).toBe(b!.description);
  });
});

// =============================================================================
// checkAndMarkDelivery
// =============================================================================

describe('checkAndMarkDelivery (bitbucket)', () => {
  it('returns false on first sight, true on retry', async () => {
    const { deps } = makeFakeDeps();
    const key = { userId: 'user_1', provider: 'bitbucket' as const, deliveryId: 'req-uuid-1' };
    expect(await checkAndMarkDelivery(deps, key)).toBe(false);
    expect(await checkAndMarkDelivery(deps, key)).toBe(true);
  });
});

// =============================================================================
// handleBitbucketWebhook - status matrix
// =============================================================================

describe('handleBitbucketWebhook - status code matrix', () => {
  it('returns 503 when disabled (no PE, no DB writes)', async () => {
    const { deps, enqueued } = makeFakeDeps();
    const raw = JSON.stringify(makePushPayload());
    const result = await handleBitbucketWebhook(deps, {
      rawBody: raw,
      signatureHeader: sign(raw),
      eventKey: 'repo:push',
      deliveryId: 'req-uuid-1',
      config: CONFIG_DISABLED,
    });
    expect(result.status).toBe(503);
    expect(enqueued).toHaveLength(0);
  });

  it('returns 401 on a bad signature BEFORE any DB lookup', async () => {
    const { deps, store, enqueued } = makeFakeDeps();
    const { doc: installRepo } = await createServiceInstall(deps.db, { user_id: 'user_1', provider: 'bitbucket', installation_id: REPO_UUID });
    const raw = JSON.stringify(makePushPayload());
    const result = await handleBitbucketWebhook(deps, {
      rawBody: raw,
      signatureHeader: 'sha256=' + 'f'.repeat(64),
      eventKey: 'repo:push',
      deliveryId: 'req-uuid-1',
      config: CONFIG_ENABLED,
    });
    expect(result.status).toBe(401);
    expect(enqueued).toHaveLength(0);
    expect(store.get('witness_webhook_deliveries')?.size ?? 0).toBe(0);
  });

  it('returns 404 when the repo has no install row', async () => {
    const { deps, enqueued } = makeFakeDeps();
    const raw = JSON.stringify(makePushPayload());
    const result = await handleBitbucketWebhook(deps, {
      rawBody: raw,
      signatureHeader: sign(raw),
      eventKey: 'repo:push',
      deliveryId: 'req-uuid-1',
      config: CONFIG_ENABLED,
    });
    expect(result.status).toBe(404);
    expect(enqueued).toHaveLength(0);
  });

  it('returns 410 when the install is revoked', async () => {
    const { deps } = makeFakeDeps();
    const { doc: installRepo } = await createServiceInstall(deps.db, { user_id: 'user_1', provider: 'bitbucket', installation_id: REPO_UUID });
    await markServiceInstallRevoked(deps.db, 'bitbucket', REPO_UUID);
    const raw = JSON.stringify(makePushPayload());
    const result = await handleBitbucketWebhook(deps, {
      rawBody: raw,
      signatureHeader: sign(raw, installRepo.webhook_secret!),
      eventKey: 'repo:push',
      deliveryId: 'req-uuid-1',
      config: CONFIG_ENABLED,
    });
    expect(result.status).toBe(410);
  });

  it('submits a PE on a valid push and is idempotent on redelivery', async () => {
    const { deps, enqueued, store } = makeFakeDeps();
    const { doc: installRepo } = await createServiceInstall(deps.db, { user_id: 'user_1', provider: 'bitbucket', installation_id: REPO_UUID });
    const raw = JSON.stringify(makePushPayload());
    const input = {
      rawBody: raw,
      signatureHeader: sign(raw, installRepo.webhook_secret!),
      eventKey: 'repo:push',
      deliveryId: 'req-uuid-1',
      config: CONFIG_ENABLED,
    };
    const first = await handleBitbucketWebhook(deps, input);
    expect(first.status).toBe(200);
    expect(first.body.pe_id).toBeDefined();
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].peId).toBe(first.body.pe_id);
    const tipsAfterFirst = JSON.stringify([...store.get('pe_chain_tips')!.entries()]);
    expect(tipsAfterFirst).not.toBe('[]'); // a real tip advanced (the comparison below is not over an empty population)
    const second = await handleBitbucketWebhook(deps, input);
    expect(second.status).toBe(200);
    expect(second.body.idempotent).toBe(true);
    // Exactly one staged act, and the chain tip did not move on redelivery.
    expect(enqueued).toHaveLength(1);
    expect(JSON.stringify([...store.get('pe_chain_tips')!.entries()])).toBe(tipsAfterFirst);
  });

  it('acknowledges 200 but emits no PE for an unsupported event', async () => {
    const { deps, enqueued } = makeFakeDeps();
    const { doc: installRepo } = await createServiceInstall(deps.db, { user_id: 'user_1', provider: 'bitbucket', installation_id: REPO_UUID });
    const raw = JSON.stringify(makePushPayload());
    const result = await handleBitbucketWebhook(deps, {
      rawBody: raw,
      signatureHeader: sign(raw, installRepo.webhook_secret!),
      eventKey: 'issue:created',
      deliveryId: 'req-uuid-1',
      config: CONFIG_ENABLED,
    });
    expect(result.status).toBe(200);
    expect(result.body.dropped).toBe(true);
    expect(enqueued).toHaveLength(0);
  });

  it('emits a cross-witness corroboration for a prior PE with the same commit (PRE-METER row)', async () => {
    const { deps, store } = makeFakeDeps();
    const { doc: installRepo } = await createServiceInstall(deps.db, { user_id: 'user_1', provider: 'bitbucket', installation_id: REPO_UUID });
    // Prior PE in REAL production shapes (built via the shared fixture builder):
    // envelope carries hash + metadata.commit_sha; pe_history mirror carries
    // peHash (== hash), NO hash/metadata.
    const prior = makeCorroborationTargetDocs({
      peId: 'pe_prior_dev', userId: 'user_1', hash: 'priorhash', commitSha: PUSH_SHA,
    });
    if (!store.has('provenance_envelopes')) store.set('provenance_envelopes', new Map());
    store.get('provenance_envelopes')!.set('pe_prior_dev', prior.envelope);
    if (!store.has('pe_history')) store.set('pe_history', new Map());
    store.get('pe_history')!.set('pe_prior_dev', prior.history);
    const raw = JSON.stringify(makePushPayload());
    const result = await handleBitbucketWebhook(deps, {
      rawBody: raw,
      signatureHeader: sign(raw, installRepo.webhook_secret!),
      eventKey: 'repo:push',
      deliveryId: 'req-uuid-1',
      config: CONFIG_ENABLED,
    });
    expect(result.status).toBe(200);
    const corroboration = store.get('pe_history')!.get('pe_prior_dev');
    expect((corroboration as any).corroboration_status).toBe('service_grant_attested');
  });

  // PE METER: a prior act recorded after the meter landed has no envelope and no pe_history row —
  // its priced row lives on its 31-day act key, which is where the commit lookup finds it.
  it('emits a cross-witness corroboration for a prior METERED act with the same commit (act key)', async () => {
    const { deps, store } = makeFakeDeps();
    const { doc: installRepo } = await createServiceInstall(deps.db, { user_id: 'user_1', provider: 'bitbucket', installation_id: REPO_UUID });
    if (!store.has('meter_act_keys_v1')) store.set('meter_act_keys_v1', new Map());
    store.get('meter_act_keys_v1')!.set('pe_prior_dev', makeMeterActKeyDoc({
      peId: 'pe_prior_dev', actorId: 'user_1', peHash: 'priorhash', commitSha: PUSH_SHA,
    }));
    const raw = JSON.stringify(makePushPayload());
    const result = await handleBitbucketWebhook(deps, {
      rawBody: raw,
      signatureHeader: sign(raw, installRepo.webhook_secret!),
      eventKey: 'repo:push',
      deliveryId: 'req-uuid-1',
      config: CONFIG_ENABLED,
    });
    expect(result.status).toBe(200);
    const prior = store.get('meter_act_keys_v1')!.get('pe_prior_dev') as { row: Record<string, unknown> };
    expect(prior.row.corroboration_status).toBe('service_grant_attested');
  });
});

describe('B2 per-install secrets — bitbucket mirror controls', () => {
  it('[ RED] CROSS-INSTALL FORGERY: install A\'s secret cannot sign for install B; app-wide refused for per-install rows', async () => {
    const { deps } = makeFakeDeps();
    const { doc: installA } = await createServiceInstall(deps.db, {
      user_id: 'user_a', provider: 'bitbucket', installation_id: '{other-repo-uuid}',
    });
    const { doc: installB } = await createServiceInstall(deps.db, {
      user_id: 'user_b', provider: 'bitbucket', installation_id: REPO_UUID,
    });
    const raw = JSON.stringify(makePushPayload());
    // Forgery: signed with A's secret, targets B's repo.
    const forged = await handleBitbucketWebhook(deps, {
      rawBody: raw,
      signatureHeader: sign(raw, installA.webhook_secret!),
      eventKey: 'repo:push', deliveryId: 'req-forge-1', config: CONFIG_ENABLED,
    });
    expect(forged.status).toBe(401);
    // App-wide secret refused for a per-install row (supersedes, not adds).
    const appWide = await handleBitbucketWebhook(deps, {
      rawBody: raw,
      signatureHeader: sign(raw),
      eventKey: 'repo:push', deliveryId: 'req-forge-2', config: CONFIG_ENABLED,
    });
    expect(appWide.status).toBe(401);
    // The install's own secret verifies.
    const own = await handleBitbucketWebhook(deps, {
      rawBody: raw,
      signatureHeader: sign(raw, installB.webhook_secret!),
      eventKey: 'repo:push', deliveryId: 'req-forge-3', config: CONFIG_ENABLED,
    });
    expect(own.status).toBe(200);
  });

  it('ENUMERATION-SAFE: unregistered repo uuid answers 401 without the operator secret, 404 with it', async () => {
    const { deps } = makeFakeDeps();
    const raw = JSON.stringify(makePushPayload());
    const probe = await handleBitbucketWebhook(deps, {
      rawBody: raw,
      signatureHeader: 'sha256=' + 'a'.repeat(64),
      eventKey: 'repo:push', deliveryId: 'req-probe-1', config: CONFIG_ENABLED,
    });
    expect(probe.status).toBe(401);
    const operator = await handleBitbucketWebhook(deps, {
      rawBody: raw,
      signatureHeader: sign(raw),
      eventKey: 'repo:push', deliveryId: 'req-probe-2', config: CONFIG_ENABLED,
    });
    expect(operator.status).toBe(404);
  });
});
