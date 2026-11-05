/**
 * `provian pes` this machine's own PE store (PE meter, ).
 *
 * The relay keeps no PE: the observer keeps each PE on the machine that recorded it and sends one
 * signed batch a day (plus one right before a presentation or payout). This reads the local store only — no network, no credentials beyond the
 * device id that names the store.
 *
 * provian pes how many PEs are kept here, where, what is not yet batched, the
 * last batch the relay accepted, proofs fetched
 * provian pes prove <pe_id> the pe_fact entry {pe_id, envelope_hash, pe, inclusion} a
 * presentation carries (MCP `present`, the SDK, or `--pe` here)
 * provian pes export [--out] every PE this agent owns in ONE file (provian.pe-export.v1): the
 * same SDK function as the runtime's `provian export-pes`
 * provian pes verify <file> verify an export against Base through one RPC (no Provian server):
 * the same SDK function as `provian verify-export`
 */

import {
  describeMeterStatus,
  exportLocalPes,
  verifyPeExportFile,
  DEFAULT_EXPORT_VERIFY_RPC_URL,
  loadCredentials,
  meterStatusOf,
  openLocalArchiveKeeper,
  peFactFromStore,
  peFactWire,
  resolveLocalPeStore,
  PE_STORE_NOTICE,
  type ArchivedPeSource,
  type LocalPeStoreResolution,
  type PeExportResult,
  type PeExportVerification,
  type VerifyPeExportOptions,
} from '@provian/agent-sdk';

type CommandResult = Record<string, unknown>;
type Flags = Record<string, string | boolean>;

export interface PesCliDeps {
  /** This machine's PE store (default: the device in ~/.provian/credentials, else the one store under the root). */
  openPeStore: () => LocalPeStoreResolution;
  /** This machine's paid PE Archive: a PE dropped here after its day was archived is pulled back to prove it. */
  openArchive?: () => Promise<ArchivedPeSource | null>;
  /** Build and write one complete PE export from this machine (the SDK's `exportLocalPes`). */
  exportPes?: (options: { readonly out: string | null }) => Promise<PeExportResult>;
  /** Verify an export file (the SDK's `verifyPeExportFile`). */
  verifyExport?: (file: string, options: VerifyPeExportOptions) => Promise<PeExportVerification>;
  env?: NodeJS.ProcessEnv;
}

export function defaultPesDeps(): PesCliDeps {
  return {
    openPeStore: () => resolveLocalPeStore({ deviceId: loadCredentials()?.deviceId ?? null }),
    openArchive: openLocalArchiveKeeper,
    exportPes: (options) => exportLocalPes({ out: options.out }),
    verifyExport: verifyPeExportFile,
    env: process.env,
  };
}

