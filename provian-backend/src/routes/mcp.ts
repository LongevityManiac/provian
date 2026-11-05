/**
 * Remote MCP endpoint — POST /mcp (Model Context Protocol, streamable HTTP).
 *
 * Serves the SAME tool core as the local `npx @provian/mcp` stdio server
 * (mirrored from provian-mcp/src/core → src/mcp/core; see
 * scripts/sync-mcp-core.sh) so hosted agents — Claude connectors, agent
 * platforms, framework runtimes — connect by URL with zero install.
 *
 * PROTOCOL (MCP TS SDK v2, revision 2026-07-28): BOTH eras are served from ONE
 * factory:
 * - a modern 2026-07-28 client (stateless, `_meta`-versioned, `server/discover`,
 * `resultType`, cacheable `tools/list` results) through
 * `createMcpHandler({ legacy: 'reject' })`, and
 * - a current-era client that opens with the 2025 `initialize` handshake,
 * through a stateless `WebStandardStreamableHTTPServerTransport` with
 * `enableJsonResponse` (fresh instance per request, no session state,
 * GET/DELETE -> 405), routed by the SDK's own `isLegacyRequest` predicate.
 * The SDK owns version negotiation, required-header (`Mcp-Method`/`Mcp-Name`)
 * validation and the `UnsupportedProtocolVersion`/`HeaderMismatch` errors. This
 * route supplies the per-request factory, the admission gate, the connector
 * credential read, and the first-try normalization documented at
 * "First-try serving" below (a hosted connector connects on the
 * first try — JSON replies, lenient Accept/Content-Type, no empty 202 for a
 * request, per-element batches).
 *
 * Security model (deliberate, load-bearing):
 * - Admission is OPEN once onboarding is on — no key allowlist (; see
 * mcp-access.ts). Self-serve onboarding is the product. What holds the line
 * is NOT the transport door but (a) each tool's downstream auth and (b) rate
 * limits (below). The capability an arbitrary key reaches was established by
 * execution before opening: self-scoped reads + own-address only (the own-PE
 * report tools were removed by);
 * cross-agent/admin/operator/mint all refuse; create_wallet remote-disabled.
 * - Stateless: a fresh factory instance per POST, no session state, GET/DELETE
 * answer 405. This route never mints an ephemeral identity that would be lost
 * after an ambiguous response.
 * - NO auth is validated here. The connector credential (api_key:api_secret in
 * Authorization / X-API-Key / x-provian-api-key; see
 * resolveConnectorCredential) is parsed only to be FORWARDED on the tool core's
 * loopback self-calls to the existing REST routes, where
 * createAgentAuthMiddleware / device auth / PoP verification remain the
 * sole validators (relayCall injects NO admin/internal secret — the forwarder
 * cannot escalate). Unauthenticated callers can use public reads such as
 * get_agent_record and get_pvt_estimate. Remote create_wallet is disabled
 * before key generation because a stateless request cannot durably recover
 * a fund-bearing identity. A hosted agent creates its wallet remotely with
 * wallet_challenge + wallet_create instead: it generates and keeps its key
 * itself and sends only the public key and a signature, the
 * same PoP the REST routes verify.
 * - Rate limits: two layers. (1) A per-IP limit on `/mcp` ITSELF (this route),
 * so an open endpoint cannot be spammed at the protocol layer (initialize/
 * tools/list make no downstream call). (2) The tool self-calls re-enter the
 * Express stack and inherit each endpoint's existing per-IP limits; the real
 * client IP is forwarded via X-Forwarded-For (server.ts sets `trust proxy`,
 * so req.ip resolves it exactly as for direct callers).
 */

import { createHash } from 'crypto';
import { Readable } from 'node:stream';
import { mcpBatchBudget } from './mcp-budget';
import { fetchMcpRelay } from './mcp-relay-fetch';
import type { Express, Request, RequestHandler, Response } from 'express';
import type { ToolAuth, ToolContext } from '../mcp/core/types';
import { explainMcpAccess, mcpAccessAdmits, type McpAccessEnv } from './mcp-access';
import { cache } from '../cache';
import { bumpOpsCounter } from '../core/observability/ops-counters';

