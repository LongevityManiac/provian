#!/usr/bin/env node
/**
 * export-agent-keystore - Export the complete encrypted agent recovery state.
 *
 * A separate backup passphrase protects current and retired key generations,
 * pending operations, API credentials and the local at-rest secret together.
 *
 * There is no cloud backup in Node; this is the supported backup path.
 *
 * Usage:
 *   npx @provian/agent-sdk export-agent-keystore ./agent-keystore.backup.json
 *   npx @provian/agent-sdk export-agent-keystore /Volumes/usb/keystore.json
 *
 * Recovery (on a new device, after copying the backup file over):
 *   npx @provian/agent-sdk restore-agent-backup ./agent-keystore.backup.json ~/.provian
 */

import { exportKeystore, getDefaultKeystorePath } from '../keystore';
import { exportRetiredKeystore } from '../retired-keystore';
import { isDirectCliEntry } from './cli-entry';
import { homedir } from 'os';
import * as path from 'path';
import { exportAgentRecoveryBackup } from '../agent-recovery-backup';
import { readLocalKeystoreSecret } from '../local-keystore-secret';
import { readSecret } from './prompt-secret';

export async function runExportKeystoreCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const dest = argv[0];
  if (!dest || dest === '--help' || dest === '-h') {
    console.log(`
Usage: export-agent-keystore <destination-path>
       export-agent-keystore <destination-path> --keystore-only
       export-agent-keystore <destination-path> --retired [--rotation-id=<id>]

Creates a complete encrypted recovery backup of the agent directory containing
${getDefaultKeystorePath()}, including hash accounts, independent recovery keys
and pending transactions. Choose a separate backup passphrase at the hidden prompt.
Restore with restore-agent-backup <backup-path> <new-directory>.
--keystore-only and --retired export only a curve key, without later recovery state.
`);
    process.exit(dest ? 0 : 1);
  }

  try {
    const rotationId = argv.find(arg => arg.startsWith('--rotation-id='))?.slice('--rotation-id='.length);
    const curveOnly = argv.includes('--retired') || !!rotationId || argv.includes('--keystore-only');
    let written: string;
    if (curveOnly) written = argv.includes('--retired') || rotationId ? exportRetiredKeystore(dest, rotationId) : exportKeystore(dest);
    else {
      const directory = path.join(homedir(), '.provian');
      const localPassphrase = process.env.PROVIAN_KEYSTORE_PASSPHRASE ?? readLocalKeystoreSecret(path.join(directory, 'agent-keystore.secret'));
      if (!localPassphrase) throw Error('Local keystore passphrase unavailable');
      const backupPassphrase = process.env.PROVIAN_BACKUP_PASSPHRASE ?? await readSecret('Backup passphrase (hidden): ');
      if (!process.env.PROVIAN_BACKUP_PASSPHRASE && await readSecret('Repeat backup passphrase (hidden): ') !== backupPassphrase) throw Error('Backup passphrases do not match');
      written = await exportAgentRecoveryBackup({ directory, destination: dest, localPassphrase, backupPassphrase });
    }
    console.log(`\n  Encrypted ${curveOnly ? 'curve keystore' : 'recovery backup'} exported to: ${written}`);
    console.log('  Keep the passphrase separately. Export again after recovery or key changes.\n');
  } catch (error) {
    console.error(`  Export failed: ${(error as Error).message}\n`);
    process.exit(1);
  }
}

if (isDirectCliEntry(module)) void runExportKeystoreCli();
