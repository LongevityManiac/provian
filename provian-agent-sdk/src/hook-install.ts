/**
 * hook-install — the ONE place that installs the Provian git post-commit hook,
 * composing with whatever hook system a repo already uses instead of clobbering
 * it (/ WS3).
 *
 * WHY THIS EXISTS. Before WS3 the installer had three composition holes:
 * (A) `setup-hook --global`/`register-device` set `core.hooksPath` to
 * `~/.provian/hooks` but never merged the user's PRIOR global hooks into
 * it, so a global pre-commit/post-merge silently stopped running.
 * (B) a repo with its OWN `core.hooksPath` (Husky's `.husky`, lefthook, a
 * hand-set `.githooks`) is git-PREFERRED over the global one, so the
 * Provian global hook never fired there at all — and `--local` installed
 * into `.git/hooks`, which git also ignores when `core.hooksPath` is set.
 * (C) the agent bootstrap started the observer but never installed the hook.
 * (D) the Provian hook did not run the repo's OWN post-commit that
 * `core.hooksPath` had diverted git away from.
 *
 * THE MODEL. Provian ADDS its capture without REMOVING any hook git would
 * otherwise run:
 * - Default repo (no core.hooksPath): append into `.git/hooks/post-commit`.
 * - Global capture (global core.hooksPath -> ~/.provian/hooks): the Provian
 * hook CHAINS to the repo's `.git/hooks/post-commit` (the template's
 * self-aware chain block, active only when it runs from ~/.provian/hooks).
 * - Repo with its own core.hooksPath: append into THAT path's post-commit,
 * preserving the file's existing content (marker-based), and NOT chaining to
 * `.git/hooks` (the repo deliberately chose its own path).
 *
 * The pure decisions (`resolveActiveHooksDir`, `composePostCommit`) carry their
 * own RED negative controls (hook-install.test.ts,).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { extractScriptPaths, realProbe, resolveRuntimeTarget, SourceTreeRefusal } from './observer/runtime-install';
import { POST_COMMIT_TEMPLATE } from './post-commit-template.generated';
import { execFileSync } from 'child_process';

/**
 * The last-resort hook command when neither a bundle nor an installed package resolves (a source
 * checkout). Joined at runtime so the hosted bundle — which always resolves its own bundle and never
 * reaches this — carries no npx command literal.
 */
const NPX_REPORT_PE_FALLBACK = ['npx', '@provian/agent-sdk', 'report-pe'].join(' ');

export const HOOK_START_MARKER = '# --- Provian PE Hook Start ---';
export const HOOK_END_MARKER = '# --- Provian PE Hook End ---';
export const GLOBAL_HOOKS_DIR = path.join(os.homedir(), '.provian', 'hooks');
export const PREV_HOOKS_PATH_FILE = path.join(os.homedir(), '.provian', '.prev-hooks-path');

// ---------------------------------------------------------------------------
// git config (thin, injectable for tests)
// ---------------------------------------------------------------------------

export interface GitConfigIO {
  get(scope: 'global' | 'local', key: string, cwd?: string): string | null;
  set(scope: 'global' | 'local', key: string, value: string, cwd?: string): void;
  unset(scope: 'global' | 'local', key: string, cwd?: string): void;
  repoRoot(cwd: string): string | null;
}

export const realGit: GitConfigIO = {
  get(scope, key, cwd) {
    try {
      return execFileSync('git', ['config', `--${scope}`, key], {
        encoding: 'utf-8', cwd,
      }).trim() || null;
    } catch {
      return null;
    }
  },
  set(scope, key, value, cwd) {
    execFileSync('git', ['config', `--${scope}`, key, value], { cwd });
  },
  unset(scope, key, cwd) {
    try {
      execFileSync('git', ['config', `--${scope}`, '--unset', key], { cwd });
    } catch {
      /* already unset */
    }
  },
  repoRoot(cwd) {
    try {
      return execFileSync('git', ['rev-parse', '--show-toplevel'], {
        encoding: 'utf-8', cwd,
      }).trim() || null;
    } catch {
      return null;
    }
  },
};

// ---------------------------------------------------------------------------
// Pure decisions (RED-controlled)
// ---------------------------------------------------------------------------

