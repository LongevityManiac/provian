/**
 * device-bootstrap-script — the ONE line a human copies under "Connect a
 * computer" to turn a personal machine into a Provian desktop daemon.
 *
 * The parallel of core/agent-bootstrap-script, for the DEVICE path, in BOTH
 * POSIX sh (macOS / Linux) and PowerShell (Windows) so a Windows user is a
 * first-class day-one path, not a follow-up. The app (and the "email the
 * command" flow) shows one line per OS:
 *
 * macOS / Linux:
 * curl -sSL -H 'x-provian-token: <hex>' "https://api.provian.ai/v1/bootstrap/device" | sh
 * Windows (PowerShell):
 * irm -Headers @{'x-provian-token'='<hex>';'x-provian-platform'='windows'} "https://api.provian.ai/v1/bootstrap/device" | iex
 *
 * Both hit GET /v1/bootstrap/device (item 9: GET is canonical — a body-less
 * POST with no Content-Length is refused 411 by Google Front End before it
 * reaches Cloud Run; POST with a header or a {"token" "…"} body is still served).
 * The token rides the x-provian-token HEADER — never the URL; the header dodges agent-shell quote
 * mangling, same tokens-out-of-the-URL rule setup-command.ts and bootstrap.ts
 * carry); the route returns the sh script by default and the PowerShell script
 * when platform:"windows" (header or body). Unlike the raw `curl …/v1/devices/register` line
 * it replaces — which dumped the relay's JSON response (credentials smashed into
 * one blob) and left the machine with NO git hook, NO observer, and creds the
 * user had to hand-save — each script:
 *
 * 1. ensures a Node that can read the transcript store (shared prelude
 * core/bootstrap-node-ensure: keeps the system Node only if it has a working
 * flagless node:sqlite, else an official checksum-verified download into
 * ~/.provian/node — no sudo, removable), and
 * 2. runs `npx @provian/agent-sdk register-device` full setup, which registers
 * the device, writes ~/.provian/credentials, installs the global git hook,
 * and starts the observer — one paste, no leftover manual steps.
 *
 * The one-time token travels into register-device by ENVIRONMENT
 * (PROVIAN_SETUP_TOKEN), never argv, so it never appears in the process list.
 *
 * POST-PUBLISH BY DESIGN : the device path drives the published
 * `@provian/agent-sdk` rather than a self-contained hosted bundle, so it does
 * not have to work before the npm publish flip. Pasted before publish, the npx
 * step fails and the script prints a plain "not launched yet" sentence — never a
 * raw error — so a curious early paste is a harmless no-op, not a scary dump.
 *
 * Pure string builders (no shell, no fs) so they are unit-testable; the route
 * validates its inputs first, so a throw here is a server bug, not a
 * client-reachable path.
 */

import { nodeEnsureSh, nodeEnsurePs, BOOTSTRAP_NODE_VERSION } from './bootstrap-node-ensure';

/** Path POST /v1/bootstrap/device serves the script. */
export const DEVICE_BOOTSTRAP_SCRIPT_ROUTE = '/v1/bootstrap/device';

// Re-exported for tests / callers that pin the runtime version.
export { BOOTSTRAP_NODE_VERSION };

/**
 * A device_registration / agent_device_registration setup token is
 * `crypto.randomBytes(32).toString('hex')` — exactly 64 lowercase hex chars
 * (see routes/setup.ts and server.ts email-command). Hex is inherently
 * shell-safe (no quote, $, backtick, or backslash), so a validated token
 * single-quotes cleanly into either script below.
 */
export function isValidDeviceSetupTokenFormat(token: unknown): token is string {
  return typeof token === 'string' && /^[a-f0-9]{64}$/.test(token);
}

/** A plain https origin (no path/query), matching the agent-bootstrap guard. */
function isPlainHttpsOrigin(url: string): boolean {
  return /^https:\/\/[A-Za-z0-9.\-:]+$/.test(url);
}

export interface DeviceBootstrapParams {
  /** The one-time 64-hex device setup token. Baked into the script/command. */
  token: string;
  /** The relay origin (no trailing slash), e.g. https://api.provian.ai. */
  relayUrl: string;
}

/** Validate + normalize the shared inputs, or throw (route validates first). */
function normalize(params: DeviceBootstrapParams, who: string): { token: string; relayUrl: string } {
  if (!isValidDeviceSetupTokenFormat(params.token)) {
    throw new Error(`${who}: invalid device setup token`);
  }
  const relayUrl = params.relayUrl.replace(/\/+$/, '');
  if (!isPlainHttpsOrigin(relayUrl)) {
    throw new Error(`${who}: relayUrl must be a plain https origin`);
  }
  return { token: params.token, relayUrl };
}

