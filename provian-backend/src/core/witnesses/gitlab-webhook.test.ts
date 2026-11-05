/**
 * gitlab-webhook handler tests. Mirrors github-webhook.test.ts: covers the
 * status-code matrix and the security invariants - verify-before-parse (a bad
 * X-Gitlab-Token returns 401 and never reaches the install lookup), constant-
 * time token compare, idempotency on retry, synthesize-or-drop, and the
 * cross-witness corroboration emission.
 */

import {
  handleGitLabWebhook,
  verifyGitLabToken,
  synthesizeFromGitLabPayload,
  checkAndMarkDelivery,
} from './gitlab-webhook';
import type { GitLabAppConfig } from './gitlab-app-config';
import { createServiceInstall, markServiceInstallRevoked } from './service-installs';
import { makeCorroborationTargetDocs, makeMeterActKeyDoc } from '../../__test-helpers__/pe-doc-fixtures';
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

const SECRET = 'gitlab-secret-token-at-least-32-characters-long';
const CONFIG_ENABLED: GitLabAppConfig = { enabled: true, webhookSecret: SECRET, baseUrl: null };
const CONFIG_DISABLED: GitLabAppConfig = { enabled: false, webhookSecret: null, baseUrl: null };

function makePushPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    object_kind: 'push',
    after: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    ref: 'refs/heads/main',
    project: { id: 100, path_with_namespace: 'group/project' },
    commits: [
      { id: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2', added: ['x.ts'], removed: [], modified: ['y.ts'] },
    ],
    total_commits_count: 1,
    ...overrides,
  };
}

function makeMRMergedPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    object_kind: 'merge_request',
    project: { id: 100, path_with_namespace: 'group/project' },
    object_attributes: {
      action: 'merge',
      merge_commit_sha: 'def456def456def456def456def456def456def4',
      iid: 7,
      target_branch: 'main',
      source_branch: 'feature',
    },
    ...overrides,
  };
}

// =============================================================================
// verifyGitLabToken
// =============================================================================

describe('verifyGitLabToken', () => {
  it('accepts the exact token', () => {
    expect(verifyGitLabToken(SECRET, SECRET)).toBe(true);
  });
  it('rejects a wrong token', () => {
    expect(verifyGitLabToken('wrong-token-but-also-32-characters-long!!', SECRET)).toBe(false);
  });
  it('rejects a missing token', () => {
    expect(verifyGitLabToken(undefined, SECRET)).toBe(false);
  });
  it('does not throw on length-mismatched token (false uniformly)', () => {
    expect(() => verifyGitLabToken('short', SECRET)).not.toThrow();
    expect(verifyGitLabToken('short', SECRET)).toBe(false);
  });
});

// =============================================================================
// synthesizeFromGitLabPayload
// =============================================================================

describe('synthesizeFromGitLabPayload', () => {
  it('synthesizes a Push Hook into service:gitlab_push', () => {
    const out = synthesizeFromGitLabPayload('Push Hook', makePushPayload());
    expect(out).not.toBeNull();
    expect(out!.actionType).toBe('service:gitlab_push');
    expect(out!.commitSha).toBe('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2');
    expect(out!.description).toContain('group/project/main');
    expect(out!.metadata.commit_sha).toBe('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2');
    expect(out!.metadata.project_id).toBe('100');
    expect(out!.metadata.branch).toBe('main');
  });

  it('synthesizes a merged Merge Request Hook into service:gitlab_mr_merged', () => {
    const out = synthesizeFromGitLabPayload('Merge Request Hook', makeMRMergedPayload());
    expect(out).not.toBeNull();
    expect(out!.actionType).toBe('service:gitlab_mr_merged');
    expect(out!.commitSha).toBe('def456def456def456def456def456def456def4');
    expect(out!.description).toContain('MR !7');
  });

  it('returns null for an unsupported event type', () => {
    expect(synthesizeFromGitLabPayload('Issue Hook', makePushPayload())).toBeNull();
  });

  it('returns null for an MR that is not a merge', () => {
    const out = synthesizeFromGitLabPayload(
      'Merge Request Hook',
      makeMRMergedPayload({ object_attributes: { action: 'open', iid: 7, target_branch: 'main' } }),
    );
    expect(out).toBeNull();
  });

  it('returns null for a branch-delete push (zero sha)', () => {
    const out = synthesizeFromGitLabPayload(
      'Push Hook',
      makePushPayload({ after: '0'.repeat(40), commits: [] }),
    );
    expect(out).toBeNull();
  });

  it('is deterministic', () => {
    const a = synthesizeFromGitLabPayload('Push Hook', makePushPayload());
    const b = synthesizeFromGitLabPayload('Push Hook', makePushPayload());
    expect(a!.description).toBe(b!.description);
  });
});

