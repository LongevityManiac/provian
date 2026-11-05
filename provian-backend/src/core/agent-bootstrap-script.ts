/**
 * agent-bootstrap-script — the ONE line the human copies at "Connect an agent".
 *
 * the standing rule (npm publish stays flip-time): a hosted `curl … | sh` one-liner
 * is equally one-paste, so the agent bootstraps with no npm and no install. The
 * app shows one line per OS:
 *
 * macOS / Linux:
 * curl -sSL -H 'x-provian-token: PROV-XXXX-XXXX' "https://api.provian.ai/v1/bootstrap/agent" | sh
 * Windows (PowerShell):
 * irm -Headers @{'x-provian-token'='PROV-XXXX-XXXX';'x-provian-platform'='windows'} "https://api.provian.ai/v1/bootstrap/agent" | iex
 *
 * Both are a GET of /v1/bootstrap/agent (item 9: a body-less POST with no
 * Content-Length is refused 411 by Google Front End before it reaches Cloud Run,
 * so GET is canonical; POST with the header or a {"token" "…"} body is still
 * served). The token rides the x-provian-token HEADER — never the URL; the
 * header dodges agent-shell quote mangling of a `-d '{"token" "…"}'` body. The
 * route returns THIS script — sh by default, PowerShell when the
 * x-provian-platform header (or a POST body's platform) is "windows" with the
 * connection token baked in. Fetching it only checks the code's format, so an
 * agent may look at the script first without spending the code. Run on a machine with no
 * agent wallet yet, the script first asks the relay whether the code is still good
 * (GET /v1/bootstrap/agent/code, a read that spends nothing), so a dead, expired or
 * placeholder code stops before anything is written. It then ensures a
 * Node that can read the transcript store (shared prelude core/bootstrap-node-ensure
 * system Node only if it has a working flagless node:sqlite, else an official
 * checksum-verified download into ~/.provian/node, matching the device installer),
 * fetches a self-contained JS
 * bundle (no dependency install) and runs the unattended onboarding: create
 * wallet → seal a recoverable copy of the key to the inviting human's phone
 * anchor → escrow the ciphertext → register device → start the observer → file
 * the link request. The human's single Accept tap then forms the 80/20 link —
 * or, for a fleet code any linked agent issued, the link
 * forms at request-link with no tap.
 *
 * The bundle + the Node entrypoint it runs are the SDK-orchestration slice; this
 * module only produces the shell/PowerShell wrappers and is a pure string
 * builder so it can be tested without a shell.
 *
 * Every user-facing failure here is a plain sentence + a next action (never a raw
 * error), per the onboarding no-raw-errors rule.
 */

import { isValidConnectionTokenFormat } from './connection-token-format';
import { nodeEnsureSh, nodeEnsurePs } from './bootstrap-node-ensure';
import { GENESIS_OFFER_LINE, GENESIS_WINDOW_END_MS } from '../mcp/core/genesis-offer';

/** The Genesis window's end in epoch SECONDS (what `date -u +%s` prints). */
const GENESIS_WINDOW_END_S = Math.floor(GENESIS_WINDOW_END_MS / 1000);

// The line is baked into a single-quoted sh / PowerShell string: it must carry no quote.
if (GENESIS_OFFER_LINE.includes("'")) throw new Error('GENESIS_OFFER_LINE must not contain a single quote');

/**
 * sh: print the Genesis offer line (stderr) while the Genesis window is open, judged
 * by THIS machine's clock at run time — so a script served before the close stops
 * printing it at the close, with no redeploy. A clock that does not read as a plain
 * integer prints nothing (unknown → no offer). Expects `say` to be defined.
 */
export function genesisOfferSh(): string {
  return `GENESIS_NOW=$(date -u +%s 2>/dev/null || true)
case "$GENESIS_NOW" in
  ''|*[!0-9]*) ;;
  *) if [ "$GENESIS_NOW" -lt ${GENESIS_WINDOW_END_S} ]; then say '${GENESIS_OFFER_LINE}'; fi ;;
esac`;
}

/** PowerShell twin of genesisOfferSh. Expects `Say` to be defined. */
export function genesisOfferPs(): string {
  return `if ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() -lt ${GENESIS_WINDOW_END_S}) { Say '${GENESIS_OFFER_LINE}' }`;
}

