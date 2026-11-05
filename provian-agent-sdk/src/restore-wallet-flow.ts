/**
 * restore-wallet-flow — rebuild the local keystore from a phone-recovered key.
 *
 * The phone's RecoverAgent screen opens the relay-escrowed sealed box with the
 * device-held anchor secret and emits ONE command for the new agent machine
 * (`buildAgentRestoreCommand` in the app):
 *
 * PROVIAN_WALLET_ID=<wallet_id> … restore-wallet --from-stdin <<'PROVIAN_RESTORE'
 * <64-hex-key>
 * PROVIAN_RESTORE
 *
 * PREFERRED (hardening): the command carries NO key. It runs interactively
 * and prompts for the key with terminal echo OFF (`restoreWalletInteractive`), so
 * the key never rides the pasted command — it is not shown on screen, not placed on
 * the clipboard as part of a command, and NOT written to the shell history file.
 * (The earlier heredoc form was believed to keep the key "out of shell history",
 * but a heredoc pasted into an INTERACTIVE shell is saved to the history file
 * verbatim, body and all — the very leak this interactive prompt removes.)
 *
 * `--from-stdin` is retained for AUTOMATION only (piping the key in a script, where
 * there is no interactive history). Either way the key leaves this process ONLY as
 * AES-256-GCM keystore ciphertext under the machine's local at-rest secret
 * (the same no-passphrase scheme the one-command bootstrap uses). Nothing here
 * talks to the relay: the private key is fund-bearing and the relay must never
 * see it in any form other than the anchor-sealed escrow blob.
 *
 * What this restores: signing capability (funds, x402, PoP/keyless connect), and
 * for a RECOVERY RE-KEY — the freshly-rotated API credentials too, so a
 * re-keyed agent's daemon can authenticate again without a separate device invite.
 * A plain restore (same-key, from the escrow unseal) still restores signing only;
 * the payload simply omits the api credentials.
 */

import { deriveAgentIdentityFromPrivateKey } from './wallet';
import { cliCommand, HOSTED_BUNDLE } from './cli-command';

export interface RestoreWalletInput {
  /** The wallet id the phone printed into the command (env PROVIAN_WALLET_ID). */
  walletId: string;
  /** Raw stdin content between the heredoc markers. */
  stdinContent: string;
}

export interface RestoreWalletDeps {
  /** Persist the key as local keystore ciphertext; the bootstrap's exact pair. */
  persistKey(params: {
    privateKey: string;
    address: string;
    publicKey: string;
    walletId: string;
    passphrase: string;
    createdAt: string;
  }): void;
  loadOrCreateSecret(): string;
  /**
   * Persist freshly-rotated API credentials to ~/.provian/agent-credentials.json
   * (recovery re-key only). Absent on a plain same-key restore.
   */
  persistApiCredentials?(params: { apiKey: string; apiSecret: string; walletId: string; address: string }): void;
  log(message: string): void;
}

export interface RestoreWalletResult {
  walletId: string;
  address: string;
  /** True when the payload also carried + persisted rotated API credentials. */
  apiCredentialsRestored: boolean;
}

const KEY_HEX = /^[0-9a-f]{64}$/;
const API_KEY_RE = /^pvn_live_[0-9a-f]{15,}$/;

/** The parsed restore payload: always a key; optionally the rotated API creds. */
export interface RestorePayload {
  privateKey: string;
  apiKey?: string;
  apiSecret?: string;
}

/**
 * Parse the heredoc payload. Two accepted shapes, both fail-closed:
 * - LEGACY (plain restore): exactly one non-empty line = a 64-hex secp256k1 key.
 * - RE-KEY : a single JSON object `{ private_key, api_key?, api_secret? }`.
 * A truncated paste (half a key, half an object) must never half-restore.
 */
