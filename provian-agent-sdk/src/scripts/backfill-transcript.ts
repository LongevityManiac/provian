import { isDirectCliEntry } from './cli-entry';
export async function runBackfillCli(): Promise<void> {
  throw new Error('The catalog-based backfill is retired. Describe the real session store with provian witness configure; its durable reader resumes each turn exactly once.');
}
if (isDirectCliEntry(module)) void runBackfillCli().catch(e => { console.error(e.message); process.exitCode = 1; });