/** Path GET (canonical) / POST /v1/bootstrap/agent serves the script; the script fetches the bundle from here. */
export const AGENT_BOOTSTRAP_SCRIPT_ROUTE = '/v1/bootstrap/agent';
export const AGENT_BOOTSTRAP_BUNDLE_ROUTE = '/v1/bootstrap/agent.js';
/** Path GET: where the script checks its code before it writes anything. */
export const AGENT_BOOTSTRAP_CODE_CHECK_ROUTE = '/v1/bootstrap/agent/code';

/**
 * What a dead code prints: the same two sentences the bundle prints when a link request
 * fails. MIRRORS `friendlyLinkError` and `renderBootstrapOutcome` in
 * provian-agent-sdk/src/bootstrap-flow.ts; bootstrap.code-check.test.ts keeps them equal.
 */
export const DEAD_CODE_LINES: readonly string[] = [
  'The invite code may have expired or already been used.',
  'Open Provian, generate a fresh code under "Connect an agent", and run the invite again to finish linking.',
];

/** What a code the relay could not rule on prints. Nothing is written in that case either. */
export const CODE_CHECK_UNAVAILABLE_LINE =
  'Provian could not check your invite code just now, so nothing was set up. Check your internet connection and paste the command again.';

/** What a rate-limited check prints. A 429 does not say which limit it hit, so this promises no time. */
export const TOO_MANY_REQUESTS_LINE = 'Too many requests. Please try again later.';

/**
 * The files in ~/.provian that mean this machine already holds an agent wallet, or one on its
 * way. MIRROR DEFAULT_KEYSTORE_PATH in provian-agent-sdk/src/keystore.ts and the pending
 * registration file in provian-agent-sdk/src/pending-wallet-registration.ts.
 */
export const AGENT_WALLET_STATE_FILES: readonly string[] = [
  'agent-keystore.json',
  'pending-agent-wallet-registration.json',
];

/**
 * The canonical install lines for a connection code (item 9): a GET with
 * the code in the x-provian-token header, one line per OS. The single source for
 * every relay surface that hands out an install line (e.g. the fleet-code
 * route); the app's Connect screen mirrors the same shape. Throws on a
 * malformed code or a non-https origin (callers mint or validate first).
 */
export function buildAgentInstallLines(token: string, relayUrl: string): { sh: string; powershell: string } {
  if (!isValidConnectionTokenFormat(token)) throw new Error('buildAgentInstallLines: invalid connection token');
  const origin = relayUrl.replace(/\/+$/, '');
  if (!/^https:\/\/[A-Za-z0-9.\-:]+$/.test(origin)) {
    throw new Error('buildAgentInstallLines: relayUrl must be a plain https origin');
  }
  return {
    sh: `curl -sSL -H 'x-provian-token: ${token}' "${origin}${AGENT_BOOTSTRAP_SCRIPT_ROUTE}" | sh`,
    powershell: `irm -Headers @{'x-provian-token'='${token}';'x-provian-platform'='windows'} "${origin}${AGENT_BOOTSTRAP_SCRIPT_ROUTE}" | iex`,
  };
}

export interface AgentBootstrapScriptParams {
  /** A canonical PROV-XXXX-XXXX connection code. Baked into the script. */
  token: string;
  /** The relay origin (no trailing slash), e.g. https://api.provian.ai. */
  relayUrl: string;
  /**
   * F36: the SHA256 (64 lowercase hex) of the EXACT agent.js bundle bytes the
   * relay serves at /v1/bootstrap/agent.js. The relay hashes its own bundle and
   * bakes it in here; the script verifies the download against it BEFORE
   * `exec node`, so a MITM cannot substitute the bundle that becomes the
   * persistent launchd/systemd daemon. Required — the relay knows the bytes it
   * serves, so there is never a reason to omit it.
   */
  bundleSha256: string;
}

/** Validate + normalize the inputs, or throw (route validates first). The token
 * is a canonical PROV-XXXX-XXXX code (A–Z, 2–9, '-' — no quote/$/backtick/
 * backslash), so it is inert inside the single-quoted shell/PowerShell strings. */
