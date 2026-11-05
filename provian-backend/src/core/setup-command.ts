/**
 * Setup-command builders — the ONE source for every emitted "paste this line"
 * onboarding command (production-effect audit 2026-08-16, item 5;  single
 * source).
 *
 * Pre-flip the @provian/* packages are unpublished (npm E404), so a fresh
 * recipient can only complete setup through the hosted relay API itself. Every
 * surface that hands out a runnable line (the email-command route, the agent
 * device-invite, /v1/setup/generate-token) therefore builds it HERE, as a
 * plain curl call to the exact live endpoint that consumes the embedded token:
 *
 * - device tokens -> POST /v1/devices/register
 * human `device_registration` tokens enter via the authenticate
 * setup-token branch (server.ts); agent `agent_device_registration`
 * tokens via routes/middleware/device-register-auth.ts. SAME command
 * shape for both — the relay routes by the stored token type.
 * (the keyless agent connect command is gone — an agent onboards through
 * the hosted bootstrap rail with its own key.)
 *
 * The Idempotency-Key is minted at command-build time so the emailed line is
 * safely re-runnable: both register-token consumers implement idempotent
 * replay keyed on registration_id_sha256, and a replay returns the original
 * registration instead of burning a second device.
 *
 * At public launch the npm packages publish and the npx one-liners return
 * (B5 flip act); until then no surface may emit a bare `npx @provian/...` line.
 *
 * EXCEPTION — the human "Connect a computer" device path now routes through the
 * hosted bootstrap rail instead of the raw register curl below: the app and the
 * emailed device command emit a `curl … | sh` one-liner (see
 * core/device-bootstrap-script.ts / GET /v1/bootstrap/device), whose returned
 * script ensures Node.js and drives `npx @provian/agent-sdk register-device`.
 * That npx runs INSIDE the hosted script (never an emitted surface line) and is
 * post-publish by design — pasted pre-publish it prints a plain "not launched
 * yet" sentence. `buildDeviceRegisterCommand` (raw curl) remains for the
 * agent-owned-device email path, which needs `--agent-token` mode.
 */

import crypto from 'crypto';

export const DEFAULT_RELAY_URL = 'https://api.provian.ai';

/** Same env seam the setup router has always used (routes/setup.ts). */
export function resolveRelayUrl(): string {
  return process.env.RELAY_URL || DEFAULT_RELAY_URL;
}

/**
 * 32 hex chars — inside the canonical 16–128 registration-id bound enforced by
 * routes/middleware/device-registration-id.ts.
 */
export function mintCommandIdempotencyKey(): string {
  return crypto.randomBytes(16).toString('hex');
}

export const DEFAULT_DEVICE_NAME = 'my-computer';

/**
 * The device name rides inside a single-quoted JSON body on a shell line the
 * recipient pastes, so the embedded value must be inert in BOTH grammars: no
 * single quote (ends the shell string), no double quote or backslash (breaks
 * the JSON string), no $/backtick (shell expansion inside the surrounding
 * double-quoted email contexts). This is command-construction correctness —
 * the emitted line must parse — not a policy gate: a caller-supplied name
 * survives verbatim minus unsafe characters, and an empty result falls back
 * to the default. The 100-char cap mirrors the register endpoint's own
 * device_name validation bound (routes/devices.ts).
 */
const DEVICE_NAME_UNSAFE = /[^A-Za-z0-9 _.,()@-]/g;

function safeDeviceName(deviceName?: string): string {
  const cleaned = (deviceName ?? '').replace(DEVICE_NAME_UNSAFE, '').trim().slice(0, 100);
  return cleaned.length > 0 ? cleaned : DEFAULT_DEVICE_NAME;
}

export interface DeviceRegisterCommandParams {
  /** The one-time setup token (device_registration OR agent_device_registration — same consumer endpoint). */
  token: string;
  /** Stable idempotency anchor for safe re-runs; mint with mintCommandIdempotencyKey(). */
  idempotencyKey: string;
  /** Defaults to resolveRelayUrl(). */
  relayUrl?: string;
  /** Optional friendly device name; sanitized for shell/JSON embedding. */
  deviceName?: string;
}

/**
 * One paste-and-run line that registers a device against the live relay with
 * zero install. The response prints the device credentials
 * (PROVIAN_DEVICE_KEY / PROVIAN_DEVICE_SECRET as env_vars) exactly once.
 */
export function buildDeviceRegisterCommand(params: DeviceRegisterCommandParams): string {
  const relayUrl = params.relayUrl ?? resolveRelayUrl();
  const name = safeDeviceName(params.deviceName);
  return (
    `curl -sS -X POST ${relayUrl}/v1/devices/register ` +
    `-H "Authorization: Bearer ${params.token}" ` +
    `-H "Idempotency-Key: ${params.idempotencyKey}" ` +
    `-H "Content-Type: application/json" ` +
    `-d '{"device_name":"${name}","device_type":"coding_workstation","platform":"macos"}'`
  );
}
