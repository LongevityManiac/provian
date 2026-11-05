import { guardedFetch as fetch, guardedFetcher } from '../guarded-fetch';
/**
 * PE EXPORT — verify an export file anywhere, with nothing but a Base RPC endpoint.
 *
 * Parses the file (canonical lines, the running hash), checks every line offline (each PE's hash,
 * its act's path to its batch's acts_root, the batch leaf's path to its day root, chain links,
 * batches against the PEs they carried), then reads each distinct day root ONCE from PEAnchor on
 * Base through the RPC named (`eth_call` getBatch). It contacts no other host — the hosts actually
 * contacted are recorded and returned, so a caller can see it.
 *
 * Verdict (`exportVerdictOf`, pe-export-wire.ts — the same rule the phone applies to its own file):
 *   ok                  no parse error, no failing line, no gap in a chain the header lists under
 *                       `devices`, every day root confirmed on Base, and NOTHING named missing in
 *                       the end line's `incomplete`;
 *   incomplete          everything in the file verifies, but the producer named what it holds and
 *                       could not include (listed in `incomplete` and `missing`) — never a clean ok;
 *   offline_ok          `ok` without the chain read (--offline); the day roots to check are listed;
 *   offline_incomplete  `incomplete` without the chain read;
 *   failed              anything else.
 * Lines not anchored yet are reported as pending, never as verified, and never as missing.
 */

import * as fs from 'fs';
import {
  exportVerdictOf,
  parseExport,
  verifyAnchorsOnChain,
  verifyExportOffline,
  type EthCall,
  type ExportAnchorCheck,
  type ExportOfflineReport,
  type ExportVerdict,
} from '../pe-export-wire';

export const DEFAULT_EXPORT_VERIFY_RPC_URL = 'https://mainnet.base.org';

export interface VerifyPeExportOptions {
  /** Base mainnet JSON-RPC endpoint (default https://mainnet.base.org). */
  readonly rpcUrl?: string;
  /** Stop after the offline checks; list the day roots to check on chain. */
  readonly offline?: boolean;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface PeExportVerification {
  readonly verdict: ExportVerdict;
  readonly file: string;
  readonly parse_error: { readonly error: string; readonly line: number | null } | null;
  readonly header: {
    readonly owner: unknown;
    readonly exported_at_ms: number;
    readonly producer: unknown;
    readonly devices: readonly string[];
    readonly archive_state: string;
  } | null;
  readonly counts: ExportOfflineReport['counts'] | null;
  readonly failures: ExportOfflineReport['failures'];
  readonly gaps_in_listed_devices: ExportOfflineReport['gaps'];
  readonly gaps_archive_only: ExportOfflineReport['gaps'];
  readonly pending: ExportOfflineReport['pending'];
  /** What the producer said it could not include. */
  readonly incomplete: readonly { readonly what: string; readonly reason: string }[];
  /** `incomplete` as one line per item (`what — reason`), for a person reading the result. */
  readonly missing: readonly string[];
  /** Each day root: confirmed on Base, refused, or unchecked (offline). */
  readonly anchors: readonly (ExportAnchorCheck | (ExportOfflineReport['anchors'][number] & { readonly ok: null; readonly reason: 'not_checked_offline' }))[];
  readonly rpc: { readonly url: string | null; readonly contacted_hosts: readonly string[] };
  readonly reasons: readonly string[];
}

/** A minimal JSON-RPC `eth_call` against `rpcUrl` (latest block), recording every host contacted. */
export function jsonRpcEthCall(rpcUrl: string, fetchFn: typeof fetch, contacted: Set<string>, timeoutMs = 30_000): EthCall {
  fetchFn = guardedFetcher(fetchFn);
  let id = 0;
  return async (to: string, data: string): Promise<string> => {
    id += 1;
    contacted.add(new URL(rpcUrl).host);
    const response = await fetchFn(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'eth_call', params: [{ to, data }, 'latest'] }),
      // Never follow a redirect: the verifier reads only the RPC it was given.
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`http_${response.status}`);
    const body = (await response.json()) as { result?: unknown; error?: { message?: unknown } };
    if (body.error !== undefined) throw new Error(typeof body.error?.message === 'string' ? body.error.message : 'rpc_error');
    if (typeof body.result !== 'string') throw new Error('rpc_result_missing');
    return body.result;
  };
}

