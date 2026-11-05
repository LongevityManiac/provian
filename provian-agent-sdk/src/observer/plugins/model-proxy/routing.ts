/**
 * model-proxy/routing — where an incoming shim request is forwarded, and which
 * model-API protocol it speaks. PURE (no I/O), so every route decision is
 * unit-tested against a table of real base-URL shapes.
 *
 * THE UPSTREAM IS PINNED, NEVER READ FROM THE REQUEST. Exactly like the x402
 * signer pins the USDC contract + EIP-712 domain rather than trusting the 402
 * body, this module maps a recognized provider to its CANONICAL upstream origin
 * (api.anthropic.com, api.openai.com, api.x.ai, generativelanguage.googleapis.com).
 * A request can never talk the shim into forwarding a bearer token / API key to an
 * arbitrary host: the host comes from the pinned table (or an operator-set
 * `PROVIAN_PROXY_UPSTREAM_<PROVIDER>` for a self-hosted gateway), not the wire.
 *
 * HOW THE PROVIDER IS DECIDED (in priority):
 * 1. A provider PREFIX on the path the agent/daemon repointed to
 * (`/anthropic`, `/openai`, `/xai`, `/gemini`) — authoritative, and the only
 * way to disambiguate xAI from OpenAI (both speak `/v1/chat/completions`).
 * 2. Otherwise, the request PATH (`/v1/messages` → anthropic; `/v1/chat/
 * completions|responses|embeddings` → openai; `…:generateContent` → gemini).
 * 3. `unknown` when neither resolves — the caller still forwards byte-exact when
 * it has an upstream (prefix or single configured override) and records a
 * structure-only fingerprint (never a silent passthrough that
 * witnesses nothing); with no resolvable upstream it fails closed (502).
 *
 * The path segment the prefix consumed is stripped; whatever remains is the
 * upstream path, forwarded unchanged so the transport is transparent.
 */

/** Loopback only — the shim is never a routable interface. */
export const MODEL_PROXY_BIND_HOST = '127.0.0.1';
/** Default port; distinct from the OTLP receiver (4318). */
export const MODEL_PROXY_DEFAULT_PORT = 4320;

export type ModelProvider = 'anthropic' | 'openai' | 'xai' | 'gemini' | 'grok' | 'grok_api';

/** The model-API protocol family a request/response pair speaks. */
export type ModelProtocol =
  | 'anthropic_messages'
  | 'openai_chat'
  | 'openai_responses'
  | 'openai_embeddings'
  | 'openai_completions'
  | 'gemini_generate'
  | 'unknown';

/** The canonical upstream origin for each provider (scheme + host). PINNED. */
export const CANONICAL_UPSTREAM: Record<ModelProvider, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
  xai: 'https://api.x.ai',
  gemini: 'https://generativelanguage.googleapis.com',
  // Grok Build's subscription (signed-in) transport: the CLI chat proxy. Its
  // built-in models speak the OpenAI Responses API under `/v1` (Grok's own
  // models cache: base_url https://cli-chat-proxy.grok.com/v1, api_backend
  // "responses"); Grok is repointed with `[endpoints] cli_chat_proxy_base_url`
  // = http://127.0.0.1:4320/grok/v1, so `/grok/v1/responses` → this origin +
  // `/v1/responses`. The session token rides through untouched.
  grok: 'https://cli-chat-proxy.grok.com',
  // Grok Build signed in with an xAI API key: `[endpoints] models_base_url` =
  // http://127.0.0.1:4320/grok-api/v1 → the xAI API. A prefix of its own (not
  // `/xai`) so the daemon's "Grok is proxy-routed" state keys on GROK's
  // traffic only, never on another xAI client's on the same machine.
  grok_api: 'https://api.x.ai',
};

/** The path prefix the agent/daemon may repoint to, per provider. */
export const PROVIDER_PREFIX: Record<ModelProvider, string> = {
  anthropic: '/anthropic',
  openai: '/openai',
  xai: '/xai',
  gemini: '/gemini',
  grok: '/grok',
  grok_api: '/grok-api',
};

