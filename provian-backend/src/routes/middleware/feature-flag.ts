/**
 * feature-flag — the ONE reader of the `ENABLE_<FEATURE>` env gates on the agent
 * Promise and Pool rails.
 *
 * `requireFeature` in `routes/agent-promises.ts` / `routes/agent-pools.ts` 503s a
 * request unless this returns true, and `GET /v1/ecosystem` reports the same rails'
 * status from this same call — so discovery can never say `env_gated` while the
 * routes are open (the finding: `ENABLE_PROMISES` is on in production,,
 * yet the discovery block was a hardcoded `env_gated`). Read per call, never cached,
 * exactly as the gate reads it.
 */
export type GatedFeature = 'promises' | 'pools';

export function isFeatureEnabled(feature: GatedFeature, env: NodeJS.ProcessEnv = process.env): boolean {
  return env[`ENABLE_${feature.toUpperCase()}`] === 'true';
}