export function parseRestorePayloadFromStdin(stdinContent: string): RestorePayload {
  const trimmed = stdinContent.trim();
  if (trimmed.startsWith('{')) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      throw new Error('The restore payload is not valid — re-copy the command from the Provian app.');
    }
    const key = String(obj.private_key ?? '').toLowerCase().replace(/^0x/, '');
    if (!KEY_HEX.test(key)) {
      throw new Error('The recovered key is not a 64-character hex string. Re-copy the command from the Provian app.');
    }
    const apiKey = typeof obj.api_key === 'string' ? obj.api_key : undefined;
    const apiSecret = typeof obj.api_secret === 'string' ? obj.api_secret : undefined;
    // API creds are all-or-nothing: a lone key or a lone secret is a malformed paste.
    if ((apiKey === undefined) !== (apiSecret === undefined)) {
      throw new Error('The restore payload is incomplete — re-copy the command from the Provian app.');
    }
    if (apiKey !== undefined && !API_KEY_RE.test(apiKey)) {
      throw new Error('The API key in the restore payload is malformed — re-copy the command from the Provian app.');
    }
    return { privateKey: key, ...(apiKey && apiSecret ? { apiKey, apiSecret } : {}) };
  }
  return { privateKey: parseRestoreKeyFromStdin(trimmed) };
}

/**
 * Parse the heredoc payload: exactly one non-empty line, a 64-hex secp256k1
 * key (0x prefix tolerated, case-insensitive). Anything else fails closed with
 * a plain sentence — a truncated paste must never restore a half-key.
 */
export function parseRestoreKeyFromStdin(stdinContent: string): string {
  const lines = stdinContent.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) {
    throw new Error('No key arrived on stdin. Paste the whole command from the Provian app, including the last PROVIAN_RESTORE line.');
  }
  if (lines.length > 1) {
    throw new Error('More than one line arrived on stdin. Paste exactly the command the Provian app shows.');
  }
  const key = lines[0].toLowerCase().replace(/^0x/, '');
  if (!KEY_HEX.test(key)) {
    throw new Error('The recovered key is not a 64-character hex string. Re-copy the command from the Provian app.');
  }
  return key;
}

export function runRestoreWallet(
  input: RestoreWalletInput,
  deps: RestoreWalletDeps,
): RestoreWalletResult {
  const walletId = input.walletId.trim();
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(walletId)) {
    throw new Error('PROVIAN_WALLET_ID is missing or malformed. Copy the whole command from the Provian app.');
  }
  const payload = parseRestorePayloadFromStdin(input.stdinContent);
  const identity = deriveAgentIdentityFromPrivateKey(payload.privateKey);
  deps.log('Rebuilding the wallet keystore on this machine…');
  deps.persistKey({
    privateKey: payload.privateKey,
    address: identity.address,
    publicKey: identity.publicKey,
    walletId,
    passphrase: deps.loadOrCreateSecret(),
    createdAt: new Date().toISOString(),
  });
  let apiCredentialsRestored = false;
  if (payload.apiKey && payload.apiSecret && deps.persistApiCredentials) {
    deps.persistApiCredentials({
      apiKey: payload.apiKey, apiSecret: payload.apiSecret, walletId, address: identity.address,
    });
    apiCredentialsRestored = true;
  }
  deps.log(`Wallet restored. Address ${identity.address}`);
  deps.log('Signing works again on this machine (funds, x402, connect).');
  if (apiCredentialsRestored) {
    deps.log('Rotated API credentials restored — the work observer can authenticate again.');
    deps.log(HOSTED_BUNDLE
      ? `Restart the observer here: \`${cliCommand('repair')}\` (it restarts the service or the background daemon).`
      : `Restart the observer here: \`${cliCommand('observe')}\` (or restart the launchd/systemd service).`);
  } else {
    deps.log('To restart the work observer here, send this machine a device invite from the Provian app (Agents → your agent → Invite a device).');
  }
  return { walletId, address: identity.address, apiCredentialsRestored };
}

