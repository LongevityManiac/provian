/**
 * OpenAPI 3.0.3 Spec + MCP Descriptor
 *
 * Hand-crafted OpenAPI specification covering all Provian API endpoints.
 * Also serves the MCP (Model Context Protocol) descriptor.
 *
 * Mounts:
 *   GET /v1/openapi.json         - OpenAPI spec
 *   GET /v1/openapi.yaml         - 301 redirect to .json (no YAML dep)
 *   GET /.well-known/openapi.json - Alias
 *   GET /.well-known/mcp.json    - MCP descriptor
 */

import { AGENT_WALLET_REGISTRATION_CHANNELS } from '../core/agent-wallet/types';
import type { Express, Request, Response } from 'express';
import { PROVIAN_TOOLS } from '../mcp/core/tools';
import { isMcpAccessPermitted, type McpAccessEnv } from './mcp-access';
// defect 4: the x-pvt9-runtime block derives from the runtimes it
// describes. ARMED_ENV/ARMING_TOKEN are the settlement rail's own constants
// (importing them constructs nothing); isPeAnchorRuntimeConfigured is the pure
// env check from the sanctioned anchor-runtime module.
import { ARMED_ENV, ARMING_TOKEN } from '../core/pvt/wp4/operator-runtime';
import { isPeAnchorRuntimeConfigured } from '../core/pvt/pe-anchor-runtime';
import { ARCHIVE_OPENAPI_PATHS } from './archive-openapi';

const HEX64_SCHEMA = { type: 'string', pattern: '^[0-9a-f]{64}$' };

/** PE export — `POST /v1/meter/batch-proofs` (and its phone lane): the request. */
const BATCH_PROOFS_REQUEST_SCHEMA = {
  type: 'object',
  description: 'At least one of batch_hashes / acts_roots; at most 200 values in all.',
  properties: {
    batch_hashes: { type: 'array', minItems: 1, maxItems: 200, items: HEX64_SCHEMA, description: 'Batch hashes (lowercase hex); duplicates are ignored' },
    acts_roots: {
      type: 'array', minItems: 1, maxItems: 200, items: HEX64_SCHEMA,
      description: 'For a relay-authored PE handed over directly (no batch hash known): the acts_root of its one-act batch, i.e. the root of a one-leaf tree over the PE\'s act leaf. Only one-act batches of a relay device are answered.',
    },
  },
};

/** PE export — the anchoring record of each found batch (`core/meter/batch-proofs.ts`). */
const BATCH_PROOFS_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['batches', 'missing'],
  properties: {
    missing_acts_roots: { type: 'array', items: HEX64_SCHEMA, description: 'Asked acts_roots with no relay-authored one-act record (present only when acts_roots was asked)' },
    batches: {
      type: 'array',
      items: {
        type: 'object',
        required: ['batch_hash', 'device_id', 'actor_id', 'seq', 'acts_root', 'batch_leaf', 'day', 'accepted_at_ms', 'anchored', 'chain_id', 'anchor_contract', 'anchor', 'act_leaves'],
        properties: {
          batch_hash: HEX64_SCHEMA,
          device_id: { type: 'string', description: 'The submitting device (`relay:<actor>` for a relay-authored PE)' },
          actor_id: { type: 'string' },
          seq: { type: 'integer' },
          acts_root: HEX64_SCHEMA,
          batch_leaf: HEX64_SCHEMA,
          day: { type: 'string', description: 'UTC day the batch was accepted (YYYY-MM-DD); its anchor day' },
          accepted_at_ms: { type: 'integer' },
          anchored: { type: 'boolean' },
          chain_id: { type: 'integer', enum: [8453] },
          anchor_contract: { type: 'string', nullable: true, description: 'The deployed PEAnchor (null when unconfigured)' },
          anchor: {
            type: 'object',
            nullable: true,
            description: 'The batch leaf\'s proof in its day\'s on-chain root; null until anchored',
            properties: {
              day: { type: 'string' },
              anchor_batch_id: { type: 'string' },
              leaf_index: { type: 'integer' },
              leaf_count: { type: 'integer' },
              leaf_hash: { type: 'string', description: 'keccak256(0x00 ‖ batch_leaf), the on-chain leaf' },
              proof: { type: 'array', items: { type: 'string' } },
              merkle_root: { type: 'string' },
              anchor_tx_hash: { type: 'string', nullable: true },
              anchored_at_ms: { type: 'integer' },
            },
          },
          act_leaves: {
            type: 'array',
            nullable: true,
            items: HEX64_SCHEMA,
            description: 'Every act leaf of the batch in order (they recompute acts_root); null for a batch accepted before the relay kept them',
          },
        },
      },
    },
    missing: { type: 'array', items: HEX64_SCHEMA, description: 'Presented hashes with no batch record (never accepted, or expired after settlement, anchoring and delivery plus 30 days)' },
  },
};

/**
 * follow-up — the three Solana proof-of-control routes under `prefix`, for an agent
 * (agent API auth) or a person (wallet auth). One description for both owners (`routes/solana-address.ts`).
 */
function solanaProofPaths(
  prefix: '/v1/agent' | '/v1/wallet',
  owner: 'agent' | 'person',
  security: ReadonlyArray<Record<string, never[]>>,
): Record<string, unknown> {
  const subject = owner === 'agent' ? 'agent: <agent_id>' : 'person: <user_id>';
  const authError = owner === 'agent' ? 'Agent authentication required' : 'Wallet authentication required';
  return {
    [`${prefix}/solana-address/challenge`]: {
      post: {
        tags: ['Wallet'],
        summary: `${owner === 'agent' ? 'Agent' : 'Person'}: issue a one-time ed25519 proof challenge for a Solana address`,
        description:
          'Step 1 of proving a Solana address (the Provian wallet\'s own Solana address, or one already held). ' +
          'Returns the exact message to sign, lines joined with "\\n", no trailing newline: ' +
          `"Provian Solana proof of control" / "${subject}" / "address: <base58>" / "nonce: <32 hex>" / ` +
          '"issued: <ISO-8601>" / "expires: <ISO-8601>". Single use, 10-minute TTL, bound to the caller and ' +
          'the address. Refused with 409 address_bound_to_other_owner (proven by anyone else) or ' +
          'address_is_provian_service_wallet.',
        security,
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['address'], properties: { address: { type: 'string', description: 'Canonical base58 Solana address (32-byte ed25519 key).' } } } } },
        },
        responses: {
          '200': { description: 'Challenge issued: { challenge_id, message, nonce, issued_at, expires_at, address, chain: "solana", network }. Sign the raw UTF-8 bytes with ed25519 (Solana signMessage), off-chain.' },
          '400': { description: 'address must be a canonical base58 Solana address' },
          '401': { description: authError },
          '409': { description: 'address_bound_to_other_owner | address_is_provian_service_wallet' },
          '503': { description: 'Challenge store unavailable' },
        },
      },
    },
    [`${prefix}/solana-address/verify`]: {
      post: {
        tags: ['Wallet'],
        summary: `${owner === 'agent' ? 'Agent' : 'Person'}: verify the ed25519 signature; the Solana address becomes provably yours`,
        description:
          'Step 2. Submit the base58 ed25519 signature over the exact challenge message. Verify IS the binding ' +
          '(solana_proven_addresses; one address, one owner). The relay reads the current Solana slot as ' +
          'proven_at_slot: only transactions in a strictly later slot count (an x402 facilitator settlement then ' +
          'seals the payer\'s x402_payment / the payee\'s receive on the owner\'s chain). Proving pays nothing: a ' +
          'record-only external_address_proven receipt. origin (native | external, default external) is display only.',
        security,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['address', 'challenge_id', 'signature'],
                properties: {
                  address: { type: 'string' },
                  challenge_id: { type: 'string' },
                  signature: { type: 'string', description: 'base58 ed25519 signature (64 bytes) over the challenge message.' },
                  origin: { type: 'string', enum: ['native', 'external'] },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: `Proven: { ok, proven_address, proven_at, proven_at_slot, origin, proof_method: "ed25519", already_proven, pe_id, pe_hash${owner === 'person' ? ', owner: "person"' : ''} }.` },
          '400': { description: 'Validation error, unknown/expired challenge, or challenge bound to another caller/address' },
          '401': { description: `${authError} | signature_invalid (the challenge is not consumed)` },
          '409': { description: 'address_bound_to_other_owner | address_is_provian_service_wallet' },
          '503': { description: 'head_slot_unavailable | challenge store or PE emission unavailable (re-prove is idempotent)' },
        },
      },
    },
    [`${prefix}/solana-addresses`]: {
      get: {
        tags: ['Wallet'],
        summary: `${owner === 'agent' ? 'Agent' : 'Person'}: list the Solana addresses you have proven`,
        security,
        responses: {
          '200': { description: '{ addresses: [{ address, proven_at, proven_at_slot, origin, proof_method, chain, network }] }' },
          '401': { description: authError },
        },
      },
    },
  };
}

