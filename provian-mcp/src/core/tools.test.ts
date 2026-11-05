import { createHash } from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import { callProvianTool, findTool, PROVIAN_TOOLS, replyInstructionFor, WHAT_EARNS_NOTE } from './tools';
import type { ToolContext } from './types';
import { generateAgentKeyPair } from './crypto';
import { assertServedToolSet, diffToolSet, registeredToolNames } from './tool-set';

type FetchStub = (url: string, init?: RequestInit) => Promise<Response>;
const DEVICE_ID = `dev_${'1'.repeat(64)}`;

function makeResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function ctxWith(overrides: Partial<ToolContext> & { fetchImpl?: FetchStub } = {}): ToolContext {
  const keyPair = generateAgentKeyPair();
  const loadPending = (context: Parameters<NonNullable<ToolContext['loadOrCreatePendingAgentWalletRegistration']>>[0]) => ({
    registrationId: 'mcp-agent-registration-test-fixture-0001',
    agentId: context.requested_agent_id ?? 'testbot-default-stable',
    agentName: context.agent_name,
    platform: context.platform,
    constitutionAcceptedAt: '2026-07-12T00:00:00.000Z',
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
    address: keyPair.address,
  });
  return {
    baseUrl: 'https://relay.test',
    fetchImpl: overrides.fetchImpl ?? (vi.fn(async () => makeResponse(500, { error: 'unexpected call' })) as unknown as typeof fetch),
    auth: null,
    mode: 'local',
    persistCredentials: () => '/tmp/agent-credentials.json',
    loadCompletedAgentWalletRegistration: () => null,
    loadOrCreatePendingAgentWalletRegistration: loadPending,
    reloadPendingAgentWalletRegistration: (_context, expected) => ({ ...expected }),
    completePendingAgentWalletRegistration: () => '/tmp/agent-wallet-identity.json',
    ...overrides,
  } as ToolContext;
}

function parseResult(result: { content: Array<{ type: string; text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

describe('tool registry', () => {
  it('the registry is non-empty, uniquely named, and every tool is well-formed', () => {
    // No redeclared literal list: every tool-list pin (server, dual-revision, the relay's /mcp)
    // binds to the registry through tool-set.ts. This test pins what makes a registry entry
    // serveable, over every registered tool.
    const names = PROVIAN_TOOLS.map((t) => t.name);
    expect(names.length).toBeGreaterThan(0);
    expect(diffToolSet(names).duplicates).toEqual([]);
    for (const tool of PROVIAN_TOOLS) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool.description.trim().length).toBeGreaterThan(0);
      expect(tool.inputSchema).toMatchObject({ type: 'object' });
      expect(typeof tool.handler).toBe('function');
      expect(findTool(tool.name)).toBe(tool);
    }
  });

  it('RED control: the comparator every tool-list pin uses rejects a missing, an extra and a duplicated tool', () => {
    const registered = registeredToolNames();
    expect(registered.length).toBeGreaterThan(1);
    expect(() => assertServedToolSet(registered)).not.toThrow();
    expect(() => assertServedToolSet(registered.slice(1))).toThrow(`missing [${registered[0]}]`);
    expect(() => assertServedToolSet([...registered, 'phantom_tool'])).toThrow('extra [phantom_tool]');
    expect(() => assertServedToolSet([...registered, registered[0]])).toThrow(`duplicated [${registered[0]}]`);
    expect(() => assertServedToolSet([], [])).toThrow(/registry is empty/);
  });

  it('never enforces auth for the bootstrap tools', () => {
    expect(findTool('create_wallet')!.requiresAuth).toBe(false);
    expect(findTool('get_agent_record')!.requiresAuth).toBe(false);
    expect(findTool('get_pvt_estimate')!.requiresAuth).toBe(false);
  });

  it('returns a helpful error for unknown tools', async () => {
    const result = await callProvianTool('does_not_exist', {}, ctxWith());
    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain('Unknown tool');
  });

  it('apply_job and deliver_job require auth (write tools)', () => {
    expect(findTool('apply_job')!.requiresAuth).toBe(true);
    expect(findTool('deliver_job')!.requiresAuth).toBe(true);
  });
});

describe('intent-board act tools (work package O14)', () => {
  const AUTH = { apiKey: 'pvn_live_k', apiSecret: 'pvns_s' } as unknown as ToolContext['auth'];

  it('apply_job POSTs the proposal to the job apply endpoint with agent creds', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchStub = async (url, init) => {
      calls.push({ url, init });
      return makeResponse(200, { id: 'job_x', status: 'open' });
    };
    const ctx = ctxWith({ auth: AUTH, fetchImpl });
    const result = await callProvianTool('apply_job', { job_id: 'hjob_x', proposal: 'I can do this' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    // the ONE Commons board; the proposal rides as the cover note.
    expect(calls[0].url).toBe('https://relay.test/v1/commons/jobs/hjob_x/apply');
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ cover_note: 'I can do this' });
    // carries agent credentials (the auth boundary — not a client-asserted identity)
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer pvn_live_k:pvns_s');
  });

  it('apply_job requires job_id and proposal', async () => {
    const ctx = ctxWith({ auth: AUTH });
    expect(parseResult(await callProvianTool('apply_job', { proposal: 'x' }, ctx)).error).toContain('job_id');
    expect(parseResult(await callProvianTool('apply_job', { job_id: 'j' }, ctx)).error).toContain('proposal');
  });

  it('apply_job without credentials is blocked by the dispatcher (never reaches the relay)', async () => {
    const fetchImpl = vi.fn();
    const ctx = ctxWith({ auth: null, fetchImpl: fetchImpl as unknown as FetchStub });
    const result = await callProvianTool('apply_job', { job_id: 'j', proposal: 'p' }, ctx);
    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain('requires agent API credentials');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('deliver_job routes a Commons hjob_ id to the Commons deliver endpoint with the deliverable', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchStub = async (url, init) => {
      calls.push({ url, init });
      return makeResponse(200, { job_id: 'hjob_y' });
    };
    await callProvianTool('deliver_job', { job_id: 'hjob_y', deliverable_uri: 'https://example.com/r' }, ctxWith({ auth: AUTH, fetchImpl }));
    expect(calls[0].url).toBe('https://relay.test/v1/commons/jobs/hjob_y/deliver');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ deliverable_uri: 'https://example.com/r' });
  });

  it('deliver_job keeps an in-flight legacy job_ id on its old route and surfaces relay errors', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchStub = async (url, init) => {
      calls.push({ url, init });
      return makeResponse(403, { error: 'only the assigned agent may deliver' });
    };
    const ctx = ctxWith({ auth: AUTH, fetchImpl });
    const result = await callProvianTool('deliver_job', { job_id: 'job_y' }, ctx);
    expect(calls[0].url).toBe('https://relay.test/v1/jobs/job_y/deliver');
    expect(calls[0].init?.method).toBe('POST');
    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain('HTTP 403');
  });
});

