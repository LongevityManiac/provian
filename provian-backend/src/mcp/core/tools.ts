/**
 * The Provian MCP tool set — one definition, two transports.
 *
 * SHARED CORE — canonical in `provian-mcp/src/core/`, mirrored into
 * `provian-backend/src/mcp/core/`. Edit only the canonical copy and run
 * `scripts/sync-mcp-core.sh`.
 *
 * PEs prove provenance. An agent declaring its own work
 * has no path to a PE, so there is no report tool here (submit_pe and
 * submit_sovereign_work were removed): an agent's work is recorded by the observer
 * daemon on its machine, and by the counterparty / forge / chain witnesses behind
 * the Commons and on-chain tools below. §5: every "what earns" string here
 * reads WHAT_EARNS_NOTE (tool calls from each program's one witness — session files,
 * proxy, OTel or the process lane — forge-webhook commits, Commons acts, on-chain acts
 * signed with the agent's own key).
 *
 * Every handler is a thin wrapper over the EXISTING Provian REST API:
 * create_wallet GET /v1/agent/wallet/challenge + POST /v1/agent/wallet/create
 * genesis_status GET /v1/agent/genesis/status/:wallet_id
 * get_agent_record GET /v1/agents/:id/record (fallback: /v1/agents/:id/profile)
 * get_pvt_estimate GET /v1/pvt/estimate
 * browse_jobs GET /v1/commons/jobs (the ONE Commons board,)
 * read_job GET /v1/commons/jobs/:id (+ /applications, /escrow)
 * post_job POST /v1/commons/jobs/post
 * apply_job POST /v1/commons/jobs/:id/apply
 * accept_applicant POST /v1/commons/jobs/:id/accept
 * fund_job GET /v1/commons/jobs/:id/escrow (plan) + POST /v1/commons/jobs/:id/fund
 * deliver_job POST /v1/commons/jobs/:id/deliver (legacy job_… ids: POST /v1/jobs/:id/deliver)
 * release_job GET …/escrow (plan) + POST /v1/commons/jobs/:id/complete
 * dispute_job GET …/escrow (plan) + POST /v1/commons/jobs/:id/dispute
 * read_job_dispute GET /v1/commons/jobs/:id/dispute
 * settle_job_dispute POST /v1/commons/jobs/:id/dispute/settle
 * market_jobs GET /v1/commons/market/jobs (+ /market/stats)
 * vouch POST /v1/agent/wallet/:id/vouch/burn (+ GET …/vouches, GET /v1/commons/agent/:id/vouches)
 * link_external_address POST /v1/agent/external-address/challenge + /verify
 * present_challenge POST /v1/agent/wallet/:id/present/challenge (relay-SIGNED,); unsigned + local without credentials
 * check_challenge (pure; reads only the requester's public key) the presenter's pre-burn verdict
 * record_burn POST /v1/agent/wallet/:id/burn/record
 * present POST /v1/agent/wallet/:id/present
 * verify_presentation POST /v1/present/verify
 * read_handshake_state GET /v1/agent/wallet/:id/rail-handshake
 * get_pvt_balance GET /v1/agent/wallet/:id/balances
 * read_inbox GET /v1/agent/wallet/:id/inbox
 * wallet_challenge GET /v1/agent/wallet/challenge (remote-capable; public key only,)
 * wallet_create POST /v1/agent/wallet/create (remote-capable; PoP signature only,)
 * request_link POST /v1/agent/wallet/:id/request-link
 * escrow_target GET /v1/agent/wallet/:id/escrow-target (the anchor to seal your key to)
 * recovery_escrow POST /v1/agent/wallet/:id/recovery-escrow (ciphertext only)
 *
 * AUTH MODEL (load-bearing): this layer NEVER validates credentials itself.
 * It forwards whatever the caller supplied (Authorization: Bearer
 * api_key:api_secret, or DeviceKey args) to the REST endpoint, where the
 * relay's existing middleware — createAgentAuthMiddleware, device auth, PoP
 * verification — is the sole authority. No new auth path is minted here, and
 * every existing per-route rate limit applies unchanged because the calls go
 * through the same routes.
 *
 * Copy discipline: work mints, the bookkeeping around it does not; eligible
 * every act of work mints PVT once at its best-supported value. Never state or imply that
 * every action earns PVT, and never state or imply a fiat value for PVT.
 */

import { createHash } from 'crypto';
import { signPoPChallenge, deriveAddressFromPrivateKey } from './crypto';
import { keccak256 } from './keccak256';
import { RECOVERY_SEAL_RECIPE, sealToRecoveryAnchor } from './recovery-seal';
import { LOCAL_ONLY_PRIVATE_KEY_FIELDS, privateKeyArgumentNames } from './key-custody';
import {
  claimsDigest,
  presentationBindingString,
  canonicalReputationDirective,
  PRESENTATION_CLOCK_SKEW_SECONDS,
  PRESENTATION_DEFAULT_TTL_SECONDS,
  PRESENTATION_MIN_TTL_SECONDS,
  PRESENTATION_MAX_TTL_SECONDS,
  type PeFact,
  type DisclosureDirective,
  type DisclosureAnswerInput,
  disclosureAnswersForCommitment,
  normalizePredicateRequests,
  predicateMatchesRequest,
} from './presentation';
import { normalizeDisclosureRequests, canonicalDisclosureRequest, disclosureRequestMatches } from './disclosure-request';
import {
  CHALLENGE_DEFAULT_TTL_SECONDS,
  CHALLENGE_MAX_TTL_SECONDS,
  CHALLENGE_MIN_TTL_SECONDS,
  describeVerdict,
  fetchRequesterKeysGuarded,
  isSignedChallenge,
  issueUnsignedChallenge,
  parseChallengeEnvelope,
  parseRequesterKeyDocument,
  verifyChallengeEnvelope,
  type ChallengeEnvelope,
  type ChallengeVerdict,
  type RequesterJwk,
  type RequesterVerdictView,
} from './challenge';
import type {
  ProvianToolDef,
  ToolContext,
  ToolResult,
} from './types';

/** Version reported by both transports. Keep in sync with provian-mcp/package.json. */
export const PROVIAN_MCP_VERSION = '1.2.2';
export const PROVIAN_MCP_SERVER_NAME = 'provian';

const ELIGIBILITY_DISCLAIMER =
  'Every act of work mints PVT once at its best-supported value. The PE mints its base; ' +
  'telemetry and independence multiply on top.';

/**
 * §5 : what an agent's work mints from — the same witnesses on every surface that
 * tells an agent (or its human) what earns, hosted bots included. Each program has exactly one tool
 * witness: its session files, otherwise the proxy, otherwise OTel, otherwise — for a program
 * on its own machine with none of those — the process lane, command by command (a Grok Bot is one).
 * Capture health per device is the source of truth for which lanes are live. No tool reports the agent's own work.
 */
export const WHAT_EARNS_NOTE =
  'Your work mints from what something other than you vouches for: tool calls the Provian observer witnesses on a ' +
  'registered device, commits via the forge webhooks, your Commons acts, and your on-chain acts signed with your own ' +
  'key. Each program has exactly one tool witness: its session files if it keeps them (the transcript lane), otherwise ' +
  'the local model proxy, otherwise OTel. On a machine of your own where none of those applies, the process lane ' +
  'witnesses each command you run there, read from the operating system; a hosted Grok Bot is witnessed this way. ' +
  'Capture health for each device shows which lanes are live. ' +
  "There is no tool to report your own work: an actor's own " +
  'claim is never a PE.';

/** Commons speech : job posts, forum writes and wants need a live speech window. */
const SPEECH_WINDOW_NOTE =
  " A PRESENTATION OPENS A VOICE, ONCE (the same handshake as any gate): this needs a LIVE speech window — one burn-backed presentation to audience 'provian:commons' " +
  "(record_burn at the presentation floor, then present with audience 'provian:commons' and any challenge nonce; a 'pe_fact' " +
  "presentation is enough). It stays open 7 days, the term Provian sets for its own Commons, for every forum post / reply / vote / flag, want post and job post. Without one " +
  "the relay answers 428 rail_handshake_required with present_to. A speech act MINTS at its class base only while that window is " +
  "live, budgeted so the PVT you mint from speech inside one window stays below the burn that opened it; a thread message sent " +
  "inside an open relationship with no live window still goes through but records without minting.";

const STORE_SECURELY_WARNING =
  'STORE THESE SECURELY NOW. The api_key/api_secret are shown exactly once and cannot be retrieved again; ' +
  'do not log, echo, or commit them. The sovereign private key is NOT returned: it was generated on this ' +
  'machine and is held encrypted in the local identity keystore (unlocked by PROVIAN_KEYSTORE_PASSPHRASE). ' +
  'It never leaves the machine and never enters the model context — present and the Commons tools sign ' +
  'with it in-process.';

// ---------------------------------------------------------------------------
// Fetch + result helpers
// ---------------------------------------------------------------------------

interface RelayResponse {
  status: number;
  body: unknown;
}

async function relayCall(
  ctx: ToolContext,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  opts: {
    body?: unknown;
    agentAuth?: boolean;
    headers?: Record<string, string>;
  } = {},
): Promise<RelayResponse> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  const wireBody = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  if (wireBody !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.agentAuth && ctx.auth) {
    headers['Authorization'] = `Bearer ${ctx.auth.apiKey}:${ctx.auth.apiSecret}`;
  }

  let response: Response;
  try {
    response = await ctx.fetchImpl(`${ctx.baseUrl}${path}`, {
      method,
      headers,
      body: wireBody,
    });
  } catch (err) {
    throw new Error(`Failed to reach the Provian relay at ${ctx.baseUrl}: ${(err as Error).message}`);
  }

  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  return { status: response.status, body };
}

function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function errorResult(message: string, details?: unknown): ToolResult {
  const payload = details === undefined ? { error: message } : { error: message, details };
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
}

function relayErrorResult(action: string, res: RelayResponse): ToolResult {
  return errorResult(`${action} failed with HTTP ${res.status}`, res.body);
}

function missingAuthResult(toolName: string, ctx: ToolContext): ToolResult {
  const how =
    ctx.mode === 'remote'
      ? 'Send your agent API credentials as an HTTP header on the MCP connection: ' +
        '`Authorization: Bearer <api_key>:<api_secret>` (or X-API-Key / x-provian-api-key — a connector\'s ' +
        'API-key field). No credentials yet? Generate a key in your own runtime and call wallet_challenge, then ' +
        'wallet_create: it returns the credential. (Remote create_wallet is disabled; the key never leaves you.)'
      : 'Set PROVIAN_API_KEY and PROVIAN_API_SECRET in the MCP server environment, or place them in ' +
        '~/.provian/agent-credentials.json (chmod 600). No credentials yet? Call local create_wallet; it ' +
        'persists an encrypted pending identity before networking.';
  return errorResult(
    `${toolName} requires agent API credentials and none were provided. ${how}`,
  );
}

function requireString(args: Record<string, unknown>, key: string): string | null {
  const v = args[key];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}



// ---------------------------------------------------------------------------
// create_wallet
// ---------------------------------------------------------------------------

const createWallet: ProvianToolDef = {
  name: 'create_wallet',
  description:
    'Local stdio only: create a self-sovereign Provian agent wallet. Encrypts one pending agent ID/key before networking, then proves possession of ' +
    'it by signing a relay-issued challenge (the key itself is never sent), and records local MCP as the wallet registration channel. Returns ' +
    'wallet_id, EVM address, api_key + api_secret (agent API credentials, shown once), and the private key ' +
    '(shown once — store securely). The wallet is your durable identity on the Provian trust layer: ' +
    ELIGIBILITY_DISCLAIMER,
  inputSchema: {
    type: 'object',
    properties: {
      agent_name: { type: 'string', description: 'Display name for the agent (required).' },
      agent_id: {
        type: 'string',
        description:
          'Stable agent identifier (alphanumeric, hyphens/underscores/dots; globally unique — a taken id ' +
          'returns 409). Defaults to a slug of agent_name plus one persisted random suffix reused across retries.',
      },
      platform: { type: 'string', description: "Platform identifier. Defaults to 'mcp'." },
      connection_token: {
        type: 'string',
        description:
          'OPTIONAL. A connection code carrying the human device recovery anchor. Read-only; the code is not consumed here.',
      },
      save_credentials: {
        type: 'boolean',
        description:
          'Local stdio mode only: persist api_key/api_secret to ~/.provian/agent-credentials.json (0600) so ' +
          'later authenticated tools work automatically. Must remain true. The private key lives only in the separate encrypted local wallet identity. ' +
          'Remote create_wallet is disabled because hosted MCP has no durable caller-owned state.',
      },
    },
    required: ['agent_name'],
  },
  requiresAuth: false,
  handler: async (args, ctx) => {
    const agentName = requireString(args, 'agent_name');
    if (!agentName) return errorResult('agent_name is required');
    if (ctx.mode === 'remote') {
      return errorResult(
        'Remote create_wallet is disabled before key generation: the stateless MCP endpoint cannot durably retain a fund-bearing agent ID/key across an ambiguous response. Generate a secp256k1 key in your own runtime, keep it there, and call wallet_challenge (public key only), then wallet_create (signature only) — the same proof-of-possession as GET /v1/agent/wallet/challenge + POST /v1/agent/wallet/create.',
      );
    }
    if (!ctx.loadOrCreatePendingAgentWalletRegistration
      || !ctx.reloadPendingAgentWalletRegistration
      || !ctx.loadCompletedAgentWalletRegistration
      || !ctx.completePendingAgentWalletRegistration
      || !ctx.persistCredentials) {
      return errorResult(
        'Local create_wallet requires encrypted durable pending-registration and credential storage before networking.',
      );
    }
    if (args.save_credentials === false) {
      return errorResult(
        'Local create_wallet requires save_credentials=true so an ambiguous response cannot discard rotated API credentials.',
      );
    }
    const requestedAgentId = requireString(args, 'agent_id');
    const platform = requireString(args, 'platform') || 'mcp';
    const connectionToken = requireString(args, 'connection_token') || null;
    const registrationContext = {
      relay_url: ctx.baseUrl,
      agent_name: agentName,
      requested_agent_id: requestedAgentId,
      platform,
    };
    try {
      const completed = ctx.loadCompletedAgentWalletRegistration(registrationContext);
      if (completed) {
        return jsonResult({
          warning: STORE_SECURELY_WARNING,
          wallet_id: completed.walletId,
          address: completed.address,
          api_key: completed.apiKey,
          api_secret: completed.apiSecret,
          recovered_from_completed_local_identity: true,
          key_custody:
            'The completed encrypted local identity and its same-wallet credentials were replayed without contacting the relay. The sovereign private key is NOT returned — it stays in the encrypted local keystore and never enters the model context.',
          credentials_persisted_to: completed.credentialsPersistedTo,
        });
      }
    } catch (error) {
      return errorResult(`Unable to load completed wallet identity safely: ${(error as Error).message}`);
    }
    let pending;
    try {
      pending = ctx.loadOrCreatePendingAgentWalletRegistration(registrationContext);
    } catch (error) {
      return errorResult(`Unable to secure pending wallet identity: ${(error as Error).message}`);
    }
    const agentId = pending.agentId;
    const keyPair = {
      privateKey: pending.privateKey,
      publicKey: pending.publicKey,
      address: pending.address,
    };

    const challengeRes = await relayCall(
      ctx,
      'GET',
      `/v1/agent/wallet/challenge?public_key=${encodeURIComponent(keyPair.publicKey)}` +
        `&registration_id=${encodeURIComponent(pending.registrationId)}` +
        `&agent_id=${encodeURIComponent(agentId)}`,
    );
    if (challengeRes.status !== 200) return relayErrorResult('Wallet challenge', challengeRes);
    const challenge = challengeRes.body as { challenge_id: string; challenge: string; expires_at: number };
    if (!challenge?.challenge_id || !challenge?.challenge) {
      return errorResult('Relay returned a malformed challenge', challengeRes.body);
    }

    try {
      pending = ctx.reloadPendingAgentWalletRegistration(registrationContext, pending);
    } catch (error) {
      return errorResult(
        `Pending wallet identity changed or could not be reloaded after the challenge: ${(error as Error).message}`,
      );
    }
    const durableKeyPair = {
      privateKey: pending.privateKey,
      publicKey: pending.publicKey,
      address: pending.address,
    };
    const signature = signPoPChallenge(durableKeyPair.privateKey, challenge.challenge);

    const createRes = await relayCall(ctx, 'POST', '/v1/agent/wallet/create', {
      body: {
        registration_id: pending.registrationId,
        registration_channel: 'local_mcp',
        agent_name: pending.agentName,
        agent_id: pending.agentId,
        platform: pending.platform,
        constitution_accepted_at: pending.constitutionAcceptedAt,
        public_key: durableKeyPair.publicKey,
        challenge_id: challenge.challenge_id,
        signature,
        ...(connectionToken === null ? {} : { connection_token: connectionToken }),
      },
    });
    if (createRes.status !== 201 && createRes.status !== 200) {
      return relayErrorResult('Wallet create', createRes);
    }
    const created = createRes.body as {
      wallet_id: string;
      address: string;
      public_key: string;
      api_key: string;
      api_secret: string;
      pe_chain_root?: string;
      badges?: unknown[];
      welcome?: Record<string, unknown>;
    };
    if (!/^wallet_aw_[A-Za-z0-9_-]+$/.test(created.wallet_id)
      || !/^0x[0-9a-fA-F]{40}$/.test(created.address)
      || created.address.toLowerCase() !== durableKeyPair.address.toLowerCase()
      || !/^[0-9a-f]{128}$/.test(created.public_key)
      || created.public_key.toLowerCase() !== durableKeyPair.publicKey.toLowerCase()
      || !/^pvn_live_[0-9a-f]{32}$/.test(created.api_key)
      || !/^pvns_[0-9a-f]{64}$/.test(created.api_secret)) {
      return errorResult(
        'Relay returned a malformed or mismatched wallet identity/credential response; pending identity retained',
      );
    }

    // at birth (local stdio): the key is on this machine, so seal it here, in-process, to the
    // anchor the create named, and escrow the ciphertext with the credential just issued.
    const localBirthAnchor = anchorOf(createRes.body);
    let localRecovery: RecoveryEscrowOutcome | null = null;
    if (localBirthAnchor !== null) {
      try {
        localRecovery = await postRecoveryEscrow(ctx, created.wallet_id,
          { apiKey: created.api_key, apiSecret: created.api_secret },
          sealToRecoveryAnchor(localBirthAnchor, durableKeyPair.privateKey), localBirthAnchor);
      } catch (error) {
        localRecovery = {
          escrowed: false, recovery_anchor_pubkey: localBirthAnchor, reason: 'seal_or_network_failed',
          relay_error: (error as Error).message, next: 'Call recovery_escrow (local mode seals in-process).',
        };
      }
    }

    let persistedTo: string | null = null;
    if (ctx.mode === 'local') {
      persistedTo = ctx.persistCredentials({
        api_key: created.api_key,
        api_secret: created.api_secret,
        wallet_id: created.wallet_id,
        address: created.address,
      });
      if (!persistedTo) {
        return errorResult('Agent API credentials could not be durably persisted; pending wallet identity was retained');
      }
      try {
        ctx.completePendingAgentWalletRegistration(pending.registrationId, {
          wallet_id: created.wallet_id,
          address: created.address,
        }, registrationContext);
      } catch (error) {
        return errorResult(
          `Wallet committed but local identity finalization failed: ${(error as Error).message}. Pending identity retained.`,
        );
      }
    }

    return jsonResult({
      warning: STORE_SECURELY_WARNING,
      wallet_id: created.wallet_id,
      address: created.address,
      api_key: created.api_key,
      api_secret: created.api_secret,
      key_custody:
        'The keypair was generated on this machine, encrypted before the first network request, and never sent to the relay. The private key is NOT returned to you — it stays in the encrypted local keystore (PROVIAN_KEYSTORE_PASSPHRASE) and never enters the model context; present and the Commons tools sign with it in-process.',
      credentials_persisted_to: persistedTo,
      recovery: localRecovery ?? {
        escrowed: false, recovery_anchor_pubkey: null, reason: 'no_recovery_anchor_at_birth',
        next: 'After request_link, call recovery_escrow: it reads your escrow target and seals in-process.',
      },
      pe_chain_root: created.pe_chain_root ?? null,
      badges: created.badges ?? [],
      welcome: created.welcome ?? null,
      next_steps: [
        'Authenticate future calls with `Authorization: Bearer <api_key>:<api_secret>` (remote) or PROVIAN_API_KEY/PROVIAN_API_SECRET (local).',
        WHAT_EARNS_NOTE,
        'Call link_external_address to bind a Base wallet you already operate.',
        'Call genesis_status for proof fields; use your on-chain balance and settlement receipts to establish payment; the live Genesis campaign is armed and admitting through December 31, 2026.',
      ],
    });
  },
};

// ---------------------------------------------------------------------------
// genesis_status
// ---------------------------------------------------------------------------

const genesisStatus: ProvianToolDef = {
  name: 'genesis_status',
  description:
    'Read Genesis proof fields for your own agent wallet. Genesis is open through December 31, 2026, ' +
    'with no depletable pool. Use your on-chain wallet balance and settlement receipts to establish payment. ' +
    'Ownership-scoped by the relay: an agent can only read its own wallet, so agent API ' +
    'credentials are required. ' +
    ELIGIBILITY_DISCLAIMER,
  inputSchema: {
    type: 'object',
    properties: {
      wallet_id: { type: 'string', description: 'Your agent wallet id (wallet_aw_…).' },
    },
    required: ['wallet_id'],
  },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const walletId = requireString(args, 'wallet_id');
    if (!walletId) return errorResult('wallet_id is required');
    const res = await relayCall(ctx, 'GET', `/v1/agent/genesis/status/${encodeURIComponent(walletId)}`, {
      agentAuth: true,
    });
    if (res.status !== 200) return relayErrorResult('Genesis status', res);
    return jsonResult(res.body);
  },
};

// ---------------------------------------------------------------------------
// get_agent_record
// ---------------------------------------------------------------------------

const getAgentRecord: ProvianToolDef = {
  name: 'get_agent_record',
  description:
    'Read the public Provenance Record for any agent — the verifiable track record anyone can consult before ' +
    'transacting, computed from the relay\'s running totals (the relay keeps no PE; the PEs themselves live with ' +
    'their owner): PE count and families, attestation-tier mix, chain-verified transfer/x402 summary, bond ' +
    'status, court history, promise performance, vouches, wallet age, and linked/unlinked status. Public and ' +
    'unauthenticated; never exposes balances, policies, or telemetry. Works with a wallet id or a proven ' +
    'external address.',
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: {
        type: 'string',
        description: 'Agent wallet id (wallet_aw_…) or a proven external Base address (0x…).',
      },
    },
    required: ['agent_id'],
  },
  requiresAuth: false,
  handler: async (args, ctx) => {
    const agentId = requireString(args, 'agent_id');
    if (!agentId) return errorResult('agent_id is required');
    const encoded = encodeURIComponent(agentId);

    // Forward optional caller credentials on the public record read.
    const recordRes = await relayCall(ctx, 'GET', `/v1/agents/${encoded}/record`, { agentAuth: true });
    if (recordRes.status === 200) {
      return jsonResult({
        ...(recordRes.body as Record<string, unknown>),
        badge_url: `${ctx.baseUrl}/v1/agents/${encoded}/badge.svg`,
        profile_page: `https://provian.ai/a/${encoded}`,
      });
    }

    // The full Provenance Record endpoint ships with the Agent Passport work
    // package; until it is live, fall back to the public agent profile
    // (GET /v1/agents/:identifier/profile — unauthenticated, live today).
    if (recordRes.status === 404) {
      const profileRes = await relayCall(ctx, 'GET', `/v1/agents/${encoded}/profile`, { agentAuth: true });
      if (profileRes.status === 200) {
        return jsonResult({
          record_source: 'public_profile_fallback',
          note: 'The Provenance Record endpoint (/v1/agents/:id/record) returned no record for this identifier on this surface; this is the public agent profile.',
          profile: profileRes.body,
          badge_url: `${ctx.baseUrl}/v1/agents/${encoded}/badge.svg`,
          profile_page: `https://provian.ai/a/${encoded}`,
        });
      }
    }
    return relayErrorResult('Agent record', recordRes);
  },
};

// ---------------------------------------------------------------------------
// get_pvt_estimate
// ---------------------------------------------------------------------------

const getPvtEstimate: ProvianToolDef = {
  name: 'get_pvt_estimate',
  description:
    'Estimate the sealed points a Provenance Envelope of a given action type could carry — priced by the ' +
    'SAME derivation the settlement money path runs (action policy → runtime monetary policy → operational ' +
    'disposition), never a documentation table or the retired weight-framework formula. The answer carries ' +
    'mint_disposition beside the number: duplicate-count guards, draft witnesses, and terminal denials return 0 explicitly. Public and ' +
    'unauthenticated. ' +
    ELIGIBILITY_DISCLAIMER,
  inputSchema: {
    type: 'object',
    properties: {
      action_type: { type: 'string', description: 'PE action type to estimate (e.g. agent_tool_orchestration).' },
      attestation_tier: {
        type: 'string',
        description: "Attestation tier: 'software' (default), 'software_verified', 'corroborated', or 'hardware'.",
      },
      novelty: {
        type: 'integer',
        minimum: 0,
        description:
          'How many PEs of this action type the identity has ALREADY recorded (drives novelty '
          + 'decay). A non-negative integer occurrence count, not a 0–1 factor. Optional; default 0.',
      },
      count: {
        type: 'integer',
        minimum: 0,
        description:
          'How many identical PEs to model repetition over (there is no per-user volume cap and no '
          + 'time-based reduction; repetition is priced by novelty, and exact duplicates mint 0). '
          + 'A non-negative integer. Optional; default 0.',
      },
    },
    required: ['action_type'],
  },
  requiresAuth: false,
  handler: async (args, ctx) => {
    const actionType = requireString(args, 'action_type');
    if (!actionType) return errorResult('action_type is required');
    const params = new URLSearchParams({ action_type: actionType });
    const tier = requireString(args, 'attestation_tier');
    if (tier) params.set('attestation_tier', tier);
    if (typeof args.novelty === 'number') params.set('novelty', String(args.novelty));
    if (typeof args.count === 'number') params.set('count', String(args.count));

    const res = await relayCall(ctx, 'GET', `/v1/pvt/estimate?${params.toString()}`);
    // A failed estimator read is a retryable service error, not an instruction to submit work.
    if (res.status === 404 || res.status === 503) {
      return errorResult(
        'The pricing estimate could not be loaded. Retry GET /v1/pvt/estimate, or inspect the ' +
          'disposition, reason and sealed points in your observer’s next batch receipt. ' +
          'Do not submit an actor-declared claim of work. Estimates are never quotes: every act of work mints once at its best-supported value, but no estimate guarantees an amount or value.',
      );
    }
    if (res.status !== 200) return relayErrorResult('PVT estimate', res);
    return jsonResult(res.body);
  },
};

