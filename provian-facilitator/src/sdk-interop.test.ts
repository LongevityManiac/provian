/**
 * Interop: a payment signed by Provian's OWN agent SDK (provian-agent-sdk/src/x402-signer-svm.ts,
 * @solana/web3.js) passes this facilitator's Solana inspection with the fee leg — and the same
 * requirement WITHOUT `extra.provianFee` (what a third-party/standard buyer sends) is refused.
 */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { inspectSvmPayment } from './solana/inspect.js';
import { SOLANA_GAS_WALLET, SOLANA_NETWORK, SOLANA_USDC_MINT } from './constants.js';

interface SdkSvm {
  signX402SvmPayment(args: {
    privateKeyHex: string;
    requirement: Record<string, unknown>;
    maxAmountAtomic: bigint;
    recentBlockhash?: string;
  }): Promise<{ transaction: string; payer: string }>;
}

const here = dirname(fileURLToPath(import.meta.url));
const sdkPath = join(here, '../../provian-agent-sdk/src/x402-signer-svm.ts');
const sdkPresent = existsSync(sdkPath) && existsSync(join(here, '../../provian-agent-sdk/node_modules/@solana/web3.js'));

describe.skipIf(!sdkPresent)('Provian SDK buyer ↔ Provian facilitator (Solana)', () => {
  const seller = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
  const requirement = (withFee: boolean) => ({
    scheme: 'exact',
    network: SOLANA_NETWORK,
    asset: SOLANA_USDC_MINT,
    amount: '250000',
    payTo: seller,
    maxTimeoutSeconds: 60,
    extra: {
      feePayer: SOLANA_GAS_WALLET,
      ...(withFee ? { provianFee: { amount: '1501', payTo: SOLANA_GAS_WALLET, asset: SOLANA_USDC_MINT } } : {}),
    },
  });

  async function sign(withFee: boolean) {
    const sdk = (await import(pathToFileURL(sdkPath).href)) as SdkSvm;
    return sdk.signX402SvmPayment({
      privateKeyHex: `0x${'42'.repeat(32)}`,
      requirement: requirement(withFee),
      maxAmountAtomic: 1_000_000n,
      recentBlockhash: '11111111111111111111111111111111',
    });
  }

  it('the SDK-signed transaction with the fee leg passes inspection', async () => {
    const signed = await sign(true);
    const r = await inspectSvmPayment({
      transactionBase64: signed.transaction,
      feePayer: SOLANA_GAS_WALLET,
      payTo: seller,
      amount: 250_000n,
      feeWallet: SOLANA_GAS_WALLET,
      feeAmount: 1_501n,
      expectedMemo: null,
    });
    expect(r).toMatchObject({ ok: true, payer: signed.payer, fee: 1_501n });
  });

  it('RED: the same payment without the fee leg (a standard x402 buyer) is refused', async () => {
    const signed = await sign(false);
    const r = await inspectSvmPayment({
      transactionBase64: signed.transaction,
      feePayer: SOLANA_GAS_WALLET,
      payTo: seller,
      amount: 250_000n,
      feeWallet: SOLANA_GAS_WALLET,
      feeAmount: 1_501n,
      expectedMemo: null,
    });
    expect(r).toMatchObject({ ok: false, reason: 'provian_fee_missing' });
  });
});