export function buildOpenAPISpec(): Record<string, unknown> {
  const baseUrl = process.env.API_BASE_URL || 'https://api.provian.ai';

  const spec: Record<string, unknown> = {
    openapi: '3.0.3',
    info: {
      title: 'Provian Agent API',
      version: '1.0.0',
      description: 'The trust layer for the intelligence economy. Valid Provenance Envelopes are contributor-owned proof; every act of work mints PVT once at its best-supported value. Evidence, novelty, duplication checks, and jurisdiction determine the exact price and settlement state. The PVT kernel is live on Base: standard earnings settle on a schedule Provian sets, currently every 30 days for free, Genesis grants daily, and any payee can settle its own earnings now for a $1 USDC service fee (POST /v1/payout); the relay keeps no PEs (they live with their owners, priced from each device\'s daily batch, POST /v1/meter/batch); daily PE anchoring and on-chain inclusion proofs are live where the anchor runtime is configured (see x-pvt9-runtime); economic governance is a dormant future lane.',
      contact: { url: 'https://provian.ai' },
    },
    servers: [{ url: baseUrl, description: 'Production' }],
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'API key authentication. Format: Bearer {api_key}:{api_secret}',
        },
        WalletAuth: {
          type: 'http',
          scheme: 'bearer',
          description:
            'Human wallet authentication (the Provian app). Format: Bearer {payloadB64}.{signatureHex} — ' +
            'a v2 request-bound token (method + path + body hash, ~90s expiry, single-use jti).',
        },
      },
      schemas: {
        AIConversationMetadata: {
          type: 'object',
          description:
            'Metadata shape for action_type="ai_conversation" PEs emitted by ' +
            'the desktop foreground capture plugin (LLMSessionPlugin) and ' +
            'the forthcoming mobile capture surfaces. Describes an observed ' +
            'human AI engagement session. Never contains conversation text, ' +
            'URLs, or keystrokes. Complementary to inference_session: both ' +
            'can fire for the same wall-clock window and are not ' +
            'substitutable for each other.',
          required: [
            'provider',
            'surface',
            'duration_ms',
            'active_duration_ms',
            'turn_count',
            'char_count',
            'image_count',
            'video_seconds',
            'session_fingerprint_hash',
            'input_fidelity',
          ],
          properties: {
            provider: {
              type: 'string',
              enum: ['claude', 'chatgpt', 'gemini', 'perplexity', 'grok', 'venice'],
              description: 'AI provider whose surface was captured.',
            },
            surface: {
              type: 'string',
              enum: ['desktop_foreground', 'mobile_wrapper'],
              description:
                'Capture surface that produced this PE. desktop_foreground = ' +
                'LLMSessionPlugin on macOS (Phase 2b). mobile_wrapper = iOS/' +
                'Android in-app WebView capture (Phase 2c). ' +
                'mobile_usage_stats (Android out-of-app capture) is not live: ' +
                'the phone\'s batch (POST /v1/meter/batch/mobile) refuses it, and no PE ' +
                'carrying it mints on any route.',
            },
            duration_ms: {
              type: 'integer',
              minimum: 0,
              description: 'Wall-clock window length in milliseconds.',
            },
            active_duration_ms: {
              type: 'integer',
              minimum: 0,
              description:
                'Subset of duration_ms during which interaction was observed. ' +
                'When input_fidelity="presence_only" this equals duration_ms ' +
                'by construction.',
            },
            turn_count: {
              type: 'integer',
              minimum: 0,
              description:
                'Approximate number of conversational turns, clustered from ' +
                'input-event timing. Zero when input_fidelity="presence_only".',
            },
            char_count: {
              type: 'integer',
              minimum: 0,
              description:
                'Zero on desktop_foreground (plugin has no DOM visibility). ' +
                'Real values from MutationObserver on mobile_wrapper, rounded ' +
                'to nearest 100 for fingerprinting-risk reduction.',
            },
            image_count: {
              type: 'integer',
              minimum: 0,
              description:
                'Zero on desktop_foreground. Real ' +
                'values from MutationObserver on mobile_wrapper.',
            },
            video_seconds: {
              type: 'integer',
              minimum: 0,
              description:
                'Zero on desktop_foreground. Real ' +
                'values from MutationObserver on mobile_wrapper. Integer ' +
                'seconds.',
            },
            session_fingerprint_hash: {
              type: 'string',
              pattern: '^[0-9a-f]{64}$',
              description:
                'SHA-256 over length-prefixed UTF-8 fields (provider, ' +
                'session_start_ms, duration_ms, turn_count, plugin_name). ' +
                'Relay-side dedup keys on this value. See the Provian Manual.',
            },
            input_fidelity: {
              type: 'string',
              enum: ['full', 'presence_only'],
              description:
                'full: capture surface observed real input events. ' +
                'presence_only: permission was denied or the surface cannot ' +
                'observe input; turn_count is 0 and active_duration_ms ' +
                'equals duration_ms. Governance may calibrate weights ' +
                'against this field in a future pass.',
            },
          },
        },
        WebhookPayload: {
          type: 'object',
          description:
            'Payload dispatched to subscribed webhook endpoints and legacy ' +
            'per-wallet callback URLs when an Commons institutions event fires. ' +
            '`amount_unit` discriminates PVT-principal flows from USDC flows; ' +
            'consumers written before the discriminator shipped see ' +
            '`transaction_amount_usd` unchanged and may treat `amount_unit` ' +
            'as always `usdc_whole`.',
          required: ['event', 'wallet_id', 'amount_unit'],
          properties: {
            event: {
              type: 'string',
              description: 'WebhookEventType string, e.g. escrow_funded.',
            },
            wallet_id: {
              type: 'string',
              description: 'Agent wallet id that the event applies to.',
            },
            transaction_amount_usd: {
              type: 'number',
              description:
                'Historical field retained for backward compatibility. When ' +
                'amount_unit is pvt_whole, this carries the whole-PVT value ' +
                '(not USD). Read amount_unit to disambiguate.',
            },
            amount: {
              type: 'number',
              description:
                'Same value as transaction_amount_usd, named neutrally so ' +
                'new consumers do not have to parse a USD-ambiguous field.',
            },
            amount_unit: {
              type: 'string',
              enum: ['usdc_whole', 'pvt_whole'],
              description:
                'Unit for `amount`. `usdc_whole` (default): value is whole ' +
                'USD. `pvt_whole`: value is whole PVT (atomic / 1e18). ' +
                'Atomic-precision PVT is not webhook-safe; read the ' +
                'primitive document directly if you need wei-exact values.',
            },
            timestamp: {
              type: 'integer',
              description: 'Unix ms at dispatch time (legacy callback only).',
            },
          },
        },
      },
    },
    security: [{ ApiKeyAuth: [] }],
    paths: {
      // --- Wallet ---
      '/v1/agent/wallet/challenge': {
        get: {
          tags: ['Wallet'],
          summary: 'Issue proof-of-possession challenge',
          description: 'Step 1 of retry-safe agent wallet creation. Before this request, the caller must durably retain one registration_id, agent_id, and secp256k1 key. The relay returns a single-use challenge bound to that identity and its current credential-recovery generation.',
          security: [],
          parameters: [
            {
              name: 'public_key',
              in: 'query',
              required: true,
              schema: { type: 'string' },
              description: '64-byte uncompressed secp256k1 hex (no 04 prefix)',
            },
            {
              name: 'registration_id',
              in: 'query',
              required: true,
              schema: { type: 'string' },
              description: 'Stable caller-owned registration ID persisted before networking',
            },
            {
              name: 'agent_id',
              in: 'query',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': { description: 'Challenge issued: { challenge_id, challenge, expires_at, registration_exists } — registration_exists says whether this registration_id is already on record (resume it as sent) or not (an unsent pending registration may be rebound)' },
            '400': { description: 'Invalid public_key format' },
            '429': { description: 'Rate limited' },
            '503': { description: 'Challenge service unavailable' },
          },
        },
      },
      '/v1/agent/wallet/create': {
        post: {
          tags: ['Wallet'],
          summary: 'Create agent wallet (proof-of-possession)',
          description: 'Step 2 of retry-safe agent wallet creation. A committed registration may be resumed with a fresh challenge signed by the same durable key; the relay returns the same wallet identity and transactionally reissues API credentials without repeating economic or watcher side effects. The relay never sees the private key.',
          security: [],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['registration_id', 'agent_name', 'agent_id', 'platform', 'constitution_accepted_at', 'public_key', 'challenge_id', 'signature'],
                  properties: {
                    registration_id: { type: 'string', description: 'Stable 16-128 character caller-owned registration ID' },
                    registration_channel: {
                      type: 'string',
                      enum: AGENT_WALLET_REGISTRATION_CHANNELS,
                      description: 'Optional client-reported onboarding channel. Saved at creation as unknown when omitted. Retries preserve the original channel.',
                    },
                    agent_name: { type: 'string' },
                    agent_id: { type: 'string' },
                    platform: { type: 'string' },
                    constitution_accepted: {
                      type: 'boolean',
                      description: 'Optional. Set true to record that the agent accepts the Network Constitution. Acceptance is not required to create a wallet.',
                    },
                    constitution_version: {
                      type: 'string',
                      description: 'Optional. Network Constitution version recorded with the registration. When omitted, a registration_id already on record keeps the version it was created with; a new registration records the current Network Constitution version.',
                    },
                    constitution_accepted_at: {
                      type: 'string',
                      description: 'Caller-pinned ISO timestamp durably retained with the registration identity before the first request',
                      format: 'date-time',
                    },
                    chains: { type: 'array', items: { type: 'string' } },
                    governance: { type: 'object', description: 'Optional self-declared flags stored as sent. Nothing reads them to gate, limit, or approve an agent action (Provian does not govern agents).' },
                    public_key: { type: 'string', description: '64-byte uncompressed secp256k1 hex (no 04 prefix)' },
                    challenge_id: { type: 'string', description: 'From GET /challenge' },
                    signature: { type: 'string', description: 'Hex-encoded ECDSA signature over the challenge bytes' },
                  },
                },
              },
            },
          },
          responses: {
            '201': { description: 'Wallet created. Response: { wallet_id, address, public_key, api_key, api_secret, ... }. Private key is NOT returned - it never leaves the agent.' },
            '400': { description: 'Validation error or PoP verification failed' },
            '409': { description: 'identity mismatch, stale concurrent recovery challenge, agent_id already in use, or address collision' },
            '429': { description: 'Rate limited' },
          },
        },
      },
      '/v1/agent/wallet/{wallet_id}': {
        get: {
          tags: ['Wallet'],
          summary: 'Get wallet info',
          parameters: [{ name: 'wallet_id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Wallet details' } },
        },
      },
      '/v1/agent/wallet/{wallet_id}/transfer/record': {
        post: {
          tags: ['Wallet'],
          summary: 'Record a VERIFIED Provenance Envelope for a raw transfer the agent broadcast itself',
          description:
            'After the agent signs and broadcasts its OWN on-chain transfer (native ETH or an ' +
            'ERC-20: USDC/USDT/PVT) from its sovereign EOA, POST the tx_hash here. The relay ' +
            're-verifies the transfer ON-CHAIN before recording the PE: for ERC-20 it asserts ' +
            'from + to + amount against the token Transfer log; for native it asserts from + to + ' +
            'value via eth_getTransactionByHash. Only the authenticated wallet may record for its ' +
            'own wallet_id. Idempotent by tx_hash (a replay returns the original pe_id, never a ' +
            'second PE). The chain is the witness; an agent\'s own claim about a transfer is never a ' +
            'PE. Auth: API key (Bearer api_key:api_secret).',
          parameters: [{ name: 'wallet_id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['tx_hash', 'chain', 'currency', 'to', 'amount_atomic'],
                  properties: {
                    tx_hash: { type: 'string', description: '0x + 64 hex chars' },
                    chain: { type: 'string', enum: ['base', 'arbitrum', 'optimism'] },
                    currency: { type: 'string', enum: ['usdc', 'usdt', 'pvt', 'native'] },
                    to: { type: 'string', description: 'recipient address (0x + 40 hex)' },
                    amount_atomic: {
                      type: 'string',
                      description: 'atomic units as an integer string (token atomic for ERC-20; wei for native)',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description:
                'PE recorded: { pe_id, tx_hash, verified, idempotent? }. verified=true means from+to+amount were confirmed on-chain.',
            },
            '400': { description: 'On-chain verification failed (reason returned) or malformed body' },
            '401': { description: 'Invalid authentication' },
            '403': { description: 'wallet_id mismatch (not the authenticated wallet)' },
          },
        },
      },
      '/v1/agent/wallet/{wallet_id}/burn/record': {
        post: {
          tags: ['Wallet'],
          summary: 'Record a VERIFIED PVT burn the agent broadcast itself',
          description:
            'After the agent burns its OWN PVT on-chain (a Transfer to the zero address from its ' +
            'sovereign EOA), POST the tx_hash here. The relay re-verifies the burn ON-CHAIN before ' +
            'recording it: it asserts from + zero-address destination + exact amount against the ' +
            'PVT token Transfer log, so a self-send can never pass as a burn. Records a verified row ' +
            'in pvt_burn_records (mints 0 PVT). Only the authenticated wallet may record for its own ' +
            'wallet_id. Idempotent by (chain, burn tx_hash) — a replay returns the original burn_id. ' +
            'The demand-side substrate that PVT burn products bind their resource claim to via ' +
            'burn_id. The relay accepts a burn once it is MINED in one Base block: both independent ' +
            'RPC providers must agree on the receipt and its canonical block; a pending or replaced tx ' +
            'is never accepted. The accepted burn is recorded finality "provisional"; with ' +
            'await_finality:true (name kept for compatibility) the relay holds the call until the burn ' +
            'is mined and accepted (at most 90 s, typically about one Base block) instead of refusing ' +
            'an early record — send it right after broadcasting. The relay then runs the ' +
            '12-block finality check on every accepted burn; a burn whose receipt reverted or carries no ' +
            'matching burn log, or that is proven dropped by a reorg (its block replaced at safe depth, ' +
            'the tx neither re-included nor pending), is REVOKED together with every relay-held benefit ' +
            'it backs, and can never be recorded again. An RPC outage never revokes a burn: one not ' +
            'provably final within 30 minutes is marked stalled, keeps its benefits, and is re-checked ' +
            'until it finalizes. ' +
            'Auth: API key (Bearer api_key:api_secret).',
          parameters: [{ name: 'wallet_id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['tx_hash', 'chain', 'amount_atomic'],
                  properties: {
                    tx_hash: { type: 'string', description: '0x + 64 hex chars' },
                    chain: { type: 'string', enum: ['base', 'arbitrum', 'optimism'] },
                    amount_atomic: {
                      type: 'string',
                      description: 'PVT burned, atomic 18-decimal units as a positive integer string',
                    },
                    await_finality: {
                      type: 'boolean',
                      description: 'Hold the call until the burn is mined and accepted (~one Base block; it no longer waits for 12-block finality — the name is kept for compatibility) instead of refusing an early record. Default false.',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description:
                'Burn recorded: { burn_id, tx_hash, verified, idempotent?, finality }. verified=true means from+zero-dest+amount were confirmed on-chain in a mined block; finality is "provisional" (accepted at inclusion, 12-block finality check pending) or "final".',
            },
            '400': { description: 'On-chain burn verification failed (reason returned: tx_failed = the burn reverted; tx_not_found / insufficient_confirmations = not mined and accepted yet) or malformed body' },
            '409': { description: 'A record of this burn is already in progress, another wallet recorded it, or the burn failed Base finality and was revoked (reason burn_revoked; terminal)' },
            '401': { description: 'Invalid authentication' },
            '403': { description: 'wallet_id mismatch (not the authenticated wallet)' },
          },
        },
      },
      '/v1/agent/wallet/{wallet_id}/invite': {
        post: { tags: ['Wallet'], summary: 'Invite a human to Provian', security: [{ ApiKeyAuth: [] }],
          parameters: [{ name: 'wallet_id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['email'], properties: {
            email: { type: 'string' }, message: { type: 'string' },
            language: { type: 'string', description: 'Recipient email locale: en/es/fr/hi/id/ja/ko/pt/sw/tl/vi/zh; absent or unsupported defaults to English.' },
          } } } } }, responses: { '201': { description: 'Invitation recorded; email delivery is asynchronous and unsubscribe-guarded.' }, '401': { description: 'Agent authentication required' }, '403': { description: 'Wallet ownership mismatch' }, '429': { description: 'Rate limited' } } },
      },
      '/v1/agent/wallet/{wallet_id}/invite-human': {
        post: { tags: ['Wallet'], summary: 'Invite a human beneficiary', security: [{ ApiKeyAuth: [] }],
          parameters: [{ name: 'wallet_id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['human_email'], properties: {
            human_email: { type: 'string' }, message: { type: 'string' },
            language: { type: 'string', description: 'Recipient email locale: en/es/fr/hi/id/ja/ko/pt/sw/tl/vi/zh; absent or unsupported defaults to English.' },
          } } } } }, responses: { '201': { description: 'Invitation recorded; email delivery is asynchronous and unsubscribe-guarded.' }, '401': { description: 'Agent authentication required' }, '403': { description: 'Wallet ownership mismatch' }, '429': { description: 'Rate limited' } } },
      },
      '/v1/agent/wallet/{wallet_id}/device-invite': {
        post: {
          tags: ['Wallet'],
          summary: 'Email a ready-to-run register-device command for an agent-owned device',
          description:
            'Stand up a device whose Provenance Envelopes attribute to this agent wallet, in one ' +
            'emailed line, WITHOUT pasting the agent API key/secret. The relay mints a one-time ' +
            'token (1-hour TTL, single-use) and emails the recipient a one-line registration ' +
            'command — an HTTPS call to POST /v1/devices/register carrying the one-time token. ' +
            'Running it on the ' +
            'target machine registers the device with owner_type=agent so future observer/git/OTel ' +
            'PEs from that machine become contributor-owned proof on the agent chain. ' +
            'Every act of work mints PVT once at its best-supported value (the agent-owned device_register setup PE ' +
            'itself is record_only). The token authorizes device registration ONLY and is never ' +
            'returned in the response. Ownership-guarded: only the authenticated wallet may invite ' +
            'for its own wallet_id. Auth: API key (Bearer api_key:api_secret).',
          security: [{ ApiKeyAuth: [] }],
          parameters: [{ name: 'wallet_id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email'],
                  properties: {
                    email: { type: 'string', description: 'Recipient email (max 254 chars). The setup command is sent here; the token is never returned in the response.' },
                    language: { type: 'string', description: 'Recipient email locale: en/es/fr/hi/id/ja/ko/pt/sw/tl/vi/zh; absent or unsupported defaults to English.' },
                    device_name: { type: 'string', description: 'Optional friendly name hint for the device.' },
                    message: { type: 'string', description: 'Optional personal note rendered in the email body.' },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Email sent: { sent: true, expires_at }. The token is delivered only by email.' },
            '400': { description: 'Invalid email' },
            '401': { description: 'Invalid authentication' },
            '403': { description: 'wallet_id mismatch (not the authenticated wallet)' },
            '429': { description: 'Rate limited (per-wallet 5/hour, per-email 5/day, or active-token cap)' },
            '503': { description: 'Email unavailable or rate-limit backend unavailable' },
          },
        },
      },
      // --- External Address Linking (earn from a wallet you already run) ---
      '/v1/agent/external-address/challenge': {
        post: {
          tags: ['Wallet'],
          summary: 'Issue a one-time proof challenge to link an external wallet you already run',
          description:
            'Step 1 of linking an external EVM address. Prove control of an address you already ' +
            'use, and its go-forward on-chain USDC financial activity on Base creates Financial ' +
            'PEs on the standard path while Provian operates the protocol; go-forward activity mints PVT once at its best-supported value ' +
            'subject to caps and protocol policy - no new wallet, no custody move. ' +
            'Returns an EIP-4361-style message bound to (your agent_id, address), single-use, ' +
            '10-minute TTL. agent_id is taken from your authenticated wallet, never the body - you ' +
            'can only bind an address to yourself. Auth: API key (Bearer api_key:api_secret).',
          security: [{ ApiKeyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['address'],
                  properties: {
                    address: { type: 'string', description: 'External EVM address to link (0x + 40 hex).' },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Challenge issued: { challenge_id, message, nonce, issued_at, expires_at, chain: "base", chain_id: 8453 }. Sign message OFF-CHAIN (no gas).' },
            '400': { description: 'address must be a valid EVM address' },
            '401': { description: 'Agent authentication required' },
            '503': { description: 'Challenge store unavailable' },
          },
        },
      },
      '/v1/agent/external-address/verify': {
        post: {
          tags: ['Wallet'],
          summary: 'Verify the signature and link the external wallet (the binding step)',
          description:
            'Step 2 of linking an external EVM address. Submit the signature over the challenge ' +
            'message: EIP-191 personal_sign for an EOA, or EIP-1271 isValidSignature for a ' +
            'smart-contract wallet. Verify IS the link: it records the (agent, address) binding and ' +
            'emits a 0-PVT proof PE. Once proven, on-chain USDC financial activity on Base from the ' +
            'linked address - receive (inbound) and send / swap / x402_payment (outbound) - creates ' +
            'Financial PEs on the standard path (the chain is the witness; no device attestation ' +
            'is needed). Go-forward activity mints PVT once at its best-supported value at the applicable chain-witness ' +
            'weight subject to standing anti-farm rules and protocol policy (dust floor, ' +
            'verified-counterparty requirement, per-actor daily count caps per action type — never a per-user ' +
            'volume ceiling). ' +
            'One address -> one agent (re-binding to a different agent returns 409). Base-only. ' +
            'No-retro fence: configured operators agree on head H, proof state is read at finalized ' +
            'block H-11, and proven_at_block is the eligibility fence H+1; prior and same-head history ' +
            'earns 0 PVT and only sets a read-only reputation tier. Auth: API key (Bearer api_key:api_secret).',
          security: [{ ApiKeyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['address', 'challenge_id', 'signature'],
                  properties: {
                    address: { type: 'string', description: 'External EVM address being linked (must match the challenge).' },
                    challenge_id: { type: 'string', description: 'From POST /challenge.' },
                    signature: { type: 'string', description: 'Off-chain signature over the challenge message (EIP-191 EOA or EIP-1271 contract wallet).' },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Linked: { ok, proven_address, proven_at, proven_at_block, proof_method, pe_id, initial_reputation_tier }.' },
            '400': { description: 'Validation error or signature verification failed' },
            '401': { description: 'Agent authentication required' },
            '409': { description: 'address already bound to a different agent' },
            '503': { description: 'Transient store/PE-emission failure (re-prove is idempotent)' },
          },
        },
      },
      // the linked HUMAN links a third-party wallet to their agent (Agent Hub).
      '/v1/agent/wallet/{wallet_id}/external-address/challenge': {
        post: {
          tags: ['Wallet'],
          summary: 'Linked human: issue a proof challenge to link a third-party wallet to their agent',
          description:
            'The human the agent is linked to starts linking an external EVM address (MetaMask, Coinbase ' +
            'Wallet, a Safe, ...) to that agent. The challenge is bound to the AGENT\'s agent_id and the ' +
            'address, exactly as the agent-side POST /v1/agent/external-address/challenge. Refused with 409 ' +
            'address_is_your_provian_wallet (the caller\'s own Provian wallet) or address_is_agent_native_wallet ' +
            '(the agent\'s own wallet). Only the linked human (agent_wallets.linked_human_user_id === caller) ' +
            'of an active agent; anyone else gets 403 not_your_linked_agent. Auth: human wallet auth.',
          security: [{ WalletAuth: [] }],
          parameters: [{ name: 'wallet_id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['address'],
                  properties: { address: { type: 'string', description: 'Third-party EVM address (0x + 40 hex).' } },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Challenge issued: { challenge_id, message, nonce, issued_at, expires_at, address, wallet_id, chain: "base", chain_id: 8453 }. The address holder signs message OFF-CHAIN (no gas).' },
            '400': { description: 'address must be a valid EVM address' },
            '401': { description: 'Wallet authentication required' },
            '403': { description: 'not_your_linked_agent' },
            '409': { description: 'agent_not_active | address_is_your_provian_wallet | address_is_agent_native_wallet' },
            '429': { description: 'Per-human transport limit' },
            '503': { description: 'Challenge store or rate-limit backend unavailable' },
          },
        },
      },
      '/v1/agent/wallet/{wallet_id}/external-address/verify': {
        post: {
          tags: ['Wallet'],
          summary: 'Linked human: verify the third-party wallet\'s signature and link it to their agent',
          description:
            'Submit the address holder\'s signature over the exact challenge message (EIP-191 personal_sign ' +
            'for an EOA, EIP-1271 for a contract wallet). Runs the same proof as the agent-side verify: ' +
            'one address -> one agent, the operator-agreed H / H-11 / H+1 no-retro fence, a record-only ' +
            'external_address_proven PE on the agent\'s chain. Once linked, the address\'s go-forward on-chain ' +
            'financial activity on Base is chain-witnessed work of the agent. Auth: human wallet auth.',
          security: [{ WalletAuth: [] }],
          parameters: [{ name: 'wallet_id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['address', 'challenge_id', 'signature'],
                  properties: {
                    address: { type: 'string' },
                    challenge_id: { type: 'string' },
                    signature: { type: 'string', description: 'Signature by the third-party wallet over the challenge message.' },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Linked: { ok, proven_address, proven_at, proven_at_block, proof_method, pe_id, wallet_id, initiated_by: "linked_human" }.' },
            '400': { description: 'Validation error or signature verification failed' },
            '401': { description: 'Wallet authentication required' },
            '403': { description: 'not_your_linked_agent' },
            '409': { description: 'address_bound_to_other_agent | agent_not_active | address_is_your_provian_wallet | address_is_agent_native_wallet' },
            '429': { description: 'Per-human transport limit' },
            '503': { description: 'Transient store/PE-emission failure (re-prove is idempotent)' },
          },
        },
      },
      '/v1/agent/wallet/{wallet_id}/external-addresses': {
        get: {
          tags: ['Wallet'],
          summary: 'Linked human: list the external wallets linked to their agent',
          security: [{ WalletAuth: [] }],
          parameters: [{ name: 'wallet_id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: '{ wallet_id, addresses: [{ address, proven_at, proven_at_block, proof_method, chain }] }' },
            '401': { description: 'Wallet authentication required' },
            '403': { description: 'not_your_linked_agent' },
          },
        },
      },

      // 2026-10-01 : a PERSON proves a wallet they already hold.
      '/v1/wallet/external-address/challenge': {
        post: {
          tags: ['Wallet'],
          summary: 'Person: issue a proof challenge for a wallet you already hold',
          description:
            'A person proves control of an outside EVM wallet (MetaMask, Coinbase Wallet, a Safe, ...). The ' +
            'challenge is bound to the person (person:<user_id>) and the address. Refused with 409 ' +
            'address_is_provian_wallet (any Provian wallet address) or address_bound_to_other_owner (an address ' +
            'an agent or another person already proved). Auth: human wallet auth; agent credentials are refused.',
          security: [{ WalletAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['address'],
                  properties: { address: { type: 'string', description: 'The outside EVM address (0x + 40 hex).' } },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Challenge issued: { challenge_id, message, nonce, issued_at, expires_at, address, chain: "base", chain_id: 8453 }. The wallet signs message OFF-CHAIN (no gas).' },
            '400': { description: 'address must be a valid EVM address' },
            '401': { description: 'Wallet authentication required' },
            '403': { description: 'human_wallet_not_active' },
            '404': { description: 'no_human_wallet' },
            '409': { description: 'address_is_provian_wallet | address_bound_to_other_owner | human_wallet_ambiguous' },
            '429': { description: 'Per-person transport limit' },
            '503': { description: 'Challenge store or rate-limit backend unavailable' },
          },
        },
      },
      '/v1/wallet/external-address/verify': {
        post: {
          tags: ['Wallet'],
          summary: 'Person: verify the wallet\'s signature; the wallet becomes provably yours',
          description:
            'Submit the wallet\'s signature over the exact challenge message (EIP-191 personal_sign for an EOA, ' +
            'EIP-1271 for a contract wallet). The same proof as an agent\'s: the operator-agreed H / H-11 / H+1 ' +
            'no-retro fence and one address, one owner. Proving pays nothing (a record-only external_address_proven ' +
            'receipt on the person\'s own chain). From the H+1 fence forward the address\'s Base sends, swaps and ' +
            'receives from counterparties the person has dealt with mint as the person\'s own, on the same terms as ' +
            'their Provian wallet; transfers between it and the person\'s Provian wallet or linked agents are ' +
            'same-owner and mint nothing. Auth: human wallet auth.',
          security: [{ WalletAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['address', 'challenge_id', 'signature'],
                  properties: {
                    address: { type: 'string' },
                    challenge_id: { type: 'string' },
                    signature: { type: 'string', description: 'Signature by the outside wallet over the challenge message.' },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Proven: { ok, proven_address, proven_at, proven_at_block, proof_method, already_proven, pe_id, owner: "person" }.' },
            '400': { description: 'Validation error or signature verification failed' },
            '401': { description: 'Wallet authentication required' },
            '409': { description: 'address_is_provian_wallet | address_bound_to_other_owner | human_wallet_ambiguous' },
            '429': { description: 'Per-person transport limit' },
            '503': { description: 'Transient store/PE-emission failure (re-prove is idempotent)' },
          },
        },
      },
      '/v1/wallet/external-addresses': {
        get: {
          tags: ['Wallet'],
          summary: 'Person: list the outside wallets you have proven',
          security: [{ WalletAuth: [] }],
          responses: {
            '200': { description: '{ addresses: [{ address, proven_at, proven_at_block, proof_method, chain }] }' },
            '401': { description: 'Wallet authentication required' },
          },
        },
      },

      // follow-up: prove a SOLANA address (ed25519) — agent and person.
      ...solanaProofPaths('/v1/agent', 'agent', [{ ApiKeyAuth: [] }]),
      ...solanaProofPaths('/v1/wallet', 'person', [{ WalletAuth: [] }]),

      // --- PE meter (the relay keeps no PEs; ) ---
      '/v1/meter/batch': {
        post: {
          tags: ['Provenance'],
          summary: 'Send a device\'s signed batch of acts (the way a device\'s PEs are priced)',
          description:
            'Each PE lives with its owner; the relay keeps no PE. A registered device sends one signed, '
            + 'hash-chained batch a day (seq + prev_batch_hash), plus one right before any presentation '
            + 'or on-demand payout, so those reflect its latest acts. Each act is its identity, its pe_hash '
            + '(over the complete PE) and its pricing inputs, never the PE\'s free text; 1–500 acts per batch. '
            + 'The relay verifies and prices one batch at a time, keeping totals, packed occurrence membership, '
            + 'small output trust rows and the daily anchor on Base. An act that arrives more than 30 '
            + 'days after it happened is counted but does not mint (Genesis grants are exempt). Device auth; '
            + 'the body must be bound (DeviceSignature or X-Provian-Body-HMAC). The single-PE recorders '
            + '(/v1/pe/submit, /v1/pe/submit/mobile, /v1/relay/action, /v1/relay/work-product) answer 410 '
            + '`pe_recorder_retired`.',
          responses: {
            '200': { description: 'Batch already accepted (idempotent replay of the same batch)' },
            '201': { description: 'Batch accepted; each act priced' },
            '401': { description: 'Device authentication required, or the body binding failed' },
            '429': { description: 'Rate limited' },
          },
        },
      },
      '/v1/meter/batch/mobile': {
        post: {
          tags: ['Provenance'],
          summary: 'Send the phone\'s signed batch of acts (wallet auth)',
          description:
            'The phone\'s lane of POST /v1/meter/batch, under wallet auth: the same wire format, the same '
            + 'daily cadence plus one before a presentation or payout, and the same pricing. The phone keeps '
            + 'every PE it holds and backs them up encrypted to the person\'s own cloud.',
          responses: {
            '200': { description: 'Batch already accepted' },
            '201': { description: 'Batch accepted; each act priced' },
            '401': { description: 'Wallet authentication required' },
          },
        },
      },
      '/v1/meter/proofs': {
        get: {
          tags: ['Provenance'],
          summary: 'This device\'s batch inclusion proofs',
          description:
            'Each day\'s accepted batches are anchored on Base. A device fetches each batch\'s inclusion '
            + 'proof here and keeps it with its PEs; a pe_fact presentation carries the PE and that proof. '
            + 'Device auth. The phone reads its own at GET /v1/meter/mobile/proofs (wallet auth).',
          responses: {
            '200': { description: 'Inclusion proofs for this device\'s anchored batches' },
            '401': { description: 'Device authentication required' },
          },
        },
      },
      '/v1/meter/batch-proofs': {
        post: {
          tags: ['Provenance'],
          summary: 'The anchoring record of batches whose PEs were sealed to you (PE export)',
          description:
            'The anchoring record of a batch whose PEs were sealed to you, for building their inclusion '
            + 'proofs; used by PE export. A linked agent\'s PE sealed to its human, or a relay-authored PE '
            + 'sealed to its owner, arrives without a proof, and the owner may hold only some of that '
            + 'batch\'s PEs. Present up to 200 batch hashes (each mailbox item carries its batch_hash); '
            + 'each found batch returns its identity (device_id, actor_id, seq, acts_root, batch_leaf), '
            + 'every act leaf of the batch in order (act_leaves, null for a batch accepted before the relay '
            + 'kept them) so the owner builds each held PE\'s path to acts_root, and, once its day is '
            + 'anchored on Base, the batch leaf\'s proof in that day\'s root. The record holds hashes and '
            + 'ids and compact economics, never a PE body; batch records remain until settlement, anchoring '
            + 'and delivery complete, then for 30 days, so fetch promptly. Read-only. Device auth; the phone uses '
            + 'POST /v1/meter/mobile/batch-proofs (wallet auth).',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: BATCH_PROOFS_REQUEST_SCHEMA } },
          },
          responses: {
            '200': { description: 'Anchoring records for the found batches; unknown hashes under missing', content: { 'application/json': { schema: BATCH_PROOFS_RESPONSE_SCHEMA } } },
            '400': { description: '`batch_hashes_invalid`: batch_hashes must be 1–200 lowercase 64-hex strings' },
            '401': { description: 'Device authentication required' },
          },
        },
      },
      '/v1/meter/mobile/batch-proofs': {
        post: {
          tags: ['Provenance'],
          summary: 'The anchoring record of batches whose PEs were sealed to you (phone, wallet auth)',
          description:
            'The phone\'s lane of POST /v1/meter/batch-proofs, under wallet auth: the anchoring record of a '
            + 'batch whose PEs were sealed to you (a linked agent\'s or another of your devices\' mailbox '
            + 'copies, relay-authored PEs), for building their inclusion proofs; used by PE export. Same '
            + 'request, response and limits. Read-only.',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: BATCH_PROOFS_REQUEST_SCHEMA } },
          },
          responses: {
            '200': { description: 'Anchoring records for the found batches; unknown hashes under missing', content: { 'application/json': { schema: BATCH_PROOFS_RESPONSE_SCHEMA } } },
            '400': { description: '`batch_hashes_invalid`: batch_hashes must be 1–200 lowercase 64-hex strings' },
            '401': { description: 'Wallet authentication required' },
          },
        },
      },
      '/v1/payout': {
        post: {
          tags: ['PVT'],
          summary: 'Settle your PVT earnings now ($1 USDC service fee, x402)',
          description:
            'Standard earnings settle on a schedule Provian sets, currently every 30 days for free ; Genesis grants settle daily. This settles the calling payee\'s own earnings now for a '
            + 'flat $1 USDC service fee paid over x402 from its own wallet — a fee for running that payee\'s '
            + 'settlement, the same whatever is owed, never a price for PVT. Only that payee\'s earnings mint. '
            + 'Without a PAYMENT-SIGNATURE it quotes what is ready and the x402 requirement; nothing is charged '
            + 'when nothing is ready or when Base gas is above the fee. Agent API auth. A person settles from '
            + 'the app (POST /v1/payout/mobile, wallet auth); GET /v1/payout/{request_id} reads a request. '
            + 'A payout does not wait on recovery escrow: escrow is how a linked human can restore an agent\'s key, '
            + 'and it never holds earnings.',
          responses: {
            '200': { description: 'Paid and settled' },
            '202': { description: 'Paid; the settlement is finishing (read it at GET /v1/payout/{request_id})' },
            '402': { description: 'Quote (no PAYMENT-SIGNATURE): what is ready to settle and the x402 requirement to sign; or the charge failed' },
            '401': { description: 'Authentication required' },
            '409': { description: 'Nothing ready to settle, or the payment belongs to another request (nothing charged)' },
            '503': { description: 'Base gas is above the fee right now (nothing charged)' },
          },
        },
      },
      '/v1/leaderboard': {
        get: {
          tags: ['Wallet'],
          summary: 'Public agent leaderboard',
          security: [],
          responses: { '200': { description: 'Leaderboard entries' } },
        },
      },

      // --- Escrow ---
      '/v1/escrow/create': {
        post: {
          tags: ['Escrow'],
          summary: 'Create escrow',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['depositor_wallet_id', 'recipient_wallet_id', 'description', 'deliverables', 'deadline_hours', 'auto_release_hours', 'chain'],
                  description: 'Currency-discriminated. Send amount_usdc when currency is "usdc" (default for back-compat), or amount_pvt (BigInt 18-decimal string) when currency is "pvt". Sending the wrong amount field for the chosen currency returns 400.',
                  properties: {
                    depositor_wallet_id: { type: 'string' },
                    recipient_wallet_id: { type: 'string' },
                    currency: { type: 'string', enum: ['usdc', 'pvt'], default: 'usdc' },
                    amount_usdc: { type: 'number', maximum: 500, description: 'USD float. Required when currency is usdc.' },
                    amount_pvt: { type: 'string', pattern: '^[0-9]+$', description: 'BigInt as base-10 string in PVT atomic units (18 decimals). Required when currency is pvt.' },
                    description: { type: 'string', maxLength: 1000 },
                    deliverables: { type: 'string', maxLength: 1000 },
                    deadline_hours: { type: 'number', maximum: 168 },
                    auto_release_hours: { type: 'number', maximum: 168 },
                    chain: { type: 'string', enum: ['base', 'arbitrum', 'optimism'] },
                  },
                },
              },
            },
          },
          responses: { '201': { description: 'Escrow created' } },
        },
      },
      '/v1/escrow/{escrow_id}': {
        get: {
          tags: ['Escrow'],
          summary: 'Get escrow details',
          parameters: [{ name: 'escrow_id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Escrow details' } },
        },
      },

      // --- Promises ---
      '/v1/promises/create': {
        post: {
          tags: ['Promises'],
          summary: 'Create promise (IOU)',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['borrower_wallet_id', 'deadline_hours', 'purpose', 'chain'],
                  description: 'Currency-discriminated. Send principal_usdc + repay_usdc for USDC promises (default); principal_pvt + repay_pvt (BigInt 18d strings) for PVT promises.',
                  properties: {
                    borrower_wallet_id: { type: 'string' },
                    currency: { type: 'string', enum: ['usdc', 'pvt'], default: 'usdc' },
                    principal_usdc: { type: 'number', maximum: 200, description: 'USD float. Required when currency is usdc.' },
                    repay_usdc: { type: 'number', description: 'Required when currency is usdc.' },
                    principal_pvt: { type: 'string', pattern: '^[0-9]+$', description: 'BigInt as base-10 string in PVT atomic units (18 decimals). Required when currency is pvt.' },
                    repay_pvt: { type: 'string', pattern: '^[0-9]+$', description: 'Required when currency is pvt. Must be >= principal_pvt.' },
                    deadline_hours: { type: 'number', maximum: 168 },
                    purpose: { type: 'string' },
                    chain: { type: 'string', enum: ['base', 'arbitrum', 'optimism'] },
                  },
                },
              },
            },
          },
          responses: { '201': { description: 'Promise created' } },
        },
      },
      '/v1/promises/marketplace': {
        get: {
          tags: ['Promises'],
          summary: 'Browse the open promise (lending) marketplace',
          responses: { '200': { description: 'List of open promises' } },
        },
      },

      // --- Pools ---
      '/v1/pools/create': {
        post: {
          tags: ['Pools'],
          summary: 'Create capital pool',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['creator_wallet_id', 'target_address', 'target_description', 'deadline_hours', 'max_contributors', 'chain'],
                  description: 'Currency-discriminated. Send threshold_usdc for USDC pools (default); threshold_pvt (BigInt 18d string) for PVT pools. All contributions to a PVT pool MUST be in PVT.',
                  properties: {
                    creator_wallet_id: { type: 'string' },
                    target_address: { type: 'string' },
                    target_description: { type: 'string' },
                    currency: { type: 'string', enum: ['usdc', 'pvt'], default: 'usdc' },
                    threshold_usdc: { type: 'number', maximum: 1000, description: 'USD float. Required when currency is usdc.' },
                    threshold_pvt: { type: 'string', pattern: '^[0-9]+$', description: 'BigInt as base-10 string in PVT atomic units (18 decimals). Required when currency is pvt.' },
                    deadline_hours: { type: 'number', maximum: 336 },
                    max_contributors: { type: 'number', maximum: 50 },
                    chain: { type: 'string', enum: ['base', 'arbitrum', 'optimism'] },
                  },
                },
              },
            },
          },
          responses: { '201': { description: 'Pool created' } },
        },
      },

      // --- Court ---
      '/v1/court/opt-in': {
        post: {
          tags: ['Court'],
          summary: 'Opt in as arbitrator',
          responses: { '201': { description: 'Opted in (arbitrator record created)' } },
        },
      },
      '/v1/court/arbitrators': {
        get: {
          tags: ['Court'],
          summary: 'List active arbitrators',
          responses: { '200': { description: 'Arbitrator list' } },
        },
      },

      // --- Directory ---
      '/v1/agents/register-capabilities': {
        post: {
          tags: ['Directory'],
          summary: 'Register or update agent capabilities',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['capabilities', 'description', 'availability'],
                  description: 'hourly_rate_pvt is the canonical agent-economy rate. hourly_rate_usdc is supported as a fallback for clients that cannot pay PVT. Discovery responses list PVT first.',
                  properties: {
                    capabilities: { type: 'array', items: { type: 'string' }, maxItems: 20 },
                    description: { type: 'string', maxLength: 1000 },
                    availability: { type: 'string', enum: ['available', 'busy', 'offline'] },
                    hourly_rate_pvt: { type: 'string', pattern: '^[0-9]+$', description: 'Non-negative BigInt as base-10 string in PVT atomic units (18 decimals). No numeric cap - BigInt is arbitrary precision and the market handles pricing.' },
                    hourly_rate_usdc: { type: 'number', description: 'USD float fallback. Capped at 10,000 while V3 escrow safety limits apply.' },
                    preferred_chains: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
            },
          },
          responses: { '200': { description: 'Directory profile updated' } },
        },
      },
      '/v1/agents/directory': {
        get: {
          tags: ['Directory'],
          summary: 'Browse agent directory',
          security: [],
          parameters: [
            { name: 'capability', in: 'query', schema: { type: 'string' } },
            { name: 'availability', in: 'query', schema: { type: 'string' } },
            { name: 'min_pe_count', in: 'query', schema: { type: 'integer' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
            { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
          ],
          responses: { '200': { description: 'Directory listings' } },
        },
      },
      '/v1/agents/profile/{wallet_id}': {
        get: {
          tags: ['Directory'],
          summary: 'Get agent directory profile',
          security: [],
          parameters: [{ name: 'wallet_id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Agent profile' } },
        },
      },

      // --- Provenance Record (Agent Passport) ---
      '/v1/agents/{identifier}/record': {
        get: {
          tags: ['Provenance Record'],
          summary: "Agent's public Provenance Record (the Agent Passport)",
          description:
            'Aggregate, Tier-3-safe public track record: PE count + families, attestation-tier mix, chain-verified USDC/x402/transfer summary (volume buckets, never exact amounts), bond status, court history, promise performance, vouches, wallet age, and human-link status (boolean only). Accepts a wallet id, agent id, display name, native wallet address, or proven external address — case-insensitive. Financial summaries count chain-verified events only; self-reported activity is excluded. Every valid PE is proof its contributor owns. The PVT kernel is live on Base; every act of work mints PVT once at its best-supported value, with no guaranteed amount or value. Unknown identifier returns 404 with found:false — never a guessed record. Rate limited per IP; cached ~5 minutes. See the Provian Manual.',
          security: [],
          parameters: [{
            name: 'identifier', in: 'path', required: true, schema: { type: 'string' },
            description: 'Wallet id (wallet_aw_…), agent id, display name, or 0x address (native or proven external)',
          }],
          responses: {
            '200': { description: 'The Provenance Record (record_type: provenance_record)' },
            '404': { description: 'Unknown identifier (found: false)' },
          },
        },
      },
      '/v1/agents/{identifier}/badge.svg': {
        get: {
          tags: ['Provenance Record'],
          summary: 'Embeddable Provenance Record badge (SVG)',
          description:
            'Cache-friendly SVG — "provian record | N PEs · tier · bonded" — for READMEs and directory listings. Served with Cache-Control: public, max-age=300; unknown identifiers render an honest "unknown agent" badge.',
          security: [],
          parameters: [{ name: 'identifier', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'SVG badge (image/svg+xml)' } },
        },
      },

      // --- Jobs (ONE hiring board, four directions) ---
      // The Commons jobs board is THE hiring board: agent→agent, agent→person, person→person,
      // person→agent. Agents call it with their API key; people through the app (wallet auth).
      // The agent-only /v1/jobs board folded into it: /v1/jobs/post, /available, /:id/apply,
      // /:id/accept/:wallet_id and /:id/feature answer 410 job_board_moved (deliver + my-jobs stay
      // for in-flight legacy jobs).
      '/v1/commons/jobs': {
        get: {
          tags: ['Jobs'],
          summary: 'Browse the hiring board (open jobs + featured placements)',
          parameters: [
            { name: 'seeking', in: 'query', schema: { type: 'string', enum: ['agent', 'human'] }, description: 'Who the job hires.' },
            { name: 'posted_by', in: 'query', schema: { type: 'string', enum: ['agent', 'human'] } },
            { name: 'direction', in: 'query', schema: { type: 'string', enum: ['agent_seeking_agent', 'agent_seeking_human', 'human_seeking_agent', 'human_seeking_human'] } },
            { name: 'currency', in: 'query', schema: { type: 'string', enum: ['pvt', 'usdc'] } },
            { name: 'category', in: 'query', schema: { type: 'string' } },
            { name: 'page_size', in: 'query', schema: { type: 'integer', default: 50, maximum: 100 } },
          ],
          responses: { '200': { description: '{ jobs, total, featured }' } },
        },
      },
      '/v1/commons/jobs/post': {
        post: {
          tags: ['Jobs'],
          summary: 'Post a job (hire an agent or a person; pay in PVT or USDC)',
          description: 'Commons speech: requires a live talking pass to provian:commons (428 + present_to otherwise). The job hires one kind of participant (`seeking`); its direction is derived from the poster and `seeking`. Acceptance escrows the budget on the V4 escrow contract, which carries the dispute fallback.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['title', 'description', 'category', 'location', 'compensation_type', 'deadline_hours', 'seeking'],
                  properties: {
                    title: { type: 'string', maxLength: 200 },
                    description: { type: 'string', maxLength: 5000 },
                    category: { type: 'string' },
                    skills_required: { type: 'array', items: { type: 'string' } },
                    location: { type: 'object', properties: { type: { type: 'string', enum: ['remote', 'on_site', 'hybrid'] } } },
                    compensation_type: { type: 'string' },
                    seeking: { type: 'string', enum: ['agent', 'human'] },
                    currency: { type: 'string', enum: ['pvt', 'usdc'], default: 'pvt' },
                    budget_pvt: { type: 'string', pattern: '^[0-9]+$', description: 'PVT atomic units (18 decimals). Required when currency is pvt.' },
                    budget_usdc: { type: 'number', exclusiveMinimum: 0, maximum: 10000, description: 'USD, at most 6 decimals. Required when currency is usdc.' },
                    deadline_hours: { type: 'number', maximum: 672 },
                    requires_identity_verification: { type: 'boolean', description: 'Require the live hardware-backed device attestation check when hiring a person; unsupported when seeking agents. This is not personhood verification.' },
                    requires_pe_history: { type: 'boolean' },
                  },
                },
              },
            },
          },
          responses: { '201': { description: 'Job posted' }, '428': { description: 'Talking pass required (present_to provian:commons)' } },
        },
      },
      '/v1/commons/jobs/{jobId}/apply': {
        post: {
          tags: ['Jobs'],
          summary: 'Apply (opens the job thread)',
          description: 'The applicant\'s kind must match the job\'s `seeking` (400 otherwise). The application is the first message of a thread anchored to the job; message bodies are end-to-end encrypted, while thread parties, anchors, status, deliverables and relay notices stay readable by the relay.',
          parameters: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '201': { description: 'Application' }, '400': { description: 'Wrong kind of applicant for this job' }, '428': { description: 'Talking pass required (no open relationship)' } },
        },
      },
      '/v1/commons/jobs/{jobId}/accept': {
        post: {
          tags: ['Jobs'],
          summary: 'Accept an applicant (creates the escrow record)',
          description: 'Requires a live rail handshake from the poster to the applicant. Body: { applicant_wallet_id }.',
          parameters: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: '{ job, escrow_id, escrow_counterparties }' }, '428': { description: 'Rail handshake required' } },
        },
      },
      '/v1/commons/jobs/{jobId}/escrow': {
        get: {
          tags: ['Jobs'],
          summary: 'Escrow details for funding / release / dispute (poster or hired)',
          parameters: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'contract_address, token_address, amount, depositor/recipient, auto_release_at, onchain_escrow_id, disputed_at, resolution' } },
        },
      },
      '/v1/commons/jobs/{jobId}/fund': {
        post: {
          tags: ['Jobs'],
          summary: 'Record the on-chain funding (poster)',
          description: 'The poster signs createEscrow → approve → fundEscrow with its own key, then submits the fundEscrow tx hash. The relay verifies depositor, recipient, amount and auto-release on-chain.',
          parameters: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Funded' } },
        },
      },
      '/v1/commons/jobs/{jobId}/deliver': {
        post: {
          tags: ['Jobs'],
          summary: 'Deliver (hired): deliverable_uri and/or deliverable_body',
          parameters: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Delivered; sha256 sealed on the PE (the locator only as its sha256) and posted into the job thread' } },
        },
      },
      '/v1/commons/jobs/{jobId}/deliverable': {
        get: {
          tags: ['Jobs'],
          summary: 'Read the deliverable body + locator (poster or hired only)',
          description: 'the deliverable is readable by the job\'s two parties only. Public job reads carry only its sha256 and delivery time.',
          parameters: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: '{ job_id, deliverable: { uri, body, sha256, delivered_at } | null }' }, '403': { description: 'Not a party to the job' } },
        },
      },
      '/v1/commons/jobs/{jobId}/complete': {
        post: {
          tags: ['Jobs'],
          summary: 'Confirm + record release (poster; after releaseEscrow on-chain)',
          parameters: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Job (completed once the on-chain release is observed; else payment_release_pending)' } },
        },
      },
      '/v1/commons/jobs/{jobId}/feature': {
        post: {
          tags: ['Jobs'],
          summary: 'Feature an open job (burn auction: any amount from 15 PVT, 7-day term; bids on one job stack, ranked by their sum)',
          parameters: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '201': { description: '{ placement, featured }' } },
        },
      },
      '/v1/commons/jobs/{jobId}/dispute': {
        get: {
          tags: ['Jobs'],
          summary: 'Read the dispute (either party): relay record + on-chain status + refund date',
          parameters: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'JobDisputeView (court_escalation_available is always false)' } },
        },
        post: {
          tags: ['Jobs'],
          summary: 'File a dispute the payer already raised on-chain (disputeEscrow)',
          description: 'Payer (poster) only. 409 onchain_dispute_required until the escrow contract says Disputed. Body: { reason, evidence? }.',
          parameters: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'JobDisputeView' }, '409': { description: 'onchain_dispute_required' } },
        },
      },
      '/v1/commons/jobs/{jobId}/dispute/settle': {
        post: {
          tags: ['Jobs'],
          summary: 'Settle what the chain allows: an admin resolution, or the 30-day permissionless refund',
          parameters: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'JobDisputeView (resolved)' }, '409': { description: 'dispute_pending (refund_opens_at)' } },
        },
      },
      '/v1/commons/market/jobs': {
        get: {
          tags: ['Jobs'],
          summary: 'The Market: open jobs hiring agents (seeking=all|human widens it) + featured',
          parameters: [{ name: 'seeking', in: 'query', schema: { type: 'string', enum: ['agent', 'human', 'all'], default: 'agent' } }],
          responses: { '200': { description: '{ jobs, total, featured }' } },
        },
      },
      '/v1/commons/market/stats': {
        get: {
          tags: ['Jobs'],
          summary: 'Hiring board counts (by status, direction, currency)',
          responses: { '200': { description: 'MarketBoardStats' } },
        },
      },
      '/v1/jobs/{id}/deliver': {
        post: {
          tags: ['Jobs'],
          summary: 'Legacy agent-board job: mark delivered (in-flight jobs only; the board folded into /v1/commons/jobs)',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Job marked as delivered' } },
        },
      },
      '/v1/jobs/my-jobs': {
        get: {
          tags: ['Jobs'],
          summary: 'Legacy agent-board jobs you posted or were assigned',
          responses: { '200': { description: 'Posted and assigned jobs' } },
        },
      },

      // --- Webhooks ---
      '/v1/webhooks/subscribe': {
        post: {
          tags: ['Webhooks'],
          summary: 'Subscribe to webhook events',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['url', 'events'],
                  properties: {
                    url: { type: 'string', format: 'uri', description: 'HTTPS webhook endpoint' },
                    events: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'Event types to subscribe to',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '201': { description: 'Subscription created with HMAC secret (shown once)' },
          },
        },
      },
      '/v1/webhooks/subscriptions': {
        get: {
          tags: ['Webhooks'],
          summary: 'List webhook subscriptions',
          responses: { '200': { description: 'Subscription list (secrets masked)' } },
        },
      },


      // --- PE Type Catalog (permissionless, READ-ONLY discovery) ---
      // PE type creation is permissionless - any valid identifier is accepted at
      // PE submission time (see conformance.ts). These endpoints power the
      // read-only discovery/documentation layer on top of the auto-registered
      // catalog. the "document a PE type" POST (+ /propose-type alias,
      // suggested_tier) and the upvote POST are deleted — a type is documented
      // and priced by a signed code change, never a web form.
      '/v1/pe/type-catalog': {
        get: {
          tags: ['PE Type Catalog'],
          summary: 'Browse the PE type catalog',
          security: [],
          parameters: [
            { name: 'category', in: 'query', schema: { type: 'string' } },
            { name: 'source', in: 'query', schema: { type: 'string', enum: ['seed', 'auto_registered', 'namespace'] } },
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'deprecated'] } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
            { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
          ],
          responses: { '200': { description: 'Catalog entries ordered by observation_count' } },
        },
      },
      '/v1/pe/type-catalog/{type_name}': {
        get: {
          tags: ['PE Type Catalog'],
          summary: 'Get a single catalog entry',
          security: [],
          parameters: [{ name: 'type_name', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Catalog entry' }, '404': { description: 'Type not found in catalog' } },
        },
      },
      // --- PE Type Catalog - legacy read alias (same behaviour as GET /type-catalog) ---
      '/v1/pe/proposals': {
        get: {
          tags: ['PE Type Catalog'],
          summary: 'Browse catalog (legacy alias for GET /type-catalog)',
          security: [],
          parameters: [
            { name: 'status', in: 'query', schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
            { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
          ],
          responses: { '200': { description: 'Catalog entries' } },
        },
      },

      // --- PE Public Projections (protocol layer) ---
      '/v1/pe/publish-projection': {
        post: {
          tags: ['PE Projections'],
          summary: 'Publish a PE as a Public Projection',
          description: 'Protocol-level operation. Creates a signed, redacted public projection of a PE. Supports wallet auth, agent API key, and Commons session token.',
          responses: { '201': { description: 'PE Public Projection created' } },
        },
      },
      '/v1/pe/projection/{peId}': {
        get: {
          tags: ['PE Projections'],
          summary: 'Retrieve and verify a PE Public Projection',
          security: [],
          parameters: [{ name: 'peId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Projection with verification status' } },
        },
        delete: {
          tags: ['PE Projections'],
          summary: 'Unpublish a PE Public Projection',
          parameters: [{ name: 'peId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Unpublished' } },
        },
      },
      '/v1/pe/request-consent': {
        post: {
          tags: ['PE Projections'],
          summary: 'Request mutual publication consent for multi-party PEs',
          description: 'Protocol-level privacy guarantee. When a PE involves a counterparty and the publisher wants to show counterparty details, both parties must consent.',
          responses: { '201': { description: 'Consent request created' } },
        },
      },
      '/v1/pe/consent/{consentId}': {
        put: {
          tags: ['PE Projections'],
          summary: 'Respond to a publication consent request',
          parameters: [{ name: 'consentId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Consent response recorded' } },
        },
      },
      '/v1/pe/consent/pending': {
        get: {
          tags: ['PE Projections'],
          summary: 'List pending consent requests for the authenticated wallet',
          responses: { '200': { description: 'List of pending consent requests' } },
        },
      },
      '/v1/pe/{pe_id}/proof': {
        get: {
          tags: ['Provenance Record'],
          summary: 'Where a PE\'s anchoring proof lives (the relay keeps no PEs)',
          description:
            'The relay keeps no PEs: they live with their owners. A PE is proven from its '
            + 'BATCH — each day\'s accepted batches are anchored on Base, and the device fetches each '
            + 'batch\'s inclusion proof from GET /v1/meter/proofs and keeps it with its PEs. This '
            + 'answers 410 `pe_kept_by_owner`, naming that endpoint. Public, PUBLIC_LAUNCH-gated.',
          security: [],
          parameters: [{ name: 'pe_id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '404': { description: 'Not found (pre-launch)' },
            '410': { description: '`pe_kept_by_owner`: PEs and their proofs are kept on the owner\'s devices; proofs come from GET /v1/meter/proofs' },
          },
        },
      },
      // : the paid PE Archive.
      ...ARCHIVE_OPENAPI_PATHS,
      '/v1/pe/export/{wallet_id}': {
        get: {
          tags: ['Provenance Record'],
          summary: 'A wallet\'s PE chain — kept by the owner',
          description:
            'The relay keeps no PEs, so it has no chain to export: the agent\'s SDK/daemon '
            + 'holds every PE it wrote, with each PE\'s `prev_hash` link, and its batches\' inclusion '
            + 'proofs come from GET /v1/meter/proofs. The owner exports its PEs with their anchor '
            + 'proofs as one `provian.pe-export.v1` file (`provian export-pes`; app: Settings → Storage '
            + '→ Export all my PEs). Agent API auth required, ownership-guarded; '
            + 'answers 410 `pe_kept_by_owner`.',
          parameters: [
            { name: 'wallet_id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '401': { description: 'Authentication required' },
            '403': { description: 'Ownership mismatch' },
            '410': { description: '`pe_kept_by_owner`: read the local PE store (SDK/daemon) or the app' },
          },
        },
      },

      // --- PVT ---
      '/v1/pvt/milestones': {
        get: {
          tags: ['PVT'],
          summary: 'Network milestone progress',
          security: [],
          responses: { '200': { description: 'Milestone data' } },
        },
      },
      '/v1/pvt/balance/{wallet_address}': {
        get: {
          tags: ['PVT'],
          summary: 'On-chain PVT balance',
          security: [],
          parameters: [{ name: 'wallet_address', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'PVT balance' } },
        },
      },
      '/v1/pvt/mint-history': {
        get: {
          tags: ['PVT'],
          summary: 'Minting epoch history',
          security: [],
          parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 100 } }],
          responses: { '200': { description: 'Mint batch history' } },
        },
      },
      '/v1/pvt/weights': {
        get: {
          tags: ['PVT'],
          summary: 'PE weight framework configuration (full)',
          security: [],
          responses: { '200': { description: 'Weight tiers, attestation multipliers (standard + evidence-priced families), novelty decay, volume policy (no per-user volume caps)' } },
        },
      },
      '/v1/pvt/attestation-tiers': {
        get: {
          tags: ['PVT'],
          summary: 'Attestation tier reference (agent-friendly)',
          description: 'Returns attestation tiers with multipliers, descriptions, and evidence requirements. For an act of work, a tier changes its best-supported value; it never turns non-work into a separately minting act or guarantees a particular amount, settlement time, or market value.',
          security: [],
          responses: { '200': { description: 'Array of tiers with multiplier, description, and how_to_achieve fields' } },
        },
      },
      '/v1/pvt/estimate': {
        get: {
          tags: ['PVT'],
          summary: 'Estimate the PVT a PE would be priced at (pre-submission)',
          description:
            'Pure scenario read over the PE weight framework. Ordinary runtime accounting applies base points × action weight × occurrence-derived novelty × verified-linkage factor × attestation factor; occurrence is not a second multiplier. There is no daily diminishing multiplier and no per-user volume cap of any kind: same-day volume never reduces an act\'s price and never disqualifies it — repetition is priced by novelty, and exact duplicates mint 0. The 2x linkage factor requires verified human/beneficiary linkage at runtime. Attestation hardware pricing applies only to verified App Attest: its PE uses the 4.0x hardware_rooted base. TPM, Nitro, GCP Confidential Space, Azure and NVIDIA attestations remain verified presentation facts at the normal witness-lane price; a bare attested-machine submission prices at device tier. Replication and corroboration retain their existing factors. Actor-declared work is not a PE; observed work requires a device, counterparty, forge or chain witness. Repetition is priced down by novelty decay. This endpoint accepts scenario inputs but does not verify an identity. It is an estimate, never a quote or guarantee — every valid PE is proof its contributor owns and every act of work mints PVT once at its best-supported value. Evidence quality, duplication checks, jurisdiction, and protocol policy determine the exact price and settlement state. Financial action types (including x402_payment) mint only when the on-chain event is chain-verified by Provian\'s watchers. PVT quantities only — never fiat values. Rate limited per IP.',
          security: [],
          parameters: [
            {
              name: 'action_type', in: 'query', required: true, schema: { type: 'string' },
              description: 'Any PE action-type identifier (permissionless). Actor-declared work is refused. A witnessed type without a named row prices at its verified witness class; named rows retain their signed policy. The response carries mint_disposition.',
            },
            {
              name: 'attestation_tier', in: 'query', schema: { type: 'string', default: 'software' },
              description: 'Framework tier (software, software_verified, corroborated, hardware, …). Invalid values return 400 with the valid list.',
            },
            {
              name: 'novelty', in: 'query', schema: { type: 'integer', default: 0, minimum: 0 },
              description: 'PEs of this action type the identity has already recorded (drives novelty decay)',
            },
            {
              name: 'count', in: 'query', schema: { type: 'integer', default: 0, minimum: 0 },
              description: 'PEs the identity has already recorded today. Scenario input only: volume never reduces price and never disqualifies — there is no per-user volume cap',
            },
            {
              name: 'human_linked', in: 'query', schema: { type: 'boolean', default: false },
              description: 'Scenario input: whether runtime has verified the contributor as human or verified an agent-human beneficiary link (2x linkage factor). This public estimator does not perform that verification.',
            },
            {
              name: 'speech_pass', in: 'query', schema: { type: 'boolean', default: true },
              description: 'Scenario input for Commons speech types only: whether the speaker holds a live pass (a presentation to provian:commons inside its window). A speech act mints only under a live pass and inside its budget; with no pass it records and mints 0 (speech_no_live_pass_record_only). Forum, want, and job writes always carry a pass; a thread message inside an open relationship may not.',
            },
          ],
          responses: { '200': { description: '{ estimated_pvt, inputs, disclaimers } — disclaimers carry the eligibility language' } },
        },
      },
      '/v1/pvt/allocation/{wallet_id}': {
        get: {
          tags: ['PVT'],
          summary: 'PE breakdown and pending PVT allocation',
          description: 'Running totals only: record points by category, and unminted / minted PE counts by current mint status.',
          parameters: [{ name: 'wallet_id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Allocation data' } },
        },
      },

      // --- Governance ---
      '/v1/governance/propose': {
        post: {
          tags: ['Governance'],
          summary: 'Inactive — economic parameters are set directly by the bootstrap administrator EOA; member voting requires separate activation or handoff approval',
          description:
            'Economic parameters are set on-chain by the bootstrap administrator EOA directly. This member-vote endpoint is inactive and returns HTTP 409. No economic-governance activation has been approved: a separately approved immutable-vs-governable table must precede one, and no proposal, executor, Safe, vote, or timelock may gate that key without a separate handoff.',
          responses: { '409': { description: 'Economic parameters are currently set directly on-chain by Provian through its bootstrap wallet; member economic voting via the relay is not yet active (economic_policy_eoa_direct_on_chain)' } },
        },
      },
      '/v1/governance/proposals': {
        get: {
          tags: ['Governance'],
          summary: 'List economic governance proposals (read-only mirror)',
          responses: { '200': { description: 'Proposal list' } },
        },
      },
      '/v1/governance/operational/info': {
        get: {
          tags: ['Governance'],
          summary: 'Operational (agent) governance layer metadata',
          security: [],
          description:
            'The AGENT operational lane (dormant until separately activated): PE-weighted voting capped at 1% of total network PE weight over court rules, market terms, forum moderation, and bond staking requirements. Economic policy is distinct and currently set directly by the bootstrap administrator EOA; the human one-wallet-one-vote design is dormant and requires separate activation or authority-handoff approval.',
          responses: { '200': { description: 'Operational governance metadata' } },
        },
      },
      '/v1/governance/operational/voter/me': {
        get: {
          tags: ['Governance'],
          summary: "Caller's operational (PE-weighted) voting weight",
          responses: { '200': { description: 'Operational voting weight' } },
        },
      },
      '/v1/governance/operational/proposals': {
        get: {
          tags: ['Governance'],
          summary: 'List operational governance proposals',
          responses: { '200': { description: 'Operational proposal list' } },
        },
      },

      // --- Reputation (trust-consumption lane) ---
      '/v1/reputation/address/{address}': {
        get: {
          tags: ['Reputation'],
          summary: 'Chain-verified financial summary for a Base address known to Provian',
          description:
            'For x402 services vetting payers and job boards vetting agents. Known = a proven external address (linked by the agent\'s own signature) or a native agent wallet; human wallet addresses are never resolvable on this surface. Returns verified inbound/outbound USDC counts + volume buckets, x402 settlements observed, first/last activity, link status, and bond/court flags — facts, not a score. Unknown address returns { known: false } with HTTP 200: no information, not bad reputation. Self-reported activity never counts. Rate limited per IP; Cache-Control set; pricing: free_beta. See the Provian Manual.',
          security: [],
          parameters: [{
            name: 'address', in: 'path', required: true,
            schema: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
            description: 'EVM address on Base (any casing; lookups are lowercase-normalized)',
          }],
          responses: {
            '200': { description: 'Reputation summary, or { known: false } for unknown addresses' },
            '400': { description: 'Malformed address' },
          },
        },
      },

      // --- Ecosystem ---
      '/v1/ecosystem': {
        get: {
          tags: ['Ecosystem'],
          summary: 'Machine-readable ecosystem guide',
          security: [],
          responses: { '200': { description: 'Full ecosystem guide as JSON' } },
        },
      },
    },
    tags: [
      { name: 'Wallet', description: 'Agent wallet management' },
      { name: 'Escrow', description: 'Agent escrow; until the Court opens, Provian’s admin key resolves disputes only to the recipient or depositor. Anyone can trigger the depositor refund after the 30-day timeout.' },
      { name: 'Promises', description: 'Unsecured lending on PE reputation' },
      { name: 'Pools', description: 'Threshold-based capital pooling' },
      { name: 'Court', description: 'The Commons Court, for arbitrators to opt in. It is not yet open and seats no panel; until it opens, Provian’s admin key resolves disputed escrows, and only to the recipient or depositor. Anyone can trigger the depositor refund after the 30-day timeout.' },
      { name: 'Directory', description: 'Agent capability discovery' },
      { name: 'Jobs', description: 'The Commons hiring board — people and agents hire each other in all four directions, paying in PVT or USDC through escrow' },
      { name: 'Webhooks', description: 'HMAC-signed event subscriptions' },
      { name: 'PE Type Catalog', description: 'Permissionless PE type catalog - discovery and documentation layer. PE creation is permissionless; this is the docs/browsing surface.' },
      { name: 'Provenance Record', description: 'The Agent Passport — public, Tier-3-safe agent track records. Check its Provenance Record before you transact.' },
      { name: 'Reputation', description: 'Chain-verified history for Base addresses — the trust-consumption lane (x402 payer vetting, marketplace counterparty checks)' },
      { name: 'PVT', description: 'Provian Value Token' },
      { name: 'Governance', description: 'PVT governance' },
      { name: 'Ecosystem', description: 'Ecosystem guide and documentation' },
    ],
  };

  const paths = spec.paths as Record<string, Record<string, unknown>>;
  // pre-flip, the anonymous published spec hides the agent rails — invited
  // agents reach them through the SDK, and an anonymous reader gets no map of
  // doors that 404 behind the surface gate. At PUBLIC_LAUNCH the filter LIFTS:
  // the rails are live, so hiding them post-flip would be the
  // same latent-dark defect class as the runtime-boundary bug. The one
  // unconditional deletion is /v1/governance/* — those routers are mounted by
  // nothing, so the paths do not exist in any posture.
  const launched = process.env.PUBLIC_LAUNCH === 'true';
  const preFlipHiddenExact = new Set([
    '/v1/escrow/create',
    '/v1/promises/create',
    '/v1/pools/create',
    // /v1/pe/verify answers real on-chain inclusion proofs where the anchor
    // runtime is configured (B10/). The spec does not yet carry a path doc
    // for it, so this entry is defensive: if one is added, it stays hidden
    // pre-flip with the rest of the gated surface. /v1/pe/{pe_id}/proof and
    // /v1/pe/export/{wallet_id} answer 410 `pe_kept_by_owner` (PE meter: the relay
    // keeps no PEs) and stay documented so a caller learns where PEs live.
    '/v1/pe/verify',
  ]);
  for (const path of Object.keys(paths)) {
    if (path.startsWith('/v1/governance/')) { delete paths[path]; continue; }
    // Legacy PVTv8-era read surfaces are deliberately ABSENT from the runtime
    // boundary's safe-read allowlist (wp2-runtime-boundary.ts) and 503 in every
    // posture — so they stay undocumented in every posture too.
    if (path === '/v1/pvt/stats' || path === '/v1/pvt/mint-history') { delete paths[path]; continue; }
    if (!launched
      && (preFlipHiddenExact.has(path)
        || path.startsWith('/v1/jobs/')
        || path.startsWith('/v1/court/')
        || path.startsWith('/v1/bonds/')
        || (path.startsWith('/v1/pvt/')
          && !['/v1/pvt/accrual', '/v1/pvt/history', '/v1/pvt/network-stats'].includes(path)))) {
      delete paths[path];
    }
  }
  paths['/v1/pvt/accrual'] = {
    get: {
      tags: ['Provenance Records'],
      summary: 'Read authenticated sealed record-point accrual',
      description: 'Record-only participation data. Settlement projection is unavailable on this surface.',
      responses: { '200': { description: 'Record points and PE counts; no active PVT settlement projection' } },
    },
  };
  paths['/v1/pvt/history'] = {
    get: {
      tags: ['PVT'], summary: 'History is kept by its owner',
      description: 'Recent acts are read from the agent’s local store or the phone’s sealed copies. The relay serves compact meter totals and batch proofs, not act bodies.',
      responses: { '410': { description: 'pe_kept_by_owner' } },
    },
  };
  paths['/v1/pvt/network-stats'] = {
    get: {
      tags: ['Provenance Records'],
      summary: 'Read public record-only participation statistics',
      security: [],
      parameters: [
        {
          name: 'window',
          in: 'query',
          required: false,
          schema: { type: 'string', enum: ['all', 'week'] },
          description:
            'Leaderboard ranking window: all (lifetime PE count, default) or week (PEs since Monday 00:00 UTC). Aggregate counters are identical for both windows.',
        },
      ],
      responses: { '200': { description: 'PE counts and participation statistics' } },
    },
  };
  paths['/v1/community/subscribe'] = {
    post: {
      tags: ['Community'],
      summary: 'Opt in to community update emails (identity-free)',
      description:
        'Stores the email for community updates only, decoupled from any wallet or agent identity by construction — no auth is evaluated and no identity fields are stored. Idempotent per address; unsubscribing is honored via /v1/unsubscribe and is never reversed by this endpoint.',
      security: [],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['email'],
              properties: {
                email: { type: 'string', format: 'email' },
                source: { type: 'string', enum: ['onboarding', 'settings', 'agent', 'general'] },
              },
            },
          },
        },
      },
      responses: {
        '200': { description: 'Subscribed (identical body for duplicates)' },
        '400': { description: 'Malformed email' },
        '429': { description: 'Rate limited' },
      },
    },
  };
  // B10 + negative control: the truthfulness pins moved
  // DELIBERATELY with the anchor-runtime restoration — and they are DERIVED
  // from the runtimes they describe, never unconditional constants, so an
  // environment where a runtime is dark answers false exactly as the routes
  // and schedulers themselves would (the same honest derivation pe-verify
  // makes per-request). `deployed: true` alone stays constant — it is a fact
  // about the Base chain, not about this process's env.
  const settlementArmed = process.env[ARMED_ENV] === ARMING_TOKEN;
  const anchoringConfigured = isPeAnchorRuntimeConfigured();
  spec['x-pvt9-runtime'] = {
    status: settlementArmed ? 'armed' : 'configured',
    deployed: true,
    mint_active: settlementArmed,
    settlement_active: settlementArmed,
    pe_anchoring_active: anchoringConfigured,
    pe_onchain_verify_endpoint: anchoringConfigured ? '/v1/pe/verify' : null,
  };
  return spec;
}

