#!/usr/bin/env node
/**
 * export-agent-keystore - Copy the encrypted agent keystore to an off-device
 * backup location.
 *
 * The keystore is already AES-256-GCM encrypted, so the exported file is safe
 * to store on external media, a password manager, or a separate host. Recovery
 * still requires the passphrase - back up the passphrase separately (e.g. a
 * password manager), never alongside the keystore.
 *
 * There is no cloud backup in Node; this is the supported backup path.
 *
 * Usage:
 *   npx @provian/agent-sdk export-agent-keystore ./agent-keystore.backup.json
 *   npx @provian/agent-sdk export-agent-keystore /Volumes/usb/keystore.json
 *
 * Recovery (on a new device, after copying the backup file over):
 *   node -e "require('@provian/agent-sdk').importKeystore('./agent-keystore.backup.json', process.env.PROVIAN_KEYSTORE_PASSPHRASE)"
 */

import { exportKeystore, getDefaultKeystorePath } from '../keystore';
import { exportRetiredKeystore } from '../retired-keystore';
import { isDirectCliEntry } from './cli-entry';

export function runExportKeystoreCli(argv: string[] = process.argv.slice(2)): void {
  const dest = argv[0];
  if (!dest || dest === '--help' || dest === '-h') {
    console.log(`
Usage: export-agent-keystore <destination-path> [--retired] [--rotation-id=<id>]

Copies the encrypted keystore at ${getDefaultKeystorePath()}
to <destination-path> for off-device backup. The file stays encrypted;
recovery still needs your passphrase.
`);
    process.exit(dest ? 0 : 1);
  }

  try {
    const rotationId = argv.find(arg => arg.startsWith('--rotation-id='))?.slice('--rotation-id='.length);
    const written = argv.includes('--retired') || rotationId
      ? exportRetiredKeystore(dest, rotationId) : exportKeystore(dest);
    console.log(`\n  Encrypted keystore exported to: ${written}`);
    console.log('  Store it somewhere safe. Recovery requires your passphrase.\n');
  } catch (error) {
    console.error(`  Export failed: ${(error as Error).message}\n`);
    process.exit(1);
  }
}

if (isDirectCliEntry(module)) runExportKeystoreCli();
