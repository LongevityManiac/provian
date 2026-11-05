import { guardedFetcher } from '../guarded-fetch';
/**
 * Pure invite-device flow - extracted from invite-device.ts so the network
 * logic is testable without spawning a subprocess or hitting the real relay.
 *
 * The CLI script (invite-device.ts) injects a real fetch and the agent creds
 * loaded from the 0600-enforced ~/.provian/agent-credentials.json. Tests inject
 * a mock fetch and explicit creds.
 *
 * SECURITY:
 *   - The Authorization header is `Bearer <api_key>:<api_secret>` (agent API
 *     auth) and is ONLY sent to POST /v1/agent/wallet/:wallet_id/device-invite.
 *   - The endpoint mints + emails a one-time token; the response is
 *     { sent, expires_at } ONLY. The token is NEVER returned over the wire and
 *     this flow never logs the api_secret (S3).
 */

/**
 * The one-line email regex the relay uses (mirrored client-side so we fail fast
 * before the network round trip). RFC-5321 caps the full address at 254 chars.
 */
const EMAIL_ADDRESS_REGEX =
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX_LENGTH = 254;

export interface InviteDeviceCreds {
  apiKey: string;
  apiSecret: string;
}

export interface InviteDeviceDeps {
  /** Recipient email language; absent/unsupported defaults to English. */
  language?: string;
  relayUrl: string;
  /** Agent wallet id (wallet_aw_*) that the new device will attribute to. */
  walletId: string;
  /** Destination email address for the one-time setup link. */
  email: string;
  /** Optional friendly device name carried into the email body. */
  deviceName?: string;
  /** Optional free-text note carried into the email body. */
  message?: string;
  /** Agent API creds. Loaded from the 0600-enforced creds file by the CLI. */
  creds: InviteDeviceCreds;
  /** Defaults to globalThis.fetch in the CLI; overridable for tests. */
  fetch: typeof globalThis.fetch;
}

export type InviteDeviceResult =
  | { status: 'sent'; expiresAt: number }
  | { status: 'error'; error: string };

/** Validate the destination email (regex + length). Throwing keeps the CLI thin. */
export function assertValidEmail(email: string): void {
  if (typeof email !== 'string') {
    throw new Error('email is required');
  }
  const trimmed = email.trim();
  if (!trimmed) {
    throw new Error('email is required');
  }
  if (trimmed.length > EMAIL_MAX_LENGTH) {
    throw new Error(`email must be at most ${EMAIL_MAX_LENGTH} characters`);
  }
  if (!EMAIL_ADDRESS_REGEX.test(trimmed)) {
    throw new Error(`invalid email address: ${trimmed}`);
  }
}

function authHeader(creds: InviteDeviceCreds): string {
  return `Bearer ${creds.apiKey}:${creds.apiSecret}`;
}

/**
 * POST /v1/agent/wallet/:wallet_id/device-invite with agent API auth.
 *
 * Body: { email, device_name?, message? } - device_name / message are only
 * included when provided (no null padding).
 *
 * Returns { status: 'sent', expiresAt } on success, { status: 'error', error }
 * on any failure. Never returns or logs the token (the relay never sends it
 * back) or the api_secret.
 */
export async function runInviteDevice(deps: InviteDeviceDeps): Promise<InviteDeviceResult> {
  // Validate locally first so a bad address never reaches the relay.
  try {
    assertValidEmail(deps.email);
  } catch (err) {
    return { status: 'error', error: (err as Error).message };
  }
  if (!deps.walletId) {
    return { status: 'error', error: 'walletId is required to send a device invite' };
  }
  if (!deps.creds.apiKey || !deps.creds.apiSecret) {
    return { status: 'error', error: 'agent API key + secret are required' };
  }

  const email = deps.email.trim();
  const body: { email: string; device_name?: string; message?: string; language?: string } = { email };
  if (deps.language !== undefined) body.language = deps.language;
  if (deps.deviceName) body.device_name = deps.deviceName;
  if (deps.message) body.message = deps.message;

  const url = `${deps.relayUrl}/v1/agent/wallet/${encodeURIComponent(deps.walletId)}/device-invite`;

  let resp: Response;
  try {
    resp = await guardedFetcher(deps.fetch)(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(deps.creds),
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { status: 'error', error: `request failed: ${(err as Error).message}` };
  }

  if (!resp.ok) {
    let detail = '';
    try {
      const errJson = (await resp.json()) as { error?: string };
      if (errJson && typeof errJson.error === 'string') detail = errJson.error;
    } catch {
      try {
        detail = (await resp.text()).slice(0, 200);
      } catch {
        detail = '';
      }
    }
    return {
      status: 'error',
      error: `device-invite returned ${resp.status}${detail ? `: ${detail}` : ''}`,
    };
  }

  let payload: { sent?: boolean; expires_at?: number };
  try {
    payload = (await resp.json()) as { sent?: boolean; expires_at?: number };
  } catch (err) {
    return { status: 'error', error: `device-invite response was not JSON: ${(err as Error).message}` };
  }
  if (payload.sent !== true || typeof payload.expires_at !== 'number') {
    return { status: 'error', error: 'device-invite response missing { sent, expires_at }' };
  }

  return { status: 'sent', expiresAt: payload.expires_at };
}
