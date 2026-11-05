#!/usr/bin/env node
/**
 * setup-hook - Install a git post-commit hook for automatic PE generation
 *
 * Installs a post-commit hook that reports every commit as a Provenance
 * Envelope. Commit work mints PVT once at its best-supported value.
 *
 * Usage:
 *   npx @provian/agent-sdk setup-hook              # Interactive (recommends global)
 *   npx @provian/agent-sdk setup-hook --global      # Global install (all repos)
 *   npx @provian/agent-sdk setup-hook --local       # This repo only
 *   npx @provian/agent-sdk setup-hook --yes         # Non-interactive (defaults to global)
 *   npx @provian/agent-sdk setup-hook --remove       # Uninstall (auto-detects mode)
 *   npx @provian/agent-sdk setup-hook --remove --global  # Remove global hook
 *   npx @provian/agent-sdk setup-hook --remove --local   # Remove per-repo hook
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { execSync } from 'child_process';
import * as os from 'os';
// WS3 : one shared, tested composer that installs into the repo's ACTIVE
// hooks path (respecting a repo-local/global core.hooksPath) instead of the
// always-wrong `.git/hooks`.
import { hookNodeInvocation, installIntoRepo, repoActiveHooksDir } from '../hook-install';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const START_MARKER = '# --- Provian PE Hook Start ---';
const END_MARKER = '# --- Provian PE Hook End ---';
const GLOBAL_HOOKS_DIR = path.join(os.homedir(), '.provian', 'hooks');
const PREV_HOOKS_PATH_FILE = path.join(os.homedir(), '.provian', '.prev-hooks-path');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findGitDir(startDir: string): string | null {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;

  while (dir !== root) {
    const gitPath = path.join(dir, '.git');
    try {
      const stat = fs.statSync(gitPath);
      if (stat.isDirectory()) return gitPath;
    } catch {
      // not found, keep walking
    }
    dir = path.dirname(dir);
  }
  return null;
}

function resolveReportPeCmd(): string {
  // Prefer local build (same package), fall back to npx
  const localScript = path.resolve(__dirname, 'report-pe.js');
  if (fs.existsSync(localScript)) {
    return `${hookNodeInvocation(process.execPath)} "${localScript}"`;
  }
  return 'npx @provian/agent-sdk report-pe';
}

function loadTemplate(): string {
  // Template lives alongside the compiled scripts in dist, or in hooks/ at package root
  const candidates = [
    path.resolve(__dirname, '../../hooks/post-commit.template'),
    path.resolve(__dirname, '../hooks/post-commit.template'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return fs.readFileSync(p, 'utf-8');
    }
  }
  throw new Error('Could not find post-commit.template. Is the SDK installed correctly?');
}

function buildHookSection(): string {
  const template = loadTemplate();
  const reportCmd = resolveReportPeCmd();
  return template.replace('{{REPORT_PE_CMD}}', reportCmd);
}

function extractProvianSection(content: string): { before: string; after: string; found: boolean } {
  const startIdx = content.indexOf(START_MARKER);
  const endIdx = content.indexOf(END_MARKER);

  if (startIdx === -1 || endIdx === -1) {
    return { before: content, after: '', found: false };
  }

  const before = content.substring(0, startIdx).replace(/\n+$/, '');
  const after = content.substring(endIdx + END_MARKER.length).replace(/^\n+/, '');
  return { before, after, found: true };
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function confirm(question: string): Promise<boolean> {
  return prompt(question).then(answer =>
    answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes'
  );
}

function getGitConfig(key: string): string | null {
  try {
    return execSync(`git config --global ${key}`, { encoding: 'utf-8' }).trim() || null;
  } catch {
    return null;
  }
}

function setGitConfig(key: string, value: string): void {
  execSync(`git config --global ${key} "${value}"`);
}

function unsetGitConfig(key: string): void {
  try {
    execSync(`git config --global --unset ${key}`);
  } catch {
    // already unset
  }
}

function savePrevHooksPath(hooksPath: string): void {
  const dir = path.dirname(PREV_HOOKS_PATH_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(PREV_HOOKS_PATH_FILE, hooksPath, 'utf-8');
}

function loadPrevHooksPath(): string | null {
  try {
    const val = fs.readFileSync(PREV_HOOKS_PATH_FILE, 'utf-8').trim();
    return val || null;
  } catch {
    return null;
  }
}

function removePrevHooksPathFile(): void {
  try {
    fs.unlinkSync(PREV_HOOKS_PATH_FILE);
  } catch {
    // doesn't exist
  }
}

/**
 * Install the hook section into a post-commit file at the given directory.
 * Uses marker-based append/replace logic.
 */
