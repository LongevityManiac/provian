/**
 * The default-on Solana address proof in the one-command onboarding: runs after the
 * Commons join with the agent's own id and key, is idempotent, and never blocks
 * onboarding when it fails.
 */
import { describe, it, expect, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { base58 } from '@scure/base';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';
import { runAgentBootstrap, renderBootstrapOutcome, defaultBootstrapDeps, type BootstrapDeps, type CreatedWallet } from './bootstrap-flow';
import { buildSolanaProofMessage } from './solana-address-proof';
import { deriveSolanaAddress } from './chains';

const INPUT = { connectionToken: 'PROV-ABCD-2345', relayUrl: 'https://api.provian.ai' };

function makeDeps(over: Partial<BootstrapDeps> = {}): { deps: BootstrapDeps; calls: string[]; wallet: CreatedWallet } {
  const calls: string[] = [];
  const wallet: CreatedWallet = {
    walletId: 'wallet_aw_boot', address: '0xabc', privateKey: bytesToHex(randomBytes(32)),
    publicKey: 'pub', apiKey: 'pvn_live_x', apiSecret: 'pvns_y',
  };
  const deps: BootstrapDeps = {
    agentIdentity() { calls.push('agentIdentity'); return { agentId: 'agent-a1', agentName: 'Atlas' }; },
    async createWallet() { calls.push('createWallet'); return wallet; },
    async escrowRecoveryKey() { calls.push('escrow'); },
    async registerDevice() { calls.push('registerDevice'); },
    async startObserver() { calls.push('startObserver'); },
    async joinCommons() { calls.push('joinCommons'); return { ok: true, joinStatus: 'joined' }; },
    async proveSolanaAddress() { calls.push('proveSolana'); return { ok: true, status: 'proven' }; },
    async fileLinkRequest() { calls.push('linkRequest'); return { ok: true, linkStatus: 'pending' }; },
    log() { /* silent */ },
    ...over,
  };
  return { deps, calls, wallet };
}

describe('onboarding — the Solana address proof step', () => {
  it('runs after the Commons join, with the agent\'s own id and key', async () => {
    const spy = vi.fn<NonNullable<BootstrapDeps['proveSolanaAddress']>>(async () => ({ ok: true, status: 'proven' as const }));
    const { deps, calls, wallet } = makeDeps({ proveSolanaAddress: async (i) => { calls.push('proveSolana'); return spy(i); } });
    const res = await runAgentBootstrap(INPUT, deps);
    expect(calls).toEqual(['agentIdentity', 'createWallet', 'registerDevice', 'startObserver', 'joinCommons', 'proveSolana', 'linkRequest']);
    expect(spy).toHaveBeenCalledWith({
      relayUrl: INPUT.relayUrl, apiKey: wallet.apiKey, apiSecret: wallet.apiSecret,
      agentId: 'agent-a1', privateKey: wallet.privateKey,
    });
    expect(res.solanaAddressProven).toBe(true);
    expect(res.solanaProofStatus).toBe('proven');
  });

  it('already proven is benign — no note, still proven', async () => {
    const { deps } = makeDeps({ proveSolanaAddress: async () => ({ ok: true, status: 'already_proven' as const }) });
    const res = await runAgentBootstrap(INPUT, deps);
    expect(res.solanaAddressProven).toBe(true);
    expect(res.solanaProofStatus).toBe('already_proven');
    expect(res.notes.some((n) => /Solana/.test(n))).toBe(false);
  });

  it('a FAILED proof (or a thrown one) never blocks onboarding: the link is still filed and the run succeeds', async () => {
    for (const prove of [
      async () => ({ ok: false, code: 'SOLANA_PROOF_UNAVAILABLE' }),
      async () => { throw new Error('boom'); },
    ] as Array<NonNullable<BootstrapDeps['proveSolanaAddress']>>) {
      const { deps, calls } = makeDeps({ proveSolanaAddress: prove });
      const res = await runAgentBootstrap(INPUT, deps);
      expect(calls).toContain('linkRequest');
      expect(res.linkRequested).toBe(true);
      expect(res.solanaAddressProven).toBe(false);
      expect(res.solanaProofStatus).toBe('failed');
      const note = res.notes.find((n) => /Solana address did not complete/.test(n));
      expect(note).toMatch(/prove-solana-address/);
      const view = renderBootstrapOutcome(res);
      expect(view.exitCode).toBe(0);
      expect(view.stdout.join('\n')).toMatch(/prove-solana-address/);
    }
  });

  it('opt-out skips the step entirely', async () => {
    const { deps, calls } = makeDeps();
    const res = await runAgentBootstrap({ ...INPUT, solanaProofOptOut: true }, deps);
    expect(calls).not.toContain('proveSolana');
    expect(res.solanaProofStatus).toBe('skipped');
  });

  it('the REAL wiring (defaultBootstrapDeps) signs the relay\'s canonical message with the derived key', async () => {
    const privateKey = bytesToHex(randomBytes(32));
    const address = deriveSolanaAddress(privateKey);
    const issued = Date.now();
    const message = buildSolanaProofMessage({
      subjectLine: 'agent: agent-a1', address, nonce: 'c'.repeat(32),
      issuedIso: new Date(issued).toISOString(), expiresIso: new Date(issued + 600_000).toISOString(),
    });
    let submitted: Record<string, unknown> | null = null;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const json = (body: Record<string, unknown>, status = 200): Response =>
        ({ ok: status < 300, status, json: async () => body }) as unknown as Response;
      if (url.endsWith('/challenge')) return json({ challenge_id: 'ch-1', message, nonce: 'c'.repeat(32), issued_at: issued, expires_at: issued + 600_000 });
      submitted = JSON.parse(String(init.body)) as Record<string, unknown>;
      return json({ ok: true, proven_address: address, origin: 'native', proven_at_slot: 9 });
    });
    const real = defaultBootstrapDeps(fetchImpl as unknown as typeof fetch);
    const r = await real.proveSolanaAddress!({ relayUrl: 'https://relay.test', apiKey: 'k', apiSecret: 's', agentId: 'agent-a1', privateKey });
    expect(r).toEqual({ ok: true, status: 'proven', provenAddress: address });
    expect(submitted).not.toBeNull();
    const body = submitted as unknown as Record<string, unknown>;
    expect(body.origin).toBe('native');
    expect(ed25519.verify(base58.decode(String(body.signature)), new TextEncoder().encode(message), base58.decode(address))).toBe(true);

    // RED: the same wiring, the relay naming another agent → refused, nothing submitted, no throw.
    submitted = null;
    const r2 = await real.proveSolanaAddress!({ relayUrl: 'https://relay.test', apiKey: 'k', apiSecret: 's', agentId: 'agent-other', privateKey });
    expect(r2).toEqual({ ok: false, code: 'SOLANA_PROOF_CHALLENGE_UNTRUSTED' });
    expect(submitted).toBeNull();
  });
});