/**
 * The MCP SDK and the tool core load on the first `/mcp` request, not at boot.
 * Together they are about 12 MB of heap, a fifth of the relay's boot heap, and an
 * instance that never serves `/mcp` (most of them: the scheduler bursts and the app
 * traffic never touch it) should not hold them. The promise is memoized, so every
 * later request reuses the loaded modules; a failed load is not memoized, so the
 * next request retries it.
 */
interface McpRuntime {
  readonly createMcpHandler: typeof import('@modelcontextprotocol/server').createMcpHandler;
  readonly isLegacyRequest: typeof import('@modelcontextprotocol/server').isLegacyRequest;
  readonly WebStandardStreamableHTTPServerTransport: typeof import('@modelcontextprotocol/server').WebStandardStreamableHTTPServerTransport;
  readonly toNodeHandler: typeof import('@modelcontextprotocol/node').toNodeHandler;
  readonly buildProvianMcpServer: typeof import('../mcp/core/server').buildProvianMcpServer;
}

let mcpRuntime: Promise<McpRuntime> | null = null;

function loadMcpRuntime(): Promise<McpRuntime> {
  if (mcpRuntime) return mcpRuntime;
  const loading = Promise.all([
    import('@modelcontextprotocol/server'),
    import('@modelcontextprotocol/node'),
    import('../mcp/core/server'),
  ]).then(([sdk, node, core]): McpRuntime => ({
    createMcpHandler: sdk.createMcpHandler,
    isLegacyRequest: sdk.isLegacyRequest,
    WebStandardStreamableHTTPServerTransport: sdk.WebStandardStreamableHTTPServerTransport,
    toNodeHandler: node.toNodeHandler,
    buildProvianMcpServer: core.buildProvianMcpServer,
  }));
  mcpRuntime = loading;
  loading.catch(() => {
    if (mcpRuntime === loading) mcpRuntime = null;
  });
  return loading;
}

// Per-IP limit on the /mcp endpoint itself. Generous enough for a real MCP
// session (initialize + tools/list + a handful of tool calls) and for a modest
// burst, while capping protocol-layer spam on the now-open door. Value-affecting
// operations are additionally bounded by each tool endpoint's own per-IP limit.
const MCP_RATE_LIMIT_PER_MIN = 120;

/**
 * (§Q4 item 9): a cloud-VM agent platform puts many tenants behind
 * ONE egress IP (a hosted platform's proxy; Grok Bot's shared static egress IPs), so a
 * purely per-IP bucket made every tenant share 120/min. A caller presenting an
 * agent API key now gets its own 120/min bucket (keyed by a HASH of the key id,
 * scoped to the IP), under a per-IP backstop ten times higher so rotating
 * made-up keys cannot lift the protocol-layer cap without bound. Anonymous
 * calls keep the original per-IP bucket. Nothing here touches wallet creation
 * (limits unchanged — ); this guard is not the security
 * boundary (per-tool auth + per-endpoint limits are), and it still fails open
 * under a Redis outage exactly as before.
 */
export const MCP_IP_BACKSTOP_PER_MIN = MCP_RATE_LIMIT_PER_MIN * 10;

export function mcpRateLimitBuckets(clientIp: string, apiKeyId: string | null): Array<{ key: string; limit: number }> {
  if (!apiKeyId) return [{ key: `rl:mcp:${clientIp}`, limit: MCP_RATE_LIMIT_PER_MIN }];
  const keyHash = createHash('sha256').update(apiKeyId, 'utf8').digest('hex').slice(0, 24);
  return [
    { key: `rl:mcp-ip:${clientIp}`, limit: MCP_IP_BACKSTOP_PER_MIN },
    { key: `rl:mcp:${clientIp}:k:${keyHash}`, limit: MCP_RATE_LIMIT_PER_MIN },
  ];
}

