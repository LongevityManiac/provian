/**
 * cli-command — the ONE place that renders a Provian CLI command for the runtime it is in (§3
 * item 5).
 *
 * Two artifacts print commands to a person or an agent, and they run different programs:
 * - the hosted single-file bundle (`curl … /v1/bootstrap/agent | sh` → `~/.provian/agent.js`),
 * whose installed command is the `~/.provian/bin/provian` wrapper (it execs the runtime that
 * wrote it on the bundle — see provian-shim.ts);
 * - the npm-installed SDK (`npx @provian/agent-sdk …`).
 * the curl line is canonical and its quirks are bugs — the hosted path never
 * names an npx or npm command (npm is unpublished until the flip, so `npx @provian/agent-sdk …`
 * E404s there).
 *
 * The choice is made at BUNDLE BUILD TIME: `scripts/build-bootstrap-bundle.mjs` defines
 * `__PROVIAN_HOSTED_BUNDLE__` as `true`, so esbuild folds `HOSTED_BUNDLE` to a constant and
 * eliminates every npm-side literal from the bundle (bundle-no-npm.test.ts reads the built bundle
 * and asserts it). tsc / vitest the identifier is undeclared, so `HOSTED_BUNDLE` is false.
 * Every function takes an explicit `hosted` override so both renderings are unit-testable.
 */

declare const __PROVIAN_HOSTED_BUNDLE__: boolean | undefined;

/** True only inside the hosted bundle (a build-time constant there; false in the npm package). */
export const HOSTED_BUNDLE: boolean =
  typeof __PROVIAN_HOSTED_BUNDLE__ !== 'undefined' && __PROVIAN_HOSTED_BUNDLE__ === true;

/**
 * The hosted wrapper, by ABSOLUTE path ( , defect 5): `~/.provian/bin` is never
 * put on PATH, and a hosted box may have no bare `node`, so this path is the one that always
 * resolves. Quoted so it pastes into any POSIX shell.
 */
export const HOSTED_CLI_PREFIX = '"$HOME/.provian/bin/provian"';

/**
 * The npm package's command prefix. Gated on `HOSTED_BUNDLE` itself (not only on the `hosted`
 * parameter) so the literal folds away in the bundle, where the parameter is not a constant.
 */
const NPM_CLI_PREFIX: string = HOSTED_BUNDLE ? HOSTED_CLI_PREFIX : 'npx @provian/agent-sdk';
const NPM_UPGRADE_COMMAND: string = HOSTED_BUNDLE ? '' : 'npm i @provian/agent-sdk@latest';

/** The command prefix for this runtime. */
export function cliPrefix(hosted: boolean = HOSTED_BUNDLE): string {
  return hosted ? HOSTED_CLI_PREFIX : NPM_CLI_PREFIX;
}

/** `<prefix> <sub>` — e.g. `cliCommand('doctor')`. */
export function cliCommand(sub: string, hosted: boolean = HOSTED_BUNDLE): string {
  return `${cliPrefix(hosted)} ${sub}`;
}

/**
 * How to get newer SDK code. The hosted install updates itself from the signed release channel
 * (self-update is default-on), so the hosted text names no command at all.
 */
export function sdkUpgradeHint(hosted: boolean = HOSTED_BUNDLE): string {
  return hosted
    ? 'the hosted install updates itself from the signed release channel; paste your install line again to update now'
    : NPM_UPGRADE_COMMAND;
}
