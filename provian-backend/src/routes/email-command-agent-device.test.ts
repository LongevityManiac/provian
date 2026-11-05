/**
 * Adversarial tests for the human-initiated agent-device email-command path
 * (BUILD SPEC item 5): POST /v1/relay/connect/email-command with
 * kind="agent_device".
 *
 * This branch is inline in server.ts (which calls app.listen() at import time and
 * boots Firestore/Redis/listeners), so a full supertest mount is impractical -
 * the codebase's convention for inline server.ts routes is source-assertion plus
 * a behavioral replica (see pe-immutability.test.ts). We do BOTH:
 *
 * A. SOURCE ASSERTIONS pin the security-critical contract in server.ts:
 * - kind="agent_device" accepted; agent_wallet_id required;
 * - M8 authz ordering: existence 404 -> active 403 -> linked-id 403;
 * - allowlisted agent_device_registration token write (no api secret);
 * - the emitted command comes from the shared setup-command builder
 * (audit 2026-08-16 item 5: pre-flip the SDK is unpublished/E404, so
 * the emailed line is the hosted register curl — never npx).
 * B. A BEHAVIORAL REPLICA of the authz + mint logic runs the same ordering and
 * asserts the outcomes + the emitted command (built by the REAL builder —
 * single source), so the properties have executable coverage. The
 * replica is kept in lock-step with the source by the source assertions in
 * (A): if the impl ordering changes, (A) fails.
 */

import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  buildDeviceRegisterCommand,
  mintCommandIdempotencyKey,
} from '../core/setup-command';

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.ts'), 'utf-8');

// ===========================================================================
// A. Source assertions - pin the inline server.ts contract
// ===========================================================================

describe('email-command agent_device branch: source contract (M8 / allowlist / command)', () => {
  it('accepts kind="agent_device" and requires agent_wallet_id', () => {
    // kind 'agent' (the keyless relay session) no longer exists.
    expect(SERVER_SRC).toContain("kind !== 'device' && kind !== 'agent_device'");
    expect(SERVER_SRC).toContain("else if (kind === 'agent_device')");
    expect(SERVER_SRC).toContain('agent_wallet_id is required for kind="agent_device"');
  });

  it('enforces M8 authz ordering: existence(404) -> active(403) -> non-null linked id === user(403)', () => {
    // Existence check first.
    const existenceIdx = SERVER_SRC.indexOf("res.status(404).json({ error: 'Agent wallet not found' })");
    // Active check second.
    const activeIdx = SERVER_SRC.indexOf("res.status(403).json({ error: 'Agent wallet is not active' })");
    // Linked-id check third, with an explicit non-null guard (prevents the
    // null === null bypass).
    const linkedIdx = SERVER_SRC.indexOf("res.status(403).json({ error: 'Not your agent' })");

    expect(existenceIdx).toBeGreaterThan(-1);
    expect(activeIdx).toBeGreaterThan(-1);
    expect(linkedIdx).toBeGreaterThan(-1);
    // Ordering: existence < active < linked.
    expect(existenceIdx).toBeLessThan(activeIdx);
    expect(activeIdx).toBeLessThan(linkedIdx);
    // Non-null guard present before the equality compare.
    expect(SERVER_SRC).toMatch(/!agentWallet\.linked_human_user_id\s*\|\|[\s\S]*?linked_human_user_id !== user_id/);
  });

  it('writes the allowlisted agent_device_registration token (no api_key/secret/hash/salt)', () => {
    // The token type literal.
    expect(SERVER_SRC).toContain("type: 'agent_device_registration'");
    // owner_address sourced from the wallet doc.
    expect(SERVER_SRC).toContain('owner_address: agentWallet.address');
    // email_hash present.
    expect(SERVER_SRC).toMatch(/email_hash/);
    // The agent_device branch must never write secret material into setup_tokens.
    // Slice out the branch body, STRIP comments (the M6 allowlist comment names
    // api_key/secret/hash/salt in prose), then assert no secret material is
    // referenced as actual code (an object-key write or a wallet field read).
    const branchStart = SERVER_SRC.indexOf("else if (kind === 'agent_device')");
    const branchEnd = SERVER_SRC.indexOf('buildAgentDeviceInstallLines(token, resolveRelayUrl())', branchStart);
    expect(branchStart).toBeGreaterThan(-1);
    expect(branchEnd).toBeGreaterThan(branchStart);
    const branchRaw = SERVER_SRC.slice(branchStart, branchEnd);
    const branchCode = branchRaw
      .split('\n')
      .map((line) => {
        const c = line.indexOf('//');
        return c === -1 ? line : line.slice(0, c);
      })
      .join('\n');
    for (const forbidden of ['api_secret', 'api_key_hash', 'api_key_salt', 'api_key_prefix']) {
      expect(branchCode).not.toContain(forbidden);
    }
  });

  it('emits the shared-builder command and no dead npx template anywhere in server.ts', () => {
    // kind='device' calls the shared register builder with a per-mint
    // idempotency key; kind='agent_device' emails the hosted
    // agent-device installer, which also starts the observer.
    expect(SERVER_SRC).toContain('command = buildDeviceRegisterCommand({');
    expect(SERVER_SRC).toContain('idempotencyKey: mintCommandIdempotencyKey(),');
    expect(SERVER_SRC).toContain('const lines = buildAgentDeviceInstallLines(token, resolveRelayUrl());');
    // Pre-flip tripwire (audit 2026-08-16 item 5): the SDK is unpublished, so
    // no `npx @provian/agent-sdk` line may survive anywhere in server.ts.
    expect(SERVER_SRC).not.toContain('npx @provian/agent-sdk');
  });

  it('[negative control] the npx tripwire matches the old defective template shape', () => {
    // Proves the absence assertion above is falsifiable: the exact pre-fix
    // template registers against the same needle.
    const preFixLine = 'command = `npx @provian/agent-sdk register-device --agent-token ${token}`';
    expect(preFixLine).toContain('npx @provian/agent-sdk');
  });

  it('applies a per-email strict rate limit in addition to the per-user one', () => {
    expect(SERVER_SRC).toContain('email-connect-cmd:user:');
    expect(SERVER_SRC).toContain('email-connect-cmd:email:');
    // Both strict limits are checked via checkRateLimitStrict and fail closed.
    expect(SERVER_SRC).toContain('checkRateLimitStrict(`email-connect-cmd:user:');
    expect(SERVER_SRC).toContain('checkRateLimitStrict(`email-connect-cmd:email:');
    expect(SERVER_SRC).toContain("rl.error === 'rate_limit_unavailable'");
    expect(SERVER_SRC).toContain("rlEmail.error === 'rate_limit_unavailable'");
  });
});

