/**
 * runtime-env — carry the box's egress environment (forward proxy, loopback
 * bypass, extra CA) into EVERY Provian Node process,
 * however that process was started (, requirement C).
 *
 * THE DEFECT THIS CLOSES (§3). On a cloud-VM agent box whose only egress
 * is a forward proxy (a hosted agent's runtime cell; Grok Bot under Network
 * Controls), Node's global `fetch` ignores `HTTPS_PROXY` and fails `EAI_AGAIN`,
 * and Node never reads the system CA store, so a TLS-inspecting proxy's CA is
 * untrusted. Node honours both only when told at PROCESS START:
 * `NODE_USE_ENV_PROXY=1` (Node ≥ 22.21 / ≥ 24.5) routes `fetch` AND
 * `http(s).request` through `HTTP(S)_PROXY` minus `NO_PROXY`, and
 * `NODE_EXTRA_CA_CERTS` adds trust anchors. Neither can be switched on from
 * inside a running process. And the variables the install shell had never
 * reached a daemon started by systemd, launchd or cron.
 *
 * THE MECHANISM (one, uniform for every entry). The installer writes the box's
 * egress variables to `~/.provian/runtime.env` (0600, allowlisted keys only).
 * Every Node entry point — the bundle dispatcher (install, `observe`,
 * `report-pe` from the git hook), the npm observer, the npm hook — calls
 * `applyRuntimeEnvAtEntry()` FIRST. It merges the file under the live
 * environment (the live environment always wins), guarantees loopback is in
 * `NO_PROXY` whenever a proxy is in effect (the OTLP receiver
 * and model shim are loopback and must never be proxied), and, when a
 * start-time-only variable differs from what this process started with,
 * re-executes itself once with the merged environment (`process.execve` when
 * the runtime has it, else a supervised child). So a service unit, a cron line
 * or a hook needs to carry nothing — the file is the one source.
 *
 * INVARIANTS.
 * - Destination checks are unchanged: the SDK egress guard still judges the
 * DESTINATION host, never the proxy; bundle hashes and signed-channel
 * signatures are verified exactly as before (TLS to the relay still verifies,
 * against the system anchors plus any extra CA).
 * - Loopback is never proxied (`127.0.0.1`, `localhost`, ` :1` always in
 * `NO_PROXY` when a proxy is set).
 * - Only allowlisted keys are ever read from or written to the file, so it can
 * never inject `NODE_OPTIONS`, a preload, or anything else executable.
 * - One re-exec at most (guard variable), never a loop.
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';

/** Where the installer records the box's egress environment. */
export function runtimeEnvPath(home: string = homedir()): string {
  return path.join(home, '.provian', 'runtime.env');
}

/** Proxy variables Node's env-proxy support reads (both cases, as curl does). */
export const PROXY_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const;
export const NO_PROXY_KEYS = ['NO_PROXY', 'no_proxy'] as const;

/**
 * The ONLY keys runtime.env may carry. Anything else in the file is ignored on
 * read and never written. (retired the local witness endpoint; its
 * PROVIAN_WITNESS_* opt-ins are no longer carried — a line an earlier installer
 * wrote is ignored, and an updated daemon prunes it.)
 */
export const RUNTIME_ENV_KEYS: readonly string[] = [
  ...PROXY_KEYS,
  ...NO_PROXY_KEYS,
  'NODE_USE_ENV_PROXY',
  'NODE_EXTRA_CA_CERTS',
];

/** Variables Node reads once at process start — a change requires a re-exec. */
const START_TIME_KEYS: readonly string[] = [
  'NODE_USE_ENV_PROXY', 'NODE_EXTRA_CA_CERTS', ...PROXY_KEYS, ...NO_PROXY_KEYS,
];

/** Hosts that are always loopback and must never be sent to a proxy. */
export const LOOPBACK_NO_PROXY = ['127.0.0.1', 'localhost', '::1'] as const;

/** Guard so a re-executed process never re-executes again. */
export const RUNTIME_ENV_REEXEC_GUARD = 'PROVIAN_RUNTIME_ENV_REEXEC';

/**
 * System CA bundles, most common first. Used only on Linux, where a
 * TLS-inspecting proxy's CA is installed into the OS store (curl trusts it) but
 * Node does not read that store.
 */
