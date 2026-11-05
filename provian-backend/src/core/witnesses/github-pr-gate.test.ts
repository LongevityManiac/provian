import crypto from 'crypto';
import { ethers } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { STANDING_ALWAYS_PRESENT_FIELDS } from '../presentation/vocabulary-fields';
import { claimsDigest, encodePresentationToken, presentationBindingString, type PresentationPayload } from '../presentation/types';
import { reputationDirective } from '../presentation/verify';
import { loadPresentationSigningKey, signReputationPresentation } from '../presentation/signer';
import { verifyChallengeEnvelope } from '../presentation/challenge';
import { loadCommerceAttestationKeys } from '../presentation/jws-key-material';
import { acceptPrGatePresentation, issuePrGateChallenge, prGateId, prGateComment, PR_GATE_CHECK, PR_GATES_COLLECTION,
  PR_GATE_PRICE_ATOMIC, PR_GATE_SEEN_COLLECTION, syncPrGate, finalizePrGatePending, resolvePrAuthor, type PrGateDeps } from './github-pr-gate';
import { PR_GATE_REPOSITORIES, type PrGateApi, type PrGateRepository } from './github-pr-api';
import { PRESENTATION_FLOOR_BY_TIER } from '../commons/burn-consumption';

const NOW = 1793655000000;
const ID = 'wallet_human_test';
const AUTHOR = 123;
const BURN = 'b'.repeat(64);
const wallet = new ethers.Wallet('0x' + '23'.repeat(32));
const ADDRESS = wallet.address.toLowerCase();
const pair = crypto.generateKeyPairSync('ed25519');
const env = { ATTESTATION_SIGNING_KEY: JSON.stringify({ ...pair.privateKey.export({ format: 'jwk' }), kid: 'pr-test' }) };

function setup() {
  const fake = createFakeFirestore();
  const prs = new Map<number, Record<string, unknown>>();
  const comments: Array<Record<string, unknown>> = [];
  const runs: Array<Record<string, unknown>> = [];
  const writes: Array<{ method: string; suffix: string; body: unknown }> = [];
  const pr = (n: number, sha = String(n).repeat(40).slice(0, 40)) => ({ number: n, user: { id: AUTHOR, login: 'contributor' },
    head: { sha }, base: { ref: 'master', sha: 'f'.repeat(40), repo: { id: PR_GATE_REPOSITORIES.provian.id } }, state: 'open' });
  prs.set(1, pr(1)); prs.set(2, pr(2));
  const api: PrGateApi = { call: jest.fn(async (_repo: PrGateRepository, method: string, suffix: string, body?: unknown) => {
    if (method === 'GET' && /^\/pulls\/\d+$/.test(suffix)) return prs.get(Number(suffix.split('/')[2]));
    if (method === 'GET' && suffix.startsWith('/pulls?')) return [...prs.values()].filter((p) => p.state === 'open');
    if (method === 'GET' && suffix.includes('/comments?')) return comments;
    if (method === 'GET' && suffix.includes('/check-runs?')) return { check_runs: runs };
    writes.push({ method, suffix, body });
    if (method === 'POST' && suffix.endsWith('/comments')) {
      comments.push({ id: 9, ...(body as object), user: { type: 'Bot' }, performed_via_github_app: { id: 4570525 } }); return comments[0];
    }
    if (method === 'PATCH' && suffix === '/issues/comments/9') { Object.assign(comments[0], body); return comments[0]; }
    if (method === 'POST' && suffix === '/check-runs') {
      const run = { id: runs.length + 10, app: { id: 4570525 }, ...(body as object) }; runs.push(run); return run;
    }
    if (method === 'PATCH' && suffix.startsWith('/check-runs/')) {
      const run = runs.find((r) => r.id === Number(suffix.split('/')[2])); Object.assign(run!, body); return run;
    }
    if (suffix.includes('/labels')) return null;
    throw new Error(`unexpected API call ${method} ${suffix}`);
  }) };
  fake.store.set(`wallets/${ID}`, { address: ADDRESS, user_id: 'human' });
  fake.store.set(`github_wallet_links_v1/${AUTHOR}_${ID}`, { github_id: String(AUTHOR), wallet_id: ID, verified_by: 'github_user_oauth', verified_at: NOW, revoked_at: null });
  fake.store.set('service_installs/personal', { provider: 'github', forge_account_id: String(AUTHOR), user_id: ID, revoked_at: null });
  fake.store.set(`pvt_burn_records/${BURN}`, { wallet_id: ID, status: 'recorded', verified: true,
    finality: 'final', amount_atomic: PR_GATE_PRICE_ATOMIC.toString() });
  fake.store.set(`burn_consumptions/${BURN}`, { wallet_id: ID, product: 'presentation' });
  const deps: PrGateDeps = { db: fake as unknown as Firestore, api, env, now: () => NOW };
  return { fake, deps, prs, writes, comments, runs };
}