/** Env var that overrides a provider's upstream origin (a self-hosted gateway /
 * Azure / an enterprise proxy). Value is an origin like `https://host[:port]`. */
export function upstreamOverrideEnvVar(provider: ModelProvider): string {
  return `PROVIAN_PROXY_UPSTREAM_${provider.toUpperCase()}`;
}

export interface ResolvedRoute {
  /** The provider the request was routed to, or null when unresolvable. */
  provider: ModelProvider | null;
  /** The protocol family, for the parser. `unknown` → fingerprint, still forward. */
  protocol: ModelProtocol;
  /** Upstream origin (scheme://host[:port]) to forward to, or null when unknown. */
  upstreamOrigin: string | null;
  /** The path to send upstream (prefix stripped), including query string. */
  upstreamPath: string;
  /** True when the provider came from an explicit path prefix (authoritative). */
  fromPrefix: boolean;
}

/** Strip a leading `/<provider>` prefix; returns [provider|null, remainingPath]. */
function splitProviderPrefix(path: string): [ModelProvider | null, string] {
  for (const provider of Object.keys(PROVIDER_PREFIX) as ModelProvider[]) {
    const pfx = PROVIDER_PREFIX[provider];
    if (path === pfx) return [provider, '/'];
    if (path.startsWith(pfx + '/')) return [provider, path.slice(pfx.length)];
  }
  return [null, path];
}

/**
 * Detect the protocol family from a bare upstream path (prefix already stripped).
 * Keys ONLY on the path shape — never a provider name — so a custom gateway that
 * speaks the OpenAI protocol is recognized as `openai_*`.
 */
export function detectProtocol(path: string): ModelProtocol {
  const p = path.split('?')[0];
  if (/(^|\/)v1\/messages(\/|$)/.test(p)) return 'anthropic_messages';
  if (/(^|\/)(v1|openai\/v1)\/chat\/completions(\/|$)/.test(p)) return 'openai_chat';
  if (/(^|\/)(v1|openai\/v1)\/responses(\/|$)/.test(p)) return 'openai_responses';
  if (/(^|\/)(v1|openai\/v1)\/embeddings(\/|$)/.test(p)) return 'openai_embeddings';
  if (/(^|\/)(v1|openai\/v1)\/completions(\/|$)/.test(p)) return 'openai_completions';
  // Gemini: /v1beta/models/<model>:generateContent (and :streamGenerateContent).
  if (/:(stream)?generatecontent(\?|$)/i.test(p) || /:(stream)?generateContent/.test(path)) {
    return 'gemini_generate';
  }
  return 'unknown';
}

/** The default provider a protocol maps to when there is no explicit prefix. xAI
 * shares OpenAI's protocol and is only reachable by prefix, so an unprefixed
 * OpenAI-shaped request routes to OpenAI. */
function providerForProtocol(protocol: ModelProtocol): ModelProvider | null {
  switch (protocol) {
    case 'anthropic_messages': return 'anthropic';
    case 'openai_chat':
    case 'openai_responses':
    case 'openai_embeddings':
    case 'openai_completions': return 'openai';
    case 'gemini_generate': return 'gemini';
    default: return null;
  }
}

/**
 * Resolve where to forward and how to parse. `env` supplies optional per-provider
 * upstream overrides. Never throws.
 */
export function resolveRoute(
  reqPath: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedRoute {
  const [prefixProvider, rest] = splitProviderPrefix(reqPath);
  const protocol = detectProtocol(rest);
  const provider = prefixProvider ?? providerForProtocol(protocol);
  const upstreamOrigin = provider
    ? (asOrigin(env[upstreamOverrideEnvVar(provider)]) ?? CANONICAL_UPSTREAM[provider])
    : null;
  return {
    provider,
    protocol,
    upstreamOrigin,
    upstreamPath: rest,
    fromPrefix: prefixProvider !== null,
  };
}

/** Validate + normalize an operator-supplied upstream origin. Only http(s) with a
 * host, no path — a bad value is ignored (falls back to the pinned canonical). */
export function asOrigin(value: string | undefined): string | null {
  if (!value || typeof value !== 'string') return null;
  try {
    const u = new URL(value.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (!u.hostname) return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}
