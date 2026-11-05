#!/usr/bin/env node
/**
 * uninstall - Remove the observer service, git hook, and credentials.
 *
 * One-command clean removal: `uninstall --yes` (npm: `npx @provian/agent-sdk uninstall`; hosted:
 * `"$HOME/.provian/bin/provian" uninstall`). Also removes the shell-startup restart hook
 * (via uninstallService).
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { uninstallService } from '../observer/service';
import { getProvianDir } from './credentials';
import { removeGrokHooks } from '../grok-home';
import { unrepointGrok } from '../grok-proxy-config';
import { isDirectCliEntry } from './cli-entry';
import { cliCommand, HOSTED_BUNDLE } from '../cli-command';

function removeGlobalGitHook(): void {
  const hooksDir = path.join(homedir(), '.provian', 'hooks');
  const hookPath = path.join(hooksDir, 'post-commit');
  if (fs.existsSync(hookPath)) {
    try { fs.unlinkSync(hookPath); } catch { /* ok */ }
  }
  // Unset core.hooksPath only if pointing to ours
  try {
    const current = execSync('git config --global core.hooksPath', { encoding: 'utf-8' }).trim();
    if (current === hooksDir) {
      execSync('git config --global --unset core.hooksPath');
    }
  } catch { /* no global setting */ }
}

function removeProvianDir(): void {
  const dir = getProvianDir();
  if (!fs.existsSync(dir)) return;
  // Best-effort recursive remove
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
}

/** The uninstall CLI body (the npm bin and the hosted bundle's `uninstall` verb,). */
export async function runUninstallCli(args: string[] = process.argv.slice(2)): Promise<void> {
  const yes = args.includes('--yes') || args.includes('-y');

  if (!yes) {
    console.log('');
    console.log('  This will:');
    console.log('    • Stop the Provian observer service (and remove its shell-startup restart hook)');
    console.log('    • Remove the global git hook');
    console.log('    • Remove the Provian Grok Build hook file and proxy repoint (if present)');
    console.log('    • Delete ~/.provian/ (credentials, logs, PID file)');
    console.log('');
    console.log('  Re-run with --yes to confirm. Your PE chain on the relay is unaffected.');
    process.exit(0);
  }

  console.log('  Stopping observer...');
  try { uninstallService(); } catch (err) {
    console.warn(`  Warning: service uninstall failed: ${(err as Error).message}`);
  }

  console.log('  Removing git hook...');
  try { removeGlobalGitHook(); } catch (err) {
    console.warn(`  Warning: git hook removal failed: ${(err as Error).message}`);
  }

  console.log('  Removing Grok Build hook file and proxy repoint...');
  try {
    const hooks = removeGrokHooks();
    if (hooks === 'foreign') console.warn('  Note: ~/.grok/hooks/provian.json is not Provian\'s; left in place.');
    unrepointGrok();
  } catch (err) {
    console.warn(`  Warning: Grok cleanup failed: ${(err as Error).message}`);
  }

  console.log('  Removing ~/.provian/...');
  try { removeProvianDir(); } catch (err) {
    console.warn(`  Warning: directory removal failed: ${(err as Error).message}`);
  }

  console.log('');
  console.log('  Uninstall complete. Your PE chain on the relay is preserved.');
  console.log(HOSTED_BUNDLE
    ? '  To set up again: generate a fresh code in the Provian app under "Connect an agent" and paste the install line.'
    : `  To re-register: ${cliCommand('register-device')}`);
}

if (isDirectCliEntry(module)) {
  runUninstallCli().catch(err => {
    console.error(`Unexpected error: ${err}`);
    process.exit(1);
  });
}
