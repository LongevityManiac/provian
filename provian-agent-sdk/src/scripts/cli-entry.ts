/**
 * cli-entry — decide whether a CLI module should self-execute.
 *
 * THE BUG THIS CLOSES. The single-file bundle has ONE process entry (bootstrap),
 * which dispatches a verb by importing a submodule and calling its exported CLI
 * body (`runReportPeCli`, `runBackfillCli`). Those submodules ALSO carry the
 * classic `if (require.main === module) main()` guard for their npm-installed,
 * run-directly form. Under Node 20 that guard is false for a dynamically-imported
 * bundled submodule, so only the dispatcher's call runs. Under Node 26 the SAME
 * bundle evaluates `require.main === module` as TRUE for that submodule too — so
 * `main()` fires on import AND the dispatcher calls it again: two concurrent
 * runs. For `report-pe` from the git hook that is a double PE per commit; for
 * `backfill-transcript` it double-submitted every turn (duplicate envelopes,
 * caught only because turn_id mint-once kept it from double-MINTING).
 *
 * So the dispatcher MARKS itself before importing anything, and a CLI self-execs
 * only when it is the genuine process entry AND was not reached through the
 * dispatcher. This is Node-version-independent: it does not rely on how the
 * bundle resolves `require.main`.
 */
const FLAG = '__PROVIAN_CLI_DISPATCHED__';

/** Called by the bundle dispatcher (bootstrap) before it imports a verb module. */
export function markCliDispatched(): void {
  (globalThis as Record<string, unknown>)[FLAG] = true;
}

/**
 * True only for a direct `node <script>` invocation — never when the module was
 * imported by the dispatcher (flag set) or by a test (require.main is the runner).
 */
export function isDirectCliEntry(mod: NodeModule): boolean {
  if ((globalThis as Record<string, unknown>)[FLAG]) return false;
  return require.main === mod;
}