function installHookToDir(hooksDir: string, section: string): { hookPath: string; action: string; finalContent: string } {
  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  const hookPath = path.join(hooksDir, 'post-commit');
  let finalContent: string;
  let action: string;

  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, 'utf-8');
    const { before, after, found } = extractProvianSection(existing);

    if (found) {
      const parts = [before, section, after].filter(Boolean);
      finalContent = parts.join('\n');
      action = 'update';
    } else {
      finalContent = existing.trimEnd() + '\n\n' + section + '\n';
      action = 'append to';
    }
  } else {
    finalContent = '#!/bin/sh\n\n' + section + '\n';
    action = 'create';
  }

  return { hookPath, action, finalContent };
}

function writeHook(hookPath: string, content: string): void {
  fs.writeFileSync(hookPath, content, { mode: 0o755 });
  fs.chmodSync(hookPath, 0o755);
}

function printEnvHint(): void {
  if (!process.env.PROVIAN_DEVICE_KEY || !process.env.PROVIAN_DEVICE_SECRET) {
    console.log('  Note: Set these env vars for the hook to work:');
    console.log('    export PROVIAN_DEVICE_KEY=pdk_...');
    console.log('    export PROVIAN_DEVICE_SECRET=pds_...');
    console.log('');
    console.log("  Register your device first if you haven't:");
    console.log('    npx @provian/agent-sdk register-device\n');
  }
}

function printUsage(): void {
  console.log(`
Usage: setup-hook [options]

Options:
  --global          Install globally (recommended) - every repo on this machine
  --local           Install for current repo only
  --yes, -y         Skip confirmation prompt (non-interactive, defaults to global)
  --remove          Remove the Provian hook
  --help, -h        Show this help

When run with no flags, interactively asks which mode to use.

Environment variables (required for the hook to work at commit time):
  PROVIAN_DEVICE_KEY      Device key (pdk_...)
  PROVIAN_DEVICE_SECRET   Device secret (pds_...)
  PROVIAN_RELAY_URL       Relay URL (default: https://api.provian.ai)

  PROVIAN_DISABLE_HOOK=1  Temporarily disable PE reporting

Examples:
  setup-hook              # Interactive install (recommends global)
  setup-hook --global     # Global install (all repos, one-time)
  setup-hook --local      # Per-repo install
  setup-hook --yes        # Non-interactive global install
  setup-hook --remove     # Uninstall (auto-detects mode)
`);
}

// ---------------------------------------------------------------------------
// Install: Global
// ---------------------------------------------------------------------------

