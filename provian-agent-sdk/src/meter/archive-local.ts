/**
 * This machine's PE Archive keeper, from its installed credentials : the device
 * credentials name the store and authenticate `/v1/archive/device/*`; the agent's own message key
 * (derived from its wallet key, which stays on this machine) opens what the Archive holds. Shared by
 * the act verbs and the `provian` CLI, so a PE dropped after its day was archived presents the same
 * way from either.
 */

import { ProvianClient } from '../ProvianClient';
import { loadCredentials } from '../scripts/credentials';
import type { ArchiveKeeper } from './archive';
import { agentMessageSecretProvider } from './message-key';

/** Null when this machine has no device credentials (no store to archive from). */
export async function openLocalArchiveKeeper(): Promise<ArchiveKeeper | null> {
  const creds = loadCredentials();
  if (!creds) return null;
  const client = new ProvianClient({
    relayUrl: creds.relayUrl, deviceKey: creds.deviceKey, deviceSecret: creds.deviceSecret,
    deviceId: creds.deviceId, signingMethod: creds.signingMethod, signingKeyAlias: creds.signingKeyAlias,
  });
  return client.createArchiveKeeper({ messageSecretKey: agentMessageSecretProvider(creds.agentWalletId) });
}