async function checkMcpRateLimit(clientIp: string, apiKeyId: string | null, cost: number): Promise<{ allowed: boolean; retryAfter?: number }> {
  for (const bucket of mcpRateLimitBuckets(clientIp, apiKeyId)) {
    const r = await cache.checkRateLimit(bucket.key, bucket.limit, 60, cost);
    if (!r.allowed) return r;
  }
  return { allowed: true };
}


/**
 * Judge admission and LOG a refusal with its named verdict and the attempted key
 * id. A refusal used to be a silent 404, so an allowlisted partner mistyping a
 * key, or an operator forgetting `MCP_AGENT_ONBOARDING`, was indistinguishable
 * from ordinary pre-launch traffic. The key id is an identifier, never secret
 * material (the `:<secret>` half is not touched here); the verdict is the same
 * named reason `explainMcpAccess` already computes.
 */
function admitOrLogRefusal(apiKeyId: string | null): boolean {
  const verdict = explainMcpAccess(apiKeyId, process.env as McpAccessEnv);
  if (mcpAccessAdmits(verdict)) return true;
  console.warn(
    `[MCP] admission refused: verdict=${verdict} attempted_key_id=${apiKeyId ?? '(none)'}`,
  );
  return false;
}

export interface MCPRouteDeps {
  /**
   * Base URL for the tool core's self-calls. Defaults to the local listener
   * (http://127.0.0.1:$PORT). Tests inject a stub fetchImpl instead.
   */
  getSelfBaseUrl?: () => string;
  /** Fetch implementation for self-calls (tests inject a stub). */
  fetchImpl?: typeof fetch;
}

/**
 * Split `Bearer <api_key>:<api_secret>` for forwarding. Parsing only — no
 * validation happens here; garbage is forwarded and rejected by the relay's
 * existing middleware exactly as it would be on a direct REST call.
 */
export function parseForwardableAuth(header: string | undefined): ToolAuth | null {
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  const separator = token.indexOf(':');
  if (separator === -1) return null;
  return { apiKey: token.slice(0, separator), apiSecret: token.slice(separator + 1) };
}

// ---------------------------------------------------------------------------
// The connector credential (item 8)
// ---------------------------------------------------------------------------
//
// A hosted connector (a custom MCP connector on most platforms) stores ONE
// secret in an "API key" field and sends it as a header of its own choosing. The
// credential that belongs there is the agent API credential `pvn_live_…:pvns_…`:
// long-lived (no expiry), bound to exactly one agent wallet, changed only by
// rotate-key or recovery. It is accepted in every common header form and never
// from a URL. Parsing only — the REST middleware the tool core forwards to stays
// the sole validator; this layer only refuses the two things that can never be a
// credential (a link code, a key without its secret) with a message that names
// the fix, so a misconfigured connector is told why instead of silently running
// unauthenticated.

/** Header names a connector's API-key field is sent under, in precedence order. */
export const CONNECTOR_CREDENTIAL_HEADERS = ['authorization', 'x-api-key', 'x-provian-api-key'] as const;

const API_KEY_SHAPE = /^pvn_live_[0-9a-f]{32}$/;
const API_SECRET_SHAPE = /^pvns_[0-9a-f]{64}$/;
const LINK_CODE_SHAPE = /^PROV-/i;

export const LINK_CODE_AS_CREDENTIAL_MESSAGE =
  'That is a Provian link code (PROV-…), not a connector credential. Link codes expire in an hour and ' +
  "can't be a connector credential; use the API credential your wallet creation returned " +
  '(pvn_live_…:pvns_…, the api_key and api_secret joined by a colon). Use the link code only once, ' +
  'with request_link (or wallet_create), to ask your human to link this agent.';

export const PARTIAL_CREDENTIAL_MESSAGE =
  'The connector credential must be the whole API credential your wallet creation returned: ' +
  'pvn_live_…:pvns_… (the api_key, a colon, then the api_secret). Only one half was sent.';

export const QUERY_CREDENTIAL_MESSAGE =
  'Credentials are never accepted in the URL: query strings are written to logs and proxies. Put the API ' +
  "credential (pvn_live_…:pvns_…) in the connector's API-key field, which is sent as a header. A credential " +
  'that was sent in a URL should be treated as exposed: rotate it.';

