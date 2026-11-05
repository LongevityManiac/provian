/**
 * Witness 3 - GitLab webhook secret config.
 *
 * GitLab project (and group) webhooks authenticate with a user-configured
 * **secret token** sent verbatim in the `X-Gitlab-Token` header on every
 * delivery. Unlike GitHub - which HMAC-signs the body with an app-wide
 * secret - GitLab does NOT sign the payload; verification is a constant-time
 * comparison of the inbound token against the configured secret. (See
 * gitlab-webhook.ts verifyGitLabToken for the compare.)
 *
 * This mirrors github-app-config.ts: an env/secret-manager-loaded value, no
 * per-row secret in Firestore, fail-loud on a malformed secret, feature off
 * when unset. Reusing the same shape keeps the two forge connectors
 * operationally identical for the relay operator.
 *
 * GitLab self-hosted is the point of this connector (compliance /
 * data-residency builders who cannot use github.com). The receiver is
 * instance-agnostic: a self-hosted GitLab that can reach the relay URL
 * delivers webhooks the same way gitlab.com does. `GITLAB_BASE_URL` is
 * optional and informational only (used by the connect/docs surface, not the
 * webhook verifier).
 */

const TOKEN_LIKE = /^[A-Za-z0-9_\-+/=]+$/;
const MIN_SECRET_LENGTH = 32;

export interface GitLabAppConfig {
  enabled: boolean;
  /** App-wide webhook secret token (the value pasted into a GitLab project's webhook "Secret token"). Present only when enabled. */
  webhookSecret: string | null;
  /**
   * Base URL of the GitLab instance (e.g. https://gitlab.com or a
   * self-hosted host). Informational - the webhook receiver does not call
   * back to GitLab (Tier A: no stored credential, no outbound token use).
   * Null when unset.
   */
  baseUrl: string | null;
}

/**
 * Load the GitLab webhook config from env. Read once at server startup
 * (matches the github-app-config read-once pattern); do not call per request.
 *
 * - GITLAB_WEBHOOK_SECRET unset → { enabled: false }. Receiver returns 503.
 * - set and well-formed → { enabled: true, webhookSecret }.
 * - set but malformed (too short or out-of-charset) → throws (fail-loud): a
 *   token that can't match what GitLab sends silently breaks every delivery.
 */
export function loadGitLabAppConfig(): GitLabAppConfig {
  const raw = process.env.GITLAB_WEBHOOK_SECRET;
  const baseUrl = loadBaseUrl();

  if (raw == null || raw.length === 0) {
    return { enabled: false, webhookSecret: null, baseUrl };
  }

  if (raw.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `GITLAB_WEBHOOK_SECRET is set but too short (${raw.length} chars, minimum ${MIN_SECRET_LENGTH}). ` +
        `Generate at least 32 random bytes (hex or base64) and set the variable to the result.`,
    );
  }

  if (!TOKEN_LIKE.test(raw)) {
    throw new Error(
      `GITLAB_WEBHOOK_SECRET is set but contains characters outside the standard ` +
        `[A-Za-z0-9_\\-+/=] alphabet. Check for whitespace, quotes, or placeholder text leaked from ` +
        `the secret-manager value.`,
    );
  }

  return { enabled: true, webhookSecret: raw, baseUrl };
}

const BASE_URL_RE = /^https:\/\/[A-Za-z0-9.\-]+(?::\d+)?$/;

function loadBaseUrl(): string | null {
  const raw = process.env.GITLAB_BASE_URL;
  if (raw == null || raw.length === 0) return null;
  const trimmed = raw.replace(/\/+$/, '');
  if (!BASE_URL_RE.test(trimmed)) {
    throw new Error(
      `GITLAB_BASE_URL is set but malformed (got: "${raw}"). Expected an https origin like ` +
        `https://gitlab.com or https://gitlab.example.com (no path).`,
    );
  }
  return trimmed;
}