/**
 * The directory git will ACTUALLY read this repo's post-commit from.
 *
 * Precedence mirrors git exactly: a repo-local `core.hooksPath` wins over a
 * global one, which wins over the default `.git/hooks`. A relative hooksPath is
 * resolved against the repo root (git resolves it against the repo working dir),
 * an absolute one is taken as-is. This is the fix for holes (B) and the
 * `--local`-into-`.git/hooks` bug: installing anywhere but here is installing
 * where git will not look.
 */
export function resolveActiveHooksDir(input: {
  readonly repoRoot: string;
  readonly localHooksPath: string | null;
  readonly globalHooksPath: string | null;
}): string {
  const pick = input.localHooksPath ?? input.globalHooksPath ?? path.join('.git', 'hooks');
  return path.isAbsolute(pick) ? pick : path.join(input.repoRoot, pick);
}

/**
 * The active hooks dir for a repo, resolved through git config — the symmetric
 * companion to `installIntoRepo`/`installLocal`, so `--remove` looks where the
 * install actually wrote (a repo-local `core.hooksPath` such as `.githooks`),
 * not the always-wrong `.git/hooks`. Null when `cwd` is not inside a repo.
 */
export function repoActiveHooksDir(cwd: string, git: GitConfigIO = realGit): string | null {
  const repoRoot = git.repoRoot(cwd);
  if (repoRoot === null) return null;
  return resolveActiveHooksDir({
    repoRoot,
    localHooksPath: git.get('local', 'core.hooksPath', cwd),
    globalHooksPath: git.get('global', 'core.hooksPath', cwd),
  });
}

/**
 * Merge the Provian section into an existing post-commit file WITHOUT dropping
 * anything already there. Three cases, each preserving the user's bytes:
 *   - no file yet            -> a fresh `#!/bin/sh` + our section
 *   - our markers present    -> replace ONLY between the markers (idempotent update)
 *   - a foreign post-commit  -> keep it verbatim, append our section after it
 */
export function composePostCommit(existing: string | null, section: string): string {
  if (existing === null || existing.trim() === '') {
    return `#!/bin/sh\n\n${section}\n`;
  }
  const s = existing.indexOf(HOOK_START_MARKER);
  const e = existing.indexOf(HOOK_END_MARKER);
  if (s !== -1 && e !== -1 && e > s) {
    const before = existing.slice(0, s).replace(/\n+$/, '');
    const after = existing.slice(e + HOOK_END_MARKER.length).replace(/^\n+/, '');
    // Replace marker block with marker block: the section's own leading
    // `#!/bin/sh` must not stack a new shebang on every reinstall.
    return [before, markerBlock(section) ?? section, after].filter((p) => p.length > 0).join('\n') + '\n';
  }
  return existing.trimEnd() + '\n\n' + section + '\n';
}

/** True when the post-commit content already carries the Provian section. */
export function hasProvianSection(content: string): boolean {
  return content.includes(HOOK_START_MARKER) && content.includes(HOOK_END_MARKER);
}

// ---------------------------------------------------------------------------
// Template + section
// ---------------------------------------------------------------------------

/**
 * The hook body.
 *
 * Returned from a compiled-in constant, NOT read off disk. A `__dirname`-relative
 * read of a packaged data file works from an npm install and silently fails
 * inside the single-file bundle — which is how bundle-installed devices ended up
 * with a running observer and no commit hook at all. The on-disk
 * `hooks/post-commit.template` is still the editable source and is pinned to the
 * constant by a parity test.
 */
export function loadTemplate(): string {
  return POST_COMMIT_TEMPLATE;
}

/**
 * The command the global post-commit hook bakes.
 *
 * Goes through the same runtime resolver as the observer service, for the same
 * reason: this string is written into a file that outlives the install, and a
 * source-tree path in it fails SILENTLY — a commit hook that cannot find its
 * script simply reports nothing, forever, with no error anyone reads.
 */