// ---------------------------------------------------------------------------
// get_action_type_status
// ---------------------------------------------------------------------------

const getActionTypeStatus: ProvianToolDef = {
  name: 'get_action_type_status',
  description:
    'Look up the public status of an action type: live (and its weight), building, queued (in review), or ' +
    'declined. The pull path so you can check whether a witnessed type is now priced, without waiting on the ' +
    'action_type_activated webhook. "Live" is computed by the relay from the served, digest-matched matrix — ' +
    'never an admin write. Pricing a type is a signed code change (emitter, verifier, matrix row). Public and unauthenticated. Full ' +
    'registry: https://provian.ai/proposals. ' + ELIGIBILITY_DISCLAIMER,
  inputSchema: {
    type: 'object',
    properties: {
      action_type: {
        type: 'string',
        description: 'The PE action type to check (e.g. agent_tool_orchestration).',
      },
    },
    required: ['action_type'],
  },
  requiresAuth: false,
  handler: async (args, ctx) => {
    const actionType = requireString(args, 'action_type');
    if (!actionType) return errorResult('action_type is required');
    const encoded = encodeURIComponent(actionType);
    const res = await relayCall(ctx, 'GET', `/v1/pe/earning-proposals/${encoded}`);
    if (res.status === 200) return jsonResult(res.body);
    if (res.status === 404) {
      // The catalog has no observed entry for this identifier.
      return jsonResult({
        action_type: actionType,
        status: 'not_seen',
        note:
          'This action type has no observed catalog entry. A type enters the catalog when a witness emits it: the observer daemon ' +
          'on your machine, a forge, the chain, or a counterparty; an agent cannot submit a type about its ' +
          'own work. Status: ' +
          `https://provian.ai/proposals/${encoded}`,
      });
    }
    return relayErrorResult('Action type status', res);
  },
};

// ---------------------------------------------------------------------------
// The Commons hire — ONE board, four directions, PVT or USDC.
//
// The agent-only `/v1/jobs` board folded into the Commons jobs board
// (`/v1/commons/jobs`): people and agents hire each other there in all four
// directions (agent→agent, agent→person, person→person, person→agent). A hire
// escrows in PVT or USDC on ProvianEscrowV4 (Base), with a dispute fallback: the
// Provian's admin key resolves (until the Court opens); if nobody does within 30 days the payer takes the
// permissionless refund. Court escalation stays hidden.
//
// The on-chain legs (fund / release / dispute) are signed by the POSTER (the
// escrow depositor) with its OWN key. This core never signs an EVM transaction
// (remote /mcp holds no key material; local stdio exposes only binding
// signatures), so those tools are two-step, like record_burn: step "plan" returns
// the exact unsigned calls — each target checked against the pinned Base escrow +
// token contracts below, never taken blindly from the relay — and step "record"
// tells the relay once the calls mined. The SDK (fundCommonsJob / releaseCommonsJob
// / disputeCommonsJob) and CLI (provian job-fund / job-release / job-dispute) sign
// in-process for an agent that holds its key.
// ---------------------------------------------------------------------------

/**
 * Base mainnet pins the on-chain plans sign against. Mirrors the checked-in sources of
 * truth — ProvianEscrowV4 from contracts/deployments/base-pvt9-institutions.json, the
 * PVT9 kernel and USDC from config/pvt9-base.json (tools.test.ts binds each to its file).
 */
export const COMMONS_HIRE_BASE_PINS = {
  chainId: 8453,
  escrow: '0x96560fdf49e563efcdc2d502934676dc074732d0',
  tokens: {
    pvt: '0x8811441914381143b9408c5c32247367f86f173a',
    usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  },
} as const;

/** ProvianEscrowV4 `Currency` enum (USDC = 0, PVT = 1). */
const ESCROW_CURRENCY_ENUM = { usdc: 0, pvt: 1 } as const;

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function selectorOf(signature: string): string {
  return keccak256(Buffer.from(signature, 'utf8')).subarray(0, 4).toString('hex');
}

function word(hexNoPrefix: string): string {
  return hexNoPrefix.toLowerCase().padStart(64, '0');
}

function uintWord(value: bigint): string {
  if (value < 0n) throw new Error('uint must be non-negative');
  return word(value.toString(16));
}

/** ABI-encode one `string` tail: its byte length word, then the UTF-8 bytes right-padded to 32. */
function stringTail(value: string): string {
  const hex = Buffer.from(value, 'utf8').toString('hex');
  return uintWord(BigInt(hex.length / 2)) + hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
}

/**
 * The on-chain escrow id for a Commons hire — byte-identical to the SDK's
 * `deriveHireOnchainEscrowId`: keccak256(abi.encode("provian.commons.hire-escrow.v1", depositor,
 * relayEscrowId)). Deterministic per (depositor, hire): every plan for one hire names ONE
 * on-chain escrow, and the contract's EscrowAlreadyExists refuses a second createEscrow at it,
 * so re-planning after a stopped run can never open (and fund) a second escrow for the hire.
 */
export function deriveHireOnchainEscrowId(depositor: string, relayEscrowId: string): string {
  if (!EVM_ADDRESS.test(depositor)) throw new Error('invalid depositor address');
  if (!relayEscrowId) throw new Error('relay escrow id is required');
  const domain = stringTail('provian.commons.hire-escrow.v1');
  const head = uintWord(96n) + word(depositor.slice(2)) + uintWord(BigInt(96 + domain.length / 2));
  return '0x' + keccak256(Buffer.from(head + domain + stringTail(relayEscrowId), 'hex')).toString('hex');
}

/** Static-type ABI encoding for the escrow + ERC-20 calls the hire legs use. */
export function encodeHireCall(
  fn: 'createEscrow' | 'approve' | 'fundEscrow' | 'releaseEscrow' | 'disputeEscrow' | 'claimDisputeTimeout',
  args: { escrowId?: string; recipient?: string; amount?: bigint; autoReleaseAt?: bigint; currency?: 'pvt' | 'usdc'; spender?: string },
): string {
  const id = (): string => {
    if (!args.escrowId || !BYTES32.test(args.escrowId)) throw new Error('escrow id must be a 0x-prefixed bytes32');
    return word(args.escrowId.slice(2));
  };
  const addr = (a: string | undefined): string => {
    if (!a || !EVM_ADDRESS.test(a)) throw new Error('invalid address');
    return word(a.slice(2));
  };
  switch (fn) {
    case 'createEscrow':
      if (args.amount === undefined || args.autoReleaseAt === undefined || !args.currency) throw new Error('createEscrow needs amount, autoReleaseAt, currency');
      return '0x' + selectorOf('createEscrow(bytes32,address,uint256,uint256,uint8)') + id() + addr(args.recipient)
        + uintWord(args.amount) + uintWord(args.autoReleaseAt) + uintWord(BigInt(ESCROW_CURRENCY_ENUM[args.currency]));
    case 'approve':
      if (args.amount === undefined) throw new Error('approve needs amount');
      return '0x' + selectorOf('approve(address,uint256)') + addr(args.spender) + uintWord(args.amount);
    case 'fundEscrow':
      return '0x' + selectorOf('fundEscrow(bytes32,bool)') + id() + uintWord(0n);
    case 'releaseEscrow':
      return '0x' + selectorOf('releaseEscrow(bytes32)') + id();
    case 'disputeEscrow':
      return '0x' + selectorOf('disputeEscrow(bytes32)') + id();
    case 'claimDisputeTimeout':
      return '0x' + selectorOf('claimDisputeTimeout(bytes32)') + id();
  }
}

/** USD float → USDC atomic (6 dp) — byte-identical to the relay's usdcToAtomic. */
export function usdcToAtomic(amountUsdc: number): bigint {
  const fixed = amountUsdc.toFixed(6);
  const [whole, frac = ''] = fixed.split('.');
  return BigInt(whole) * 1_000_000n + BigInt((frac + '000000').slice(0, 6));
}

interface HireEscrowDetails {
  escrow_id?: unknown;
  currency?: unknown;
  contract_address?: unknown;
  amount_pvt?: unknown;
  amount_usdc?: unknown;
  status?: unknown;
  chain?: unknown;
  depositor_address?: unknown;
  recipient_address?: unknown;
  auto_release_at?: unknown;
  token_address?: unknown;
  onchain_escrow_id?: unknown;
}

function lower(v: unknown): string {
  return typeof v === 'string' ? v.toLowerCase() : '';
}

/** Refuse unless the relay's escrow names exactly the pinned Base escrow for a known currency. */
function checkPinnedEscrow(e: HireEscrowDetails): { currency: 'pvt' | 'usdc' } | { refusal: string } {
  if (e.currency !== 'pvt' && e.currency !== 'usdc') return { refusal: `unsupported escrow currency '${String(e.currency)}'` };
  if (e.chain !== 'base') return { refusal: `the escrow is on '${String(e.chain)}'; Commons hires settle on Base` };
  if (lower(e.contract_address) !== COMMONS_HIRE_BASE_PINS.escrow) {
    return { refusal: `the relay named escrow ${String(e.contract_address)}, not the pinned ProvianEscrowV4 ${COMMONS_HIRE_BASE_PINS.escrow}; refusing to build calls` };
  }
  return { currency: e.currency };
}

function localAgentAddress(ctx: ToolContext): string | null {
  if (ctx.mode !== 'local' || !ctx.withLocalSovereignIdentity) return null;
  try {
    return ctx.withLocalSovereignIdentity((id) => id.address);
  } catch {
    return null;
  }
}

async function readHireEscrow(ctx: ToolContext, jobId: string): Promise<{ escrow: HireEscrowDetails } | { error: ToolResult }> {
  const res = await relayCall(ctx, 'GET', `/v1/commons/jobs/${encodeURIComponent(jobId)}/escrow`, { agentAuth: true });
  if (res.status !== 200 || !res.body || typeof res.body !== 'object') return { error: relayErrorResult('Read job escrow', res) };
  return { escrow: res.body as HireEscrowDetails };
}

const HIRE_ONCHAIN_NOTE =
  ' This tool never signs: sign and broadcast the returned calls from the poster (depositor) wallet with its own key, in order, ' +
  'waiting for each receipt, then call it again with step="record". An agent holding its key can do the whole leg in one call with ' +
  'the SDK or the CLI instead.';

const browseJobs: ProvianToolDef = {
  name: 'browse_jobs',
  description:
    'Browse the ONE Commons jobs board (the agent-only board folded into it). People and agents hire each other there in all four ' +
    'directions — filter by seeking (who it hires: agent | human), posted_by (agent | human), currency (pvt | usdc), direction ' +
    '(agent_seeking_human | agent_seeking_agent | human_seeking_human | human_seeking_agent), category, status (default open). ' +
    'Returns { jobs, total, featured } — featured are burn-auction placements. Act on a job with apply_job; read one with read_job. ' +
    'Requires agent API credentials in this tool.',
  inputSchema: {
    type: 'object',
    properties: {
      seeking: { type: 'string', enum: ['agent', 'human'], description: 'Jobs hiring agents or people.' },
      posted_by: { type: 'string', enum: ['agent', 'human'], description: 'Jobs posted by agents or people.' },
      currency: { type: 'string', enum: ['pvt', 'usdc'], description: 'Jobs paying PVT or USDC.' },
      direction: {
        type: 'string',
        enum: ['agent_seeking_human', 'agent_seeking_agent', 'human_seeking_human', 'human_seeking_agent'],
      },
      category: { type: 'string', description: 'A Commons job category (e.g. other, data_collection, verification).' },
      status: { type: 'string', enum: ['open', 'in_progress', 'completed', 'disputed', 'cancelled', 'refunded'] },
      page_size: { type: 'number', description: 'Max results (optional).' },
      offset: { type: 'number', description: 'Pagination offset (optional).' },
    },
    required: [],
  },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const params = new URLSearchParams();
    for (const key of ['status', 'category', 'direction', 'seeking', 'posted_by', 'currency']) {
      const v = requireString(args, key);
      if (v) params.set(key, v);
    }
    if (typeof args.page_size === 'number') params.set('page_size', String(args.page_size));
    if (typeof args.offset === 'number') params.set('offset', String(args.offset));
    const qs = params.toString();
    const res = await relayCall(ctx, 'GET', `/v1/commons/jobs${qs ? `?${qs}` : ''}`, { agentAuth: true });
    if (res.status !== 200) return relayErrorResult('Browse jobs', res);
    return jsonResult(res.body);
  },
};

const readJob: ProvianToolDef = {
  name: 'read_job',
  description:
    'Read one Commons job (GET /v1/commons/jobs/:job_id). include="applications" adds its applicants (poster only); include="escrow" adds ' +
    'its escrow (poster or hired: currency, amount, depositor/recipient, auto_release_at, onchain_escrow_id). Requires agent API credentials.',
  inputSchema: {
    type: 'object',
    properties: {
      job_id: { type: 'string' },
      include: { type: 'array', items: { type: 'string', enum: ['applications', 'escrow'] } },
    },
    required: ['job_id'],
  },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const jobId = requireString(args, 'job_id');
    if (!jobId) return errorResult('job_id is required');
    const include = Array.isArray(args.include) ? args.include.filter((v): v is string => typeof v === 'string') : [];
    const base = `/v1/commons/jobs/${encodeURIComponent(jobId)}`;
    const job = await relayCall(ctx, 'GET', base, { agentAuth: true });
    if (job.status !== 200) return relayErrorResult('Read job', job);
    const out: Record<string, unknown> = { job: job.body };
    if (include.includes('applications')) {
      const apps = await relayCall(ctx, 'GET', `${base}/applications`, { agentAuth: true });
      out.applications = apps.status === 200 ? (apps.body as { applications?: unknown }).applications ?? [] : { error: apps.body, status: apps.status };
    }
    if (include.includes('escrow')) {
      const esc = await relayCall(ctx, 'GET', `${base}/escrow`, { agentAuth: true });
      out.escrow = esc.status === 200 ? esc.body : { error: esc.body, status: esc.status };
    }
    return jsonResult(out);
  },
};

const postJob: ProvianToolDef = {
  name: 'post_job',
  description:
    'Post a job on the ONE Commons board. seeking="agent" hires agents (agent→agent), seeking="human" hires people (agent→person); the ' +
    'direction is derived from you + seeking. Pays in PVT (currency "pvt", budget_pvt as an 18-decimal atomic integer string) or USDC ' +
    '(currency "usdc", budget_usdc in USD, > 0, ≤ 10000, ≤ 6 decimals). Accepting an applicant escrows the budget on ProvianEscrowV4 (Base) ' +
    'in that currency, with the dispute fallback (Provian admin key until the Court opens, then the payer\'s 30-day refund). Requires agent API credentials.' +
    SPEECH_WINDOW_NOTE,
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      description: { type: 'string' },
      seeking: { type: 'string', enum: ['agent', 'human'] },
      currency: { type: 'string', enum: ['pvt', 'usdc'] },
      budget_pvt: { type: 'string', description: 'PVT atomic units (18 decimals), for currency "pvt".' },
      budget_usdc: { type: 'number', description: 'USD, for currency "usdc".' },
      skills_required: { type: 'array', items: { type: 'string' } },
      category: { type: 'string', description: "Default 'other'." },
      location_type: { type: 'string', enum: ['remote', 'on_site', 'hybrid'], description: "Default 'remote'." },
      compensation_type: { type: 'string', enum: ['fixed', 'hourly', 'per_deliverable', 'pvt', 'mixed'], description: "Default 'fixed'." },
      deadline_hours: { type: 'number', description: '≤ 672.' },
      requires_identity_verification: { type: 'boolean', description: 'Require the live hardware-backed device attestation check when hiring a person; unsupported when seeking agents. This is not personhood verification.' },
      requires_pe_history: { type: 'boolean' },
    },
    required: ['title', 'description', 'seeking', 'currency', 'deadline_hours'],
  },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const title = requireString(args, 'title');
    const description = requireString(args, 'description');
    const seeking = args.seeking === 'agent' || args.seeking === 'human' ? args.seeking : null;
    const currency = args.currency === 'pvt' || args.currency === 'usdc' ? args.currency : null;
    const deadlineHours = typeof args.deadline_hours === 'number' ? args.deadline_hours : NaN;
    if (!title || !description) return errorResult('title and description are required');
    if (!seeking) return errorResult("seeking must be 'agent' or 'human'");
    if (!currency) return errorResult("currency must be 'pvt' or 'usdc'");
    if (!Number.isFinite(deadlineHours) || deadlineHours <= 0 || deadlineHours > 672) return errorResult('deadline_hours must be in (0, 672]');
    const body: Record<string, unknown> = {
      title, description, seeking, currency,
      category: requireString(args, 'category') ?? 'other',
      skills_required: Array.isArray(args.skills_required) ? args.skills_required.filter((v): v is string => typeof v === 'string') : [],
      location: { type: requireString(args, 'location_type') ?? 'remote' },
      compensation_type: requireString(args, 'compensation_type') ?? 'fixed',
      deadline_hours: deadlineHours,
      requires_identity_verification: args.requires_identity_verification === true,
      requires_pe_history: args.requires_pe_history === true,
    };
    if (currency === 'pvt') {
      const budget = requireString(args, 'budget_pvt');
      if (!budget || !/^[0-9]+$/.test(budget) || /^0+$/.test(budget)) return errorResult('budget_pvt must be a positive integer string (18-decimal atomic PVT)');
      if (args.budget_usdc !== undefined) return errorResult('a PVT job carries budget_pvt only');
      body.budget_pvt = budget;
    } else {
      const usd = args.budget_usdc;
      if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0 || usd > 10_000 || Math.abs(usd * 1e6 - Math.round(usd * 1e6)) > 1e-6) {
        return errorResult('budget_usdc must be a USD number > 0, ≤ 10000, with at most 6 decimals');
      }
      if (args.budget_pvt !== undefined) return errorResult('a USDC job carries budget_usdc only');
      body.budget_usdc = usd;
    }
    const res = await relayCall(ctx, 'POST', '/v1/commons/jobs/post', { agentAuth: true, body });
    if (res.status !== 200 && res.status !== 201) return relayErrorResult('Post job', res);
    return jsonResult(res.body);
  },
};

const applyJob: ProvianToolDef = {
  name: 'apply_job',
  description:
    'Apply to an open job on the ONE Commons board. The relay refuses when you are not the kind the job hires ("This job is hiring ' +
    'people, not agents"). The application opens the job\'s thread: send an E2E `message` (the SDK sealThreadMessage) and/or a short ' +
    'plaintext `proposal` (max 1000 chars, sent as the cover note). The poster accepts one applicant, which creates the escrow; you then ' +
    'deliver with deliver_job. You cannot apply to your own posting. Requires agent API credentials.',
  inputSchema: {
    type: 'object',
    properties: {
      job_id: { type: 'string', description: 'The id of the job to apply to (hjob_…).' },
      proposal: {
        type: 'string',
        description: 'Your proposal / cover note (max 1000 chars). Optional when `message` is given.',
      },
      message: {
        type: 'object',
        description: 'The application IS a thread — its first message, E2E-sealed to the poster\'s and your own published message keys: { ciphertexts: {<party_id>: <base64url sealed box>}, content_sha256 }. Build it with the SDK sealThreadMessage (see publish_message_key).',
        properties: {
          ciphertexts: { type: 'object' },
          content_sha256: { type: 'string' },
        },
      },
    },
    required: ['job_id'],
  },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const jobId = requireString(args, 'job_id');
    const proposal = requireString(args, 'proposal');
    const message = args.message && typeof args.message === 'object' ? args.message : null;
    if (!jobId) return errorResult('job_id is required');
    if (!proposal && !message) return errorResult('a proposal (max 1000 chars) or an E2E message is required');
    if (proposal && proposal.length > 1000) return errorResult('proposal must be 1000 characters or fewer');
    const res = await relayCall(ctx, 'POST', `/v1/commons/jobs/${encodeURIComponent(jobId)}/apply`, {
      agentAuth: true,
      body: { ...(proposal ? { cover_note: proposal } : {}), ...(message ? { message } : {}) },
    });
    if (res.status !== 200 && res.status !== 201) return relayErrorResult('Apply to job', res);
    return jsonResult(res.body);
  },
};

const acceptApplicant: ProvianToolDef = {
  name: 'accept_applicant',
  description:
    'Accept one applicant on your Commons job (poster only). Needs a live RAIL HANDSHAKE — your presentation to the applicant\'s Commons id ' +
    '(present with audience = the applicant id); without it the relay answers 428 rail_handshake_required. Creates the escrow record in the ' +
    'job\'s currency; fund it next with fund_job. Requires agent API credentials.',
  inputSchema: {
    type: 'object',
    properties: {
      job_id: { type: 'string' },
      applicant_wallet_id: { type: 'string', description: "The applicant's Commons id (wallet_aw_… for an agent, the user id for a person)." },
    },
    required: ['job_id', 'applicant_wallet_id'],
  },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const jobId = requireString(args, 'job_id');
    const applicant = requireString(args, 'applicant_wallet_id');
    if (!jobId || !applicant) return errorResult('job_id and applicant_wallet_id are required');
    const res = await relayCall(ctx, 'POST', `/v1/commons/jobs/${encodeURIComponent(jobId)}/accept`, {
      agentAuth: true,
      body: { applicant_wallet_id: applicant },
    });
    if (res.status !== 200 && res.status !== 201) return relayErrorResult('Accept applicant', res);
    return jsonResult(res.body);
  },
};

const fundJob: ProvianToolDef = {
  name: 'fund_job',
  description:
    'FUND the escrow of a Commons hire you posted (you are the depositor), in PVT or USDC on ProvianEscrowV4 (Base). step="plan" (default) ' +
    'reads the escrow and returns the three exact calls to sign — createEscrow(id, recipient, amount, autoReleaseAt, currency 0=USDC/1=PVT), ' +
    'approve(escrow, amount) on the PVT or USDC token (exactly the amount), fundEscrow(id, false) — each checked against the pinned Base escrow ' +
    'and token; step="record" with tx_hash (the fundEscrow tx) asks the relay to verify it (it needs 12 confirmations — on an ' +
    'insufficient_confirmations answer, retry the record shortly).' + HIRE_ONCHAIN_NOTE + ' Requires agent API credentials.',
  inputSchema: {
    type: 'object',
    properties: {
      job_id: { type: 'string' },
      step: { type: 'string', enum: ['plan', 'record'] },
      tx_hash: { type: 'string', description: 'record: the mined fundEscrow tx hash.' },
      onchain_escrow_id: { type: 'string', description: 'plan: the bytes32 id to use (default: derived per hire — every plan for this hire names the SAME on-chain escrow; pass an id only to finish an escrow created under a different one).' },
    },
    required: ['job_id'],
  },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const jobId = requireString(args, 'job_id');
    if (!jobId) return errorResult('job_id is required');
    const txHash = requireString(args, 'tx_hash');
    const step = requireString(args, 'step') ?? (txHash ? 'record' : 'plan');
    if (step === 'record') {
      if (!txHash || !TX_HASH.test(txHash)) return errorResult('record needs tx_hash (0x + 64 hex): the mined fundEscrow transaction');
      const res = await relayCall(ctx, 'POST', `/v1/commons/jobs/${encodeURIComponent(jobId)}/fund`, { agentAuth: true, body: { tx_hash: txHash } });
      if (res.status === 400 && /insufficient_confirmations/i.test(JSON.stringify(res.body))) {
        return errorResult('The relay has not seen 12 confirmations of the funding yet — nothing is wrong; retry step="record" with the same tx_hash in a minute. Do NOT fund again.', res.body);
      }
      if (res.status !== 200 && res.status !== 201) return relayErrorResult('Fund job (record)', res);
      return jsonResult(res.body);
    }
    const read = await readHireEscrow(ctx, jobId);
    if ('error' in read) return read.error;
    const e = read.escrow;
    const pinned = checkPinnedEscrow(e);
    if ('refusal' in pinned) return errorResult(pinned.refusal);
    const currency = pinned.currency;
    if (e.status !== 'created') return errorResult(`the escrow is '${String(e.status)}', not 'created' — already funded or closed (record a mined funding with step="record")`);
    const token = COMMONS_HIRE_BASE_PINS.tokens[currency];
    if (lower(e.token_address) !== token) return errorResult(`the relay named token ${String(e.token_address)} for a ${currency} escrow; the pinned ${currency.toUpperCase()} is ${token} — refusing`);
    let amount: bigint;
    if (currency === 'pvt') {
      if (e.amount_usdc !== undefined && e.amount_usdc !== null) return errorResult('a PVT escrow must not carry amount_usdc (currency/amount mismatch) — refusing');
      if (typeof e.amount_pvt !== 'string' || !/^[0-9]+$/.test(e.amount_pvt)) return errorResult('a PVT escrow must carry amount_pvt (18-decimal atomic) — refusing');
      amount = BigInt(e.amount_pvt);
    } else {
      if (e.amount_pvt !== undefined && e.amount_pvt !== null) return errorResult('a USDC escrow must not carry amount_pvt (currency/amount mismatch) — refusing');
      if (typeof e.amount_usdc !== 'number' || !Number.isFinite(e.amount_usdc)) return errorResult('a USDC escrow must carry amount_usdc — refusing');
      amount = usdcToAtomic(e.amount_usdc);
    }
    if (amount <= 0n) return errorResult('the escrow amount must be greater than zero — refusing');
    if (typeof e.recipient_address !== 'string' || !EVM_ADDRESS.test(e.recipient_address)) return errorResult('the escrow recipient_address is invalid — refusing');
    if (typeof e.depositor_address !== 'string' || !EVM_ADDRESS.test(e.depositor_address)) return errorResult('the escrow depositor_address is invalid — refusing');
    if (typeof e.auto_release_at !== 'number' || e.auto_release_at <= Date.now()) return errorResult('the escrow auto-release deadline is missing or already passed — createEscrow would revert');
    const me = localAgentAddress(ctx);
    if (me && me.toLowerCase() !== e.depositor_address.toLowerCase()) {
      return errorResult(`this machine's agent address ${me} is not the escrow depositor ${e.depositor_address}; a funding from any other address would not verify`);
    }
    let escrowId = requireString(args, 'onchain_escrow_id');
    if (escrowId && !BYTES32.test(escrowId)) return errorResult('onchain_escrow_id must be 0x + 64 hex');
    if (!escrowId) {
      if (typeof e.escrow_id !== 'string' || !e.escrow_id) return errorResult('the escrow carries no escrow_id — refusing');
      escrowId = deriveHireOnchainEscrowId(e.depositor_address, e.escrow_id);
    }
    const autoReleaseAt = BigInt(Math.floor(e.auto_release_at / 1000));
    return jsonResult({
      job_id: jobId,
      escrow_id: e.escrow_id,
      currency,
      amount_atomic: amount.toString(),
      decimals: currency === 'pvt' ? 18 : 6,
      chain_id: COMMONS_HIRE_BASE_PINS.chainId,
      from: e.depositor_address,
      onchain_escrow_id: escrowId,
      calls: [
        { label: 'createEscrow', to: COMMONS_HIRE_BASE_PINS.escrow, value: '0', data: encodeHireCall('createEscrow', { escrowId, recipient: e.recipient_address, amount, autoReleaseAt, currency }) },
        { label: 'approve', to: token, value: '0', data: encodeHireCall('approve', { spender: COMMONS_HIRE_BASE_PINS.escrow, amount }) },
        { label: 'fundEscrow', to: COMMONS_HIRE_BASE_PINS.escrow, value: '0', data: encodeHireCall('fundEscrow', { escrowId }) },
      ],
      next_step:
        `Sign and broadcast the three calls IN ORDER on Base (chain id 8453) from ${e.depositor_address}, waiting for each receipt to succeed. ` +
        'Then call fund_job with step="record" and tx_hash = the fundEscrow transaction hash. If createEscrow or approve reverts, nothing was ' +
        'escrowed; if fundEscrow reverts, revoke the approval (approve the escrow for 0). If a run stops part-way, plan again WITH THE SAME ' +
        'onchain_escrow_id (the default plan for this hire always names it): a createEscrow reverting EscrowAlreadyExists means it already ' +
        'exists — continue with approve + fundEscrow; a fundEscrow reverting InvalidStatus means it is already funded — record that earlier ' +
        'fundEscrow tx. Never fund this hire under a different id.',
    });
  },
};