function normalize(params: AgentBootstrapScriptParams, who: string): { token: string; relayUrl: string; bundleUrl: string; bundleSha256: string } {
  if (!isValidConnectionTokenFormat(params.token)) {
    throw new Error(`${who}: invalid connection token`);
  }
  const relayUrl = params.relayUrl.replace(/\/+$/, '');
  if (!/^https:\/\/[A-Za-z0-9.\-:]+$/.test(relayUrl)) {
    throw new Error(`${who}: relayUrl must be a plain https origin`);
  }
  const bundleSha256 = String(params.bundleSha256 ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(bundleSha256)) {
    throw new Error(`${who}: bundleSha256 must be 64 lowercase hex chars`);
  }
  return { token: params.token, relayUrl, bundleUrl: `${relayUrl}${AGENT_BOOTSTRAP_BUNDLE_ROUTE}`, bundleSha256 };
}

/**
 * Build the POSIX-sh bootstrap script (macOS / Linux). Throws on an invalid
 * token or relay URL — the caller (the route) validates first, so a throw here
 * is a server bug, not a client-reachable path.
 */
/**
 * Every host a Provian install and its daemon contact, after the relay itself (2026-10-20,
 * measured with a connection trace on a fake-IP box). A platform that approves hosts one by
 * one (Sentinel, Network Controls) needs ONE standing allow covering all of them, so the script
 * names every one before anything runs. MIRRORS provian-agent-sdk/src/egress-hosts.ts
 * (`EGRESS_ALLOW_HOSTS`); `egress-hosts-mirror.test.ts` keeps the two equal.
 */
export const EGRESS_ALLOW_HOSTS: ReadonlyArray<{ host: string; use: string }> = [
  { host: 'nodejs.org', use: "Provian's own Node runtime: at setup unless this machine already has it, and again if an update needs a newer one" },
  { host: '1.1.1.1', use: "address lookups (DNS over HTTPS), only when this machine's own DNS can't give a real address" },
  { host: '8.8.8.8', use: 'the same lookups, when 1.1.1.1 does not answer' },
  { host: 'mainnet.base.org', use: 'on-chain and Commons acts on Base (PROVIAN_BASE_RPC_URL names another)' },
  { host: 'api.mainnet-beta.solana.com', use: 'Solana x402 payments, only if you make them' },
];

/** The allow request, as lines: every host and what it is for. */
export function egressAllowLines(relayHost: string): string[] {
  return [
    'If your platform approves network requests host by host, ask your human once for ONE standing',
    'allow covering every host Provian contacts:',
    `  ${relayHost} — setup, the daemon, every record, and updates`,
    ...EGRESS_ALLOW_HOSTS.map((h) => `  ${h.host} — ${h.use}`),
    'Nothing else is contacted, apart from the model provider your own program already uses and sites you choose to pay.',
  ];
}

const shQuote = (line: string): string => `'${line.replace(/'/g, `'\\''`)}'`;
const psQuote = (line: string): string => `'${line.replace(/'/g, "''")}'`;
function egressAllowSh(relayHost: string): string {
  return egressAllowLines(relayHost).map((l) => `say ${shQuote(l)}`).join('\n');
}
function egressAllowPs(relayHost: string): string {
  return egressAllowLines(relayHost).map((l) => `Say ${psQuote(l)}`).join('\n');
}

/**
 * sh: on a machine with no agent wallet, stop unless the relay says the code is good, before
 * anything is written. 200 runs the install; 404, 409 and 410 are dead codes. Anything else
 * leaves the code unruled, so the install stops there too (Unknown = Block).
 *
 * A machine already holding a wallet skips the check and runs as it always has. Pasting an old
 * line is how an installed agent updates and repairs itself, that line's code has usually
 * expired, and only request-link, which knows the wallet asking, can rule on a resume.
 * The body goes to stdout and the status is read off its end, because `-o /dev/null` cannot
 * retry: on Linux curl fails truncating /dev/null, exits 23, and never sends the second request.
 * Expects `say`, RELAY_URL and CONNECTION_TOKEN to be defined.
 */
export function agentCodeCheckSh(relayHost: string): string {
  const noWalletHere = AGENT_WALLET_STATE_FILES.map((f) => `[ ! -f "\${HOME}/.provian/${f}" ]`).join(' && ');
  const deadCode = DEAD_CODE_LINES.map((l) => `        say ${shQuote(l)}`).join('\n');
  return `if ${noWalletHere}; then
  CODE_CHECK=$(curl -sL -w '%{http_code}' --max-time 30 --retry 2 -H "x-provian-token: $CONNECTION_TOKEN" "$RELAY_URL${AGENT_BOOTSTRAP_CODE_CHECK_ROUTE}" 2>/dev/null) || CODE_CHECK=000
  CODE_CHECK=\${CODE_CHECK##*[!0-9]}
  case "$CODE_CHECK" in
    200) ;;
    404|409|410)
${deadCode}
        exit 1
        ;;
    429)
        say ${shQuote(TOO_MANY_REQUESTS_LINE)}
        exit 1
        ;;
    *)
        say ${shQuote(CODE_CHECK_UNAVAILABLE_LINE)}
${egressAllowSh(relayHost).split('\n').map((l) => `        ${l}`).join('\n')}
        exit 1
        ;;
  esac
fi`;
}

