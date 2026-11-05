/**
 * Witness 3 - Bitbucket webhook secret config.
 *
 * Bitbucket (Cloud and Data Center) signs each webhook delivery with
 * HMAC-SHA256 over the raw body, keyed by a per-webhook **secret** the user
 * sets when creating the webhook, and sends it in the `X-Hub-Signature`
 * header as `sha256=<hex>`. This is the same scheme GitHub uses (GitHub's
 * header is `X-Hub-Signature-256`; Bitbucket's is `X-Hub-Signature`), so
 * verification is an HMAC compare over the raw body - NOT the verbatim-token
 * compare GitLab uses. See bitbucket-webhook.ts `verifyBitbucketSignature`.
 *
 * This mirrors github-app-config.ts / gitlab-app-config.ts: an
 * env/secret-manager-loaded app-wide secret, no per-row secret in Firestore,
 * fail-loud on a malformed secret, feature off when unset (receiver returns
 * 503). Reusing the same shape keeps the three forge connectors operationally
 * identical for the relay operator.
 *
 * `BITBUCKET_BASE_URL` is optional and informational only (used by the
 * connect/docs surface, not the webhook verifier). A self-hosted Bitbucket
 * Data Center that can reach the relay URL delivers webhooks the same way
 * bitbucket.org does; the verifier never calls back to Bitbucket - Tier A
 * custody, no stored credential, no outbound token use.
 *
 * **Scope at launch:** the synthesizer targets Bitbucket **Cloud** payload
 * shapes (`repo:push`, `pullrequest:fulfilled`). Bitbucket Data Center emits
 * different event keys (`repo:refs_changed`, `pr:merged`) with a different
 * payload shape; that mapping is a tracked follow-up. The receiver fails safe
 * for unrecognized shapes (200 dropped, no PE), so a DC delivery never crashes
 * or mis-attributes.
 */

const SECRET_LIKE = /^[A-Za-z0-9_\-+/=]+$/;
const MIN_SECRET_LENGTH = 32;

export interface BitbucketAppConfig {
  enabled: boolean;
  /** App-wide webhook secret (the value pasted into a Bitbucket webhook's "Secret" field). Present only when enabled. */
  webhookSecret: string | null;
  /**
   * Base URL of the Bitbucket instance (e.g. https://bitbucket.org or a
   * self-hosted Data Center host). Informational only - the webhook receiver
   * does not call back to Bitbucket (Tier A custody). Null when unset.
   */
  baseUrl: string | null;
}

/**
 * Load the Bitbucket webhook config from env. Read once at server startup
 * (matches the github/gitlab-app-config read-once pattern); do not call per
 * request.
 *
 * - BITBUCKET_WEBHOOK_SECRET unset → { enabled: false }. Receiver returns 503.
 * - set and well-formed → { enabled: true, webhookSecret }.
 * - set but malformed (too short or out-of-charset) → throws (fail-loud): a
 *   secret that can't HMAC-match what Bitbucket sends silently breaks every
 *   delivery, which is worse than refusing to boot.
 */
export function loadBitbucketAppConfig(): BitbucketAppConfig {
  const raw = process.env.BITBUCKET_WEBHOOK_SECRET;
  const baseUrl = loadBaseUrl();

  if (raw == null || raw.length === 0) {
    return { enabled: false, webhookSecret: null, baseUrl };
  }

  if (raw.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `BITBUCKET_WEBHOOK_SECRET is set but too short (${raw.length} chars, minimum ${MIN_SECRET_LENGTH}). ` +
        `Generate at least 32 random bytes (hex or base64) and set the variable to the result.`,
    );
  }

  if (!SECRET_LIKE.test(raw)) {
    throw new Error(
      `BITBUCKET_WEBHOOK_SECRET is set but contains characters outside the standard ` +
        `[A-Za-z0-9_\\-+/=] alphabet. Check for whitespace, quotes, or placeholder text leaked from ` +
        `the secret-manager value.`,
    );
  }

  return { enabled: true, webhookSecret: raw, baseUrl };
}

const BASE_URL_RE = /^https:\/\/[A-Za-z0-9.\-]+(?::\d+)?$/;

function loadBaseUrl(): string | null {
  const raw = process.env.BITBUCKET_BASE_URL;
  if (raw == null || raw.length === 0) return null;
  const trimmed = raw.replace(/\/+$/, '');
  if (!BASE_URL_RE.test(trimmed)) {
    throw new Error(
      `BITBUCKET_BASE_URL is set but malformed (got: "${raw}"). Expected an https origin like ` +
        `https://bitbucket.org or https://bitbucket.example.com (no path).`,
    );
  }
  return trimmed;
}