async function tokenFor(deps: PrGateDeps, number: number, changes: Partial<PresentationPayload> = {}): Promise<string> {
  const challenge = await issuePrGateChallenge(deps, 'provian', number);
  const payload: PresentationPayload = { v: 2, tier: 'reputation', iss: 'https://provian.ai', sub: ID,
    presenter_address: ADDRESS, aud: challenge.audience, chal: challenge.challenge,
    iat: NOW / 1000, exp: NOW / 1000 + 300, chal_exp: challenge.expiresAt,
    requester: { type: 'domain', id: 'provian.ai' }, jti: BURN, burn_id: BURN,
    reputation: { facts: Object.fromEntries(STANDING_ALWAYS_PRESENT_FIELDS.map((f) => [f, 0])), redacted: [], predicates: [] },
    presenter_pop: { scheme: 'eip191_secp256k1', signature: '' }, ...changes };
  const binding = presentationBindingString({ tier: payload.tier, presenter_address: payload.presenter_address,
    aud: payload.aud, chal: payload.chal, iat: payload.iat, exp: payload.exp, jti: payload.jti, burn_id: payload.burn_id,
    claims_digest: claimsDigest({ tier: payload.tier, reputation_directive: reputationDirective(payload) }),
    requester: payload.requester, chal_exp: payload.chal_exp });
  const signed = { ...payload, presenter_pop: { scheme: 'eip191_secp256k1' as const, signature: await wallet.signMessage(binding) } };
  const key = loadPresentationSigningKey(env); if (!key.ok) throw new Error('key');
  return encodePresentationToken({ tier: 'reputation', payload: signed, provian_jws: signReputationPresentation(signed, key.key) });
}

