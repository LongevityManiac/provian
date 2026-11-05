/** Agent-only proxy witness for programs without session files. Byte-exact forwarding. */
import * as http from 'http';
import * as https from 'https';
import { validateEgressTarget } from '../../egress-guard';
import { egressResolver } from '../../guarded-fetch';
import { pinnedConnector } from '../../pinned-connection';
import * as zlib from 'zlib';
import { createHash } from 'crypto';
import type { ObserverPlugin, PECommitOutcome } from './PluginInterface';
import type { ProvianObserver } from '../ProvianObserver';
import type { PluginContribution, PluginPE, SessionState } from '../types';
import {
  MODEL_PROXY_BIND_HOST, MODEL_PROXY_DEFAULT_PORT, resolveRoute, type ResolvedRoute,
} from './model-proxy/routing';
import {
  StreamingTurnParser, parseResponseJson, parseRequestToolSchemas,
  type ModelTurnObservation, type RequestToolSchemas,
} from './model-proxy/parse';
import { screenBrowserAndHost } from './loopback-guard';
import { ProgramWitnessRegistry } from '../program-witness';
import { ProgramProxyTurns } from './model-proxy/program-turns';
import { PeerAttributor } from '../peer-process';
import { listenWithRetry } from './port-retry';

/** Cap on a buffered NON-STREAMING RESPONSE body for OBSERVATION (never affects
 * the forwarded stream, which is unbounded; the REQUEST is never buffered at all).
 * Beyond it, the turn is not parsed — forwarded fine, just not witnessed. */

/** Hop-by-hop headers never forwarded upstream (RFC 7230 §6.1). `content-length`
 * is NOT here: the request is piped byte-exact, so the client's own
 * `content-length` is preserved to keep upstream framing identical. A client that
 * used `transfer-encoding: chunked` (stripped as hop-by-hop) is re-framed by the
 * transport. `host` is replaced with the pinned upstream host. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
]);

/** A structure-only record of traffic the shim forwarded but could not parse
 * (a fingerprint to capture-health, never a silent witness of nothing). */
export interface UnrecognizedProtocolFingerprint {
  /** sha256 over (provider-or-none, protocol, method) — content-free, stable. */
  fingerprint: string;
  provider: string | null;
  method: string;
  count: number;
}

export interface ModelProxyConfig {
  port?: number;
  programRegistry?: ProgramWitnessRegistry;
  journalPath?: string;
  peerAttributor?: PeerAttributor;
  /** Bytes the observation COPY of a request or response may hold; default `MODEL_PROXY_OBSERVATION_CAP_BYTES`. */
  observationCapBytes?: number;
}

/**
 * The observation tee is a COPY the proxy keeps beside the forwarded bytes, so it is bounded: a
 * body past this size still forwards byte-exact, but its copy is dropped (request: no tool
 * schemas for the turn; response: the turn is not witnessed) instead of growing without limit
 * for every in-flight call (2026-10-17 bug check). Far above any model response — a maximal
 * completion is well under a megabyte — it exists only as a memory bound.
 */
export const MODEL_PROXY_OBSERVATION_CAP_BYTES = 32 * 1024 * 1024;

export class ModelProxyPlugin implements ObserverPlugin {
  readonly name = 'model_proxy';
  private observer!: ProvianObserver;
  private server: http.Server | null = null;
  private readonly port: number;
  private readonly programs: ProgramWitnessRegistry;
  private readonly turns: ProgramProxyTurns;
  private readonly peers: PeerAttributor;
  private readonly observationCapBytes: number;
  private listening = false;
  private binding: { retry: () => void; cancel: () => void } | null = null;
  private readonly providersSeen = new Set<string>();
  private readonly providerLastSeenAtMs = new Map<string, number>();

  // Self-diagnosis state.
  private turnsEverSeen = false;
  private lastTurnAtMs: number | null = null;
  private readonly unrecognized = new Map<string, UnrecognizedProtocolFingerprint>();

