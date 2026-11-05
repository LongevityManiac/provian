/** Rotate with a durable encrypted journal; reruns resume the same rotation.
 * --new-rotation explicitly starts a subsequent rotation. Retired keys remain
 * available for all EVM and Solana assets, regardless of the PVT sweep result.
 */

import { runRotateKeyFlow } from '../rotate-key-flow';

async function main(): Promise<void> {
  const relayUrl = process.env.PROVIAN_RELAY_URL ?? 'https://api.provian.ai';
  const walletId = process.env.PROVIAN_WALLET_ID?.trim() || undefined;
  try {
    await runRotateKeyFlow({ relayUrl, walletId, newRotation: process.argv.includes('--new-rotation') });
    process.exit(0);
  } catch (err) {
    console.error(`  ${err instanceof Error ? err.message : 'Key rotation could not finish.'}`);
    process.exit(1);
  }
}

void main();