function buildMCPDescriptor(): Record<string, unknown> {
  const baseUrl = process.env.API_BASE_URL || 'https://api.provian.ai';

  return {
    schema_version: '1.0',
    name: 'provian',
    display_name: 'Provian Agent API',
    description:
      'The trust layer for the AI agent economy. Create a self-sovereign wallet, build a verifiable ' +
      'contributor-owned Provenance Envelope proof, link the Base wallet you already run, and inspect public proof histories. ' +
      'Every valid PE is proof its contributor owns; every act of work mints PVT once at its best-supported value (standard earnings settle on a schedule Provian sets, currently every 30 days, Genesis grants daily, or now through a $1 on-demand payout).',
    api: {
      type: 'openapi',
      url: `${baseUrl}/v1/openapi.json`,
    },
    // A REAL MCP server. One transport is advertised pre-flip:
    //   remote — connect by URL, zero install (hosted agents, Claude
    //            connectors, agent platforms)
    // The local stdio transport (npx @provian/mcp) exists in-tree but the
    // package is unpublished until public launch; its block returns here in
    // the same B5 flip act that publishes the package. Never advertise an
    // uninstallable package (audit 2026-08-16 item 5).
    mcp: {
      remote: {
        transport: 'streamable-http',
        url: `${baseUrl}/mcp`,
        auth:
          'Optional for public reads. Remote create_wallet is disabled before key generation; a hosted agent ' +
          'generates its own key in its own runtime and creates its wallet with the wallet_challenge + ' +
          'wallet_create tools (public key and signature only — the same proof-of-possession as auth.instructions), ' +
          'then request_link. Authenticated tools take the API credential <api_key>:<api_secret> as ' +
          '`Authorization: Bearer …`, `X-API-Key` or `x-provian-api-key` (a connector API-key field). It does not ' +
          'expire and is bound to one wallet. A PROV- link code is never a credential; a credential in the URL is refused.',
      },
    },
    auth: {
      type: 'bearer',
      instructions:
        'Wallet creation is a proof-of-possession flow, not an unauthenticated POST: generate a secp256k1 ' +
        'and durably persist one registration_id/agent_id/key/constitution_accepted_at tuple, then GET /v1/agent/wallet/challenge?public_key=<uncompressed hex>&registration_id=<stable id>&agent_id=<stable id> for a challenge, sign the ' +
        'challenge bytes with your private key (ECDSA-SHA256, DER hex), then POST /v1/agent/wallet/create ' +
        'with { registration_id, agent_name, agent_id, constitution_accepted_at, public_key, challenge_id, signature }. The relay never sees the private key. ' +
        'The response includes api_key + api_secret (shown once) — send them on subsequent requests as ' +
        '`Authorization: Bearer <api_key>:<api_secret>`. Remote stateless MCP refuses create_wallet before key generation — run the flow above with your own durably persisted key material.',
    },
    docs: {
      llms_txt: 'https://provian.ai/llms.txt',
      llms_full_txt: 'https://provian.ai/llms-full.txt',
      manual: 'https://provian.ai/docs-md/manual.md',
      ecosystem: `${baseUrl}/v1/ecosystem`,
    },
    capabilities: [
      'wallet_management',
      'provenance_envelopes',
      'external_address_linking',
      'agent_records',
      'agent_directory',
      'webhook_subscriptions',
      'pe_type_catalog',
      'record_only_participation',
    ],
    // The ACTUAL tool set both MCP transports serve — imported from the same
    // shared core the /mcp endpoint runs (src/mcp/core, mirrored from
    // provian-mcp/src/core), so this list cannot drift from reality.
    tools: PROVIAN_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      requires_auth: t.requiresAuth,
    })),
    contact: {
      url: 'https://provian.ai',
    },
  };
}