  constructor(config: ModelProxyConfig = {}) {
    this.port = config.port ?? MODEL_PROXY_DEFAULT_PORT;
    this.programs = config.programRegistry ?? new ProgramWitnessRegistry();
    this.turns = new ProgramProxyTurns(config.journalPath);
    this.peers = config.peerAttributor ?? new PeerAttributor({ identifyProgram: p => this.programs.identify(p) });
    this.observationCapBytes = config.observationCapBytes ?? MODEL_PROXY_OBSERVATION_CAP_BYTES;
  }

  async init(observer: ProvianObserver): Promise<void> {
    this.observer = observer;
  }

  async start(): Promise<void> {
    // Tool turns an earlier daemon recorded but never saw committed: resubmitted under the same
    // idempotency key (the PE store answers with the PE it already recorded, if it did).

    this.binding?.cancel();
    const binding = listenWithRetry({
      create: () => {
        const server = http.createServer((req, res) => this.handle(req, res));
        server.on('clientError', (_err, socket) => { try { socket.destroy(); } catch { /* ok */ } });
        return server;
      },
      port: this.port,
      host: MODEL_PROXY_BIND_HOST,
      onBound: (server) => {
        this.server = server;
        this.listening = true;
        this.observer.log('info', `model proxy listening on http://${MODEL_PROXY_BIND_HOST}:${this.port}`, {
          hint: 'point your model base URL at /openai, /anthropic, /xai, or /gemini here to be witnessed',
        });
      },
      onInUse: (first) => {
        if (first) this.observer.log('warn', `model proxy: listen failed on ${this.port}`, {
          hint: 'another process holds the port; proxy lane disabled',
        });
      },
      onError: (err) => this.observer.log('warn', `model proxy: listen failed on ${this.port}`, { error: err.message }),
    });
    this.binding = binding;
    await binding.first;
  }