describe('repository PR presentation gate with executable negative controls', () => {
  it('RED: a reclaimed legacy install and actor-claimed account mapping cannot authorize the PR author', async () => {
    const { deps, fake } = setup();
    fake.store.delete(`github_wallet_links_v1/${AUTHOR}_${ID}`);
    fake.store.get('service_installs/personal')!.user_id = 'attacker';
    fake.store.set('agent_wallets/attacker', { address: ADDRESS, status: 'active' });
    expect(await resolvePrAuthor(deps, { repository: 'provian', number: 1, author_id: String(AUTHOR), author_login: 'victim', head_sha: '1'.repeat(40), state: 'open' })).toBeNull();
    await expect(issuePrGateChallenge(deps, 'provian', 1)).rejects.toThrow('link_github_identity');
  });
  it('RED: an expired sync cannot write after another lease takes ownership', async () => {
    const { deps, fake, writes } = setup(); let clock = NOW; let calls = 0;
    const api = deps.api;
    const delayed: PrGateDeps = { ...deps, now: () => clock, api: { call: async (...args) => {
      const result = await api.call(...args);
      if (++calls === 1) { clock += 181000; fake.store.set(`github_pr_gate_locks_v1/${PR_GATE_REPOSITORIES.provian.id}`, { token: 'new-owner', until: clock + 180000 }); }
      return result;
    } } };
    await expect(syncPrGate(delayed, 'provian', 1)).rejects.toThrow('deadline');
    expect(writes).toHaveLength(0);
  });
  it('issues a real domain-signed, author-addressed PR challenge and reuses it until near expiry', async () => {
    const { deps } = setup(); const envelope = await issuePrGateChallenge(deps, 'provian', 1);
    const keys = loadCommerceAttestationKeys(env); if (!keys.ok) throw new Error('keys');
    const verified = await verifyChallengeEnvelope(envelope, { nowSeconds: NOW / 1000,
      fetchRequesterKeys: async () => keys.keys, presenterAddress: ADDRESS });
    expect(verified.status).toBe('verified');
    expect(envelope.challenge).toContain(`github-pr:${PR_GATE_REPOSITORIES.provian.id}:1:${AUTHOR}:`);
    expect(await issuePrGateChallenge(deps, 'provian', 1)).toEqual(envelope);
    expect((await issuePrGateChallenge(deps, 'provian', 2)).challenge).not.toBe(envelope.challenge);
  });
  it('accepts a cryptographically valid 50 PVT presentation exactly once and retains one PR clearance', async () => {
    const { deps, fake } = setup(); const token = await tokenFor(deps, 1);
    await acceptPrGatePresentation(deps, 'provian', 1, token);
    expect(fake.store.get(`${PR_GATES_COLLECTION}/${prGateId('provian', 1)}`)?.cleared).toMatchObject({ burn_id: BURN, amount_atomic: PR_GATE_PRICE_ATOMIC.toString() });
    expect(fake.store.get(`${PR_GATE_SEEN_COLLECTION}/${BURN}`)?.pr).toBe(prGateId('provian', 1));
    await acceptPrGatePresentation(deps, 'provian', 1, token); // network retry is idempotent
    expect([...fake.store.keys()].filter((k) => k.startsWith(`${PR_GATE_SEEN_COLLECTION}/`))).toHaveLength(1);
    await expect(issuePrGateChallenge(deps, 'provian', 1)).rejects.toThrow('pr_already_cleared');
  });
  it('RED: replaying the first PR presentation against a second PR fails its challenge', async () => {
    const { deps, fake } = setup(); const token = await tokenFor(deps, 1);
    await issuePrGateChallenge(deps, 'provian', 2);
    await acceptPrGatePresentation(deps, 'provian', 1, token);
    await expect(acceptPrGatePresentation(deps, 'provian', 2, token)).rejects.toThrow('challenge_mismatch');
    expect(fake.store.get(`${PR_GATES_COLLECTION}/${prGateId('provian', 2)}`)?.cleared).toBeUndefined();
  });
  it.each([
    ['below 50 PVT', { amount_atomic: (PR_GATE_PRICE_ATOMIC - 1n).toString() }, 'insufficient burn'],
    ['wrong wallet', { wallet_id: 'other_wallet' }, 'different wallet'],
    ['unverified burn', { verified: false }, 'not a verified'],
    ['revoked burn', { status: 'revoked' }, 'revoked'],
    ['provisional burn', { finality: 'provisional' }, 'finality_pending'],
  ])('RED: refuses %s without a clearance', async (_name, patch, reason) => {
    const { deps, fake } = setup(); const token = await tokenFor(deps, 1);
    Object.assign(fake.store.get(`pvt_burn_records/${BURN}`)!, patch);
    await expect(acceptPrGatePresentation(deps, 'provian', 1, token)).rejects.toThrow(String(reason));
    expect(fake.store.get(`${PR_GATES_COLLECTION}/${prGateId('provian', 1)}`)?.cleared).toBeUndefined();
  });
  it('allows the same token after finality, without a second burn', async () => {
    const { deps, fake } = setup(); const token = await tokenFor(deps, 1);
    const row = fake.store.get(`pvt_burn_records/${BURN}`)!; row.finality = 'provisional';
    await expect(acceptPrGatePresentation(deps, 'provian', 1, token)).rejects.toThrow('finality_pending');
    row.finality = 'final'; await acceptPrGatePresentation(deps, 'provian', 1, token);
    expect(fake.store.get(`${PR_GATE_SEEN_COLLECTION}/${BURN}`)).toBeDefined();
  });
  it('keeps a fresh verified submission pending through token expiry, and the sweeper clears it only at finality', async () => {
    const { deps, fake } = setup(); const token = await tokenFor(deps, 1);
    const burn = fake.store.get(`pvt_burn_records/${BURN}`)!; burn.finality = 'provisional';
    await expect(acceptPrGatePresentation(deps, 'provian', 1, token)).rejects.toThrow('finality_pending');
    expect(fake.store.get(`${PR_GATES_COLLECTION}/${prGateId('provian', 1)}`)?.pending).toBeDefined();
    await finalizePrGatePending({ ...deps, now: () => NOW + 3_600_000 }, 'provian', 1);
    expect(fake.store.get(`${PR_GATES_COLLECTION}/${prGateId('provian', 1)}`)?.cleared).toBeUndefined();
    burn.finality = 'final';
    await finalizePrGatePending({ ...deps, now: () => NOW + 3_600_000 }, 'provian', 1);
    expect(fake.store.get(`${PR_GATES_COLLECTION}/${prGateId('provian', 1)}`)?.cleared).toBeDefined();
  });
  it('RED: a revoked pending burn cannot clear after token expiry', async () => {
    const { deps, fake } = setup(); const token = await tokenFor(deps, 1);
    const burn = fake.store.get(`pvt_burn_records/${BURN}`)!; burn.finality = 'provisional';
    await expect(acceptPrGatePresentation(deps, 'provian', 1, token)).rejects.toThrow('finality_pending');
    burn.status = 'revoked';
    await finalizePrGatePending({ ...deps, now: () => NOW + 3_600_000 }, 'provian', 1);
    expect(fake.store.get(`${PR_GATES_COLLECTION}/${prGateId('provian', 1)}`)?.cleared).toBeUndefined();
    expect(fake.store.get(`${PR_GATES_COLLECTION}/${prGateId('provian', 1)}`)?.pending).toBeNull();
  });
  it('RED: a token for another requester, actor or expired moment is refused despite a real signature', async () => {
    for (const patch of [{ aud: 'other.example' }, { sub: 'other_wallet' }, { exp: NOW / 1000 - 120 }]) {
      const { deps } = setup(); const token = await tokenFor(deps, 1, patch);
      await expect(acceptPrGatePresentation(deps, 'provian', 1, token)).rejects.toThrow();
    }
  });
  it('RED: a modified token and an unrelated benefit consumption never clear a PR', async () => {
    const { deps, fake } = setup(); const token = await tokenFor(deps, 1);
    const decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    const parts = String(decoded.provian_jws).split('.');
    const forged = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); forged.chal = 'fake'.repeat(16);
    parts[1] = Buffer.from(JSON.stringify(forged)).toString('base64url'); decoded.provian_jws = parts.join('.');
    await expect(acceptPrGatePresentation(deps, 'provian', 1, Buffer.from(JSON.stringify(decoded)).toString('base64url'))).rejects.toThrow();
    fake.store.set(`burn_consumptions/${BURN}`, { wallet_id: ID, product: 'vouch' });
    await expect(acceptPrGatePresentation(deps, 'provian', 1, token)).rejects.toThrow('burn_not_consumed');
  });
  it('RED: no linked wallet means no signed challenge, and a wrong GitHub repository is refused', async () => {
    const { deps, fake, prs } = setup(); fake.store.delete(`github_wallet_links_v1/${AUTHOR}_${ID}`);
    await expect(issuePrGateChallenge(deps, 'provian', 1)).rejects.toThrow('link_github_identity');
    Object.assign(prs.get(1)!, { base: { ref: 'master', sha: 'f'.repeat(40), repo: { id: 7 } } });
    await expect(issuePrGateChallenge(deps, 'provian', 1)).rejects.toThrow('github_pr_binding_invalid');
  });
  it('accepts an OAuth link for an active agent and refuses ambiguous or revoked links', async () => {
    const { deps, fake } = setup();
    fake.store.delete(`wallets/${ID}`);
    fake.store.set(`agent_wallets/${ID}`, { address: ADDRESS, status: 'active' });
    const row = { repository: 'provian' as const, number: 1, author_id: String(AUTHOR), author_login: 'a', state: 'open', head_sha: 'a'.repeat(40) };
    expect(await resolvePrAuthor(deps, row)).toEqual({ id: ID, address: ADDRESS });
    fake.store.set('github_wallet_links_v1/another', { github_id: String(AUTHOR), wallet_id: 'another', verified_by: 'github_user_oauth', verified_at: NOW, revoked_at: null });
    expect(await resolvePrAuthor(deps, row)).toBeNull();
    fake.store.delete('github_wallet_links_v1/another'); fake.store.set(`github_identity_revocations_v1/${AUTHOR}`, { revoked_at: NOW });
    expect(await resolvePrAuthor(deps, row)).toBeNull();
  });
  it('renewing a nearly expired quote cannot invalidate another live challenge after a burn', async () => {
    const { deps } = setup(); const earlier = await issuePrGateChallenge(deps, 'provian', 1);
    const later = { ...deps, now: () => NOW + 850_000 };
    const token = await tokenFor(later, 1, { chal: earlier.challenge, chal_exp: earlier.expiresAt,
      iat: NOW / 1000 + 850, exp: NOW / 1000 + 1150 });
    await expect(acceptPrGatePresentation(later, 'provian', 1, token)).resolves.toBeUndefined();
  });
  it('pending check, one comment and label block the unpaid PR; pushes to a paid PR keep its clearance', async () => {
    const { deps, fake, writes, comments, prs, runs } = setup();
    await syncPrGate(deps, 'provian', 1); await syncPrGate(deps, 'provian', 1);
    expect(comments).toHaveLength(1);
    expect(writes.some((w) => w.suffix === '/check-runs' && (w.body as {status:string}).status === 'queued')).toBe(true);
    expect(runs.at(-1)).toMatchObject({ name: PR_GATE_CHECK, conclusion: 'action_required' });
    await acceptPrGatePresentation(deps, 'provian', 1, await tokenFor(deps, 1));
    await syncPrGate(deps, 'provian', 1);
    expect(runs.at(-1)).toMatchObject({ conclusion: 'success' });
    Object.assign(prs.get(1)!, { head: { sha: 'a'.repeat(40) } });
    await syncPrGate(deps, 'provian', 1);
    expect(runs.at(-1)).toMatchObject({ head_sha: 'a'.repeat(40), conclusion: 'success' });
    expect(comments).toHaveLength(1);
    expect([...fake.store.keys()].filter((k) => k.startsWith(PR_GATE_SEEN_COLLECTION))).toHaveLength(1);
    await syncPrGate(deps, 'provian', 2);
    expect(runs.at(-1)).toMatchObject({ conclusion: 'action_required' });
  });
  it('a commit-scoped display never grants a second PR a clearance', async () => {
    const { deps, prs, runs, fake } = setup();
    Object.assign(prs.get(2)!, { head: (prs.get(1)!).head });
    await acceptPrGatePresentation(deps, 'provian', 1, await tokenFor(deps, 1));
    await syncPrGate(deps, 'provian', 1);
    expect(runs.at(-1)).toMatchObject({ conclusion: 'success' });
    expect(fake.store.get(`${PR_GATES_COLLECTION}/${prGateId('provian', 2)}`)?.cleared).toBeUndefined();
  });
  it('gate price does not alter either presentation floor; contributor comment has both onboarding paths', () => {
    expect(PR_GATE_PRICE_ATOMIC).toBe(50n * 10n ** 18n);
    expect(PRESENTATION_FLOOR_BY_TIER).toEqual({ reputation: 15n * 10n ** 18n, pe_fact: 5n * 10n ** 18n });
    const comment = prGateComment('provian', 1, false);
    expect(comment).toContain('Connect → GitHub'); expect(comment).toContain('--burn-amount-atomic 50000000000000000000');
  });
});