/** PowerShell twin of agentCodeCheckSh. Expects `Say`, $RelayUrl and $ConnectionToken to be defined. */
export function agentCodeCheckPs(relayHost: string): string {
  const walletHere = AGENT_WALLET_STATE_FILES
    .map((f) => `(Test-Path (Join-Path (Join-Path $env:USERPROFILE '.provian') '${f}'))`).join(' -or ');
  return `if (-not (${walletHere})) {
  $codeCheck = 0
  foreach ($attempt in 1..3) {
    try {
      $codeCheck = [int](Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 -Headers @{ 'x-provian-token' = $ConnectionToken } -Uri "$RelayUrl${AGENT_BOOTSTRAP_CODE_CHECK_ROUTE}").StatusCode
    } catch {
      $codeCheck = 0
      if ($_.Exception.Response) { $codeCheck = [int]$_.Exception.Response.StatusCode }
    }
    if (@(200, 404, 409, 410) -contains $codeCheck) { break }
    if ($attempt -lt 3) { Start-Sleep -Seconds $attempt }
  }
  if (@(404, 409, 410) -contains $codeCheck) {
${DEAD_CODE_LINES.map((l) => `    Say ${psQuote(l)}`).join('\n')}
    exit 1
  }
  if ($codeCheck -eq 429) {
    Say ${psQuote(TOO_MANY_REQUESTS_LINE)}
    exit 1
  }
  if ($codeCheck -ne 200) {
    Say ${psQuote(CODE_CHECK_UNAVAILABLE_LINE)}
${egressAllowPs(relayHost).split('\n').map((l) => `    ${l}`).join('\n')}
    exit 1
  }
}`;
}

export function buildAgentBootstrapScript(params: AgentBootstrapScriptParams): string {
  const { token, relayUrl, bundleUrl, bundleSha256 } = normalize(params, 'buildAgentBootstrapScript');

  return `#!/bin/sh
# Provian agent onboarding — one command, no package install, no passphrase.
set -eu

RELAY_URL='${relayUrl}'
CONNECTION_TOKEN='${token}'
BUNDLE_URL='${bundleUrl}'
BUNDLE_SHA256='${bundleSha256}'

say() { printf '%s\\n' "$*" >&2; }

# The Genesis offer leads the output while the Genesis window is open (this
# machine's clock, at run time); after the window it prints nothing.
${genesisOfferSh()}

# Provian's rule: on a platform that approves network requests one at a
# time, the human grants the relay a STANDING allow once; nothing here works
# around per-request approval.
say "Setting up Provian."
${egressAllowSh(new URL(relayUrl).host)}

# Check the connection code with the relay before anything lands on this machine.
# This is a read: it spends nothing.
${agentCodeCheckSh(new URL(relayUrl).host)}

${nodeEnsureSh()}

# Fetch the self-contained onboarding bundle (single file; no dependencies to
# install) to a STABLE path. The bundle is the only Provian artifact on the
# machine: the auto-start observer runs it directly (node ~/.provian/agent.js
# observe), and every command it prints is "$HOME/.provian/bin/provian" <verb>.
PROVIAN_HOME="\${HOME}/.provian"
mkdir -p "$PROVIAN_HOME"
BUNDLE="$PROVIAN_HOME/agent.js"
if ! curl --compressed -fsSL "$BUNDLE_URL" -o "$BUNDLE"; then
  say "Could not download the Provian setup bundle. Check your internet connection and paste the command again."
${egressAllowSh(new URL(relayUrl).host).split('\n').map((l) => `  ${l}`).join('\n')}
  exit 1
fi

# Verify the bundle against the SHA256 the relay pinned into THIS script (the
# relay hashed the exact bytes it serves). FAIL CLOSED (F36): a substituted
# bundle — or a host with no checksum tool — stops here, because these bytes
# become the always-on launchd/systemd observer daemon.
BUNDLE_ACTUAL=""
if command -v shasum >/dev/null 2>&1; then
  BUNDLE_ACTUAL=$(shasum -a 256 "$BUNDLE" | awk '{print $1}')
elif command -v sha256sum >/dev/null 2>&1; then
  BUNDLE_ACTUAL=$(sha256sum "$BUNDLE" | awk '{print $1}')
fi
if [ -z "$BUNDLE_ACTUAL" ] || [ "$BUNDLE_SHA256" != "$BUNDLE_ACTUAL" ]; then
  rm -f "$BUNDLE"
  say 'The Provian setup bundle failed its integrity check. Setup stopped for safety — paste the command again.'
  exit 1
fi

# Run the unattended onboarding. The token and relay travel by environment (not
# argv) so the one-time code never shows up in the process list. PROVIAN_BUNDLE_PATH
# tells the bundle where its persisted copy lives so it can point the observer
# service at it. The bundle handles: create wallet -> seal a recoverable copy of
# the key to the phone that invited you -> escrow only ciphertext -> register
# device -> start the observer -> file the link request. No passphrase and no
# backup file: recovery routes through your Provian app. (There is no local
# witness endpoint and no self-reporting — an agent never reports its own work.)
PROVIAN_CONNECTION_TOKEN="$CONNECTION_TOKEN" \\
PROVIAN_RELAY_URL="$RELAY_URL" \\
PROVIAN_BUNDLE_PATH="$BUNDLE" \\
exec node "$BUNDLE"
`;
}

