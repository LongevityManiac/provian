/**
 * Tests for device-bootstrap-script — the "Connect a computer" one-liners
 * (macOS/Linux sh + Windows PowerShell) and the hosted scripts they return.
 *
 * Negative-control doctrine (run contract): every guard here is exercised with
 * BOTH a passing and a deliberately-violating input, so no assertion can pass
 * vacuously. The token validator, the builders' throw-on-bad-token, and the
 * https-origin guard each have their RED case recorded alongside the GREEN one.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildDeviceBootstrapCommand,
  buildDeviceBootstrapCommandWindows,
  buildDeviceBootstrapScript,
  buildDeviceBootstrapPowershell,
  isValidDeviceSetupTokenFormat,
  DEVICE_BOOTSTRAP_SCRIPT_ROUTE,
  BOOTSTRAP_NODE_VERSION,
} from './device-bootstrap-script';

// A real-shape token: 64 lowercase hex chars (crypto.randomBytes(32).toString('hex')).
const VALID_TOKEN = 'a'.repeat(64);
const RELAY = 'https://api.provian.ai';

// PowerShell syntax check — self-activates wherever `pwsh` exists (a CI runner,
// or a dev box with `brew install powershell`), and skips cleanly otherwise so
// no environment is forced to have it.
function hasPwsh(): boolean {
  try {
    return spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'],
      { encoding: 'utf8' }).status === 0;
  } catch { return false; }
}
function pwshParseErrors(script: string): number {
  const file = path.join(os.tmpdir(), `provian-ps-${Math.abs(hashCode(script))}.ps1`);
  fs.writeFileSync(file, script);
  try {
    const res = spawnSync('pwsh', ['-NoProfile', '-Command',
      `$e=@(); [void][System.Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$null,[ref]$e); exit $e.Count`],
      { encoding: 'utf8' });
    return res.status ?? -1;
  } finally { try { fs.unlinkSync(file); } catch { /* ok */ } }
}
function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return h;
}
const pwshIt = hasPwsh() ? it : it.skip;

describe('isValidDeviceSetupTokenFormat', () => {
  it('accepts a 64-char lowercase hex token', () => {
    expect(isValidDeviceSetupTokenFormat(VALID_TOKEN)).toBe(true);
    expect(isValidDeviceSetupTokenFormat('0123456789abcdef'.repeat(4))).toBe(true);
  });

  // RED controls — each MUST be rejected, or the guard is meaningless.
  it.each([
    ['too short (63)', 'a'.repeat(63)],
    ['too long (65)', 'a'.repeat(65)],
    ['uppercase hex', 'A'.repeat(64)],
    ['non-hex char', `${'a'.repeat(63)}g`],
    ['empty string', ''],
    ['whitespace-padded', ` ${'a'.repeat(64)} `],
  ])('rejects %s', (_label, bad) => {
    expect(isValidDeviceSetupTokenFormat(bad)).toBe(false);
  });

  it.each([[undefined], [null], [12345], [{}], [['a']]])(
    'rejects non-string %p',
    (bad) => {
      expect(isValidDeviceSetupTokenFormat(bad as unknown)).toBe(false);
    },
  );
});

describe('buildDeviceBootstrapCommand (macOS/Linux)', () => {
  it('builds the curl|sh one-liner as a GET with the token in the header, not the URL (item 9)', () => {
    const cmd = buildDeviceBootstrapCommand({ token: VALID_TOKEN, relayUrl: RELAY });
    expect(cmd).toContain(`-H 'x-provian-token: ${VALID_TOKEN}'`);
    expect(cmd).not.toContain('-X POST'); // a body-less POST is GFE's 411
    expect(cmd).not.toContain(' -d ');
    expect(cmd).toContain(`"${RELAY}${DEVICE_BOOTSTRAP_SCRIPT_ROUTE}"`);
    expect(cmd.trimEnd().endsWith('| sh')).toBe(true);
    const urlPart = cmd.slice(cmd.indexOf('https://'));
    expect(urlPart).not.toContain(VALID_TOKEN);
  });

  it('strips a trailing slash from the relay origin', () => {
    const cmd = buildDeviceBootstrapCommand({ token: VALID_TOKEN, relayUrl: `${RELAY}/` });
    expect(cmd).toContain(`"${RELAY}${DEVICE_BOOTSTRAP_SCRIPT_ROUTE}"`);
    expect(cmd).not.toContain('//v1/bootstrap');
  });

  it('throws on an invalid token', () => {
    expect(() => buildDeviceBootstrapCommand({ token: 'nope', relayUrl: RELAY })).toThrow();
  });

  it.each([
    ['http origin', 'http://api.provian.ai'],
    ['origin with a path', 'https://api.provian.ai/x'],
    ['origin with a query', 'https://api.provian.ai/?a=b'],
  ])('throws on %s', (_label, relay) => {
    expect(() => buildDeviceBootstrapCommand({ token: VALID_TOKEN, relayUrl: relay })).toThrow();
  });
});

