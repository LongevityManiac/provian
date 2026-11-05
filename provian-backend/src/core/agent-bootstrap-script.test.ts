import { describe, it, expect } from '@jest/globals';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildAgentBootstrapScript,
  buildAgentBootstrapPowershell,
  genesisOfferSh,
  genesisOfferPs,
  AGENT_BOOTSTRAP_BUNDLE_ROUTE,
} from './agent-bootstrap-script';
import { GENESIS_WINDOW_END_MS, GENESIS_OFFER_LINE } from '../mcp/core/genesis-offer';
import { PROPOSED_GENESIS_CAMPAIGN_POLICY } from './pvt/policy/proposed-genesis-policy';

const TOKEN = 'PROV-ABCD-2345';
const RELAY = 'https://api.provian.ai';
// A valid 64-hex bundle SHA256 for the build calls (F36).
const VALID_SHA = 'a'.repeat(64);

describe('buildAgentBootstrapScript', () => {
  it('produces a script that the real shell parser accepts (sh -n)', () => {
    // The strongest control: if the generated script has ANY syntax error, sh -n
    // fails. A hand-written string assertion would pass over a broken script.
    const script = buildAgentBootstrapScript({ token: TOKEN, relayUrl: RELAY, bundleSha256: VALID_SHA });
    const res = spawnSync('sh', ['-n'], { input: script, encoding: 'utf8' });
    expect(res.status).toBe(0); // 0 = syntactically valid POSIX sh
    if (res.status !== 0) console.error(res.stderr);
  });

  it('bakes in the token and the relay + bundle URLs', () => {
    const script = buildAgentBootstrapScript({ token: TOKEN, relayUrl: RELAY, bundleSha256: VALID_SHA });
    expect(script).toContain(`CONNECTION_TOKEN='${TOKEN}'`);
    expect(script).toContain(`RELAY_URL='${RELAY}'`);
    expect(script).toContain(`${RELAY}${AGENT_BOOTSTRAP_BUNDLE_ROUTE}`);
  });

  it('fails closed and passes the code by ENV, not argv (not in the process list)', () => {
    const script = buildAgentBootstrapScript({ token: TOKEN, relayUrl: RELAY, bundleSha256: VALID_SHA });
    expect(script).toContain('set -eu');
    expect(script).toContain('PROVIAN_CONNECTION_TOKEN="$CONNECTION_TOKEN"');
    // the token must never be handed to node as an argument
    expect(script).not.toContain(`--token ${TOKEN}`);
    expect(script).not.toContain(`--token "$CONNECTION_TOKEN"`);
  });

  it('selects private Node22 and persists the bundle to a stable ~/.provian path for the observer', () => {
    const script = buildAgentBootstrapScript({ token: TOKEN, relayUrl: RELAY, bundleSha256: VALID_SHA });
    expect(script).not.toContain('command -v node');
    expect(script).toContain('$HOME/.provian/node/bin/node');
    expect(script).toContain('nodejs.org'); // actionable message, not a raw error
    // Bundle persists (no temp dir / trap) so the auto-start observer service can
    // run it: node ~/.provian/agent.js observe.
    expect(script).toContain('PROVIAN_HOME="${HOME}/.provian"');
    expect(script).toContain('BUNDLE="$PROVIAN_HOME/agent.js"');
    expect(script).toContain('PROVIAN_BUNDLE_PATH="$BUNDLE"');
    // the bundle is no longer written into a throwaway temp dir
    expect(script).not.toContain('BUNDLE="$WORKDIR/agent.js"');
    expect(script).not.toContain("trap 'rm -rf \"$WORKDIR\"'");
  });

  it('trims a trailing slash on the relay URL', () => {
    const script = buildAgentBootstrapScript({ token: TOKEN, relayUrl: 'https://api.provian.ai/', bundleSha256: VALID_SHA });
    expect(script).toContain(`RELAY_URL='https://api.provian.ai'`);
    expect(script).not.toContain('provian.ai//v1');
  });

  it('THROWS on a malformed token (never emits a script for a bad code)', () => {
    expect(() => buildAgentBootstrapScript({ token: 'conn_' + 'a'.repeat(40), relayUrl: RELAY, bundleSha256: VALID_SHA })).toThrow();
    expect(() => buildAgentBootstrapScript({ token: 'PROV-AB0D-2345', relayUrl: RELAY, bundleSha256: VALID_SHA })).toThrow(); // 0 not in alphabet
  });

  it('THROWS on a non-https / non-origin relay URL', () => {
    expect(() => buildAgentBootstrapScript({ token: TOKEN, relayUrl: 'http://api.provian.ai', bundleSha256: VALID_SHA })).toThrow();
    expect(() => buildAgentBootstrapScript({ token: TOKEN, relayUrl: 'https://x.com/path', bundleSha256: VALID_SHA })).toThrow();
    expect(() => buildAgentBootstrapScript({ token: TOKEN, relayUrl: 'https://x.com; rm -rf /', bundleSha256: VALID_SHA })).toThrow();
  });

  it('F36: embeds the pinned bundle SHA256 and FAILS CLOSED verifying it before exec', () => {
    const script = buildAgentBootstrapScript({ token: TOKEN, relayUrl: RELAY, bundleSha256: VALID_SHA });
    expect(script).toContain(`BUNDLE_SHA256='${VALID_SHA}'`);
    // Verifies the downloaded bundle and refuses to run on a mismatch, BEFORE exec.
    expect(script).toContain('"$BUNDLE_SHA256" != "$BUNDLE_ACTUAL"');
    expect(script.indexOf('integrity check')).toBeGreaterThan(-1);
    const verifyAt = script.indexOf('BUNDLE_ACTUAL');
    const execAt = script.indexOf('exec node');
    expect(verifyAt).toBeGreaterThan(-1);
    expect(execAt).toBeGreaterThan(verifyAt); // integrity check precedes exec
    // Still valid POSIX sh with the check inserted.
    const res = spawnSync('sh', ['-n'], { input: script, encoding: 'utf8' });
    expect(res.status).toBe(0);
  });

  it('F36: pins the Node download SHA256 in-script and fails closed (no same-origin SHASUMS fetch)', () => {
    const script = buildAgentBootstrapScript({ token: TOKEN, relayUrl: RELAY, bundleSha256: VALID_SHA });
    // The Node tarball hash is pinned per platform (trust anchored to the relay).
    expect(script).toContain('61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6'); // darwin-arm64
    expect(script).toContain('b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a'); // linux-x64
    // No longer trusts a same-origin SHASUMS256.txt.
    expect(script).not.toContain('SHASUMS256.txt');
    // Fails closed on no-tool / unknown-platform / mismatch.
    expect(script).toContain('[ -z "$NODE_EXPECTED" ] || [ -z "$NODE_ACTUAL" ] || [ "$NODE_EXPECTED" != "$NODE_ACTUAL" ]');
  });

  it('F36: THROWS on a malformed bundleSha256 (never emits a script with an unusable pin)', () => {
    expect(() => buildAgentBootstrapScript({ token: TOKEN, relayUrl: RELAY, bundleSha256: 'nothex' })).toThrow();
    expect(() => buildAgentBootstrapScript({ token: TOKEN, relayUrl: RELAY, bundleSha256: '' })).toThrow();
  });
});