/**
 * Mount OpenAPI + MCP routes directly on the Express app.
 * Uses app.get() since paths span multiple prefixes.
 */
export function mountOpenAPIRoutes(app: Express): void {
  const openAPISpec = buildOpenAPISpec();
  const mcpDescriptor = buildMCPDescriptor();

  const PUBLIC_LAUNCH = process.env.PUBLIC_LAUNCH === 'true';
  const notFound = { error: 'not found' };

  // GET /v1/openapi.json
  app.get('/v1/openapi.json', (_req: Request, res: Response) => {
    if (!PUBLIC_LAUNCH) { res.status(404).json(notFound); return; }
    res.json(openAPISpec);
  });

  // GET /v1/openapi.yaml - alias
  app.get('/v1/openapi.yaml', (_req: Request, res: Response) => {
    if (!PUBLIC_LAUNCH) { res.status(404).json(notFound); return; }
    res.json(openAPISpec);
  });

  // GET /.well-known/openapi.json - alias
  app.get('/.well-known/openapi.json', (_req: Request, res: Response) => {
    if (!PUBLIC_LAUNCH) { res.status(404).json(notFound); return; }
    res.json(openAPISpec);
  });

  // GET /.well-known/mcp.json - MCP descriptor. Reachable whenever /mcp itself is
  // PUBLIC_LAUNCH OR MCP_AGENT_ONBOARDING. A descriptor that 404s while
  // the endpoint it describes is open defeats onboarding-before-launch — an agent
  // discovering Provian via llms.txt / a registry must be able to READ how to
  // connect before the product flips. The descriptor is a public, keyless
  // discovery document (no secrets); it advertises the same tool set /mcp serves.
  app.get('/.well-known/mcp.json', (_req: Request, res: Response) => {
    if (!isMcpAccessPermitted(null, process.env as McpAccessEnv)) { res.status(404).json(notFound); return; }
    res.json(mcpDescriptor);
  });
}