export const LINUX_SYSTEM_CA_BUNDLES = [
  '/etc/ssl/certs/ca-certificates.crt', // Debian, Ubuntu, Alpine (ca-certificates)
  '/etc/pki/tls/certs/ca-bundle.crt', // RHEL, Fedora, Amazon Linux
  '/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem', // RHEL 7+ extracted
  '/etc/ssl/ca-bundle.pem', // openSUSE
  '/etc/ssl/cert.pem', // Alpine / generic OpenSSL
] as const;

/** Does this Node runtime honour `NODE_USE_ENV_PROXY` for fetch and http(s)? */
export function nodeSupportsEnvProxy(nodeVersion: string = process.versions.node): boolean {
  const [major, minor] = nodeVersion.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10));
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  if (major === 22) return minor >= 21;
  if (major === 24) return minor >= 5;
  return major >= 25;
}

export function hasProxy(env: NodeJS.ProcessEnv): boolean {
  return PROXY_KEYS.some((k) => typeof env[k] === 'string' && (env[k] as string).trim().length > 0);
}

/** Merge the loopback hosts into a NO_PROXY list, preserving the caller's entries and order. */
export function withLoopbackNoProxy(value: string | undefined): string {
  const entries = (value ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  const missing = LOOPBACK_NO_PROXY.filter((h) => !entries.includes(h));
  return [...missing, ...entries].join(',');
}

export interface RuntimeEnvProbe {
  platform?: NodeJS.Platform;
  exists?: (p: string) => boolean;
}

/** The extra-CA file this box needs Node to trust, or null. */
export function resolveExtraCaFile(env: NodeJS.ProcessEnv, probe: RuntimeEnvProbe = {}): string | null {
  const exists = probe.exists ?? ((p: string) => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  });
  // An operator's explicit choice, in the order the common tools read them.
  for (const key of ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE']) {
    const v = env[key];
    if (typeof v === 'string' && v.length > 0 && exists(v)) return v;
  }
  // The OS store, on Linux only (macOS/Windows keep corporate anchors in a
  // keychain/cert store, not a PEM file, so there is nothing to point at).
  if ((probe.platform ?? process.platform) === 'linux') {
    for (const candidate of LINUX_SYSTEM_CA_BUNDLES) {
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The runtime environment the INSTALLER captures from its own shell. Pure over
 * `env` + `probe`. Empty when the box has no proxy and no extra CA.
 */
export function computeRuntimeEnv(env: NodeJS.ProcessEnv, probe: RuntimeEnvProbe = {}): Record<string, string> {
  const out: Record<string, string> = {};
  if (hasProxy(env)) {
    for (const k of PROXY_KEYS) {
      const v = env[k];
      if (typeof v === 'string' && v.trim().length > 0) out[k] = v.trim();
    }
    const noProxy = withLoopbackNoProxy(env.NO_PROXY ?? env.no_proxy);
    out.NO_PROXY = noProxy;
    out.no_proxy = noProxy;
    out.NODE_USE_ENV_PROXY = '1';
  }
  const ca = resolveExtraCaFile(env, probe);
  if (ca) out.NODE_EXTRA_CA_CERTS = ca;
  return out;
}

/** Serialize (allowlisted keys only; values with a newline are dropped, never escaped). */
export function serializeRuntimeEnv(values: Record<string, string>): string {
  const lines = ['# Written by the Provian installer. Loaded by every Provian process on this machine.'];
  for (const key of RUNTIME_ENV_KEYS) {
    const v = values[key];
    if (typeof v !== 'string' || v.length === 0 || /[\r\n]/.test(v)) continue;
    lines.push(`${key}=${v}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Parse the file (allowlisted keys only; comments and unknown keys ignored). */
export function parseRuntimeEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!RUNTIME_ENV_KEYS.includes(key)) continue;
    out[key] = line.slice(eq + 1);
  }
  return out;
}

export function readRuntimeEnvFile(file: string = runtimeEnvPath()): Record<string, string> {
  try { return parseRuntimeEnv(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

/**
 * Persist what the installer saw. Replaces the file (a re-install from a shell
 * with a different proxy must not keep the stale one); removes it when there is
 * nothing to carry. Returns the keys written.
 */
export function persistRuntimeEnv(
  env: NodeJS.ProcessEnv,
  opts: { file?: string; probe?: RuntimeEnvProbe } = {},
): string[] {
  const file = opts.file ?? runtimeEnvPath();
  const values = computeRuntimeEnv(env, opts.probe);
  const keys = Object.keys(values);
  if (keys.length === 0) {
    try { fs.unlinkSync(file); } catch { /* absent is fine */ }
    return [];
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, serializeRuntimeEnv(values), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return keys;
}

export interface RuntimeEnvDecision {
  /** The environment this process should run with. */
  env: NodeJS.ProcessEnv;
  /** True when a start-time-only variable differs from what the process started with. */
  reexec: boolean;
  /** Plain notes for the log (never a secret value). */
  notes: string[];
}

/**
 * Decide the effective environment for THIS process. Pure: `current` is the
 * environment the process started with, `fromFile` what the installer recorded.
 */
export function decideRuntimeEnv(
  current: NodeJS.ProcessEnv,
  fromFile: Record<string, string>,
  nodeVersion: string = process.versions.node,
): RuntimeEnvDecision {
  const env: NodeJS.ProcessEnv = { ...current };
  const notes: string[] = [];
  // The live environment wins; the file only fills what is missing.
  for (const [k, v] of Object.entries(fromFile)) {
    if (env[k] === undefined || env[k] === '') env[k] = v;
  }
  // A proxy in effect → loopback bypass + Node's env-proxy support, both cases of NO_PROXY.
  if (hasProxy(env)) {
    const merged = withLoopbackNoProxy(env.NO_PROXY ?? env.no_proxy);
    env.NO_PROXY = merged;
    env.no_proxy = merged;
    if (nodeSupportsEnvProxy(nodeVersion)) {
      if (!env.NODE_USE_ENV_PROXY) env.NODE_USE_ENV_PROXY = '1';
    } else {
      notes.push(
        `this Node (${nodeVersion}) cannot route through the configured proxy; `
        + 'Node 22.21+ is needed (the hosted install line fetches one)',
      );
    }
  }
  const alreadyReexeced = current[RUNTIME_ENV_REEXEC_GUARD] === '1';
  const changed = START_TIME_KEYS.some((k) => (current[k] ?? '') !== (env[k] ?? ''));
  return { env, reexec: changed && !alreadyReexeced, notes };
}

export interface ApplyRuntimeEnvDeps {
  env?: NodeJS.ProcessEnv;
  file?: string;
  /**
   * Merge these in place of the file. `onboard` passes what it read from its own shell, which is
   * authoritative for an install, so it can reach the relay before it has written anything.
   */
  recorded?: Record<string, string>;
  nodeVersion?: string;
  execPath?: string;
  execArgv?: string[];
  argv?: string[];
  log?: (line: string) => void;
  /** `process.execve` (Node ≥ 22.15) — replaces the process image, same pid. */
  execve?: ((file: string, args: string[], env: NodeJS.ProcessEnv) => never) | null;
  spawnSync?: typeof spawnSync;
  exit?: (code: number) => never;
}

/**
 * Call FIRST in every Node entry point. Returns normally when this process
 * already runs with the right environment (after updating `process.env` with the
 * non-start-time values). Otherwise re-executes and never returns.
 */
export function applyRuntimeEnvAtEntry(deps: ApplyRuntimeEnvDeps = {}): void {
  const current = deps.env ?? process.env;
  const decision = decideRuntimeEnv(current, deps.recorded ?? readRuntimeEnvFile(deps.file), deps.nodeVersion);
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  for (const note of decision.notes) log(`[provian] ${note}`);
  if (!decision.reexec) {
    // Non-start-time values are read later from process.env; apply them in place.
    for (const [k, v] of Object.entries(decision.env)) {
      if (v !== undefined && current[k] !== v) current[k] = v;
    }
    return;
  }
  const childEnv: NodeJS.ProcessEnv = { ...decision.env, [RUNTIME_ENV_REEXEC_GUARD]: '1' };
  const execPath = deps.execPath ?? process.execPath;
  const args = [...(deps.execArgv ?? process.execArgv), ...(deps.argv ?? process.argv).slice(1)];
  const execve = deps.execve !== undefined
    ? deps.execve
    : (typeof (process as unknown as { execve?: unknown }).execve === 'function'
      ? ((process as unknown as { execve: (f: string, a: string[], e: NodeJS.ProcessEnv) => never }).execve.bind(process))
      : null);
  if (execve) {
    try {
      execve(execPath, [execPath, ...args], childEnv);
    } catch {
      // Fall through to the supervised child below.
    }
  }
  const run = deps.spawnSync ?? spawnSync;
  const res = run(execPath, args, { stdio: 'inherit', env: childEnv });
  const exit = deps.exit ?? ((code: number) => process.exit(code) as never);
  exit(typeof res.status === 'number' ? res.status : 1);
}
