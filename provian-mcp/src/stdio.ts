import { decryptLocalThreadMessage } from './core/thread-reader';
/**
 * Local stdio MCP server entrypoint (`npx @provian/mcp`).
 *
 * Wires the shared tool core to a StdioServerTransport with local credential
 * resolution:
 *   - agent API creds: PROVIAN_API_KEY/PROVIAN_API_SECRET env, else
 *     ~/.provian/agent-credentials.json (0600)
 *   - device creds:    PROVIAN_DEVICE_KEY/PROVIAN_DEVICE_SECRET env, else an
 *     agent-owned ~/.provian/credentials
 *   - relay URL:       PROVIAN_RELAY_URL env (default https://api.provian.ai)
 *
 * NEVER write to stdout here — it is the MCP protocol channel. Diagnostics go
 * to stderr.
 */

import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { buildProvianMcpServer } from './core/server';
import type { ToolContext } from './core/types';
import { genesisOfferLines } from './core/genesis-offer';
import {
  AGENT_CREDS_PATH,
  loadBoundAgentCredentialsFile,
  persistAgentCredentials,
  resolveLocalAuth,
} from './credentials';
import {
  reconcileInstalledDeviceRegistration,
} from './device-credentials';
import { signEip191Message } from './eip191';
import { sealToRecoveryAnchor } from './core/recovery-seal';
import { signPoPChallenge, derivePublicKeyFromPrivateKey } from './core/crypto';
import {
  clearCompletedAgentWalletPending,
  completePendingAgentWalletRegistration,
  loadCompletedAgentWalletIdentity,
  loadOrCreatePendingAgentWalletRegistration,
  reloadPendingAgentWalletRegistration,
} from './agent-wallet-registration';

const DEFAULT_RELAY_URL = 'https://api.provian.ai';

/** Held so the stdio transport (reading process stdin) is not garbage-collected
 *  and the process stays alive for the connection's lifetime. */
let activeStdioHandle: ReturnType<typeof serveStdio> | null = null;

/** Build the local ToolContext. Re-resolved per tool call so a create_wallet
 *  in this session makes later authenticated calls work immediately. */
export function buildLocalContext(env: NodeJS.ProcessEnv = process.env): ToolContext {
  reconcileInstalledDeviceRegistration();
  return {
    baseUrl: (env.PROVIAN_RELAY_URL || DEFAULT_RELAY_URL).replace(/\/$/, ''),
    fetchImpl: fetch,
    auth: resolveLocalAuth(env),
    mode: 'local',
    persistCredentials: (creds) => persistAgentCredentials(creds),
    loadOrCreatePendingAgentWalletRegistration: (context) => {
      const passphrase = env.PROVIAN_KEYSTORE_PASSPHRASE;
      if (!passphrase) {
        throw new Error('PROVIAN_KEYSTORE_PASSPHRASE is required for local create_wallet');
      }
      return loadOrCreatePendingAgentWalletRegistration(context, passphrase);
    },
    reloadPendingAgentWalletRegistration: (context, expected) => {
      const passphrase = env.PROVIAN_KEYSTORE_PASSPHRASE;
      if (!passphrase) {
        throw new Error('PROVIAN_KEYSTORE_PASSPHRASE is required for local create_wallet');
      }
      return reloadPendingAgentWalletRegistration(context, passphrase, expected);
    },
    loadCompletedAgentWalletRegistration: (context) => {
      const passphrase = env.PROVIAN_KEYSTORE_PASSPHRASE;
      if (!passphrase) {
        throw new Error('PROVIAN_KEYSTORE_PASSPHRASE is required for local create_wallet');
      }
      const completed = loadCompletedAgentWalletIdentity(
        passphrase,
        undefined,
        context,
      );
      if (!completed) return null;
      const credentials = loadBoundAgentCredentialsFile();
      if (!credentials
        || credentials.wallet_id !== completed.walletId
        || credentials.address.toLowerCase() !== completed.address.toLowerCase()) {
        throw new Error('Completed MCP wallet credentials do not match the final encrypted identity');
      }
      clearCompletedAgentWalletPending(passphrase, context);
      return {
        ...completed,
        apiKey: credentials.api_key,
        apiSecret: credentials.api_secret,
        credentialsPersistedTo: AGENT_CREDS_PATH,
      };
    },
    completePendingAgentWalletRegistration: (registrationId, wallet, context) => {
      const passphrase = env.PROVIAN_KEYSTORE_PASSPHRASE;
      if (!passphrase) {
        throw new Error('PROVIAN_KEYSTORE_PASSPHRASE is required for local create_wallet');
      }
      return completePendingAgentWalletRegistration(registrationId, wallet, {
        passphrase,
        context,
      });
    },
    signEip191: signEip191Message,
    withLocalSovereignIdentity: (fn) => {
      const passphrase = env.PROVIAN_KEYSTORE_PASSPHRASE;
      if (!passphrase) {
        throw new Error('PROVIAN_KEYSTORE_PASSPHRASE is required to sign with the local sovereign identity');
      }
      const completed = loadCompletedAgentWalletIdentity(passphrase);
      if (!completed) {
        throw new Error(
          'No completed local agent wallet identity found — run create_wallet first (or sign locally and pass the pre-signed fields).',
        );
      }
      // The decrypted private key is confined to this closure: the signing
      // helpers close over it, but it is NEVER returned to the tool handler or
      // placed in any tool argument/result (F32).
      const privateKey = completed.privateKey;
      const pubkey = derivePublicKeyFromPrivateKey(privateKey);
      return fn({
        address: completed.address,
        walletId: completed.walletId,
        pubkey,
        signEip191: (message: string) => signEip191Message(privateKey, message),
        signPop: (binding: string) => signPoPChallenge(privateKey, binding),
        readThreadMessage: (ciphertext: string) => decryptLocalThreadMessage(privateKey, ciphertext),
        sealRecoveryKey: (anchorPubkeyB64u: string) => sealToRecoveryAnchor(anchorPubkeyB64u, privateKey),
      });
    },
  };
}

export async function startStdioServer(): Promise<void> {
  // serveStdio owns the era decision: the opening exchange selects the wire era
  // and pins ONE instance from this factory for the connection's lifetime.
  // legacy:'serve' (the default) keeps serving current-era clients that open
  // with the 2025 `initialize` handshake, alongside modern 2026-07-28 clients.
  // The handle is held so the transport (reading process stdin) keeps the
  // process alive.
  activeStdioHandle = serveStdio(() => buildProvianMcpServer(() => buildLocalContext()), {
    legacy: 'serve',
  });
  const auth = resolveLocalAuth();
  // The Genesis offer LEADS the startup output while the window is open (stderr only —
  // stdout is the MCP channel). Nothing after the window closes.
  for (const line of genesisOfferLines()) console.error(line);
  console.error(
    `provian-mcp: stdio server ready (relay: ${process.env.PROVIAN_RELAY_URL || DEFAULT_RELAY_URL}; ` +
      (auth
        ? 'agent credentials resolved)'
        : `no agent credentials yet — call create_wallet, or set PROVIAN_API_KEY/PROVIAN_API_SECRET or ${AGENT_CREDS_PATH})`),
  );
}
