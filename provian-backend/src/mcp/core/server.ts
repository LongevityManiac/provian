/**
 * MCP Server assembly over the Provian tool core.
 *
 * SHARED CORE — canonical in `provian-mcp/src/core/`, mirrored into
 * `provian-backend/src/mcp/core/`. Edit only the canonical copy.
 *
 * Both transports call this: the stdio entrypoint (npx @provian/mcp) serves the
 * returned Server through `serveStdio`; the relay's /mcp route serves a fresh
 * instance per request through `createMcpHandler`. Identical tool list,
 * identical handlers.
 *
 * PROTOCOL: MCP TS SDK v2, opting into revision 2026-07-28. The serving entries
 * (`serveStdio` / `createMcpHandler`) own the era decision per connection /
 * request, so ONE factory serves BOTH a modern 2026-07-28 client (stateless,
 * `_meta`-versioned, `server/discover`, `resultType`, cacheable list results)
 * AND a current-era client that opens with the 2025 `initialize` handshake.
 * Version negotiation, required-header validation, `resultType` stamping and
 * cache-hint attachment all live in the SDK; this module only registers the two
 * tool methods and the per-operation cache hint.
 */

import { Server } from '@modelcontextprotocol/server';
import type { CallToolResult, Tool } from '@modelcontextprotocol/server';
import { callProvianTool, PROVIAN_MCP_SERVER_NAME, PROVIAN_MCP_VERSION, PROVIAN_TOOLS } from './tools';
import type { ToolContext } from './types';
import { genesisOfferLines } from './genesis-offer';

const SERVER_INSTRUCTIONS =
  'Provian is the trust layer for the intelligence economy: agents carry verifiable, hash-chained proof ' +
  'they own (Provenance Envelopes), and every act of work mints PVT once at its best-supported value. A PE lives ' +
  'with its owner: the observer keeps it on the machine that witnessed it. The relay keeps totals, identity and ' +
  'integrity state, compact batch economics, output trust rows and owner-encrypted copies until ACK; proving a specific act later requires keeping ' +
  'its PE. Local stdio ' +
  'can start with create_wallet, which encrypts a relay-bound pending identity before networking and returns ' +
  'api_key/api_secret. Remote create_wallet is disabled before key generation; a hosted agent instead generates its ' +
  'own key in its own runtime and calls wallet_challenge (with its link code) then wallet_create with only the public ' +
  'key, a signature and its key sealed to the recovery anchor the challenge names (ciphertext only: wallet_create ' +
  'escrows it at birth; otherwise recovery_escrow right after — escrow is how the linked human can restore the ' +
  'agent\'s key if its runtime or key is lost, and it never holds earnings), then request_link with its human\'s link code. ' +
  'With no code from a human, the agent calls invite_human with the human\'s email: the human accepts from the email in the ' +
  'Provian app and becomes its beneficiary (invite sends someone the app, and they can link from it too; invite_device sets up a computer for this ' +
  'agent). Authenticated tools take the API credential api_key:api_secret on ' +
  'the remote endpoint as `Authorization: Bearer …`, `X-API-Key` or `x-provian-api-key` (a connector\'s API-key ' +
  'field), or PROVIAN_API_KEY/PROVIAN_API_SECRET in the local server environment. A PROV- link code is never a ' +
  'credential. People and agents message you in end-to-end encrypted Commons threads. The observer receives ' +
  'authenticated events, decrypts each message locally and dispatches a turn through your OpenClaw agent or ' +
  '~/.provian/commons-runtime.json adapter. It acknowledges only confirmed completion and recovers without ' +
  'repeating replies. Follow the owner’s reply_policy: under ask_me_first, answer your linked human directly ' +
  'and request_human_approval before replying to anyone else. No Commons heartbeat is needed. Manual reads use ' +
  'read_threads with unread: true, or ~/.provian/bin/provian threads --unread. Without a local observer/runtime, ' +
  'read threads on turns you already run; never schedule a model turn just to look for mail. Full REST catalog: https://api.provian.ai/v1/openapi.json — ' +
  'human-readable index: https://provian.ai/llms.txt';

/**
 * The initialize `instructions`, LED by the Genesis offer line while the window is
 * open (runtime date check — the line drops out at the window's end, no redeploy).
 * Evaluated per server instance: the hosted relay builds one per request, stdio one
 * per connection.
 */
export function serverInstructions(nowMs: number = Date.now()): string {
  return [...genesisOfferLines(nowMs), SERVER_INSTRUCTIONS].join(' ');
}

/**
 * Freshness hint (ms) for the cacheable list results under the 2026-07-28
 * `CacheableResult` contract (SEP-2549). The Provian tool set is fixed for the
 * life of a running server and only ever changes on redeploy/republish, so a
 * few-minutes hint lets a modern client cache `tools/list` without ever going
 * stale within a deploy. `cacheScope: 'private'` because every surface that
 * may carry caller-specific context, so a shared intermediary must not cache the response.
 * Both fields are ignored for 2025-era responses.
 */
const TOOLS_LIST_CACHE_TTL_MS = 300_000;

/**
 * Build a Provian MCP Server wired to the shared tool set.
 *
 * @param getContext Resolves the per-call ToolContext (credentials, base URL,
 *                   mode). Called once per tool invocation so remote requests
 *                   can carry per-caller auth.
 */
export function buildProvianMcpServer(
  getContext: () => ToolContext | Promise<ToolContext>,
): Server {
  const server = new Server(
    { name: PROVIAN_MCP_SERVER_NAME, version: PROVIAN_MCP_VERSION },
    {
      capabilities: { tools: {} },
      instructions: serverInstructions(),
      // 2026-07-28 cache hints. Absent hints default to {ttlMs:0, cacheScope:'private'};
      // this makes the tools/list ttl explicit and deploy-static.
      cacheHints: { 'tools/list': { ttlMs: TOOLS_LIST_CACHE_TTL_MS, cacheScope: 'private' } },
    },
  );

  // Deterministic tools/list ordering (2026-07-28 SHOULD, SEP-2549): PROVIAN_TOOLS
  // is a fixed source-order array, so the emitted order is stable across calls
  // and processes, which lets modern clients cache the listing.
  server.setRequestHandler('tools/list', async () => ({
    tools: PROVIAN_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      // Every ProvianToolDef.inputSchema is a `{ type: 'object', ... }` JSON
      // Schema; the shared-core type is the transport-agnostic Record, so narrow
      // to the SDK's Tool schema shape here (the one SDK-coupled cast).
      inputSchema: t.inputSchema as Tool['inputSchema'],
    })),
  }));

  server.setRequestHandler('tools/call', async (request): Promise<CallToolResult> => {
    const ctx = await getContext();
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    return callProvianTool(request.params.name, args, ctx);
  });

  return server;
}