describe('the hosted install turns on no local witness endpoint (there is none; agents never self-report)', () => {
  // Run the script's real exec block through sh with a fake `node` that prints the
  // witness setting it was started with. Behavioural, not a string match.
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');

  function execBlock(script: string): string {
    const start = script.indexOf('PROVIAN_CONNECTION_TOKEN="$CONNECTION_TOKEN"');
    const end = script.indexOf('exec node "$BUNDLE"');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    return script.slice(start, end + 'exec node "$BUNDLE"'.length);
  }

  function witnessSeenByNode(block: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-default-'));
    fs.writeFileSync(path.join(dir, 'node'), '#!/bin/sh\nprintf "W=%s" "${PROVIAN_WITNESS_ENABLED-<unset>}"\n', { mode: 0o755 });
    const res = spawnSync('sh', ['-c', `CONNECTION_TOKEN=t RELAY_URL=r BUNDLE=/b\n${block}`], {
      env: { PATH: `${dir}:/usr/bin:/bin` },
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    return res.stdout;
  }

  const script = buildAgentBootstrapScript({ token: TOKEN, relayUrl: RELAY, bundleSha256: VALID_SHA });

  it('sh: the bundle starts with no witness opt-in, and the script names none', () => {
    expect(witnessSeenByNode(execBlock(script))).toBe('W=<unset>');
    expect(script).not.toContain('PROVIAN_WITNESS');
  });

  it('RED control: the exec block (its witness default restored) starts the bundle with PROVIAN_WITNESS_ENABLED=1', () => {
    const d466 = execBlock(script).replace('exec node "$BUNDLE"', 'PROVIAN_WITNESS_ENABLED="${PROVIAN_WITNESS_ENABLED:-1}" \\\nexec node "$BUNDLE"');
    expect(d466).not.toBe(execBlock(script));
    expect(witnessSeenByNode(d466)).toBe('W=1');
  });

  it('PowerShell: sets no witness opt-in before running the bundle', () => {
    const ps = buildAgentBootstrapPowershell({ token: TOKEN, relayUrl: RELAY, bundleSha256: VALID_SHA });
    expect(ps).toContain('& node $bundle'); // evaluated population: the exec line is there
    expect(ps).not.toContain('PROVIAN_WITNESS');
  });
});

describe('buildAgentBootstrapPowershell (Windows)', () => {
  it('bakes in the token/relay/bundle and passes the code by ENV, not argv', () => {
    const script = buildAgentBootstrapPowershell({ token: TOKEN, relayUrl: RELAY, bundleSha256: VALID_SHA });
    expect(script).toContain(`$ConnectionToken = '${TOKEN}'`);
    expect(script).toContain(`$RelayUrl = '${RELAY}'`);
    expect(script).toContain(`${RELAY}${AGENT_BOOTSTRAP_BUNDLE_ROUTE}`);
    expect(script).toContain("$ErrorActionPreference = 'Stop'");
    expect(script).toContain('$env:PROVIAN_CONNECTION_TOKEN = $ConnectionToken');
    expect(script).not.toContain('--token');
  });

  it('ensures the pinned private Node22 and runs the bundle, persisting it for the observer', () => {
    const script = buildAgentBootstrapPowershell({ token: TOKEN, relayUrl: RELAY, bundleSha256: VALID_SHA });
    expect(script).not.toContain('Get-Command node');
    expect(script).toContain('$privateNode');
    expect(script).toContain('nodejs.org/dist');
    expect(script).toContain('Invoke-WebRequest');
    expect(script).toContain('& node $bundle');
    // persists under ~/.provian and tells the bundle where it lives (no temp cleanup)
    expect(script).toContain("Join-Path $env:USERPROFILE '.provian'");
    expect(script).toContain('$env:PROVIAN_BUNDLE_PATH = $bundle');
    // the bundle is no longer written into a throwaway temp dir
    expect(script).not.toContain("Join-Path $work 'agent.js'");
  });

  // RED controls — mirror the sh throws so neither builder can emit for bad input.
  it('THROWS on a malformed token or non-https relay', () => {
    expect(() => buildAgentBootstrapPowershell({ token: 'PROV-AB0D-2345', relayUrl: RELAY, bundleSha256: VALID_SHA })).toThrow();
    expect(() => buildAgentBootstrapPowershell({ token: TOKEN, relayUrl: 'http://api.provian.ai', bundleSha256: VALID_SHA })).toThrow();
    expect(() => buildAgentBootstrapPowershell({ token: TOKEN, relayUrl: 'https://x.com/path', bundleSha256: VALID_SHA })).toThrow();
  });

  it('F36: embeds + verifies the bundle SHA256, pins the Node hash, and throws on a bad pin', () => {
    const script = buildAgentBootstrapPowershell({ token: TOKEN, relayUrl: RELAY, bundleSha256: VALID_SHA });
    expect(script).toContain(`$BundleSha256 = '${VALID_SHA}'`);
    expect(script).toContain('$BundleSha256 -ne $bundleActual');
    expect(script).toContain('fec025a6da31757e3b6af84c5a1628e9d38442ca99a2161091d78f2fcfa35ef3'); // win-arm64 pin
    expect(script).not.toContain('SHASUMS256.txt');
    expect(() => buildAgentBootstrapPowershell({ token: TOKEN, relayUrl: RELAY, bundleSha256: 'nothex' })).toThrow();
  });
});

/**
 * §3 item 5 (the operator 09-23: the curl line is canonical; its quirks are bugs): the hosted
 * install's own output never names an npx or npm command. The sh + PowerShell scripts are the
 * first half of that output (the bundle's text is guarded by the SDK's bundle-no-npm.test.ts).
 */
describe('the hosted install script names no npx / npm command', () => {
  const NPM_COMMAND = /npx |npm install|npm i |npm run|npm exec/g;
  const hits = (text: string): string[] =>
    [...text.matchAll(NPM_COMMAND)].map((m) => text.slice(Math.max(0, (m.index ?? 0) - 30), (m.index ?? 0) + 40));

  it('the sh and PowerShell scripts carry no npx / npm command text (non-vacuous: bytes scanned printed)', () => {
    const sh = buildAgentBootstrapScript({ token: TOKEN, relayUrl: RELAY, bundleSha256: VALID_SHA });
    const ps = buildAgentBootstrapPowershell({ token: TOKEN, relayUrl: RELAY, bundleSha256: VALID_SHA });
    // The population is the whole rendered script — never zero bytes.
    expect(sh.length).toBeGreaterThan(2_000);
    expect(ps.length).toBeGreaterThan(1_000);
    console.log(`[] scanned hosted install scripts: sh ${sh.length} bytes, ps1 ${ps.length} bytes`);
    expect(hits(sh)).toEqual([]);
    expect(hits(ps)).toEqual([]);
  });

  it('RED control: the scan flags the exact lines the pre- script carried', () => {
    const oldComment = '# (node ~/.provian/agent.js observe) instead of an unpublished npx package.';
    const oldNode = "# Put the chosen Node first on PATH so npx and its 'env node' shebang resolve to it.";
    expect(hits(oldComment)).toHaveLength(1);
    expect(hits(oldNode)).toHaveLength(1);
    expect(hits('run `npm i @provian/agent-sdk@latest`')).toHaveLength(1);
  });
});

// ─── The Genesis offer line leads the served install script while the window is open ───
describe('hosted install scripts: the Genesis offer line (runtime date check on the agent machine)', () => {
  const LINE = 'Genesis is open through December 31, 2026: a new agent wallet receives 74.25 PVT net from a 75 PVT gross grant.';

  it('the backend constant IS the relay manifest window end (one source; a moved close goes RED here)', () => {
    expect(GENESIS_WINDOW_END_MS).toBe(PROPOSED_GENESIS_CAMPAIGN_POLICY.window.end_ms);
    expect(GENESIS_WINDOW_END_MS).toBe(Date.UTC(2027, 0, 1));
    expect(GENESIS_OFFER_LINE).toBe(LINE);
  });

  it('sh + PowerShell: the check is the FIRST output, before "Setting up Provian" / the Node ensure', () => {
    const sh = buildAgentBootstrapScript({ token: TOKEN, relayUrl: RELAY, bundleSha256: VALID_SHA });
    const ps = buildAgentBootstrapPowershell({ token: TOKEN, relayUrl: RELAY, bundleSha256: VALID_SHA });
    expect(sh).toContain(genesisOfferSh());
    expect(sh.indexOf(genesisOfferSh())).toBeGreaterThan(sh.indexOf('say() {'));
    expect(sh.indexOf(genesisOfferSh())).toBeLessThan(sh.indexOf('say "Setting up Provian'));
    expect(sh).toContain('-lt 1798761600 ]');
    expect(ps).toContain(genesisOfferPs());
    expect(ps).toContain('ToUnixTimeSeconds() -lt 1798761600');
    expect(ps.indexOf(genesisOfferPs())).toBeLessThan(ps.indexOf('Invoke-WebRequest'));
  });

  /** Run ONLY the say() prelude + the Genesis snippet with `date` faked on PATH. */
  function runWithDate(dateOutput: string | null): { stdout: string; stderr: string; status: number | null } {
    const dir = mkdtempSync(join(tmpdir(), 'genesis-date-'));
    try {
      if (dateOutput !== null) {
        writeFileSync(join(dir, 'date'), `#!/bin/sh\nprintf '%s\\n' '${dateOutput}'\n`);
        chmodSync(join(dir, 'date'), 0o755);
      }
      const script = `set -eu\nsay() { printf '%s\\n' "$*" >&2; }\n${genesisOfferSh()}\n`;
      const pathEnv = dateOutput !== null ? `${dir}:${process.env.PATH}` : process.env.PATH;
      const res = spawnSync('sh', [], { input: script, encoding: 'utf8', env: { ...process.env, PATH: pathEnv } });
      return { stdout: res.stdout, stderr: res.stderr, status: res.status };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('OPEN one second before the end: prints exactly the line to stderr, nothing to stdout, exit 0', () => {
    const r = runWithDate('1798761599');
    expect(r.status).toBe(0);
    expect(r.stderr).toBe(`${LINE}\n`);
    expect(r.stdout).toBe('');
  });

  it('RED CONTROL: CLOSED at exactly 1798761600 — the line is absent (and set -eu does not abort)', () => {
    const r = runWithDate('1798761600');
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('after the end, or a clock that is not a plain integer, prints nothing and never aborts the install', () => {
    for (const out of ['1900000000', '', 'Thu Jan  1 00:00:00 UTC 2027', '-5']) {
      const r = runWithDate(out);
      expect(r.status).toBe(0);
      expect(r.stderr).toBe('');
    }
  });

  it('the real clock today (before 2027) prints the line', () => {
    if (Date.now() >= GENESIS_WINDOW_END_MS) return; // the window has closed; the RED control above covers it
    expect(runWithDate(null).stderr).toBe(`${LINE}\n`);
  });
});