describe('buildDeviceBootstrapCommandWindows (PowerShell one-liner)', () => {
  it('builds the irm|iex one-liner as a GET with token + platform in headers, not the URL', () => {
    const cmd = buildDeviceBootstrapCommandWindows({ token: VALID_TOKEN, relayUrl: RELAY });
    expect(cmd).toContain(`-Headers @{'x-provian-token'='${VALID_TOKEN}';'x-provian-platform'='windows'}`);
    expect(cmd).not.toContain('-Method Post');
    expect(cmd).toContain(`"${RELAY}${DEVICE_BOOTSTRAP_SCRIPT_ROUTE}"`);
    expect(cmd.trimEnd().endsWith('| iex')).toBe(true);
    const urlPart = cmd.slice(cmd.indexOf('https://'));
    expect(urlPart).not.toContain(VALID_TOKEN);
  });

  it('throws on an invalid token or non-https relay', () => {
    expect(() => buildDeviceBootstrapCommandWindows({ token: 'nope', relayUrl: RELAY })).toThrow();
    expect(() => buildDeviceBootstrapCommandWindows({ token: VALID_TOKEN, relayUrl: 'http://x' })).toThrow();
  });
});

describe('buildDeviceBootstrapScript (sh)', () => {
  const script = buildDeviceBootstrapScript({ token: VALID_TOKEN, relayUrl: RELAY });

  it('produces a script the real shell parser accepts (sh -n)', () => {
    // Strongest control: any syntax error in the composed prelude fails sh -n,
    // where a hand-written string assertion would pass over a broken script.
    const res = spawnSync('sh', ['-n'], { input: script, encoding: 'utf8' });
    if (res.status !== 0) console.error(res.stderr);
    expect(res.status).toBe(0);
  });

  it('is a POSIX sh script with the token and relay baked in', () => {
    expect(script.startsWith('#!/bin/sh')).toBe(true);
    expect(script).toContain(`SETUP_TOKEN='${VALID_TOKEN}'`);
    expect(script).toContain(`RELAY_URL='${RELAY}'`);
    expect(script).toContain(`NODE_VERSION='${BOOTSTRAP_NODE_VERSION}'`);
  });

  it('passes the one-time token by ENV, never as an argv flag', () => {
    expect(script).toContain('PROVIAN_SETUP_TOKEN="$SETUP_TOKEN"');
    expect(script).not.toContain('--token');
    expect(script).toContain('register-device --yes');
  });

  it('enables LLM session capture (--skip-llm-session-consent) — non-TTY would else fail-close to OFF', () => {
    // curl | sh has no TTY, so without this flag register-device defaults LLM
    // session capture to disabled and the daemon witnesses only git — never AI
    // sessions. Dropping this flag silently breaks capture for every user.
    expect(script).toContain('register-device --yes --skip-llm-session-consent');
  });

  it('handles Node.js: uses only private pinned Node22 with SQLite and a fail-closed download (F36)', () => {
    expect(script).not.toContain('command -v node');
    expect(script).toContain('$HOME/.provian/node/bin/node');
    expect(script).toContain('node:sqlite'); // capability probe, not a version gate
    expect(script).toContain('nodejs.org/dist');
    // F36 (2026-09-10): integrity is a PER-PLATFORM PINNED SHA256 verified against
    // a locally-computed digest and FAIL-CLOSED — NOT the retired same-origin
    // SHASUMS256.txt, which a MITM could substitute alongside the tarball and which
    // failed OPEN. Assert the new mechanism is present AND the retired marker is
    // gone: the pair is the control (before F36 the script had SHASUMS256.txt and
    // no NODE_EXPECTED, so it would fail BOTH of these).
    expect(script).toContain('NODE_EXPECTED=');
    expect(script).toMatch(/shasum -a 256|sha256sum/);
    expect(script).toContain('Could not verify the Node.js download');
    expect(script).not.toContain('SHASUMS256.txt');
    expect(script).toContain('rm -rf ~/.provian/node');
  });

  it('points Windows users to the PowerShell command instead of failing raw', () => {
    expect(script).toContain('use the PowerShell command shown in the Provian app');
  });

  it('fails with a plain sentence (never a raw error) when setup cannot finish', () => {
    expect(script).toContain('has not launched publicly yet');
    expect(script).toContain('say()');
  });

  it('uses set -eu and cleans up its Node temp dir inline (composition-safe)', () => {
    expect(script).toContain('set -eu');
    expect(script).toContain('rm -rf "$NODE_TMP"');
    // No global EXIT trap — the prelude must compose inside a caller that has one.
    expect(script).not.toContain('trap ');
  });

  it('throws on an invalid token or non-https relay', () => {
    expect(() => buildDeviceBootstrapScript({ token: 'bad', relayUrl: RELAY })).toThrow();
    expect(() => buildDeviceBootstrapScript({ token: VALID_TOKEN, relayUrl: 'http://x' })).toThrow();
  });
});