describe('create_wallet', () => {
  it('runs the full PoP flow and returns credentials with the warning', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const keyPair = generateAgentKeyPair();
    const pending = {
      registrationId: 'mcp-agent-registration-test-fixture-0001',
      agentId: 'testbot-default-stable',
      agentName: 'TestBot',
      platform: 'mcp',
      constitutionAcceptedAt: '2026-07-12T00:00:00.000Z',
      privateKey: keyPair.privateKey,
      publicKey: keyPair.publicKey,
      address: keyPair.address,
    };
    const fetchImpl: FetchStub = async (url, init) => {
      calls.push({ url, init });
      if (url.includes('/v1/agent/wallet/challenge')) {
        return makeResponse(200, { challenge_id: 'ch_1', challenge: 'sign-me', expires_at: 9 });
      }
      if (url.endsWith('/v1/agent/wallet/create')) {
        const body = JSON.parse(String(init?.body));
        expect(body.agent_name).toBe('TestBot');
        expect(body.platform).toBe('mcp');
        expect(body.challenge_id).toBe('ch_1');
        expect(body.public_key).toMatch(/^[0-9a-f]{128}$/);
        expect(body.signature).toMatch(/^[0-9a-f]+$/);
        return makeResponse(201, {
          wallet_id: 'wallet_aw_x',
          address: keyPair.address,
          public_key: keyPair.publicKey,
          api_key: 'pvn_live_' + 'a'.repeat(32),
          api_secret: 'pvns_' + 'b'.repeat(64),
          pe_chain_root: 'pe_root',
          governance_score: 50,
          badges: [],
          welcome: { hello: true },
        });
      }
      return makeResponse(404, { error: 'unexpected' });
    };

    const persisted: unknown[] = [];
    const completed = vi.fn(() => '/tmp/agent-wallet-identity.json');
    const ctx = ctxWith({
      fetchImpl,
      loadOrCreatePendingAgentWalletRegistration: () => pending,
      persistCredentials: (creds) => {
        persisted.push(creds);
        return '/tmp/agent-credentials.json';
      },
      completePendingAgentWalletRegistration: completed,
    });

    const result = await callProvianTool('create_wallet', { agent_name: 'TestBot' }, ctx);
    expect(result.isError).toBeUndefined();
    const body = parseResult(result);
    expect(body.warning).toContain('STORE THESE SECURELY');
    expect(body.wallet_id).toBe('wallet_aw_x');
    expect(body.api_key).toContain('pvn_live_');
    // F32: the sovereign private key is NEVER returned to the model context.
    expect(body.private_key).toBeUndefined();
    expect(body.credentials_persisted_to).toBe('/tmp/agent-credentials.json');
    expect(persisted).toHaveLength(1);
    expect(completed).toHaveBeenCalledWith(
      'mcp-agent-registration-test-fixture-0001',
      { wallet_id: 'wallet_aw_x', address: keyPair.address },
      {
        relay_url: 'https://relay.test',
        agent_name: 'TestBot',
        requested_agent_id: null,
        platform: 'mcp',
      },
    );
    expect(calls[1]?.url).toBe('https://relay.test/v1/agent/wallet/create');
    expect(calls[0]?.url).toContain('registration_id=mcp-agent-registration-test-fixture-0001');
    expect(calls.some((call) => call.url.includes('/v1/wallet/agent/create'))).toBe(false);
    // Never persist the private key alongside API creds
    expect(JSON.stringify(persisted[0])).not.toContain(keyPair.privateKey);
    // The relay never received the private key either
    for (const call of calls) {
      expect(String(call.init?.body ?? '')).not.toContain(keyPair.privateKey);
    }
    // F32: and the private key is nowhere in the tool result the model sees.
    expect(JSON.stringify(body)).not.toContain(keyPair.privateKey);
  });



  it('remote mode fails before key generation or networking', async () => {
    const fetchImpl = vi.fn();
    const persist = vi.fn(() => '/never');
    const pending = vi.fn();
    const ctx = ctxWith({
      fetchImpl: fetchImpl as unknown as FetchStub,
      mode: 'remote',
      persistCredentials: persist,
      loadOrCreatePendingAgentWalletRegistration: pending,
    });
    const result = await callProvianTool('create_wallet', { agent_name: 'R' }, ctx);
    expect(persist).not.toHaveBeenCalled();
    expect(pending).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain('Remote create_wallet is disabled before key generation');
  });

  it('reloads durable pending identity after the challenge and makes no POST after mutation', async () => {
    const keyPair = generateAgentKeyPair();
    const pending = {
      registrationId: 'mcp-agent-registration-mutation-0001',
      agentId: 'mutation-agent',
      agentName: 'Mutation Agent',
      platform: 'mcp',
      constitutionAcceptedAt: '2026-07-12T00:00:00.000Z',
      privateKey: keyPair.privateKey,
      publicKey: keyPair.publicKey,
      address: keyPair.address,
    };
    const fetchImpl = vi.fn(async (url: string) => {
      if (!url.includes('/challenge')) throw new Error('create POST must not run');
      pending.agentName = 'Mutated After Persistence';
      return makeResponse(200, { challenge_id: 'challenge-mutation', challenge: 'sign-me' });
    });
    const result = await callProvianTool('create_wallet', {
      agent_name: 'Mutation Agent',
      agent_id: 'mutation-agent',
    }, ctxWith({
      fetchImpl: fetchImpl as unknown as FetchStub,
      loadOrCreatePendingAgentWalletRegistration: () => pending,
      reloadPendingAgentWalletRegistration: () => {
        throw new Error('durable snapshot no longer matches');
      },
    }));
    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain('durable snapshot no longer matches');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('replays a completed local identity after a lost tool response without networking', async () => {
    const keyPair = generateAgentKeyPair();
    const fetchImpl = vi.fn();
    const loadPending = vi.fn();
    const completed = vi.fn(() => ({
      registrationId: 'mcp-agent-registration-completed-0001',
      agentId: 'completed-agent',
      agentName: 'Completed Agent',
      platform: 'mcp',
      constitutionAcceptedAt: '2026-07-12T00:00:00.000Z',
      privateKey: keyPair.privateKey,
      publicKey: keyPair.publicKey,
      address: keyPair.address,
      walletId: 'wallet_aw_completed',
      apiKey: 'pvn_live_' + 'a'.repeat(32),
      apiSecret: 'pvns_' + 'b'.repeat(64),
      credentialsPersistedTo: '/tmp/agent-credentials.json',
    }));
    const result = await callProvianTool('create_wallet', {
      agent_name: 'Completed Agent',
      agent_id: 'completed-agent',
    }, ctxWith({
      fetchImpl: fetchImpl as unknown as FetchStub,
      loadCompletedAgentWalletRegistration: completed,
      loadOrCreatePendingAgentWalletRegistration: loadPending,
    }));
    expect(result.isError).toBeUndefined();
    expect(parseResult(result)).toMatchObject({
      wallet_id: 'wallet_aw_completed',
      recovered_from_completed_local_identity: true,
    });
    expect(completed).toHaveBeenCalledWith({
      relay_url: 'https://relay.test',
      agent_name: 'Completed Agent',
      requested_agent_id: 'completed-agent',
      platform: 'mcp',
    });
    expect(loadPending).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('surfaces relay errors', async () => {
    const ctx = ctxWith({ fetchImpl: async () => makeResponse(429, { error: 'Rate limit exceeded.' }) });
    const result = await callProvianTool('create_wallet', { agent_name: 'X' }, ctx);
    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain('HTTP 429');
  });

  it.each([
    { label: 'default agent ID', args: { agent_name: 'Retry Bot' }, agentId: 'retry-bot-stable-default' },
    { label: 'explicit agent ID', args: { agent_name: 'Retry Bot', agent_id: 'retry-bot-explicit' }, agentId: 'retry-bot-explicit' },
  ])('reuses one pending ID/key after an ambiguous response ($label)', async ({ args, agentId }) => {
    const keyPair = generateAgentKeyPair();
    const pending = {
      registrationId: `mcp-agent-registration-${agentId}-0001`,
      agentId,
      agentName: 'Retry Bot',
      platform: 'mcp',
      constitutionAcceptedAt: '2026-07-12T00:00:00.000Z',
      privateKey: keyPair.privateKey,
      publicKey: keyPair.publicKey,
      address: keyPair.address,
    };
    const posted: Record<string, unknown>[] = [];
    let invocation = 0;
    const fetchImpl: FetchStub = async (url, init) => {
      if (url.includes('/challenge')) {
        invocation += 1;
        return makeResponse(200, { challenge_id: `challenge-${invocation}`, challenge: 'x' });
      }
      posted.push(JSON.parse(String(init?.body)));
      if (invocation === 1) throw new Error('lost response after commit');
      return makeResponse(200, {
        wallet_id: 'wallet_aw_recovered',
        address: keyPair.address,
        public_key: keyPair.publicKey,
        api_key: 'pvn_live_' + 'a'.repeat(32),
        api_secret: 'pvns_' + 'b'.repeat(64),
        pe_chain_root: 'pe_birth',
      });
    };
    const loadPending = vi.fn(() => pending);
    const ctx = ctxWith({
      fetchImpl,
      loadOrCreatePendingAgentWalletRegistration: loadPending,
    });
    const ambiguous = await callProvianTool('create_wallet', args, ctx);
    expect(ambiguous.isError).toBe(true);
    expect(parseResult(ambiguous).error).toContain('lost response after commit');
    const recovered = await callProvianTool('create_wallet', args, ctx);
    expect(recovered.isError).toBeUndefined();
    expect(loadPending).toHaveBeenCalledTimes(2);
    expect(posted).toHaveLength(2);
    expect(posted[1]).toMatchObject({
      registration_id: posted[0].registration_id,
      agent_id: posted[0].agent_id,
      public_key: posted[0].public_key,
      constitution_accepted_at: posted[0].constitution_accepted_at,
    });
    expect(posted[1].agent_id).toBe(agentId);
  });

  it('retains pending state and credentials when a 2xx wallet response is malformed or mismatched', async () => {
    const keyPair = generateAgentKeyPair();
    const persist = vi.fn(() => '/never');
    const complete = vi.fn(() => '/never');
    const fetchImpl: FetchStub = async (url) => url.includes('/challenge')
      ? makeResponse(200, { challenge_id: 'challenge-malformed', challenge: 'x' })
      : makeResponse(200, {
        wallet_id: 'wallet_aw_malformed',
        address: '0x' + '1'.repeat(40),
        public_key: keyPair.publicKey,
        api_key: 'not-an-api-key',
        api_secret: 'not-an-api-secret',
      });
    const result = await callProvianTool('create_wallet', {
      agent_name: 'Malformed Bot',
      agent_id: 'malformed-bot',
    }, ctxWith({
      fetchImpl,
      persistCredentials: persist,
      completePendingAgentWalletRegistration: complete,
      loadOrCreatePendingAgentWalletRegistration: () => ({
        registrationId: 'mcp-agent-registration-malformed-0001',
        agentId: 'malformed-bot',
        agentName: 'Malformed Bot',
        platform: 'mcp',
        constitutionAcceptedAt: '2026-07-12T00:00:00.000Z',
        privateKey: keyPair.privateKey,
        publicKey: keyPair.publicKey,
        address: keyPair.address,
      }),
    }));
    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain('malformed or mismatched');
    expect(persist).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('auth pre-flight guidance', () => {
  it.each(['genesis_status', 'browse_jobs', 'link_external_address'])(
    '%s without any credentials returns guidance, not a relay call',
    async (name) => {
      const fetchImpl = vi.fn();
      const result = await callProvianTool(name, { wallet_id: 'w', address: '0x' + 'a'.repeat(40) }, ctxWith({ fetchImpl: fetchImpl as unknown as FetchStub }));
      expect(result.isError).toBe(true);
      expect(parseResult(result).error).toContain('create_wallet');
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('mentions the Authorization header in remote mode', async () => {
    const result = await callProvianTool('browse_jobs', {}, ctxWith({ mode: 'remote' }));
    expect(parseResult(result).error).toContain('Authorization: Bearer <api_key>:<api_secret>');
  });
});

describe('genesis_status', () => {
  it('forwards Bearer credentials to the relay', async () => {
    let seenAuth: string | undefined;
    const fetchImpl: FetchStub = async (url, init) => {
      expect(url).toBe('https://relay.test/v1/agent/genesis/status/wallet_aw_1');
      seenAuth = (init?.headers as Record<string, string>)?.Authorization;
      return makeResponse(200, { wallet_id: 'wallet_aw_1', genesis_pvt_earned: 75 });
    };
    const ctx = ctxWith({ fetchImpl, auth: { apiKey: 'pvn_live_k', apiSecret: 'pvns_s' } });
    const result = await callProvianTool('genesis_status', { wallet_id: 'wallet_aw_1' }, ctx);
    expect(seenAuth).toBe('Bearer pvn_live_k:pvns_s');
    expect(parseResult(result).genesis_pvt_earned).toBe(75);
  });

  it('finding 20: the description is well-formed — "no depletable pool", not the garbled fragment', () => {
    const desc = findTool('genesis_status')!.description;
    // RED baseline: the shipped text read "admitting through <the close> or
    // depletable pool, and this status..." — a mangled clause.
    expect(desc).not.toContain('or depletable pool');
    expect(desc).toContain('with no depletable pool');
    // Genesis is open through December 31, 2026 (close 2027-01-01T00:00:00Z).
    expect(desc).toContain('through December 31, 2026');
    expect(desc).not.toContain('2026-10-26');
  });
});

describe('no MCP path records an agent\'s own claim about its work', () => {
  // The removed report tools, named once. A PE exists only when something other than the
  // actor vouches for it; a tool whose input is the agent's own description of its work
  // (caller-chosen action_type / metadata) is a declaration, never a PE.
  const REMOVED_REPORT_TOOLS = ['submit_pe', 'submit_sovereign_work'];
  const SELF_REPORT_COPY = /submit_pe|submit_sovereign_work|report tools|record your (first )?action|mcp_self_report/i;

  it('the registry serves neither report tool, and calling one is an unknown tool', async () => {
    expect(PROVIAN_TOOLS.length).toBeGreaterThan(5);
    for (const name of REMOVED_REPORT_TOOLS) {
      expect(findTool(name)).toBeUndefined();
      expect(registeredToolNames()).not.toContain(name);
      const fetchImpl = vi.fn(async () => makeResponse(201, { pe_id: 'pe_should_not_exist' }));
      const result = await callProvianTool(name, { action_type: 'agent_task_completed' }, ctxWith({
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }));
      expect(result.isError).toBe(true);
      expect(parseResult(result).error).toContain('Unknown tool');
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('no tool description or schema tells an agent to report its own work', () => {
    expect(PROVIAN_TOOLS.length).toBeGreaterThan(5);
    for (const tool of PROVIAN_TOOLS) {
      expect(`${tool.name}: ${tool.description}`).not.toMatch(SELF_REPORT_COPY);
      expect(JSON.stringify(tool.inputSchema)).not.toMatch(SELF_REPORT_COPY);
    }
  });

  it('request_link, once linked, does not send the agent to a report tool', async () => {
    const fetchImpl = vi.fn(async () => makeResponse(200, { status: 'linked' }));
    const result = await callProvianTool('request_link', { wallet_id: 'wallet_aw_abc12345', connection_token: 'PROV-ABCD-EFGH' }, ctxWith({
      mode: 'remote',
      auth: { apiKey: `pvn_live_${'a'.repeat(32)}`, apiSecret: `pvns_${'b'.repeat(64)}` },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }));
    const out = parseResult(result);
    expect(String(out.next)).toMatch(/linked to your human/);
    expect(String(out.next)).not.toMatch(SELF_REPORT_COPY);
  });

  it('[negative control] the copy needle matches the pre- wording', () => {
    expect('You are linked to your human. Record your work with the report tools.').toMatch(SELF_REPORT_COPY);
    expect('Call submit_pe to record your first action as a Provenance Envelope.').toMatch(SELF_REPORT_COPY);
  });

  // §5: every "what earns" surface names the four witnesses.
  const FOUR_WITNESSES = [/transcript lane/, /forge webhooks/, /Commons acts/, /on-chain acts signed with your own key/, /[Cc]apture health/];

  it(' §5: WHAT_EARNS_NOTE names the four witnesses and capture health, and never self-reporting', () => {
    for (const w of FOUR_WITNESSES) expect(WHAT_EARNS_NOTE).toMatch(w);
    expect(WHAT_EARNS_NOTE).not.toMatch(SELF_REPORT_COPY);
    expect(WHAT_EARNS_NOTE).not.toMatch(/\bonly\b|eligib/i);
    // an agent's own machine with no transcript is witnessed by the process lane; the stale "not witnessed" line is gone.
    expect(WHAT_EARNS_NOTE).toMatch(/the process lane witnesses each command you run there, read from the operating system; a hosted Grok Bot is witnessed this way\./);
    expect(WHAT_EARNS_NOTE).not.toMatch(/not witnessed|xAI's servers/);
    expect(WHAT_EARNS_NOTE).not.toMatch(/when xAI's runtime writes/);
    // one-witness ladder: the tool-call clause names every lane in order — session files, the
    // local model proxy, OTel, then the process lane — not the transcript and process lanes alone.
    expect(WHAT_EARNS_NOTE).toMatch(/Each program has exactly one tool witness: its session files if it keeps them \(the transcript lane\), otherwise the local model proxy, otherwise OTel\. On a machine of your own where none of those applies, the process lane/);
  });

  it(' §5: wallet_create carries the note; request_link (linked) returns it', async () => {
    const walletCreate = PROVIAN_TOOLS.find((t) => t.name === 'wallet_create');
    expect(walletCreate?.description).toContain(WHAT_EARNS_NOTE);
    const fetchImpl = vi.fn(async () => makeResponse(200, { status: 'linked' }));
    const result = await callProvianTool('request_link', { wallet_id: 'wallet_aw_abc12345', connection_token: 'PROV-ABCD-EFGH' }, ctxWith({
      mode: 'remote',
      auth: { apiKey: `pvn_live_${'a'.repeat(32)}`, apiSecret: `pvns_${'b'.repeat(64)}` },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }));
    const next = String(parseResult(result).next);
    for (const w of FOUR_WITNESSES) expect(next).toMatch(w);
  });

  it('[negative control] the four-witness needles reject the hosted-bot wording', () => {
    const old = 'You are linked to your human. Your work is recorded by the Provian observer on the machine you run on and by the witnesses behind the Commons and on-chain tools; there is nothing to report yourself.';
    expect(FOUR_WITNESSES.filter((w) => w.test(old)).length).toBe(0);
  });
});

describe('get_agent_record', () => {
  it('returns the record with badge and profile links when live', async () => {
    const fetchImpl: FetchStub = async (url) => {
      expect(url).toBe('https://relay.test/v1/agents/wallet_aw_2/record');
      return makeResponse(200, { record: 'Provenance Record', pe_count: 12 });
    };
    const result = await callProvianTool('get_agent_record', { agent_id: 'wallet_aw_2' }, ctxWith({ fetchImpl }));
    const body = parseResult(result);
    expect(body.pe_count).toBe(12);
    expect(body.badge_url).toBe('https://relay.test/v1/agents/wallet_aw_2/badge.svg');
    expect(body.profile_page).toBe('https://provian.ai/a/wallet_aw_2');
  });

  it('falls back to the public agent profile while /record is not live', async () => {
    const fetchImpl: FetchStub = async (url) => {
      if (url.endsWith('/record')) return makeResponse(404, { error: 'not found' });
      expect(url).toBe('https://relay.test/v1/agents/wallet_aw_2/profile');
      return makeResponse(200, { wallet_id: 'wallet_aw_2', pe_count: 3 });
    };
    const result = await callProvianTool('get_agent_record', { agent_id: 'wallet_aw_2' }, ctxWith({ fetchImpl }));
    const body = parseResult(result);
    expect(body.record_source).toBe('public_profile_fallback');
    expect((body.profile as Record<string, unknown>).pe_count).toBe(3);
    expect(body.badge_url).toBe('https://relay.test/v1/agents/wallet_aw_2/badge.svg');
  });

  it('finding 13a: forwards the caller Bearer on the record read so the onboarding gate can admit it', async () => {
    let seenAuth: string | null = null;
    const fetchImpl: FetchStub = async (_url, init) => {
      seenAuth = new Headers(init?.headers).get('Authorization');
      return makeResponse(200, { pe_count: 1 });
    };
    await callProvianTool(
      'get_agent_record',
      { agent_id: 'wallet_aw_2' },
      ctxWith({ fetchImpl, auth: { apiKey: 'pvn_live_x', apiSecret: 'sek' } }),
    );
    expect(seenAuth).toBe('Bearer pvn_live_x:sek');
  });

  it('finding 13a RED: an anonymous caller sends NO Authorization (gate stays fail-closed)', async () => {
    let seenAuth: string | null = 'sentinel';
    const fetchImpl: FetchStub = async (_url, init) => {
      seenAuth = new Headers(init?.headers).get('Authorization');
      return makeResponse(200, { pe_count: 1 });
    };
    await callProvianTool('get_agent_record', { agent_id: 'wallet_aw_2' }, ctxWith({ fetchImpl, auth: null }));
    expect(seenAuth).toBeNull();
  });
});

describe('get_pvt_estimate', () => {
  it('finding 13b: advertises novelty and count as non-negative INTEGERS, matching the backend', () => {
    const tool = findTool('get_pvt_estimate')!;
    const props = (tool.inputSchema as {
      properties: Record<string, { type: string; minimum?: number; description: string }>;
    }).properties;
    // RED baseline: both were `type: 'number'` with a fractional "Novelty factor
    // 0–1" description, which the backend's integer-count parser rejects with a
    // 400. The corrected schema is an integer occurrence count.
    expect(props.novelty.type).toBe('integer');
    expect(props.novelty.minimum).toBe(0);
    expect(props.novelty.description).toMatch(/already recorded|occurrence count/i);
    expect(props.count.type).toBe('integer');
    expect(props.count.minimum).toBe(0);
  });

  it('passes query parameters through', async () => {
    const fetchImpl: FetchStub = async (url) => {
      expect(url).toBe('https://relay.test/v1/pvt/estimate?action_type=code_review&attestation_tier=software&count=5');
      return makeResponse(200, { estimated_pvt: 0.56, disclaimers: ['records-not-money'] });
    };
    const result = await callProvianTool(
      'get_pvt_estimate',
      { action_type: 'code_review', attestation_tier: 'software', count: 5 },
      ctxWith({ fetchImpl }),
    );
    expect(parseResult(result).estimated_pvt).toBe(0.56);
  });

  it('offers retry guidance when the estimator read fails (404)', async () => {
    const result = await callProvianTool(
      'get_pvt_estimate',
      { action_type: 'x' },
      ctxWith({ fetchImpl: async () => makeResponse(404, { error: 'not found' }) }),
    );
    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain('pricing estimate could not be loaded');
  });

  //. The relay this tool actually talks to answers 503, not 404: the runtime boundary
  // runtime boundary refuses `/v1/pvt/*` before routing. Falling through to the
  // generic relay-error path surfaced a bare "PVT estimate failed with HTTP 503",
  // which reads to an agent as a broken relay rather than an unavailable feature.
  it('degrades the SAME WAY on the boundary 503 as on 404', async () => {
    const result = await callProvianTool(
      'get_pvt_estimate',
      { action_type: 'x' },
      ctxWith({
        fetchImpl: async () => makeResponse(503, {
          error: 'PVT9_DEPENDENCY_UNAVAILABLE',
          code: 'PVT9_DEPENDENCY_UNAVAILABLE',
          dependency: 'pvt_runtime',
        }),
      }),
    );
    expect(result.isError).toBe(true);
    const { error } = parseResult(result);
    expect(error).toContain('pricing estimate could not be loaded');
    // The regression being pinned: NOT the generic relay-failure wording.
    expect(error).not.toContain('failed with HTTP');
  });

  // The old 404 text sent callers to GET /v1/pvt/weights, which the SAME boundary
  // closes — a fallback that is itself unreachable is worse than none, because the
  // agent spends a round trip to learn nothing. Pinned so it cannot come back.
  it('does not point callers at a fallback the same boundary closes', async () => {
    for (const status of [404, 503]) {
      const result = await callProvianTool(
        'get_pvt_estimate',
        { action_type: 'x' },
        ctxWith({ fetchImpl: async () => makeResponse(status, { error: 'x' }) }),
      );
      const { error } = parseResult(result);
      expect(error).not.toContain('/v1/pvt/weights');
      // and it names the alternative that IS reachable today
      expect(error).toContain('disposition, reason and sealed points');
      expect(error).not.toContain('Submit the PE');
    }
  });
});

describe('browse_jobs', () => {
  it('reads the ONE Commons board with seeking / posted_by / currency filters and forwards auth', async () => {
    const fetchImpl: FetchStub = async (url, init) => {
      expect(url).toBe('https://relay.test/v1/commons/jobs?seeking=agent&posted_by=human&currency=usdc&page_size=10');
      expect((init?.headers as Record<string, string>).Authorization).toContain('Bearer pvn_live_');
      return makeResponse(200, { jobs: [], total: 0, featured: [] });
    };
    const ctx = ctxWith({ fetchImpl, auth: { apiKey: 'pvn_live_k', apiSecret: 'pvns_s' } });
    const result = await callProvianTool('browse_jobs', { seeking: 'agent', posted_by: 'human', currency: 'usdc', page_size: 10 }, ctx);
    expect(parseResult(result).total).toBe(0);
  });
});

describe('link_external_address', () => {
  it('its description states the commerce rule as built: sends, swaps, dealt-counterparty receives, every known token, no "eligible"', () => {
    const description = findTool('link_external_address')!.description;
    const states = (text: string): boolean =>
      /sends, swaps/.test(text) && /receives from a counterparty it has dealt with/.test(text) && /every known token on Base/.test(text) && !/eligib/i.test(text);
    expect(states(description)).toBe(true);
    // RED control: the line the status check found fails the same predicate.
    expect(states('From H+1 onward, eligible financial activity can map to PEs on the standard mint path.')).toBe(false);
  });

  const auth = { apiKey: 'pvn_live_k', apiSecret: 'pvns_s' };
  const address = '0x' + '1'.repeat(40);

  it('challenge step returns the message and next-step instructions', async () => {
    const fetchImpl: FetchStub = async (url, init) => {
      expect(url).toBe('https://relay.test/v1/agent/external-address/challenge');
      expect(JSON.parse(String(init?.body)).address).toBe(address);
      return makeResponse(200, { challenge_id: 'ch_9', message: 'Provian proof: nonce abc' });
    };
    const result = await callProvianTool('link_external_address', { address, step: 'challenge' }, ctxWith({ fetchImpl, auth }));
    const body = parseResult(result);
    expect(body.challenge_id).toBe('ch_9');
    expect(body.next_step).toContain('step="verify"');
  });

  it('verify step posts the signature', async () => {
    const fetchImpl: FetchStub = async (url, init) => {
      expect(url).toBe('https://relay.test/v1/agent/external-address/verify');
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ address, challenge_id: 'ch_9', signature: '0xsig' });
      return makeResponse(200, { ok: true, proven_address: address, pe_id: 'pe_link' });
    };
    const result = await callProvianTool(
      'link_external_address',
      { address, step: 'verify', challenge_id: 'ch_9', signature: '0xsig' },
      ctxWith({ fetchImpl, auth }),
    );
    expect(parseResult(result).ok).toBe(true);
  });

  it('rejects external_private_key on the remote endpoint', async () => {
    const fetchImpl = vi.fn();
    const result = await callProvianTool(
      'link_external_address',
      { address, external_private_key: 'f'.repeat(64) },
      ctxWith({ fetchImpl: fetchImpl as unknown as FetchStub, auth, mode: 'remote' }),
    );
    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain('never send private keys');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('single-call local mode signs the challenge and verifies (key never sent)', async () => {
    // Deterministic key: derive its address to use as the link target.
    const { generateAgentKeyPair } = await import('./crypto');
    const { signEip191Message } = await import('../eip191');
    const kp = generateAgentKeyPair();

    const sentBodies: string[] = [];
    const fetchImpl: FetchStub = async (url, init) => {
      sentBodies.push(String(init?.body ?? ''));
      if (url.endsWith('/challenge')) {
        return makeResponse(200, { challenge_id: 'ch_1', message: 'sign this to prove control' });
      }
      const body = JSON.parse(String(init?.body));
      expect(body.signature).toBe(signEip191Message(kp.privateKey, 'sign this to prove control'));
      return makeResponse(200, { ok: true, proven_address: kp.address });
    };
    const ctx = ctxWith({ fetchImpl, auth, signEip191: signEip191Message });
    const result = await callProvianTool(
      'link_external_address',
      { address: kp.address, external_private_key: kp.privateKey },
      ctx,
    );
    expect(parseResult(result).ok).toBe(true);
    for (const body of sentBodies) expect(body).not.toContain(kp.privateKey);
  });

  it('rejects a key that does not match the address', async () => {
    const { generateAgentKeyPair } = await import('./crypto');
    const { signEip191Message } = await import('../eip191');
    const kp = generateAgentKeyPair();
    const fetchImpl: FetchStub = async () => makeResponse(200, { challenge_id: 'c', message: 'm' });
    const result = await callProvianTool(
      'link_external_address',
      { address, external_private_key: kp.privateKey },
      ctxWith({ fetchImpl, auth, signEip191: signEip191Message }),
    );
    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain('does not match');
  });
});

describe('present — sovereign key never enters the model context (F32)', () => {
  const auth = { apiKey: 'pvn_live_' + 'a'.repeat(32), apiSecret: 'pvns_' + 'b'.repeat(64) };

  it('remote mode never signs: without pre-signed pop fields it refuses and no key is required', async () => {
    let fetched = false;
    const ctx = ctxWith({
      mode: 'remote',
      auth,
      fetchImpl: (async () => { fetched = true; return new Response('{}', { status: 200 }); }) as typeof fetch,
    });
    const result = await callProvianTool('present', {
      wallet_id: 'wallet_aw_x',
      burn_id: 'burn_1',
      audience: 'counterparty-1',
      challenge: 'chal-abcdef0123456789',
    }, ctx);
    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain('never send a private key');
    expect(fetched).toBe(false);
  });

  it('local mode signs the binding in-process — no key in args, none in the network body', async () => {
    const { signPoPChallenge, derivePublicKeyFromPrivateKey } = await import('./crypto');
    const kp = generateAgentKeyPair();
    let bodySeen = '';
    const ctx = ctxWith({
      mode: 'local',
      auth,
      fetchImpl: (async (_u: unknown, init?: RequestInit) => {
        bodySeen = String(init?.body ?? '');
        return new Response(JSON.stringify({ presentation_id: 'pres_1', ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }) as typeof fetch,
      withLocalSovereignIdentity: (<T>(fn: (id: {
        address: string; walletId: string; pubkey: string;
        signEip191: (m: string) => string; signPop: (b: string) => string;
      }) => T): T => fn({
        address: kp.address,
        walletId: 'wallet_aw_local',
        pubkey: derivePublicKeyFromPrivateKey(kp.privateKey),
        signEip191: () => { throw new Error('not used here'); },
        signPop: (b) => signPoPChallenge(kp.privateKey, b),
      })) as ToolContext['withLocalSovereignIdentity'],
    });
    // NO agent_private_key, NO pre-signed pop fields.
    const result = await callProvianTool('present', {
      wallet_id: 'wallet_aw_x',
      burn_id: 'burn_1',
      audience: 'counterparty-1',
      challenge: 'chal-abcdef0123456789',
      tier: 'pe_fact',
    }, ctx);
    expect(result.isError).not.toBe(true);
    const body = JSON.parse(bodySeen) as { pop?: { signature?: string; pubkey?: string } };
    expect(body.pop?.signature).toMatch(/^[0-9a-f]+$/);
    expect(body.pop?.pubkey).toBe(derivePublicKeyFromPrivateKey(kp.privateKey));
    // F32: the private key never reached the network body.
    expect(bodySeen).not.toContain(kp.privateKey);
  });
});

describe('tool copy is pre-flip truthful (audit 2026-08-16 item 5)', () => {
  // Pre-flip the @provian npm packages are unpublished (E404), so no served
  // tool description or error string may instruct `npx @provian/...` — a
  // remote caller would hit a dead install. The npx guidance returns in the
  // B5 flip act that publishes the packages.
  const NPX_INSTRUCTION = /npx @provian\//;

  it('no tool description references an npx install of an unpublished package', () => {
    // Guard against the empty-population shape : the roster is real
    // (10 tools at the time of writing).
    expect(PROVIAN_TOOLS.length).toBeGreaterThan(5);
    for (const tool of PROVIAN_TOOLS) {
      expect(tool.description).not.toMatch(NPX_INSTRUCTION);
      expect(JSON.stringify(tool.inputSchema)).not.toMatch(NPX_INSTRUCTION);
    }
  });

  it('the remote create_wallet refusal routes to the REST PoP flow, not a dead npx line', async () => {
    const ctx = ctxWith({ mode: 'remote' });
    const result = await callProvianTool('create_wallet', { agent_name: 'testbot' }, ctx);
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result);
    expect(text).toContain('Remote create_wallet is disabled before key generation');
    expect(text).toContain('/v1/agent/wallet/challenge');
    expect(text).toContain('/v1/agent/wallet/create');
    expect(text).not.toMatch(NPX_INSTRUCTION);
  });

  it('[negative control] the guard regex matches the pre-fix refusal shape', () => {
    // Proves the absence assertions above are falsifiable: the exact pre-fix
    // wording registers against the same needle.
    const preFix =
      'Use the safe SDK prepared-registration flow or local `npx @provian/mcp` with PROVIAN_KEYSTORE_PASSPHRASE.';
    expect(preFix).toMatch(NPX_INSTRUCTION);
  });
});

describe('read_threads unread (: unread threads on MCP)', () => {
  const AUTH = { apiKey: 'pvn_live_k', apiSecret: 'pvns_s' } as unknown as ToolContext['auth'];
  it('unread: true reads only the threads with unread messages; otherwise all threads', async () => {
    const urls: string[] = [];
    const fetchImpl: FetchStub = async (url) => { urls.push(url); return makeResponse(200, { threads: [], count: 0 }); };
    const ctx = ctxWith({ auth: AUTH, fetchImpl });
    expect((await callProvianTool('read_threads', { unread: true }, ctx)).isError).toBeUndefined();
    await callProvianTool('read_threads', {}, ctx);
    expect(urls).toEqual(['https://relay.test/v1/threads/unread', 'https://relay.test/v1/threads']);
  });

  it('thread_id + mark_read: true returns the messages and marks read through the newest one returned; without it nothing is marked', async () => {
    const calls: Array<{ call: string; body?: unknown }> = [];
    const fetchImpl: FetchStub = async (url, init) => {
      calls.push({ call: `${init?.method ?? 'GET'} ${url}`, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return url.endsWith('/read') ? makeResponse(200, { read: true }) : makeResponse(200, { thread: { thread_id: 't1' }, read_cursor: 5, messages: [{ message_id: 'm1', created_at: 7 }, { message_id: 'm2', created_at: 9 }] });
    };
    const ctx = ctxWith({ auth: AUTH, fetchImpl });
    const r = await callProvianTool('read_threads', { thread_id: 't1', mark_read: true }, ctx);
    expect(r.isError).toBeUndefined();
    expect(JSON.stringify(r.content)).toContain('m2');
    expect(calls.map((c) => c.call)).toEqual(['GET https://relay.test/v1/threads/t1/messages?limit=100', 'POST https://relay.test/v1/threads/t1/read']);
    expect(calls[1].body).toEqual({ up_to: 9 });
    calls.length = 0;
    await callProvianTool('read_threads', { thread_id: 't1' }, ctx);
    expect(calls.map((c) => c.call)).toEqual(['GET https://relay.test/v1/threads/t1/messages', 'GET https://relay.test/v1/threads/t1/messages?limit=100']);
  });

  it('more than one page unread: pages back to the read cursor and returns all of it before marking (none marked unseen)', async () => {
    const msgs = Array.from({ length: 160 }, (_, i) => ({ message_id: `m${i}`, created_at: 1_000 + i }));
    const calls: Array<{ call: string; body?: unknown }> = [];
    const fetchImpl: FetchStub = async (url, init) => {
      calls.push({ call: `${init?.method ?? 'GET'} ${url}`, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith('/read')) return makeResponse(200, { read: true });
      const u = new URL(url);
      const before = u.searchParams.get('before');
      const pool = before ? msgs.filter((m) => m.created_at < Number(before)) : msgs;
      return makeResponse(200, { thread: { thread_id: 't1' }, read_cursor: 1_000 + 19, messages: pool.slice(-Number(u.searchParams.get('limit'))) });
    };
    const r = await callProvianTool('read_threads', { thread_id: 't1', mark_read: true }, ctxWith({ auth: AUTH, fetchImpl }));
    const body = JSON.parse((r.content as Array<{ text: string }>)[0].text) as { messages: Array<{ message_id: string }> };
    expect(body.messages.map((m) => m.message_id)).toContain('m20'); // the oldest unread (cursor at m19) is returned
    expect(body.messages.at(-1)?.message_id).toBe('m159');
    expect(calls.at(-1)).toEqual({ call: 'POST https://relay.test/v1/threads/t1/read', body: { up_to: 1_159 } });
  });

  it('mark_read refuses before, and a relay that does not name the read cursor marks nothing', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchStub = async (url, init) => { calls.push(`${init?.method ?? 'GET'} ${url}`); return makeResponse(200, { messages: [{ created_at: 3 }] }); };
    const ctx = ctxWith({ auth: AUTH, fetchImpl });
    expect((await callProvianTool('read_threads', { thread_id: 't1', mark_read: true, before: 5 }, ctx)).isError).toBe(true);
    expect((await callProvianTool('read_threads', { thread_id: 't1', mark_read: true }, ctx)).isError).toBe(true);
    expect(calls.some((c) => c.startsWith('POST'))).toBe(false);
  });

  it('a thread opened whose first message never landed (no messages, last_message_at past the cursor) is still cleared', async () => {
    const calls: Array<{ call: string; body?: unknown }> = [];
    const fetchImpl: FetchStub = async (url, init) => {
      calls.push({ call: `${init?.method ?? 'GET'} ${url}`, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return url.endsWith('/read') ? makeResponse(200, { read: true }) : makeResponse(200, { thread: { thread_id: 't1', last_message_at: 50 }, read_cursor: 0, messages: [] });
    };
    await callProvianTool('read_threads', { thread_id: 't1', mark_read: true }, ctxWith({ auth: AUTH, fetchImpl }));
    expect(calls.at(-1)).toEqual({ call: 'POST https://relay.test/v1/threads/t1/read', body: { up_to: 50 } });
  });

  it('a failed mark-read is reported, never silently dropped', async () => {
    const fetchImpl: FetchStub = async (url) => (url.endsWith('/read') ? makeResponse(403, { error: 'not_a_party' }) : makeResponse(200, { read_cursor: 0, messages: [{ created_at: 4 }] }));
    const r = await callProvianTool('read_threads', { thread_id: 't1', mark_read: true }, ctxWith({ auth: AUTH, fetchImpl }));
    expect(r.isError).toBe(true);
  });
});

describe('MCP onboarding describes immediate Commons delivery', () => {
  it('names local dispatch, durable completion, owner policy and the manual remote fallback', async () => {
    const { serverInstructions } = await import('./server');
    const text = serverInstructions();
    expect(text).toContain('authenticated events');
    expect(text).toContain('commons-runtime.json');
    expect(text).toContain('acknowledges only confirmed completion');
    expect(text).toContain('ask_me_first');
    expect(text).toContain('request_human_approval before replying to anyone else');
    expect(text).toContain('No Commons heartbeat is needed');
    expect(text).toContain('read threads on turns you already run');
    expect(text).not.toContain('on your standing heartbeat');
    expect(text).not.toContain('start a turn only when its local mailbox');
  });
});

describe('reply policy on read_threads, and list_approval_requests (item 4)', () => {
  const AUTH = { apiKey: 'pvn_live_k', apiSecret: 'pvns_s' } as unknown as ToolContext['auth'];
  const textOf = (r: { content: unknown }) => JSON.parse((r.content as Array<{ text: string }>)[0].text) as Record<string, unknown>;

  it('every read carries the owner\'s policy and what to do under it, in this server\'s tool names', async () => {
    const policy = { mode: 'ask_me_first', linked_human: 'user_frank' };
    const fetchImpl: FetchStub = async (url) => makeResponse(200, url.includes('/messages')
      ? { thread: { thread_id: 't1' }, read_cursor: 0, messages: [], reply_policy: policy }
      : { threads: [], count: 0, reply_policy: policy });
    const ctx = ctxWith({ auth: AUTH, fetchImpl });
    for (const args of [{ unread: true }, {}, { thread_id: 't1' }, { thread_id: 't1', mark_read: true }]) {
      const body = textOf(await callProvianTool('read_threads', args, ctx));
      expect(body.reply_policy).toEqual(policy);
      expect(String(body.reply_instruction)).toContain('Reply directly only to your linked human (user_frank)');
      expect(String(body.reply_instruction)).toContain('request_human_approval');
      expect(String(body.reply_instruction)).toContain('list_approval_requests');
      // The request names the message, so a heartbeat with no memory finds its approval again.
      expect(String(body.reply_instruction)).toContain('subject_pe_id');
      expect(String(body.reply_instruction)).toContain('without mark_read');
      // RED ( ): the relay never writes status expired — a lapsed request stays pending
      // past expires_at_ms, so the instruction must treat that as lapsed or the agent waits forever.
      expect(String(body.reply_instruction)).toContain('pending with expires_at_ms in the past');
    }
  });

  it('answer anyone (or a relay without the field) says to act on every message', async () => {
    for (const extra of [{ reply_policy: { mode: 'answer_anyone', linked_human: 'user_frank' } }, {}]) {
      const fetchImpl: FetchStub = async () => makeResponse(200, { threads: [], count: 0, ...extra });
      const body = textOf(await callProvianTool('read_threads', { unread: true }, ctxWith({ auth: AUTH, fetchImpl })));
      expect(String(body.reply_instruction)).toContain('answer anyone');
    }
  });

  it('RED: a policy this server cannot read is ask me first', () => {
    for (const raw of ['answer_anyone', 3, { mode: 'everyone' }]) expect(replyInstructionFor(raw)).toContain('ask me first');
  });

  it('list_approval_requests reads the agent\'s own requests (status filter passed through; a bad one refused before any call)', async () => {
    const urls: string[] = [];
    const fetchImpl: FetchStub = async (url) => { urls.push(url); return makeResponse(200, { requests: [{ request_id: 'har_1', status: 'satisfied', decision: 'approved' }] }); };
    const ctx = ctxWith({ auth: AUTH, fetchImpl });
    const r = await callProvianTool('list_approval_requests', { wallet_id: 'wallet_aw_bot', status: 'satisfied' }, ctx);
    expect(textOf(r).requests).toEqual([{ request_id: 'har_1', status: 'satisfied', decision: 'approved' }]);
    expect(urls).toEqual(['https://relay.test/v1/agent/wallet/wallet_aw_bot/approval-requests?status=satisfied']);
    expect((await callProvianTool('list_approval_requests', { wallet_id: 'wallet_aw_bot', status: 'all' }, ctx)).isError).toBe(true);
    expect(urls).toHaveLength(1);
  });
});
