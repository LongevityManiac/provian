/**
 * shell-profile — the marker-delimited OTel / model-proxy blocks written into the user's shell
 * profile, extracted from register-device.ts so the one-command bootstrap imports ONLY
 * this — not the npm register-device CLI and its npm-only command text — into the hosted bundle.
 * register-device.ts re-exports every name here, so existing callers keep their import.
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { OTLP_DEFAULT_PORT } from '../observer/plugins/OTelPlugin';

const OTEL_START_MARKER = '# --- Provian OTel Environment Start ---';
const OTEL_END_MARKER = '# --- Provian OTel Environment End ---';
const MODELPROXY_START_MARKER = '# --- Provian Model Proxy (Lane 5) Start ---';
const MODELPROXY_END_MARKER = '# --- Provian Model Proxy (Lane 5) End ---';

export function detectShellProfile(): string {
  const shell = process.env.SHELL || '';
  if (shell.includes('zsh')) return path.join(homedir(), '.zshrc');
  if (shell.includes('fish')) return path.join(homedir(), '.config', 'fish', 'config.fish');
  if (shell.includes('bash')) return path.join(homedir(), '.bashrc');
  return path.join(homedir(), '.profile');
}

export function detectShellProfileDisplay(): string {
  const shell = process.env.SHELL || '';
  if (shell.includes('zsh')) return '~/.zshrc';
  if (shell.includes('fish')) return '~/.config/fish/config.fish';
  if (shell.includes('bash')) return '~/.bashrc';
  return '~/.profile';
}

export function isFishShell(): boolean {
  return (process.env.SHELL || '').includes('fish');
}

export function buildExportLine(key: string, value: string): string {
  if (isFishShell()) {
    return `set -gx ${key} ${value}`;
  }
  return `export ${key}=${value}`;
}

export function writeOTelToProfile(profilePath: string): void {
  // Spans go to the LOCAL observer OTLP receiver (OTelPlugin on
  // 127.0.0.1:4318), which turns qualifying spans into PEs and authenticates
  // to the relay with the device credentials itself. The previous block
  // pointed frameworks at `${relayUrl}/v1/otel` — an endpoint that has never
  // existed on the relay (404) — and leaked the DeviceKey credentials as OTLP
  // headers toward whatever endpoint the env resolved to. The localhost
  // receiver takes no auth header; re-running register-device replaces the
  // stale block in place via the markers.
  const block = [
    OTEL_START_MARKER,
    buildExportLine('OTEL_EXPORTER_OTLP_ENDPOINT', `http://localhost:${OTLP_DEFAULT_PORT}`),
    buildExportLine('OTEL_SERVICE_NAME', 'provian-agent'),
    OTEL_END_MARKER,
  ].join('\n');

  if (fs.existsSync(profilePath)) {
    const content = fs.readFileSync(profilePath, 'utf-8');

    const startIdx = content.indexOf(OTEL_START_MARKER);
    const endIdx = content.indexOf(OTEL_END_MARKER);
    if (startIdx !== -1 && endIdx !== -1) {
      const before = content.substring(0, startIdx).replace(/\n+$/, '');
      const after = content.substring(endIdx + OTEL_END_MARKER.length).replace(/^\n+/, '');
      const parts = [before, block, after].filter(Boolean);
      fs.writeFileSync(profilePath, parts.join('\n\n') + '\n');
      return;
    }

    fs.writeFileSync(profilePath, content.trimEnd() + '\n\n' + block + '\n');
  } else {
    const dir = path.dirname(profilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(profilePath, block + '\n');
  }
}

/**
 * Remove the model-proxy base-URL block from a profile (D). Used when the
 * shim is NOT listening: an installer must never leave a harness's base URL
 * pointed at a port nothing listens on — that breaks the human's model access.
 * Returns true when a block was removed.
 */
export function removeModelProxyFromProfile(profilePath: string): boolean {
  if (!fs.existsSync(profilePath)) return false;
  const content = fs.readFileSync(profilePath, 'utf-8');
  const startIdx = content.indexOf(MODELPROXY_START_MARKER);
  const endIdx = content.indexOf(MODELPROXY_END_MARKER);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return false;
  const before = content.substring(0, startIdx).replace(/\n+$/, '');
  const after = content.substring(endIdx + MODELPROXY_END_MARKER.length).replace(/^\n+/, '');
  const parts = [before, after].filter(Boolean);
  fs.writeFileSync(profilePath, parts.length ? parts.join('\n\n') + '\n' : '');
  return true;
}

/**
 * Write the OTel + model-proxy blocks into every shell profile that exists
 * (zshrc/bashrc), or the detected default when neither does — the same
 * enumeration main() uses for credentials. Exported so the one-command bootstrap
 * (`bootstrap-flow.ts`) configures the observer env in the SAME pass as wallet +
 * daemon, instead of leaving the profile block to a later manual `register-device`
 * run. This module stays the single owner of the profile markers and detection.
 * Skips the model-proxy block when it is opted out (PROVIAN_MODEL_PROXY=0), so a
 * device that will not run the shim does not get env pointed at a closed port.
 */
export function writeOTelToExistingProfiles(
  opts: {
    /**
     * (D): 'write' points the harness base URLs at the shim; 'remove'
     * strips any such block (the shim is not listening — never leave a base URL
     * pointed at a dead port). Default 'write' keeps the register-device path's
     * behaviour for callers that start the shim themselves.
     */
    modelProxy?: 'remove';
  } = {},
): string[] {
  const profiles: { path: string; display: string }[] = [];
  const zshrcPath = path.join(homedir(), '.zshrc');
  const bashrcPath = path.join(homedir(), '.bashrc');
  if (fs.existsSync(zshrcPath)) profiles.push({ path: zshrcPath, display: '~/.zshrc' });
  if (fs.existsSync(bashrcPath)) profiles.push({ path: bashrcPath, display: '~/.bashrc' });
  if (profiles.length === 0) {
    profiles.push({ path: detectShellProfile(), display: detectShellProfileDisplay() });
  }
  for (const profile of profiles) {
    writeOTelToProfile(profile.path);
    removeModelProxyFromProfile(profile.path);
  }
  return profiles.map((p) => p.display);
}


/** Undo only installer-owned global endpoint blocks, on upgrade as well as setup. */
export function removeModelProxyFromExistingProfiles(home = homedir()): void {
  for (const relative of ['.zshrc','.bashrc','.profile','.config/fish/config.fish']) removeModelProxyFromProfile(path.join(home,relative));
}
