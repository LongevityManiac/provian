/**
 * github-connect tests.
 *
 * Covers the pure helpers (state validation, URL builder) and the
 * pending CRUD + finalize logic. Mock Firestore is the same shape
 * used by the other tests in this directory.
 */

import {
  isValidState,
  buildInstallUrl,
  startPendingConnect,
  markPendingCompleted,
  pollAndFinalize,
  CONNECT_TTL_MS,
  STATE_HEX_LENGTH,
  type PendingConnectDocument,
} from './github-connect';
import { makeWitnessFakeDeps, type WitnessStagedAct } from './__test-helpers__/witness-fake-deps';
import { createServiceInstall, stampServiceInstallForgeAccount } from './service-installs';

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

const VALID_STATE = '0'.repeat(64);
const OTHER_VALID_STATE = 'a'.repeat(64);

// =============================================================================
// isValidState
// =============================================================================

describe('isValidState', () => {
  it('accepts 64 lowercase hex chars', () => {
    expect(isValidState('0'.repeat(64))).toBe(true);
    expect(isValidState('abcdef0123456789'.repeat(4))).toBe(true);
    expect(STATE_HEX_LENGTH).toBe(64);
  });

  it('rejects too-short strings', () => {
    expect(isValidState('a'.repeat(63))).toBe(false);
    expect(isValidState('a'.repeat(32))).toBe(false);
  });

  it('rejects too-long strings', () => {
    expect(isValidState('a'.repeat(65))).toBe(false);
  });

  it('rejects uppercase hex', () => {
    expect(isValidState('A'.repeat(64))).toBe(false);
  });

  it('rejects non-hex characters', () => {
    expect(isValidState('g'.repeat(64))).toBe(false);
    expect(isValidState(' '.repeat(64))).toBe(false);
    expect(isValidState('z' + 'a'.repeat(63))).toBe(false);
  });

  it('rejects non-string types', () => {
    expect(isValidState(undefined)).toBe(false);
    expect(isValidState(null)).toBe(false);
    expect(isValidState(123)).toBe(false);
    expect(isValidState({})).toBe(false);
  });
});

// =============================================================================
// buildInstallUrl
// =============================================================================

describe('buildInstallUrl', () => {
  it('builds a clean install URL with state in the query string', () => {
    const url = buildInstallUrl('provian-app', VALID_STATE);
    expect(url).toBe(`https://github.com/apps/provian-app/installations/new?state=${VALID_STATE}`);
  });

  it('encodeURIComponent-s the slug as defense in depth', () => {
    const url = buildInstallUrl('weird slug', VALID_STATE);
    expect(url).toContain('weird%20slug');
  });
});

// =============================================================================
// startPendingConnect
// =============================================================================

describe('startPendingConnect', () => {
  it('creates a pending doc with status=pending and 5-min TTL', async () => {
    const { deps, store } = makeFakeDeps();
    const before = Date.now();
    const result = await startPendingConnect(deps, VALID_STATE, 'user_1');
    const after = Date.now();
    expect(result).not.toBeNull();
    expect(result!.state).toBe(VALID_STATE);
    expect(result!.user_id).toBe('user_1');
    expect(result!.status).toBe('pending');
    expect(result!.installation_id).toBeNull();
    expect(result!.created_at).toBeGreaterThanOrEqual(before);
    expect(result!.created_at).toBeLessThanOrEqual(after);
    expect(result!.expires_at - result!.created_at).toBe(CONNECT_TTL_MS);

    const stored = store.get('github_connect_pending')!.get(VALID_STATE);
    expect(stored).toBeDefined();
  });

  it('throws on malformed state', async () => {
    const { deps } = makeFakeDeps();
    await expect(startPendingConnect(deps, 'not-hex', 'user_1')).rejects.toThrow(/invalid state/);
  });

  it('throws on empty user_id', async () => {
    const { deps } = makeFakeDeps();
    await expect(startPendingConnect(deps, VALID_STATE, '')).rejects.toThrow(/user_id is required/);
  });

  it('REJECTS a state-collision from a different user (returns null)', async () => {
    const { deps, store } = makeFakeDeps();
    await startPendingConnect(deps, VALID_STATE, 'user_1');
    const second = await startPendingConnect(deps, VALID_STATE, 'attacker');
    expect(second).toBeNull();
    // Original record is preserved
    const stored = store.get('github_connect_pending')!.get(VALID_STATE) as unknown as PendingConnectDocument;
    expect(stored.user_id).toBe('user_1');
  });

  it('allows the same user to re-call with the same state (resets the record)', async () => {
    const { deps } = makeFakeDeps();
    const first = await startPendingConnect(deps, VALID_STATE, 'user_1');
    await new Promise((r) => setTimeout(r, 5));
    const second = await startPendingConnect(deps, VALID_STATE, 'user_1');
    expect(second).not.toBeNull();
    expect(second!.created_at).toBeGreaterThanOrEqual(first!.created_at);
  });
});

