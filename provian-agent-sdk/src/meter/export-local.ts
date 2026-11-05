/**
 * PE EXPORT on this machine — one call behind every surface (`provian export-pes`, the
 * `export-pes` bin, `provian pes export`): every device store under the PE store root, this
 * machine's device credentials for the Archive and the relay's batch records, the agent's key for
 * opening Archive days and mailbox items, the agent's identity for the header. First the relay
 * mailbox is drained (the PEs sealed to the agent that no device here has filed yet are fetched,
 * opened and filed, exactly as the daemon's hourly drain does), so they are in the file; whatever
 * stays on the relay is counted and named in `incomplete`. Then build, write, self-check.
 */

import { ProvianClient } from '../ProvianClient';
import { loadKeystore } from '../keystore';
import { loadCredentials } from '../scripts/credentials';
import {
  drainMailboxForExport,
  exportPesToFile,
  listLocalDeviceStores,
  type PeExportArchiveSource,
  type PeExportMailboxState,
  type PeExportResult,
} from './export';
import { agentMessageSecretProvider } from './message-key';
import { defaultPeStoreRoot } from './pe-store';
import type { MeterBatcher } from './batcher';
import type { MeterTransport } from './transport';

export interface ExportLocalPesOptions {
  /** Output file (default ./provian-pe-export-<wallet_id>-<UTC stamp>.jsonl). */
  readonly out?: string | null;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export class PeExportUnavailableError extends Error {
  readonly code = 'PE_EXPORT_UNAVAILABLE';
  constructor(message: string) {
    super(message);
    this.name = 'PeExportUnavailableError';
  }
}

/** Export every PE this agent owns that this machine can reach, in one file. */
export async function exportLocalPes(options: ExportLocalPesOptions = {}): Promise<PeExportResult> {
  const env = options.env ?? process.env;
  const creds = loadCredentials();
  const root = defaultPeStoreRoot(env);
  const configured = creds?.deviceId ?? (env.PROVIAN_DEVICE_ID?.trim() || null);
  const { stores } = listLocalDeviceStores(root, configured);
  if (stores.length === 0) {
    throw new PeExportUnavailableError(`no PE store under ${root} (PEs are kept by the observer daemon on the machine that recorded them; run this there)`);
  }
  let keystore: { wallet_id: string; address: string } | null = null;
  try {
    keystore = loadKeystore();
  } catch {
    keystore = null;
  }
  const walletId = creds?.agentWalletId ?? keystore?.wallet_id ?? null;
  const owner = {
    wallet_id: walletId,
    address: keystore !== null && (walletId === null || keystore.wallet_id === walletId) ? keystore.address.toLowerCase() : null,
  };
  let archive: PeExportArchiveSource | null = null;
  let batchProofs: Pick<MeterTransport, 'getBatchProofs'> | null = null;
  let mailbox: PeExportMailboxState = {
    waiting: null,
    truncated: false,
    reason: 'no_device_credentials_here: without this machine\'s device credentials the relay mailbox cannot be read, so PEs sealed to this agent and not filed here may be missing',
  };
  if (creds !== null) {
    const client = new ProvianClient({
      relayUrl: creds.relayUrl, deviceKey: creds.deviceKey, deviceSecret: creds.deviceSecret,
      deviceId: creds.deviceId, signingMethod: creds.signingMethod, signingKeyAlias: creds.signingKeyAlias,
      // The drain files into the same store root this export reads.
      peStoreRoot: root,
    });
    // The mailbox opens only with the agent's message key (from its keystore), as in the daemon.
    const agentWallet = typeof creds.agentWalletId === 'string' && creds.agentWalletId.length > 0 ? creds.agentWalletId : null;
    let batcher: MeterBatcher | null = null;
    try {
      batcher = await client.createMeterBatcher(agentWallet !== null ? { messageSecretKey: agentMessageSecretProvider(agentWallet) } : {});
    } catch {
      batcher = null;
    }
    if (batcher !== null) {
      const drainer = batcher;
      try {
        const transport = client.createMeterTransport();
        mailbox = await drainMailboxForExport({
          drain: () => drainer.drainMailbox(),
          getMailbox: (after, limit) => transport.getMailbox(after, limit),
          filedIds: async () => {
            const ids = new Set<string>();
            for (const store of stores) {
              for (const r of await store.listReceived()) ids.add(r.mailbox_id);
              for (const r of await store.listLegacy()) ids.add(r.mailbox_id);
            }
            return ids;
          },
        });
      } catch (err) {
        mailbox = { waiting: null, truncated: false, reason: `mailbox_unreachable: ${(err as Error).message}` };
      }
      try {
        // The newest anchor proofs (and the kept records for received PEs), best effort.
        await batcher.fetchProofs();
      } catch {
        /* the export still includes every proof already kept */
      }
    } else {
      mailbox = { waiting: null, truncated: false, reason: 'meter_unavailable_here: the PE meter could not be opened with this machine\'s credentials' };
    }
    try {
      archive = await client.createArchiveKeeper({ messageSecretKey: agentMessageSecretProvider(creds.agentWalletId) });
    } catch {
      archive = null;
    }
    try {
      batchProofs = client.createMeterTransport();
    } catch {
      batchProofs = null;
    }
  }
  return exportPesToFile({
    stores,
    owner,
    archive,
    batchProofs,
    mailbox,
    out: options.out ?? null,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
  });
}
