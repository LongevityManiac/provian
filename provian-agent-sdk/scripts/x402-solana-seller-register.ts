/**
 * live proof — register an agent's own Solana address as a seller with Provian's x402
 * facilitator: ed25519 over the facilitator's canonical registration message (base58 signature),
 * signed with the agent's Solana key (derived from its keystore key, as the SDK does everywhere).
 * Signs a message only; moves no money.
 *
 * tsx scripts/x402-solana-seller-register.ts --resource <https url> [--name <display name>]
 * [--keystore <file> --passphrase-file <file>] (default: ~/.provian/agent-keystore.json + .secret)
 *
 * The key is decrypted in-process and never printed or passed as an argument.
 */
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { randomBytes } from 'crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { base58 } from '@scure/base';
import { loadKeystore, withDecryptedKey } from '../src/keystore';
import { deriveSolanaAddress, deriveSolanaEd25519Seed } from '../src/chains';
import { profileSchema, registrationMessage } from '../../provian-facilitator/src/sellers';

const FAC = 'https://provian-x402-facilitator-185909722463.us-central1.run.app';
const arg = (n: string): string | undefined => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };

async function main(): Promise<void> {
  const resource = arg('resource');
  if (!resource || !resource.startsWith('https://')) throw new Error('--resource <https url> is required');
  const ksPath = arg('keystore') ?? `${homedir()}/.provian/agent-keystore.json`;
  const passPath = arg('passphrase-file') ?? `${homedir()}/.provian/agent-keystore.secret`;
  const ks = loadKeystore(ksPath);
  if (!ks) throw new Error('keystore unreadable');
  const pass = (process.env.PROVIAN_KEYSTORE_PASSPHRASE ?? readFileSync(passPath, 'utf8')).trim();
  await withDecryptedKey(ks, pass, async (key: { privateKey: string }) => {
    const address = deriveSolanaAddress(key.privateKey);
    const profile = profileSchema.parse({
      display_name: arg('name') ?? 'Provian x402 proof seller (Solana)',
      description: 'Live proof of the Provian x402 facilitator: one $0.01 USDC resource on Solana.',
      resource_urls: [resource],
    });
    const nonce = randomBytes(12).toString('hex');
    const issued = Date.now();
    const message = registrationMessage('solana', address, profile, nonce, issued);
    const signature = base58.encode(ed25519.sign(new TextEncoder().encode(message), deriveSolanaEd25519Seed(key.privateKey)));
    const res = await fetch(`${FAC}/sellers/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chain: 'solana', address, profile, nonce, issued_at_ms: issued, signature }),
    });
    console.log(`solana seller ${address}: register ${res.status}`, JSON.stringify(await res.json()));
  });
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
