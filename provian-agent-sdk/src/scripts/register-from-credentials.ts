/**
 * `node <bundle> register-device --from-credentials <file> [--platform <p>] [--name <n>]`
 *
 * an agent that created its wallet over MCP (wallet_challenge +
 * wallet_create on /mcp, its key generated on its own machine) already holds its
 * agent API credential. If it CHOOSES to run the passive recorder, it fetches
 * the bundle, verifies it against the signed release manifest, and runs this
 * verb to register an agent-owned device from THAT credential — then starts
 * `observe`, which reads the device credentials this writes.
 *
 * Deliberately the smallest possible surface:
 * - the credential is read ONLY from the file the agent names, and only when
 * it is a private 0600 regular file (no symlink) holding exactly
 * {api_key, api_secret, wallet_id, address} (`loadBoundAgentCredentialsFile`,
 * the same loader register-device uses). Never from argv (process list),
 * never from a scan of the machine;
 * - registration is the install path's own `registerDevice` step (agent API
 * auth, idempotent registration id derived from the wallet id, device
 * credentials persisted to ~/.provian/credentials and read back);
 * - it installs nothing else: no service, no git hook, no shell-profile write,
 * no consent flow. The agent starts `observe` itself if it wants it.
 * Nothing about the `curl … | sh` install path changes.
 */

import { loadBoundAgentCredentialsFile } from './agent-credentials-file';
import type { BootstrapDeps } from '../bootstrap-flow';

export interface RegisterFromCredentialsArgs {
  credentialsPath: string;
  platform: string | null;
  deviceName: string | null;
}

const PLATFORM = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const DEVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

export function parseRegisterFromCredentialsArgs(
  argv: readonly string[],
): { ok: true; args: RegisterFromCredentialsArgs } | { ok: false; error: string } {
  let credentialsPath: string | null = null;
  let platform: string | null = null;
  let deviceName: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--from-credentials' && next !== undefined) { credentialsPath = next; i += 1; }
    else if (arg === '--platform' && next !== undefined) { platform = next; i += 1; }
    else if (arg === '--name' && next !== undefined) { deviceName = next; i += 1; }
    else return { ok: false, error: `Unknown or incomplete option: ${arg}` };
  }
  if (!credentialsPath) {
    return { ok: false, error: 'register-device needs --from-credentials <file> (a 0600 JSON file with api_key, api_secret, wallet_id, address).' };
  }
  if (platform !== null && !PLATFORM.test(platform)) {
    return { ok: false, error: '--platform must be a short lowercase name such as linux.' };
  }
  if (deviceName !== null && !DEVICE_NAME.test(deviceName)) {
    return { ok: false, error: '--name must be a short plain name (letters, digits, space, . _ -).' };
  }
  return { ok: true, args: { credentialsPath, platform, deviceName } };
}

export interface RegisterFromCredentialsDeps {
  registerDevice: BootstrapDeps['registerDevice'];
  loadCredentials?: typeof loadBoundAgentCredentialsFile;
  relayUrl: string;
}

export type RegisterFromCredentialsOutcome =
  | { ok: true; walletId: string }
  | { ok: false; reason: 'credentials_unreadable' | 'registration_failed'; message: string };

export async function registerDeviceFromCredentials(
  args: RegisterFromCredentialsArgs,
  deps: RegisterFromCredentialsDeps,
): Promise<RegisterFromCredentialsOutcome> {
  const creds = (deps.loadCredentials ?? loadBoundAgentCredentialsFile)(args.credentialsPath);
  if (!creds) {
    return {
      ok: false,
      reason: 'credentials_unreadable',
      message:
        'The credentials file could not be used. It must be a private (chmod 600) regular file, not a link, ' +
        'holding exactly api_key, api_secret, wallet_id and address from your wallet creation.',
    };
  }
  try {
    await deps.registerDevice({
      relayUrl: deps.relayUrl,
      walletId: creds.wallet_id,
      apiKey: creds.api_key,
      apiSecret: creds.api_secret,
      ...(args.platform ? { platform: args.platform } : {}),
      ...(args.deviceName ? { deviceName: args.deviceName } : {}),
    });
  } catch {
    return {
      ok: false,
      reason: 'registration_failed',
      message: 'Device registration did not finish. Check the connection to the relay and run the same command again; it resumes the same registration.',
    };
  }
  return { ok: true, walletId: creds.wallet_id };
}

export async function runRegisterFromCredentialsCli(argv: readonly string[]): Promise<void> {
  const parsed = parseRegisterFromCredentialsArgs(argv);
  if (!parsed.ok) {
    console.error(`  ${parsed.error}`);
    process.exit(1);
  }
  const { defaultBootstrapDeps } = await import('../bootstrap-flow.js');
  const outcome = await registerDeviceFromCredentials(parsed.args, {
    registerDevice: defaultBootstrapDeps().registerDevice,
    relayUrl: process.env.PROVIAN_RELAY_URL ?? 'https://api.provian.ai',
  });
  if (!outcome.ok) {
    console.error(`  ${outcome.message}`);
    process.exit(1);
  }
  console.log(`  This machine is registered as a device of wallet ${outcome.walletId}.`);
  console.log('  Start the recorder when you choose to:  node <this file> observe');
  process.exit(0);
}