/**
 * Build the PowerShell bootstrap script (Windows). Same flow as the sh variant.
 * Throws on invalid input.
 */
export function buildAgentBootstrapPowershell(params: AgentBootstrapScriptParams): string {
  const { token, relayUrl, bundleUrl, bundleSha256 } = normalize(params, 'buildAgentBootstrapPowershell');

  return `# Provian agent onboarding — one command, no package install, no passphrase.
$ErrorActionPreference = 'Stop'

$RelayUrl = '${relayUrl}'
$ConnectionToken = '${token}'
$BundleUrl = '${bundleUrl}'
$BundleSha256 = '${bundleSha256}'

function Say($m) { [Console]::Error.WriteLine($m) }

# The Genesis offer leads the output while the Genesis window is open; nothing after.
${genesisOfferPs()}

Say 'Setting up Provian.'
${egressAllowPs(new URL(relayUrl).host)}

# Check the connection code with the relay before anything lands on this machine.
# This is a read: it spends nothing.
${agentCodeCheckPs(new URL(relayUrl).host)}

${nodeEnsurePs()}

# Fetch the self-contained onboarding bundle (single file; no dependencies) to a
# STABLE path so the observer Scheduled Task can run it (node agent.js observe)
# directly — the bundle is the only Provian artifact on the machine.
$provianHome = Join-Path $env:USERPROFILE '.provian'
New-Item -ItemType Directory -Force -Path $provianHome | Out-Null
$bundle = Join-Path $provianHome 'agent.js'
try {
  Invoke-WebRequest -UseBasicParsing -Uri $BundleUrl -OutFile $bundle
} catch {
  Say 'Could not download the Provian setup bundle. Check your internet connection and paste the command again.'
  exit 1
}
# Verify the bundle against the SHA256 the relay pinned into THIS script. FAIL
# CLOSED (F36): a substituted bundle stops here — these bytes become the always-on
# Scheduled-Task observer daemon.
$bundleActual = (Get-FileHash -Algorithm SHA256 -Path $bundle).Hash.ToLower()
if ($BundleSha256 -ne $bundleActual) {
  Remove-Item -Force -Path $bundle -ErrorAction SilentlyContinue
  Say 'The Provian setup bundle failed its integrity check. Setup stopped for safety — paste the command again.'
  exit 1
}
# The token and relay travel by environment, not argv, so the one-time code never
# shows up in the process list. PROVIAN_BUNDLE_PATH tells the bundle where its
# persisted copy lives so it can point the observer service at it.
$env:PROVIAN_CONNECTION_TOKEN = $ConnectionToken
$env:PROVIAN_RELAY_URL = $RelayUrl
$env:PROVIAN_BUNDLE_PATH = $bundle
& node $bundle
exit $LASTEXITCODE
`;
}

