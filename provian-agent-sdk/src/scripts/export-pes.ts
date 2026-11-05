#!/usr/bin/env node
/**
 * export-pes — export every PE this agent owns in ONE file (`provian.pe-export.v1`,
 * docs/PE_PROTOCOL_SPEC.md §14): every device chain on this machine, its batches with the relay's
 * receipts and anchor proofs, every day held in the paid PE Archive, every PE sealed to this agent,
 * (the relay mailbox drained first), and every pre-meter record. An anchored PE carries its proof
 * to its on-chain anchor; a pending PE (not yet in an anchored day root) carries none until the next
 * export after the daily anchor; a pre-meter record carries none (checked against its own hash).
 * Anything held but not included is named in the file's `incomplete`.
 * The file is written 0600 (it holds the agent's PE content) and verified offline before this
 * returns. The same verb as the hosted `provian export-pes` and `provian pes export`.
 *
 * Usage (npm: `npx @provian/agent-sdk export-pes`; hosted: `"$HOME/.provian/bin/provian" export-pes`):
 *   export-pes [--out <file>]
 */
import { runActVerbCli } from '../act-verbs';
import { isDirectCliEntry } from './cli-entry';

export async function runExportPesCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  return runActVerbCli('export-pes', argv);
}

if (isDirectCliEntry(module)) {
  void runExportPesCli().then((code) => process.exit(code));
}