  async stop(): Promise<void> {
    this.binding?.cancel();
    this.binding = null;
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
      this.listening = false;
    }
  }
  tick(_session: SessionState | null): PluginContribution | null { return null; }
  drainPEs(): PluginPE[] { return this.turns.drain(); }
  onCommitted(pe: PluginPE, outcome: PECommitOutcome): void { this.turns.commit(pe, outcome === 'failed'); }

  // --- capture-health getters (the proxy witness lane's live state) ----------
  isListening(): boolean { return this.listening; }
  /** The lock holder stopped a stray observer: if the port was taken at start, try it again now. */
  rebindIfWaiting(): void { this.binding?.retry(); }
  hasSeenTurns(): boolean { return this.turnsEverSeen; }
  /** Has this daemon proxied a witnessed turn on this provider's prefix route? */
  hasSeenProviderTurn(provider: string): boolean { return this.providersSeen.has(provider); }
  /** Wall time this daemon last proxied a witnessed turn on this provider's prefix route, or null. */
  lastProviderTurnAtMs(provider: string): number | null { return this.providerLastSeenAtMs.get(provider) ?? null; }
  getLastTurnAtMs(): number | null { return this.lastTurnAtMs; }
  boundPort(): number | null {
    const addr = this.server?.address();
    return addr && typeof addr === 'object' ? addr.port : null;
  }
  unrecognizedFingerprints(): UnrecognizedProtocolFingerprint[] {
    return [...this.unrecognized.values()].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
  }

  // --------------------------------------------------------------------------

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    // a web page in a browser can never drive this shim. Browser-only
    // headers (Origin, Sec-Fetch-Site/Dest/User) and a non-loopback Host (DNS
    // rebinding) are refused 403 BEFORE anything is forwarded or witnessed. Local
    // CLIs/SDKs (Node, Python, Rust, Go http clients) send none of them. No
    // Content-Type rule here, deliberately: the shim forwards arbitrary vendor
    // traffic byte-exact (multipart audio/file uploads, Gemini binary uploads), so
    // requiring JSON would break transparency; every browser sends
    // Origin on any non-GET/HEAD request, so the browser vector is closed above.
    const refused = screenBrowserAndHost(req, req.socket.localPort);
    if (refused) {
      res.writeHead(refused.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'provian_proxy', message: refused.error } }));
      this.drainRequest(req);
      return;
    }
    const route = resolveRoute(req.url ?? '/', process.env);
    if (!route.upstreamOrigin) {
      // No prefix and an unrecognizable path → we cannot know the real upstream,
      // so we cannot transparently forward. Fail closed with a clear, content-free
      // error rather than guess a destination for a bearer token.
      this.fingerprint(route, req.method ?? 'GET');
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'provian_proxy', message: 'no upstream resolvable — set a provider path prefix (/openai, /anthropic, /xai, /gemini) on your model base URL' } }));
      this.drainRequest(req);
      return;
    }
    // Forward the request STRAIGHT THROUGH — never buffered. Piping is byte-exact
    // and UNBOUNDED (a request of any size, including one past the observe cap,
    // forwards intact; ) and never drains the stream for observation. We
    // must not read the request body anyway — it carries prompt content;
    // everything we witness (tool calls, tokens, model) is in the RESPONSE.
    void this.forward(req, res, route, this.peers.attribute(req.socket)).catch(() => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"provian_proxy_egress_refused"}}');
      this.drainRequest(req);
    });
  }

  /** Drain a request body we are not forwarding, so the socket is not left open. */
  private drainRequest(req: http.IncomingMessage): void {
    req.on('data', () => { /* discard */ });
    req.on('end', () => { /* ok */ });
    req.on('error', () => { /* ok */ });
  }

  private async forward(
    req: http.IncomingMessage, res: http.ServerResponse, route: ResolvedRoute,
    sender: Promise<string | null>,
  ): Promise<void> {
    let upstreamUrl: URL;
    try { upstreamUrl = new URL(route.upstreamOrigin! + route.upstreamPath); }
    catch { res.writeHead(502, { 'content-type': 'application/json' }); res.end('{"error":{"message":"provian_proxy_bad_upstream"}}'); this.drainRequest(req); return; }
    const guard = await validateEgressTarget(upstreamUrl.toString(), { resolveHost: egressResolver(upstreamUrl.toString()) });
    if (!guard.ok || !guard.resolvedIps?.length) throw new Error('proxy egress refused');
    const approved = guard.resolvedIps;

    // Forward headers verbatim EXCEPT hop-by-hop + host. The API key (Authorization
    // / x-api-key / x-goog-api-key / anthropic-version / …) rides here untouched
    // and is never logged. `content-length` is preserved from the client (not in
    // HOP_BY_HOP) because the request is piped byte-exact.
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      if (HOP_BY_HOP.has(k.toLowerCase())) continue;
      headers[k] = Array.isArray(v) ? v.join(', ') : v;
    }
    headers['host'] = upstreamUrl.host;

    const started = Date.now();
    const transport = upstreamUrl.protocol === 'http:' ? http : https;
    // A private fresh agent prevents ambient Node proxy agents and pooled sockets from
    // bypassing approval. Configured forward proxies use IP-pinned CONNECT tunnels.
    const connector = await pinnedConnector(upstreamUrl, approved);
    const agent = upstreamUrl.protocol === 'http:' ? new http.Agent({ keepAlive: false }) : new https.Agent({ keepAlive: false });
    agent.createConnection = (options, callback) => {
      connector({ hostname: upstreamUrl.hostname, protocol: upstreamUrl.protocol, port: String(options.port ?? upstreamUrl.port), servername: upstreamUrl.hostname }, (err, socket) => callback?.(err, socket!));
      return undefined;
    };

    // OBSERVE a bounded COPY of the REQUEST body to read the tool DEFINITIONS only
    // (generic schema-driven origin classification). The request is
    // still piped byte-exact and unbounded to upstream below; this tee never delays
    // or mutates it. STRUCTURE ONLY: `parseRequestToolSchemas` reads just the
    // `tools[]` array (parameter names/types/formats), NEVER messages/system/prompt
    // content, and the buffered copy is discarded after parsing — it is
    // never stored on the observation, the PE, or a log. Over the cap ⇒ no schemas
    // (graceful: schema-driven capture simply does not run for that turn).
    const reqContentEncoding = String(req.headers['content-encoding'] ?? '').toLowerCase();
    const reqChunks: Buffer[] = [];
    let reqObserved = 0;
    let reqOverflow = false;
    req.on('data', (chunk: Buffer) => {
      if (reqOverflow) return;
      reqObserved += chunk.length;
      if (reqObserved > this.observationCapBytes) { reqOverflow = true; reqChunks.length = 0; return; }
      reqChunks.push(chunk);
    });

    const upstreamReq = transport.request(
      upstreamUrl,
      { method: req.method, headers, agent },
      (upRes) => {
        // Mirror the upstream status + headers to the client exactly.
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        const contentType = String(upRes.headers['content-type'] ?? '').toLowerCase();
        const contentEncoding = String(upRes.headers['content-encoding'] ?? '').toLowerCase();
        // Streaming is decided by the RESPONSE, never the request: an SSE stream is
        // `text/event-stream`. Everything else (application/json — a Gemini
        // `:generateContent` object OR a `:streamGenerateContent` JSON array,
        // and every non-streaming turn) is buffered and parsed whole. Deciding
        // from the request body mis-routed non-streaming Gemini to the SSE parser,
        // which could not parse a bare JSON object → the turn was never witnessed.
        const streamed = contentType.includes('text/event-stream');
        const parser = streamed ? new StreamingTurnParser(route.protocol) : null;
        const obsChunks: Buffer[] = [];
        let obsObserved = 0;
        let obsOverflow = false;
        // Trust Layer §2.3: the RESPONSE DIGEST — sha256 over the exact bytes forwarded to the
        // harness. A digest, never content; it is what a consumer's captured hash resolves against.
        const responseHash = createHash('sha256');

        upRes.on('data', (chunk: Buffer) => {
          // 1) Forward immediately — byte-exact, no delay. This is the wire.
          res.write(chunk);
          try { responseHash.update(chunk); } catch { /* observation only */ }
          // 2) Observe a COPY, best-effort, never touching the forwarded bytes — bounded.
          try {
            if (obsOverflow) return;
            obsObserved += chunk.length;
            if (obsObserved > this.observationCapBytes) { obsOverflow = true; obsChunks.length = 0; return; }
            if (parser) {
              // Streaming SSE is identity-encoded; feed the tee directly.
              if (!contentEncoding || contentEncoding === 'identity') parser.push(chunk);
            } else {
              obsChunks.push(chunk);
            }
          } catch { /* observation must never break forwarding */ }
        });
        upRes.on('end', () => {
          try { res.end(); } catch { /* ok */ }
          const endedAt = Date.now();
          // The sender is known (or the lookup timed out) before the turn is recorded or landed.
          void sender.catch(() => null).then((harness) => { try {
            if (obsOverflow) {
              this.observer.log('warn', 'model proxy: response exceeded the observation cap; forwarded but not witnessed', {
                provider: route.provider, cap_bytes: this.observationCapBytes,
              });
              return;
            }
            let observed: ModelTurnObservation;
            if (parser) {
              observed = parser.finish();
            } else {
              const body = decodeBody(Buffer.concat(obsChunks), contentEncoding);
              observed = parseResponseJson(route.protocol, safeParseJson(body));
            }
            // Tool DEFINITIONS from the request (structure only) for schema-driven
            // origin classification. Absent when the request overflowed the cap.
            const reqJson = reqOverflow ? null : safeParseJson(decodeBody(Buffer.concat(reqChunks), reqContentEncoding));
            const toolSchemas = parseRequestToolSchemas(reqJson);
            this.onTurn(route, observed, started, endedAt, toolSchemas, `sha256:${responseHash.digest('hex')}`, harness);
          } catch (error) { this.observer.log('warn', 'model proxy: observation failed', { error: String(error) }); } });
        });
        upRes.on('error', () => { try { res.end(); } catch { /* ok */ } });
        // Aborted mid-response ('close' without 'end'): nothing will be recorded.
      },
    );

    upstreamReq.on('error', (err) => {
      // Upstream unreachable — pass a clean, content-free 502 to the client
      // (transparent within what a proxy can do; the harness sees an upstream
      // fault, exactly as it would talking to a flaky endpoint directly).
      this.observer.log('warn', 'model proxy: upstream request failed', {
        provider: route.provider, error: (err as Error).message,
      });
      try { res.writeHead(502, { 'content-type': 'application/json' }); res.end('{"error":{"message":"provian_proxy_upstream_error"}}'); } catch { /* ok */ }
    });

    // Stream the request body straight to upstream — byte-exact and UNBOUNDED, so
    // a request of any size forwards intact. The bounded `req.on('data')` tee above
    // observes a COPY (tool DEFINITIONS only) and never gates or mutates this pipe.
    // A client disconnect mid-body tears down the upstream request cleanly.
    req.on('error', () => { try { upstreamReq.destroy(); } catch { /* ok */ } });
    req.pipe(upstreamReq);
  }

  private onTurn(route: ResolvedRoute, observed: ModelTurnObservation, startedMs: number, endedMs: number,
    schemas: RequestToolSchemas | undefined, digest: string, program: string | null): void {
    if (!this.programs.allows(program, 'model_proxy')) return;
    if (!observed.recognized) { this.fingerprint(route, 'POST'); return; }
    this.turnsEverSeen = true; this.lastTurnAtMs = endedMs;
    if (route.provider) { this.providersSeen.add(route.provider); this.providerLastSeenAtMs.set(route.provider, endedMs); }
    if(observed.toolCalls.length) this.programs.captured?.(program!,'model_proxy',endedMs);
    if (observed.toolCalls.length) this.observer.log('info','model proxy: tool turn witnessed',{program,tool_count:observed.toolCalls.length});
    this.turns.observe(program!, observed, { start: startedMs, end: endedMs,
      witness: this.observer.observerDeviceWitness?.() ?? null, schemas, digest });
  }

  private fingerprint(route: ResolvedRoute, method: string): void {
    const provider = route.provider ?? null;
    const fp = createHash('sha256')
      .update([provider ?? 'none', route.protocol, method].join('\x1f'), 'utf8')
      .digest('hex').slice(0, 16);
    const existing = this.unrecognized.get(fp);
    if (existing) { existing.count += 1; return; }
    if (this.unrecognized.size < 256) {
      this.unrecognized.set(fp, { fingerprint: fp, provider, method, count: 1 });
    }
  }
}

