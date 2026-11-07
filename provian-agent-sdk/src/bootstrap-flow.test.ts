import { EGRESS_ALLOW_HOSTS } from './egress-hosts';
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { readCredentialsFile } from './scripts/credentials';
import { randomBytes, bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { generateAnchorKeyPair, openWithAnchor, fromB64u } from './agent-key-recovery';
import { sealAndEscrow, runAgentBootstrap, defaultBootstrapDeps, renderBootstrapOutcome, bootstrapObserverEntrypoint, hostWitnessFacts, AGENT_HELP_COMMAND_HOSTED, AGENT_HELP_COMMAND_NPX, AGENT_ACT_EXAMPLES_HOSTED, AGENT_PROVIAN_COMMAND_HOSTED, hostedProvianCommand, resolveBootstrapAgentName, sanitizeBootstrapAgentName, BOOTSTRAP_AGENT_NAME_MAX, type BootstrapDeps, type BootstrapResult, type CreatedWallet } from './bootstrap-flow';
import { commonsHeartbeatInstruction } from './witness-setup';
import { ACT_VERBS } from './act-verbs';
import { deriveMessageKeyPair } from './thread-crypto';

const ANCHOR = generateAnchorKeyPair();
const ANCHOR_PUB_B64U = Buffer.from(ANCHOR.publicKey).toString('base64url');

function fakeWallet(): CreatedWallet {
  return {
    walletId: 'wallet_aw_boot', address: '0xabc', privateKey: bytesToHex(randomBytes(32)),
    publicKey: 'pub', apiKey: 'pvn_live_x', apiSecret: 'pvns_y',
  };
}

describe('sealAndEscrow — the escrow wire contract', () => {
  it('escrows a blob the phone anchor can open back to the exact key', async () => {
    const privateKey = bytesToHex(randomBytes(32));
    let captured: any = null;
    const mockFetch = vi.fn(async (_url: string, init: any) => {
      captured = JSON.parse(init.body);
      return { ok: true, status: 200 } as Response;
    });
    await sealAndEscrow(
      { relayUrl: 'https://api.provian.ai', walletId: 'wallet_aw_1', apiKey: 'k', apiSecret: 's', privateKey, anchorPubkeyB64u: ANCHOR_PUB_B64U },
      mockFetch as unknown as typeof fetch,
    );
    // the relay was given ciphertext + the pubkey
    expect(typeof captured.sealed_key_blob).toBe('string');
    expect(captured.recovery_anchor_pubkey).toBe(ANCHOR_PUB_B64U);
    // the phone (anchor secret) recovers the EXACT private key
    const recovered = bytesToHex(openWithAnchor(ANCHOR.secretKey, fromB64u(captured.sealed_key_blob)));
    expect(recovered).toBe(privateKey);
    // auth + url
    expect(mockFetch.mock.calls[0][0]).toContain('/v1/agent/wallet/wallet_aw_1/recovery-escrow');
    expect((mockFetch.mock.calls[0][1] as any).headers.Authorization).toBe('Bearer k:s');
  });

  it('throws when the relay rejects the escrow (fund-safety: never pretend it is safe)', async () => {
    const mockFetch = vi.fn(async () => ({ ok: false, status: 500 } as Response));
    await expect(sealAndEscrow(
      { relayUrl: 'https://api.provian.ai', walletId: 'w', apiKey: 'k', apiSecret: 's', privateKey: bytesToHex(randomBytes(32)), anchorPubkeyB64u: ANCHOR_PUB_B64U },
      mockFetch as unknown as typeof fetch,
    )).rejects.toThrow();
  });
});

function makeDeps(over: Partial<BootstrapDeps> = {}, walletOver: Partial<CreatedWallet> = {}): { deps: BootstrapDeps; calls: string[] } {
  const calls: string[] = [];
  // The recovery anchor now rides the CREATE response, so the fake wallet carries it.
  const wallet: CreatedWallet = { ...fakeWallet(), recoveryAnchorPubkey: ANCHOR_PUB_B64U, ...walletOver };
  const deps: BootstrapDeps = {
    agentIdentity() { calls.push('agentIdentity'); return { agentId: 'a1', agentName: 'Atlas' }; },
    async createWallet() { calls.push('createWallet'); return wallet; },
    async escrowRecoveryKey() { calls.push('escrow'); },
    async registerDevice() { calls.push('registerDevice'); },
    async startObserver() { calls.push('startObserver'); },
    async joinCommons() { calls.push('joinCommons'); return { ok: true, joinStatus: 'joined' }; },
    async fileLinkRequest() { calls.push('linkRequest'); return { ok: true, linkStatus: 'pending' }; },
    log() { /* silent */ },
    ...over,
  };
  return { deps, calls };
}

describe('runAgentBootstrap orchestration', () => {
  it('the agent\'s own bootstrap records its launcher right before the observer starts; the observer start alone never does', async () => {
    const { deps, calls } = makeDeps({ recordLauncher() { calls.push('recordLauncher'); } });
    await runAgentBootstrap({ connectionToken: 'PROV-ABCD-2345', relayUrl: 'https://api.provian.ai' }, deps);
    expect(calls.indexOf('recordLauncher')).toBe(calls.indexOf('startObserver') - 1);
    // The human-run agent-device install calls only startObserver; it must not record the human's terminal.
    expect(String(defaultBootstrapDeps().startObserver)).not.toMatch(/recordProcessLauncher|recordLauncher/);
  });

  it('runs the full sequence and escrows recovery when an anchor is present', async () => {
    const { deps, calls } = makeDeps();
    const res = await runAgentBootstrap({ connectionToken: 'PROV-ABCD-2345', relayUrl: 'https://api.provian.ai' }, deps);
    expect(calls).toEqual(['agentIdentity', 'createWallet', 'escrow', 'registerDevice', 'startObserver', 'joinCommons', 'linkRequest']);
    expect(res.recoveryEscrowed).toBe(true);
    expect(res.commonsJoined).toBe(true);
    expect(res.commonsJoinStatus).toBe('joined');
    expect(res.linkRequested).toBe(true);
    expect(res.linkStatus).toBe('pending');
    expect(res.notes).toEqual([]);
  });

  // ── RED: the assertion above can actually tell present from absent ─────────
  //
  // A dep that drops the field reproduces the pre-fix behaviour exactly; if this
  // expectation ever stopped detecting it, the control above would be a guard that
  // cannot fail.
  it('RED — a createWallet that drops the token is observed dropping it', async () => {
    let seen: unknown = 'unset';
    const dropping: BootstrapDeps['createWallet'] = async (input) => {
      // The pre-fix shape: the orchestrator's own field list, minus the anchor.
      const { connectionToken: _dropped, ...withoutAnchor } = input;
      seen = (withoutAnchor as Record<string, unknown>).connectionToken;
      return fakeWallet();
    };
    const { deps } = makeDeps({ createWallet: dropping });
    await runAgentBootstrap({ connectionToken: 'PROV-ABCD-2345', relayUrl: 'https://api.provian.ai' }, deps);
    expect(seen).toBeUndefined();
  });

  it('DEFAULT-ON Commons join: joins with the agent OWN key + its locally-derived display name', async () => {
    // (Ordering — join after observer, before the link — is asserted by the
    // full-sequence test above.)
    const spy = vi.fn<BootstrapDeps['joinCommons']>(async () => ({ ok: true, joinStatus: 'joined' as const }));
    const { deps } = makeDeps({ joinCommons: spy });
    await runAgentBootstrap({ connectionToken: 'PROV-ABCD-2345', relayUrl: 'https://api.provian.ai' }, deps);
    // Joined with the created wallet's OWN api creds + the locally-derived agent name.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({ apiKey: 'pvn_live_x', apiSecret: 'pvns_y', displayName: 'Atlas' });
  });

  it('JOINING = REACHABLE: the join carries the message key derived from the created wallet key', async () => {
    const privateKey = bytesToHex(randomBytes(32));
    const spy = vi.fn<BootstrapDeps['joinCommons']>(async () => ({ ok: true, joinStatus: 'joined' as const }));
    const { deps } = makeDeps({ joinCommons: spy }, { privateKey });
    await runAgentBootstrap({ connectionToken: 'PROV-ABCD-2345', relayUrl: 'https://api.provian.ai' }, deps);
    expect(spy.mock.calls[0][0].messagePubkey).toBe(deriveMessageKeyPair(privateKey).pubkeyB64u);
  });

  it('OPT-OUT: commonsOptOut skips the join entirely, records a note, still files the link', async () => {
    const spy = vi.fn<BootstrapDeps['joinCommons']>(async () => ({ ok: true, joinStatus: 'joined' as const }));
    const { deps, calls } = makeDeps({ joinCommons: spy });
    const res = await runAgentBootstrap({ connectionToken: 'PROV-ABCD-2345', relayUrl: 'https://api.provian.ai', commonsOptOut: true }, deps);
    expect(spy).not.toHaveBeenCalled();
    expect(calls).not.toContain('joinCommons');
    expect(res.commonsJoined).toBe(false);
    expect(res.commonsJoinStatus).toBe('skipped');
    expect(res.notes.join('   ')).toMatch(/opted out of the Commons/i);
    expect(res.linkRequested).toBe(true); // opt-out never affects the link
  });

  it('an idempotent re-join (already_member) is reported as joined-present', async () => {
    const { deps } = makeDeps({ joinCommons: async () => ({ ok: true, joinStatus: 'already_member' as const }) });
    const res = await runAgentBootstrap({ connectionToken: 'PROV-ABCD-2345', relayUrl: 'https://api.provian.ai' }, deps);
    expect(res.commonsJoined).toBe(true);
    expect(res.commonsJoinStatus).toBe('already_member');
  });

  it('RED: a test-platform exclusion stays out of public Commons totals while onboarding continues', async () => {
    const { deps } = makeDeps({
      joinCommons: async () => ({ ok: true, joinStatus: 'excluded_test' as const }),
    });
    const res = await runAgentBootstrap(
      { connectionToken: 'PROV-ABCD-2345', relayUrl: 'https://api.provian.ai' },
      deps,
    );
    expect(res.commonsJoined).toBe(false);
    expect(res.commonsJoinStatus).toBe('excluded_test');
    expect(res.notes).toContain(
      'This test-platform agent is excluded from the public Commons and its activity totals.',
    );
  });

  it('a failed Commons join is best-effort: note added, wallet + link unaffected', async () => {
    const { deps } = makeDeps({ joinCommons: async () => ({ ok: false, error: 'http_500' }) });
    const res = await runAgentBootstrap({ connectionToken: 'PROV-ABCD-2345', relayUrl: 'https://api.provian.ai' }, deps);
    expect(res.commonsJoined).toBe(false);
    expect(res.linkRequested).toBe(true);
    expect(res.notes.join('   ')).toMatch(/Joining the Commons did not complete/i);
  });

  it('a THROWING Commons join is caught (best-effort), link still filed', async () => {
    const { deps } = makeDeps({ joinCommons: async () => { throw new Error('commons down'); } });
    const res = await runAgentBootstrap({ connectionToken: 'PROV-ABCD-2345', relayUrl: 'https://api.provian.ai' }, deps);
    expect(res.commonsJoined).toBe(false);
    expect(res.linkRequested).toBe(true);
    expect(res.notes.join('   ')).toMatch(/Joining the Commons did not complete/i);
  });

  it('escrow receives the created wallet key + the anchor', async () => {
    const spy = vi.fn<BootstrapDeps['escrowRecoveryKey']>(async () => {});
    const { deps } = makeDeps({ escrowRecoveryKey: spy });
    await runAgentBootstrap({ connectionToken: 'PROV-ABCD-2345', relayUrl: 'https://api.provian.ai' }, deps);
    expect(spy.mock.calls[0][0]).toMatchObject({ walletId: 'wallet_aw_boot', anchorPubkeyB64u: ANCHOR_PUB_B64U });
  });

  it('with NO anchor: skips escrow, records a note, still files the link', async () => {
    const escrow = vi.fn(async () => {});
    const { deps, calls } = makeDeps({ escrowRecoveryKey: escrow }, { recoveryAnchorPubkey: undefined });
    const res = await runAgentBootstrap({ connectionToken: 'PROV-ABCD-2345', relayUrl: 'https://api.provian.ai' }, deps);
    expect(escrow).not.toHaveBeenCalled();
    expect(calls).toContain('linkRequest');
    expect(res.recoveryEscrowed).toBe(false);
    expect(res.notes.join('   ')).toMatch(/no phone-based recovery/i);
  });

  it('FUND-SAFETY: a failed escrow (anchor present) throws — never proceeds silently', async () => {
    const { deps } = makeDeps({ escrowRecoveryKey: async () => { throw new Error('escrow down'); } });
    await expect(runAgentBootstrap({ connectionToken: 'PROV-ABCD-2345', relayUrl: 'https://api.provian.ai' }, deps)).rejects.toThrow();
  });

  it('a failing device step is recorded (internal note), the link is still filed, and the observer is not started for an unregistered device', async () => {
    const startObserver = vi.fn(async () => { throw new Error('no daemon'); });
    const { deps } = makeDeps({
      registerDevice: async () => { throw new Error('no device'); },
      startObserver,
    });
    const res = await runAgentBootstrap({ connectionToken: 'PROV-ABCD-2345', relayUrl: 'https://api.provian.ai' }, deps);
    expect(res.deviceRegistered).toBe(false);
    expect(res.observerStarted).toBe(false);
    expect(startObserver).not.toHaveBeenCalled();
    expect(res.linkRequested).toBe(true);
    expect(res.notes).toContain('device_registration_failed');
    // (A): and that run is NOT a success.
    expect(renderBootstrapOutcome(res).exitCode).toBe(1);
  });

  it('a failing observer start (device registered) is a visible note, not a failure', async () => {
    const { deps } = makeDeps({ startObserver: async () => { throw new Error('no daemon'); } });
    const res = await runAgentBootstrap({ connectionToken: 'PROV-ABCD-2345', relayUrl: 'https://api.provian.ai' }, deps);
    expect(res.deviceRegistered).toBe(true);
    expect(res.observerStarted).toBe(false);
    expect(res.notes.join('   ')).toMatch(/did not start automatically/);
  });

  it('the host facts reach the result — a detected harness is named', async () => {
    const home = mkdtempSync(join(tmpdir(), 'd494-home-'));
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
    try {
      const { deps } = makeDeps({});
      const withHarness = await runAgentBootstrap({ connectionToken: 'PROV-ABCD-2345', relayUrl: 'https://api.provian.ai', hostedInstall: true, hostHome: home }, deps);
      expect(withHarness.transcriptHarnesses).toEqual([]);
      const text = renderBootstrapOutcome(withHarness).stdout.join('\n');
      expect(text).toMatch(/describe their location and record format/);
      const bare = mkdtempSync(join(tmpdir(), 'd494-bare-'));
      const lin = await runAgentBootstrap({ connectionToken: 'PROV-ABCD-2345', relayUrl: 'https://api.provian.ai', hostedInstall: true, hostHome: bare }, makeDeps({}).deps);
      expect(lin.transcriptHarnesses).toEqual([]);
      rmSync(bare, { recursive: true, force: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('the read loop : standard onboarding tells the agent to act on Commons mail through its runtime adapter', async () => {
    const { deps } = makeDeps({});
    const res = await runAgentBootstrap({ connectionToken: 'PROV-ABCD-2345', relayUrl: 'https://api.provian.ai' }, deps);
    expect(res.commonsJoined).toBe(true);
    const text = renderBootstrapOutcome(res).stdout.join('\n');
    expect(text).toContain(commonsHeartbeatInstruction());
    expect(text).toMatch(/observer checks for mail and starts your runtime when it arrives/);
  });

  it('hostWitnessFacts never throws and reads only the given home', () => {
    expect(hostWitnessFacts('/nonexistent-home')).toEqual({ transcriptHarnesses: [] });
  });

  it('startObserver outcome (supervision, shim listening) lands on the result', async () => {
    const { deps } = makeDeps({ startObserver: async () => ({ supervision: 'cron', modelProxyListening: true }) });
    const res = await runAgentBootstrap({ connectionToken: 'PROV-ABCD-2345', relayUrl: 'https://api.provian.ai' }, deps);
    expect(res.supervision).toBe('cron');
    expect(res.modelProxyListening).toBe(true);
  });

  it.each([[false, 'npm_sdk'], [true, 'install_line']] as const)(
    'passes the registration channel for hostedInstall=%s',
    async (hostedInstall, registrationChannel) => {
      const createWallet = vi.fn<BootstrapDeps['createWallet']>(async () => fakeWallet());
      const { deps } = makeDeps({ createWallet });
      await runAgentBootstrap({
        connectionToken: 'PROV-ABCD-2345', relayUrl: 'https://api.provian.ai', hostedInstall,
      }, deps);
      expect(createWallet).toHaveBeenCalledWith(expect.objectContaining({ registrationChannel }));
    },
  );

  it('the identity is derived locally BEFORE creation and is what createWallet receives', async () => {
    const spy = vi.fn<BootstrapDeps['createWallet']>(async () => ({ ...fakeWallet(), recoveryAnchorPubkey: ANCHOR_PUB_B64U }));
    const seenBeforeCreate: string[][] = [];
    const { deps, calls } = makeDeps({ createWallet: async (input) => { seenBeforeCreate.push(calls.slice()); return spy(input); } });
    await runAgentBootstrap({ connectionToken: 'PROV-ABCD-2345', relayUrl: 'https://api.provian.ai' }, deps);
    // The identity step had already run (and nothing else) when createWallet was entered.
    expect(seenBeforeCreate).toEqual([['agentIdentity']]);
    expect(spy.mock.calls[0][0]).toMatchObject({ agentId: 'a1', agentName: 'Atlas' });
    // RED half of the removal: no dep named connect exists on the orchestrator's contract.
    expect('connect' in deps).toBe(false);
  });

  it('defaultBootstrapDeps derives a deterministic, hostname-named identity (no relay round-trip)', () => {
    const a = defaultBootstrapDeps().agentIdentity();
    const b = defaultBootstrapDeps().agentIdentity();
    expect(a).toEqual(b);
    expect(a.agentId).toMatch(/^agent-[0-9a-f]{16}$/);
    expect(a.agentName.length).toBeGreaterThan(0);
  });

  it('PROVIAN_AGENT_NAME names the agent (sanitized like the hostname, ≤40); hostname is the fallback', () => {
    expect(resolveBootstrapAgentName({ PROVIAN_AGENT_NAME: 'Research Bot' }, 'mini.local')).toBe('Research-Bot');
    // RED control: without the env var the hostname still wins — so the assertion above is the env's doing.
    expect(resolveBootstrapAgentName({}, 'mini.local')).toBe('mini.local');
    // Blank / all-junk env falls back to the hostname, then to my-agent.
    expect(resolveBootstrapAgentName({ PROVIAN_AGENT_NAME: '   ' }, 'mini.local')).toBe('mini.local');
    expect(resolveBootstrapAgentName({ PROVIAN_AGENT_NAME: '<>' }, '')).toBe('my-agent');
    // Markup never survives; length is capped with no trailing dash.
    expect(resolveBootstrapAgentName({ PROVIAN_AGENT_NAME: '<script>x</script>' }, 'h')).toBe('script-x--script');
    const long = resolveBootstrapAgentName({ PROVIAN_AGENT_NAME: `${'a'.repeat(39)} tail` }, 'h');
    expect(long.length).toBeLessThanOrEqual(BOOTSTRAP_AGENT_NAME_MAX);
    expect(long.endsWith('-')).toBe(false);
    expect(sanitizeBootstrapAgentName('--ok--')).toBe('ok');
  });

  it('defaultBootstrapDeps sends PROVIAN_AGENT_NAME and it does not move the agentId', () => {
    const before = defaultBootstrapDeps().agentIdentity();
    vi.stubEnv('PROVIAN_AGENT_NAME', 'Researcher Research Bot');
    try {
      const named = defaultBootstrapDeps().agentIdentity();
      expect(named.agentName).toBe('Researcher-Research-Bot');
      expect(named.agentId).toBe(before.agentId);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('a FAILED link request is recorded, never swallowed: linkRequested=false + error note', async () => {
    const { deps } = makeDeps({ fileLinkRequest: async () => ({ ok: false, error: 'http_404' }) });
    const res = await runAgentBootstrap({ connectionToken: 'PROV-ABCD-2345', relayUrl: 'https://api.provian.ai' }, deps);
    expect(res.linkRequested).toBe(false);
    expect(res.notes).toContain('link_request_error:http_404');
  });
});

describe('renderBootstrapOutcome — a link that did not file is a FAILURE, not a silent success', () => {
  const base: BootstrapResult = {
    walletId: 'wallet_aw_boot', address: '0xabc', recoveryEscrowed: true,
    deviceRegistered: true, observerStarted: true, commonsJoined: true,
    commonsJoinStatus: 'joined', linkRequested: true,
    linkStatus: 'pending', notes: [],
  };

  it('link filed (pending) -> exit 0, success on stdout, nothing on stderr', () => {
    const v = renderBootstrapOutcome(base);
    expect(v.exitCode).toBe(0);
    expect(v.stdout.join('\n')).toMatch(/Your agent wallet is set up/);
    expect(v.stdout.join('\n')).toMatch(/in the Commons/);
    expect(v.stdout.join('\n')).toMatch(/tap Accept to finish the link/);
    expect(v.stderr).toEqual([]);
  });

  it('opted out of the Commons -> no Commons success line, still exit 0', () => {
    const v = renderBootstrapOutcome({ ...base, commonsJoined: false, commonsJoinStatus: 'skipped' });
    expect(v.exitCode).toBe(0);
    expect(v.stdout.join('\n')).not.toMatch(/in the Commons/);
  });

  it('already linked -> exit 0', () => {
    const v = renderBootstrapOutcome({ ...base, linkStatus: 'already_linked' });
    expect(v.exitCode).toBe(0);
    expect(v.stdout.join('\n')).toMatch(/already linked/i);
  });

  it('RED CONTROL: link NOT filed -> exit 1, no success line on stdout, reason on stderr', () => {
    const v = renderBootstrapOutcome({
      ...base, linkRequested: false, linkStatus: undefined, notes: ['link_request_error:http_404'],
    });
    expect(v.exitCode).toBe(1);
    // never prints a reassuring success line
    expect(v.stdout).toEqual([]);
    expect(v.stdout.join('\n')).not.toMatch(/wallet is ready|set up|All set/);
    // says, in plain words, that nothing is linked and why
    const err = v.stderr.join('\n');
    expect(err).toMatch(/nothing is linked yet/);
    expect(err).toMatch(/not found|expired/);
    // never leaks the raw relay code
    expect(err).not.toMatch(/link_request_error:|http_404/);
  });

  it(' (A) RED CONTROL: link filed but device NOT registered -> exit 1, no success line', () => {
    const v = renderBootstrapOutcome({ ...base, deviceRegistered: false, observerStarted: false, notes: ['device_registration_failed'] });
    expect(v.exitCode).toBe(1);
    expect(v.stdout).toEqual([]);
    const err = v.stderr.join('\n');
    expect(err).toMatch(/could not be registered as its device/);
    expect(err).toMatch(/Paste the same command again/);
    expect(err).not.toMatch(/device_registration_failed/);
  });

  it(' (D): shim not listening -> no base-URL export lines are printed, and it says why', () => {
    const v = renderBootstrapOutcome({ ...base, modelProxyListening: false });
    const out = v.stdout.join('\n');
    expect(out).not.toMatch(/ANTHROPIC_BASE_URL=/);
    expect(out).toMatch(/do not repoint/);
  });

  it('10-20: success and failure both ask for ONE standing allow naming every host', () => {
    const hosts = ['api.provian.ai', ...EGRESS_ALLOW_HOSTS.map((h) => h.host)];
    for (const text of [
      renderBootstrapOutcome({ ...base, relayUrl: 'https://api.provian.ai' }).stdout.join('\n'),
      renderBootstrapOutcome({ ...base, relayUrl: 'https://api.provian.ai', deviceRegistered: false }).stderr.join('\n'),
    ]) {
      expect(text).toMatch(/ONE standing\s+allow covering every host/);
      for (const h of hosts) expect(text).toContain(`  ${h} — `);
    }
  });

  describe('what earns — never a self-reporting instruction', () => {
    const out = (o: Partial<BootstrapResult>) => renderBootstrapOutcome({ ...base, ...o }).stdout.join('\n');

    it('RED control — no install output, hosted or npm, asks the agent to report its own work ', () => {
      for (const hostedInstall of [true, false]) {
        for (const grokDetected of [true, false]) {
          const text = out({ hostedInstall, grokDetected, transcriptHarnesses: ['claude-code'] });
          expect({ hostedInstall, grokDetected, selfReport: /self-report|Self-reporting|\/v1\/witness|4319|submit_pe|report-pe|PROVIAN_WITNESS/.test(text) })
            .toEqual({ hostedInstall, grokDetected, selfReport: false });
          expect(text).toMatch(/You never report your own work/);
        }
      }
    });

    it(' §5 / tells hosted-bot users what earns — forge commits, Commons acts, on-chain acts, and tool calls where a transcript is written on the machine', () => {
      for (const hostedInstall of [true, false]) {
        const text = out({ hostedInstall });
        expect(text).toMatch(/A hosted bot earns from:/);
        expect(text).not.toMatch(/four witnesses/);
        expect(text).toMatch(/its tool calls: from the transcript its harness writes on this machine \(the transcript lane\)/);
        expect(text).toMatch(/its commits, through the forge webhooks/);
        expect(text).toMatch(/its Commons acts \(jobs, threads, forum, presentations\), each signed with its own key/);
        expect(text).toMatch(/its on-chain acts, signed with the same key/);
        expect(text).toMatch(/capture health shows which of those lanes are live/);
        // a Grok Bot keeps no transcript, so the process lane witnesses its commands; the stale "not witnessed" line is gone.
        expect(text).toMatch(/A Grok Bot writes no transcript on this machine, so the process lane witnesses each command it runs here\./);
        expect(text).toMatch(/where it writes none, from each command it runs here, read from the operating system\s+\(the process lane\)/);
        expect(text).not.toMatch(/not\s+witnessed|xAI's servers/);
        expect(text).not.toMatch(/tool calls (will )?earn\s+(when|once) xAI/);
      }
      expect(out({ hostedInstall: true })).toContain(AGENT_HELP_COMMAND_HOSTED);
      expect(out({ hostedInstall: false })).toContain(AGENT_HELP_COMMAND_NPX);
    });

    it(' §5 RED control: the superseded 09-28 hosted-bot copy (invisible to the daemon, not watching its chats) is gone', () => {
      const superseded = /no work the observer can see|no work a daemon lane can see|watching its chats|xAI's side/;
      // The detector catches the retired line…
      expect(superseded.test("here) has no work the observer can see. It earns from what it does through Provian")).toBe(true);
      expect(superseded.test('    acts — not from watching its chats.')).toBe(true);
      // …and no install output, hosted or npm, carries it.
      for (const hostedInstall of [true, false]) {
        for (const grokDetected of [true, false]) {
          expect(superseded.test(out({ hostedInstall, grokDetected, transcriptHarnesses: ['claude-code'] }))).toBe(false);
        }
      }
    });

    it('RED ( , defect 5): hosted output names the wrapper by absolute path — never bare `node` or a bare `provian`', () => {
      const text = out({ hostedInstall: true });
      expect(text).toContain('`"$HOME/.provian/bin/provian" help`');
      // No printed command depends on PATH: no bare `node …`, no bare `provian …`.
      expect(text).not.toMatch(/\bnode "/);
      expect(text).not.toMatch(/(^|[`\s])provian (help|fleet-code|balance|post|jobs|speech-window)\b/m);
      // Every printed command is the absolute wrapper, and each example names a verb the bundle
      // actually serves (bound to ACT_VERBS, not a copy).
      const commands = text.match(/"\$HOME\/\.provian\/bin\/provian" \S+/g) ?? [];
      expect(commands.length).toBeGreaterThanOrEqual(2 + AGENT_ACT_EXAMPLES_HOSTED.length); // help + fleet-code + examples
      expect(text).toContain('`"$HOME/.provian/bin/provian" fleet-code`');
      for (const e of AGENT_ACT_EXAMPLES_HOSTED) {
        expect(text).toContain(e);
        const verb = e.slice(AGENT_PROVIAN_COMMAND_HOSTED.length).trim().split(/\s+/)[0];
        expect(ACT_VERBS.map((v) => v.name)).toContain(verb);
      }
    });

    it('Windows (no sh wrapper): the PowerShell form calls the runtime by absolute path, never a bare `node`', () => {
      expect(hostedProvianCommand('win32', 'C:\\Users\\bot\\.provian\\node\\node.exe'))
        .toBe('& "C:\\Users\\bot\\.provian\\node\\node.exe" "$HOME/.provian/agent.js"');
      expect(hostedProvianCommand('linux', '/x/node')).toBe(AGENT_PROVIAN_COMMAND_HOSTED);
    });

    it('a machine whose harness sessions Provian reads is told they are recorded from their own records', () => {
      expect(out({ transcriptHarnesses: ['claude-code'] })).toMatch(/describe their location and record format/);
      expect(out({ transcriptHarnesses: [] })).not.toMatch(/This machine runs/);
    });

    it('a machine with Grok Build is told the proxy or the transcript records it — never hooks ', () => {
      const text = out({ grokDetected: true });
      expect(text).toMatch(/writes NO session files/);
      expect(text).toMatch(/do not repoint/);
      // A hooks LANE, never the forge's webhooks (§5 names those): whole word only.
      const hooksLane = /\bhooks\b/;
      expect(hooksLane.test('otherwise from Grok hooks')).toBe(true);
      expect(hooksLane.test('through the forge webhooks')).toBe(false);
      expect(text).not.toMatch(hooksLane);
      expect(out({})).not.toMatch(/Grok Build is installed here/);
    });

    it('the hosted entry marks its runs hostedInstall; the npm onboard entry does not; neither reads a witness opt-in', () => {
      const read = (f: string) => readFileSync(join(__dirname, 'scripts', f), 'utf8');
      expect(read('bootstrap.ts')).toMatch(/hostedInstall: true/);
      expect(read('onboard.ts')).not.toMatch(/hostedInstall/);
      expect(read('bootstrap.ts')).not.toMatch(/PROVIAN_WITNESS/);
      expect(read('onboard.ts')).not.toMatch(/PROVIAN_WITNESS/);
    });
  });

  it('link failure with a network error maps to a plain sentence', () => {
    const v = renderBootstrapOutcome({
      ...base, linkRequested: false, linkStatus: undefined, notes: ['link_request_error:network_error: ECONNREFUSED'],
    });
    expect(v.exitCode).toBe(1);
    expect(v.stderr.join('\n')).toMatch(/could not reach Provian/);
  });
});

// ---------------------------------------------------------------------------
// REAL-DEPS wire-shape contract (the sweep's confirmed finding): the mocked
// registerDevice dep above proves orchestration only. This block drives the
// PRODUCTION defaultBootstrapDeps().registerDevice against a captured fetch
// and asserts the request satisfies the relay route's actual admission
// contract — a stable Idempotency-Key equal to registration_id (the route
// 400s without it, devices.ts:545-552), which the pre-fix body omitted while
// this suite stayed green.
// ---------------------------------------------------------------------------
describe('defaultBootstrapDeps.registerDevice wire shape', () => {
  const WALLET_ID = 'wallet_aw_0f2b71e2-9f6e-4f1a-8f6a-1c2d3e4f5a6b';
  // A relay-shaped 201 body (devices.ts:942-945): real pdk_/pds_/dev_ tokens so
  // the SDK's writeCredentialsFile validators admit them.
  const RELAY_BODY = {
    device_id: `dev_${'a'.repeat(64)}`,
    device_key: `pdk_${'b'.repeat(32)}`,
    device_secret: `pds_${'c'.repeat(64)}`,
    device_name: 'agent-machine',
    owner_wallet_id: WALLET_ID,
    owner_type: 'agent',
  };

  async function capture(
    opts: { status?: number; body?: Record<string, unknown>; credsPath?: string } = {},
  ): Promise<{ headers: Record<string, string>; body: Record<string, unknown> }> {
    const status = opts.status ?? 201;
    const responseBody = opts.body ?? RELAY_BODY;
    let captured: { headers: Record<string, string>; body: Record<string, unknown> } | null = null;
    const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
      captured = {
        headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      };
      return { ok: status < 400, status, json: async () => responseBody } as unknown as Response;
    }) as typeof fetch;
    const deps = defaultBootstrapDeps(fakeFetch, { credsPath: opts.credsPath });
    await deps.registerDevice({
      relayUrl: 'https://api.provian.ai', walletId: WALLET_ID, apiKey: 'pvn_live_x', apiSecret: 'pvns_y',
    });
    if (!captured) throw new Error('fetch never called');
    return captured;
  }

  it('sends a stable Idempotency-Key equal to registration_id, in the route-admissible shape', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prov-creds-'));
    try {
      const req = await capture({ credsPath: join(dir, 'credentials') });
      const idem = req.headers['Idempotency-Key'];
      expect(typeof idem).toBe('string');
      expect(req.body.registration_id).toBe(idem);
      // Route contract: 16-128 canonical characters. Cross-package boundary
      // forces the literal here (backend cannot be imported); the equality
      // assertion above is the load-bearing half.
      expect(idem.length).toBeGreaterThanOrEqual(16);
      expect(idem.length).toBeLessThanOrEqual(128);
      expect(idem).toMatch(/^[A-Za-z0-9._-]+$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the key is derived from the wallet id (a crash-retry replays the same registration)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prov-creds-'));
    try {
      const first = await capture({ credsPath: join(dir, 'credentials') });
      const second = await capture({ credsPath: join(dir, 'credentials') });
      expect(first.headers['Idempotency-Key']).toBe(second.headers['Idempotency-Key']);
      expect(String(first.headers['Idempotency-Key'])).toContain(WALLET_ID);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('RED CONTROL: a non-2xx response throws (registration failure is never silent)', async () => {
    await expect(capture({ status: 400 })).rejects.toThrow(/device registration failed \(400\)/);
  });

  // ── F-A3-1 — the credential handoff (the sweep's HIGH silent gap) ──────────
  //
  // The pre-fix registerDevice only checked `if (!res.ok) throw` and DISCARDED
  // the 201 body — so no device_key/device_secret ever reached disk, the daemon's
  // loadCredentials() returned null, and it exit(1)'d silently while the bootstrap
  // printed success. This drives the PRODUCTION dep against a relay-shaped 201 into
  // a temp credentials file and asserts the observer can now authenticate: keys on
  // disk AND PROVIAN_OWNER_TYPE=agent (the owner gate that activates the capture
  // plugins). RED on pre-fix code (nothing was persisted).
  it('persists the returned device credentials as an AGENT device (observer can authenticate)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prov-creds-'));
    const credsPath = join(dir, 'credentials');
    try {
      await capture({ credsPath });
      const persisted = readCredentialsFile(credsPath);
      expect(persisted).not.toBeNull();
      expect(persisted!.deviceKey).toBe(RELAY_BODY.device_key);
      expect(persisted!.deviceSecret).toBe(RELAY_BODY.device_secret);
      // The owner gate: run-daemon.ts reads ownerType from this file and only an
      // 'agent' device activates Process/OTel/Transcript. A 'human' (or absent)
      // owner leaves the whole capture engine dormant.
      expect(persisted!.ownerType).toBe('agent');
      expect(persisted!.agentWalletId).toBe(WALLET_ID);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── negative control: the assertion above CAN observe absence ────────
  //
  // A 201 whose body carries no device_key is the exact pre-fix outcome
  // (nothing to persist). registerDevice must fail LOUD (not silently succeed),
  // and the credentials file must stay absent — proving the persistence
  // assertion is not a guard that cannot fail.
  it('RED — a 201 with no credentials in the body persists NOTHING and throws (not a silent success)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prov-creds-'));
    const credsPath = join(dir, 'credentials');
    try {
      await expect(capture({ body: { owner_type: 'agent' }, credsPath })).rejects.toThrow();
      expect(readCredentialsFile(credsPath)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The observer service command, chosen by CONTEXT: hosted bundle vs npm install.
// The hosted sh wrapper exports PROVIAN_BUNDLE_PATH; `npx @provian/agent-sdk
// onboard` never does. Both entrypoints reach this through the same
// `defaultBootstrapDeps().startObserver` (source-bound below), so the choice is
// made once, here, and tested without installing a service.
// ---------------------------------------------------------------------------
describe('bootstrapObserverEntrypoint — hosted bundle vs npm install', () => {
  it('hosted: PROVIAN_BUNDLE_PATH set → `node ~/.provian/agent.js observe`', async () => {
    const r = await bootstrapObserverEntrypoint({ PROVIAN_BUNDLE_PATH: '/home/a/.provian/agent.js' }, {execPath: '/home/a/.provian/node/bin/node'});
    expect(r).toEqual({ command: '/home/a/.provian/node/bin/node', args: ['/home/a/.provian/agent.js', 'observe'] });
  });

  it('npm (the onboard bin): no PROVIAN_BUNDLE_PATH → the installed dist/scripts/start-observer.js under this node', async () => {
    // Deterministic on any machine: inject a genuine-npm-install shape (dist, no
    // src/tsconfig, no hosted bundle) so the decision never reads this laptop's
    // real `~/.provian/agent.js` or whether `dist/` was built here. Previously
    // this probed the real filesystem — on any box running the daemon the hosted
    // bundle leaked in and the assertion flipped. The rule under test is
    // unchanged: an installed package runs its OWN compiled script, never the
    // bundle, never npx.
    const pkg = '/opt/homebrew/lib/node_modules/@provian/agent-sdk';
    const r = await bootstrapObserverEntrypoint({}, {
      execPath: process.execPath,
      moduleDir: `${pkg}/dist/observer`,
      hostedBundle: '/nowhere/agent.js',
      probe: { exists: () => false, isDir: () => false, realpath: (p) => p },
    });
    expect(r).toEqual({ command: process.execPath, args: [`${pkg}/dist/scripts/start-observer.js`] });
    expect(r.args.join('   ')).not.toMatch(/agent\.js observe/);
  });

  it('RED — an empty PROVIAN_BUNDLE_PATH is treated as unset (never `node "" observe`)', async () => {
    const r = await bootstrapObserverEntrypoint({ PROVIAN_BUNDLE_PATH: '' });
    expect(r.args[0]).not.toBe('');
    expect(r.args).not.toEqual(['', 'observe']);
  });
});

describe('defaultBootstrapDeps.startObserver installs the service with the EXPLICIT entrypoint', () => {
  // `startObserver` installs a launchd/systemd/schtasks service and writes shell
  // profiles, so it is not executed here; the wiring is source-bound, with a RED
  // that proves the scan reports the absence.
  const source = (): string => readFileSync(resolve(__dirname, 'bootstrap-flow.ts'), 'utf8');
  const installCall = (): string => {
    const src = source();
    const start = src.indexOf('installService({', src.indexOf('async startObserver()'));
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('});', start);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  };

  it('passes entrypoint: await bootstrapObserverEntrypoint(process.env) — never undefined, never a literal', () => {
    expect(installCall()).toContain('entrypoint: await bootstrapObserverEntrypoint(process.env),');
    expect(installCall()).not.toMatch(/entrypoint:\s*undefined/);
    expect(installCall()).not.toContain("'observe'");
  });

  it('RED — the scan reports ABSENT when the explicit choice is removed', () => {
    const mutated = installCall().replace('entrypoint: await bootstrapObserverEntrypoint(process.env),', '');
    expect(mutated).not.toContain('bootstrapObserverEntrypoint');
    expect(installCall().length).toBeGreaterThan(40);
  });
});

describe('renderBootstrapOutcome — git identity guidance (Part 2)', () => {
  const linked: BootstrapResult = {
    walletId: 'wallet_aw_x', address: '0xabc', recoveryEscrowed: true, deviceRegistered: true,
    observerStarted: true, commonsJoined: true, commonsJoinStatus: 'joined', linkRequested: true,
    linkStatus: 'pending', notes: [],
  };

  it('prints the exact register-git-identity command when a git author email was detected', () => {
    const v = renderBootstrapOutcome({ ...linked, gitAuthorEmail: 'atlas@example.com' });
    expect(v.exitCode).toBe(0);
    const text = v.stdout.join('\n');
    expect(text).toContain('npx @provian/agent-sdk register-git-identity --email atlas@example.com');
    expect(text).not.toMatch(/every (commit|push) (earns|mints)/i);
  });

  it('RED: no detected email → no guidance line at all', () => {
    for (const email of [null, undefined, '']) {
      const v = renderBootstrapOutcome({ ...linked, gitAuthorEmail: email as string | null | undefined });
      expect(v.stdout.join('\n')).not.toContain('register-git-identity');
    }
  });

  it('RED: guidance never appears on the failure path (a link that did not file prints no next step)', () => {
    const v = renderBootstrapOutcome({
      ...linked, linkRequested: false, linkStatus: undefined,
      gitAuthorEmail: 'atlas@example.com', notes: ['link_request_error:404'],
    });
    expect(v.exitCode).toBe(1);
    expect([...v.stdout, ...v.stderr].join('\n')).not.toContain('register-git-identity');
  });

  it('runAgentBootstrap threads the detected email into the result and tolerates a throwing reader', async () => {
    const { deps } = makeDeps();
    const withEmail = await runAgentBootstrap(
      { connectionToken: 'tok', relayUrl: 'https://r' },
      { ...deps, readGitAuthorEmail: () => 'atlas@example.com' },
    );
    expect(withEmail.gitAuthorEmail).toBe('atlas@example.com');
    const throwing = await runAgentBootstrap(
      { connectionToken: 'tok', relayUrl: 'https://r' },
      { ...deps, readGitAuthorEmail: () => { throw new Error('no git'); } },
    );
    expect(throwing.gitAuthorEmail).toBeNull();
    expect(throwing.linkRequested).toBe(true);
  });
});
