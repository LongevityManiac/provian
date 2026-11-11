#!/usr/bin/env node
import { importAgentRecoveryBackup } from '../agent-recovery-backup';
import { readSecret } from './prompt-secret';
import { isDirectCliEntry } from './cli-entry';

export async function runRestoreAgentBackupCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('restore-agent-backup <backup-path> <new-directory>\nRestore a complete encrypted agent recovery backup locally. The destination must not already exist. No transaction is sent.'); return;
  }
  try {
    if (argv.length !== 2) throw Error('Use restore-agent-backup <backup-path> <new-directory>');
    const backupPassphrase = process.env.PROVIAN_BACKUP_PASSPHRASE ?? await readSecret('Backup passphrase (hidden): ');
    const result = await importAgentRecoveryBackup({ source: argv[0], directory: argv[1], backupPassphrase });
    console.log(`Agent recovery state restored to ${result.directory}. Resume recovery or inspect pending transactions before preparing new ones.`);
    console.log('For a custom local keystore passphrase, set PROVIAN_KEYSTORE_PASSPHRASE when running recovery commands. The protected agent-keystore.secret file retains the original local passphrase.');
  } catch (error) { console.error(`Restore failed: ${(error as Error).message}`); process.exitCode = 1; }
}
if (isDirectCliEntry(module)) void runRestoreAgentBackupCli();