/**
 * The macOS / Linux copy-paste line: a GET with the token in the
 * x-provian-token header, never the URL (item 9).
 */
export function buildDeviceBootstrapCommand(params: DeviceBootstrapParams): string {
  const { token, relayUrl } = normalize(params, 'buildDeviceBootstrapCommand');
  return `curl -sSL -H 'x-provian-token: ${token}' "${relayUrl}${DEVICE_BOOTSTRAP_SCRIPT_ROUTE}" | sh`;
}

/**
 * The Windows (PowerShell) copy-paste line. The x-provian-platform:windows
 * header tells the route to return the PowerShell script instead of the sh one.
 */
export function buildDeviceBootstrapCommandWindows(params: DeviceBootstrapParams): string {
  const { token, relayUrl } = normalize(params, 'buildDeviceBootstrapCommandWindows');
  return (
    `irm -Headers @{'x-provian-token'='${token}';'x-provian-platform'='windows'} ` +
    `"${relayUrl}${DEVICE_BOOTSTRAP_SCRIPT_ROUTE}" | iex`
  );
}

/**
 * The POSIX-sh device bootstrap script (macOS / Linux). Throws on invalid input.
 */
export function buildDeviceBootstrapScript(params: DeviceBootstrapParams): string {
  const { token, relayUrl } = normalize(params, 'buildDeviceBootstrapScript');
  return `#!/bin/sh
# Provian desktop setup — registers this computer and starts witnessing your work.
# One paste: ensures Node.js, registers the device, installs the git hook and observer.
set -eu

RELAY_URL='${relayUrl}'
SETUP_TOKEN='${token}'

say() { printf '%s\\n' "$*" >&2; }

${nodeEnsureSh()}

# --- Register this computer + install the daemon -----------------------------
# register-device full setup: register device -> write ~/.provian/credentials ->
# install the global git hook -> start the observer. The one-time token travels
# by env (PROVIAN_SETUP_TOKEN), never argv, so it never enters the process list.
say 'Registering this computer with Provian...'
# --skip-llm-session-consent: this rail runs non-interactively (curl | sh has no
# TTY), so without it register-device fail-closes LLM session capture to OFF and
# the daemon witnesses only git — never AI sessions. The flag auto-accepts capture
# (consent is disclosed on the phone's "Connect a computer" screen before this
# command is ever shown) and still prints the macOS permission deep-links the
# foreground helper needs. One paste must enable 100% of intended capture.
if ! PROVIAN_SETUP_TOKEN="$SETUP_TOKEN" PROVIAN_RELAY_URL="$RELAY_URL" \\
     npx -y @provian/agent-sdk@latest register-device --yes --skip-llm-session-consent; then
  say ''
  say 'Provian setup could not finish. If Provian has not launched publicly yet, the installer is not available yet — try again after launch, or generate a fresh command in the Provian app.'
  exit 1
fi
`;
}

/**
 * The PowerShell device bootstrap script (Windows). Throws on invalid input.
 */
export function buildDeviceBootstrapPowershell(params: DeviceBootstrapParams): string {
  const { token, relayUrl } = normalize(params, 'buildDeviceBootstrapPowershell');
  return `# Provian desktop setup — registers this computer and starts witnessing your work.
# One paste: ensures Node.js, registers the device, installs the git hook and observer.
$ErrorActionPreference = 'Stop'

$RelayUrl = '${relayUrl}'
$SetupToken = '${token}'

function Say($m) { [Console]::Error.WriteLine($m) }

${nodeEnsurePs()}

# --- Register this computer + install the daemon -----------------------------
# register-device full setup: register device -> write credentials -> install the
# git hook -> start the observer. The one-time token travels by env, never argv.
Say 'Registering this computer with Provian...'
$env:PROVIAN_SETUP_TOKEN = $SetupToken
$env:PROVIAN_RELAY_URL = $RelayUrl
# --skip-llm-session-consent: non-interactive rail (irm | iex has no TTY) would
# otherwise fail-close LLM session capture to OFF. Consent is disclosed on the
# phone before this command is shown; one paste must enable 100% of capture.
& npx -y '@provian/agent-sdk@latest' register-device --yes --skip-llm-session-consent
if ($LASTEXITCODE -ne 0) {
  Say ''
  Say 'Provian setup could not finish. If Provian has not launched publicly yet, the installer is not available yet — try again after launch, or generate a fresh command in the Provian app.'
  exit 1
}
`;
}