async function installGlobal(skipConfirm: boolean): Promise<void> {
  const section = buildHookSection();
  const existingHooksPath = getGitConfig('core.hooksPath');

  // Check for existing core.hooksPath that isn't ours
  if (existingHooksPath && existingHooksPath !== GLOBAL_HOOKS_DIR) {
    console.log(`\n  Warning: core.hooksPath is already set to: ${existingHooksPath}`);
    console.log(`  Setting it to ${GLOBAL_HOOKS_DIR} will override this.\n`);

    if (!skipConfirm) {
      const mergeAnswer = await prompt(
        '  Merge existing hooks into ~/.provian/hooks/ first? [Y/n] '
      );
      const shouldMerge = mergeAnswer === '' || mergeAnswer.toLowerCase() === 'y' || mergeAnswer.toLowerCase() === 'yes';

      if (shouldMerge && fs.existsSync(existingHooksPath)) {
        // Copy hooks from old path
        if (!fs.existsSync(GLOBAL_HOOKS_DIR)) {
          fs.mkdirSync(GLOBAL_HOOKS_DIR, { recursive: true });
        }
        const files = fs.readdirSync(existingHooksPath);
        let copied = 0;
        for (const file of files) {
          const src = path.join(existingHooksPath, file);
          const dest = path.join(GLOBAL_HOOKS_DIR, file);
          const stat = fs.statSync(src);
          if (stat.isFile()) {
            // Don't overwrite if dest already exists (our hooks take priority)
            if (!fs.existsSync(dest)) {
              fs.copyFileSync(src, dest);
              fs.chmodSync(dest, stat.mode);
              copied++;
            }
          }
        }
        if (copied > 0) {
          console.log(`  Copied ${copied} hook(s) from ${existingHooksPath}`);
        }
      }

      const ok = await confirm('  Proceed with setting core.hooksPath? [y/N] ');
      if (!ok) {
        console.log('Cancelled.');
        process.exit(0);
      }
    }

    // Save previous path for restore on --remove
    savePrevHooksPath(existingHooksPath);
  }

  // Install hook file
  const { hookPath, action, finalContent } = installHookToDir(GLOBAL_HOOKS_DIR, section);

  if (!skipConfirm) {
    console.log(`\nWill ${action} hook: ${hookPath}`);
    console.log('Will set: git config --global core.hooksPath ~/.provian/hooks/\n');

    const ok = await confirm('Install? [y/N] ');
    if (!ok) {
      console.log('Cancelled.');
      process.exit(0);
    }
  }

  writeHook(hookPath, finalContent);
  setGitConfig('core.hooksPath', GLOBAL_HOOKS_DIR);

  console.log('\n  Every repo on this machine now generates PEs on commit. No per-repo setup needed.\n');
  printEnvHint();

  console.log('  Disable temporarily: export PROVIAN_DISABLE_HOOK=1');
  console.log('  Uninstall:           npx @provian/agent-sdk setup-hook --remove --global\n');
}

// ---------------------------------------------------------------------------
// Install: Local (per-repo)
// ---------------------------------------------------------------------------