// ─── "A device for your agent" ────────────────────────────────────────
//
// The emailed agent-device line runs the SAME SHA-pinned bundle as the Connect
// line, with the single-use `agent_device_registration` setup token (64 hex)
// instead of a connection code. The bundle registers this machine to the agent's
// EXISTING wallet (POST /v1/devices/register, the token's only honoring route),
// persists the device credentials, and installs + starts the observer service,
// the profile blocks and the git hook — the Connect install's device leg. It
// creates no wallet and never moves the agent's key.

/** Path GET (canonical) / POST /v1/bootstrap/agent-device serves the script. */
export const AGENT_DEVICE_BOOTSTRAP_SCRIPT_ROUTE = '/v1/bootstrap/agent-device';

/** An agent_device_registration setup token: 32 random bytes, lowercase hex. */
export function isValidAgentDeviceTokenFormat(token: string): boolean {
  return /^[0-9a-f]{64}$/.test(token);
}

const AGENT_DEVICE_NAME_UNSAFE = /[^A-Za-z0-9 _.,()@-]/g;

/** Inert inside single quotes (no quote, $, backtick or backslash survives); '' when absent. */
export function safeAgentDeviceName(name: unknown): string {
  return typeof name === 'string' ? name.replace(AGENT_DEVICE_NAME_UNSAFE, '').trim().slice(0, 64) : '';
}

/**
 * The agent-device install lines (one per OS). The token and the optional device
 * name ride HEADERS, never the URL (the same tokens-out-of-the-URL rule as the
 * Connect line). Throws on a malformed token or a non-https origin.
 */
export function buildAgentDeviceInstallLines(
  token: string,
  relayUrl: string,
  deviceName?: string,
): { sh: string; powershell: string } {
  if (!isValidAgentDeviceTokenFormat(token)) throw new Error('buildAgentDeviceInstallLines: invalid agent-device token');
  const origin = relayUrl.replace(/\/+$/, '');
  if (!/^https:\/\/[A-Za-z0-9.\-:]+$/.test(origin)) {
    throw new Error('buildAgentDeviceInstallLines: relayUrl must be a plain https origin');
  }
  const name = safeAgentDeviceName(deviceName);
  const nameHeaderSh = name ? ` -H 'x-provian-device-name: ${name}'` : '';
  const nameHeaderPs = name ? `;'x-provian-device-name'='${name}'` : '';
  return {
    sh: `curl -sSL -H 'x-provian-token: ${token}'${nameHeaderSh} "${origin}${AGENT_DEVICE_BOOTSTRAP_SCRIPT_ROUTE}" | sh`,
    powershell: `irm -Headers @{'x-provian-token'='${token}'${nameHeaderPs};'x-provian-platform'='windows'} "${origin}${AGENT_DEVICE_BOOTSTRAP_SCRIPT_ROUTE}" | iex`,
  };
}

export interface AgentDeviceBootstrapScriptParams {
  token: string;
  relayUrl: string;
  bundleSha256: string;
  /** Already-sanitized display name, or '' (the bundle then uses the hostname). */
  deviceName?: string;
}

function normalizeAgentDevice(params: AgentDeviceBootstrapScriptParams, who: string): {
  token: string; relayUrl: string; bundleUrl: string; bundleSha256: string; deviceName: string;
} {
  if (!isValidAgentDeviceTokenFormat(params.token)) throw new Error(`${who}: invalid agent-device token`);
  const relayUrl = params.relayUrl.replace(/\/+$/, '');
  if (!/^https:\/\/[A-Za-z0-9.\-:]+$/.test(relayUrl)) throw new Error(`${who}: relayUrl must be a plain https origin`);
  const bundleSha256 = String(params.bundleSha256 ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(bundleSha256)) throw new Error(`${who}: bundleSha256 must be 64 lowercase hex chars`);
  return {
    token: params.token, relayUrl, bundleUrl: `${relayUrl}${AGENT_BOOTSTRAP_BUNDLE_ROUTE}`, bundleSha256,
    deviceName: safeAgentDeviceName(params.deviceName),
  };
}

