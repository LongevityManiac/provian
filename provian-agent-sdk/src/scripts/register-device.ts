#!/usr/bin/env node
import { guardedFetch as fetch, guardedFetcher } from '../guarded-fetch';
/**
 * register-device - One-command setup for Provian device registration
 *
 * Registers a compute device, writes credentials to a machine-local file
 * (and shell profile for convenience), and installs the global git hook.
 * One command → fully operational PE-generating machine.
 *
 * One actor, one device: the device identity IS the actor identity.
 * Humans register their personal machines. Agents register their
 * execution environment. All PEs attribute to the device owner automatically.
 *
 * Interactive:
 * npx @provian/agent-sdk register-device
 *
 * Non-interactive (from app token flow):
 * npx @provian/agent-sdk register-device \
 * --token <wallet_session_token> \
 * --name "the operator’s MacBook Pro"
 *
 * Credentials only (old behavior, no shell/hook modifications):
 * npx @provian/agent-sdk register-device --credentials-only
 */

import { createInterface } from 'readline';
import { hostname, platform as osPlatform, homedir } from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, execSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
// WS3 : the shared, tested hook composer — one source for global install,
// prior-hook merge, and per-repo composition (replaces this file's former copy).
import { installGlobal as sharedInstallGlobal } from '../hook-install';
import { getCredentialsPath, readCredentialsFile, writeCredentialsFile } from './credentials';
import type { DeviceSigningMethod } from './credentials';
import { installService, restartService, isObserverRunning, publishSessionOtelEndpoint, PID_FILE } from '../observer/service';
import { detectOTelFramework, detectAgentHarness, OTLP_DEFAULT_PORT } from '../observer/plugins/OTelPlugin';
import { witnessSetupLines } from '../witness-setup';
import { probeLocalInferenceRuntimes, describeLocalInferenceProbe } from '../observer/plugins/local-inference/runtimes';
import { harnessEnableGuidance } from './harness-guidance';
import { runLLMSessionConsent } from './llm-session-consent';
import { loadAgentCredentialsFile } from './agent-credentials-file';
import { readGitAuthorEmail } from '../git-identity';
import { gitIdentityGuidanceLines } from '../git-identity-guidance';
import {
  clearPendingDeviceRegistration,
  loadPendingDeviceRegistrationForContext,
  loadOrCreatePendingDeviceRegistration,
  reconcileInstalledDeviceRegistration,
  type PendingDeviceRegistration,
} from './pending-device-registration';
import { isDirectCliEntry } from './cli-entry';
import {
  detectShellProfile, detectShellProfileDisplay, buildExportLine,
  writeOTelToProfile, removeModelProxyFromProfile, writeOTelToExistingProfiles,
} from './shell-profile';
// Re-exported: callers and tests import these from register-device.
export {
  writeOTelToProfile, removeModelProxyFromProfile, writeOTelToExistingProfiles,
};
// Re-exported for backward-compatibility with any external importer that
// pulled these from register-device before they were factored into the shared
// (side-effect-free) agent-credentials-file module.
export type { AgentCredentialsFile } from './agent-credentials-file';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RELAY_URL = 'https://api.provian.ai';
const CREDS_START_MARKER = '# --- Provian Device Credentials Start ---';
const CREDS_END_MARKER = '# --- Provian Device Credentials End ---';
/**
 * Resolution of which registration mode (and therefore which Authorization
 * header + owner type) applies. Kept as a pure function so the byte-exact
 * auth-header contract is unit-testable without driving the full FS-mutating
 * registration flow in main().
 *
 * Precedence (mirrors main()):
 *   1. --agent-token <token>  → agent-token mode (Bearer <token>, owner=agent)
 *   2. agent device (flag / api-key / agent-credentials.json) → Bearer
 *      <api_key>:<api_secret>, owner=agent
 *   3. otherwise → human, Bearer <wallet_session_token>
 *
 * SECURITY (S2): in agent-token mode the only credential is the single-use
 * agent-token. It is the Bearer value for the one /v1/devices/register POST and
 * is never combined with the agent api-key/secret.
 */
export function buildRegisterAuthHeader(params: {
  isAgentTokenMode: boolean;
  isAgentDevice: boolean;
  agentToken?: string;
  apiKey?: string;
  apiSecret?: string;
  token?: string;
}): string {
  if (params.isAgentTokenMode) {
    if (!params.agentToken) {
      throw new Error('agent-token mode requires a non-empty --agent-token value');
    }
    return `Bearer ${params.agentToken}`;
  }
  if (params.isAgentDevice) {
    return `Bearer ${params.apiKey}:${params.apiSecret}`;
  }
  return `Bearer ${params.token}`;
}

export interface DeviceRegistrationResponse {
  device_id: string;
  device_name: string;
  device_key: string;
  device_secret: string;
  owner_wallet_id: string;
  registration_pe_id: string;
}

export function isExactDeviceRegistrationResponse(
  value: unknown,
  pending: PendingDeviceRegistration,
): value is DeviceRegistrationResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  return typeof response.device_id === 'string'
    && /^dev_[a-f0-9]{64}$/.test(response.device_id)
    && response.device_key === pending.device_key
    && response.device_secret === pending.device_secret
    && response.device_name === pending.context.device_name
    && typeof response.owner_wallet_id === 'string'
    && (pending.context.owner_type === 'agent'
      ? /^wallet_aw_[A-Za-z0-9_-]+$/.test(response.owner_wallet_id)
      : /^[A-Za-z0-9_-]{1,256}$/.test(response.owner_wallet_id))
    && typeof response.registration_pe_id === 'string'
    && /^pe_device_register_[a-f0-9]{64}$/.test(response.registration_pe_id);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Does this device's owner have an ACTIVE GitHub App install? Best-effort
 * (DeviceKey auth, 5s budget): true / false when the relay answered, null
 * when it could not be asked — the guidance then prints its conditional form.
 */