export async function cmdPes(positionals: readonly string[], flags: Flags, depsIn?: Partial<PesCliDeps>): Promise<CommandResult | null> {
  const subcommand = positionals[0] ?? null;
  if (flags.help) {
    printPesHelp();
    return null;
  }
  const deps: PesCliDeps = { ...defaultPesDeps(), ...(depsIn ?? {}) };
  // Export and verify resolve their own stores (every device store here) or need none at all.
  if (subcommand === 'export') {
    const out = typeof flags.out === 'string' && flags.out.length > 0 ? flags.out : (positionals[1] ?? null);
    try {
      const result = await (deps.exportPes ?? ((o) => exportLocalPes({ out: o.out })))({ out });
      return { ...result };
    } catch (err) {
      return { status: 'error', error: (err as Error).message };
    }
  }
  if (subcommand === 'verify') {
    const file = positionals[1] ?? (typeof flags.file === 'string' ? flags.file : null);
    if (!file) return { status: 'error', error: 'Usage: provian pes verify <file> [--rpc-url <url>] [--offline]' };
    const offline = flags.offline === true || flags.offline === 'true';
    const env = deps.env ?? process.env;
    const rpcUrl = typeof flags['rpc-url'] === 'string' && flags['rpc-url'].length > 0
      ? flags['rpc-url']
      : ((env.PROVIAN_BASE_RPC_URL ?? '').trim() || DEFAULT_EXPORT_VERIFY_RPC_URL);
    try {
      const result = await (deps.verifyExport ?? verifyPeExportFile)(file, offline ? { offline } : { offline, rpcUrl });
      // `incomplete`: everything in the file verifies, but it names PEs the owner holds that it does
      // not carry (listed under `missing`) — never reported as a clean ok; the bin exits 3.
      const status = result.verdict === 'failed' ? 'error' : result.verdict === 'incomplete' || result.verdict === 'offline_incomplete' ? 'incomplete' : 'ok';
      return { status, ...result };
    } catch (err) {
      return { status: 'error', error: `could not read ${file}: ${(err as Error).message}` };
    }
  }
  const opened = deps.openPeStore();
  if (!opened.ok) return { status: 'error', error: opened.detail, notice: PE_STORE_NOTICE };
  try {
    if (subcommand === null || subcommand === 'status') {
      const status = await meterStatusOf(opened.store);
      return { status: status.halted ? 'error' : 'ok', ...status, summary: describeMeterStatus(status), notice: PE_STORE_NOTICE };
    }
    if (subcommand === 'prove') {
      const peId = positionals[1] ?? (typeof flags.pe === 'string' ? flags.pe : null);
      if (!peId) return { status: 'error', error: 'Usage: provian pes prove <pe_id>' };
      const id = peId.split(':')[0];
      const archived = (await opened.store.findPe(id)) === null && (await opened.store.findArchived?.(id)) && deps.openArchive
        ? (await deps.openArchive()) ?? undefined
        : undefined;
      const r = await peFactFromStore(opened.store, peId, archived);
      if (!r.ok) return { status: 'error', reason: r.reason, error: r.detail };
      return { status: 'ok', pe_fact: peFactWire(r.fact) };
    }
    return { status: 'error', error: `Unknown pes subcommand: ${subcommand}. Run provian pes --help.` };
  } catch (err) {
    return { status: 'error', error: `the PE store at ${opened.store.location} could not be read: ${(err as Error).message}` };
  }
}

export function printPesHelp(): void {
  console.log(`provian pes — this machine's own PEs

  provian pes
      How many PEs this machine keeps and where, how many are not yet batched,
      the last batch the relay accepted (time, acts, eligible points), proofs
      fetched, and mailbox PEs received. Reads the local store only.

  provian pes prove <pe_id>
      Print the pe_fact entry a presentation carries: {pe_id, envelope_hash, pe,
      inclusion}. Only a PE whose day is anchored on Base can be presented. A PE
      dropped here after its day was confirmed in your paid PE Archive is pulled
      back and opened on this machine first.
      Pass it to MCP \`present\` (pe_facts), or use --pe <pe_id> on respond/present.

  provian pes export [--out <file>]
      Export every PE this agent owns in ONE file (provian.pe-export.v1): every
      device chain on this machine, its batches with the relay's receipts and
      anchor proofs, every day in your paid PE Archive (pulled and opened here),
      every PE sealed to you (the relay mailbox is drained first), and every
      pre-meter record. An anchored PE carries its proof to its on-chain day
      root; a pending PE (not yet in an anchored day root) carries none until
      you export again after the daily anchor; a pre-meter record carries none
      and is checked against its own hash. Written 0600 to --out or
      ./provian-pe-export-<wallet>-<UTC time>.jsonl, then verified offline; what
      could not be included is listed under "incomplete".

  provian pes verify <file> [--rpc-url <url>] [--offline]
      Verify an export anywhere: every line offline, then each day root read once
      from PEAnchor on Base through the RPC named (default
      PROVIAN_BASE_RPC_URL, else https://mainnet.base.org). No Provian server is
      contacted; the hosts contacted are printed. --offline stops before the
      chain read and lists the day roots to check. Exit 0: ok (offline_ok);
      1: failed; 3: incomplete — every line verifies, but the file names PEs
      the owner holds that it does not carry (printed under "missing").

${PE_STORE_NOTICE}
The store is the device in ~/.provian/credentials (PROVIAN_DEVICE_ID), under
PROVIAN_PE_STORE_DIR or ~/.provian/pe-store.`);
}