// =============================================================================
// checkAndMarkDelivery
// =============================================================================

describe('checkAndMarkDelivery (gitlab)', () => {
  it('returns false on first sight, true on retry', async () => {
    const { deps } = makeFakeDeps();
    const key = { userId: 'user_1', provider: 'gitlab' as const, deliveryId: 'uuid-1' };
    expect(await checkAndMarkDelivery(deps, key)).toBe(false);
    expect(await checkAndMarkDelivery(deps, key)).toBe(true);
  });
});

// =============================================================================
// handleGitLabWebhook - status matrix
// =============================================================================

describe('handleGitLabWebhook - status code matrix', () => {
  it('returns 503 when disabled (no PE, no DB writes)', async () => {
    const { deps, enqueued } = makeFakeDeps();
    const result = await handleGitLabWebhook(deps, {
      rawBody: JSON.stringify(makePushPayload()),
      tokenHeader: SECRET,
      eventType: 'Push Hook',
      deliveryId: 'uuid-1',
      config: CONFIG_DISABLED,
    });
    expect(result.status).toBe(503);
    expect(enqueued).toHaveLength(0);
  });

  it('returns 401 on wrong token BEFORE any DB lookup', async () => {
    const { deps, store, enqueued } = makeFakeDeps();
    const { doc: install100 } = await createServiceInstall(deps.db, { user_id: 'user_1', provider: 'gitlab', installation_id: '100' });
    const result = await handleGitLabWebhook(deps, {
      rawBody: JSON.stringify(makePushPayload()),
      tokenHeader: 'wrong-token-also-32-characters-long-abcdef',
      eventType: 'Push Hook',
      deliveryId: 'uuid-1',
      config: CONFIG_ENABLED,
    });
    expect(result.status).toBe(401);
    expect(enqueued).toHaveLength(0);
    expect(store.get('witness_webhook_deliveries')?.size ?? 0).toBe(0);
  });

  it('returns 404 when the project has no install row', async () => {
    const { deps, enqueued } = makeFakeDeps();
    const result = await handleGitLabWebhook(deps, {
      rawBody: JSON.stringify(makePushPayload({ project: { id: 999, path_with_namespace: 'x/y' } })),
      tokenHeader: SECRET,
      eventType: 'Push Hook',
      deliveryId: 'uuid-1',
      config: CONFIG_ENABLED,
    });
    expect(result.status).toBe(404);
    expect(enqueued).toHaveLength(0);
  });

  it('returns 410 when the install is revoked', async () => {
    const { deps } = makeFakeDeps();
    const { doc: install100 } = await createServiceInstall(deps.db, { user_id: 'user_1', provider: 'gitlab', installation_id: '100' });
    await markServiceInstallRevoked(deps.db, 'gitlab', '100');
    const result = await handleGitLabWebhook(deps, {
      rawBody: JSON.stringify(makePushPayload()),
      tokenHeader: install100.webhook_secret!,
      eventType: 'Push Hook',
      deliveryId: 'uuid-1',
      config: CONFIG_ENABLED,
    });
    expect(result.status).toBe(410);
  });

  it('submits a PE on a valid push and is idempotent on redelivery', async () => {
    const { deps, enqueued, store } = makeFakeDeps();
    const { doc: install100 } = await createServiceInstall(deps.db, { user_id: 'user_1', provider: 'gitlab', installation_id: '100' });
    const input = {
      rawBody: JSON.stringify(makePushPayload()),
      tokenHeader: install100.webhook_secret!,
      eventType: 'Push Hook',
      deliveryId: 'uuid-1',
      config: CONFIG_ENABLED,
    };
    const first = await handleGitLabWebhook(deps, input);
    expect(first.status).toBe(200);
    expect(first.body.pe_id).toBeDefined();
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].peId).toBe(first.body.pe_id);
    const tipsAfterFirst = JSON.stringify([...store.get('pe_chain_tips')!.entries()]);
    expect(tipsAfterFirst).not.toBe('[]'); // a real tip advanced (the comparison below is not over an empty population)
    // Redelivery with the same X-Gitlab-Event-UUID is a no-op.
    const second = await handleGitLabWebhook(deps, input);
    expect(second.status).toBe(200);
    expect(second.body.idempotent).toBe(true);
    // Exactly one staged act, and the chain tip did not move on redelivery.
    expect(enqueued).toHaveLength(1);
    expect(JSON.stringify([...store.get('pe_chain_tips')!.entries()])).toBe(tipsAfterFirst);
  });

  it('acknowledges 200 but emits no PE for an unsupported event', async () => {
    const { deps, enqueued } = makeFakeDeps();
    const { doc: install100 } = await createServiceInstall(deps.db, { user_id: 'user_1', provider: 'gitlab', installation_id: '100' });
    const result = await handleGitLabWebhook(deps, {
      rawBody: JSON.stringify(makePushPayload({ object_kind: 'issue' })),
      tokenHeader: install100.webhook_secret!,
      eventType: 'Issue Hook',
      deliveryId: 'uuid-1',
      config: CONFIG_ENABLED,
    });
    expect(result.status).toBe(200);
    expect(result.body.dropped).toBe(true);
    expect(enqueued).toHaveLength(0);
  });

  it('emits a cross-witness corroboration for a prior PE with the same commit (PRE-METER row)', async () => {
    const { deps, store } = makeFakeDeps();
    const { doc: install100 } = await createServiceInstall(deps.db, { user_id: 'user_1', provider: 'gitlab', installation_id: '100' });
    // A prior local observer PE already recorded this commit.
    const sha = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    // Prior PE in REAL production shapes (built via the shared fixture builder):
    // envelope carries hash + metadata.commit_sha; pe_history mirror carries
    // peHash (== hash), NO hash/metadata.
    const prior = makeCorroborationTargetDocs({
      peId: 'pe_prior_dev', userId: 'user_1', hash: 'priorhash', commitSha: sha,
    });
    if (!store.has('provenance_envelopes')) store.set('provenance_envelopes', new Map());
    store.get('provenance_envelopes')!.set('pe_prior_dev', prior.envelope);
    if (!store.has('pe_history')) store.set('pe_history', new Map());
    store.get('pe_history')!.set('pe_prior_dev', prior.history);
    const result = await handleGitLabWebhook(deps, {
      rawBody: JSON.stringify(makePushPayload()),
      tokenHeader: install100.webhook_secret!,
      eventType: 'Push Hook',
      deliveryId: 'uuid-1',
      config: CONFIG_ENABLED,
    });
    expect(result.status).toBe(200);
    // A corroboration_signal PE should have been enqueued targeting the prior PE.
    const corroboration = store.get('pe_history')!.get('pe_prior_dev');
    expect((corroboration as any).corroboration_status).toBe('service_grant_attested');
  });

  // PE METER: a prior act recorded after the meter landed has no envelope and no pe_history row —
  // its priced row lives on its 31-day act key, which is where the commit lookup finds it.
  it('emits a cross-witness corroboration for a prior METERED act with the same commit (act key)', async () => {
    const { deps, store } = makeFakeDeps();
    const { doc: install100 } = await createServiceInstall(deps.db, { user_id: 'user_1', provider: 'gitlab', installation_id: '100' });
    const sha = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    if (!store.has('meter_act_keys_v1')) store.set('meter_act_keys_v1', new Map());
    store.get('meter_act_keys_v1')!.set('pe_prior_dev', makeMeterActKeyDoc({
      peId: 'pe_prior_dev', actorId: 'user_1', peHash: 'priorhash', commitSha: sha,
    }));
    const result = await handleGitLabWebhook(deps, {
      rawBody: JSON.stringify(makePushPayload()),
      tokenHeader: install100.webhook_secret!,
      eventType: 'Push Hook',
      deliveryId: 'uuid-1',
      config: CONFIG_ENABLED,
    });
    expect(result.status).toBe(200);
    const prior = store.get('meter_act_keys_v1')!.get('pe_prior_dev') as { row: Record<string, unknown> };
    expect(prior.row.corroboration_status).toBe('service_grant_attested');
  });
});

