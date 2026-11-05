#!/usr/bin/env node
import { guardedFetch as fetch, guardedFetcher } from '../guarded-fetch';
/**
 * connect-github - User-initiated GitHub App connect flow (step 4c).
 *
 * Opens the user's browser to the GitHub App install page on github.com,
 * then polls the Provian relay until the install is recorded. The user
 * authorizes ON github.com - this CLI never prompts for a GitHub
 * credential and never receives a GitHub token.
 *
 * Auth: the existing device credentials at ~/.provian/credentials
 * (same identity the user established via `register-device`). The
 * relay binds the install to that device's owning wallet.
 *
 * Usage:
 *   npx @provian/agent-sdk connect-github
 *
 * Optional flags:
 *   --relay-url <url>    Override relay URL (defaults to file/env value)
 *   --no-open            Skip auto-opening browser; print the URL instead
 *   --timeout <seconds>  Poll timeout (default 300 = 5 min, matches relay TTL)
 */

import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { platform } from 'os';
import { loadCredentials } from './credentials';
import { runConnectFlow, type ConnectFlowResult } from './connect-github-flow';

// ---------------------------------------------------------------------------
// Helpers - argv parsing + browser open
// ---------------------------------------------------------------------------

function parseFlag(name: string): string | null {
  const i = process.argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return null;
  const arg = process.argv[i];
  if (arg.includes('=')) return arg.slice(arg.indexOf('=') + 1);
  return process.argv[i + 1] ?? null;
}

function hasFlag(name: string): boolean {
  return process.argv.some((a) => a === `--${name}`);
}

/**
 * Cross-platform browser opener. Best-effort: on failure the CLI prints
 * the URL for the user to open manually. We use execFile (not exec) so
 * the URL is never substituted into a shell command line - defense
 * against URL fragments containing shell metacharacters.
 */
function openInBrowser(url: string): Promise<void> {
  return new Promise((resolve) => {
    const p = platform();
    let cmd: string;
    let args: string[];
    if (p === 'darwin') {
      cmd = 'open';
      args = [url];
    } else if (p === 'win32') {
      cmd = 'cmd';
      args = ['/c', 'start', '""', url];
    } else {
      cmd = 'xdg-open';
      args = [url];
    }
    execFile(cmd, args, { windowsVerbatimArguments: false }, () => resolve());
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const creds = loadCredentials();
  if (!creds) {
    console.error('No Provian credentials found. Run: npx @provian/agent-sdk register-device');
    process.exit(2);
  }

  const relayUrl = parseFlag('relay-url') ?? creds.relayUrl;
  const skipOpen = hasFlag('no-open');
  const timeoutSec = Number(parseFlag('timeout') ?? '300');
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
    console.error('--timeout must be a positive number of seconds');
    process.exit(2);
  }

  // 32 bytes of entropy → 64 hex chars. Matches the relay's STATE_HEX_LENGTH.
  const state = crypto.randomBytes(32).toString('hex');

  console.log('Starting GitHub App connect flow…');

  const result: ConnectFlowResult = await runConnectFlow({
    relayUrl,
    deviceKey: creds.deviceKey,
    deviceSecret: creds.deviceSecret,
    state,
    timeoutMs: timeoutSec * 1000,
    fetch: fetch,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    onInstallUrl: async (url) => {
      console.log('');
      console.log('Open this URL in your browser to install the Provian GitHub App:');
      console.log(`  ${url}`);
      console.log('');
      console.log('You will authorize the install on github.com. Provian never sees your GitHub credentials.');
      console.log('');
      if (!skipOpen) {
        await openInBrowser(url);
      }
    },
    onPoll: (attempt) => {
      if (attempt === 1) console.log('Waiting for install to complete on github.com …');
      else if (attempt % 10 === 0) console.log(`  (still waiting - ${attempt} polls)`);
    },
  });

  if (result.status === 'completed') {
    console.log('');
    console.log('✓ GitHub App installed and recorded.');
    console.log(`  installation_id: ${result.install_id}`);
    console.log(`  pe_id:           ${result.pe_id}`);
    process.exit(0);
  }
  if (result.status === 'timeout') {
    console.error('');
    console.error('Timed out waiting for install. The relay recorded nothing.');
    console.error('If you completed the install in your browser, the relay-side session may have expired (5 min).');
    console.error('Re-run this command to start a fresh session.');
    process.exit(1);
  }
  if (result.status === 'error') {
    console.error('');
    console.error(`Connect failed: ${result.error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