// =============================================================================
// markPendingCompleted (setup-callback path)
// =============================================================================

describe('markPendingCompleted', () => {
  it('marks pending → completed with the supplied installation_id', async () => {
    const { deps, store } = makeFakeDeps();
    await startPendingConnect(deps, VALID_STATE, 'user_1');
    const ok = await markPendingCompleted(deps, VALID_STATE, '42');
    expect(ok).toBe(true);
    const stored = store.get('github_connect_pending')!.get(VALID_STATE) as unknown as PendingConnectDocument;
    expect(stored.status).toBe('completed');
    expect(stored.installation_id).toBe('42');
  });

  it('returns false on unknown state (no leak to the HTML response)', async () => {
    const { deps } = makeFakeDeps();
    const ok = await markPendingCompleted(deps, VALID_STATE, '42');
    expect(ok).toBe(false);
  });

  it('returns false on malformed state', async () => {
    const { deps } = makeFakeDeps();
    const ok = await markPendingCompleted(deps, 'not-hex', '42');
    expect(ok).toBe(false);
  });

  it('returns false on empty installation_id', async () => {
    const { deps } = makeFakeDeps();
    await startPendingConnect(deps, VALID_STATE, 'user_1');
    const ok = await markPendingCompleted(deps, VALID_STATE, '');
    expect(ok).toBe(false);
  });

  it('REFUSES to overwrite an already-completed session', async () => {
    const { deps, store } = makeFakeDeps();
    await startPendingConnect(deps, VALID_STATE, 'user_1');
    await markPendingCompleted(deps, VALID_STATE, '42');
    const second = await markPendingCompleted(deps, VALID_STATE, '999');
    expect(second).toBe(false);
    const stored = store.get('github_connect_pending')!.get(VALID_STATE) as unknown as PendingConnectDocument;
    expect(stored.installation_id).toBe('42'); // original preserved
  });
});

// =============================================================================
// pollAndFinalize
// =============================================================================

describe('pollAndFinalize', () => {
  it('returns expired for unknown state', async () => {
    const { deps } = makeFakeDeps();
    const result = await pollAndFinalize(deps, VALID_STATE, 'user_1');
    expect(result.status).toBe('expired');
  });

  it('returns expired for malformed state', async () => {
    const { deps } = makeFakeDeps();
    const result = await pollAndFinalize(deps, 'not-hex', 'user_1');
    expect(result.status).toBe('expired');
  });

  it('returns pending while waiting for GitHub redirect', async () => {
    const { deps } = makeFakeDeps();
    await startPendingConnect(deps, VALID_STATE, 'user_1');
    const result = await pollAndFinalize(deps, VALID_STATE, 'user_1');
    expect(result.status).toBe('pending');
  });

  it('SECURITY: returns expired (NOT forbidden) for wrong user', async () => {
    const { deps } = makeFakeDeps();
    await startPendingConnect(deps, VALID_STATE, 'user_1');
    // Even after setup-callback completes, an attacker polling with a
    // different auth identity gets the same response as if state didn't
    // exist - no information leak about session existence.
    await markPendingCompleted(deps, VALID_STATE, '42');
    const result = await pollAndFinalize(deps, VALID_STATE, 'attacker');
    expect(result.status).toBe('expired');
  });

  it('on first poll after completion: creates install + emits PE + returns completed', async () => {
    const { deps, enqueued, store } = makeFakeDeps();
    await startPendingConnect(deps, VALID_STATE, 'user_1');
    await markPendingCompleted(deps, VALID_STATE, '42');
    const result = await pollAndFinalize(deps, VALID_STATE, 'user_1');
    expect(result.status).toBe('completed');
    expect(result.install_id).toBe('42');
    expect(result.pe_id).toBeDefined();

    // Install row written
    const install = store.get('service_installs')!.get('github_42') as Record<string, unknown>;
    expect(install.user_id).toBe('user_1');
    expect(install.installation_id).toBe('42');

    // PE emitted with the right action type
    expect(enqueued).toHaveLength(1);
    const pe = enqueued[0].pe;
    expect(pe.action_type).toBe('service_install_created');
    const metadata = pe.metadata as Record<string, unknown>;
    expect(metadata.provider).toBe('github');
    expect(metadata.installation_id).toBe('42');
  });

  it('idempotent: second poll returns the same install_id + pe_id, no duplicate PE', async () => {
    const { deps, enqueued, store } = makeFakeDeps();
    await startPendingConnect(deps, VALID_STATE, 'user_1');
    await markPendingCompleted(deps, VALID_STATE, '42');
    const first = await pollAndFinalize(deps, VALID_STATE, 'user_1');
    const tipsAfterFirst = JSON.stringify([...store.get('pe_chain_tips')!.entries()]);
    expect(tipsAfterFirst).not.toBe('[]'); // a real tip advanced (the comparison below is not over an empty population)
    const second = await pollAndFinalize(deps, VALID_STATE, 'user_1');
    expect(second.status).toBe('completed');
    expect(second.install_id).toBe(first.install_id);
    expect(second.pe_id).toBe(first.pe_id);
    // Exactly one staged act (the one the poll returned), and the chain tip did not move.
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].peId).toBe(first.pe_id);
    expect(JSON.stringify([...store.get('pe_chain_tips')!.entries()])).toBe(tipsAfterFirst);
  });

  it('returns expired when pending has expired with no completion', async () => {
    const { deps, store } = makeFakeDeps();
    await startPendingConnect(deps, VALID_STATE, 'user_1');
    // Hand-roll an expired record
    const expired = store.get('github_connect_pending')!.get(VALID_STATE) as Record<string, unknown>;
    expired.expires_at = Date.now() - 1;
    const result = await pollAndFinalize(deps, VALID_STATE, 'user_1');
    expect(result.status).toBe('expired');
  });

  it('isolates two different states for different users', async () => {
    const { deps } = makeFakeDeps();
    await startPendingConnect(deps, VALID_STATE, 'user_1');
    await startPendingConnect(deps, OTHER_VALID_STATE, 'user_2');
    await markPendingCompleted(deps, VALID_STATE, '42');
    const u1 = await pollAndFinalize(deps, VALID_STATE, 'user_1');
    const u2 = await pollAndFinalize(deps, OTHER_VALID_STATE, 'user_2');
    expect(u1.status).toBe('completed');
    expect(u2.status).toBe('pending'); // user_2 hasn't completed yet
  });
});