describe('B2 per-install secrets — the invariants, each with its RED leg', () => {
  it('a delivery signed with the INSTALL OWN secret verifies; the app-wide secret is REFUSED for it', async () => {
    const { deps } = makeFakeDeps();
    const { doc: install } = await createServiceInstall(deps.db, {
      user_id: 'user_1', provider: 'gitlab', installation_id: '100',
    });
    const ok = await handleGitLabWebhook(deps, {
      rawBody: JSON.stringify(makePushPayload()),
      tokenHeader: install.webhook_secret!,
      eventType: 'Push Hook', deliveryId: 'uuid-own-1', config: CONFIG_ENABLED,
    });
    expect(ok.status).toBe(200);
    // RED: the app-wide secret must NOT verify a per-install-secret install —
    // per-install SUPERSEDES, it does not add a second accepted token.
    const appWide = await handleGitLabWebhook(deps, {
      rawBody: JSON.stringify(makePushPayload()),
      tokenHeader: SECRET,
      eventType: 'Push Hook', deliveryId: 'uuid-own-2', config: CONFIG_ENABLED,
    });
    expect(appWide.status).toBe(401);
  });

  it('[ RED] CROSS-INSTALL FORGERY: install A\'s secret cannot deliver for install B', async () => {
    const { deps } = makeFakeDeps();
    const { doc: installA } = await createServiceInstall(deps.db, {
      user_id: 'user_a', provider: 'gitlab', installation_id: '200',
    });
    await createServiceInstall(deps.db, {
      user_id: 'user_b', provider: 'gitlab', installation_id: '100',
    });
    // Payload targets project 100 (install B); token is install A's secret.
    const result = await handleGitLabWebhook(deps, {
      rawBody: JSON.stringify(makePushPayload()),
      tokenHeader: installA.webhook_secret!,
      eventType: 'Push Hook', deliveryId: 'uuid-forge-1', config: CONFIG_ENABLED,
    });
    expect(result.status).toBe(401);
  });

  it('LEGACY GRANDFATHER: a secret-less pre-B2 row verifies against the app-wide secret', async () => {
    const { deps } = makeFakeDeps();
    // Simulate a pre-B2 row: write the install shape directly, no webhook_secret.
    await deps.db.collection('service_installs').doc('gitlab_100').set({
      user_id: 'user_1', provider: 'gitlab', installation_id: '100',
      installed_at: Date.now(), revoked_at: null,
    });
    const ok = await handleGitLabWebhook(deps, {
      rawBody: JSON.stringify(makePushPayload()),
      tokenHeader: SECRET,
      eventType: 'Push Hook', deliveryId: 'uuid-legacy-1', config: CONFIG_ENABLED,
    });
    expect(ok.status).toBe(200);
    // RED: a random token still refuses for the legacy row.
    const bad = await handleGitLabWebhook(deps, {
      rawBody: JSON.stringify(makePushPayload()),
      tokenHeader: 'not-the-secret-not-the-secret-abcdef',
      eventType: 'Push Hook', deliveryId: 'uuid-legacy-2', config: CONFIG_ENABLED,
    });
    expect(bad.status).toBe(401);
  });

  it('ENUMERATION-SAFE: an unregistered project id answers 401 (not 404) without a valid secret', async () => {
    const { deps } = makeFakeDeps();
    const probe = await handleGitLabWebhook(deps, {
      rawBody: JSON.stringify(makePushPayload()),
      tokenHeader: 'guessing-token-guessing-token-abcdef',
      eventType: 'Push Hook', deliveryId: 'uuid-probe-1', config: CONFIG_ENABLED,
    });
    expect(probe.status).toBe(401);
    // The operator (app-wide secret) still gets the diagnostic 404.
    const operator = await handleGitLabWebhook(deps, {
      rawBody: JSON.stringify(makePushPayload()),
      tokenHeader: SECRET,
      eventType: 'Push Hook', deliveryId: 'uuid-probe-2', config: CONFIG_ENABLED,
    });
    expect(operator.status).toBe(404);
  });

  it('SECRET LIFECYCLE: re-POST preserves; revoke + re-register ROTATES', async () => {
    const { deps } = makeFakeDeps();
    const first = await createServiceInstall(deps.db, {
      user_id: 'user_1', provider: 'gitlab', installation_id: '100',
    });
    expect(first.secretIssued).toBe(true);
    const rePost = await createServiceInstall(deps.db, {
      user_id: 'user_1', provider: 'gitlab', installation_id: '100',
    });
    expect(rePost.secretIssued).toBe(false);
    expect(rePost.doc.webhook_secret).toBe(first.doc.webhook_secret);
    await markServiceInstallRevoked(deps.db, 'gitlab', '100');
    const rotated = await createServiceInstall(deps.db, {
      user_id: 'user_1', provider: 'gitlab', installation_id: '100',
    });
    expect(rotated.secretIssued).toBe(true);
    expect(rotated.doc.webhook_secret).not.toBe(first.doc.webhook_secret);
    // The OLD secret no longer verifies after rotation.
    const oldSecret = await handleGitLabWebhook(deps, {
      rawBody: JSON.stringify(makePushPayload()),
      tokenHeader: first.doc.webhook_secret!,
      eventType: 'Push Hook', deliveryId: 'uuid-rot-1', config: CONFIG_ENABLED,
    });
    expect(oldSecret.status).toBe(401);
    const newSecret = await handleGitLabWebhook(deps, {
      rawBody: JSON.stringify(makePushPayload()),
      tokenHeader: rotated.doc.webhook_secret!,
      eventType: 'Push Hook', deliveryId: 'uuid-rot-2', config: CONFIG_ENABLED,
    });
    expect(newSecret.status).toBe(200);
  });
});
