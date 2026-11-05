#!/usr/bin/env node
import { guardedFetch as fetch, guardedFetcher } from '../guarded-fetch';
/**
 * disconnect-github - Stop honoring a GitHub App installation.
 *
 * Tells the Provian relay to mark the install revoked. Does NOT call
 * GitHub to uninstall - the user removes the app on github.com if they
 * choose. After this CLI runs, the relay returns HTTP 410 for any
 * subsequent webhook delivery from the install.
 *
 * Usage:
 *   npx @provian/agent-sdk disconnect-github --installation-id <id>
 *
 * Optional flags:
 *   --relay-url <url>    Override relay URL
 */

import { loadCredentials } from './credentials';

function parseFlag(name: string): string | null {
  const i = process.argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return null;
  const arg = process.argv[i];
  if (arg.includes('=')) return arg.slice(arg.indexOf('=') + 1);
  return process.argv[i + 1] ?? null;
}

async function main(): Promise<void> {
  const creds = loadCredentials();
  if (!creds) {
    console.error('No Provian credentials found. Run: npx @provian/agent-sdk register-device');
    process.exit(2);
  }
  const relayUrl = parseFlag('relay-url') ?? creds.relayUrl;
  const installationId = parseFlag('installation-id');
  if (!installationId || !/^[A-Za-z0-9_-]+$/.test(installationId)) {
    console.error('--installation-id is required and must contain only [A-Za-z0-9_-] characters.');
    console.error('You can find your installation ID in your Provian dashboard or in a previous connect-github output.');
    process.exit(2);
  }

  const url = `${relayUrl}/v1/witnesses/github/installs/${encodeURIComponent(installationId)}/revoke`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `DeviceKey ${creds.deviceKey}:${creds.deviceSecret}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
  } catch (err) {
    console.error('Network error contacting the relay:', (err as Error).message);
    process.exit(1);
  }

  if (resp.status === 404) {
    console.error('No install found with that installation_id under your account.');
    process.exit(1);
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    console.error(`Disconnect failed (${resp.status}): ${body.slice(0, 200)}`);
    process.exit(1);
  }
  const payload = (await resp.json().catch(() => ({}))) as { revoked?: boolean; idempotent?: boolean; pe_id?: string | null };
  if (!payload.revoked) {
    console.error('Relay did not confirm revocation. Response:', JSON.stringify(payload));
    process.exit(1);
  }

  console.log('✓ Installation marked revoked.');
  if (payload.idempotent) {
    console.log('  (It was already revoked; this was a no-op.)');
  }
  if (payload.pe_id) {
    console.log(`  service_install_revoked PE: ${payload.pe_id}`);
  }
  console.log('');
  console.log('Provian will return HTTP 410 for any further webhook deliveries from this installation.');
  console.log('To fully uninstall the Provian GitHub App from your account, also remove it on github.com:');
  console.log('  https://github.com/settings/installations');
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