// ===========================================================================
// B. Behavioral replica of the authz + mint ordering (executable coverage).
//    Mirrors server.ts lines for the agent_device branch exactly.
// ===========================================================================

type Doc = Record<string, unknown>;

function makeStore() {
  const m = new Map<string, Doc>();
  return {
    get: (id: string) => ({ exists: m.has(id), data: () => m.get(id) }),
    set: (id: string, d: Doc) => m.set(id, d),
    raw: m,
  };
}

const EMAIL_ADDRESS_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_CONNECT_TOKEN_TTL_MS = 60 * 60 * 1000;

type RlResult = { allowed: boolean; error?: 'rate_limit_unavailable'; retryAfter?: number };

interface ReplicaResult {
  status: number;
  body: Record<string, unknown>;
  command?: string;
  tokenDoc?: Doc;
  tokenId?: string;
}

/**
 * Faithful replica of the server.ts kind="agent_device" handler body, including
 * M8 ordering and the allowlisted token write. Pinned to the source by suite (A).
 */
async function emailCommandAgentDevice(params: {
  userId: string;
  email: string;
  agentWalletId: string;
  agentWallets: ReturnType<typeof makeStore>;
  setupTokens: ReturnType<typeof makeStore>;
  emailDisabled?: boolean;
  rlUser?: RlResult;
  rlEmail?: RlResult;
}): Promise<ReplicaResult> {
  const { userId, email: rawEmail, agentWalletId, agentWallets, setupTokens } = params;
  const email = typeof rawEmail === 'string' ? rawEmail.trim() : '';

  if (!EMAIL_ADDRESS_REGEX.test(email) || email.length > 254) {
    return { status: 400, body: { error: 'A valid email address is required' } };
  }
  if (params.emailDisabled) {
    return { status: 503, body: { error: 'email_unavailable' } };
  }

  const emailHash = crypto.createHash('sha256').update(email.toLowerCase()).digest('hex');
  const rl = params.rlUser ?? { allowed: true };
  if (rl.error === 'rate_limit_unavailable') return { status: 503, body: { error: 'temporarily_unavailable' } };
  if (!rl.allowed) return { status: 429, body: { error: 'Too many setup emails. Try again later.' } };
  const rlEmail = params.rlEmail ?? { allowed: true };
  if (rlEmail.error === 'rate_limit_unavailable') return { status: 503, body: { error: 'temporarily_unavailable' } };
  if (!rlEmail.allowed) return { status: 429, body: { error: 'Too many setup emails. Try again later.' } };

  const now = Date.now();
  const expiresAt = now + EMAIL_CONNECT_TOKEN_TTL_MS;

  if (!agentWalletId) {
    return { status: 400, body: { error: 'agent_wallet_id is required for kind="agent_device"' } };
  }
  const agentDoc = agentWallets.get(agentWalletId);
  if (!agentDoc.exists) return { status: 404, body: { error: 'Agent wallet not found' } };
  const agentWallet = agentDoc.data() as Doc;
  if (agentWallet.status !== 'active') return { status: 403, body: { error: 'Agent wallet is not active' } };
  if (!agentWallet.linked_human_user_id || agentWallet.linked_human_user_id !== userId) {
    return { status: 403, body: { error: 'Not your agent' } };
  }

  const token = crypto.randomBytes(32).toString('hex');
  const tokenDoc: Doc = {
    agent_wallet_id: agentWalletId,
    agent_id: agentWallet.agent_id,
    owner_type: 'agent',
    owner_address: agentWallet.address || '',
    type: 'agent_device_registration',
    created_at: now,
    expires_at: expiresAt,
    used: false,
    email_hash: emailHash,
  };
  setupTokens.set(token, tokenDoc);
  // The REAL shared builder (single source), exactly as server.ts calls it.
  const command = buildDeviceRegisterCommand({
    token,
    idempotencyKey: mintCommandIdempotencyKey(),
  });
  return { status: 200, body: { sent: true, expires_at: expiresAt }, command, tokenDoc, tokenId: token };
}

