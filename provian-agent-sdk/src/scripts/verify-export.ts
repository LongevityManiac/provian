#!/usr/bin/env node
/**
 * verify-export — verify a PE export (`provian.pe-export.v1`) with nothing but a Base RPC: every
 * line offline (hashes, act paths, batch leaves, day-root paths, chain links), then each distinct
 * day root read once from PEAnchor on Base. No Provian server is contacted; the hosts contacted are
 * printed. Exit codes: 0 ok (or offline_ok); 1 failed — a failing line, a gap in a chain the file
 * lists, or a day root Base does not hold; 2 usage; 3 incomplete — every line in the file verifies,
 * but its end line names PEs the owner holds that it does not carry (printed under `missing`).
 *
 * Usage (npm: `npx @provian/agent-sdk verify-export <file>`; hosted: `"$HOME/.provian/bin/provian" verify-export <file>`):
 *   verify-export <file> [--rpc-url <url>] [--offline]
 */
import { runActVerbCli } from '../act-verbs';
import { isDirectCliEntry } from './cli-entry';

export async function runVerifyExportCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  return runActVerbCli('verify-export', argv);
}

if (isDirectCliEntry(module)) {
  void runVerifyExportCli().then((code) => process.exit(code));
}