export function resolveReportPeCmd(
  opts: { nodeBin?: string; moduleDir?: string; hostedBundle?: string } = {},
): string {
  const nodeBin = opts.nodeBin ?? process.execPath;
  try {
    const target = resolveRuntimeTarget({
      bundlePath: process.env.PROVIAN_BUNDLE_PATH,
      // resolvePackageRoot climbs two levels (it assumes dist/observer); this
      // module compiles to dist/, so hand it a dist/observer-shaped dir — the
      // bare `__dirname` resolved to <pkg>/.., a path that does not exist.
      moduleDir: path.join(opts.moduleDir ?? __dirname, 'observer'),
      ...(opts.hostedBundle !== undefined ? { hostedBundle: opts.hostedBundle } : {}),
    });
    return `${hookNodeInvocation(nodeBin)} ${target.reportPeArgs.map((a) => shellQuote(a)).join(' ')}`;
  } catch (err) {
    if (!(err instanceof SourceTreeRefusal)) throw err;
    // Never bake the checkout path. npx is wrong-but-visible (it prints an
    // error); a dead absolute path is wrong-and-silent.
    return NPX_REPORT_PE_FALLBACK;
  }
}

/**
 * How the hook starts Node. A bare `node` is wrong on exactly the boxes
 * the hosted `curl | sh` line exists for: no system Node, so the installer put a
 * private runtime in `~/.provian/node` that is on nobody's PATH — the hook ran
 * `node: not found` into hook.log and every commit PE was lost. So the hook bakes
 * the ABSOLUTE node the installer ran under, and falls back to PATH `node` only
 * if that binary is later removed (an nvm version dropped), which is the one case
 * where PATH is the better guess. The result is spliced into the template's
 * `(… &)` subshell, so the assignments never leak into the hook's own scope.
 */
export function hookNodeInvocation(nodeBin: string): string {
  return `PROVIAN_NODE=${shellQuote(nodeBin)}; [ -x "$PROVIAN_NODE" ] || PROVIAN_NODE=node; "$PROVIAN_NODE"`;
}

/**
 * POSIX single-quoting: every byte is literal inside single quotes except the quote itself, which
 * is closed, backslash-escaped and reopened. The baked paths used to ride in DOUBLE quotes, where
 * `$`, a backtick and a backslash are still live (2026-10-17 bug check).
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Repair a BROKEN global hook at daemon start — never re-target a
 * working one. A hook is broken when its Provian block starts a bare `node`
 * (pre-fix: `node: not found` on a private-runtime box) or bakes a script that
 * no longer exists. Only then is the block (between its markers; foreign content
 * preserved) rewritten, and only with a section whose own script EXISTS — never
 * the `npx` fallback, never a path this process merely computed. A hook the user
 * did not install is never created; a repo-local hook is never touched.
 */
export function healGlobalHook(
  opts: { hooksDir?: string; section?: string; exists?: (p: string) => boolean } = {},
): 'healed' | 'current' | 'absent' | 'skipped' {
  const exists = opts.exists ?? realProbe.exists;
  const hookPath = path.join(opts.hooksDir ?? GLOBAL_HOOKS_DIR, 'post-commit');
  let existing: string;
  try { existing = fs.readFileSync(hookPath, 'utf-8'); } catch { return 'absent'; }
  const have = markerBlock(existing);
  if (have === null) return 'absent';
  const haveScripts = extractScriptPaths(have);
  const broken = !have.includes('PROVIAN_NODE=') || haveScripts.length === 0 || !haveScripts.every(exists);
  if (!broken) return 'current';
  const section = opts.section ?? buildSection();
  if (section.includes(NPX_REPORT_PE_FALLBACK)) return 'skipped';
  // Compare and replace ONLY the marker block: the template carries its own
  // `#!/bin/sh` ahead of the start marker, so a whole-section compare would call
  // every hook stale and each heal would stack another shebang line.
  const want = markerBlock(section);
  if (want === null) return 'skipped';
  const wantScripts = extractScriptPaths(want);
  if (wantScripts.length === 0 || !wantScripts.every(exists)) return 'skipped';
  if (have === want) return 'current';
  writeHook(hookPath, composePostCommit(existing, want));
  return 'healed';
}

function markerBlock(text: string): string | null {
  const s = text.indexOf(HOOK_START_MARKER);
  const e = text.indexOf(HOOK_END_MARKER);
  return s !== -1 && e > s ? text.slice(s, e + HOOK_END_MARKER.length) : null;
}