/** Verify an export's text (see `verifyPeExportFile`). */
export async function verifyPeExportText(text: string, file: string, options: VerifyPeExportOptions = {}): Promise<PeExportVerification> {
  const contacted = new Set<string>();
  const rpcUrl = options.offline === true ? null : (options.rpcUrl ?? DEFAULT_EXPORT_VERIFY_RPC_URL);
  const parsed = parseExport(text);
  if (!parsed.ok) {
    return {
      verdict: 'failed', file, parse_error: { error: parsed.error, line: parsed.line ?? null }, header: null, counts: null,
      failures: [], gaps_in_listed_devices: [], gaps_archive_only: [], pending: [], incomplete: [], missing: [], anchors: [],
      rpc: { url: rpcUrl, contacted_hosts: [] }, reasons: [`file_refused: ${parsed.error}${parsed.line !== undefined ? ` at line ${parsed.line}` : ''}`],
    };
  }
  const report = verifyExportOffline(parsed.body);
  const listed = new Set(parsed.header.devices);
  const gapsListed = report.gaps.filter((g) => listed.has(g.device_id));
  const gapsArchive = report.gaps.filter((g) => !listed.has(g.device_id));
  const reasons: string[] = [];
  if (report.failures.length > 0) reasons.push(`${report.failures.length} line(s) failed verification`);
  if (gapsListed.length > 0) reasons.push(`${gapsListed.length} gap(s) in a chain the export says it holds`);
  let anchors: PeExportVerification['anchors'];
  if (rpcUrl === null) {
    anchors = report.anchors.map((a) => ({ ...a, ok: null, reason: 'not_checked_offline' as const }));
  } else {
    let ethCall: EthCall;
    try {
      new URL(rpcUrl);
      ethCall = jsonRpcEthCall(rpcUrl, guardedFetcher(options.fetchFn), contacted, options.timeoutMs);
    } catch {
      ethCall = async () => {
        throw new Error('rpc_url_invalid');
      };
    }
    const checks = await verifyAnchorsOnChain(report.anchors, ethCall);
    anchors = checks;
    const bad = checks.filter((c) => !c.ok);
    if (bad.length > 0) reasons.push(`${bad.length} day root(s) not confirmed on Base (${[...new Set(bad.map((b) => b.reason))].join(', ')})`);
  }
  const incomplete = parsed.end.incomplete ?? [];
  if (incomplete.length > 0) reasons.push(`${incomplete.length} item(s) the export names as held by the owner but not included (see missing)`);
  const verdict = exportVerdictOf({
    parsed: true,
    failures: report.failures.length,
    gapsInListedDevices: gapsListed.length,
    incomplete: incomplete.length,
    anchorsConfirmed: rpcUrl === null ? null : anchors.every((a) => a.ok === true),
  });
  return {
    verdict,
    file,
    parse_error: null,
    header: {
      owner: parsed.header.owner,
      exported_at_ms: parsed.header.exported_at_ms,
      producer: parsed.header.producer,
      devices: parsed.header.devices,
      archive_state: parsed.header.archive?.state ?? 'unknown',
    },
    counts: report.counts,
    failures: report.failures,
    gaps_in_listed_devices: gapsListed,
    gaps_archive_only: gapsArchive,
    pending: report.pending,
    incomplete,
    missing: incomplete.map((x) => `${x.what} — ${x.reason}`),
    anchors,
    rpc: { url: rpcUrl, contacted_hosts: [...contacted] },
    reasons,
  };
}

/** Read and verify an export file: offline, then (unless `offline`) each day root on Base. */
export async function verifyPeExportFile(filePath: string, options: VerifyPeExportOptions = {}): Promise<PeExportVerification> {
  return verifyPeExportText(fs.readFileSync(filePath, 'utf8'), filePath, options);
}