/** Wire the real keystore + local-secret implementations. */
export function defaultRestoreWalletDeps(): RestoreWalletDeps {
  return {
    persistKey(params) {
      // Lazy require keeps key material handling in one call frame.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { persistAgentWalletKey } = require('./keystore') as typeof import('./keystore');
      persistAgentWalletKey(params);
    },
    loadOrCreateSecret() {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { loadOrCreateLocalKeystoreSecret } = require('./local-keystore-secret') as typeof import('./local-keystore-secret');
      return loadOrCreateLocalKeystoreSecret();
    },
    persistApiCredentials(params) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const credsMod = require('./scripts/agent-credentials-file') as typeof import('./scripts/agent-credentials-file');
      // A re-key CHANGES this wallet's address, so the stored creds file (bound to
      // the OLD address) would make persistAgentCredentialsFile refuse the replace
      // (its cross-identity guard). This is a legitimate SAME-wallet_id re-key, so
      // clear the old file first, then write the rotated creds cleanly.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require('fs') as typeof import('fs');
      try { fs.rmSync(credsMod.AGENT_CREDS_PATH, { force: true }); } catch { /* best effort */ }
      credsMod.persistAgentCredentialsFile({
        api_key: params.apiKey, api_secret: params.apiSecret,
        wallet_id: params.walletId, address: params.address,
      });
    },
    log(message) { process.stderr.write(`  ${message}\n`); },
  };
}

/** Read all of stdin (the heredoc body), then run the restore. */
export async function restoreWalletFromStdin(
  walletId: string,
  deps: RestoreWalletDeps = defaultRestoreWalletDeps(),
  stdin: NodeJS.ReadableStream = process.stdin,
): Promise<RestoreWalletResult> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return runRestoreWallet({ walletId, stdinContent: Buffer.concat(chunks).toString('utf8') }, deps);
}

/**
 * Read one line from the controlling TTY with echo OFF (a password-style prompt).
 * The typed/pasted characters are never printed and, because they are consumed by
 * THIS process rather than entered as a shell command, are never written to the
 * shell's history file. Reads until the first CR/LF (a single-line key or compact
 * JSON payload). Returns the raw string (caller trims/parses). Requires a TTY.
 */
export function readHiddenLineFromTty(
  promptText: string,
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stderr,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!input.isTTY || typeof input.setRawMode !== 'function') {
      reject(new Error('No interactive terminal is available. Re-run with the key piped in: `… restore-wallet --from-stdin`.'));
      return;
    }
    output.write(promptText);
    let buf = '';
    const onData = (chunk: Buffer): void => {
      const s = chunk.toString('utf8');
      for (const ch of s) {
        if (ch === '\n' || ch === '\r' || ch === '') { // Enter / EOT → done
          cleanup();
          output.write('\n');
          resolve(buf);
          return;
        }
        if (ch === '') { // Ctrl-C → cancel
          cleanup();
          output.write('\n');
          reject(new Error('Cancelled.'));
          return;
        }
        if (ch === '' || ch === '\b') { // backspace
          buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
      }
    };
    const cleanup = (): void => {
      input.removeListener('data', onData);
      try { input.setRawMode(false); } catch { /* best effort */ }
      input.pause();
    };
    try { input.setRawMode(true); } catch { /* best effort */ }
    input.resume();
    input.on('data', onData);
  });
}

/**
 * Interactive restore (preferred path). Prompts for the recovery key with
 * echo OFF, so it never appears on screen, on the clipboard-as-command, or in the
 * shell history — then restores exactly as the stdin path does. `readKey` is
 * injectable for tests; production reads the hidden TTY line.
 */
export async function restoreWalletInteractive(
  walletId: string,
  deps: RestoreWalletDeps = defaultRestoreWalletDeps(),
  readKey: () => Promise<string> = () => readHiddenLineFromTty('  Paste the recovery key from the Provian app (input hidden), then press Enter: '),
): Promise<RestoreWalletResult> {
  const pasted = await readKey();
  return runRestoreWallet({ walletId, stdinContent: pasted }, deps);
}