async function installLocal(skipConfirm: boolean): Promise<void> {
  const gitDir = findGitDir(process.cwd());
  if (!gitDir) {
    console.error('Error: No .git directory found. Run this from inside a git repository.');
    process.exit(1);
  }

  const section = buildHookSection();

  if (!skipConfirm) {
    console.log('\n--- Hook content (Provian section) ---');
    console.log(section);
    console.log('--------------------------------------\n');

    const ok = await confirm('Install this hook? [y/N] ');
    if (!ok) {
      console.log('Cancelled.');
      process.exit(0);
    }
  }

  // WS3: install where git ACTUALLY reads this repo's hooks (a repo-local
  // core.hooksPath — Husky / lefthook / .githooks — wins over the default
  // .git/hooks, which git ignores in that case). The shared composer preserves
  // any foreign post-commit and never touches sibling hook types (pre-commit …).
  let res: ReturnType<typeof installIntoRepo>;
  try {
    res = installIntoRepo(process.cwd(), { section });
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }

  console.log(`\n  Hook ${res.action}: ${res.hookPath}`);
  if (path.resolve(res.hooksDir) !== path.resolve(path.join(gitDir, 'hooks'))) {
    console.log(`  (this repo uses core.hooksPath ${res.hooksDir} — installed there so git runs it)`);
  }
  console.log('\n  Your commits in this repo now create proof and mint PVT once.\n');
  printEnvHint();

  console.log('  Tip: Run with --global to cover every repo on this machine.');
  console.log('');
  console.log('  Disable temporarily: export PROVIAN_DISABLE_HOOK=1');
  console.log('  Uninstall:           npx @provian/agent-sdk setup-hook --remove\n');
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

function removeHookFromDir(hooksDir: string, label: string): boolean {
  const hookPath = path.join(hooksDir, 'post-commit');
  if (!fs.existsSync(hookPath)) {
    console.log(`No post-commit hook found at ${hooksDir}. Nothing to remove.`);
    return false;
  }

  const existing = fs.readFileSync(hookPath, 'utf-8');
  const { before, after, found } = extractProvianSection(existing);

  if (!found) {
    console.log(`No Provian hook section found in ${hookPath}. Nothing to remove.`);
    return false;
  }

  const remaining = (before + '\n' + after).trim();

  if (!remaining || remaining === '#!/bin/sh') {
    fs.unlinkSync(hookPath);
    console.log(`Removed: ${hookPath}`);
  } else {
    fs.writeFileSync(hookPath, remaining + '\n', { mode: 0o755 });
    console.log(`Removed Provian section from: ${hookPath}`);
  }

  console.log(`Provian PE hook uninstalled (${label}).`);
  return true;
}

async function removeGlobal(): Promise<void> {
  removeHookFromDir(GLOBAL_HOOKS_DIR, 'global');

  // Restore previous hooks path or unset
  const prev = loadPrevHooksPath();
  if (prev) {
    setGitConfig('core.hooksPath', prev);
    removePrevHooksPathFile();
    console.log(`Restored core.hooksPath to: ${prev}`);
  } else {
    // Only unset if it's pointing to our directory
    const current = getGitConfig('core.hooksPath');
    if (current === GLOBAL_HOOKS_DIR) {
      unsetGitConfig('core.hooksPath');
      console.log('Unset git config --global core.hooksPath');
    }
    removePrevHooksPathFile();
  }
}

async function removeLocal(): Promise<void> {
  const gitDir = findGitDir(process.cwd());
  if (!gitDir) {
    console.error('Error: No .git directory found.');
    process.exit(1);
  }

  // Symmetric with installLocal (WS3): remove from the ACTIVE hooks dir git reads
  // for this repo (a repo-local core.hooksPath like `.githooks`), else `.git/hooks`.
  removeHookFromDir(repoActiveHooksDir(process.cwd()) ?? path.join(gitDir, 'hooks'), 'local');
}

async function removeAuto(): Promise<void> {
  // Auto-detect: check global first, then local
  const globalHookPath = path.join(GLOBAL_HOOKS_DIR, 'post-commit');
  const hasGlobal = fs.existsSync(globalHookPath) &&
    fs.readFileSync(globalHookPath, 'utf-8').includes(START_MARKER);

  const gitDir = findGitDir(process.cwd());
  const hasLocal = gitDir && (() => {
    // The ACTIVE hooks dir (WS3), not always `.git/hooks` — else a `.githooks`
    // repo's installed hook is invisible to auto-remove.
    const activeDir = repoActiveHooksDir(process.cwd()) ?? path.join(gitDir, 'hooks');
    const localHookPath = path.join(activeDir, 'post-commit');
    return fs.existsSync(localHookPath) &&
      fs.readFileSync(localHookPath, 'utf-8').includes(START_MARKER);
  })();

  if (hasGlobal && hasLocal) {
    console.log('Found Provian hooks in both global and local locations.');
    const answer = await prompt('  Remove [1] Global  [2] Local  [3] Both? ');
    if (answer === '1') await removeGlobal();
    else if (answer === '2') await removeLocal();
    else if (answer === '3') {
      await removeGlobal();
      await removeLocal();
    } else {
      console.log('Cancelled.');
    }
  } else if (hasGlobal) {
    await removeGlobal();
  } else if (hasLocal) {
    await removeLocal();
  } else {
    console.log('No Provian hook found (checked global and local). Nothing to remove.');
  }
}

// ---------------------------------------------------------------------------
// Interactive mode selector
// ---------------------------------------------------------------------------

async function interactiveInstall(): Promise<void> {
  console.log('\n  How would you like to install?\n');
  console.log('    [1] Global (recommended) - every repo on this machine, one-time setup');
  console.log('    [2] This repo only - just the current git repository\n');

  const answer = await prompt('  Choose [1/2]: ');

  if (answer === '1' || answer === '') {
    await installGlobal(false);
  } else if (answer === '2') {
    await installLocal(false);
  } else {
    console.log('Cancelled.');
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  const hasGlobal = args.includes('--global');
  const hasLocal = args.includes('--local');
  const hasRemove = args.includes('--remove');
  const skipConfirm = args.includes('--yes') || args.includes('-y');

  if (hasRemove) {
    if (hasGlobal) {
      await removeGlobal();
    } else if (hasLocal) {
      await removeLocal();
    } else {
      await removeAuto();
    }
    return;
  }

  if (hasGlobal) {
    await installGlobal(skipConfirm);
  } else if (hasLocal) {
    await installLocal(skipConfirm);
  } else if (skipConfirm) {
    // --yes without explicit mode defaults to global
    await installGlobal(true);
  } else {
    // No flags: interactive mode
    await interactiveInstall();
  }
}

main().catch(err => {
  console.error(`Unexpected error: ${err}`);
  process.exit(1);
});