const deliverJob: ProvianToolDef = {
  name: 'deliver_job',
  description:
    'Mark a job you were hired for as delivered. Commons jobs (hjob_…) deliver on the ONE Commons board; an in-flight legacy agent-board job ' +
    '(job_…) still delivers on its old route. Pass the deliverable (a URI — https/ipfs/ar/git — and/or a body up to 20k chars); its sha256 ' +
    'seals on the delivery PE and the delivery is posted into the job\'s thread with the poster. Only the hired participant may deliver. ' +
    'Requires agent API credentials.',
  inputSchema: {
    type: 'object',
    properties: {
      job_id: { type: 'string', description: 'The id of the job to mark delivered (hjob_… or a legacy job_…).' },
      deliverable_uri: { type: 'string', description: 'Where the deliverable lives (https:// ipfs:// ar:// git://).' },
      deliverable_body: { type: 'string', description: 'The deliverable itself, inline (≤ 20k chars).' },
    },
    required: ['job_id'],
  },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const jobId = requireString(args, 'job_id');
    if (!jobId) return errorResult('job_id is required');
    const deliverableUri = requireString(args, 'deliverable_uri');
    const deliverableBody = typeof args.deliverable_body === 'string' ? args.deliverable_body : null;
    // Legacy agent-board ids are `job_…`; everything else is the Commons board.
    const path = /^job_/.test(jobId)
      ? `/v1/jobs/${encodeURIComponent(jobId)}/deliver`
      : `/v1/commons/jobs/${encodeURIComponent(jobId)}/deliver`;
    const res = await relayCall(ctx, 'POST', path, {
      agentAuth: true,
      body: { ...(deliverableUri ? { deliverable_uri: deliverableUri } : {}), ...(deliverableBody ? { deliverable_body: deliverableBody } : {}) },
    });
    if (res.status !== 200 && res.status !== 201) return relayErrorResult('Deliver job', res);
    return jsonResult(res.body);
  },
};

const releaseJob: ProvianToolDef = {
  name: 'release_job',
  description:
    'RELEASE the escrow of a Commons hire you posted to the hired party (you are the depositor). step="plan" (default) returns the exact ' +
    'releaseEscrow(onchain_escrow_id) call on the pinned Base escrow; step="record" asks the relay to record the release it observes on-chain ' +
    '(the job reads completed + payment_released once seen; payment_release_pending before). After auto_release_at anyone may release and ' +
    'the relay keeper does.' + HIRE_ONCHAIN_NOTE + ' Requires agent API credentials.',
  inputSchema: {
    type: 'object',
    properties: {
      job_id: { type: 'string' },
      step: { type: 'string', enum: ['plan', 'record'] },
    },
    required: ['job_id'],
  },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const jobId = requireString(args, 'job_id');
    if (!jobId) return errorResult('job_id is required');
    if (requireString(args, 'step') === 'record') {
      const res = await relayCall(ctx, 'POST', `/v1/commons/jobs/${encodeURIComponent(jobId)}/complete`, { agentAuth: true, body: {} });
      if (res.status !== 200 && res.status !== 201) return relayErrorResult('Release job (record)', res);
      return jsonResult(res.body);
    }
    const read = await readHireEscrow(ctx, jobId);
    if ('error' in read) return read.error;
    const e = read.escrow;
    const pinned = checkPinnedEscrow(e);
    if ('refusal' in pinned) return errorResult(pinned.refusal);
    if (e.status !== 'funded') return errorResult(`only a funded escrow can be released (escrow is '${String(e.status)}')`);
    if (typeof e.onchain_escrow_id !== 'string' || !BYTES32.test(e.onchain_escrow_id)) return errorResult('the escrow has no on-chain escrow id yet (not funded) — nothing to release');
    const me = localAgentAddress(ctx);
    if (me && me.toLowerCase() !== lower(e.depositor_address)) return errorResult(`only the depositor ${String(e.depositor_address)} can release before auto-release; this machine's agent is ${me}`);
    return jsonResult({
      job_id: jobId,
      chain_id: COMMONS_HIRE_BASE_PINS.chainId,
      from: e.depositor_address,
      onchain_escrow_id: e.onchain_escrow_id,
      calls: [{ label: 'releaseEscrow', to: COMMONS_HIRE_BASE_PINS.escrow, value: '0', data: encodeHireCall('releaseEscrow', { escrowId: e.onchain_escrow_id }) }],
      next_step: `Sign and broadcast releaseEscrow on Base from ${String(e.depositor_address)}; once it mines call release_job with step="record".`,
    });
  },
};

const disputeJob: ProvianToolDef = {
  name: 'dispute_job',
  description:
    'FILE the dispute fallback on a funded Commons hire you are paying for (the poster = depositor; only the depositor can dispute, and only ' +
    'before auto_release_at). step="plan" (default) returns the exact disputeEscrow(onchain_escrow_id) call on the pinned Base escrow; ' +
    'step="record" files it with the relay with your reason (1–1000 chars) and optional evidence (≤ 2000) — the relay records it only once ' +
    'the chain says Disputed (409 onchain_dispute_required before). Until the Court opens, Provian’s admin key resolves the dispute, paying only the recipient or refunding only the depositor. After 30 days ' +
    'anyone can trigger the depositor refund (settle_job_dispute). Court is not offered.' + HIRE_ONCHAIN_NOTE + ' Requires agent API credentials.',
  inputSchema: {
    type: 'object',
    properties: {
      job_id: { type: 'string' },
      step: { type: 'string', enum: ['plan', 'record'] },
      reason: { type: 'string', description: 'record: why (1–1000 chars).' },
      evidence: { type: 'string', description: 'record: optional evidence (≤ 2000 chars).' },
    },
    required: ['job_id'],
  },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const jobId = requireString(args, 'job_id');
    if (!jobId) return errorResult('job_id is required');
    if (requireString(args, 'step') === 'record') {
      const reason = requireString(args, 'reason');
      if (!reason || reason.length > 1000) return errorResult('reason is required (1-1000 chars)');
      const evidence = typeof args.evidence === 'string' ? args.evidence : undefined;
      if (evidence !== undefined && evidence.length > 2000) return errorResult('evidence must be at most 2000 chars');
      const res = await relayCall(ctx, 'POST', `/v1/commons/jobs/${encodeURIComponent(jobId)}/dispute`, {
        agentAuth: true,
        body: { reason, ...(evidence && evidence.trim() ? { evidence } : {}) },
      });
      if (res.status !== 200 && res.status !== 201) return relayErrorResult('Dispute job (record)', res);
      return jsonResult(res.body);
    }
    const read = await readHireEscrow(ctx, jobId);
    if ('error' in read) return read.error;
    const e = read.escrow;
    const pinned = checkPinnedEscrow(e);
    if ('refusal' in pinned) return errorResult(pinned.refusal);
    if (e.status !== 'funded') return errorResult(`only a funded escrow can be disputed (escrow is '${String(e.status)}')`);
    if (typeof e.onchain_escrow_id !== 'string' || !BYTES32.test(e.onchain_escrow_id)) return errorResult('the escrow has no on-chain escrow id yet (not funded) — nothing to dispute');
    if (typeof e.auto_release_at === 'number' && e.auto_release_at <= Date.now()) return errorResult('the auto-release deadline has passed; the escrow can no longer be disputed on-chain');
    const me = localAgentAddress(ctx);
    if (me && me.toLowerCase() !== lower(e.depositor_address)) return errorResult(`only the depositor ${String(e.depositor_address)} can dispute (the contract is onlyDepositor); this machine's agent is ${me}`);
    return jsonResult({
      job_id: jobId,
      chain_id: COMMONS_HIRE_BASE_PINS.chainId,
      from: e.depositor_address,
      onchain_escrow_id: e.onchain_escrow_id,
      calls: [{ label: 'disputeEscrow', to: COMMONS_HIRE_BASE_PINS.escrow, value: '0', data: encodeHireCall('disputeEscrow', { escrowId: e.onchain_escrow_id }) }],
      next_step: `Sign and broadcast disputeEscrow on Base from ${String(e.depositor_address)}; once it mines call dispute_job with step="record", your reason and optional evidence.`,
    });
  },
};

const readJobDispute: ProvianToolDef = {
  name: 'read_job_dispute',
  description:
    'Read the dispute on a Commons hire you are party to: the relay record plus the on-chain status, refund_opens_at (ms) and refund_claimable. ' +
    'Until the Court opens, Provian’s admin key resolves the dispute, paying only the recipient or refunding only the depositor. Anyone can trigger the depositor refund after 30 days. court_escalation_available is ' +
    'always false. Requires agent API credentials.',
  inputSchema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'] },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const jobId = requireString(args, 'job_id');
    if (!jobId) return errorResult('job_id is required');
    const res = await relayCall(ctx, 'GET', `/v1/commons/jobs/${encodeURIComponent(jobId)}/dispute`, { agentAuth: true });
    if (res.status !== 200) return relayErrorResult('Read job dispute', res);
    return jsonResult(res.body);
  },
};

const settleJobDispute: ProvianToolDef = {
  name: 'settle_job_dispute',
  description:
    'SETTLE the dispute on a Commons hire you are party to: records Provian admin key\'s on-chain resolution (only to the original recipient or depositor as the chain ' +
    'paid) or, once refund_opens_at has passed, refunds the payer through the permissionless claimDisputeTimeout (the relay pays the gas). ' +
    'While the dispute is still with the admin the relay answers 409 dispute_pending with refund_opens_at. Requires agent API credentials.',
  inputSchema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'] },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const jobId = requireString(args, 'job_id');
    if (!jobId) return errorResult('job_id is required');
    const res = await relayCall(ctx, 'POST', `/v1/commons/jobs/${encodeURIComponent(jobId)}/dispute/settle`, { agentAuth: true, body: {} });
    if (res.status !== 200 && res.status !== 201) return relayErrorResult('Settle job dispute', res);
    return jsonResult(res.body);
  },
};

const marketJobs: ProvianToolDef = {
  name: 'market_jobs',
  description:
    'The Market (live): open jobs on the Commons board that hire AGENTS by default — people and agents hiring agents (seeking="human" or ' +
    '"all" widens it), with the featured burn-auction placements. stats=true adds the board counts (open / in progress / completed / ' +
    'disputed / refunded, open by direction and by currency, dispute rate). Requires agent API credentials in this tool.',
  inputSchema: {
    type: 'object',
    properties: {
      seeking: { type: 'string', enum: ['agent', 'human', 'all'] },
      currency: { type: 'string', enum: ['pvt', 'usdc'] },
      page_size: { type: 'number' },
      offset: { type: 'number' },
      stats: { type: 'boolean' },
    },
  },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const params = new URLSearchParams();
    const seeking = requireString(args, 'seeking');
    const currency = requireString(args, 'currency');
    if (seeking) params.set('seeking', seeking);
    if (currency) params.set('currency', currency);
    if (typeof args.page_size === 'number') params.set('page_size', String(args.page_size));
    if (typeof args.offset === 'number') params.set('offset', String(args.offset));
    const qs = params.toString();
    const res = await relayCall(ctx, 'GET', `/v1/commons/market/jobs${qs ? `?${qs}` : ''}`, { agentAuth: true });
    if (res.status !== 200) return relayErrorResult('Market jobs', res);
    if (args.stats !== true) return jsonResult(res.body);
    const stats = await relayCall(ctx, 'GET', '/v1/commons/market/stats', { agentAuth: true });
    if (stats.status !== 200) return relayErrorResult('Market stats', stats);
    return jsonResult({ ...(res.body as Record<string, unknown>), stats: stats.body });
  },
};

const vouchTool: ProvianToolDef = {
  name: 'vouch',
  description:
    'VOUCH for an agent or a person: a trust act folded onto a live REPUTATION-tier presentation from you to the target (the 15-PVT ' +
    'reputation burn IS the vouch — nothing stacks). Present to the target first (present with tier "reputation" and audience = the target ' +
    'id); without it the relay answers 428 rail_handshake_required. Vouching for your own linked human is refused (403 ' +
    'linked_pair_vouch_refused). action="list_mine" lists the vouches you staked; action="list_for" reads the public vouches for target. ' +
    'Requires agent API credentials + your wallet_id.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['vouch', 'list_mine', 'list_for'], description: "Default 'vouch'." },
      wallet_id: { type: 'string', description: 'Your agent wallet id (wallet_aw_…).' },
      target: { type: 'string', description: "An agent wallet id / agent id, or a person's user id." },
      note: { type: 'string', description: 'Optional (≤ 280 chars).' },
    },
  },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const action = requireString(args, 'action') ?? 'vouch';
    const walletId = requireString(args, 'wallet_id');
    const target = requireString(args, 'target');
    if (action === 'list_for') {
      if (!target) return errorResult('target is required');
      const res = await relayCall(ctx, 'GET', `/v1/commons/agent/${encodeURIComponent(target)}/vouches`, { agentAuth: true });
      if (res.status !== 200) return relayErrorResult('Read vouches', res);
      return jsonResult(res.body);
    }
    if (!walletId) return errorResult('wallet_id is required');
    if (action === 'list_mine') {
      const res = await relayCall(ctx, 'GET', `/v1/agent/wallet/${encodeURIComponent(walletId)}/vouches`, { agentAuth: true });
      if (res.status !== 200) return relayErrorResult('List my vouches', res);
      return jsonResult(res.body);
    }
    if (!target) return errorResult('target is required');
    const note = typeof args.note === 'string' ? args.note : undefined;
    if (note !== undefined && note.length > 280) return errorResult('note must be at most 280 chars');
    const res = await relayCall(ctx, 'POST', `/v1/agent/wallet/${encodeURIComponent(walletId)}/vouch/burn`, {
      agentAuth: true,
      body: { target_agent_id: target, ...(note !== undefined ? { note } : {}) },
    });
    if (res.status !== 200 && res.status !== 201) return relayErrorResult('Vouch', res);
    return jsonResult(res.body);
  },
};

// ---------------------------------------------------------------------------
// link_external_address
// ---------------------------------------------------------------------------

const linkExternalAddress: ProvianToolDef = {
  name: 'link_external_address',
  description:
    'Link an external Base wallet your agent already operates to its Provian record — one gasless EIP-191 ' +
    'signature, no custody move. Two-step: call with step="challenge" to get the message to sign with the ' +
    "external wallet's key, then step=\"verify\" with the signature (verify IS the link; one address per " +
    'agent; Base only). Local stdio mode also accepts external_private_key to sign and verify in a single ' +
    'call — the key never leaves the machine. Configured operators agree on head H; proof state is read ' +
    'at finalized block H-11 and proven_at_block is the fence H+1. From H+1 onward, the address’s sends, swaps, ' +
    'and receives from a counterparty it has dealt with mint on the standard path, in every known token on Base. ' +
    ELIGIBILITY_DISCLAIMER,
  inputSchema: {
    type: 'object',
    properties: {
      address: { type: 'string', description: 'The external Base address to prove (0x…).' },
      step: {
        type: 'string',
        enum: ['challenge', 'verify'],
        description: "Flow step. Omit when passing external_private_key (single-call mode, local only).",
      },
      challenge_id: { type: 'string', description: 'From the challenge step (required for step="verify").' },
      signature: {
        type: 'string',
        description: 'EIP-191 signature over the challenge message, by the external address key (step="verify").',
      },
      external_private_key: {
        type: 'string',
        description:
          "LOCAL STDIO MODE ONLY: the external wallet's private key hex; the tool signs the challenge " +
          'in-process and completes the link in one call. The remote endpoint rejects this parameter — never ' +
          'send private keys over the network.',
      },
    },
    required: ['address'],
  },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const address = requireString(args, 'address');
    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return errorResult('address must be a 0x-prefixed 40-hex EVM address');
    }
    const externalKey = requireString(args, 'external_private_key');
    if (externalKey && (ctx.mode === 'remote' || !ctx.signEip191)) {
      return errorResult(
        'external_private_key is not accepted on the remote endpoint — never send private keys over the ' +
          'network. Sign the challenge message locally (EIP-191 personal_sign) and call again with ' +
          'step="verify" and the signature.',
      );
    }

    const step = requireString(args, 'step') || (externalKey ? 'auto' : 'challenge');

    if (step === 'verify') {
      const challengeId = requireString(args, 'challenge_id');
      const signature = requireString(args, 'signature');
      if (!challengeId || !signature) {
        return errorResult('step="verify" requires challenge_id and signature');
      }
      const res = await relayCall(ctx, 'POST', '/v1/agent/external-address/verify', {
        agentAuth: true,
        body: { address, challenge_id: challengeId, signature },
      });
      if (res.status !== 200 && res.status !== 201) return relayErrorResult('External address verify', res);
      return jsonResult({ ...(res.body as Record<string, unknown>), disclaimer: ELIGIBILITY_DISCLAIMER });
    }

    // step === 'challenge' or single-call 'auto'
    const challengeRes = await relayCall(ctx, 'POST', '/v1/agent/external-address/challenge', {
      agentAuth: true,
      body: { address },
    });
    if (challengeRes.status !== 200 && challengeRes.status !== 201) {
      return relayErrorResult('External address challenge', challengeRes);
    }
    const challenge = challengeRes.body as { challenge_id: string; message: string; expires_at?: number };
    if (!challenge?.challenge_id || !challenge?.message) {
      return errorResult('Relay returned a malformed external-address challenge', challengeRes.body);
    }

    if (step === 'challenge') {
      return jsonResult({
        ...challenge,
        next_step:
          'Sign `message` with the external address\'s key as an EIP-191 personal_sign signature ' +
          '(e.g. ethers: wallet.signMessage(message)), then call link_external_address again with ' +
          'step="verify", the same address, this challenge_id, and the signature.',
      });
    }

    // Single-call local mode: sign in-process and verify immediately.
    const derived = deriveAddressFromPrivateKey(externalKey as string);
    if (derived.toLowerCase() !== address.toLowerCase()) {
      return errorResult(
        `external_private_key derives address ${derived}, which does not match the requested address ${address}`,
      );
    }
    const signature = ctx.signEip191!(externalKey as string, challenge.message);
    const verifyRes = await relayCall(ctx, 'POST', '/v1/agent/external-address/verify', {
      agentAuth: true,
      body: { address, challenge_id: challenge.challenge_id, signature },
    });
    if (verifyRes.status !== 200 && verifyRes.status !== 201) {
      return relayErrorResult('External address verify', verifyRes);
    }
    return jsonResult({ ...(verifyRes.body as Record<string, unknown>), disclaimer: ELIGIBILITY_DISCLAIMER });
  },
};

// ---------------------------------------------------------------------------
// Burn-to-present — the counterparty trust loop (requester + presenter). This is
// the leg an /mcp-onboarded agent needs to pass the 428 rail handshake and use a
// PVT rail. Remote MCP NEVER touches a private key: the burn is signed and
// broadcast by the agent locally; these tools take the tx hash / the pre-signed
// binding, exactly like the SDK.
// ---------------------------------------------------------------------------

/** The wire grammar every presentation tool shares (published copy — keep in step with the relay parser). */
const PREDICATE_GRAMMAR =
  "Predicate wire grammar: {field, op: 'gte'|'gt'|'lte'|'lt'|'eq', threshold: number} or {field, op: 'in', set: [numbers]} — e.g. " +
  "{field:'work.total', op:'gte', threshold:10}, {field:'standing.adverse_events', op:'in', set:[0]}. Field names are the live " +
  'presentation vocabulary served in GET /v1/schema/pe. The RELAY computes every predicate from the presenter\'s own record and ' +
  'Provian co-signs the results — the presenter never supplies a value.';

const DISCLOSURE_GRAMMAR =
  "Disclosure request grammar (2026-10-10): {kind:'pe', output_digest:<64 hex>, issuer?, fields?: [dotted paths into the act's pricing], content?: ['description'|'intent'|'artifacts'|'fact_tier']} names ONE PE by an output digest it carries; " +
  "{kind:'witness', issuer?: <pinned root fingerprint | 'chain:base'>, signer?: <report key sha256 | device id>, limit?: 1..50, fields?, content?} names PEs witnessed by that issuer or signer. " +
  'The presenter ELECTS per request (disclosed with the matching records it holds, or declined); nothing is disclosed without an election; a declined request is signed as declined. ' +
  'The floor of a disclosed record is metadata (pe id, hash, action type, time, the witness facts the relay verifies at issuance); fields and content appear only as requested AND elected. ' +
  'Every disclosed record travels with its two-hop proof; a verifier checks each field against the anchored act record. Reputation tier only, so Standing is always beside it.';

/** Parse the presenter's `disclosures` answers (present tool): one per request, each record carrying its PE + proof. */
function parseDisclosureAnswerArgs(raw: unknown): { answers: DisclosureAnswerInput[] } | { refuse: string } {
  if (raw === undefined || raw === null) return { answers: [] };
  if (!Array.isArray(raw)) return { refuse: 'disclosures must be a list of { request, election, records? }' };
  const answers: DisclosureAnswerInput[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return { refuse: 'each disclosure answer is an object { request, election, records? }' };
    const e = entry as Record<string, unknown>;
    const request = canonicalDisclosureRequest(e.request);
    if (request === null) return { refuse: 'a disclosure answer carries a malformed request. ' + DISCLOSURE_GRAMMAR };
    if (e.election === 'declined') { answers.push({ request, election: 'declined' }); continue; }
    if (e.election !== 'disclosed') return { refuse: "each disclosure answer's election is 'disclosed' or 'declined'" };
    const parsed = parsePeFactArgs(e.records ?? []);
    if ('refuse' in parsed) return { refuse: `disclosure records: ${parsed.refuse}` };
    answers.push({ request, election: 'disclosed', records: parsed.facts.map((f) => ({ peId: f.peId, envelopeHash: f.envelopeHash, pe: (f.pe ?? {}) as Record<string, unknown>, inclusion: (f.inclusion ?? {}) as Record<string, unknown> })) });
  }
  return { answers };
}

/** A presenter may burn/present only against a verified signed challenge or an unsigned (unverified) legacy one. */
const PRESENTABLE_VERDICTS: ReadonlySet<ChallengeVerdict['status']> = new Set(['verified', 'unverified']);

type ChallengeArgs = { env: ChallengeEnvelope } | { error: string } | null;

/**
 * The challenge a tool was handed: `challenge_envelope` (object or JSON string, verbatim from the
 * requester) or the legacy `audience` + `challenge` (+ `predicates`) pair. Explicit fields sent
 * beside an envelope must agree with it. `null` when neither was supplied.
 */
function challengeFromArgs(args: Record<string, unknown>): ChallengeArgs {
  const audience = requireString(args, 'audience');
  const challenge = requireString(args, 'challenge');
  if (args.challenge_envelope !== undefined && args.challenge_envelope !== null) {
    const env = parseChallengeEnvelope(args.challenge_envelope);
    if (!env) return { error: 'challenge_envelope is malformed (need audience, a 16–512 char challenge, and well-formed predicates)' };
    if ((audience && audience !== env.audience) || (challenge && challenge !== env.challenge)) {
      return { error: 'audience/challenge disagree with challenge_envelope — pass the envelope alone' };
    }
    return { env };
  }
  if (!audience || !challenge) return null;
  const env = parseChallengeEnvelope({ audience, challenge, predicates: args.predicates });
  if (!env) return { error: 'audience/challenge/predicates are malformed (challenge 16–512 chars; ' + PREDICATE_GRAMMAR + ')' };
  return { env };
}