// =============================================================================
// Install hijack (2026-10-17)
// =============================================================================
//
// setup-callback is unauthenticated and takes `installation_id` from GitHub's
// redirect query string, so an attacker can complete THEIR OWN pending state
// with a VICTIM's installation id and then poll. The poll must not re-point the
// victim's install (webhook deliveries would mint the victim's commits to the
// attacker), must not wipe the stamped forge account, and must emit no PE.

describe('install hijack through setup-callback + poll (2026-10-17)', () => {
  it('a completed state naming another user\'s ACTIVE installation answers conflict and changes nothing', async () => {
    const { deps, store, enqueued } = makeFakeDeps();
    await createServiceInstall(deps.db, { user_id: 'wallet_victim', provider: 'github', installation_id: '999' });
    await stampServiceInstallForgeAccount(deps.db, 'github', '999', { id: '4242', login: 'victim' });

    await startPendingConnect(deps, VALID_STATE, 'wallet_attacker');
    expect(await markPendingCompleted(deps, VALID_STATE, '999')).toBe(true);
    const result = await pollAndFinalize(deps, VALID_STATE, 'wallet_attacker');

    expect(result.status).toBe('conflict');
    expect(result.install_id).toBeUndefined();
    const row = store.get('service_installs')!.get('github_999') as Record<string, unknown>;
    expect(row.user_id).toBe('wallet_victim');
    expect(row.revoked_at).toBeNull();
    expect(row.forge_account_id).toBe('4242');
    expect(row.forge_account_login).toBe('victim');
    expect(enqueued).toHaveLength(0);
  });

  it('the owner re-connecting their own installation still completes', async () => {
    const { deps, store } = makeFakeDeps();
    await createServiceInstall(deps.db, { user_id: 'wallet_owner', provider: 'github', installation_id: '999' });
    await stampServiceInstallForgeAccount(deps.db, 'github', '999', { id: '4242', login: 'owner' });
    await startPendingConnect(deps, VALID_STATE, 'wallet_owner');
    await markPendingCompleted(deps, VALID_STATE, '999');
    const result = await pollAndFinalize(deps, VALID_STATE, 'wallet_owner');
    expect(result.status).toBe('completed');
    const row = store.get('service_installs')!.get('github_999') as Record<string, unknown>;
    expect(row.user_id).toBe('wallet_owner');
    expect(row.forge_account_id).toBe('4242');
  });

  it('markPendingCompleted refuses a non-numeric installation id', async () => {
    const { deps } = makeFakeDeps();
    await startPendingConnect(deps, VALID_STATE, 'user_1');
    expect(await markPendingCompleted(deps, VALID_STATE, '../x')).toBe(false);
    expect(await markPendingCompleted(deps, VALID_STATE, '12a')).toBe(false);
    expect(await markPendingCompleted(deps, VALID_STATE, '42')).toBe(true);
  });
});