describe('buildDeviceBootstrapPowershell (Windows)', () => {
  const script = buildDeviceBootstrapPowershell({ token: VALID_TOKEN, relayUrl: RELAY });

  it('is a PowerShell script with the token and relay baked in', () => {
    expect(script).toContain(`$SetupToken = '${VALID_TOKEN}'`);
    expect(script).toContain(`$RelayUrl = '${RELAY}'`);
    expect(script).toContain("$ErrorActionPreference = 'Stop'");
    expect(script).toContain(`$NodeVersion = '${BOOTSTRAP_NODE_VERSION}'`);
  });

  it('passes the one-time token by ENV, never as an argv flag', () => {
    expect(script).toContain('$env:PROVIAN_SETUP_TOKEN = $SetupToken');
    expect(script).not.toContain('--token');
    expect(script).toContain('register-device --yes');
  });

  it('enables LLM session capture (--skip-llm-session-consent) — irm | iex has no TTY', () => {
    // Same fail-closed trap as the sh path: without the flag the Windows rail
    // defaults LLM session capture OFF. One paste must enable full capture.
    expect(script).toContain('register-device --yes --skip-llm-session-consent');
  });

  it('handles Node.js: uses only private pinned Node22 with SQLite and a fail-closed download (F36)', () => {
    expect(script).not.toContain('Get-Command node');
    expect(script).toContain('$privateNode');
    expect(script).toContain('node:sqlite'); // capability probe, not a version gate
    expect(script).toContain('nodejs.org/dist');
    // F36: pinned per-platform SHA256 checked with Get-FileHash, FAIL-CLOSED — NOT
    // the retired same-origin SHASUMS256.txt. Present-new + absent-retired is the control.
    expect(script).toContain('Get-FileHash');
    expect(script).toContain('Could not verify the Node.js download');
    expect(script).not.toContain('SHASUMS256.txt');
    expect(script).toContain('-win-'); // fetches the Windows Node build
  });

  it('fails with a plain sentence (never a raw error) when setup cannot finish', () => {
    expect(script).toContain('has not launched publicly yet');
    expect(script).toContain('function Say');
    expect(script).toContain('$LASTEXITCODE');
  });

  it('throws on an invalid token or non-https relay', () => {
    expect(() => buildDeviceBootstrapPowershell({ token: 'bad', relayUrl: RELAY })).toThrow();
    expect(() => buildDeviceBootstrapPowershell({ token: VALID_TOKEN, relayUrl: 'http://x' })).toThrow();
  });

  pwshIt('parses as valid PowerShell (real pwsh parser, when available)', () => {
    expect(pwshParseErrors(script)).toBe(0);
  });
});