export type ConnectorCredential =
  | { kind: 'none' }
  | { kind: 'ok'; auth: ToolAuth; source: (typeof CONNECTOR_CREDENTIAL_HEADERS)[number] }
  | { kind: 'refused'; reason: 'link_code' | 'partial_credential'; message: string };

type HeaderBag = Record<string, string | string[] | undefined>;

function firstHeader(headers: HeaderBag, name: string): string | undefined {
  const v = headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && s.trim().length > 0 ? s.trim() : undefined;
}

/**
 * Read the connector credential from whichever header carries it. Accepted forms:
 *   Authorization: Bearer <key>:<secret>   (any scheme case)
 *   Authorization: <key>:<secret>          (API-key fields that send the bare value)
 *   Authorization: Basic base64(<key>:<secret>)
 *   X-API-Key / x-provian-api-key: <key>:<secret>  (optionally prefixed "Bearer ")
 * Pure and exported so the precedence and the refusals are unit-tested.
 */
export function resolveConnectorCredential(headers: HeaderBag, _query: unknown): ConnectorCredential {
  for (const name of CONNECTOR_CREDENTIAL_HEADERS) {
    const raw = firstHeader(headers, name);
    if (raw === undefined) continue;
    let value = raw;
    const scheme = /^([A-Za-z-]+)\s+(.+)$/.exec(raw);
    if (scheme) {
      const s = scheme[1].toLowerCase();
      if (s === 'bearer' || s === 'token' || s === 'apikey' || s === 'api-key') {
        value = scheme[2].trim();
      } else if (s === 'basic') {
        try {
          value = Buffer.from(scheme[2].trim(), 'base64').toString('utf8');
        } catch {
          continue;
        }
      } else {
        // Another scheme (DeviceKey …) is not a connector credential; leave it alone.
        continue;
      }
    }
    if (LINK_CODE_SHAPE.test(value)) {
      return { kind: 'refused', reason: 'link_code', message: LINK_CODE_AS_CREDENTIAL_MESSAGE };
    }
    const sep = value.indexOf(':');
    if (sep === -1) {
      if (API_KEY_SHAPE.test(value) || API_SECRET_SHAPE.test(value)) {
        return { kind: 'refused', reason: 'partial_credential', message: PARTIAL_CREDENTIAL_MESSAGE };
      }
      continue;
    }
    // Garbage in key:secret form is FORWARDED, as before: the relay's agent-auth
    // middleware rejects it exactly as it would on a direct REST call.
    return {
      kind: 'ok',
      auth: { apiKey: value.slice(0, sep), apiSecret: value.slice(sep + 1) },
      source: name,
    };
  }
  return { kind: 'none' };
}

const CREDENTIAL_QUERY_KEY = /^(api[_-]?key|apikey|api[_-]?secret|secret|key|token|access[_-]?token|auth|authorization|credential|credentials)$/i;
const CREDENTIAL_QUERY_VALUE = /pvn_live_|pvns_|PROV-/i;