async function probeGitHubInstalls(
  relayUrl: string,
  deviceKey: string,
  deviceSecret: string,
): Promise<boolean | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${relayUrl.replace(/\/+$/, '')}/v1/witnesses/github/installs`, {
      headers: { Authorization: `DeviceKey ${deviceKey}:${deviceSecret}` },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { installs?: Array<{ revoked_at?: number | null }> };
    if (!Array.isArray(body.installs)) return null;
    return body.installs.some((i) => i.revoked_at === null || i.revoked_at === undefined);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function detectPlatform(): string {
  const p = osPlatform();
  switch (p) {
    case 'darwin': return 'macOS';
    case 'linux': return 'linux';
    case 'win32': return 'windows';
    default: return p;
  }
}

export type AttestationCapability = 'software' | 'hardware_tpm';

/**
 * The host facts attestation detection reads. Injected so the decision can be
 * exercised for platforms this machine is not, and so a probe that THROWS can
 * be shown to fall closed to `software` rather than crash or guess upward.
 */
export interface AttestationProbe {
  /** `os.platform()` — 'darwin' | 'linux' | 'win32' | … */
  platform: string;
  /** `uname -m` — 'arm64' on Apple Silicon. */
  arch: () => string;
  /** Apple T2 bridge present (Intel Macs carry a Secure Enclave in the T2). */
  hasAppleBridge: () => boolean;
  /** A TPM 2.0 device node is present. */
  hasTpmDevice: () => boolean;
}

/** The real host probe. Every leg is best-effort; a throw means "unknown". */
export function defaultAttestationProbe(): AttestationProbe {
  return {
    platform: osPlatform(),
    arch: () => execSync('uname -m', { encoding: 'utf-8' }).trim(),
    hasAppleBridge: () => execSync(
      'system_profiler SPiBridgeDataType 2>/dev/null || echo ""',
      { encoding: 'utf-8', timeout: 5000 },
    ).trim().length > 10,
    hasTpmDevice: () => fs.existsSync('/dev/tpmrm0')
      || fs.existsSync('/dev/tpm0')
      || fs.existsSync('/sys/class/tpm/tpm0'),
  };
}

/**
 * Detect the highest available attestation capability for this device.
 *
 * - macOS on Apple Silicon: Secure Enclave always present   → hardware_tpm
 * - macOS on Intel with a T2 bridge (SE lives in the T2)    → hardware_tpm
 * - Linux with a TPM 2.0 device node                        → hardware_tpm
 * - Everything else, and every failed probe                 → software
 *
 * SELF-REPORTED, and deliberately so. Nothing here is verified by the relay:
 * this reports the best tier the host can offer, and `--attestation software`
 * always overrides it downward. Agent-owned devices are forced to `software`
 * server-side regardless. No mint path depends on hardware attestation
 * existing — attestation is a WEIGHT MULTIPLIER, never a gate.
 *
 * A probe that throws is UNKNOWN, and unknown resolves DOWN to `software` — the
 * claim is never rounded up on a failed read.
 */
export function detectAttestationCapability(
  probe: AttestationProbe = defaultAttestationProbe(),
): AttestationCapability {
  if (probe.platform === 'darwin') {
    try {
      if (probe.arch() === 'arm64') {
        // Apple Silicon (M1/M2/M3/M4) - Secure Enclave always present
        return 'hardware_tpm';
      }
      // Intel Mac - check for T2 chip (which contains a Secure Enclave)
      if (probe.hasAppleBridge()) {
        return 'hardware_tpm';
      }
    } catch {
      // Detection failed - fall through to software
    }
  }

  if (probe.platform === 'linux') {
    try {
      if (probe.hasTpmDevice()) {
        return 'hardware_tpm';
      }
    } catch {
      // Detection failed - fall through to software
    }
  }

  return 'software';
}

// ---------------------------------------------------------------------------
// Secure Enclave signing - Mac-only path
// ---------------------------------------------------------------------------
//
// When the host has a Secure Enclave (Apple Silicon or Intel T2), we generate
// a non-extractable P-256 key via the `provian-se-sign` companion binary and
// submit the public key at registration. The daemon then signs every outbound
// PE payload with the SE key - the relay verifies with @noble/curves/p256.
//
// TPM 2.0 equivalents on Linux/Windows are out of scope in this pass; those
// hosts stay on bearer-token DeviceKey auth. The prompt tracks this as a
// follow-up.

/** Mac or iOS hardware class - used to decide whether SE signing applies. */
function isMacHost(): boolean {
  return osPlatform() === 'darwin';
}

/**
 * Locate the provian-se-sign binary. Preference order:
 *   1. $PROVIAN_SE_SIGN_BINARY (explicit override, useful for development)
 *   2. provian-se-sign on PATH
 *   3. ~/.provian/bin/provian-se-sign (where the installer drops it)
 *   4. The debug build inside the source checkout (developer convenience)
 * Returns null if none are found.
 */
function resolveSeSignBinary(): string | null {
  const override = process.env.PROVIAN_SE_SIGN_BINARY;
  if (override && fs.existsSync(override)) return override;

  const candidates = [
    // PATH lookup via `command -v`
    (() => {
      try {
        const resolved = execSync('command -v provian-se-sign', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        return resolved || null;
      } catch {
        return null;
      }
    })(),
    path.join(homedir(), '.provian', 'bin', 'provian-se-sign'),
  ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

interface SeGenerateResult {
  publicKeyX: string; // 32-byte hex
  publicKeyY: string; // 32-byte hex
}

/**
 * Invoke `provian-se-sign --generate` for the daemon-signing path.
 * Returns the uncompressed public key coordinates. Throws on any failure
 * (binary missing, key already exists, SE unavailable, etc.) - the caller
 * decides whether to abort or fall back to bearer auth.
 */
function generateSecureEnclaveKey(binary: string, alias: string): SeGenerateResult {
  const output = execSync(
    `"${binary}" --generate --key-alias "${alias}" --no-user-presence`,
    { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const parsed = JSON.parse(output) as Partial<SeGenerateResult>;
  if (!parsed.publicKeyX || !parsed.publicKeyY) {
    throw new Error('provian-se-sign returned incomplete key material');
  }
  if (parsed.publicKeyX.length !== 64 || parsed.publicKeyY.length !== 64) {
    throw new Error(`provian-se-sign returned coordinates of unexpected length (x=${parsed.publicKeyX.length}, y=${parsed.publicKeyY.length})`);
  }
  return { publicKeyX: parsed.publicKeyX, publicKeyY: parsed.publicKeyY };
}

/**
 * Build an uncompressed SEC1 public key hex string from raw X and Y coords.
 * Matches the 65-byte format Commons auth / @noble/curves expects.
 */
function sec1UncompressedHex(x: string, y: string): string {
  return `04${x}${y}`;
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    // Re-audit LOW-2 (docs/audit/chunk_h_reaudit_2026_05.md §4 LOW-2):
    // the original chain had a duplicate `--git-username` clause and was
    // missing `else` between the first three branches, leaving the chain
    // structurally inconsistent. Rewritten as a uniform else-if chain.
    if (argv[i] === '--token' && argv[i + 1]) args.token = argv[++i];
    else if (argv[i] === '--name' && argv[i + 1]) args.name = argv[++i];
    else if (argv[i] === '--platform' && argv[i + 1]) args.platform = argv[++i];
    else if (argv[i] === '--relay' && argv[i + 1]) args.relay = argv[++i];
    else if (argv[i] === '--tool' && argv[i + 1]) args.tool = argv[++i];
    else if (argv[i] === '--attestation' && argv[i + 1]) args.attestation = argv[++i];
    else if (argv[i] === '--credentials-only') args.credentialsOnly = true;
    else if (argv[i] === '--yes' || argv[i] === '-y') args.yes = true;
    else if (argv[i] === '--agent') args.agent = true;
    else if (argv[i] === '--human') args.human = true;
    else if (argv[i] === '--api-key' && argv[i + 1]) args.apiKey = argv[++i];
    else if (argv[i] === '--api-secret' && argv[i + 1]) args.apiSecret = argv[++i];
    else if (argv[i] === '--agent-token' && argv[i + 1]) args.agentToken = argv[++i];
    else if (argv[i] === '--wallet-id' && argv[i + 1]) args.walletId = argv[++i];
    else if (argv[i] === '--skip-llm-session-consent') args.skipLlmSessionConsent = true;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log(`
