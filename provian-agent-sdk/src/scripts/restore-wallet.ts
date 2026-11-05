/**
 * restore-wallet — rebuild the local keystore from a phone-recovered key.
 *
 * PREFERRED (interactive,): the Provian app's RecoverAgent screen emits a
 * command that carries NO key:
 *
 * PROVIAN_WALLET_ID=<wallet_id> … restore-wallet
 *
 * It runs and PROMPTS for the key with echo OFF; you paste the key (shown
 * separately, masked, on the phone) into that hidden prompt. The key never appears
 * on screen, on the clipboard-as-command, or in the shell history file.
 *
 * AUTOMATION (--from-stdin): for scripted restores the key may be piped in:
 *
 * PROVIAN_WALLET_ID=<wallet_id> … restore-wallet --from-stdin <<'PROVIAN_RESTORE'
 * <64-hex-key>
 * PROVIAN_RESTORE
 *
 * Either way this process turns the key into local keystore ciphertext and prints
 * plain sentences. Nothing is sent anywhere.
 */

import { restoreWalletFromStdin, restoreWalletInteractive } from '../restore-wallet-flow';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const walletId = process.env.PROVIAN_WALLET_ID ?? '';
  try {
    // --from-stdin is the automation path (key piped in, no interactive history).
    // Absent it, prompt interactively with echo off — the key never rides the
    // pasted command, so it stays out of the clipboard-as-command and shell history.
    if (args.includes('--from-stdin')) {
      await restoreWalletFromStdin(walletId);
    } else {
      await restoreWalletInteractive(walletId);
    }
    process.exit(0);
  } catch (err) {
    console.error(`  ${err instanceof Error ? err.message : 'Wallet restore could not finish.'}`);
    process.exit(1);
  }
}

void main();