describe('owner exemption and actual-author payment', () => {
  it('does not publish a check, comment or label, or offer a challenge, for the immutable repository owner', async () => {
    const { deps, prs, writes, fake } = setup();
    prs.get(1)!.user = { id: Number(PR_GATE_REPOSITORIES.provian.ownerId), login: 'LongevityManiac' };
    await syncPrGate(deps, 'provian', 1);
    expect(writes).toHaveLength(0);
    expect(fake.store.has(`${PR_GATES_COLLECTION}/${prGateId('provian', 1)}`)).toBe(false);
    await expect(issuePrGateChallenge(deps, 'provian', 1)).rejects.toMatchObject({ status: 409, message: 'repository_owner_exempt' });
    await expect(acceptPrGatePresentation(deps, 'provian', 1, 'unused')).rejects.toMatchObject({ status: 409, message: 'repository_owner_exempt' });
  });
  it('a claimed owner login with a different GitHub account id remains gated', async () => {
    const { deps, prs, writes } = setup(); prs.get(1)!.user = { id: AUTHOR, login: 'LongevityManiac' };
    await syncPrGate(deps, 'provian', 1);
    expect(writes.some(w => w.suffix === '/check-runs')).toBe(true);
  });
  it('refuses an App-bot PR even when it has the old Atlas wallet binding', async () => {
    const { deps, prs, fake } = setup();
    prs.get(1)!.user = { id: 998, login: 'provian-git-witness[bot]' };
    fake.store.set(`${PR_GATES_COLLECTION}/${prGateId('provian', 1)}`, { author_id: '998', app_author_wallet: { wallet_id: ID, request_id: 'a'.repeat(64) } });
    await expect(issuePrGateChallenge(deps, 'provian', 1, ID)).rejects.toMatchObject({ status: 428 });
  });
  it('a wallet parameter cannot select a sponsor from an ambiguous identity mapping', async () => {
    const { deps, fake } = setup();
    fake.store.set(`github_wallet_links_v1/${AUTHOR}_sponsor`, { github_id: String(AUTHOR), wallet_id: 'sponsor', verified_by: 'github_user_oauth', verified_at: NOW, revoked_at: null });
    await expect(issuePrGateChallenge(deps, 'provian', 1, ID)).rejects.toMatchObject({ status: 428 });
    await expect(issuePrGateChallenge(deps, 'provian', 1, 'sponsor')).rejects.toMatchObject({ status: 428 });
  });
  it('pins the actual author wallet and does not permit replacement after the challenge', async () => {
    const { deps, fake } = setup(); await issuePrGateChallenge(deps, 'provian', 1);
    expect(fake.store.get(`${PR_GATES_COLLECTION}/${prGateId('provian', 1)}`)?.author_wallet)
      .toEqual({ wallet_id: ID, address: ADDRESS, github_id: String(AUTHOR) });
    fake.store.delete(`github_wallet_links_v1/${AUTHOR}_${ID}`);
    fake.store.set(`github_wallet_links_v1/${AUTHOR}_other`, { github_id: String(AUTHOR), wallet_id: 'other', verified_by: 'github_user_oauth', verified_at: NOW, revoked_at: null });
    fake.store.set('wallets/other', { address: ADDRESS });
    await expect(issuePrGateChallenge(deps, 'provian', 1, 'other')).rejects.toMatchObject({ status: 428 });
  });
});