/** POSIX-sh agent-device installer (macOS / Linux). Throws on invalid input (the route validates first). */
export function buildAgentDeviceBootstrapScript(params: AgentDeviceBootstrapScriptParams): string {
  const { token, relayUrl, bundleUrl, bundleSha256, deviceName } = normalizeAgentDevice(params, 'buildAgentDeviceBootstrapScript');
  const host = new URL(relayUrl).host;
  return `#!/bin/sh
# Provian — set up this computer as a device for your agent. One command, no package install.
set -eu

RELAY_URL='${relayUrl}'
AGENT_DEVICE_TOKEN='${token}'
DEVICE_NAME='${deviceName}'
BUNDLE_URL='${bundleUrl}'
BUNDLE_SHA256='${bundleSha256}'

say() { printf '%s\\n' "$*" >&2; }

say "Setting up this computer for your agent."
${egressAllowSh(host)}

${nodeEnsureSh()}

PROVIAN_HOME="\${HOME}/.provian"
mkdir -p "$PROVIAN_HOME"
BUNDLE="$PROVIAN_HOME/agent.js"
if ! curl --compressed -fsSL "$BUNDLE_URL" -o "$BUNDLE"; then
  say "Could not download the Provian setup bundle. Check your internet connection and paste the command again."
  exit 1
fi

# Verify the bundle against the SHA256 the relay pinned into THIS script. FAIL
# CLOSED (F36): these bytes become the always-on observer daemon.
BUNDLE_ACTUAL=""
if command -v shasum >/dev/null 2>&1; then
  BUNDLE_ACTUAL=$(shasum -a 256 "$BUNDLE" | awk '{print $1}')
elif command -v sha256sum >/dev/null 2>&1; then
  BUNDLE_ACTUAL=$(sha256sum "$BUNDLE" | awk '{print $1}')
fi
if [ -z "$BUNDLE_ACTUAL" ] || [ "$BUNDLE_SHA256" != "$BUNDLE_ACTUAL" ]; then
  rm -f "$BUNDLE"
  say 'The Provian setup bundle failed its integrity check. Setup stopped for safety — paste the command again.'
  exit 1
fi

# Register this machine to your agent's wallet, then install and start the
# observer (service, profile blocks, git hook). The one-time token travels by
# environment, never argv, so it never shows in the process list.
PROVIAN_AGENT_DEVICE_TOKEN="$AGENT_DEVICE_TOKEN" \\
PROVIAN_DEVICE_NAME="$DEVICE_NAME" \\
PROVIAN_RELAY_URL="$RELAY_URL" \\
PROVIAN_BUNDLE_PATH="$BUNDLE" \\
exec node "$BUNDLE"
`;
}

/** PowerShell agent-device installer (Windows). Same flow as the sh variant. */
export function buildAgentDeviceBootstrapPowershell(params: AgentDeviceBootstrapScriptParams): string {
  const { token, relayUrl, bundleUrl, bundleSha256, deviceName } = normalizeAgentDevice(params, 'buildAgentDeviceBootstrapPowershell');
  return `# Provian — set up this computer as a device for your agent. One command, no package install.
$ErrorActionPreference = 'Stop'

$RelayUrl = '${relayUrl}'
$AgentDeviceToken = '${token}'
$DeviceName = '${deviceName}'
$BundleUrl = '${bundleUrl}'
$BundleSha256 = '${bundleSha256}'

function Say($m) { [Console]::Error.WriteLine($m) }

Say 'Setting up this computer for your agent.'
${egressAllowPs(new URL(relayUrl).host)}

${nodeEnsurePs()}

$provianHome = Join-Path $env:USERPROFILE '.provian'
New-Item -ItemType Directory -Force -Path $provianHome | Out-Null
$bundle = Join-Path $provianHome 'agent.js'
try {
  Invoke-WebRequest -UseBasicParsing -Uri $BundleUrl -OutFile $bundle
} catch {
  Say 'Could not download the Provian setup bundle. Check your internet connection and paste the command again.'
  exit 1
}
$bundleActual = (Get-FileHash -Algorithm SHA256 -Path $bundle).Hash.ToLower()
if ($BundleSha256 -ne $bundleActual) {
  Remove-Item -Force -Path $bundle -ErrorAction SilentlyContinue
  Say 'The Provian setup bundle failed its integrity check. Setup stopped for safety — paste the command again.'
  exit 1
}
$env:PROVIAN_AGENT_DEVICE_TOKEN = $AgentDeviceToken
$env:PROVIAN_DEVICE_NAME = $DeviceName
$env:PROVIAN_RELAY_URL = $RelayUrl
$env:PROVIAN_BUNDLE_PATH = $bundle
& node $bundle
exit $LASTEXITCODE
`;
}