Usage: register-device [options]

Options:
  --token <token>             Wallet session token (from Settings > Developer > API Token)
  --name <name>               Device name (default: hostname)
  --platform <platform>       Platform (default: auto-detected)
  --attestation <capability>  Override attestation capability: hardware | hardware_tpm | software
                              (default: auto-detected from hardware)
                              "hardware" / "hardware_tpm" require Mac Secure Enclave
                              key generation to succeed; registration aborts otherwise.
  --relay <url>               Relay URL (default: ${RELAY_URL})
  --credentials-only          Just print credentials (don't modify shell or install hooks)
  --yes, -y                   Skip confirmation prompts
  --agent                     Register as an agent device. Auth with agent API key
                              instead of a human wallet session token. Auto-detects
                              when ~/.provian/agent-credentials.json is present.
  --human                     Force human-device registration (opt out of auto-detect)
  --api-key <pvn_live_...>    Agent API key (for --agent mode)
  --api-secret <pvns_...>     Agent API secret (for --agent mode)
  --agent-token <token>       One-time agent device-invite token (from an emailed
                              "register-device --agent-token <token>" line). Registers
                              this machine as an AGENT device WITHOUT an API key/secret;
                              the token authorizes device registration only and is single-use.
  --wallet-id <wallet_aw_...> Agent wallet ID (optional; otherwise derived from response)
  --skip-llm-session-consent  Auto-accept LLM session capture (CI/non-interactive)
  --help, -h                  Show this help

Attestation and pricing:
  Software device witnesses use the normal lane class.
  Verified Apple App Attest supplies hardware pricing and the 4.0x
  hardware-rooted base, as does a TPM, AWS Nitro, GCP Confidential VM, Azure
  or NVIDIA attestation whose launch measurement is one the signed observer
  release pins (the measured observer). Mac Secure Enclave, StrongBox and any
  other verified hardware evidence remain presentation facts at the normal
  witness-lane price. A bare attested-machine submission mints at device tier.
  Verified human linkage remains a separate factor.
  Agent device_register has no device anchor and mints zero PVT.

Examples:
  register-device                                    # Interactive (auto-detects everything)
  register-device --token pst_... --name "My Mac"    # Non-interactive full setup
  register-device --attestation software             # Force software attestation
  register-device --credentials-only                 # Old behavior (just prints creds)
`);
      process.exit(0);
    }
  }
  return args;
}

async function prompt(rl: ReturnType<typeof createInterface>, question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  return new Promise(resolve => {
    rl.question(`${question}${suffix}: `, answer => {
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

// ---------------------------------------------------------------------------
// Existing-credentials guard
// ---------------------------------------------------------------------------

interface DeviceMeResponse {
  device_id: string;
  device_name: string;
  device_type?: string;
  platform?: string;
  owner_wallet_id: string;
  owner_user_id: string;
  total_pes?: number;
  last_pe_at?: number | null;
}

/**
 * Look up the wallet/device this machine is currently linked to via the
 * /v1/devices/me endpoint. Returns null if no creds exist, or if the
 * lookup fails (network error, revoked device, missing endpoint, etc.).
 *
 * Failure here MUST NOT block the registration flow - we still want to warn
 * the user with whatever local context we have.
 */
async function lookupExistingDevice(): Promise<{
  remote: DeviceMeResponse | null;
  localName?: string;
  localKeyPrefix?: string;
  localRelay?: string;
} | null> {
  const local = readCredentialsFile();
  if (!local || !local.deviceKey || !local.deviceSecret) {
    return null;
  }

  const localKeyPrefix = local.deviceKey.slice(0, 16);
  const localName = local.deviceName;
  const localRelay = local.relayUrl;

  try {
    const resp = await fetch(`${local.relayUrl || RELAY_URL}/v1/devices/me`, {
      method: 'GET',
      headers: {
        'Authorization': `DeviceKey ${local.deviceKey}:${local.deviceSecret}`,
      },
    });

    if (!resp.ok) {
      return { remote: null, localName, localKeyPrefix, localRelay };
    }

    const remote = await resp.json() as DeviceMeResponse;
    return { remote, localName, localKeyPrefix, localRelay };
  } catch {
    // Network error, DNS failure, endpoint missing - fall back to local info
    return { remote: null, localName, localKeyPrefix, localRelay };
  }
}

function formatWalletId(walletId: string): string {
  // Wallet ids look like 0xabc...def or wallet_xyz; show enough to recognize.
  if (walletId.length <= 14) return walletId;
  return `${walletId.slice(0, 8)}…${walletId.slice(-6)}`;
}

/**
 * If existing credentials are present, print a blunt warning showing what
 * the user is about to disconnect from, then prompt y/N. With --yes the
 * warning still prints but the prompt is skipped (CI/automation path).
 *
 * Returns true if the caller should proceed with overwriting credentials,
 * false if the caller should bail out (user declined).
 */
async function confirmOverwriteExisting(
  rl: ReturnType<typeof createInterface>,
  skipConfirm: boolean,
): Promise<boolean> {
  const existing = await lookupExistingDevice();
  if (!existing) return true; // No creds present, nothing to overwrite

  const { remote, localName, localKeyPrefix, localRelay } = existing;

  console.log('\n  ⚠  This machine already has Provian device credentials.\n');

  if (remote) {
    console.log(`     Device name:   ${remote.device_name}`);
    console.log(`     Device id:     ${remote.device_id}`);
    console.log(`     Linked wallet: ${formatWalletId(remote.owner_wallet_id)}`);
    if (typeof remote.total_pes === 'number') {
      console.log(`     PEs reported:  ${remote.total_pes}`);
    }
    console.log(`     Relay:         ${localRelay || RELAY_URL}\n`);
  } else {
    // Remote lookup failed - fall back to whatever the local file knows
    console.log(`     Device name:   ${localName || '(unknown)'}`);
    console.log(`     Device key:    ${localKeyPrefix || '(unknown)'}…`);
    console.log(`     Relay:         ${localRelay || RELAY_URL}`);
    console.log(`     (Could not contact relay to confirm linked wallet - showing local info only)\n`);
  }

  console.log('  Continuing will REPLACE these credentials. After overwrite:');
  console.log('  • Future PE reports from this machine will go to the NEW wallet, not the old one.');
  console.log('  • The git post-commit hook will route commits to the new wallet.');
  console.log('  • The old device entry on the relay is unaffected, but this machine');
  console.log('    will no longer be the source of its PEs.\n');

  if (skipConfirm) {
    console.log('  --yes flag set, proceeding without prompt.\n');
    return true;
  }

  // Non-TTY stdin (piped input, CI, headless automation, etc.) can't answer
  // an interactive prompt. Fail closed - refuse to overwrite credentials
  // without explicit confirmation. Callers who want automation should pass
  // --yes explicitly so the intent is recorded in their scripts/logs.
  if (!process.stdin.isTTY) {
    console.log('  Non-interactive stdin detected. Refusing to overwrite without --yes.');
    console.log('  Re-run with --yes if you are intentionally automating this overwrite.\n');
    return false;
  }

  const answer = await prompt(rl, '  Type "overwrite" to continue, anything else to cancel');
  if (answer.toLowerCase() !== 'overwrite') {
    console.log('\n  Cancelled. Existing credentials left untouched.\n');
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Shell profile management
// ---------------------------------------------------------------------------

function shellProfileHasCredentials(profilePath: string): boolean {
  if (!fs.existsSync(profilePath)) return false;
  const content = fs.readFileSync(profilePath, 'utf-8');
  return content.includes(CREDS_START_MARKER);
}

export function writeCredentialsToProfile(
  profilePath: string,
  deviceKey: string,
  deviceSecret: string,
  relayUrl: string,
  deviceName: string,
  deviceId: string,
): void {
  const block = [
    CREDS_START_MARKER,
    `# Device: ${deviceName}`,
    buildExportLine('PROVIAN_DEVICE_KEY', deviceKey),
    buildExportLine('PROVIAN_DEVICE_SECRET', deviceSecret),
    // PROVIAN_DEVICE_ID is load-bearing for economic_session_lineage: the
    // observer derives attestedDeviceId + the durable session ordinal from it
    // (ProvianObserver deviceId -> SessionManager -> mintSessionLineageClaim).
    // Omitting it from the env export left an env-only observer with
    // deviceId=null, so every observed PE shipped WITHOUT lineage. The file
    // path always persisted it; the shell-profile path must too.
    ...(deviceId ? [buildExportLine('PROVIAN_DEVICE_ID', deviceId)] : []),
    buildExportLine('PROVIAN_RELAY_URL', relayUrl),
    CREDS_END_MARKER,
  ].join('\n');

  if (fs.existsSync(profilePath)) {
    const content = fs.readFileSync(profilePath, 'utf-8');

    // Replace existing block if present
    const startIdx = content.indexOf(CREDS_START_MARKER);
    const endIdx = content.indexOf(CREDS_END_MARKER);
    if (startIdx !== -1 && endIdx !== -1) {
      const before = content.substring(0, startIdx).replace(/\n+$/, '');
      const after = content.substring(endIdx + CREDS_END_MARKER.length).replace(/^\n+/, '');
      const parts = [before, block, after].filter(Boolean);
      fs.writeFileSync(profilePath, parts.join('\n\n') + '\n');
      return;
    }

    // Append
    fs.writeFileSync(profilePath, content.trimEnd() + '\n\n' + block + '\n');
  } else {
    // Create the profile file
    const dir = path.dirname(profilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(profilePath, block + '\n');
  }
}