/** True when the URL carries anything that looks like a credential. */
export function queryCarriesCredential(query: unknown): boolean {
  if (!query || typeof query !== 'object') return false;
  for (const [k, v] of Object.entries(query as Record<string, unknown>)) {
    if (CREDENTIAL_QUERY_KEY.test(k)) return true;
    const values = Array.isArray(v) ? v : [v];
    if (values.some((x) => typeof x === 'string' && CREDENTIAL_QUERY_VALUE.test(x))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// First-try serving (item 8)
// ---------------------------------------------------------------------------
//
// What a hosted connector sees on its FIRST request decides whether it connects.
// The prior wiring served 2025-era traffic through the SDK's stateless fallback,
// which (a) answered 406 unless Accept named BOTH application/json and
// text/event-stream (a client sending `application/json`, `*/*` or nothing was
// refused), (b) framed every reply as SSE, and (c) answered an id-less request —
// `{"method":"initialize"}` or `{"method":"tools/list"}` with no `id` — with an
// EMPTY 202, because a JSON-RPC message without an id is a notification. (c) is
// the empty 202 a hosted connector saw before retrying. Now:
//   - 2025-era requests are served by a stateless transport with
//     `enableJsonResponse`, so every reply is one JSON body;
//   - Accept is normalized (a client that sends no Accept, `*/*`, or only one of
//     the two types is served the same JSON), as is a missing `jsonrpc` member
//     and a JSON body sent without a JSON Content-Type;
//   - an id-less message whose method is a REQUEST method is answered with a
//     JSON-RPC Invalid Request that names the fix — never an empty 202. A POST
//     that holds only genuine notifications (`notifications/…`) or responses
//     still gets the spec 202;
//   - batches (2025-03-26 clients) are answered per element, so
//     `[initialize, notifications/initialized]` and `[initialize, tools/list]`
//     work instead of the transport's "only one initialization request" 400;
//   - modern (2026-07-28, `_meta`-envelope) traffic is served by
//     `createMcpHandler({ legacy: 'reject' })` exactly as before.
// GET stays 405 + `Allow: POST` with a JSON body: the streamable-HTTP spec lets a
// server that offers no server-initiated stream answer GET with 405, and spec
// clients treat that as "no stream" and carry on over POST.

const NORMALIZED_ACCEPT = 'application/json, text/event-stream';
/** express.json()'s default limit; a body sent without a JSON content type gets the same bound. */
const RAW_BODY_LIMIT_BYTES = 100 * 1024;

type RpcShape =
  | { kind: 'request'; message: Record<string, unknown> }
  | { kind: 'notification'; message: Record<string, unknown> }
  | { kind: 'response'; message: Record<string, unknown> }
  | { kind: 'request_missing_id'; method: string }
  | { kind: 'invalid' };

function classifyRpc(raw: unknown): RpcShape {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'invalid' };
  const message: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  if (message.jsonrpc === undefined) message.jsonrpc = '2.0';
  if (typeof message.method === 'string') {
    const id = message.id;
    const validId = typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
    if (validId) return { kind: 'request', message };
    if (message.method.startsWith('notifications/') && id === undefined) return { kind: 'notification', message };
    return { kind: 'request_missing_id', method: message.method };
  }
  if ('result' in message || 'error' in message) return { kind: 'response', message };
  return { kind: 'invalid' };
}

function missingIdMessage(method: string): string {
  return `Invalid Request: "${method}" is a request and needs an "id" (a string or a number). ` +
    'A JSON-RPC message without an id is a notification and gets no reply. Resend it with an id, ' +
    'e.g. {"jsonrpc":"2.0","id":1,"method":"' + method + '"}.';
}

function rpcErrorObject(code: number, message: string, id: string | number | null = null) {
  return { jsonrpc: '2.0' as const, error: { code, message }, id };
}

function rpcErrorResponse(status: number, code: number, message: string, id: string | number | null = null): globalThis.Response {
  return new globalThis.Response(JSON.stringify(rpcErrorObject(code, message, id)), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function echoableId(body: unknown): string | number | null {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const id = (body as Record<string, unknown>).id;
    if (typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id))) return id;
  }
  return null;
}

/** A copy of the inbound request with the header normalization first-try serving needs. */
function normalizedWebRequest(original: globalThis.Request): globalThis.Request {
  const headers = new Headers(original.headers);
  headers.set('accept', NORMALIZED_ACCEPT);
  headers.set('content-type', 'application/json');
  headers.delete('content-length');
  return new globalThis.Request(original.url, { method: original.method, headers, signal: original.signal });
}

/**
 * Read a JSON body express.json() skipped because the client sent no JSON
 * Content-Type (a hand-written fetch posting a string sends text/plain; some
 * clients send none). Returns undefined when there is no body or it is not JSON.
 */
async function readUnparsedJsonBody(req: Request): Promise<unknown> {
  const parsedByExpress = (req as Request & { _body?: boolean })._body === true;
  if (parsedByExpress) return req.body;
  if (!req.readable || req.readableEnded) return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buf.length;
    if (size > RAW_BODY_LIMIT_BYTES) return undefined;
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function mountMCPRoutes(app: Express, deps: MCPRouteDeps = {}): void {
  const notFound = { error: 'not found' };

  app.post('/mcp', async (req: Request, res: Response) => {
    try {
      const credential = resolveConnectorCredential(req.headers, req.query);
      const auth = credential.kind === 'ok' ? credential.auth : null;
      // Evaluated PER REQUEST, not captured at mount time: admission depends on the
      // live onboarding/launch posture, not knowable when the route is mounted.
      // The gate runs FIRST, so a closed door never judges (or discloses) anything.
      if (!admitOrLogRefusal(auth?.apiKey ?? null)) {
        res.status(404).json(notFound);
        return;
      }
      if (queryCarriesCredential(req.query)) {
        res.status(400).json(rpcErrorObject(-32600, QUERY_CREDENTIAL_MESSAGE, echoableId(req.body)));
        return;
      }
      if (credential.kind === 'refused') {
        res.status(401).json(rpcErrorObject(-32001, credential.message, echoableId(req.body)));
        return;
      }

      let body: unknown;
      try { body = await readUnparsedJsonBody(req); }
      catch {
        if (!res.headersSent && !res.destroyed) res.status(400).json(rpcErrorObject(-32600, 'Incomplete MCP request body.'));
        return;
      }
      const budget = mcpBatchBudget(body);
      if (!budget.allowed) {
        res.status(Array.isArray(body) && body.length === 0 ? 400 : 413).json(rpcErrorObject(-32600, 'MCP batch exceeds the element limit or is empty.'));
        return;
      }
      const clientIp = req.ip || req.socket.remoteAddress || '';
      // Per-IP limit on the open endpoint itself. Fails open under a Redis
      // outage (checkRateLimit) — acceptable, because the downstream per-tool auth
      // and per-endpoint limits, not this guard, are the security boundary.
      const mcpRl = await checkMcpRateLimit(clientIp, auth?.apiKey ?? null, budget.elements);
      if (!mcpRl.allowed) {
        res
          .status(429)
          .set('Retry-After', String(mcpRl.retryAfter ?? 60))
          .json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Rate limit exceeded for /mcp. Try again shortly.' },
            id: null,
          });
        return;
      }
      // Reject a malformed envelope without serializing its arbitrary payload
      // through the Node adapter (JSON.parse can accept extreme nesting).
      if (!Array.isArray(body) && classifyRpc(body).kind === 'invalid') {
        res.status(400).json(rpcErrorObject(-32600, 'Invalid Request: the body is not a JSON-RPC 2.0 message.'));
        return;
      }
      const baseUrl = (deps.getSelfBaseUrl?.() ?? `http://127.0.0.1:${process.env.PORT || 8080}`).replace(/\/$/, '');
      const baseFetch = deps.fetchImpl ?? fetchMcpRelay;
      const forwardingFetch: typeof fetch = async (input, init) => {
        const headers = new Headers(init?.headers);
        if (clientIp) headers.set('X-Forwarded-For', clientIp);
        return baseFetch(input, { ...init, headers });
      };

      const ctx: ToolContext = {
        baseUrl,
        fetchImpl: forwardingFetch,
        auth,
        mode: 'remote',
      };

      // Dual-revision stateless serving. Modern 2026-07-28 traffic: a fresh
      // createMcpHandler per request (legacy:'reject' — the 2025 leg is served below
      // with JSON responses instead of the SDK's SSE-framed fallback). Both legs use
      // the SAME factory, so the two eras can never serve different tools.
      const {
        createMcpHandler,
        isLegacyRequest,
        WebStandardStreamableHTTPServerTransport,
        toNodeHandler,
        buildProvianMcpServer,
      } = await loadMcpRuntime();
      const onerror = (err: Error) => console.error('[MCP] handler error:', err);
      const modern = createMcpHandler(() => buildProvianMcpServer(() => ctx), { legacy: 'reject', onerror });
      res.on('close', () => {
        void modern.close();
      });

      /** One 2025-era exchange over a stateless transport that answers in JSON. */
      const serveLegacy = async (webReq: globalThis.Request, body: unknown): Promise<globalThis.Response> => {
        const server = buildProvianMcpServer(() => ctx);
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        transport.onerror = onerror;
        await server.connect(transport);
        try {
          return await transport.handleRequest(webReq, { parsedBody: body });
        } finally {
          void transport.close().catch(() => undefined);
          void server.close().catch(() => undefined);
        }
      };

      const serveOne = async (webReq: globalThis.Request, body: unknown): Promise<globalThis.Response> => {
        const shape = classifyRpc(body);
        if (shape.kind === 'request_missing_id') {
          return rpcErrorResponse(400, -32600, missingIdMessage(shape.method));
        }
        if (shape.kind === 'invalid') {
          return rpcErrorResponse(400, -32600, 'Invalid Request: the body is not a JSON-RPC 2.0 message.');
        }
        const message = shape.message;
        if (await isLegacyRequest(webReq, message)) return serveLegacy(webReq, message);
        return modern.fetch(webReq, { parsedBody: message });
      };

      const serveBatch = async (webReq: globalThis.Request, batch: unknown[]): Promise<globalThis.Response> => {
        if (batch.length === 0) {
          return rpcErrorResponse(400, -32600, 'Invalid Request: an empty batch holds no JSON-RPC message.');
        }
        const shapes = batch.map(classifyRpc);
        if (shapes.every(shape => shape.kind === 'notification' || shape.kind === 'response')) {
          return new globalThis.Response(null, { status: 202 });
        }
        // Sequential, backpressured JSON: keep at most one tool reply in flight,
        // and never reject a completed write because its reply is large.
        async function* replies(): AsyncGenerator<Uint8Array> {
          yield Buffer.from('[');
          let first = true;
          for (const shape of shapes) {
            if (shape.kind === 'notification' || shape.kind === 'response') continue;
            if (!first) yield Buffer.from(',');
            first = false;
            if (shape.kind === 'request_missing_id') {
              yield Buffer.from(JSON.stringify(rpcErrorObject(-32600, missingIdMessage(shape.method))));
            } else if (shape.kind === 'invalid') {
              yield Buffer.from(JSON.stringify(rpcErrorObject(-32600, 'Invalid Request: a batch element is not a JSON-RPC 2.0 message.')));
            } else {
              const reply = await serveLegacy(webReq, shape.message);
              const reader = reply.body?.getReader();
              if (!reader) continue;
              try {
                while (true) {
                  const chunk = await reader.read();
                  if (chunk.done) break;
                  yield chunk.value;
                }
              } finally { reader.releaseLock(); }
            }
          }
          yield Buffer.from(']');
        }
        return new globalThis.Response(Readable.toWeb(Readable.from(replies(), { objectMode: false })) as ReadableStream<Uint8Array>, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const firstTry = {
        fetch: async (request: globalThis.Request, options?: { parsedBody?: unknown }): Promise<globalThis.Response> => {
          const body = options?.parsedBody;
          const webReq = normalizedWebRequest(request);
          if (Array.isArray(body)) return serveBatch(webReq, body);
          return serveOne(webReq, body);
        },
      };

      bumpOpsCounter('mcp.calls');
        // express.json() has parsed a JSON body already; a body sent without a JSON
        // Content-Type is read here. Either way the handler gets it as parsedBody.
        await toNodeHandler(firstTry)(req, res, body);
    } catch (err) {
      bumpOpsCounter('mcp.errors');
      console.error('[MCP] /mcp request handling error:', err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  // Stateless mode has no server-initiated stream and no session to delete.
  // The gate runs first so unauthenticated callers see 404, never 405.
  const methodNotAllowed: RequestHandler = (req, res) => {
    const auth = parseForwardableAuth(req.headers.authorization);
    if (!admitOrLogRefusal(auth?.apiKey ?? null)) {
      res.status(404).json(notFound);
      return;
    }
    res
      .status(405)
      .set('Allow', 'POST')
      .json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Method not allowed. This MCP endpoint is stateless: POST JSON-RPC messages to /mcp.',
        },
        id: null,
      });
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);
}