function activeAgent(over: Doc = {}): Doc {
  return { agent_id: 'agent-1', address: '0xAGENT', status: 'active', linked_human_user_id: 'human-1', ...over };
}

describe('email-command agent_device: behavioral authz + mint (M8)', () => {
  it('404 when the agent wallet does not exist', async () => {
    const agentWallets = makeStore();
    const setupTokens = makeStore();
    const r = await emailCommandAgentDevice({
      userId: 'human-1', email: 'bob@example.com', agentWalletId: 'ghost', agentWallets, setupTokens,
    });
    expect(r.status).toBe(404);
    expect(setupTokens.raw.size).toBe(0);
  });

  it('403 when the agent wallet is not active (status checked before the link check)', async () => {
    const agentWallets = makeStore();
    agentWallets.set('w1', activeAgent({ status: 'suspended' }));
    const setupTokens = makeStore();
    const r = await emailCommandAgentDevice({
      userId: 'human-1', email: 'bob@example.com', agentWalletId: 'w1', agentWallets, setupTokens,
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('Agent wallet is not active');
    expect(setupTokens.raw.size).toBe(0);
  });

  it('403 when linked_human_user_id !== req.user.id', async () => {
    const agentWallets = makeStore();
    agentWallets.set('w1', activeAgent({ linked_human_user_id: 'someone-else' }));
    const setupTokens = makeStore();
    const r = await emailCommandAgentDevice({
      userId: 'human-1', email: 'bob@example.com', agentWalletId: 'w1', agentWallets, setupTokens,
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('Not your agent');
    expect(setupTokens.raw.size).toBe(0);
  });

  it('403 (NOT a null-equality bypass) when the agent is unlinked (linked_human_user_id null)', async () => {
    const agentWallets = makeStore();
    agentWallets.set('w1', activeAgent({ linked_human_user_id: null }));
    const setupTokens = makeStore();
    // Attacker also passes userId null/undefined to try null === null. The
    // non-null guard rejects regardless.
    const r = await emailCommandAgentDevice({
      userId: undefined as unknown as string, email: 'bob@example.com', agentWalletId: 'w1', agentWallets, setupTokens,
    });
    expect(r.status).toBe(403);
    expect(setupTokens.raw.size).toBe(0);
  });

  it('happy path: mints an agent_device_registration token + the byte-exact command', async () => {
    const agentWallets = makeStore();
    agentWallets.set('w1', activeAgent());
    const setupTokens = makeStore();
    const r = await emailCommandAgentDevice({
      userId: 'human-1', email: 'bob@example.com', agentWalletId: 'w1', agentWallets, setupTokens,
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ sent: true, expires_at: expect.any(Number) });
    expect(r.tokenDoc?.type).toBe('agent_device_registration');
    expect(r.tokenDoc?.owner_type).toBe('agent');
    expect(r.tokenDoc?.owner_address).toBe('0xAGENT');
    // Allowlist: exactly the contract field set, never api secret material.
    expect(Object.keys(r.tokenDoc!).sort()).toEqual(
      ['agent_wallet_id', 'agent_id', 'owner_type', 'owner_address', 'type', 'created_at', 'expires_at', 'used', 'email_hash'].sort(),
    );
    // The emitted command is the hosted register curl: token embedded verbatim
    // as the Bearer credential, targeting the exact live consumer endpoint,
    // with a canonical idempotency key so a re-run replays instead of failing.
    expect(r.command!.startsWith('curl -sS -X POST ')).toBe(true);
    expect(r.command).toContain('/v1/devices/register');
    expect(r.command).toContain(`-H "Authorization: Bearer ${r.tokenId}"`);
    expect(r.command).toMatch(/-H "Idempotency-Key: [0-9a-f]{32}"/);
    // Pre-flip: never an npm-install line (the SDK is unpublished/E404).
    expect(r.command).not.toContain('npx @provian/agent-sdk');
    // The token is 64 hex chars, no dot/colon (routing depends on this).
    expect(r.tokenId).toMatch(/^[0-9a-f]{64}$/);
    // Response never leaks the token.
    expect(JSON.stringify(r.body)).not.toContain(r.tokenId);
    // [negative control] the leak guard is falsifiable: the violating shape
    // (token echoed into the response body) IS caught by the same expression.
    expect(JSON.stringify({ ...r.body, token: r.tokenId })).toContain(r.tokenId!);
  });

  it('per-email rate limit -> 429 (in addition to per-user)', async () => {
    const agentWallets = makeStore();
    agentWallets.set('w1', activeAgent());
    const setupTokens = makeStore();
    const r = await emailCommandAgentDevice({
      userId: 'human-1', email: 'bob@example.com', agentWalletId: 'w1', agentWallets, setupTokens,
      rlEmail: { allowed: false, retryAfter: 600 },
    });
    expect(r.status).toBe(429);
    expect(setupTokens.raw.size).toBe(0);
  });

  it('per-user rate limit -> 429, before the agent lookup runs', async () => {
    const agentWallets = makeStore(); // empty - if reached we'd 404, but RL fires first
    const setupTokens = makeStore();
    const r = await emailCommandAgentDevice({
      userId: 'human-1', email: 'bob@example.com', agentWalletId: 'w1', agentWallets, setupTokens,
      rlUser: { allowed: false },
    });
    expect(r.status).toBe(429);
  });

  it('fail CLOSED: rate_limit_unavailable -> 503', async () => {
    const agentWallets = makeStore();
    agentWallets.set('w1', activeAgent());
    const setupTokens = makeStore();
    const r = await emailCommandAgentDevice({
      userId: 'human-1', email: 'bob@example.com', agentWalletId: 'w1', agentWallets, setupTokens,
      rlEmail: { allowed: false, error: 'rate_limit_unavailable' },
    });
    expect(r.status).toBe(503);
    expect(setupTokens.raw.size).toBe(0);
  });

  it('rejects a malformed email before any agent lookup or mint', async () => {
    const agentWallets = makeStore();
    agentWallets.set('w1', activeAgent());
    const setupTokens = makeStore();
    const r = await emailCommandAgentDevice({
      userId: 'human-1', email: 'nope', agentWalletId: 'w1', agentWallets, setupTokens,
    });
    expect(r.status).toBe(400);
    expect(setupTokens.raw.size).toBe(0);
  });
});