export function buildSection(reportCmd?: string): string {
  return loadTemplate().replace('{{REPORT_PE_CMD}}', reportCmd ?? resolveReportPeCmd());
}

// ---------------------------------------------------------------------------
// Install actions
// ---------------------------------------------------------------------------

function writeHook(hookPath: string, content: string): void {
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  fs.writeFileSync(hookPath, content, { mode: 0o755 });
  fs.chmodSync(hookPath, 0o755);
}

export type InstallAction = 'created' | 'updated' | 'appended';

/** Compose the Provian section into the post-commit at `hooksDir`. */
export function installIntoHooksDir(hooksDir: string, section: string): {
  hookPath: string;
  action: InstallAction;
} {
  const hookPath = path.join(hooksDir, 'post-commit');
  const existing = fs.existsSync(hookPath) ? fs.readFileSync(hookPath, 'utf-8') : null;
  const action: InstallAction = existing === null
    ? 'created'
    : hasProvianSection(existing) ? 'updated' : 'appended';
  writeHook(hookPath, composePostCommit(existing, section));
  return { hookPath, action };
}

/**
 * Install so THIS repo captures commits, wherever git actually reads hooks from.
 * The fix for holes (B) and the `--local`→`.git/hooks` bug: resolve the active
 * hooks dir (respecting a repo-local or global `core.hooksPath`) and compose
 * there, so a Husky/lefthook/`.githooks` repo fires Provian AND keeps its own
 * hooks (a foreign post-commit is preserved; sibling hook types like `pre-commit`
 * are never touched).
 */
export function installIntoRepo(
  cwd: string,
  opts: { git?: GitConfigIO; section?: string } = {},
): { hookPath: string; action: InstallAction; hooksDir: string } {
  const git = opts.git ?? realGit;
  const repoRoot = git.repoRoot(cwd);
  if (repoRoot === null) throw new Error('Not inside a git repository.');
  const hooksDir = resolveActiveHooksDir({
    repoRoot,
    localHooksPath: git.get('local', 'core.hooksPath', cwd),
    globalHooksPath: git.get('global', 'core.hooksPath', cwd),
  });
  const { hookPath, action } = installIntoHooksDir(hooksDir, opts.section ?? buildSection());
  return { hookPath, action, hooksDir };
}

/**
 * Global install: set global `core.hooksPath` -> ~/.provian/hooks, MERGING the
 * user's prior global hooks into it first (hole A), so their existing global
 * hooks keep running. Non-interactive by construction — used by `--yes`,
 * `register-device`, and the agent bootstrap alike.
 */
export function installGlobal(
  opts: {
    git?: GitConfigIO;
    section?: string;
    /** Overridable for tests so they never touch the real ~/.provian/hooks. */
    targetDir?: string;
    prevFile?: string;
  } = {},
): { hookPath: string; action: InstallAction; merged: string[] } {
  const git = opts.git ?? realGit;
  const targetDir = opts.targetDir ?? GLOBAL_HOOKS_DIR;
  const prevFile = opts.prevFile ?? PREV_HOOKS_PATH_FILE;
  const prior = git.get('global', 'core.hooksPath');
  const merged: string[] = [];

  if (prior && path.resolve(prior) !== path.resolve(targetDir) && fs.existsSync(prior)) {
    // Copy the user's prior global hooks in first (never overwrite ours), so a
    // prior global pre-commit / post-merge / etc. keeps firing under the new path.
    fs.mkdirSync(targetDir, { recursive: true });
    for (const file of fs.readdirSync(prior)) {
      const src = path.join(prior, file);
      const dest = path.join(targetDir, file);
      if (!fs.statSync(src).isFile() || fs.existsSync(dest)) continue;
      fs.copyFileSync(src, dest);
      fs.chmodSync(dest, fs.statSync(src).mode);
      merged.push(file);
    }
    // Remember the prior path so `--remove` can restore it.
    fs.mkdirSync(path.dirname(prevFile), { recursive: true });
    fs.writeFileSync(prevFile, prior, 'utf-8');
  }

  const { hookPath, action } = installIntoHooksDir(targetDir, opts.section ?? buildSection());
  git.set('global', 'core.hooksPath', targetDir);
  return { hookPath, action, merged };
}
