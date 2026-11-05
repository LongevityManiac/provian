/**
 * live proof — the seller wallet's one-time setup for the proof seller
 * (`proof-seller/server.mjs`): register with the facilitator (EIP-191 over the canonical message) and
 * approve the fee settler for a small USDC fee allowance from the seller's own wallet and gas.
 *
 * tsx scripts/proof-seller-setup.ts register --keystore <sdk keystore> --passphrase-file <file> --resource <https url> [--name <display name>]
 * tsx scripts/proof-seller-setup.ts approve --keystore <sdk keystore> --passphrase-file <file> [--usdc 1]
 *
 * The key is decrypted in-process from the SDK keystore and never printed or passed as an argument.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { loadKeystore, withDecryptedKey } from '../../provian-agent-sdk/src/keystore';
import { profileSchema, registrationMessage } from '../src/sellers.js';

const FAC = 'https://provian-x402-facilitator-185909722463.us-central1.run.app';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const RPC = 'https://mainnet.base.org';

const arg = (n: string): string | undefined => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const need = (n: string): string => { const v = arg(n); if (!v) throw new Error(`--${n} is required`); return v; };

async function withAccount<T>(fn: (acct: ReturnType<typeof privateKeyToAccount>) => Promise<T>): Promise<T> {
  const ks = loadKeystore(need('keystore'));
  if (!ks) throw new Error('keystore unreadable');
  const pass = readFileSync(need('passphrase-file'), 'utf8').trim();
  return withDecryptedKey(ks, pass, (key: { privateKey: string }) => {
    const hex = key.privateKey.startsWith('0x') ? key.privateKey : `0x${key.privateKey}`;
    return fn(privateKeyToAccount(hex as `0x${string}`));
  });
}

async function register(): Promise<void> {
  const settler = (await (await fetch(`${FAC}/supported`)).json()) as { kinds: { network: string; extra?: { provianFee?: { settler?: string } } }[] };
  console.log('facilitator settler', settler.kinds.find((k) => k.network === 'eip155:8453')?.extra?.provianFee?.settler);
  await withAccount(async (acct) => {
    const profile = profileSchema.parse({
      display_name: arg('name') ?? 'Provian x402 proof seller',
      description: 'Live proof of the Provian x402 facilitator: one $0.01 USDC resource on Base.',
      resource_urls: [need('resource')],
    });
    const nonce = randomBytes(12).toString('hex');
    const issued = Date.now();
    const signature = await acct.signMessage({ message: registrationMessage('base', acct.address, profile, nonce, issued) });
    const res = await fetch(`${FAC}/sellers/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chain: 'base', address: acct.address, profile, nonce, issued_at_ms: issued, signature }),
    });
    console.log(`register ${res.status}`, JSON.stringify(await res.json()));
  });
}

async function approve(): Promise<void> {
  const supported = (await (await fetch(`${FAC}/supported`)).json()) as { kinds: { network: string; extra?: { provianFee?: { settler?: string } } }[] };
  const settler = supported.kinds.find((k) => k.network === 'eip155:8453')?.extra?.provianFee?.settler as `0x${string}` | undefined;
  if (!settler) throw new Error('facilitator names no Base settler');
  const amount = BigInt(Math.round(Number(arg('usdc') ?? '1') * 1e6));
  if (amount <= 0n || amount > 5_000_000n) throw new Error('fee allowance must be > 0 and at most 5 USDC');
  await withAccount(async (acct) => {
    const pub = createPublicClient({ chain: base, transport: http(RPC) });
    const wallet = createWalletClient({ account: acct, chain: base, transport: http(RPC) });
    const abi = parseAbi(['function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)']);
    const before = await pub.readContract({ address: USDC, abi, functionName: 'allowance', args: [acct.address, settler] });
    console.log(`seller ${acct.address} settler ${settler} allowance before ${before}`);
    const hash = await wallet.writeContract({ address: USDC, abi, functionName: 'approve', args: [settler, amount] });
    const receipt = await pub.waitForTransactionReceipt({ hash, confirmations: 2 });
    const after = await pub.readContract({ address: USDC, abi, functionName: 'allowance', args: [acct.address, settler] });
    console.log(`approve tx ${hash} status ${receipt.status} allowance after ${after}`);
  });
}

const cmd = process.argv[2];
(cmd === 'register' ? register() : cmd === 'approve' ? approve() : Promise.reject(new Error('usage: register | approve')))
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