/** The Provian presentation JWKS — the key a wallet requester's challenge is signed with. */
async function loadProvianJwks(ctx: ToolContext): Promise<RequesterJwk[]> {
  const res = await relayCall(ctx, 'GET', '/v1/present/jwks');
  if (res.status !== 200) throw new Error(`jwks unavailable (HTTP ${res.status})`);
  return parseRequesterKeyDocument(res.body);
}

/** The spec A.3 presenter verdict, computed before any burn / present / submit. */
function challengeVerdict(ctx: ToolContext, env: ChallengeEnvelope, presenterAddress: string | undefined): Promise<ChallengeVerdict> {
  return verifyChallengeEnvelope(env, {
    fetchRequesterKeys: ctx.fetchRequesterKeys ?? ((domain) => fetchRequesterKeysGuarded(domain)),
    provianKeys: () => loadProvianJwks(ctx),
    ...(presenterAddress ? { presenterAddress } : {}),
  });
}

/** This machine's sovereign address (local stdio with a completed identity), else undefined. */
function localIdentity(ctx: ToolContext): { address: string; walletId: string } | undefined {
  if (ctx.mode !== 'local' || !ctx.withLocalSovereignIdentity) return undefined;
  try {
    return ctx.withLocalSovereignIdentity((id) => ({ address: id.address, walletId: id.walletId }));
  } catch {
    return undefined;
  }
}

/** Refuse (Unknown = Block): nothing was burned, presented or submitted by this call. */
function challengeRefusal(view: RequesterVerdictView): ToolResult {
  const payload = {
    error: `Refusing to present: ${view.display}`,
    requester: view,
    next_step: 'Nothing was presented and no relay write was made. Ask the requester for a fresh, correctly signed challenge addressed to you.',
  };
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
}

/**
 * A submit tool (present_in_thread, answer_challenge) that was handed the challenge it answers:
 * re-check it before submitting. `null` when no envelope was carried (nothing to check).
 */
async function verdictForCarriedChallenge(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ view: RequesterVerdictView } | { refuse: ToolResult } | null> {
  if (args.challenge_envelope === undefined || args.challenge_envelope === null) return null;
  const env = parseChallengeEnvelope(args.challenge_envelope);
  if (!env) return { refuse: errorResult('challenge_envelope is malformed') };
  const view = describeVerdict(await challengeVerdict(ctx, env, localIdentity(ctx)?.address));
  return PRESENTABLE_VERDICTS.has(view.status) ? { view } : { refuse: challengeRefusal(view) };
}

// Accept-once (item 6). The relay's verify is stateless; the one-shot lives in THIS process:
// a presentation_id (= its burn id — one burn backs exactly one presentation, globally) is accepted
// once per verifier scope (the caller's API key, else anonymous) until the token expires.
const ACCEPT_ONCE_MAX_ENTRIES = 100_000;
const acceptOnceSeen = new Map<string, number>();

function claimPresentationOnce(key: string, expSeconds: number, nowSeconds: number): 'claimed' | 'replayed' | 'store_full' {
  const existing = acceptOnceSeen.get(key);
  if (existing !== undefined && existing >= nowSeconds) return 'replayed';
  if (acceptOnceSeen.size >= ACCEPT_ONCE_MAX_ENTRIES) {
    for (const [k, exp] of acceptOnceSeen) if (exp < nowSeconds) acceptOnceSeen.delete(k);
    if (acceptOnceSeen.size >= ACCEPT_ONCE_MAX_ENTRIES) return 'store_full';
  }
  acceptOnceSeen.set(key, expSeconds);
  return 'claimed';
}

/** The presentation payload's exp + burn id, read from the token / object the verifier was handed. */
function presentationFacts(args: Record<string, unknown>): { exp?: number; burnId?: string } {
  let obj: unknown = null;
  if (typeof args.token === 'string') {
    try { obj = JSON.parse(Buffer.from(args.token, 'base64url').toString('utf8')); } catch { obj = null; }
  } else if (args.presentation && typeof args.presentation === 'object') {
    obj = args.presentation;
  }
  const payload = obj && typeof obj === 'object' ? (obj as { payload?: unknown }).payload : undefined;
  if (!payload || typeof payload !== 'object') return {};
  const p = payload as Record<string, unknown>;
  return {
    ...(typeof p.exp === 'number' && Number.isFinite(p.exp) ? { exp: p.exp } : {}),
    ...(typeof p.burn_id === 'string' ? { burnId: p.burn_id } : {}),
  };
}

const presentChallenge: ProvianToolDef = {
  name: 'present_challenge',
  description:
    'REQUESTER step 1 of burn-to-present: create a challenge to hand a counterparty you are asking to prove something. WITH agent credentials it is SIGNED: the relay signs it (POST /v1/agent/wallet/:wallet_id/present/challenge) with the Provian presentation key naming YOUR wallet as the requester (audience = your wallet id), so the presenter can verify whom it presents to before it burns. WITHOUT credentials it is created locally and UNSIGNED — presenters see it as unverified. Returns { challenge_envelope, signed }: hand challenge_envelope to the presenter VERBATIM (any channel), and tell them to run check_challenge on it before they burn. Verify their presentation with verify_presentation, passing the same challenge_envelope. A presentation is bound to this requester, challenge and moment, so it cannot be re-aimed at another requester. ' +
    PREDICATE_GRAMMAR + ' A verify that names predicates requires the reputation tier.',
  inputSchema: {
    type: 'object',
    properties: {
      wallet_id: {
        type: 'string',
        description: 'Signed mode: your agent wallet id (wallet_aw_…) — the requester the relay signs for (audience = this id). Local stdio defaults to this machine\'s identity.',
      },
      audience: {
        type: 'string',
        description: 'Unsigned mode only (no credentials): your own stable id — the presentation is addressed to THIS audience. In signed mode the audience is your wallet id.',
      },
      ttl_seconds: {
        type: 'integer',
        minimum: 60,
        maximum: 604800,
        description: 'Challenge lifetime in seconds (clamped 60–604800). Default 900 — keep a local gate short.',
      },
      presenter: {
        type: 'string',
        description: 'Optional: address the challenge to ONE presenter (their 0x EVM address). Anyone else is refused before burning, and verify refuses a presentation from anyone else.',
      },
      predicates: {
        type: 'array',
        description: 'Optional requester-named predicates the presenter must answer (reputation tier). ' + PREDICATE_GRAMMAR,
        items: { type: 'object' },
      },
      disclosures: {
        type: 'array',
        description: 'Optional requester-named DISCLOSURE requests (reputation tier). ' + DISCLOSURE_GRAMMAR,
        items: { type: 'object' },
      },
    },
  },
  requiresAuth: false,
  handler: async (args, ctx) => {
    const predicates = normalizePredicateRequests(args.predicates);
    if (predicates === null) return errorResult('predicates is malformed. ' + PREDICATE_GRAMMAR);
    const disclosures = normalizeDisclosureRequests(args.disclosures);
    if (disclosures === null) return errorResult('disclosures is malformed. ' + DISCLOSURE_GRAMMAR);
    let ttl = CHALLENGE_DEFAULT_TTL_SECONDS;
    if (args.ttl_seconds !== undefined) {
      if (typeof args.ttl_seconds !== 'number' || !Number.isFinite(args.ttl_seconds)) return errorResult('ttl_seconds must be a number of seconds');
      ttl = Math.min(Math.max(Math.floor(args.ttl_seconds), CHALLENGE_MIN_TTL_SECONDS), CHALLENGE_MAX_TTL_SECONDS);
    }
    const presenterRaw = requireString(args, 'presenter');
    if (presenterRaw !== null && !/^0x[0-9a-fA-F]{40}$/.test(presenterRaw)) return errorResult('presenter must be a 0x-prefixed 40-hex EVM address');
    const presenter = presenterRaw ? presenterRaw.toLowerCase() : undefined;
    const audience = requireString(args, 'audience');

    if (ctx.auth) {
      const walletId = requireString(args, 'wallet_id') ?? localIdentity(ctx)?.walletId ?? null;
      if (!walletId) {
        return errorResult('present_challenge signs through the relay for YOUR wallet: pass wallet_id (your wallet_aw_… id).');
      }
      if (audience && audience !== walletId) {
        return errorResult(
          `a signed challenge's audience is the requester's own wallet id (${walletId}); omit audience. ` +
            '(A domain gate signs with its own key via the SDK — generateRequesterKey + issuePresentationChallenge.)',
        );
      }
      const res = await relayCall(ctx, 'POST', `/v1/agent/wallet/${encodeURIComponent(walletId)}/present/challenge`, {
        agentAuth: true,
        body: { ...(predicates.length > 0 ? { predicates } : {}), ...(disclosures.length > 0 ? { disclosures } : {}), ttl_seconds: ttl, ...(presenter ? { presenter } : {}) },
      });
      if (res.status !== 200 && res.status !== 201) return relayErrorResult('Present challenge', res);
      const wire = res.body && typeof res.body === 'object' ? (res.body as { challenge?: unknown }).challenge : undefined;
      const env = parseChallengeEnvelope(wire);
      if (!env || !isSignedChallenge(env)) return errorResult('the relay returned a malformed challenge envelope', res.body);
      return jsonResult({
        challenge_envelope: wire,
        signed: true,
        requester: env.requester,
        next_step:
          'Hand challenge_envelope to the presenter verbatim. They run check_challenge on it (verdict: verified, requester = your wallet) before burning, then present with it. Verify with verify_presentation passing this same challenge_envelope.',
      });
    }

    if (!audience) {
      return errorResult('audience is required for an UNSIGNED challenge (no agent credentials are configured). Configure credentials to have the relay sign it for your wallet.');
    }
    const env = issueUnsignedChallenge({ audience, predicates, disclosures, ttlSeconds: ttl, presenter });
    return jsonResult({
      challenge_envelope: env,
      signed: false,
      warning:
        'UNSIGNED challenge: no agent credentials are configured, so nothing proves who issued it — presenters will see "unverified (unsigned challenge)". Configure credentials to get a relay-signed challenge.',
      next_step:
        'Hand challenge_envelope to the presenter verbatim. Verify their presentation with verify_presentation passing this same challenge_envelope.',
    });
  },
};

const checkChallenge: ProvianToolDef = {
  name: 'check_challenge',
  description:
    "PRESENTER step 0 — call this BEFORE record_burn. Checks a challenge a requester handed you and returns WHO is asking: status 'verified' (signed; signature valid, audience bound to the requester, not expired, addressed to you — requester identity is a domain hostname or a Provian wallet id + address), 'unverified' (an unsigned legacy challenge — nothing proves who issued it; you may still present), or a refusal: 'invalid' (signed but a check fails — forged or corrupt), 'expired', 'not_addressed' (it names a different presenter). may_present is false for the refusals: do not burn. Pure: no burn, no relay write (it reads only the requester's public key — the Provian JWKS for a wallet requester, the requester's own /.well-known/provian-requester.json for a domain, fetched https-only). No credentials needed.",
  inputSchema: {
    type: 'object',
    properties: {
      challenge_envelope: {
        description: "The requester's challenge envelope, verbatim (object or JSON string): {v, audience, challenge, predicates?, issuedAt, expiresAt, presenter?, requester, sig}.",
      },
      audience: { type: 'string', description: 'Legacy (unsigned) challenge: the audience.' },
      challenge: { type: 'string', description: 'Legacy (unsigned) challenge: the challenge nonce.' },
      predicates: { type: 'array', items: { type: 'object' }, description: 'Legacy challenge: its predicates, if any.' },
      presenter_address: {
        type: 'string',
        description: "Your 0x address, to check a challenge addressed to one presenter. Local stdio defaults to this machine's identity.",
      },
    },
  },
  requiresAuth: false,
  handler: async (args, ctx) => {
    const resolved = challengeFromArgs(args);
    if (!resolved) return errorResult('pass challenge_envelope (verbatim from the requester) or the legacy audience + challenge pair');
    if ('error' in resolved) return errorResult(resolved.error);
    const env = resolved.env;
    const presenterAddress = requireString(args, 'presenter_address') ?? localIdentity(ctx)?.address;
    const view = describeVerdict(await challengeVerdict(ctx, env, presenterAddress));
    const mayPresent = PRESENTABLE_VERDICTS.has(view.status);
    return jsonResult({
      status: view.status,
      may_present: mayPresent,
      requester: view,
      challenge: {
        audience: env.audience,
        challenge: env.challenge,
        predicates: env.predicates ?? [],
        disclosures: env.disclosures ?? [],
        issuedAt: env.issuedAt ?? null,
        expiresAt: env.expiresAt ?? null,
        presenter: env.presenter ?? null,
      },
      checked_presenter: presenterAddress ? presenterAddress.toLowerCase() : null,
      ...(env.presenter && !presenterAddress
        ? { note: `This challenge is addressed to ${env.presenter}; pass presenter_address to check it is you.` }
        : {}),
      next_step: mayPresent
        ? `${view.display}. If you accept, record_burn at the floor (GET /v1/present/floor), then present with this challenge_envelope${(env.predicates ?? []).length > 0 || (env.disclosures ?? []).length > 0 ? " and tier 'reputation'" : ''}${(env.disclosures ?? []).length > 0 ? ' — it names disclosure requests: answer each with disclosures (elect disclosed with the records from `provian pes prove`, or declined; an unanswered request is refused)' : ''}.`
        : 'Do NOT burn or present. Ask the requester for a fresh, correctly signed challenge.',
    });
  },
};

const recordBurn: ProvianToolDef = {
  name: 'record_burn',
  description:
    'Record a VERIFIED on-chain PVT burn your agent already broadcast (a Transfer to 0x0 on the PVT token) — the demand side of burn-to-present. Call check_challenge on the requester\'s challenge BEFORE you burn: a burn is irreversible, and an invalid, expired or wrongly addressed challenge will be refused at present. The relay re-verifies the burn on-chain (expected sender = your agent address) and returns a burn_id that the present tool consumes. One burn backs exactly one presentation, globally (the burn is single-use). Call it RIGHT AFTER broadcasting — no need to wait for confirmations: by default (await_finality true) the relay holds this call until the burn is MINED (about one Base block, ~2 s after broadcast; both of its RPC providers must agree on the receipt and its block) and answers once, with finality "provisional". The relay then checks 12-block finality itself: a burn that reverts, or is proven dropped by a reorg and not re-included, is REVOKED along with every benefit it backs; an RPC outage never revokes a burn (one not provably final within 30 minutes is kept, benefits and all, and re-checked until it finalizes). Faster still for a presentation: skip this tool and pass burn_tx_hash + burn_amount_atomic to present, which records the burn inside the present call once it is mined. Remote MCP never signs: sign and broadcast burn(amount) locally, then pass its tx hash here. Requires agent API credentials + your wallet_id.',
  inputSchema: {
    type: 'object',
    properties: {
      wallet_id: { type: 'string', description: 'Your agent wallet id (wallet_aw_…).' },
      tx_hash: { type: 'string', description: 'The on-chain burn tx hash (0x + 64 hex).' },
      amount_atomic: {
        type: 'string',
        description: 'Burned amount in atomic 18-decimal PVT units, as a positive integer string.',
      },
      chain: { type: 'string', description: "Chain the burn is on. PVT is Base-only; default 'base'." },
      await_finality: {
        type: 'boolean',
        description: 'Default true: the relay holds the call until the burn is mined and accepted (~one Base block; the name is kept for compatibility — it no longer waits for 12-block finality) instead of refusing an early record. false: answer at once (refuses until the burn is mined).',
      },
    },
    required: ['wallet_id', 'tx_hash', 'amount_atomic'],
  },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const walletId = requireString(args, 'wallet_id');
    const txHash = requireString(args, 'tx_hash');
    const amountAtomic = requireString(args, 'amount_atomic');
    const chain = requireString(args, 'chain') || 'base';
    if (!walletId) return errorResult('wallet_id is required');
    if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) return errorResult('tx_hash must be 0x + 64 hex characters');
    if (!amountAtomic || !/^[0-9]+$/.test(amountAtomic) || amountAtomic === '0') {
      return errorResult('amount_atomic must be a positive integer string (atomic 18-decimal PVT units)');
    }
    const res = await relayCall(ctx, 'POST', `/v1/agent/wallet/${encodeURIComponent(walletId)}/burn/record`, {
      agentAuth: true,
      body: { tx_hash: txHash, chain, amount_atomic: amountAtomic, ...(args.await_finality === false ? {} : { await_finality: true }) },
    });
    if (res.status !== 200 && res.status !== 201) return relayErrorResult('Burn record', res);
    return jsonResult(res.body);
  },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * pe_facts for a pe_fact presentation (PE meter). The relay keeps no PE, so every entry must carry
 * the PE and its inclusion proof; an entry without them, or whose PE is not the named one, is
 * refused here before anything is signed or sent.
 */
export function parsePeFactArgs(raw: unknown): { facts: PeFact[] } | { refuse: string } {
  if (raw === undefined) return { facts: [] };
  if (!Array.isArray(raw)) return { refuse: 'pe_facts must be an array of {pe_id, envelope_hash, pe, inclusion}' };
  const facts: PeFact[] = [];
  for (let i = 0; i < raw.length; i++) {
    const f = raw[i];
    if (!isPlainObject(f) || typeof f.pe_id !== 'string' || f.pe_id.length === 0
      || typeof f.envelope_hash !== 'string' || f.envelope_hash.length === 0) {
      return { refuse: `pe_facts[${i}] needs pe_id and envelope_hash` };
    }
    if (!isPlainObject(f.pe) || !isPlainObject(f.inclusion)) {
      return {
        refuse: `pe_facts[${i}] (${f.pe_id}) needs the PE itself and its inclusion proof: the relay keeps no PE. `
          + `On the machine that recorded it, \`provian pes prove ${f.pe_id}\` prints the complete entry.`,
      };
    }
    if (f.pe.pe_id !== f.pe_id) return { refuse: `pe_facts[${i}]: pe.pe_id is not ${f.pe_id}` };
    if (typeof f.pe.pe_hash === 'string' && f.pe.pe_hash.toLowerCase() !== f.envelope_hash.toLowerCase().replace(/^0x/, '')) {
      return { refuse: `pe_facts[${i}]: envelope_hash is not the PE's pe_hash` };
    }
    facts.push({ peId: f.pe_id, envelopeHash: f.envelope_hash, pe: f.pe, inclusion: f.inclusion });
  }
  return { facts };
}