/** Decode a buffered response body for OBSERVATION only, honoring content-encoding.
 * Never throws — an undecodable body yields empty (unrecognized → fingerprint). */
function decodeBody(buf: Buffer, encoding: string): Buffer {
  try {
    if (encoding.includes('br')) return zlib.brotliDecompressSync(buf);
    if (encoding.includes('gzip')) return zlib.gunzipSync(buf);
    if (encoding.includes('deflate')) return zlib.inflateSync(buf);
  } catch { return Buffer.alloc(0); }
  return buf;
}

function safeParseJson(buf: Buffer): unknown {
  try { return JSON.parse(buf.toString('utf8')); } catch { return null; }
}

/**
 * Resolve the plugin's config from env, or null when opted out. DEFAULT ON
 * : the agent-only listener starts when selected and does nothing
 * until traffic is repointed at it. `PROVIAN_MODEL_PROXY=0` (or false/off/no)
 * turns it off; `PROVIAN_MODEL_PROXY_PORT` overrides the port.
 */
export function resolveModelProxyConfig(
  env: NodeJS.ProcessEnv = process.env,
): ModelProxyConfig | null {
  const v = (env.PROVIAN_MODEL_PROXY ?? '').toLowerCase();
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return null;
  const port = env.PROVIAN_MODEL_PROXY_PORT ? Number(env.PROVIAN_MODEL_PROXY_PORT) : MODEL_PROXY_DEFAULT_PORT;
  return {
    port: Number.isFinite(port) && port > 0 ? Math.floor(port) : MODEL_PROXY_DEFAULT_PORT,
  };
}
