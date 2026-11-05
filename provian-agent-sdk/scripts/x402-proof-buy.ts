/**
 * live proof — the BUYER leg: pay one x402 resource from an agent keystore through the
 * SDK's own x402 fetch (EIP-3009, signed locally), and print the seller's answer and settlement.
 *
 * tsx scripts/x402-proof-buy.ts --keystore <sdk keystore> --passphrase-file <file> --url <https url> [--max-usdc 0.02]
 *
 * This MOVES USDC from the keystore's wallet (at most --max-usdc). The key is decrypted in-process and
 * never printed or passed as an argument.
 */
import { readFileSync } from 'fs';
import { ProvianClient } from '../src/ProvianClient';
import { loadKeystore, withDecryptedKey } from '../src/keystore';
import { deriveAddressFromPrivateKey } from '../src/wallet';

const arg = (n: string): string | undefined => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const need = (n: string): string => { const v = arg(n); if (!v) throw new Error(`--${n} is required`); return v; };

async function main(): Promise<void> {
  const url = need('url');
  if (!url.startsWith('https://')) throw new Error('--url must be https');
  const maxAtomic = BigInt(Math.round(Number(arg('max-usdc') ?? '0.02') * 1e6));
  if (maxAtomic <= 0n || maxAtomic > 100_000n) throw new Error('--max-usdc must be > 0 and at most 0.10');
  const ks = loadKeystore(need('keystore'));
  if (!ks) throw new Error('keystore unreadable');
  const pass = readFileSync(need('passphrase-file'), 'utf8').trim();
  const client = new ProvianClient({ relayUrl: 'https://api.provian.ai' } as never);
  await withDecryptedKey(ks, pass, async (key: { privateKey: string }) => {
    const address = deriveAddressFromPrivateKey(key.privateKey);
    const paid = client.wrapFetchWithX402({ privateKeyHex: key.privateKey, address }, { maxAmountAtomic: maxAtomic });
    console.log(`buyer ${address} → ${url} (ceiling ${maxAtomic} atomic USDC)`);
    const res = await paid(url);
    const receipt = res.headers.get('payment-response');
    console.log(`status ${res.status}`);
    console.log((await res.text()).trim());
    if (receipt) console.log('settlement', Buffer.from(receipt, 'base64').toString('utf8'));
  });
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