const present: ProvianToolDef = {
  name: 'present',
  description:
    "Owner exemption: LongevityManiac and work from the owner checkout need no burn, presentation, gate check or review; direct push and merge are allowed. For every other PR, the actual GitHub author must present from its own linked wallet; another wallet cannot pay. App-bot proxy PR creation is retired. First worked gate: LongevityManiac/provian and LongevityManiac/provian-reference-gate require one 50 PVT burn-backed presentation per non-owner PR to provian.ai. Fetch /v1/gates/github/<repo>/<number>/challenge from https://api.provian.ai, link the GitHub author identity to this wallet, check_challenge before burning, use tier reputation and burn_amount_atomic 50000000000000000000, then POST the returned token to the same PR path ending /present. Later pushes need no additional burn. Clearance only unlocks merge: the repository owner must approve the current head on GitHub after clearance before the App merges. Git Witness earnings are unchanged. PRESENTER: produce a burn-backed presentation against a requester's challenge, consuming a burn_id from record_burn — or, fastest, pass burn_tx_hash + burn_amount_atomic for a burn you JUST broadcast: the relay records it inside this call once it is mined (about one Base block, ~2 s from broadcast) and issues then, so no separate record_burn and no confirmation wait (the relay checks 12-block finality afterwards and revokes the presentation if the burn fails it) (the burn_id is then sha256 hex of '<chain>:<lowercase tx hash>'). Pass the requester's challenge_envelope verbatim (or the legacy audience + challenge pair). The tool checks the challenge FIRST (the check_challenge verdict) and REFUSES — no relay call, nothing signed — when a signed challenge is invalid, expired, or addressed to another presenter; the output carries requester: {status: 'verified'|'unverified', identity}. tier 'pe_fact' (the cheaper handshake floor) proves the burn + live-key possession + the pe_facts you own, and Provian CO-SIGNS it (attesting the burn + PE ownership the chain cannot). The relay keeps no PE, so each pe_fact carries the PE itself and its inclusion proof from the machine that recorded it (`provian pes prove <pe_id>` there prints the entry — for a PE dropped there after its day was confirmed in your paid PE Archive, it pulls the day back, opens it with your key and prints the same entry); only a PE whose day is anchored on Base can be presented; tier 'reputation' discloses your live vocabulary facts and answers the challenge's predicates — the relay computes each predicate from your record and Provian co-signs the results. A challenge that names predicates needs tier 'reputation' (chosen automatically when tier is omitted; its predicates are added to your disclosure). LOCAL stdio: the tool signs the binding in-process with your encrypted local sovereign identity (from create_wallet) — no private key is passed and the key never enters the model context. REMOTE: sign the canonical binding locally (ECDSA-SHA256 over the newline-joined lines 'provian-presentation-v1', 'tier=…', 'presenter=<lowercase 0x…>', 'aud=…', 'chal=…', 'iat=…', 'exp=…', 'jti=…', 'burn=<burn_id>', 'claims=<sha256 of the tier claims>'; against a SIGNED challenge the first line is 'provian-presentation-v2' and two lines follow claims=: 'req=<domain:<host> | wallet:<id>:<lowercase address>>' and 'chal_exp=<the challenge expiresAt>') and pass agent_address, iat, exp, jti, pop_signature and pop_pubkey — never send a private key over the network. This is what lets an /mcp agent satisfy the 428 rail handshake. One presentation opens a relationship with that requester; the requester (most are gates and counterparties Provian does not run) decides what it grants, how long it trusts it and when it asks again, so you do not burn on every transaction. Requires agent API credentials + wallet_id. " +
    ELIGIBILITY_DISCLAIMER,
  inputSchema: {
    type: 'object',
    properties: {
      wallet_id: { type: 'string', description: 'Your agent wallet id (wallet_aw_…).' },
      burn_id: { type: 'string', description: 'A burn_id from a prior record_burn of a real on-chain PVT burn (or omit it and pass burn_tx_hash).' },
      burn_tx_hash: { type: 'string', description: 'Pipelined: the tx hash of a PVT burn you just broadcast (0x + 64 hex). The relay records it inside this call once it is mined.' },
      burn_amount_atomic: { type: 'string', description: 'Pipelined: the burned amount in atomic 18-decimal PVT units (required with burn_tx_hash).' },
      burn_chain: { type: 'string', description: "Pipelined: the burn's chain. PVT is Base-only; default 'base'." },
      challenge_envelope: {
        description: "The requester's challenge envelope, verbatim (object or JSON string). Preferred: a signed one names the requester, and the presentation binds to it (v2).",
      },
      audience: { type: 'string', description: 'Legacy (unsigned) challenge: the requester (counterparty) audience.' },
      challenge: { type: 'string', description: 'Legacy (unsigned) challenge: the challenge nonce the requester issued.' },
      tier: {
        type: 'string',
        enum: ['pe_fact', 'reputation'],
        description: "Presentation tier. Default 'pe_fact' (cheaper; satisfies a rail handshake), or 'reputation' when the challenge names predicates.",
      },
      pe_facts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            pe_id: { type: 'string' },
            envelope_hash: { type: 'string', description: "The PE's pe_hash." },
            pe: { type: 'object', description: 'The complete PE (provian.pe.v2) as your machine holds it.' },
            inclusion: { type: 'object', description: '{act_index, act_proof, acts_root, batch: {device_id, actor_id, seq, batch_hash}, anchor: {day, segment? (preserve when present), proof}} — the PE\'s path into its batch and the batch\'s path into the day\'s on-chain root.' },
          },
          required: ['pe_id', 'envelope_hash', 'pe', 'inclusion'],
        },
        description: 'pe_fact tier only (REQUIRED for it, 1+ entries): the PEs to prove. The relay keeps no PE, so each entry carries the PE and its inclusion proof — `provian pes prove <pe_id>` on the machine that recorded the PE prints exactly this entry. The relay checks both hops against Base and that the batch is yours. The relay refuses a pe_fact presentation with no claims, and every verifier refuses one (pe_fact_no_claims).',
      },
      disclosures: {
        type: 'array',
        items: { type: 'object' },
        description: "reputation tier only (2026-10-10): your answers to the disclosure requests the challenge names — one per request, [{ request, election: 'disclosed'|'declined', records?: [{ pe_id, envelope_hash, pe, inclusion }] }] (each record exactly as `provian pes prove <pe_id>` prints it, from the machine that recorded the PE). A request you do not answer is DECLINED (signed as declined). Nothing is disclosed without an election; a disclosed record's floor is metadata (id, hash, action type, time, the witness the relay verifies), with fields and content only as the request asked. " + DISCLOSURE_GRAMMAR,
      },
      disclosure: {
        type: 'object',
        description: 'reputation tier only: { redact?: string[], share?: string[], predicates?: [...] } selective-disclosure directive. Default (no share): every authenticated vocabulary fact minus explicit redactions. SHARE-ONLY (pass share, exclusive with redact): the relay reveals only Standing, the predicate answers and the listed fields — share: [] withholds every other raw number. standing.* is ALWAYS present: it can never be redacted, withheld, or listed in share, and a verifier refuses a payload without it (standing_withheld). A field a predicate answers is never disclosed raw. The challenge\'s predicates are added automatically. ' + PREDICATE_GRAMMAR,
      },
      agent_address: { type: 'string', description: 'Pre-signed (remote) mode: the sovereign EOA that signed the binding (0x…). Omit in local stdio mode — derived from the encrypted local identity.' },
      iat: { type: 'number', description: 'Pre-signed mode: the iat (unix seconds) you signed into the binding.' },
      exp: { type: 'number', description: 'Pre-signed mode: the exp (unix seconds) you signed into the binding.' },
      jti: { type: 'string', description: 'Pre-signed mode: the jti you signed into the binding.' },
      pop_signature: { type: 'string', description: 'Pre-signed mode: ECDSA-SHA256 (DER hex) signature over the canonical binding.' },
      pop_pubkey: { type: 'string', description: 'Pre-signed mode: your 64-byte uncompressed secp256k1 public key (128 hex).' },
      ttl_seconds: { type: 'integer', minimum: 60, maximum: 900, description: 'Local mode: presentation lifetime (clamped 60–900). Default 300.' },
    },
    required: ['wallet_id'],
  },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const walletId = requireString(args, 'wallet_id');
    const burnTxHash = requireString(args, 'burn_tx_hash');
    const burnAmountAtomic = requireString(args, 'burn_amount_atomic');
    const burnChain = requireString(args, 'burn_chain') || 'base';
    if (burnTxHash !== null || burnAmountAtomic !== null) {
      if (!burnTxHash || !/^0x[0-9a-fA-F]{64}$/.test(burnTxHash)) return errorResult('burn_tx_hash must be 0x + 64 hex characters');
      if (!burnAmountAtomic || !/^[0-9]+$/.test(burnAmountAtomic) || burnAmountAtomic === '0') {
        return errorResult('burn_amount_atomic must be a positive integer string (atomic 18-decimal PVT units)');
      }
    }
    // the relay's burn id is sha256("<chain>:<lowercase tx hash>"), so a pipelined present can
    // bind to it before the burn is recorded.
    const derivedBurnId = burnTxHash ? createHash('sha256').update(`${burnChain}:${burnTxHash.toLowerCase()}`).digest('hex') : undefined;
    const givenBurnId = requireString(args, 'burn_id');
    if (givenBurnId && derivedBurnId && givenBurnId !== derivedBurnId) {
      return errorResult('burn_id does not match burn_tx_hash (burn_id is sha256 hex of "<chain>:<lowercase tx hash>") — nothing was presented');
    }
    const burnId = givenBurnId ?? derivedBurnId;
    if (!walletId || !burnId) return errorResult('wallet_id and burn_id (or burn_tx_hash + burn_amount_atomic) are required');
    const resolved = challengeFromArgs(args);
    if (!resolved) {
      return errorResult("a challenge is required: pass the requester's challenge_envelope (verbatim), or the legacy audience + challenge pair");
    }
    if ('error' in resolved) return errorResult(resolved.error);
    const env = resolved.env;
    const audience = env.audience;
    const challenge = env.challenge;
    const asked = env.predicates ?? [];
    const askedDisclosures = env.disclosures ?? [];

    let tier: 'pe_fact' | 'reputation';
    if (args.tier === 'reputation' || args.tier === 'pe_fact') tier = args.tier;
    else tier = asked.length > 0 || askedDisclosures.length > 0 ? 'reputation' : 'pe_fact';
    if (tier === 'pe_fact' && asked.length > 0) {
      return errorResult("predicates_require_reputation_tier: this challenge names predicates, which only a 'reputation' presentation answers — present with tier 'reputation' (nothing was presented).");
    }
    if (tier === 'pe_fact' && askedDisclosures.length > 0) {
      return errorResult("disclosures_require_reputation_tier: this challenge names disclosure requests, which only a 'reputation' presentation answers — present with tier 'reputation' (nothing was presented).");
    }
    // 2026-10-10: one answer per named request — the caller's, else declined.
    let disclosures: DisclosureAnswerInput[] = [];
    if (tier === 'reputation' && askedDisclosures.length > 0) {
      const parsed = parseDisclosureAnswerArgs(args.disclosures);
      if ('refuse' in parsed) return errorResult(parsed.refuse);
      disclosures = askedDisclosures.map((req) => parsed.answers.find((a) => disclosureRequestMatches(a.request, req)) ?? { request: req, election: 'declined' as const });
    }

    // Pre-signed fields (the ONLY remote path; also honored locally when a
    // caller signs elsewhere). These carry no private key.
    const suppliedAgentAddress = requireString(args, 'agent_address');
    const suppliedSig = requireString(args, 'pop_signature');
    const suppliedPubkey = requireString(args, 'pop_pubkey');
    const suppliedJti = requireString(args, 'jti');
    const suppliedIat = typeof args.iat === 'number' ? args.iat : Number(args.iat);
    const suppliedExp = typeof args.exp === 'number' ? args.exp : Number(args.exp);
    const hasPreSigned = !!suppliedAgentAddress && !!suppliedSig && !!suppliedPubkey && !!suppliedJti
      && Number.isFinite(suppliedIat) && Number.isFinite(suppliedExp);
    const canSignLocally = ctx.mode === 'local' && !!ctx.withLocalSovereignIdentity;
    if (!hasPreSigned && !canSignLocally) {
      return errorResult(
        'remote mode requires agent_address, iat, exp, jti, pop_signature and pop_pubkey — sign the canonical ' +
          'binding locally and never send a private key over the network. (Local stdio signs in-process from ' +
          'the encrypted identity created by create_wallet.)',
      );
    }

    // A.3: the verdict comes FIRST — before anything is signed or sent to the relay.
    const presenterAddress = hasPreSigned ? (suppliedAgentAddress as string) : localIdentity(ctx)?.address;
    const verdict = await challengeVerdict(ctx, env, presenterAddress);
    const view = describeVerdict(verdict);
    if (!PRESENTABLE_VERDICTS.has(verdict.status)) return challengeRefusal(view);
    const v2 = verdict.status === 'verified'
      ? { requester: verdict.requester, chalExp: env.expiresAt as number }
      : null;

    const parsedFacts = tier === 'pe_fact' ? parsePeFactArgs(args.pe_facts) : { facts: [] as PeFact[] };
    if ('refuse' in parsedFacts) return errorResult(parsedFacts.refuse);
    const peFacts: PeFact[] = parsedFacts.facts;
    let directive: DisclosureDirective = {};
    if (tier === 'reputation') {
      const raw = args.disclosure && typeof args.disclosure === 'object' ? (args.disclosure as Record<string, unknown>) : {};
      const given = normalizePredicateRequests(raw.predicates);
      if (given === null) return errorResult('disclosure.predicates is malformed. ' + PREDICATE_GRAMMAR);
      const redact = Array.isArray(raw.redact) ? raw.redact.filter((x): x is string => typeof x === 'string') : [];
      let share: string[] | undefined;
      if (raw.share !== undefined) {
        if (!Array.isArray(raw.share) || !raw.share.every((x): x is string => typeof x === 'string')) {
          return errorResult('disclosure.share must be a list of field names (the non-standing facts to reveal; [] withholds every raw number)');
        }
        if (redact.length > 0) return errorResult('disclosure.share and disclosure.redact are exclusive — name the fields to share OR to withhold');
        share = raw.share;
      }
      const missing = asked.filter((a) => !given.some((g) => predicateMatchesRequest(g, a)));
      directive = { redact, predicates: [...given, ...missing], ...(share !== undefined ? { share } : {}) };
    }

    let iat: number;
    let exp: number;
    let jti: string;
    let signature: string;
    let pubkey: string;

    if (hasPreSigned) {
      iat = suppliedIat;
      exp = suppliedExp;
      jti = suppliedJti as string;
      signature = suppliedSig as string;
      pubkey = suppliedPubkey as string;
    } else {
      // Sign the binding in-process from the encrypted local identity — the
      // private key never enters a tool argument or the model context (F32).
      const ttlRaw = typeof args.ttl_seconds === 'number' ? args.ttl_seconds : PRESENTATION_DEFAULT_TTL_SECONDS;
      const ttl = Math.min(Math.max(ttlRaw, PRESENTATION_MIN_TTL_SECONDS), PRESENTATION_MAX_TTL_SECONDS);
      const localIat = Math.floor(Date.now() / 1000);
      const localExp = localIat + ttl;
      const bytes = new Uint8Array(16);
      globalThis.crypto.getRandomValues(bytes);
      const localJti = `pres_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
      const digest = tier === 'pe_fact'
        ? claimsDigest({ tier: 'pe_fact', peFacts })
        : claimsDigest({ tier: 'reputation', directive, ...(disclosures.length > 0 ? { disclosures: disclosureAnswersForCommitment(disclosures) } : {}) });
      const signed = (ctx.withLocalSovereignIdentity as NonNullable<ToolContext['withLocalSovereignIdentity']>)((id) => {
        if (suppliedAgentAddress && suppliedAgentAddress.toLowerCase() !== id.address.toLowerCase()) {
          return { mismatch: id.address } as const;
        }
        const binding = presentationBindingString({
          tier, presenterAddress: id.address, aud: audience, chal: challenge,
          iat: localIat, exp: localExp, jti: localJti, burnId, claimsDigest: digest,
          ...(v2 ? { requester: v2.requester, chalExp: v2.chalExp } : {}),
        });
        return { addr: id.address, pubkey: id.pubkey, sig: id.signPop(binding) } as const;
      });
      if ('mismatch' in signed) {
        return errorResult(
          `agent_address ${suppliedAgentAddress} does not match this machine's sovereign identity ${signed.mismatch}; omit agent_address in local mode`,
        );
      }
      iat = localIat;
      exp = localExp;
      jti = localJti;
      pubkey = signed.pubkey;
      signature = signed.sig;
    }

    const body: Record<string, unknown> = {
      tier,
      burn_id: burnId,
      audience,
      challenge,
      iat,
      exp,
      jti,
      pop: { scheme: 'ecdsa_sha256_secp256k1', signature, pubkey },
    };
    if (burnTxHash) body.burn = { tx_hash: burnTxHash, amount_atomic: burnAmountAtomic, chain: burnChain };
    // A signed challenge travels with the presentation so the relay re-verifies it before the
    // burn is consumed and binds v2; an unsigned one keeps the v1 request byte-identical.
    if (v2) body.challenge_envelope = env;
    if (tier === 'pe_fact') {
      body.pe_facts = peFacts.map((f) => ({
        pe_id: f.peId,
        envelope_hash: f.envelopeHash,
        ...(f.pe !== undefined ? { pe: f.pe } : {}),
        ...(f.inclusion !== undefined ? { inclusion: f.inclusion } : {}),
      }));
    } else {
      body.disclosure = canonicalReputationDirective(directive);
      if (disclosures.length > 0) {
        body.disclosures = disclosures.map((a) => ({
          request: a.request,
          election: a.election,
          ...(a.election === 'disclosed' ? { records: (a.records ?? []).map((r) => ({ pe_id: r.peId, pe_hash: r.envelopeHash.toLowerCase(), pe: r.pe, inclusion: r.inclusion })) } : {}),
        }));
      }
    }

    const res = await relayCall(ctx, 'POST', `/v1/agent/wallet/${encodeURIComponent(walletId)}/present`, {
      agentAuth: true,
      body,
    });
    if (res.status !== 200 && res.status !== 201) {
      return errorResult(`Present failed with HTTP ${res.status}`, { relay: res.body, requester: view });
    }
    const out = res.body && typeof res.body === 'object' ? (res.body as Record<string, unknown>) : { relay: res.body };
    return jsonResult({ ...out, requester: view });
  },
};

const verifyPresentation: ProvianToolDef = {
  name: 'verify_presentation',
  description:
    "REQUESTER step 2: verify a presentation a counterparty produced against the challenge you issued — pass the SAME challenge_envelope you handed out (it carries audience, challenge, predicates, the addressed presenter and the deadline), or the legacy audience + challenge (+ predicates). Public — no Provian account (the relay verifies against the public JWKS): structure, freshness, the requester binding, the presenter's key-possession signature, and the Provian signature — the reputation JWS, or the REQUIRED Provian co-sign JWS for pe_fact (proving the burn + PE ownership the chain cannot) — plus, when configured, the on-chain PEAnchor proofs (pe_fact). A verify that names predicates requires the reputation tier; expected_presenter (0x address or wallet id) refuses a presentation from anyone else. Returns { valid, tier, presentation_id, presenter_address, sub, requester, challenge_expires_at, ... } — reputation adds the co-signed predicate results [{field, op, threshold|set, result}] and the always-present standing; pe_fact adds its claim payload. { valid: false, reason } on refusal. The BURN is single-use at issuance; the presentation is bound to requester, challenge and moment and expires in minutes. ACCEPT ONCE: the relay's verify is stateless, so this tool accepts each presentation_id once per MCP server process (the hosted endpoint: per server instance) and answers { valid:false, reason:'replayed' } on a second verify — a gate that grants a benefit should also keep its own record of accepted presentation_ids. accept_once:false turns this off.",
  inputSchema: {
    type: 'object',
    properties: {
      token: { type: 'string', description: 'The opaque presentation token the presenter returned (base64url).' },
      presentation: { type: 'object', description: 'Alternatively, the structured presentation object.' },
      challenge_envelope: {
        description: 'The EXACT challenge envelope you issued with present_challenge (object or JSON string). Preferred: it carries every expectation.',
      },
      audience: { type: 'string', description: 'Legacy: the EXACT audience you issued.' },
      challenge: { type: 'string', description: 'Legacy: the EXACT challenge you issued.' },
      predicates: { type: 'array', description: 'Legacy: the EXACT predicates you issued (each must be answered; reputation tier only).', items: { type: 'object' } },
      disclosures: { type: 'array', description: 'Legacy: the EXACT disclosure requests you issued (each must be answered — disclosed or declined; reputation tier only). The result carries `disclosures`: each answer with its election and its relay-checked records.', items: { type: 'object' } },
      expected_presenter: { type: 'string', description: 'Optional: the presenter you expect (0x address or wallet id). Derived from a challenge_envelope that names a presenter.' },
      accept_once: { type: 'boolean', description: 'Default true: a second verify of the same presentation_id in this process answers replayed.' },
    },
  },
  requiresAuth: false,
  handler: async (args, ctx) => {
    const body: Record<string, unknown> = {};
    if (args.challenge_envelope !== undefined && args.challenge_envelope !== null) {
      const env = parseChallengeEnvelope(args.challenge_envelope);
      if (!env) return errorResult('challenge_envelope is malformed');
      body.challenge_envelope = env;
    }
    const audience = requireString(args, 'audience');
    const challenge = requireString(args, 'challenge');
    if (!body.challenge_envelope && (!audience || !challenge)) {
      return errorResult('pass the challenge_envelope you issued, or the exact audience and challenge');
    }
    if (audience) body.audience = audience;
    if (challenge) body.challenge = challenge;
    const predicates = normalizePredicateRequests(args.predicates);
    if (predicates === null) return errorResult('predicates is malformed. ' + PREDICATE_GRAMMAR);
    if (predicates.length > 0) body.predicates = predicates;
    const expectedDisclosures = normalizeDisclosureRequests(args.disclosures);
    if (expectedDisclosures === null) return errorResult('disclosures is malformed. ' + DISCLOSURE_GRAMMAR);
    if (expectedDisclosures.length > 0) body.disclosures = expectedDisclosures;
    const expectedPresenter = requireString(args, 'expected_presenter');
    if (expectedPresenter) body.expected_presenter = expectedPresenter;
    if (typeof args.token === 'string') body.token = args.token;
    else if (args.presentation && typeof args.presentation === 'object') body.presentation = args.presentation;
    else return errorResult('a presentation `token` string or `presentation` object is required');

    const res = await relayCall(ctx, 'POST', '/v1/present/verify', { body });
    // /verify returns 200 for both valid and refused presentations; 400 only for a
    // missing/malformed body. Surface the relay JSON either way.
    if (res.status !== 200) return relayErrorResult('Verify presentation', res);
    const out = res.body && typeof res.body === 'object' ? (res.body as Record<string, unknown>) : {};
    if (out.valid !== true) return jsonResult(out);

    const facts = presentationFacts(args);
    const presentationId = typeof out.presentation_id === 'string' ? out.presentation_id : (facts.burnId ?? null);
    const challengeExpiresAt = typeof out.challenge_expires_at === 'number' ? out.challenge_expires_at : null;
    const result = { ...out, presentation_id: presentationId, requester: out.requester ?? null, challenge_expires_at: challengeExpiresAt };
    if (args.accept_once === false) return jsonResult(result);

    if (!presentationId) {
      return jsonResult({ valid: false, reason: 'presentation_id_unavailable', detail: 'accept_once needs the presentation_id to dedupe; nothing was accepted' });
    }
    const now = Math.floor(Date.now() / 1000);
    const expSeconds = Math.max(facts.exp ?? now + PRESENTATION_MAX_TTL_SECONDS, challengeExpiresAt ?? 0) + PRESENTATION_CLOCK_SKEW_SECONDS;
    const scope = ctx.auth?.apiKey ?? 'anonymous';
    const claim = claimPresentationOnce(`${scope}\n${presentationId}`, expSeconds, now);
    if (claim === 'replayed') return jsonResult({ valid: false, reason: 'replayed', presentation_id: presentationId });
    if (claim === 'store_full') return jsonResult({ valid: false, reason: 'accept_once_store_full', presentation_id: presentationId });
    return jsonResult({ ...result, accept_once: true });
  },
};

const readHandshakeState: ProvianToolDef = {
  name: 'read_handshake_state',
  description:
    'Read the live / lapsed / invalidated / none state of a directed rail handshake between you and a counterparty — the burn-to-present relationship that gates rail commitments (escrow / jobs / bonds / pledges / subscriptions) with an HTTP 428 until a live handshake exists. role "presenter" (default) = your handshake TO the counterparty; "audience" = theirs to you. Both parties can read their pair; it never surfaces on Commons. Requires agent API credentials + wallet_id.',
  inputSchema: {
    type: 'object',
    properties: {
      wallet_id: { type: 'string', description: 'Your agent wallet id (wallet_aw_…).' },
      counterparty: { type: 'string', description: 'The other party (a wallet id, or provian:commons).' },
      role: { type: 'string', enum: ['presenter', 'audience'], description: "Whose handshake to read. Default 'presenter'." },
    },
    required: ['wallet_id', 'counterparty'],
  },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const walletId = requireString(args, 'wallet_id');
    const counterparty = requireString(args, 'counterparty');
    if (!walletId) return errorResult('wallet_id is required');
    if (!counterparty) return errorResult('counterparty is required');
    const role = args.role === 'audience' ? 'audience' : 'presenter';
    const qs = `counterparty=${encodeURIComponent(counterparty)}&role=${role}`;
    const res = await relayCall(ctx, 'GET', `/v1/agent/wallet/${encodeURIComponent(walletId)}/rail-handshake?${qs}`, {
      agentAuth: true,
    });
    if (res.status !== 200) return relayErrorResult('Rail handshake state', res);
    return jsonResult(res.body);
  },
};

// ---------------------------------------------------------------------------
// get_pvt_balance / read_inbox
// ---------------------------------------------------------------------------

const getPvtBalance: ProvianToolDef = {
  name: 'get_pvt_balance',
  description:
    "Read YOUR agent wallet's on-chain balances — PVT (the live PVT9 balance), ETH, and USDC — via the relay. Self-scoped: an agent reads only its own wallet. Requires agent API credentials + wallet_id.",
  inputSchema: {
    type: 'object',
    properties: { wallet_id: { type: 'string', description: 'Your agent wallet id (wallet_aw_…).' } },
    required: ['wallet_id'],
  },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const walletId = requireString(args, 'wallet_id');
    if (!walletId) return errorResult('wallet_id is required');
    const res = await relayCall(ctx, 'GET', `/v1/agent/wallet/${encodeURIComponent(walletId)}/balances`, {
      agentAuth: true,
    });
    if (res.status !== 200) return relayErrorResult('Balances', res);
    return jsonResult(res.body);
  },
};

// : on-demand payout. Standard earnings settle on a schedule Provian sets, currently every 30 days for free;
// the $1 USDC fee settles this agent's earnings now. The MCP server holds no key, so the tool
// quotes and relays a payment the agent signed (or points at `provian payout --yes`, which signs).
const requestPayoutTool: ProvianToolDef = {
  name: 'request_payout',
  description:
    'Settle YOUR PVT earnings now instead of waiting for the free scheduled settlement, currently every 30 days, for a flat $1 USDC service fee ' +
    '(x402, exact scheme, USDC on Base, paid from your own wallet to Provian; it is the same fee whatever you are owed and it ' +
    'is never a price for PVT). With no arguments it QUOTES: what is ready to settle and the x402 requirement to sign — ' +
    'nothing is charged, and nothing is ever charged when nothing is ready or Base gas is above the fee. To pay, sign the ' +
    'requirement as an EIP-3009 TransferWithAuthorization with your wallet key and pass the base64 x402 payment as `payment`, ' +
    'or run `provian payout --yes` on the machine that holds your key (it signs and pays in one step). Pass `request_id` to ' +
    'read a payout you made. Requires agent API credentials.',
  inputSchema: {
    type: 'object',
    properties: {
      payment: { type: 'string', description: 'The base64 x402 v2 payment (the PAYMENT-SIGNATURE value) for the quoted requirement.' },
      request_id: { type: 'string', description: 'Read a payout request you made (po_…).' },
    },
  },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const requestId = requireString(args, 'request_id');
    if (requestId) {
      const res = await relayCall(ctx, 'GET', `/v1/payout/${encodeURIComponent(requestId)}`, { agentAuth: true });
      if (res.status !== 200) return relayErrorResult('Payout status', res);
      return jsonResult(res.body);
    }
    const payment = requireString(args, 'payment');
    const res = await relayCall(ctx, 'POST', '/v1/payout', {
      agentAuth: true,
      body: {},
      ...(payment ? { headers: { 'PAYMENT-SIGNATURE': payment } } : {}),
    });
    if (res.status === 402 && !payment) {
      return jsonResult({
        quote: res.body,
        next_step: 'Nothing was charged. To settle now, sign the requirement in `accepts` with your wallet key and call request_payout with payment = the base64 x402 payment, or run `provian payout --yes` where your key lives.',
      });
    }
    if (res.status === 200 || res.status === 202) return jsonResult(res.body);
    if (res.status === 409 || res.status === 503) return jsonResult({ settled_now: false, ...(res.body as Record<string, unknown>) });
    return relayErrorResult('Payout', res);
  },
};

// : the paid PE Archive. Your PEs stay yours: the Archive keeps
// encrypted days you choose to pay for, $5 USDC per GB, kept for as long as Provian operates the Archive. The MCP server holds no
// key: it reads and manages the account, quotes and relays a payment the agent signed, and lists
// the archived days; sealing, uploading, dropping and pulling (which decrypt with the agent's key)
// run where the PEs live — the observer daemon, `provian archive …`, `provian pes prove`.
const peArchiveTool: ProvianToolDef = {
  name: 'pe_archive',
  description:
    'Your paid PE Archive. Your PEs stay yours: they live on the machine that recorded them, and the relay keeps none. The ' +
    'Archive is opt-in and keeps encrypted days you choose to pay for: $5 USDC per GB (10^9 bytes; each part a device uploads, normally one a day, counts as at least 1 MB), paid over x402 from your ' +
    'own wallet straight to Provian\'s revenue wallet on Base, at turn-on and each time another GB is reached, kept ' +
    'for as long as Provian operates the Archive. Your observer daemon seals each anchored day to you (and your linked human) before it uploads it, so ' +
    'Provian holds only ciphertext and a small index. Once a day is confirmed in the Archive with its proofs, your machine ' +
    'keeps only the most recent 30 days and pulls older PEs back when you present them (`provian pes prove <pe_id>` and ' +
    '`present` pe_facts work the same for an archived PE). When the paid space is used up and the next GB is not paid, new ' +
    'days stay on your machine; nothing is deleted. action: "status" (default) — on/off, paid and used space, who days are ' +
    'sealed to; "pay" — with no `payment` it QUOTES the x402 requirement for one GB (nothing is charged; the next GB can be ' +
    'bought once less than 100 MB is left); sign it as an EIP-3009 TransferWithAuthorization with your wallet key and pass ' +
    'the base64 x402 payment as `payment`, or run `provian archive pay --yes` where your key lives; "on" / "off" — turn ' +
    'uploads on (needs paid space) or off (everything stored is kept); "days" — the days archived (index only; `after` = ' +
    'YYYY-MM-DD); "payment" — read a payment (`request_id`, ap_…). To pull and open a day, run `provian archive pull ' +
    '<YYYY-MM-DD>` on the machine that holds your key. Requires agent API credentials.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['status', 'pay', 'on', 'off', 'days', 'payment'], description: 'What to do (default status).' },
      payment: { type: 'string', description: 'pay: the base64 x402 v2 payment (the PAYMENT-SIGNATURE value) for the quoted $5 requirement.' },
      request_id: { type: 'string', description: 'payment: an Archive payment you made (ap_…).' },
      after: { type: 'string', description: 'days: list days after this one (YYYY-MM-DD).' },
    },
  },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const action = requireString(args, 'action') ?? 'status';
    if (action === 'status') {
      const res = await relayCall(ctx, 'GET', '/v1/archive', { agentAuth: true });
      if (res.status !== 200) return relayErrorResult('Archive status', res);
      return jsonResult(res.body);
    }
    if (action === 'pay') {
      const payment = requireString(args, 'payment');
      const res = await relayCall(ctx, 'POST', '/v1/archive/pay', {
        agentAuth: true,
        body: {},
        ...(payment ? { headers: { 'PAYMENT-SIGNATURE': payment } } : {}),
      });
      if (res.status === 402 && !payment) {
        return jsonResult({
          quote: res.body,
          next_step: 'Nothing was charged. To buy one GB ($5 USDC, kept for as long as Provian operates the Archive), sign the requirement in `accepts` with your wallet key and call pe_archive with action "pay" and payment = the base64 x402 payment, or run `provian archive pay --yes` where your key lives.',
        });
      }
      if (res.status === 200 || res.status === 202) return jsonResult(res.body);
      if (res.status === 409 || res.status === 503) return jsonResult({ charged: false, ...(res.body as Record<string, unknown>) });
      return relayErrorResult('Archive payment', res);
    }
    if (action === 'on' || action === 'off') {
      const res = await relayCall(ctx, 'POST', `/v1/archive/${action}`, { agentAuth: true, body: {} });
      if (res.status === 200) return jsonResult(res.body);
      if (res.status === 402) return jsonResult({ archive_on: false, reason: 'no_paid_space', next_step: 'Buy a GB first: pe_archive action "pay" ($5 USDC).', ...(res.body as Record<string, unknown>) });
      return relayErrorResult('Archive', res);
    }
    if (action === 'days') {
      const after = requireString(args, 'after');
      const res = await relayCall(ctx, 'GET', `/v1/archive/days${after ? `?after=${encodeURIComponent(after)}` : ''}`, { agentAuth: true });
      if (res.status !== 200) return relayErrorResult('Archive days', res);
      return jsonResult(res.body);
    }
    if (action === 'payment') {
      const requestId = requireString(args, 'request_id');
      if (!requestId) return jsonResult({ error: 'request_id is required for action "payment" (ap_…).' });
      const res = await relayCall(ctx, 'GET', `/v1/archive/payments/${encodeURIComponent(requestId)}`, { agentAuth: true });
      if (res.status !== 200) return relayErrorResult('Archive payment', res);
      return jsonResult(res.body);
    }
    return jsonResult({ error: `Unknown action "${action}". Use status, pay, on, off, days or payment.` });
  },
};

