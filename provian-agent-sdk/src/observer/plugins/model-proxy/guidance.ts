/**
 * model-proxy/guidance — the repoint instructions the agent (or a human) executes
 * to route its model traffic through the Lane 5 shim .
 *
 * "The agent repoints itself" this is INSTRUCTIONS the agent runs, not code that
 * guesses a harness's config file. Each provider's well-known base-URL env var is
 * set to the shim's loopback address with the provider path prefix, and the agent
 * restarts. The shim then witnesses every model turn transparently. PURE (a table
 * + string builders), so the exact lines are testable and shared by bootstrap,
 * doctor, register-device, and the `provian proxy` help.
 */

import { MODEL_PROXY_BIND_HOST, MODEL_PROXY_DEFAULT_PORT, PROVIDER_PREFIX, type ModelProvider } from './routing';

/** The well-known base-URL env var each provider's SDK/CLI reads. When more than
 * one name is in the wild, the canonical/most-common is first. */
export const PROVIDER_BASE_URL_ENV: Record<ModelProvider, string[]> = {
  anthropic: ['ANTHROPIC_BASE_URL'],
  openai: ['OPENAI_BASE_URL', 'OPENAI_API_BASE'],
  xai: ['XAI_BASE_URL'],
  gemini: ['GOOGLE_GEMINI_BASE_URL', 'GEMINI_BASE_URL'],
  // Grok Build (signed in): its CLI chat proxy base, which INCLUDES `/v1`. The
  // daemon writes the durable form itself (`~/.grok/config.toml [endpoints]
  // cli_chat_proxy_base_url`, grok-proxy-config.ts); this env var is the
  // per-shell equivalent Grok also honors.
  grok: ['GROK_CLI_CHAT_PROXY_BASE_URL'],
  // Grok Build on an API key: repointed only through config.toml models_base_url.
  grok_api: [],
};

/** The shim base URL a provider should be pointed at (loopback + provider prefix). */
export function proxyBaseUrl(provider: ModelProvider, port: number = MODEL_PROXY_DEFAULT_PORT): string {
  // Grok's CLI chat proxy base carries the API version (`…/v1`); every other
  // provider's SDK appends its own version path to the base URL.
  const suffix = provider === 'grok' || provider === 'grok_api' ? '/v1' : '';
  return `http://${MODEL_PROXY_BIND_HOST}:${port}${PROVIDER_PREFIX[provider]}${suffix}`;
}

export interface RepointGuidance {
  provider: ModelProvider;
  /** The exact `export VAR=…` lines (the first env name per provider). */
  exportLines: string[];
  /** All env-var names that would work (for docs). */
  envVars: string[];
  baseUrl: string;
}

/** Repoint guidance for one provider. */
export function repointGuidanceFor(provider: ModelProvider, port: number = MODEL_PROXY_DEFAULT_PORT): RepointGuidance {
  const baseUrl = proxyBaseUrl(provider, port);
  const envVars = PROVIDER_BASE_URL_ENV[provider];
  return {
    provider,
    envVars,
    baseUrl,
    exportLines: [`export ${envVars[0]}=${baseUrl}`],
  };
}

/**
 * The providers whose repoint is a shell env var the agent/human sets (the
 * profile block, bootstrap and doctor print these). Grok Build is NOT one: its
 * processes are often spawned by xAI's own harness and never read a login
 * shell's profile, so the daemon repoints Grok DURABLY in `~/.grok/config.toml`
 * (`grok-proxy-config.ts`) and records the repoint as its own state.
 */
export const ENV_REPOINT_PROVIDERS: readonly ModelProvider[] =
  (Object.keys(PROVIDER_PREFIX) as ModelProvider[]).filter((p) => p !== 'grok' && p !== 'grok_api');

/** Repoint guidance for every env-repointed provider (bootstrap/doctor print this). */
export function allRepointGuidance(port: number = MODEL_PROXY_DEFAULT_PORT): RepointGuidance[] {
  return ENV_REPOINT_PROVIDERS.map((p) => repointGuidanceFor(p, port));
}

/**
 * The console block an agent/human sees telling it how to be witnessed through
 * the model-endpoint proxy. Returns the lines (caller prefixes indentation).
 */
export function repointInstructionLines(port: number = MODEL_PROXY_DEFAULT_PORT): string[] {
  const lines = [
    'Model-endpoint proxy (Lane 5): witness EVERY model turn — tool calls + tokens —',
    'regardless of harness. Point your model base URL at the local shim and restart:',
    '',
  ];
  for (const g of allRepointGuidance(port)) {
    lines.push(`  ${g.provider}: ${g.exportLines[0]}`);
  }
  lines.push('  grok (Grok Build, signed in): repointed automatically in ~/.grok/config.toml');
  lines.push('');
  lines.push('The shim forwards byte-exact to the real API (your key rides through untouched,');
  lines.push('never logged). Turn it off with PROVIAN_MODEL_PROXY=0.');
  return lines;
}