// ---------------------------------------------------------------------------
// Git hook installation — WS3 : delegate to the shared composer so the
// device path merges the user's prior global hooks (hole A) and composes per
// repo exactly like setup-hook and the agent bootstrap. `merged` names any prior
// global hooks copied forward, surfaced to the operator.
// ---------------------------------------------------------------------------

function installGlobalHook(): { hookPath: string; action: string; merged: string[] } {
  return sharedInstallGlobal();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Crash recovery must run before argument parsing, prompts, Secure Enclave
  // key generation, or relay access. Exact installed credentials prove that
  // the prior registration completed; delete only their matching pending
  // marker and return without creating or recovering another device.
  const startupCredentials = readCredentialsFile(getCredentialsPath());
  if (reconcileInstalledDeviceRegistration(startupCredentials)) {
    console.log('\n  Device registration was already completed locally.');
    console.log('  Reconciled the durable pending marker; no relay request was made.\n');
    return;
  }

  const args = parseArgs(process.argv.slice(2));
  const credentialsOnly = args.credentialsOnly === true;
  const skipConfirm = args.yes === true;

  // ---------------------------------------------------------------------------
  // Agent-device detection
  //
  // Priority:
  //   1. --human flag → force human mode (opt-out of auto-detect)
  //   2. --agent flag or --api-key/--api-secret → force agent mode
  //   3. ~/.provian/agent-credentials.json exists with valid creds → agent mode
  //   4. Default → human mode
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // Agent device-invite token mode (email-only flow).
  //
  // A one-time token emailed to the human runs as:
  //   register-device --agent-token <token>
  // It authorizes DEVICE REGISTRATION ONLY (consumed by a dedicated relay
  // middleware on POST /v1/devices/register; never honored by the global
  // authenticate middleware). It does NOT require the agent API key/secret -
  // the token IS the only credential. Owner resolves to the agent wallet the
  // relay loads from the token (single source of truth: the wallet doc).
  // ---------------------------------------------------------------------------
  const agentToken = args.agentToken as string | undefined;
  const isAgentTokenMode = !!agentToken;

  const agentCredsFile = loadAgentCredentialsFile();
  const explicitAgent = args.agent === true || !!args.apiKey;
  const explicitHuman = args.human === true;
  const isAgentDevice =
    isAgentTokenMode ? true :
    explicitHuman ? false :
    explicitAgent ? true :
    !!agentCredsFile;

  const ownerType: 'human' | 'agent' = isAgentDevice ? 'agent' : 'human';

  const apiKey = (args.apiKey as string | undefined) || agentCredsFile?.api_key;
  const apiSecret = (args.apiSecret as string | undefined) || agentCredsFile?.api_secret;

  // In agent mode we authenticate the registration with the agent's API key
  // (Bearer api_key:api_secret). The backend's authenticateDeviceOwner
  // middleware detects the pvn_live_ prefix and routes through agent auth,
  // which sets owner_type='agent' on the resulting device record.
  // Agent-token mode never prompts: the token is self-contained and is always
  // run non-interactively from the emailed one-liner.
  // The human setup token may arrive as --token OR, from the hosted "Connect a
  // computer" bootstrap script, via the PROVIAN_SETUP_TOKEN env var. Passing it
  // by env keeps the one-time token out of the process list (argv). Both resolve
  // to the same Bearer credential for the single POST /v1/devices/register.
  const humanSetupToken = (args.token as string) || process.env.PROVIAN_SETUP_TOKEN || '';

  const isInteractive = isAgentTokenMode
    ? false
    : isAgentDevice
      ? !(apiKey && apiSecret)
      : !humanSetupToken;

  let token = humanSetupToken;
  let deviceName = (args.name as string) || '';
  let platform = (args.platform as string) || detectPlatform();
  const relayUrl = (args.relay as string) || RELAY_URL;

  // Attestation / signing mode flags.
  //
  //   --attestation software  → force bearer auth regardless of hardware.
  //   --attestation hardware  → require Secure Enclave signing on Mac (abort if
  //                             generation fails). `hardware_tpm` is accepted
  //                             for backwards compatibility and treated the same.
  //   (no flag)               → auto-detect. Mac tries SE signing and silently
  //                             falls back to bearer if generation fails. Linux
  //                             with TPM still reports hardware_tpm for the
  //                             attestation_capability field but stays on
  //                             bearer signing - the TPM signing helper is a
  //                             separate follow-up.
  const attestationOverride = args.attestation as string | undefined;
  let attestationCapability: AttestationCapability;
  let requireHardwareSigning = false;
  if (attestationOverride === 'software') {
    attestationCapability = 'software';
  } else if (attestationOverride === 'hardware' || attestationOverride === 'hardware_tpm') {
    attestationCapability = 'hardware_tpm';
    requireHardwareSigning = true;
  } else if (attestationOverride) {
    console.error(`  Error: Invalid --attestation value "${attestationOverride}". Must be "hardware", "hardware_tpm", or "software".\n`);
    process.exit(1);
  } else {
    attestationCapability = detectAttestationCapability();
  }

  // Agent-owned devices are always software-tier: the relay never issues
  // hardware attestation to an agent and forces 'software' server-side. Pin the
  // client-side field + printed tier label to 'software' in agent-token mode so
  // they match the server's forced outcome instead of a misleading
  // auto-detected 'hardware_tpm' on, e.g., Apple Silicon.
  if (isAgentTokenMode) {
    attestationCapability = 'software';
    requireHardwareSigning = false;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  let resolvedApiKey = apiKey;
  let resolvedApiSecret = apiSecret;

  try {
    if (isInteractive) {
      console.log('\n  Provian Device Registration\n');
      if (isAgentDevice) {
        console.log('  Registering this machine as an AGENT device.');
        console.log('  All compute on this device will be attributed to the agent wallet.');
        console.log('  An unlinked agent keeps its contributor share. With a verified active');
        console.log('  beneficiary link, the relay seals the configured BPS on each PE');
        console.log('  (default 20% agent / 80% human; agent range 5%–50%).\n');
        if (!resolvedApiKey) {
          resolvedApiKey = await prompt(rl, '  Agent API key (pvn_live_...)');
        }
        if (!resolvedApiSecret) {
          resolvedApiSecret = await prompt(rl, '  Agent API secret (pvns_...)');
        }
      } else {
        console.log('  This registers your machine as a PE source for your Provian wallet.');
        console.log('  All compute work on this device generates Provenance Envelopes,');
        console.log('  and every act of compute work mints PVT once in your wallet.\n');
        token = await prompt(rl, '  Wallet session token (from Settings > Developer > API Token)');
        if (!token) {
          console.error('\n  Error: Token is required. Get one from the Provian app:\n  Settings > Developer > Generate Device Token\n');
          process.exit(1);
        }
      }

      deviceName = await prompt(rl, '  Device name', hostname());
      platform = await prompt(rl, '  Platform', detectPlatform());
    }

    if (isAgentTokenMode) {
      // Agent device-invite token mode: the token is the only credential.
      // No api-key/secret is required or validated; the relay authorizes the
      // single device-registration POST from the token alone.
      if (!agentToken) {
        console.error('Error: --agent-token requires a non-empty token value');
        process.exit(1);
      }
    } else if (isAgentDevice) {
      if (!resolvedApiKey || !resolvedApiSecret) {
        console.error('Error: --api-key and --api-secret are required for --agent mode');
        console.error('(or place them in ~/.provian/agent-credentials.json)');
        process.exit(1);
      }
      if (!resolvedApiKey.startsWith('pvn_live_') || !resolvedApiSecret.startsWith('pvns_')) {
        console.error('Error: api_key must start with pvn_live_ and api_secret must start with pvns_');
        process.exit(1);
      }
    } else if (!token) {
      console.error('Error: --token is required');
      process.exit(1);
    }

    if (!deviceName) {
      deviceName = hostname();
    }

    // -----------------------------------------------------------------------
    // Step 0: If credentials already exist, warn and confirm overwrite
    // -----------------------------------------------------------------------
    // Skipped in --credentials-only mode (which doesn't touch the file).
    if (!credentialsOnly) {
      const proceed = await confirmOverwriteExisting(rl, skipConfirm);
      if (!proceed) {
        rl.close();
        process.exit(0);
      }
    }

    // -----------------------------------------------------------------------
    // Step 1: Register the device
    //
    // Auth header:
    //   • Agent mode → Bearer {api_key}:{api_secret}
    //     (authenticateDeviceOwner in the backend sees pvn_live_ and routes
    //      to the agent-auth middleware, which sets owner_type='agent')
    //   • Human mode → Bearer {wallet_session_token}
    //     (routed through the standard human wallet auth middleware)
    //
    // Agent devices automatically have their attestation_capability
    // downgraded to 'software' server-side before signing-method selection.
    // Beneficiary resolution is independent: only an active verified link
    // seals an exact integer-BPS split in recordPEAccrual.
    // -----------------------------------------------------------------------
    if (isAgentDevice) {
      console.log('\n  Registering as AGENT device. PEs from this machine are attributed');
      console.log('  to the agent wallet. An unlinked agent keeps its contributor share;');
      console.log('  an active verified beneficiary link seals the configured BPS per PE');
      console.log('  (default 20% agent / 80% human; agent range 5%–50%).');
      console.log('  Note: agent-owned devices are forced to software attestation by the relay.\n');
    }

    // SECURITY (S2): in agent-token mode the agent-token is the SOLE credential
    // and is isolated to this one /v1/devices/register POST - never combined
    // with the api-key/secret and never routed through any other request.
    const authHeader = buildRegisterAuthHeader({
      isAgentTokenMode,
      isAgentDevice,
      agentToken,
      apiKey: resolvedApiKey,
      apiSecret: resolvedApiSecret,
      token,
    });

    const pendingBaseContext = {
      relay_url: relayUrl,
      authorization_sha256: createHash('sha256').update(authHeader).digest('hex'),
      owner_type: ownerType,
      device_name: deviceName,
      platform,
      attestation_capability: attestationCapability,
      hardware_signing_required: requireHardwareSigning,
    } as const;
    const existingPendingRegistration = loadPendingDeviceRegistrationForContext(
      pendingBaseContext,
    );

    // -----------------------------------------------------------------------
    // Secure Enclave key generation (Mac daemon signing path)
    //
    // When hardware attestation is in play on a Mac host, try to mint a
    // non-extractable P-256 key in the Secure Enclave and register its public
    // key with the relay. After this point, PE submissions sign their payload
    // with that key - the relay verifies with @noble/curves/p256 exactly like
    // Commons browser auth does.
    //
    // If provian-se-sign is unavailable or generation fails:
    //   • --attestation hardware was explicit → abort with a clear error.
    //   • auto-detected hardware → fall back to bearer silently, keep the
    //     hardware_tpm capability label (TPM signing wiring is a follow-up).
    // -----------------------------------------------------------------------
    let signingMethod: DeviceSigningMethod =
      existingPendingRegistration?.context.signing_method ?? 'bearer';
    let signingPublicKeyHex: string | undefined =
      existingPendingRegistration?.context.signing_public_key ?? undefined;
    let signingKeyAlias: string | undefined =
      existingPendingRegistration?.context.signing_key_alias ?? undefined;
    const shouldAttemptSESigning =
      attestationCapability === 'hardware_tpm' && isMacHost() && !isAgentDevice;

    if (existingPendingRegistration?.context.signing_method === 'secure_enclave_p256'
      && !isMacHost()) {
      throw new Error('Pending Secure Enclave registration cannot be resumed on a non-Mac host');
    }

    if (!existingPendingRegistration && shouldAttemptSESigning) {
      const seBinary = resolveSeSignBinary();
      if (!seBinary) {
        if (requireHardwareSigning) {
          console.error('  Error: --attestation hardware was requested but provian-se-sign is not installed.');
          console.error('  Install it (see provian-se-sign/README) or re-run with --attestation software.\n');
          process.exit(1);
        }
        console.log('  Note: provian-se-sign not found on PATH - falling back to bearer auth.');
        console.log('  Install the Secure Enclave helper to use hardware-backed signing at the hardware_partial attestation tier.\n');
      } else {
        const alias = `provian-device-${randomUUID()}`;
        try {
          const { publicKeyX, publicKeyY } = generateSecureEnclaveKey(seBinary, alias);
          signingMethod = 'secure_enclave_p256';
          signingPublicKeyHex = sec1UncompressedHex(publicKeyX, publicKeyY);
          signingKeyAlias = alias;
        } catch (err) {
          const msg = (err as Error).message;
          if (requireHardwareSigning) {
            console.error(`  Error: Secure Enclave key generation failed: ${msg}`);
            console.error('  Re-run with --attestation software to force bearer-only registration, or fix the SE issue and retry.\n');
            process.exit(1);
          }
          console.log(`  Note: Secure Enclave key generation failed (${msg}) - falling back to bearer auth.\n`);
        }
      }
    } else if (!existingPendingRegistration && requireHardwareSigning && !isMacHost()) {
      // Non-Mac hosts can't use the Mac-specific helper. TPM wiring lives in a later
      // phase; be explicit instead of silently degrading.
      console.error('  Error: --attestation hardware requires Mac Secure Enclave in this release.');
      console.error('  Linux TPM / Windows attested hardware signing is a follow-up. Re-run with');
      console.error('  --attestation software, or register from a Mac to use hardware signing.\n');
      process.exit(1);
    }

    const tierLabel = isAgentDevice
      ? 'software (0.8x attestation factor, forced for agent devices)'
      : signingMethod === 'secure_enclave_p256'
        ? 'secure_enclave_p256 (verified signer fact; normal software lane pricing)'
        : attestationCapability === 'hardware_tpm'
          ? 'hardware_tpm (verified hardware fact; normal software lane pricing)'
          : 'software (0.8x attestation factor)';
    console.log(`  Registering device (attestation: ${tierLabel})...\n`);

    const pendingRegistration = loadOrCreatePendingDeviceRegistration({
      ...pendingBaseContext,
      signing_method: signingMethod,
      signing_public_key: signingPublicKeyHex ?? null,
      signing_key_alias: signingKeyAlias ?? null,
    });

    let result: DeviceRegistrationResponse;

    try {
      const response = await fetch(`${relayUrl}/v1/devices/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeader,
          'Idempotency-Key': pendingRegistration.registration_id,
        },
        body: JSON.stringify({
          registration_id: pendingRegistration.registration_id,
          device_key: pendingRegistration.device_key,
          device_secret: pendingRegistration.device_secret,
          device_name: deviceName,
          device_type: 'coding_workstation',
          platform,
          attestation_capability: attestationCapability,
          // New: daemon-signing registration. Older relays ignore unknown fields.
          signing_method: signingMethod,
          ...(signingPublicKeyHex ? { signing_public_key: signingPublicKeyHex } : {}),
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        let parsed;
        try { parsed = JSON.parse(error); } catch { parsed = null; }
        console.error(`  Registration failed (${response.status}): ${parsed?.error || error}\n`);
        process.exit(1);
      }

      const responseBody = await response.json() as unknown;
      if (!isExactDeviceRegistrationResponse(responseBody, pendingRegistration)) {
        console.error('  Registration returned a malformed or mismatched device/wallet identity.');
        console.error('  Pending registration retained; retry the same command.\n');
        process.exit(1);
      }
      result = responseBody;
    } catch (error) {
      console.error(`  Network error: ${(error as Error).message}`);
      console.error('  Make sure you can reach the Provian relay.\n');
      process.exit(1);
    }

    console.log(`  Device registered: ${result.device_name}`);
    console.log('');
    console.log('  PE descriptions: structural metadata only (safe for all work)');
    console.log(`  Device ID: ${result.device_id}`);
    console.log(`  Attestation: ${attestationCapability}${attestationOverride ? ' (override)' : ' (auto-detected)'}`);
    console.log(`  Signing:     ${signingMethod}${signingKeyAlias ? ` (alias: ${signingKeyAlias})` : ''}`);
    console.log(`  Owner wallet: ${result.owner_wallet_id}`);
    console.log(`  Registration PE: ${result.registration_pe_id}\n`);

    // -----------------------------------------------------------------------
    // Credentials-only mode: print and exit (old behavior)
    // -----------------------------------------------------------------------
    if (credentialsOnly) {
      const shellProfileDisplay = detectShellProfileDisplay();
      console.log(`  Add these lines to ${shellProfileDisplay}:\n`);
      console.log(`  # Provian device registration (${result.device_name})`);
      console.log(`  export PROVIAN_DEVICE_KEY=${result.device_key}`);
      console.log(`  export PROVIAN_DEVICE_SECRET=${result.device_secret}`);
      // Load-bearing for economic_session_lineage — see writeCredentialsToProfile.
      console.log(`  export PROVIAN_DEVICE_ID=${result.device_id}`);
      console.log(`  export PROVIAN_RELAY_URL=${relayUrl}\n`);
      console.log('  Then restart your terminal or run:');
      console.log(`  source ${shellProfileDisplay}\n`);
      console.log('  Next, install the git hook:');
      console.log('  npx @provian/agent-sdk setup-hook --global\n');
      console.log('  Pending registration retained so this printed-only response can be recovered safely.\n');
      return;
    }

    // -----------------------------------------------------------------------
    // Step 2: Write credentials to machine-local file
    // -----------------------------------------------------------------------
    const credentialsPath = getCredentialsPath();
    console.log(`  Writing credentials to ${credentialsPath}...`);
    // For agent devices, owner_wallet_id from the response is the agent's
    // wallet ID (the backend's authenticateDeviceOwner middleware puts the
    // agent wallet onto req.agentWallet, and the handler writes
    // owner_wallet_id = agentWallet.id). Persist it for the observer's logs.
    // In agent-token mode the relay is the source of truth for the owning agent
    // wallet (it loads the wallet from the single-use token), so we persist the
    // response's owner_wallet_id verbatim and ignore any client-supplied hint.
    // The authoritative response wins in every agent mode; a local wallet-id
    // hint must never relabel credentials for a different economic identity.
    const persistedAgentWalletId = isAgentDevice ? result.owner_wallet_id : undefined;

    writeCredentialsFile({
      deviceKey: result.device_key,
      deviceSecret: result.device_secret,
      relayUrl,
      deviceId: result.device_id,
      registrationId: pendingRegistration.registration_id,
      deviceName: result.device_name,
      ownerType,
      ...(persistedAgentWalletId ? { agentWalletId: persistedAgentWalletId } : {}),
      signingMethod,
      ...(signingKeyAlias ? { signingKeyAlias } : {}),
    });
    const installedCredentials = readCredentialsFile(credentialsPath);
    if (!installedCredentials) {
      throw new Error('Durable device credentials could not be reloaded after installation');
    }
    clearPendingDeviceRegistration(
      pendingRegistration.registration_id,
      installedCredentials,
    );
    console.log('  Done.\n');

    // -----------------------------------------------------------------------
    // Step 2.5: Write credentials to all shell profiles that exist
    // -----------------------------------------------------------------------
    const shellProfiles: { path: string; display: string }[] = [];
    const zshrc = path.join(homedir(), '.zshrc');
    const bashrc = path.join(homedir(), '.bashrc');

    if (fs.existsSync(zshrc)) shellProfiles.push({ path: zshrc, display: '~/.zshrc' });
    if (fs.existsSync(bashrc)) shellProfiles.push({ path: bashrc, display: '~/.bashrc' });

    // If neither exists, create the detected one
    if (shellProfiles.length === 0) {
      const profilePath = detectShellProfile();
      const profileDisplay = detectShellProfileDisplay();
      shellProfiles.push({ path: profilePath, display: profileDisplay });
    }

    for (const profile of shellProfiles) {
      if (shellProfileHasCredentials(profile.path)) {
        console.log(`  Updating existing Provian credentials in ${profile.display}...`);
      } else {
        console.log(`  Writing credentials to ${profile.display}...`);
      }
      writeCredentialsToProfile(
        profile.path,
        result.device_key,
        result.device_secret,
        relayUrl,
        result.device_name,
        result.device_id,
      );
      if (isAgentDevice) writeOTelToProfile(profile.path);
      removeModelProxyFromProfile(profile.path);
    }
    console.log('  Done.\n');

    // Source the first profile to make credentials available in this session
    try {
      const primaryProfile = shellProfiles[0].path;
      execSync(`source "${primaryProfile}"`, { shell: '/bin/zsh', stdio: 'ignore' });
    } catch {
      // Non-fatal - user can restart terminal
    }

    // -----------------------------------------------------------------------
    // Step 3: Install global git hook
    // -----------------------------------------------------------------------
    console.log('  Installing global git hook...');
    try {
      const { hookPath, action, merged } = installGlobalHook();
      console.log(`  Hook ${action}: ${hookPath}`);
      if (merged.length > 0) {
        console.log(`  Merged your prior global hooks so they keep running: ${merged.join(', ')}`);
      }
      console.log('  core.hooksPath set to ~/.provian/hooks/\n');
    } catch (hookError) {
      console.error(`  Warning: Could not install git hook: ${(hookError as Error).message}`);
      console.error('  You can install it manually later: npx @provian/agent-sdk setup-hook --global\n');
    }

    // no PE-reporting instruction section is written to
    // ~/.claude/CLAUDE.md, .cursorrules or .windsurfrules any more (it told the agent
    // to report its own non-commit work with `report-pe --type <x>`), and no
    // self-test PE is submitted (its only witness was this process). An actor's own
    // claim about its work is never a PE; the git hook and the observer daemon
    // record what this machine does. A section an older run already wrote is
    // matched by PE_REPORTING_SECTION_HEADING / _COMMAND_NEEDLE (pe-reporting-section.ts).

    // -----------------------------------------------------------------------
    // Step 4.25: LLM session capture consent (macOS desktop only; plugin
    // self-disables on other platforms). The consent flow is idempotent:
    // once the user has accepted or declined, the config value is pinned
    // and this is a no-op on subsequent runs.
    // -----------------------------------------------------------------------
    if (!isAgentDevice) {
      try {
        const consent = await runLLMSessionConsent({
          rl,
          isTTY: Boolean(process.stdin.isTTY),
          skipFlag: args.skipLlmSessionConsent === true,
          platform: osPlatform(),
        });
        if (consent.firstRun) {
          console.log(`  LLM session capture: ${consent.enabled ? 'enabled' : 'disabled'}.`);
        } else {
          console.log(`  LLM session capture: already ${consent.enabled ? 'enabled' : 'disabled'}.`);
        }
      } catch (err) {
        console.warn(`  Warning: LLM session consent flow failed: ${(err as Error).message}`);
      }
      console.log('');
    }

    // -----------------------------------------------------------------------
    // Step 4.5: Start the observer as a background service
    // -----------------------------------------------------------------------
    let observerStatus: string = 'not started';
    // Only agent devices advertise the OTLP receiver. Human devices never
    // capture tool calls or repoint model traffic.
    const otelActive = isAgentDevice;
    const observerEnv: Record<string, string> = {};
    if (otelActive) {
      observerEnv.OTEL_EXPORTER_OTLP_ENDPOINT = `http://localhost:${OTLP_DEFAULT_PORT}`;
    }
      const { ensureInstallerNodeAvailable } = await import('../observer/node-runtime-heal.js');
      await ensureInstallerNodeAvailable();
    try {
      const existingPid = isObserverRunning();
      if (existingPid) {
        // A live observer loaded its credentials at startup. This run just wrote
        // FRESH credentials (reconnect / key rotation / recovery), so the running
        // process still holds the OLD creds and will 401 on every submit until it
        // restarts. Restart it now so it reloads ~/.provian/credentials — never
        // leave it "running" on stale creds (silent partial failure).
        console.log('  Restarting observer to load new credentials...');
        const result = restartService({ env: observerEnv });
        await new Promise(resolve => setTimeout(resolve, 2000));
        const pid = isObserverRunning();
        observerStatus = pid
          ? `restarted via ${result.method} (pid ${pid})`
          : `${result.method} (restarting; check ${PID_FILE})`;
        if (pid) console.log(`  ✓ Observer restarted via ${result.method}`);
      } else {
        console.log('  Starting observer...');
        const result = installService({ env: observerEnv });
        // Give launchd/systemd a moment to spawn the child
        await new Promise(resolve => setTimeout(resolve, 2000));
        const pid = isObserverRunning();
        if (pid) {
          observerStatus = `${result.method} (pid ${pid})`;
          console.log(`  ✓ Observer started via ${result.method}`);
        } else if (result.method === 'detached') {
          observerStatus = 'detached (no service manager available - restart manually after reboot)';
          console.log('  ⚠ Observer started as detached process. Will not auto-restart after reboot.');
        } else {
          observerStatus = `${result.method} (starting; check ${PID_FILE})`;
          console.log(`  Observer install via ${result.method} done; it may take a moment to spawn.`);
        }
      }
    } catch (err) {
      observerStatus = `not started (${(err as Error).message})`;
      console.warn(`  ⚠ Could not start observer: ${(err as Error).message}`);
      console.warn('  You can start it manually with: npx @provian/agent-sdk observe');
    }

    if (otelActive) {
      // Lever 3: publish the endpoint session-wide NOW so an agent restarted
      // right after onboarding inherits it without waiting for a login/reboot.
      // Best-effort; the observer re-publishes on every start (Lever 1) and
      // `npx @provian/agent-sdk run` is the launch-mode-independent fallback (Lever 2).
      try {
        const pub = publishSessionOtelEndpoint(OTLP_DEFAULT_PORT);
        if (pub.published) {
          console.log('');
          console.log(`  ✓ OTLP endpoint published to your session (${pub.endpoint}).`);
          console.log(`  ${pub.note}`);
        }
      } catch { /* best-effort */ }

      console.log('');
      console.log('  OTel integration active. Agent frameworks on this machine will automatically');
      console.log('  export telemetry to the Provian observer. If your agent runs in a separate');
      console.log('  terminal or an already-running process, set this in its environment (or');
      console.log('  launch it once via `npx @provian/agent-sdk run`):');
      console.log('');
      console.log(`    export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:${OTLP_DEFAULT_PORT}`);
      console.log('');
      // Guided Step 2: name the detected harness and print its capture story.
      // For cataloged harnesses (OpenClaw/Claude Code) this now says "no code
      // change — the transcript watcher reads your session records"; OTel
      // emission is the optional push path. Single copy source: harness-guidance.
      const harness = detectAgentHarness();
      const guidance = harnessEnableGuidance(harness);
      console.log(`  Next — tool-call capture for ${guidance.label}:`);
      for (const line of guidance.steps) console.log(`  ${line}`);
      console.log('');
      console.log('  Then confirm capture end-to-end:');
      console.log('    npx @provian/agent-sdk doctor');
      console.log('  Or run the guided setup that does all of this for you:');
      console.log('    npx @provian/agent-sdk start');
    }
    if (isAgentDevice) for (const line of witnessSetupLines('  ')) console.log(line);
    console.log('');

    // -----------------------------------------------------------------------
    // Step 5: Print summary
    // -----------------------------------------------------------------------
    console.log('  ┌──────────────────────────────────────────────────┐');
    console.log('  │  Your machine is now part of the Provian network │');
    console.log('  └──────────────────────────────────────────────────┘\n');
    console.log(`  Device:   ${result.device_name}`);
    console.log(`  Owner:    ${result.owner_wallet_id} (${ownerType})`);
    console.log(`  Creds:    ${credentialsPath}`);
    console.log(`  Shells:   ${shellProfiles.map(p => p.display).join(', ')}`);
    console.log(`  Hook:     Global (all repos)`);
    console.log(`  Observer: ${observerStatus}`);
    // Zero-config local inference: say what the daemon will witness on this
    // machine. Loopback probe, bounded, never throws.
    try {
      const inference = await probeLocalInferenceRuntimes({ timeoutMs: 750 });
      console.log(`  Local inference: ${describeLocalInferenceProbe(inference)}`);
      if (inference.detected) {
        console.log('    Local model work (Ollama / LM Studio / llama.cpp) is witnessed as inference_session PEs.');
      }
    } catch { /* advisory only */ }
    console.log('');
    if (isAgentDevice) {
      console.log('  Agent device: PEs are attributed to the agent wallet. An unlinked');
      console.log('  agent keeps its contributor share. A verified active beneficiary link');
      console.log('  seals the configured BPS per PE (default 20% agent / 80% human;');
      console.log('  agent range 5%–50%). Tier 3+ linked work also adds its delegation');
      console.log('  value to the beneficiary human chain without a second mint.\n');
      // Git identity guidance (Part 2): the forge webhook credits the
      // git AUTHOR by a registered identity → wallet mapping. Print the exact
      // command when this machine has a git author email; the install probe
      // (device auth, best-effort) picks the phrasing.
      const authorEmail = readGitAuthorEmail();
      if (authorEmail) {
        const hasInstall = await probeGitHubInstalls(relayUrl, result.device_key, result.device_secret);
        for (const line of gitIdentityGuidanceLines({ authorEmail }, hasInstall)) console.log(`  ${line}`);
        console.log('');
      }
    } else {
      console.log('  Every git commit on this machine now generates Provenance Envelopes.');
      console.log('  All work is attributed to the device owner automatically.\n');
    }
    console.log('  Restart your terminal or run:');
    console.log(`  source ${shellProfiles[0].display}\n`);
  } finally {
    rl.close();
  }
}

// Only auto-run when invoked as a script (the bin entry), not when imported -
// e.g. by invite-device's shared loader path or by unit tests that exercise the
// exported buildRegisterAuthHeader helper. main() performs FS mutation, git-hook
// installation, and observer start that must never run on import.
if (isDirectCliEntry(module)) {
  main().catch(error => {
    console.error('Unexpected error:', error);
    process.exit(1);
  });
}