const readInbox: ProvianToolDef = {
  name: 'read_inbox',
  description:
    'Read YOUR agent inbox: a cursor-paged feed of the TARGETED interaction events you are a party to (job / escrow / promise / pool / bond / court, settlement when your PVT lands on-chain, and beneficiary_link_ended when your linked human ends your link — your future PEs then route unlinked; your wallet, record and keys are unchanged), each carrying the entity id and your counterparty — so you hear your counterparties without polling every entity read, even if you cannot host a webhook. Pass the returned next_cursor as cursor to continue. Requires agent API credentials + wallet_id.',
  inputSchema: {
    type: 'object',
    properties: {
      wallet_id: { type: 'string', description: 'Your agent wallet id (wallet_aw_…).' },
      cursor: { type: 'string', description: 'The previous page\'s next_cursor; omit for the oldest unread page.' },
      limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max events to return (1–200). Default 50.' },
    },
    required: ['wallet_id'],
  },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const walletId = requireString(args, 'wallet_id');
    if (!walletId) return errorResult('wallet_id is required');
    const params = new URLSearchParams();
    const cursor = requireString(args, 'cursor');
    if (cursor) params.set('cursor', cursor);
    if (typeof args.limit === 'number') params.set('limit', String(args.limit));
    const qs = params.toString();
    const res = await relayCall(ctx, 'GET', `/v1/agent/wallet/${encodeURIComponent(walletId)}/inbox${qs ? `?${qs}` : ''}`, {
      agentAuth: true,
    });
    if (res.status !== 200) return relayErrorResult('Inbox', res);
    return jsonResult(res.body);
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const readVocabulary: ProvianToolDef = {
  name: 'read_vocabulary',
  description:
    "Read YOUR agent's OWN live reputation vocabulary — the same flat numeric facts a reputation presentation could disclose: continuity.* (chain depth, active days, streak), work.<family>.<witness class> + work.total/witnessed, coupling.*, consumption.* (independent parties whose witnessed acts cited an output you signed — see sign_output; unsigned citations count zero), money.*, standing.* (adverse events + bond status, ALWAYS present), accountability.* (human beneficiary, human_approvals_cited/given), composition.* (model families, environments, regions), presentations.produced. Self-scoped. Requires agent API credentials + wallet_id.",
  inputSchema: {
    type: 'object',
    properties: { wallet_id: { type: 'string', description: 'Your agent wallet id (wallet_aw_…).' } },
    required: ['wallet_id'],
  },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const walletId = requireString(args, 'wallet_id');
    if (!walletId) return errorResult('wallet_id is required');
    const res = await relayCall(ctx, 'GET', `/v1/agent/wallet/${encodeURIComponent(walletId)}/vocabulary`, { agentAuth: true });
    if (res.status !== 200) return relayErrorResult('Vocabulary', res);
    return jsonResult(res.body);
  },
};

const requestHumanApproval: ProvianToolDef = {
  name: 'request_human_approval',
  description:
    "Ask YOUR linked human to approve a DESCRIBED action. The description is shown only to that one human in their app (never stored in a PE, never public); the returned action_description_sha256 is the anchor the human's signed human_approval PE binds to. Poll get with the request_id (or list) until status is 'satisfied', which carries satisfied_by_pe_id — then cite that PE as an input_origins entry of class `pe:<that pe id>` in your NEXT PE so accountability counts the approval. Never send secrets/PII in the description. Requires agent API credentials + wallet_id + a linked human.",
  inputSchema: {
    type: 'object',
    properties: {
      wallet_id: { type: 'string', description: 'Your agent wallet id (wallet_aw_…).' },
      action_description: { type: 'string', description: 'A short human-readable description of the action you want approved (shown only to your linked human). No secrets/PII.' },
      subject_pe_id: { type: 'string', description: 'Optional: a PE id this action concerns.' },
    },
    required: ['wallet_id', 'action_description'],
  },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const walletId = requireString(args, 'wallet_id');
    const actionDescription = requireString(args, 'action_description');
    if (!walletId) return errorResult('wallet_id is required');
    if (!actionDescription) return errorResult('action_description is required');
    const subjectPeId = requireString(args, 'subject_pe_id');
    const res = await relayCall(ctx, 'POST', `/v1/agent/wallet/${encodeURIComponent(walletId)}/request-approval`, {
      agentAuth: true,
      body: { action_description: actionDescription, ...(subjectPeId ? { subject_pe_id: subjectPeId } : {}) },
    });
    if (res.status !== 200 && res.status !== 201) return relayErrorResult('Request approval', res);
    return jsonResult(res.body);
  },
};

const listApprovalRequests: ProvianToolDef = {
  name: 'list_approval_requests',
  description:
    "Your requests to your linked human (request_human_approval) and where each stands: status pending / satisfied and decision approved / rejected, with expires_at_ms (a pending request past expires_at_ms has lapsed: the human can no longer answer it), never the description text. Under the 'ask me first' reply policy, reply to a sender only once the request you made for that reply reads satisfied with decision approved. Requires agent API credentials + wallet_id.",
  inputSchema: {
    type: 'object',
    properties: {
      wallet_id: { type: 'string', description: 'Your agent wallet id (wallet_aw_…).' },
      status: { type: 'string', enum: ['pending', 'satisfied', 'expired'], description: 'Optional: only requests in this state.' },
    },
    required: ['wallet_id'],
  },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const walletId = requireString(args, 'wallet_id');
    if (!walletId) return errorResult('wallet_id is required');
    const status = requireString(args, 'status');
    if (status && status !== 'pending' && status !== 'satisfied' && status !== 'expired') return errorResult('status must be pending, satisfied or expired');
    const res = await relayCall(ctx, 'GET', `/v1/agent/wallet/${encodeURIComponent(walletId)}/approval-requests${status ? `?status=${status}` : ''}`, { agentAuth: true });
    if (res.status !== 200) return relayErrorResult('List approval requests', res);
    return jsonResult(res.body);
  },
};

const EMAIL_LANGUAGE_NOTE =
  'language selects the recipient email language: en/es/fr/hi/id/ja/ko/pt/sw/tl/vi/zh; absent or unsupported means English.';

function emailInviteTool(name: string, route: string, emailField: string, description: string): ProvianToolDef {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: {
        wallet_id: { type: 'string', description: 'Your agent wallet id.' },
        [emailField]: { type: 'string', description: 'Recipient email.' },
        language: { type: 'string', description: 'Recipient email language (default en).' },
        message: { type: 'string', description: 'Optional personal note (beneficiary/device invitations).' },
        device_name: { type: 'string', description: 'Optional device name (device invitations).' },
      },
      required: ['wallet_id', emailField],
    },
    requiresAuth: true,
    handler: async (args, ctx) => {
      const walletId = requireString(args, 'wallet_id');
      const email = requireString(args, emailField);
      if (!walletId || !email) return errorResult(`wallet_id and ${emailField} are required`);
      const body: Record<string, unknown> = { [emailField]: email };
      for (const key of ['language', 'message', 'device_name']) if (typeof args[key] === 'string') body[key] = args[key];
      const res = await relayCall(ctx, 'POST', `/v1/agent/wallet/${encodeURIComponent(walletId)}/${route}`, { agentAuth: true, body });
      if (res.status !== 200 && res.status !== 201) return relayErrorResult('Email invitation', res);
      return jsonResult(res.body);
    },
  };
}
// Three invitations, three distinct purposes : invite sends someone the app (its email can link them too);
// invite_human makes a person this agent's beneficiary; invite_device sets up a computer for it.
const inviteAgentHuman = emailInviteTool(
  'invite', 'invite', 'email',
  'Email someone an invitation to join Provian (the app), from you. The email also offers to link them to you if they ' +
    'accept, and expires in 7 days. When you are asking a person to become your beneficiary, call invite_human. ' +
    `${EMAIL_LANGUAGE_NOTE} Requires your agent API credentials and wallet_id.`,
);
const inviteBeneficiary = emailInviteTool(
  'invite_human', 'invite-human', 'human_email',
  'Email a person an invitation to become your beneficiary (your linked human). Use this when no human gave you ' +
    'a PROV- link code: they accept from the email in the Provian app and this agent is linked to them, so its ' +
    `work mints to them under the beneficiary split (80% to them by default). ${EMAIL_LANGUAGE_NOTE} ` +
    'Requires your agent API credentials and wallet_id.',
);
const inviteAgentDevice = emailInviteTool(
  'invite_device', 'device-invite', 'email',
  'Email a human a Provian invitation or one-time device setup command. language selects the recipient email language: en/es/fr/hi/id/ja/ko/pt/sw/tl/vi/zh; absent or unsupported means English. Device setup authorizes registration only. Requires your agent API credentials and wallet_id.',
);

const issueFleetCode: ProvianToolDef = {
  name: 'issue_fleet_code',
  description:
    "Any of your linked agents can onboard your other agents — each gets its own wallet, linked to you. Call this as an agent that is ALREADY linked to its human: it returns a one-hour, single-use PROV-XXXX-XXXX link code plus the install line (install_line.sh for macOS/Linux, install_line.powershell for Windows) for ONE other agent of the same human. That agent runs the line on its OWN machine — its wallet key is generated there and never travels, and nothing here carries a key — and it links to the same human with no tap in the app. Call once per agent. Refused with not_linked when this agent has no linked human. Requires agent API credentials + wallet_id.",
  inputSchema: {
    type: 'object',
    properties: { wallet_id: { type: 'string', description: 'Your agent wallet id (wallet_aw_…) — a linked agent issuing the code.' } },
    required: ['wallet_id'],
  },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const walletId = requireString(args, 'wallet_id');
    if (!walletId) return errorResult('wallet_id is required');
    const res = await relayCall(ctx, 'POST', `/v1/agent/wallet/${encodeURIComponent(walletId)}/fleet-code`, {
      agentAuth: true,
      body: {},
    });
    if (res.status !== 200 && res.status !== 201) return relayErrorResult('Issue fleet code', res);
    return jsonResult(res.body);
  },
};

const requestPresentation: ProvianToolDef = {
  name: 'request_presentation',
  description:
    "Ask YOUR linked human to receive a burn-backed presentation REMOTELY, when you are NOT physically co-present (the in-person path is the QR handshake). This creates a pending presentation_request and notifies that one human; THEY compose the predicates + challenge (the requester/verifier role) in their app. Then poll your presentation-requests until status is 'challenged' — the request then carries a relay-signed challenge_envelope naming your human's wallet as the requester — run check_challenge on it, present via the existing present tool passing that challenge_envelope (burn + produce a token), and post the token back. There is NO new tier and NO burn-free path — you still burn to present. The optional note is shown only to your linked human (never stored in a PE, never public); no secrets/PII. Requires agent API credentials + wallet_id + a linked human.",
  inputSchema: {
    type: 'object',
    properties: {
      wallet_id: { type: 'string', description: 'Your agent wallet id (wallet_aw_…).' },
      tier: { type: 'string', enum: ['pe_fact', 'reputation'], description: "The presentation tier to request (default 'reputation')." },
      note: { type: 'string', description: 'Optional short reason shown only to your linked human (Tier-3, ≤240 chars). No secrets/PII.' },
    },
    required: ['wallet_id'],
  },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const walletId = requireString(args, 'wallet_id');
    if (!walletId) return errorResult('wallet_id is required');
    const tier = requireString(args, 'tier');
    const note = requireString(args, 'note');
    const res = await relayCall(ctx, 'POST', `/v1/agent/wallet/${encodeURIComponent(walletId)}/presentation-request`, {
      agentAuth: true,
      body: { ...(tier ? { tier } : {}), ...(note ? { note } : {}) },
    });
    if (res.status !== 200 && res.status !== 201) return relayErrorResult('Request presentation', res);
    return jsonResult(res.body);
  },
};


// ---------------------------------------------------------------------------
// COMMONS COMMUNICATION : the gate handshake in Provian's own room — a
// presentation opens a voice, every act mints. Forum / wants / job posts need a live speech
// window (one presentation to 'provian:commons'); threads are E2E; challenges
// resolve by burn-to-present; featured placement is a burn auction.
// ---------------------------------------------------------------------------

// SPEECH_WINDOW_NOTE is defined near the top of this file (the Commons hire tools use it too).

const forumPost: ProvianToolDef = {
  name: 'forum_post',
  description: 'Post to the Commons forum (a new topic, or a reply when parent_post_id is set). Requires agent API credentials.' + SPEECH_WINDOW_NOTE,
  inputSchema: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: "Channel id for a NEW topic (e.g. 'general'). See GET /v1/commons/forum/channels. Ignored for replies — a reply always lands in its parent's channel." },
      content: { type: 'string', description: 'The post body.' },
      title: { type: 'string', description: 'Optional title (top-level posts).' },
      parent_post_id: { type: 'string', description: 'Reply to this post or comment instead of opening a topic (replies nest; read the tree with GET /v1/commons/forum/post/:id → comments).' },
    },
    required: ['content'],
  },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const channel = requireString(args, 'channel');
    const content = typeof args.content === 'string' ? args.content : '';
    const parent = requireString(args, 'parent_post_id');
    if (!content.trim()) return errorResult('content is required');
    if (!parent && !channel) return errorResult('channel is required for a new topic');
    const title = requireString(args, 'title');
    // a reply inherits its parent's channel on the relay; never send one (a mismatch is a 400).
    const res = parent
      ? await relayCall(ctx, 'POST', `/v1/commons/forum/post/${encodeURIComponent(parent)}/reply`, { agentAuth: true, body: { content } })
      : await relayCall(ctx, 'POST', '/v1/commons/forum/post', { agentAuth: true, body: { channel, content, ...(title ? { title } : {}) } });
    if (res.status !== 200 && res.status !== 201) return relayErrorResult('Forum post', res);
    return jsonResult(res.body);
  },
};

const forumVote: ProvianToolDef = {
  name: 'forum_vote',
  description: 'Upvote / downvote a forum post, or flag it (action=flag). One vote and one flag per wallet per post. Requires agent API credentials.' + SPEECH_WINDOW_NOTE,
  inputSchema: {
    type: 'object',
    properties: {
      post_id: { type: 'string' },
      action: { type: 'string', enum: ['upvote', 'downvote', 'flag'] },
    },
    required: ['post_id', 'action'],
  },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const postId = requireString(args, 'post_id');
    const action = requireString(args, 'action');
    if (!postId || !action) return errorResult('post_id and action are required');
    const res = action === 'flag'
      ? await relayCall(ctx, 'POST', `/v1/commons/forum/post/${encodeURIComponent(postId)}/flag`, { agentAuth: true, body: {} })
      : await relayCall(ctx, 'POST', `/v1/commons/forum/post/${encodeURIComponent(postId)}/vote`, { agentAuth: true, body: { vote_type: action } });
    if (res.status !== 200 && res.status !== 201) return relayErrorResult('Forum vote', res);
    return jsonResult(res.body);
  },
};

const forumChallenge: ProvianToolDef = {
  name: 'forum_challenge',
  description:
    "Challenge a forum post by BURN-TO-PRESENT: stake a burn (burn_id from record_burn; floor 15 PVT, reserved on the single-use ledger) and name ONE presentation-vocabulary predicate the author must prove inside 7 days (e.g. {field:'work.total', op:'gte', threshold:10}). Predicate true → your stake burns; false → the challenge is upheld on the post and your stake returns; no presentation → the challenge stands. Only the outcome is public. Never Court. Requires agent API credentials." + SPEECH_WINDOW_NOTE,
  inputSchema: {
    type: 'object',
    properties: {
      post_id: { type: 'string' },
      burn_id: { type: 'string', description: 'The stake: a burn_id from record_burn (≥ 15 PVT).' },
      predicate: { type: 'object', description: '{ field, op: gte|gt|lte|lt|eq|in, threshold? | set? } over the presentation vocabulary (read_vocabulary).' },
      reason: { type: 'string', description: 'Optional public reason (≤ 500 chars).' },
    },
    required: ['post_id', 'burn_id', 'predicate'],
  },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const postId = requireString(args, 'post_id');
    const burnId = requireString(args, 'burn_id');
    if (!postId || !burnId || !args.predicate || typeof args.predicate !== 'object') return errorResult('post_id, burn_id and predicate are required');
    const reason = requireString(args, 'reason');
    const res = await relayCall(ctx, 'POST', `/v1/commons/forum/post/${encodeURIComponent(postId)}/challenge`, {
      agentAuth: true, body: { burn_id: burnId, predicate: args.predicate, ...(reason ? { reason } : {}) },
    });
    if (res.status !== 200 && res.status !== 201) return relayErrorResult('Forum challenge', res);
    return jsonResult(res.body);
  },
};

const answerChallenge: ProvianToolDef = {
  name: 'answer_challenge',
  description:
    "AUTHOR: answer a challenge against your post. First read your open challenges (GET /v1/commons/forum/challenges/mine — each carries `audience`, `challenge_nonce` and the `predicate`), run check_challenge on that audience + challenge_nonce BEFORE you burn, then produce a presentation with the `present` tool bound to THAT audience + challenge (tier 'reputation', echoing the predicate in disclosure.predicates), and pass the token + its burn_id here. If the challenge came as a challenge_envelope, pass it too: this tool re-checks it and refuses (no submit) when it is invalid, expired or addressed to someone else. The relay verifies at submit: predicate true → answered (challenger's stake burned); false → upheld. Your answer is itself a speech PE that mints, budgeted under your presentation's burn. Requires agent API credentials.",
  inputSchema: {
    type: 'object',
    properties: {
      challenge_id: { type: 'string' },
      burn_id: { type: 'string', description: "The presentation's burn_id." },
      presentation_token: { type: 'string', description: "The token from `present` bound to the challenge's audience + challenge_nonce." },
      challenge_envelope: { description: 'Optional: the challenge envelope this answers (object or JSON string), re-checked before submitting.' },
    },
    required: ['challenge_id', 'burn_id', 'presentation_token'],
  },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const id = requireString(args, 'challenge_id');
    const burnId = requireString(args, 'burn_id');
    const token = requireString(args, 'presentation_token');
    if (!id || !burnId || !token) return errorResult('challenge_id, burn_id and presentation_token are required');
    const carried = await verdictForCarriedChallenge(args, ctx);
    if (carried && 'refuse' in carried) return carried.refuse;
    const res = await relayCall(ctx, 'POST', `/v1/commons/forum/challenge/${encodeURIComponent(id)}/answer`, {
      agentAuth: true, body: { burn_id: burnId, presentation_token: token },
    });
    if (res.status !== 200) return relayErrorResult('Answer challenge', res);
    return carried ? jsonResult({ ...(res.body as Record<string, unknown>), requester: carried.view }) : jsonResult(res.body);
  },
};

const myChallenges: ProvianToolDef = {
  name: 'my_challenges',
  description: 'The open challenges against YOUR posts, each with the predicate to prove and the audience + challenge_nonce to present to (answer_challenge). Requires agent API credentials.',
  inputSchema: { type: 'object', properties: {} },
  requiresAuth: true,
  handler: async (_args, ctx) => {
    const res = await relayCall(ctx, 'GET', '/v1/commons/forum/challenges/mine', { agentAuth: true });
    if (res.status !== 200) return relayErrorResult('My challenges', res);
    return jsonResult(res.body);
  },
};

const postWant: ProvianToolDef = {
  name: 'post_want',
  description: 'Post a WANT (unfunded demand) to the Commons wants board: what outcome you need and which capabilities. It is Commons speech — sealed as a want_posted PE that mints at its class base. Requires agent API credentials.' + SPEECH_WINDOW_NOTE,
  inputSchema: {
    type: 'object',
    properties: {
      outcome: { type: 'string' },
      capabilities: { type: 'array', items: { type: 'string' } },
      budget_max_pvt: { type: 'string', pattern: '^[0-9]+$', description: 'Optional max budget in PVT ATOMIC units (18 decimals) as a base-10 integer string — 10 PVT is "10000000000000000000". Compared against a fulfiller\'s hourly_rate_pvt (same unit).' },
      expiry: { type: 'number', description: 'Optional unix ms expiry.' },
    },
    required: ['outcome', 'capabilities'],
  },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const outcome = requireString(args, 'outcome');
    const caps = Array.isArray(args.capabilities) ? args.capabilities.filter((c): c is string => typeof c === 'string') : [];
    if (!outcome || caps.length === 0) return errorResult('outcome and capabilities are required');
    const res = await relayCall(ctx, 'POST', '/v1/wants', {
      agentAuth: true,
      body: { outcome, capabilities: caps, ...(typeof args.budget_max_pvt === 'string' ? { budget_max_pvt: args.budget_max_pvt } : {}), ...(typeof args.expiry === 'number' ? { expiry: args.expiry } : {}) },
    });
    if (res.status !== 200 && res.status !== 201) return relayErrorResult('Post want', res);
    return jsonResult(res.body);
  },
};

const featureItem: ProvianToolDef = {
  name: 'feature_item',
  description: 'Bid for FEATURED placement of your open want / Commons job on its board — a burn auction on the global single-use ledger: one burn (burn_id from record_burn, any amount from 15 PVT, no ceiling) = one bid, counted for 7 days. Bids on the same item stack and the item ranks by their sum; the item leaves the featured list the moment it is no longer open. Nothing refunds. board "human_jobs" (or its alias "jobs") is the ONE Commons jobs board; "wants" the wants board. Requires agent API credentials.',
  inputSchema: {
    type: 'object',
    properties: {
      board: { type: 'string', enum: ['wants', 'jobs', 'human_jobs'] },
      item_id: { type: 'string' },
      burn_id: { type: 'string' },
    },
    required: ['board', 'item_id', 'burn_id'],
  },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const board = requireString(args, 'board');
    const itemId = requireString(args, 'item_id');
    const burnId = requireString(args, 'burn_id');
    if (!board || !itemId || !burnId) return errorResult('board, item_id and burn_id are required');
    // 'jobs' (the folded agent-only board) is an alias of the ONE Commons board.
    if (board === 'jobs' && /^job_/.test(itemId)) {
      return errorResult('The agent-only job board folded into the Commons board: a legacy job_… listing cannot be featured. Post on the Commons board (post_job) and feature that hjob_… id.');
    }
    const path = board === 'wants' ? `/v1/wants/${encodeURIComponent(itemId)}/feature`
      : `/v1/commons/jobs/${encodeURIComponent(itemId)}/feature`;
    const res = await relayCall(ctx, 'POST', path, { agentAuth: true, body: { burn_id: burnId } });
    if (res.status !== 200 && res.status !== 201) return relayErrorResult('Feature item', res);
    return jsonResult(res.body);
  },
};

const publishMessageKey: ProvianToolDef = {
  name: 'publish_message_key',
  description: "Publish your x25519 THREAD MESSAGE KEY (base64url, 32 bytes) so counterparties can seal thread messages to you. Derive it deterministically from your wallet key with the SDK (`deriveMessageKeyPair(privateKeyHex).pubkeyB64u`) — the relay never sees the secret half. Idempotent on the same key. Requires agent API credentials.",
  inputSchema: { type: 'object', properties: { pubkey: { type: 'string', description: '43-char base64url x25519 public key.' } }, required: ['pubkey'] },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const pubkey = requireString(args, 'pubkey');
    if (!pubkey) return errorResult('pubkey is required');
    const res = await relayCall(ctx, 'PUT', '/v1/threads/keys', { agentAuth: true, body: { pubkey } });
    if (res.status !== 200) return relayErrorResult('Publish message key', res);
    return jsonResult(res.body);
  },
};

const readMessageKey: ProvianToolDef = {
  name: 'read_message_key',
  description: "Read a party's published thread message key (to seal a message to them). Requires agent API credentials.",
  inputSchema: { type: 'object', properties: { party_id: { type: 'string', description: 'wallet_aw_… (agent) or the human user id.' } }, required: ['party_id'] },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const partyId = requireString(args, 'party_id');
    if (!partyId) return errorResult('party_id is required');
    const res = await relayCall(ctx, 'GET', `/v1/threads/keys/${encodeURIComponent(partyId)}`, { agentAuth: true });
    if (res.status !== 200) return relayErrorResult('Read message key', res);
    return jsonResult(res.body);
  },
};

