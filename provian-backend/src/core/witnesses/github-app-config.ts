/**
 * Witness 3 - GitHub App webhook secret config.
 *
 * The GitHub App uses a SINGLE APP-WIDE webhook secret (not per-install).
 * GitHub signs every webhook delivery with HMAC-SHA256 keyed by this
 * secret; the relay's future inbound verifier reads it from env and
 * uses it directly for `X-Hub-Signature-256` verification.
 *
 * Storing the secret in the env / secret-manager layer (not in
 * Firestore) sidesteps the missing-KMS problem for per-row encryption
 * entirely: there is no per-row sensitive value. This mirrors how
 * other backend secrets are loaded - see TOKEN_SIGNING_SECRET in
 * server.ts (fail-loud presence check + module-top constant) and
 * `loadFoundationMembershipConfig` in core/foundation-membership/client.ts
 * (feature-flagged loader with format validation, fail-loud when enabled
 * but mis-configured). This module follows the foundation-membership
 * pattern because the GitHub App is a feature that may be off in some
 * environments (dev, staging without an app installed).
 *
 * **Nothing consumes this config yet.** The inbound webhook verifier
 * lands in step 4b (separate PR) and will import `loadGitHubAppConfig()`
 * + call it at server startup, throwing if the feature is enabled but
 * the secret is unset. This step 4a exposes the loader so step 4b has
 * nothing to invent.
 */

const HEX_LIKE = /^[A-Za-z0-9_\-+/=]+$/;
const MIN_SECRET_LENGTH = 32;

/**
 * Loaded config. When `enabled: false`, no other field is populated -
 * the inbound webhook handler refuses with 503 in that state.
 *
 * `appSlug` is independent of `enabled` - it's only consulted by the
 * connect/disconnect flow (step 4c). The webhook flow itself doesn't
 * need the slug. An environment can have the webhook live (secret set,
 * slug unset) without exposing the connect flow; the connect endpoints
 * return 503 when `appSlug == null`.
 */
export interface GitHubAppConfig {
  enabled: boolean;
  /** App-wide webhook secret. Present only when enabled. */
  webhookSecret: string | null;
  /**
   * GitHub App slug from `https://github.com/apps/<slug>`. Used to
   * construct the install URL the connect CLI hands to the user's
   * browser. Independent of `enabled` - see above.
   */
  appSlug: string | null;
}

/**
 * Load the GitHub App config from env. Read on server startup by the
 * future verifier; do not call from request handlers (read-once at
 * module load time is the existing pattern).
 *
 * Behavior:
 * - GITHUB_APP_WEBHOOK_SECRET unset → returns `{ enabled: false, webhookSecret: null }`.
 *   The feature is off; the verifier will refuse to handle inbound
 *   deliveries.
 * - GITHUB_APP_WEBHOOK_SECRET set and well-formed → returns
 *   `{ enabled: true, webhookSecret }`.
 * - GITHUB_APP_WEBHOOK_SECRET set but malformed (too short or contains
 *   characters outside the standard base64/hex/url-safe alphabet) →
 *   throws. Fail-loud - a webhook secret that can't be HMAC-keyed
 *   correctly will silently break every delivery, which is worse than
 *   refusing to boot.
 *
 * The min-length / charset checks are intentionally loose. GitHub
 * accepts any string as a webhook secret, but anything under 32 chars
 * is too short to be cryptographically credible, and characters outside
 * the standard set usually indicate a copy-paste of "<set me>" or a
 * stray newline from a misformatted secret-manager value.
 */
export function loadGitHubAppConfig(): GitHubAppConfig {
  const raw = process.env.GITHUB_APP_WEBHOOK_SECRET;
  const slug = loadAppSlug();

  if (raw == null || raw.length === 0) {
    return { enabled: false, webhookSecret: null, appSlug: slug };
  }

  if (raw.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `GITHUB_APP_WEBHOOK_SECRET is set but too short (${raw.length} chars, minimum ${MIN_SECRET_LENGTH}). ` +
        `Generate at least 32 random bytes (hex or base64) and set the variable to the result.`,
    );
  }

  if (!HEX_LIKE.test(raw)) {
    throw new Error(
      `GITHUB_APP_WEBHOOK_SECRET is set but contains characters outside the standard ` +
        `[A-Za-z0-9_\\-+/=] alphabet. Check for whitespace, quotes, or placeholder text leaked from ` +
        `the secret-manager value.`,
    );
  }

  return { enabled: true, webhookSecret: raw, appSlug: slug };
}

/**
 * GitHub App slug as it appears in `https://github.com/apps/<slug>`. The
 * connect flow constructs the install URL from this; if it's unset,
 * the connect endpoints refuse (503) while the inbound webhook
 * continues to work independently.
 *
 * Accepts the GitHub-permitted character set (lowercase alphanumerics
 * and hyphens, no leading/trailing hyphen). Rejects anything that would
 * produce a malformed URL or pass through unescaped - defense in depth
 * even though the value comes from a trusted env var.
 */
const APP_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function loadAppSlug(): string | null {
  const raw = process.env.GITHUB_APP_SLUG;
  if (raw == null || raw.length === 0) return null;
  if (!APP_SLUG_RE.test(raw)) {
    throw new Error(
      `GITHUB_APP_SLUG is set but malformed (got: "${raw}"). Expected lowercase alphanumerics ` +
        `and hyphens (no leading/trailing hyphen), matching the slug in https://github.com/apps/<slug>.`,
    );
  }
  return raw;
}