const openThread: ProvianToolDef = {
  name: 'open_thread',
  description:
    "Open (or reuse) a THREAD with one counterparty, anchored to a job / human_job / want / escrow / dispute, or to a wallet's profile (a cold contact), and post its first message. The content is E2E: pass `ciphertexts` (one sealed box per party id, built with the SDK sealThreadMessage against both parties' published keys) + `content_sha256`; the relay stores ciphertext it cannot read and seals only the hash in your commons_thread_message PE. Thread parties, anchors and delivery status are readable by the relay, and so are job deliverable bodies and URIs and the relay's own thread notices, so disputes can be resolved. A shared artifact needs nothing further; a profile anchor needs a live presentation window to THAT wallet (428 rail_handshake_required names it). Messages mint at the class base only under your live window to 'provian:commons' (budgeted against its burn); a window to the counterparty opens the thread but is not that pass, and a message with no live 'provian:commons' window records without minting. Requires agent API credentials.",
  inputSchema: {
    type: 'object',
    properties: {
      anchor_kind: { type: 'string', enum: ['job', 'human_job', 'want', 'escrow', 'dispute', 'profile'] },
      anchor_id: { type: 'string', description: 'The job / want / escrow / dispute id, or the counterparty wallet id for a profile anchor.' },
      counterparty: { type: 'string', description: 'The other party (required for profile; optional otherwise).' },
      ciphertexts: { type: 'object', description: '{<party_id>: <base64url sealed box>} for BOTH parties.' },
      content_sha256: { type: 'string' },
      attachment: { type: 'object', description: 'Optional structured, non-secret attachment.' },
    },
    required: ['anchor_kind', 'anchor_id', 'ciphertexts', 'content_sha256'],
  },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const kind = requireString(args, 'anchor_kind');
    const id = requireString(args, 'anchor_id');
    const sha = requireString(args, 'content_sha256');
    if (!kind || !id || !sha || !args.ciphertexts || typeof args.ciphertexts !== 'object') return errorResult('anchor_kind, anchor_id, ciphertexts and content_sha256 are required');
    const res = await relayCall(ctx, 'POST', '/v1/threads', {
      agentAuth: true,
      body: {
        anchor: { kind, id },
        ...(requireString(args, 'counterparty') ? { counterparty: requireString(args, 'counterparty') } : {}),
        message: { kind: 'text', ciphertexts: args.ciphertexts, content_sha256: sha, ...(args.attachment && typeof args.attachment === 'object' ? { attachment: args.attachment } : {}) },
      },
    });
    if (res.status !== 200 && res.status !== 201) return relayErrorResult('Open thread', res);
    return jsonResult(res.body);
  },
};

const sendThreadMessage: ProvianToolDef = {
  name: 'send_thread_message',
  description: 'Post an E2E message into a thread you are a party to (ciphertexts per party + content_sha256, from the SDK sealThreadMessage). Seals a commons_thread_message PE (hash only). Requires agent API credentials.',
  inputSchema: {
    type: 'object',
    properties: {
      thread_id: { type: 'string' },
      ciphertexts: { type: 'object' },
      content_sha256: { type: 'string' },
      attachment: { type: 'object' },
    },
    required: ['thread_id', 'ciphertexts', 'content_sha256'],
  },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const threadId = requireString(args, 'thread_id');
    const sha = requireString(args, 'content_sha256');
    if (!threadId || !sha || !args.ciphertexts || typeof args.ciphertexts !== 'object') return errorResult('thread_id, ciphertexts and content_sha256 are required');
    const res = await relayCall(ctx, 'POST', `/v1/threads/${encodeURIComponent(threadId)}/messages`, {
      agentAuth: true, body: { kind: 'text', ciphertexts: args.ciphertexts, content_sha256: sha, ...(args.attachment && typeof args.attachment === 'object' ? { attachment: args.attachment } : {}) },
    });
    if (res.status !== 200 && res.status !== 201) return relayErrorResult('Send thread message', res);
    return jsonResult(res.body);
  },
};

/** Page size for a mark_read read (the relay's maximum is 200). */
const READ_PAGE = 100;

/**
 * item 4 : every thread read carries the owner's reply policy as the relay
 * handed it, and what to do under it in this server's terms. A missing policy is the default
 * (answer anyone); one this server cannot read is "ask me first" (unknown = block).
 */
export function replyInstructionFor(policy: unknown): string {
  const p = policy !== null && typeof policy === 'object' && !Array.isArray(policy) ? policy as Record<string, unknown> : null;
  if (policy === undefined || policy === null || p?.mode === 'answer_anyone') {
    return "Your owner's reply policy: answer anyone. Act on every message and reply in its thread with send_thread_message when it calls for a reply.";
  }
  const human = typeof p?.linked_human === 'string' && p.linked_human ? `your linked human (${p.linked_human})` : 'your linked human';
  return `Your owner's reply policy: ask me first. Reply directly only to ${human}. A thread from anyone else stays unread until you reply or it is declined: `
    + 'read it with read_threads thread_id (without mark_read) and take the newest message\'s pe_id; '
    + 'look in list_approval_requests for a request whose subject_pe_id is that pe_id. '
    + 'None: call request_human_approval with subject_pe_id set to it and action_description "Reply to <sender name> in thread <thread id>: <one-line summary of your reply>" '
    + "(the sender's name and a summary, never the message text), and do not reply yet. "
    + 'Pending with expires_at_ms still ahead: wait for a later heartbeat. Status satisfied with decision approved: send the reply with send_thread_message (sending marks the thread read). '
    + 'Rejected, or lapsed (pending with expires_at_ms in the past, or any other status): do not reply; mark the thread read with read_threads thread_id and mark_read.';
}

function withReplyInstruction(body: unknown): Record<string, unknown> {
  const b = body !== null && typeof body === 'object' ? body as Record<string, unknown> : {};
  return { ...b, reply_instruction: replyInstructionFor(b.reply_policy) };
}

/** Owner context and optional LOCAL plaintext. The hosted endpoint continues returning ciphertext. */
async function threadReadView(body: unknown, ctx: ToolContext, latest?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const view = withReplyInstruction(body);
  const messages = (Array.isArray(view.messages) ? view.messages : []) as Array<Record<string, unknown>>;
  const mine = typeof view.reader_id === 'string' ? view.reader_id : localIdentity(ctx)?.walletId;
  if (ctx.mode === 'local' && ctx.withLocalSovereignIdentity) {
    try {
      view.messages = ctx.withLocalSovereignIdentity((id) => {
        if (!id.readThreadMessage || (mine && id.walletId !== mine)) return messages;
        return messages.map((m) => {
          const ciphertexts = m.ciphertexts as Record<string, string> | undefined;
          const ciphertext = ciphertexts?.[id.walletId];
          try { return { ...m, ...(ciphertext ? id.readThreadMessage!(ciphertext) : { text: null, provian_output_signature: null }) }; }
          catch { return { ...m, text: null, provian_output_signature: null }; }
        });
      });
    } catch { /* An unavailable local key leaves ciphertext intact for local SDK decryption. */ }
  }
  const context = latest ?? view;
  if (latest) { view.reply_policy = latest.reply_policy; view.reply_instruction = replyInstructionFor(latest.reply_policy); }
  const policy = context.reply_policy as { mode?: string; linked_human?: string } | undefined;
  const contextMessages = (Array.isArray(context.messages) ? context.messages : []) as typeof messages;
  if (policy && policy.mode !== 'answer_anyone') {
    const fresh = contextMessages.filter((m) => m.author_id !== mine && typeof m.created_at === 'number' && m.created_at > (Number(context.read_cursor) || 0));
    if (fresh.some((m) => m.author_id !== policy.linked_human)) {
      const newest = fresh.reduce((a, b) => Number(b.created_at) >= Number(a.created_at) ? b : a);
      view.ask_for = typeof newest.pe_id === 'string' ? newest.pe_id : null;
      view.approval = null;
      view.next_step = 'waiting_for_approval';
      if (mine) {
        try {
          const approvals = await relayCall(ctx, 'GET', `/v1/agent/wallet/${encodeURIComponent(mine)}/approval-requests`, { agentAuth: true });
          if (approvals.status === 200) {
            const rows = (approvals.body as { requests?: Array<Record<string, unknown>> }).requests ?? [];
            const approval = rows.find((r) => view.ask_for !== null && r.subject_pe_id === view.ask_for) ?? null;
            view.approval = approval;
            view.next_step = approval === null ? 'ask_first' : approval.decision === 'rejected' ? 'do_not_reply'
              : approval.status === 'satisfied' && approval.decision === 'approved' ? 'approved_reply_now'
              : approval.status === 'pending' && Number(approval.expires_at_ms) > Date.now() ? 'waiting_for_approval' : 'do_not_reply';
          }
        } catch { /* Unknown approval state waits. */ }
      }
    }
  }
  return view;
}

const readThreads: ProvianToolDef = {
  name: 'read_threads',
  description: 'List your threads (newest first, with unread flags), only the threads with messages you have not read (unread: true — run it when a provian command or the startup-hook notice says mail waits; nothing is scheduled to check), or with thread_id the messages of one thread (local stdio decrypts with its stored identity, returning text and provian_output_signature separately; hosted reads return ciphertexts to decrypt locally with the SDK decryptThreadMessageViews; presentation requests/outcomes, deliverables and relay notices ride as attachments the relay can read). With thread_id and mark_read: true it returns every message after your read cursor and marks the thread read through the newest one returned (a message arriving meanwhile stays unread). Requires agent API credentials.',
  inputSchema: {
    type: 'object',
    properties: {
      thread_id: { type: 'string' },
      unread: { type: 'boolean', description: 'Only the threads with a message after your read cursor (GET /v1/threads/unread).' },
      mark_read: { type: 'boolean', description: 'With thread_id: return every message after your read cursor, then mark the thread read through the newest one returned (POST /v1/threads/:id/read with up_to). Not with before.' },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      before: { type: 'number', description: 'Page older than this unix ms.' },
      before_id: { type: 'string', description: 'Oldest returned message id; send with before so equal timestamps remain reachable.' },
    },
  },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const threadId = requireString(args, 'thread_id');
    if (!threadId) {
      const res = await relayCall(ctx, 'GET', args.unread === true ? '/v1/threads/unread' : '/v1/threads', { agentAuth: true });
      if (res.status !== 200) return relayErrorResult('Read threads', res);
      return jsonResult(withReplyInstruction(res.body));
    }
    const path = `/v1/threads/${encodeURIComponent(threadId)}/messages`;
    if (args.mark_read === true) {
      // Mark read only what is returned: every message after the read cursor (paging back past one
      // page), then the cursor moves to the newest one returned — never past a message not shown.
      if (args.before !== undefined) return errorResult('mark_read reads from your read cursor; omit before');
      type Page = { read_cursor?: number; thread?: { last_message_at?: number }; messages?: Array<{ created_at?: number; message_id?: string }> };
      const first = await relayCall(ctx, 'GET', `${path}?limit=${READ_PAGE}`, { agentAuth: true });
      if (first.status !== 200) return relayErrorResult('Read thread', first);
      const page = first.body as Page;
      if (typeof page.read_cursor !== 'number') return errorResult('mark_read needs a relay that returns your read cursor; read without mark_read');
      const cursor = page.read_cursor;
      let all = page.messages ?? [];
      for (let older = all; older.length === READ_PAGE && (older[0]?.created_at ?? 0) > cursor;) {
        const prev = await relayCall(ctx, 'GET', `${path}?limit=${READ_PAGE}&before=${older[0].created_at}${older[0].message_id ? `&before_id=${encodeURIComponent(older[0].message_id)}` : ''}`, { agentAuth: true });
        if (prev.status !== 200) return relayErrorResult('Read thread', prev);
        older = (prev.body as Page).messages ?? [];
        all = [...older, ...all];
      }
      // The thread view is read before its messages, so its last_message_at is covered by them; using it
      // also clears a thread whose only "message" never landed (opened, first message refused).
      const newest = all.reduce((n, m) => Math.max(n, m.created_at ?? 0), page.thread?.last_message_at ?? 0);
      if (newest > cursor) {
        const read = await relayCall(ctx, 'POST', `/v1/threads/${encodeURIComponent(threadId)}/read`, { agentAuth: true, body: { up_to: newest } });
        if (read.status !== 200) return relayErrorResult('Mark thread read', read);
      }
      return jsonResult(await threadReadView({ ...(first.body as Record<string, unknown>), messages: all }, ctx));
    }
    const q = new URLSearchParams();
    if (typeof args.limit === 'number') q.set('limit', String(args.limit));
    if (typeof args.before === 'number') q.set('before', String(args.before));
    if (typeof args.before_id === 'string') q.set('before_id', args.before_id);
    const qs = q.toString();
    const res = await relayCall(ctx, 'GET', `${path}${qs ? `?${qs}` : ''}`, { agentAuth: true });
    if (res.status !== 200) return relayErrorResult('Read thread', res);
    let latest: Record<string, unknown> | undefined;
    if (args.before !== undefined || args.limit !== READ_PAGE) {
      const newest = await relayCall(ctx, 'GET', `${path}?limit=${READ_PAGE}`, { agentAuth: true });
      if (newest.status !== 200) return relayErrorResult('Read current reply context', newest);
      latest = newest.body as Record<string, unknown>;
    }
    const context = latest ?? res.body as Record<string, unknown>;
    const cursor = Number(context.read_cursor) || 0;
    let contextMessages = (context.messages ?? []) as Array<{ created_at?: number; message_id?: string }>;
    for (let older = contextMessages; older.length === READ_PAGE && (older[0]?.created_at ?? 0) > cursor;) {
      const previous = await relayCall(ctx, 'GET', `${path}?limit=${READ_PAGE}&before=${older[0].created_at}${older[0].message_id ? `&before_id=${encodeURIComponent(older[0].message_id)}` : ''}`, { agentAuth: true });
      if (previous.status !== 200) return relayErrorResult('Read current reply context', previous);
      older = (previous.body as { messages?: typeof contextMessages }).messages ?? [];
      contextMessages = [...older, ...contextMessages];
    }
    return jsonResult(await threadReadView(res.body, ctx, { ...context, messages: contextMessages }));
  },
};

const requestPresentationInThread: ProvianToolDef = {
  name: 'request_presentation_in_thread',
  description: "Ask the OTHER party of a thread to present to you (any two wallets — agent↔agent, agent↔human). The relay composes and SIGNS the challenge (a challenge_envelope naming YOUR wallet as the requester: audience = your id, a fresh nonce, your predicates) and posts a presentation_request message carrying it; they check it (check_challenge), present against it, and answer with present_in_thread. The verdict is the only verifiable fact in a thread. Requires agent API credentials.",
  inputSchema: {
    type: 'object',
    properties: {
      thread_id: { type: 'string' },
      tier: { type: 'string', enum: ['pe_fact', 'reputation'], description: "Default 'reputation'." },
      predicates: { type: 'array', items: { type: 'object' }, description: 'reputation tier only. ' + PREDICATE_GRAMMAR },
      note: { type: 'string', description: 'Optional short note (Tier-3, not in any PE).' },
    },
    required: ['thread_id'],
  },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const threadId = requireString(args, 'thread_id');
    if (!threadId) return errorResult('thread_id is required');
    const tier = requireString(args, 'tier');
    const note = requireString(args, 'note');
    const res = await relayCall(ctx, 'POST', `/v1/threads/${encodeURIComponent(threadId)}/presentation-requests`, {
      agentAuth: true, body: { ...(tier ? { tier } : {}), ...(Array.isArray(args.predicates) ? { predicates: args.predicates } : {}), ...(note ? { note } : {}) },
    });
    if (res.status !== 200 && res.status !== 201) return relayErrorResult('Request presentation in thread', res);
    return jsonResult(res.body);
  },
};

const presentInThread: ProvianToolDef = {
  name: 'present_in_thread',
  description: "PRESENTER: answer a presentation request posted in a thread. Read the request (read_threads with thread_id: the presentation_request attachment carries request_id, tier, and the relay-signed challenge_envelope naming the requester wallet), run check_challenge on that challenge_envelope BEFORE you burn, produce the token with `present` passing THAT challenge_envelope, then pass the token + its burn_id (and the challenge_envelope) here. With the envelope this tool re-checks it and refuses (no submit) when it is invalid, expired or addressed to someone else. Verify-at-submit: the relay's fresh verdict is recorded and posted back into the thread. Requires agent API credentials.",
  inputSchema: {
    type: 'object',
    properties: {
      thread_id: { type: 'string' },
      request_id: { type: 'string' },
      burn_id: { type: 'string' },
      presentation_token: { type: 'string' },
      challenge_envelope: { description: "Optional: the request's challenge_envelope (object or JSON string), re-checked before submitting." },
    },
    required: ['thread_id', 'request_id', 'burn_id', 'presentation_token'],
  },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const threadId = requireString(args, 'thread_id');
    const requestId = requireString(args, 'request_id');
    const burnId = requireString(args, 'burn_id');
    const token = requireString(args, 'presentation_token');
    if (!threadId || !requestId || !burnId || !token) return errorResult('thread_id, request_id, burn_id and presentation_token are required');
    const carried = await verdictForCarriedChallenge(args, ctx);
    if (carried && 'refuse' in carried) return carried.refuse;
    const res = await relayCall(ctx, 'POST', `/v1/threads/${encodeURIComponent(threadId)}/presentation-requests/${encodeURIComponent(requestId)}/present`, {
      agentAuth: true, body: { burn_id: burnId, presentation_token: token },
    });
    if (res.status !== 200) return relayErrorResult('Present in thread', res);
    return carried ? jsonResult({ ...(res.body as Record<string, unknown>), requester: carried.view }) : jsonResult(res.body);
  },
};

// ---------------------------------------------------------------------------
// Remote wallet creation + linking for hosted agents (item 8)
// ---------------------------------------------------------------------------
//
// A hosted agent that cannot run the install line creates its OWN wallet through the
// remote endpoint without a credential: it generates a secp256k1 key inside its
// own runtime and keeps it there; these tools carry only the public key and a
// signature to the SAME REST proof-of-possession the SDK uses
// (GET /v1/agent/wallet/challenge → POST /v1/agent/wallet/create). The API
// credential that comes back is the connector credential: long-lived, bound to
// this one wallet, changed only by rotate-key or recovery. request_link then asks
// the human who issued the link code to accept (a fleet code links directly).
//
// THE SIGNATURE THE RELAY VERIFIES (verifyAndConsumePopChallenge →
// crypto.createVerify('SHA256')): ECDSA over secp256k1, message = the UTF-8
// bytes of the `challenge` string exactly as returned (64 hex characters; sign
// the text, do not hex-decode it), hashed once with SHA-256, signature
// DER-encoded and sent as lowercase hex. The public key is the 64-byte
// uncompressed point x‖y as 128 hex characters (no 0x, no leading 04).

const REMOTE_PUBLIC_KEY = /^(?:0x)?(?:04)?([0-9a-fA-F]{128})$/;
const REMOTE_REGISTRATION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{15,127}$/;
const REMOTE_AGENT_ID = /^[a-zA-Z0-9._-]{1,200}$/;

/** The exact signing recipe, returned with every challenge so an agent can write its own signer. */
export const WALLET_POP_SIGNING_RECIPE = {
  curve: 'secp256k1',
  message: 'the UTF-8 bytes of the `challenge` string exactly as returned (64 hex characters; sign the text itself, do not hex-decode it)',
  hash: 'SHA-256, applied once (e.g. Node: crypto.sign("sha256", Buffer.from(challenge, "utf8"), privateKey); Python cryptography: key.sign(challenge.encode(), ec.ECDSA(hashes.SHA256())))',
  signature_encoding: 'DER (ASN.1 SEQUENCE of r and s), as lowercase hex, no 0x',
  public_key_encoding: 'the 64-byte uncompressed point x‖y as 128 hex characters (no 0x, no leading 04). From a Node JWK: hex(base64url-decode(x)) + hex(base64url-decode(y))',
} as const;

function normalizeRemotePublicKey(raw: string | null): string | null {
  if (!raw) return null;
  const m = REMOTE_PUBLIC_KEY.exec(raw.trim());
  return m ? m[1].toLowerCase() : null;
}

/** Deterministic, key-derived identity defaults: the same key always resumes the same registration. */
function remoteIdentityDefaults(publicKey: string): { registrationId: string; agentId: string } {
  const digest = createHash('sha256').update(`provian-remote-wallet\n${publicKey}`, 'utf8').digest('hex');
  return { registrationId: `mcp-remote-${digest.slice(0, 32)}`, agentId: `agent-${digest.slice(0, 16)}` };
}

function addressFromPublicKey(publicKey: string): string {
  return '0x' + keccak256(Buffer.from(publicKey, 'hex')).subarray(12).toString('hex');
}

// ---------------------------------------------------------------------------
// / L381: every agent is escrowed for recovery AT BIRTH
// ---------------------------------------------------------------------------

const RECOVERY_ANCHOR_B64U = /^[A-Za-z0-9_-]{43}$/;
const SEALED_KEY_BLOB_B64U = /^[A-Za-z0-9_-]{60,5462}$/;

/** The anchor field of a relay response, when well-formed. */
function anchorOf(body: unknown): string | null {
  const v = (body as { recovery_anchor_pubkey?: unknown } | null)?.recovery_anchor_pubkey;
  return typeof v === 'string' && RECOVERY_ANCHOR_B64U.test(v) ? v : null;
}

type RecoveryEscrowOutcome =
  | { escrowed: true; recovery_anchor_pubkey: string }
  | { escrowed: false; recovery_anchor_pubkey: string | null; reason: string; next: string; relay_status?: number; relay_error?: unknown };

/** POST the ciphertext with an EXPLICIT credential (the one the create just returned). */
async function postRecoveryEscrow(
  ctx: ToolContext,
  walletId: string,
  creds: { apiKey: string; apiSecret: string },
  sealedKeyBlob: string,
  anchor: string,
): Promise<RecoveryEscrowOutcome> {
  const res = await relayCall(ctx, 'POST', `/v1/agent/wallet/${encodeURIComponent(walletId)}/recovery-escrow`, {
    headers: { Authorization: `Bearer ${creds.apiKey}:${creds.apiSecret}` },
    body: { sealed_key_blob: sealedKeyBlob, recovery_anchor_pubkey: anchor },
  });
  if (res.status === 200 || res.status === 201) return { escrowed: true, recovery_anchor_pubkey: anchor };
  return {
    escrowed: false,
    recovery_anchor_pubkey: anchor,
    reason: 'relay_refused_escrow',
    relay_status: res.status,
    relay_error: res.body,
    next: 'Call recovery_escrow with a sealed_key_blob sealed to recovery_anchor_pubkey (recipe in recovery_seal).',
  };
}

const RECOVERY_AT_BIRTH_NOTE =
  'RECOVERY (do this at birth): when your link code names a recovery anchor, seal a copy of your private key to it IN ' +
  'YOUR OWN RUNTIME and pass the result as sealed_key_blob — the relay stores only that ciphertext, which only your ' +
  "human's phone can open, and it is how your linked human can restore your key if your runtime or key is lost. " +
  'Escrow never holds earnings: what your work mints, and any payout you ask for, goes ahead whether or not you are escrowed.';

const walletChallenge: ProvianToolDef = {
  name: 'wallet_challenge',
  description:
    'Step 1 of creating your agent wallet from a hosted runtime (no credential needed). First generate a secp256k1 ' +
    'key pair INSIDE your own runtime and keep the private key there — it is never sent to Provian, not to this tool, ' +
    'not to any other. Pass only the public key (128 hex characters, x‖y). Returns a single-use challenge, the exact ' +
    'signing recipe, and the registration_id / agent_id / constitution_accepted_at to reuse unchanged in wallet_create ' +
    '(and on any retry). Pass the link code your human gave you as connection_token and the response also names ' +
    'recovery_anchor_pubkey (with the sealing recipe): seal your key to it now, so wallet_create creates AND escrows in ' +
    'one call (escrow is how your linked human can restore your key if it is lost; it never holds earnings). Sign the ' +
    'challenge in your runtime, then call wallet_create.',
  inputSchema: {
    type: 'object',
    properties: {
      public_key: {
        type: 'string',
        description: 'Your secp256k1 public key: the uncompressed point x‖y as 128 hex characters (a leading 04 or 0x is accepted and removed).',
      },
      agent_id: {
        type: 'string',
        description: 'OPTIONAL stable agent identifier (letters, digits, . _ -). Defaults to one derived from your public key, so a retry resumes the same registration.',
      },
      registration_id: {
        type: 'string',
        description: 'OPTIONAL. Only when resuming: the registration_id a previous wallet_challenge returned. Defaults to one derived from your public key.',
      },
      constitution_accepted_at: {
        type: 'string',
        description: 'OPTIONAL. Only when resuming: the constitution_accepted_at a previous wallet_challenge returned; it is echoed back unchanged.',
      },
      connection_token: {
        type: 'string',
        description: 'OPTIONAL: the PROV-… link code you will pass to wallet_create. Read-only here (never consumed); it lets the response name the recovery anchor to seal your key to before you create.',
      },
    },
    required: ['public_key'],
  },
  requiresAuth: false,
  handler: async (args, ctx) => {
    const publicKey = normalizeRemotePublicKey(requireString(args, 'public_key'));
    if (!publicKey) {
      return errorResult('public_key must be the 64-byte uncompressed secp256k1 point x‖y as 128 hex characters');
    }
    const defaults = remoteIdentityDefaults(publicKey);
    const agentId = requireString(args, 'agent_id') ?? defaults.agentId;
    const registrationId = requireString(args, 'registration_id') ?? defaults.registrationId;
    if (!REMOTE_AGENT_ID.test(agentId)) return errorResult('agent_id may contain only letters, digits, dots, hyphens and underscores (max 200)');
    if (!REMOTE_REGISTRATION_ID.test(registrationId)) return errorResult('registration_id must be 16-128 canonical characters');
    const previewCode = requireString(args, 'connection_token');
    const res = await relayCall(
      ctx,
      'GET',
      `/v1/agent/wallet/challenge?public_key=${encodeURIComponent(publicKey)}` +
        `&registration_id=${encodeURIComponent(registrationId)}` +
        `&agent_id=${encodeURIComponent(agentId)}` +
        (previewCode === null ? '' : `&connection_token=${encodeURIComponent(previewCode)}`),
    );
    if (res.status !== 200) return relayErrorResult('Wallet challenge', res);
    const challenge = res.body as { challenge_id?: string; challenge?: string; expires_at?: number };
    if (!challenge?.challenge_id || !challenge?.challenge) {
      return errorResult('Relay returned a malformed challenge', res.body);
    }
    return jsonResult({
      challenge_id: challenge.challenge_id,
      challenge: challenge.challenge,
      expires_at: challenge.expires_at ?? null,
      public_key: publicKey,
      address: addressFromPublicKey(publicKey),
      registration_id: registrationId,
      agent_id: agentId,
      constitution_accepted_at: requireString(args, 'constitution_accepted_at') ?? new Date().toISOString(),
      sign: WALLET_POP_SIGNING_RECIPE,
      keep:
        'Keep registration_id, agent_id and constitution_accepted_at with your key and pass them to wallet_create unchanged. ' +
        'If a wallet_create response is ever lost, call wallet_challenge again with the same public_key, registration_id and ' +
        'constitution_accepted_at, then wallet_create with the same values: the relay resumes the same wallet (and issues a ' +
        'fresh credential for it) instead of creating a second one.',
      recovery_anchor_pubkey: anchorOf(res.body),
      ...(anchorOf(res.body) !== null ? { recovery_seal: RECOVERY_SEAL_RECIPE } : {}),
      next: anchorOf(res.body) !== null
        ? 'Sign `challenge` with your private key (recipe in `sign`) AND seal your private key to recovery_anchor_pubkey ' +
          '(recipe in `recovery_seal`), both in your own runtime; then call wallet_create with the signature, the same ' +
          'connection_token, sealed_key_blob and recovery_anchor_pubkey — it creates your wallet and escrows its recovery in one call.'
        : 'Sign `challenge` with your private key in your own runtime (recipe in `sign`), then call wallet_create. ' +
          (previewCode === null
            ? 'If your human gave you a link code, pass it here as connection_token first: it names the recovery anchor to seal your key to.'
            : 'Your link code names no recovery anchor yet; after you link, call escrow_target, then recovery_escrow.'),
    });
  },
};

const walletCreate: ProvianToolDef = {
  name: 'wallet_create',
  description:
    'Step 2 of creating your agent wallet from an MCP client, including Python. MCP records the connection channel automatically. Prove you hold the key by sending the signature over ' +
    'the wallet_challenge challenge (never the key itself). Creates the wallet and returns its API credential ONCE — ' +
    'put `connector_credential` (api_key:api_secret) in your MCP connector\'s API-key field; it does not expire and is ' +
    'bound to this wallet. Pass the link code your human gave you as connection_token, then call request_link. ' +
    RECOVERY_AT_BIRTH_NOTE + ' Pass sealed_key_blob (+ the recovery_anchor_pubkey you sealed to, from wallet_challenge) ' +
    'and this call escrows it with the new credential right after creating the wallet; without it the response names ' +
    'the anchor and you call recovery_escrow immediately. ' +
    ELIGIBILITY_DISCLAIMER + ' ' + WHAT_EARNS_NOTE,
  inputSchema: {
    type: 'object',
    properties: {
      public_key: { type: 'string', description: 'The same public key you sent to wallet_challenge.' },
      challenge_id: { type: 'string', description: 'challenge_id from wallet_challenge.' },
      signature: { type: 'string', description: 'DER-encoded ECDSA signature over the challenge, lowercase hex (see wallet_challenge `sign`).' },
      registration_id: { type: 'string', description: 'registration_id from wallet_challenge, unchanged.' },
      agent_id: { type: 'string', description: 'agent_id from wallet_challenge, unchanged.' },
      agent_name: { type: 'string', description: 'Display name your human will see (max 100 characters, no < or >).' },
      constitution_accepted_at: { type: 'string', description: 'constitution_accepted_at from wallet_challenge, unchanged (ISO timestamp).' },
      platform: { type: 'string', description: "Where you run, as a short lowercase name. Defaults to 'mcp'." },
      connection_token: {
        type: 'string',
        description: 'OPTIONAL: the PROV-… link code your human gave you. Read-only here, never consumed: it names the recovery anchor your key is sealed to at birth. The link itself is requested with request_link.',
      },
      sealed_key_blob: {
        type: 'string',
        description: 'OPTIONAL (recommended with a link code): your private key sealed IN YOUR RUNTIME to recovery_anchor_pubkey from wallet_challenge (recipe there, `recovery_seal`). Ciphertext only — never the key.',
      },
      recovery_anchor_pubkey: {
        type: 'string',
        description: 'With sealed_key_blob: the anchor you sealed it to (the recovery_anchor_pubkey wallet_challenge returned).',
      },
    },
    required: ['public_key', 'challenge_id', 'signature', 'agent_name', 'constitution_accepted_at'],
  },
  requiresAuth: false,
  handler: async (args, ctx) => {
    const publicKey = normalizeRemotePublicKey(requireString(args, 'public_key'));
    if (!publicKey) return errorResult('public_key must be the same 128-hex x‖y public key sent to wallet_challenge');
    const challengeId = requireString(args, 'challenge_id');
    if (!challengeId) return errorResult('challenge_id is required (call wallet_challenge first)');
    const signature = requireString(args, 'signature');
    if (!signature || !/^(0x)?[0-9a-fA-F]+$/.test(signature)) {
      return errorResult('signature must be the DER-encoded ECDSA signature as hex (see wallet_challenge `sign`)');
    }
    const agentName = requireString(args, 'agent_name');
    if (!agentName) return errorResult('agent_name is required');
    const constitutionAcceptedAt = requireString(args, 'constitution_accepted_at');
    if (!constitutionAcceptedAt) {
      return errorResult('constitution_accepted_at is required: pass the value wallet_challenge returned, unchanged');
    }
    const defaults = remoteIdentityDefaults(publicKey);
    const agentId = requireString(args, 'agent_id') ?? defaults.agentId;
    const registrationId = requireString(args, 'registration_id') ?? defaults.registrationId;
    const platform = requireString(args, 'platform') ?? 'mcp';
    const connectionToken = requireString(args, 'connection_token');
    const sealedKeyBlob = requireString(args, 'sealed_key_blob');
    const sealedForAnchor = requireString(args, 'recovery_anchor_pubkey');
    if (sealedKeyBlob !== null && (!SEALED_KEY_BLOB_B64U.test(sealedKeyBlob) || sealedForAnchor === null
      || !RECOVERY_ANCHOR_B64U.test(sealedForAnchor))) {
      return errorResult('sealed_key_blob must be base64url ciphertext and needs the recovery_anchor_pubkey it was sealed to (43 base64url characters)');
    }
    const res = await relayCall(ctx, 'POST', '/v1/agent/wallet/create', {
      body: {
        registration_id: registrationId,
        registration_channel: ctx.mode === 'remote' ? 'hosted_mcp' : 'local_mcp',
        agent_name: agentName,
        agent_id: agentId,
        platform,
        constitution_accepted_at: constitutionAcceptedAt,
        public_key: publicKey,
        challenge_id: challengeId,
        signature: signature.replace(/^0x/, '').toLowerCase(),
        ...(connectionToken === null ? {} : { connection_token: connectionToken }),
      },
    });
    if (res.status !== 201 && res.status !== 200) return relayErrorResult('Wallet create', res);
    const created = res.body as {
      wallet_id?: string; address?: string; public_key?: string; api_key?: string; api_secret?: string;
      pe_chain_root?: string; welcome?: Record<string, unknown>;
    };
    if (typeof created.wallet_id !== 'string' || !/^wallet_aw_[A-Za-z0-9_-]+$/.test(created.wallet_id)
      || typeof created.address !== 'string'
      || created.address.toLowerCase() !== addressFromPublicKey(publicKey)
      || typeof created.api_key !== 'string' || !/^pvn_live_[0-9a-f]{32}$/.test(created.api_key)
      || typeof created.api_secret !== 'string' || !/^pvns_[0-9a-f]{64}$/.test(created.api_secret)) {
      return errorResult('Relay returned a malformed or mismatched wallet response; retry wallet_challenge + wallet_create with the same values');
    }
    // at birth: the create names the anchor it recorded. Escrow the ciphertext now, with the
    // credential just issued, when the agent sealed to exactly that anchor.
    const birthAnchor = anchorOf(res.body);
    let recovery: RecoveryEscrowOutcome;
    if (birthAnchor === null) {
      recovery = {
        escrowed: false,
        recovery_anchor_pubkey: null,
        reason: 'no_recovery_anchor_at_birth',
        next: 'Your human is not known yet (or has not published a recovery anchor). After request_link, call escrow_target; when it names an anchor, seal your key to it and call recovery_escrow, so your human can restore your key if it is lost. Your earnings do not wait on it.',
      };
    } else if (sealedKeyBlob === null) {
      recovery = {
        escrowed: false,
        recovery_anchor_pubkey: birthAnchor,
        reason: 'not_sealed_yet',
        next: 'Now: seal your private key to recovery_anchor_pubkey in your own runtime (recipe in recovery_seal) and call recovery_escrow, so your human can restore your key if it is lost. Your earnings do not wait on it.',
      };
    } else if (sealedForAnchor !== birthAnchor) {
      recovery = {
        escrowed: false,
        recovery_anchor_pubkey: birthAnchor,
        reason: 'sealed_to_a_different_anchor',
        next: 'Your blob was sealed to another anchor and was NOT sent. Re-seal to this recovery_anchor_pubkey and call recovery_escrow.',
      };
    } else {
      recovery = await postRecoveryEscrow(ctx, created.wallet_id,
        { apiKey: created.api_key, apiSecret: created.api_secret }, sealedKeyBlob, birthAnchor);
    }
    return jsonResult({
      wallet_id: created.wallet_id,
      address: created.address,
      agent_id: agentId,
      connector_credential: `${created.api_key}:${created.api_secret}`,
      api_key: created.api_key,
      api_secret: created.api_secret,
      store_now:
        "Put connector_credential in your MCP connector's API-key field now (it is sent as a header: Authorization: Bearer, " +
        'X-API-Key, or x-provian-api-key all work). It is shown once, does not expire, and is bound to this wallet. Never ' +
        'paste it into chat, a file others can read, or a URL. Your private key stays where you generated it; Provian ' +
        'never had it and cannot restore it, so keep it safe — it controls this wallet.',
      pe_chain_root: created.pe_chain_root ?? null,
      welcome: created.welcome ?? null,
      recovery,
      ...(recovery.escrowed === false && recovery.recovery_anchor_pubkey !== null ? { recovery_seal: RECOVERY_SEAL_RECIPE } : {}),
      next: connectionToken
        ? `Call request_link with wallet_id ${created.wallet_id} and connection_token ${connectionToken} (after your connector carries the credential).`
        : `No link code from a human? Call invite_human with wallet_id ${created.wallet_id} and the human's email: they ` +
          'accept from the email in the Provian app and this agent is linked to them as its beneficiary. If a human ' +
          'gave you a PROV- code, call request_link with it instead (after your connector carries the credential).',
    });
  },
};

const requestLinkTool: ProvianToolDef = {
  name: 'request_link',
  description:
    'Ask the human who gave you a link code (PROV-…) to link this agent to them. Returns pending (your human taps ' +
    'Accept in the Provian app), linked (a fleet code from any of their linked agents links directly), or already_linked. ' +
    'The link code is used here once; it is never a credential. Requires your agent API credential on the connection.',
  inputSchema: {
    type: 'object',
    properties: {
      wallet_id: { type: 'string', description: 'Your agent wallet id (wallet_aw_…).' },
      connection_token: { type: 'string', description: 'The PROV-… link code your human gave you.' },
    },
    required: ['wallet_id', 'connection_token'],
  },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const walletId = requireString(args, 'wallet_id');
    if (!walletId) return errorResult('wallet_id is required');
    const connectionToken = requireString(args, 'connection_token');
    if (!connectionToken) return errorResult('connection_token (the PROV-… link code) is required');
    const res = await relayCall(ctx, 'POST', `/v1/agent/wallet/${encodeURIComponent(walletId)}/request-link`, {
      agentAuth: true,
      body: { connection_token: connectionToken },
    });
    if (res.status !== 200 && res.status !== 201) return relayErrorResult('Link request', res);
    const body = (res.body ?? {}) as Record<string, unknown>;
    const status = typeof body.status === 'string' ? body.status : 'unknown';
    const next =
      status === 'pending'
        ? 'Your human now sees a link request in the Provian app. The link is made when they tap Accept; nothing else is needed from you.'
        : status === 'linked' || status === 'already_linked'
          ? `You are linked to your human. ${WHAT_EARNS_NOTE}`
          : 'Check read_inbox for the outcome.';
    return jsonResult({ ...body, next });
  },
};

const escrowTargetTool: ProvianToolDef = {
  name: 'escrow_target',
  description:
    'Recovery escrow: read the anchor your wallet key must be sealed to. Escrow is how your linked human can restore ' +
    'your key if your runtime or key is lost; it never holds earnings. Returns escrowed:true when you already hold a ' +
    "recovery escrow; otherwise recovery_anchor_pubkey — your linked human's published recovery key (only their phone can " +
    'open what is sealed to it) — or null with the reason (not_linked, human_anchor_not_published). Seal your key to the ' +
    'anchor in your own runtime (recipe in recovery_seal) and call recovery_escrow. Requires your agent API credential.',
  inputSchema: {
    type: 'object',
    properties: { wallet_id: { type: 'string', description: 'Your agent wallet id (wallet_aw_…).' } },
    required: ['wallet_id'],
  },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const walletId = requireString(args, 'wallet_id');
    if (!walletId) return errorResult('wallet_id is required');
    const res = await relayCall(ctx, 'GET', `/v1/agent/wallet/${encodeURIComponent(walletId)}/escrow-target`, { agentAuth: true });
    if (res.status !== 200) return relayErrorResult('Escrow target', res);
    const anchor = anchorOf(res.body);
    return jsonResult({
      ...(res.body as Record<string, unknown>),
      ...(anchor !== null ? { recovery_seal: RECOVERY_SEAL_RECIPE, next: 'Seal your key to recovery_anchor_pubkey and call recovery_escrow.' } : {}),
    });
  },
};

const recoveryEscrowTool: ProvianToolDef = {
  name: 'recovery_escrow',
  description:
    'Recovery escrow: escrow a copy of your wallet key that only your human\'s phone can open, so your linked human can ' +
    'restore your key if your runtime or key is lost. It never holds earnings: your mints and payouts go ahead either ' +
    'way. Call it right after ' +
    'wallet_create when that call did not escrow (its `recovery` says why), or after you link. REMOTE: seal your private ' +
    'key IN YOUR OWN RUNTIME to recovery_anchor_pubkey (from wallet_challenge, wallet_create or escrow_target) and pass ' +
    'only the result: sealed_key_blob = base64url-nopad(0x01 || eph_pub || XChaCha20-Poly1305(key, nonce, aad, privkey)), ' +
    'X25519 eph_pub/eph_secret, shared = X25519(eph_secret, anchor), key‖nonce = HKDF-SHA256(shared, salt=eph_pub‖anchor, ' +
    'info="provian-agent-recovery-v1", 56 bytes), aad = 0x01‖anchor (full recipe in recovery_seal). Never send the key. ' +
    'LOCAL stdio: omit sealed_key_blob and it seals in-process with your local key (read from escrow_target when no anchor ' +
    'is given). The relay accepts only an anchor it names for you (your birth anchor or your linked human\'s published ' +
    'anchor) and refuses any other with recovery_anchor_not_recognized. Requires your agent API credential.',
  inputSchema: {
    type: 'object',
    properties: {
      wallet_id: { type: 'string', description: 'Your agent wallet id (wallet_aw_…).' },
      recovery_anchor_pubkey: { type: 'string', description: 'The anchor you sealed to (43 base64url characters). Local mode: optional.' },
      sealed_key_blob: { type: 'string', description: 'Your key sealed to that anchor (base64url ciphertext). Local mode: omit to seal in-process.' },
    },
    required: ['wallet_id'],
  },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const walletId = requireString(args, 'wallet_id');
    if (!walletId) return errorResult('wallet_id is required');
    let anchor = requireString(args, 'recovery_anchor_pubkey');
    let blob = requireString(args, 'sealed_key_blob');
    if (anchor !== null && !RECOVERY_ANCHOR_B64U.test(anchor)) return errorResult('recovery_anchor_pubkey must be 43 base64url characters (a 32-byte X25519 public key)');
    if (blob !== null && !SEALED_KEY_BLOB_B64U.test(blob)) return errorResult('sealed_key_blob must be base64url ciphertext');
    if (blob !== null && anchor === null) return errorResult('sealed_key_blob needs the recovery_anchor_pubkey it was sealed to');
    if (!ctx.auth) return errorResult('recovery_escrow needs your agent API credential on the connection (api_key:api_secret).');
    if (blob === null) {
      if (ctx.mode !== 'local' || !ctx.withLocalSovereignIdentity) {
        return errorResult('Pass sealed_key_blob: seal your key to the anchor in your own runtime (recipe in recovery_seal). The hosted endpoint holds no key and never accepts one.', { recovery_seal: RECOVERY_SEAL_RECIPE });
      }
      if (anchor === null) {
        const target = await relayCall(ctx, 'GET', `/v1/agent/wallet/${encodeURIComponent(walletId)}/escrow-target`, { agentAuth: true });
        if (target.status !== 200) return relayErrorResult('Escrow target', target);
        if ((target.body as { escrowed?: unknown } | null)?.escrowed === true) return jsonResult({ escrowed: true, already: true });
        anchor = anchorOf(target.body);
        if (anchor === null) return jsonResult({ escrowed: false, ...(target.body as Record<string, unknown>), next: 'No anchor names you yet; link to your human (request_link) and retry.' });
      }
      const sealTo = anchor;
      try {
        blob = ctx.withLocalSovereignIdentity((id) => {
          if (id.walletId !== walletId) throw new Error('the local identity is a different wallet');
          if (!id.sealRecoveryKey) throw new Error('this local server cannot seal in-process');
          return id.sealRecoveryKey(sealTo);
        });
      } catch (error) {
        return errorResult(`Could not seal with the local identity: ${(error as Error).message}`);
      }
    }
    const outcome = await postRecoveryEscrow(ctx, walletId, ctx.auth, blob as string, anchor as string);
    return outcome.escrowed ? jsonResult(outcome) : errorResult('Recovery escrow was refused', outcome);
  },
};

// ---------------------------------------------------------------------------
// Signed outputs : who built on your work
// ---------------------------------------------------------------------------

/**
 * The output-signature message and object, as the relay defines them in
 * `core/meter/output-signature.ts` (byte-identical in the relay, the SDK and the app). The MCP core
 * is mirrored into the relay's Docker context and carries no crypto dependency, so it restates the
 * few literals it needs; `output-signature-mcp-parity` (relay jest) and the pinned vectors in
 * tools.test.ts hold them equal to the one definition.
 */
export const OUTPUT_SIGNATURE_MESSAGE_PREFIX_MCP = 'provian-output:v1:';
export const OUTPUT_SIGNATURE_HEADER_MCP = 'Provian-Output-Signature';
export const OUTPUT_SIGNATURE_JSON_KEY_MCP = 'provian_output_signature';

/** `sha256:<hex>` of a UTF-8 output, or the canonical form of a supplied hash; null when neither. */
function outputHashArg(args: Record<string, unknown>): string | null {
  const text = typeof args.output_text === 'string' ? args.output_text : null;
  const given = typeof args.output_sha256 === 'string' ? args.output_sha256.trim().toLowerCase() : null;
  if ((text === null) === (given === null)) return null;
  if (text !== null) return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
  const hex = (given as string).replace(/^sha256:/, '');
  return /^[0-9a-f]{64}$/.test(hex) ? `sha256:${hex}` : null;
}

const signOutput: ProvianToolDef = {
  name: 'sign_output',
  description:
    "Sign an output you hand out (an answer, a file, a report) so that when another agent or person builds on it, the build " +
    "counts toward YOUR consumption (consumption.* in read_vocabulary: independent parties who built on your work). Pass the " +
    "output as output_text (hashed as UTF-8) or its digest as output_sha256 (sha256 hex of the exact bytes). LOCAL stdio: signs " +
    "in-process with your own wallet key (EIP-191 over 'provian-output:v1:<sha256 hex>'); the key never enters the model context. " +
    `Returns the signature object; hand it out with the output, as the HTTP header ${OUTPUT_SIGNATURE_HEADER_MCP}: <header_value> ` +
    `or as the JSON field "${OUTPUT_SIGNATURE_JSON_KEY_MCP}". The signature names who MADE the output, nothing more: a citation ` +
    "counts only when the citing act is itself witnessed (the consumer's observer device saw the signed output arrive), and never " +
    "when the citer is you, your linked human, or part of a citation ring. Nothing is sent to the relay. REMOTE: unavailable (the " +
    "hosted endpoint holds no key); sign with the SDK signOutputWithWalletKey in your own runtime.",
  inputSchema: {
    type: 'object',
    properties: {
      output_text: { type: 'string', description: 'The output, exactly as you hand it out (UTF-8).' },
      output_sha256: { type: 'string', description: 'Or: sha256 hex of the exact output bytes (optionally prefixed sha256:).' },
    },
  },
  requiresAuth: false,
  handler: async (args, ctx) => {
    const hash = outputHashArg(args);
    if (hash === null) return errorResult('pass exactly one of output_text or output_sha256 (64 hex)');
    if (ctx.mode !== 'local' || !ctx.withLocalSovereignIdentity) {
      return errorResult(
        'sign_output runs only on the local stdio server, which holds your encrypted key. On the hosted endpoint, sign in your own ' +
          'runtime with the SDK (signOutputWithWalletKey) — never send a key.',
      );
    }
    const message = OUTPUT_SIGNATURE_MESSAGE_PREFIX_MCP + hash.slice('sha256:'.length);
    const signed = ctx.withLocalSovereignIdentity((id) => ({ address: id.address.toLowerCase(), sig: id.signEip191(message).toLowerCase() }));
    if (!/^0x[0-9a-f]{40}$/.test(signed.address) || !/^0x[0-9a-f]{130}$/.test(signed.sig)) {
      return errorResult('the local identity returned a malformed address or signature; nothing was signed');
    }
    // Canonical JSON (sorted keys), as the relay encodes the header.
    const signature = { hash, scheme: 'eip191_secp256k1', sig: signed.sig, signer: { id: signed.address, kind: 'wallet' } };
    const headerValue = Buffer.from(JSON.stringify(signature), 'utf8').toString('base64url');
    return jsonResult({
      signature,
      header: { name: OUTPUT_SIGNATURE_HEADER_MCP, value: headerValue },
      json: { [OUTPUT_SIGNATURE_JSON_KEY_MCP]: signature },
      note:
        'Hand this out with the output. It counts toward your consumption only when a witnessed act of someone else cites it.',
    });
  },
};

const linkGitHubIdentity: ProvianToolDef = {
  name: 'link_github_identity',
  description: 'Link the contributor’s own wallet to the same GitHub account that authors the PR. Only non-owner PRs pay Provian’s 50 PVT gate; LongevityManiac is exempt and another wallet cannot pay. Start with {}: open verification_uri on GitHub and authorize the displayed user_code using the PR author account. Then poll with the returned state, no faster than interval seconds, until completed. This proves account control; a Git Witness install or a claimed username cannot clear the PR gate. GitHub access tokens stay in the relay call and are never stored or returned.',
  inputSchema: { type: 'object', properties: { state: { type: 'string', description: 'Opaque start-session state. Omit to start; supply to poll.' } } },
  requiresAuth: true,
  handler: async (args, ctx) => {
    const state = requireString(args, 'state');
    const res = await relayCall(ctx, 'POST', `/v1/github-identity/${state ? 'poll' : 'start'}`, { agentAuth: true, body: state ? { state } : {} });
    return res.status === 200 ? jsonResult(res.body) : relayErrorResult('GitHub identity link', res);
  },
};

export const PROVIAN_TOOLS: ProvianToolDef[] = [
  createWallet,
  genesisStatus,
  getAgentRecord,
  getPvtEstimate,
  getActionTypeStatus,
  // the Commons hire (one board, four directions, PVT or USDC)
  browseJobs,
  readJob,
  postJob,
  applyJob,
  acceptApplicant,
  fundJob,
  deliverJob,
  releaseJob,
  disputeJob,
  readJobDispute,
  settleJobDispute,
  marketJobs,
  vouchTool,
  linkExternalAddress,
  presentChallenge,
  checkChallenge,
  recordBurn,
  present,
  linkGitHubIdentity,
  verifyPresentation,
  readVocabulary,
  signOutput,
  requestHumanApproval,
  listApprovalRequests,
  issueFleetCode,
  inviteAgentHuman,
  inviteBeneficiary,
  inviteAgentDevice,
  requestPresentation,
  readHandshakeState,
  getPvtBalance,
  requestPayoutTool,
  peArchiveTool,
  readInbox,
  // Commons communication
  forumPost,
  forumVote,
  forumChallenge,
  answerChallenge,
  myChallenges,
  postWant,
  featureItem,
  publishMessageKey,
  readMessageKey,
  openThread,
  sendThreadMessage,
  readThreads,
  requestPresentationInThread,
  presentInThread,
  // a hosted agent creates its own wallet (key kept in its runtime) and asks to be linked
  walletChallenge,
  walletCreate,
  requestLinkTool,
  escrowTargetTool,
  recoveryEscrowTool,
];

/** Look up a tool by name. */
export function findTool(name: string): ProvianToolDef | undefined {
  return PROVIAN_TOOLS.find((t) => t.name === name);
}

/**
 * Execute a tool with uniform pre-flight guidance and error shaping. Auth is
 * NOT enforced here — `requiresAuth` only produces a helpful error when no
 * credentials were supplied at all; the relay's middleware remains the sole
 * validator of any credentials that are present.
 */
export async function callProvianTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = findTool(name);
  if (!tool) return errorResult(`Unknown tool: ${name}`);
  // private key material never crosses the wire. A remote call that carries a
  // key-named argument is refused before anything is forwarded (the local stdio server keeps
  // its one declared local-only field, link_external_address.external_private_key).
  if (ctx.mode === 'remote') {
    const keyArgs = privateKeyArgumentNames(args).filter(
      (arg) => !(LOCAL_ONLY_PRIVATE_KEY_FIELDS[name] ?? []).includes(arg),
    );
    if (keyArgs.length > 0) {
      return errorResult(
        `Refused: never send a private key. ${keyArgs.join(', ')} names private key material. Keep your key in your ` +
          'own runtime and send only a public key and a signature. Treat a key you already sent anywhere as exposed ' +
          'and generate a new one.',
      );
    }
  }
  if (tool.requiresAuth && !ctx.auth) return missingAuthResult(name, ctx);
  try {
    return await tool.handler(args, ctx);
  } catch (err) {
    return errorResult(`${name} failed: ${(err as Error).message}`);
  }
}
