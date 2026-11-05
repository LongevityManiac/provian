import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverMessageAddress } from 'viem';
import { createApp, type AppDeps } from './app.js';
import type { BaseFacilitator } from './base/facilitator.js';
import { MemoryStore } from './store.js';
import { noFetch, recordingWitness } from './test-support/fakes.js';
import {
  encodeOutputSignatureHeader,
  OUTPUT_SIGNATURE_HEADER,
  outputHashOfBytes,
  outputSignatureMessage,
  signOutputBytes,
} from './output-signature.js';

interface VectorCase {
  signer_kind: string;
  input: { kind: string; value: string };
  hash: string;
  message: string;
  signature: { hash: string; scheme: string; sig: string; signer: { kind: string; id: string } };
  header: string;
}
const V = JSON.parse(readFileSync(resolve(__dirname, '../../docs/audit/output-signature-vectors.json'), 'utf8')) as {
  wallet_test_private_key: `0x${string}`;
  wallet_signer: string;
  cases: VectorCase[];
};
const account = privateKeyToAccount(V.wallet_test_private_key);

describe('the facilitator signs with the relay\'s one definition (pinned vectors)', () => {
  it('every wallet vector reproduces byte for byte', async () => {
    const wallet = V.cases.filter((c) => c.signer_kind === 'wallet');
    expect(wallet.length).toBe(2); // empty-population guard
    for (const c of wallet) {
      const bytes = c.input.kind === 'text' ? new TextEncoder().encode(c.input.value) : Uint8Array.from(Buffer.from(c.input.value, 'hex'));
      expect(outputHashOfBytes(bytes)).toBe(c.hash);
      expect(outputSignatureMessage(c.hash)).toBe(c.message);
      const s = await signOutputBytes(account, bytes);
      expect(s).toEqual(c.signature);
      expect(encodeOutputSignatureHeader(s)).toBe(c.header);
    }
  });

  it('RED — a malformed hash is refused', () => {
    expect(() => outputSignatureMessage('sha256:abc')).toThrow('output_signature_bad_hash');
  });
});

function depsWith(settleResult: Record<string, unknown>, outputSigner: AppDeps['outputSigner']): AppDeps {
  const w = recordingWitness();
  const base = {
    settle: async () => settleResult,
    verify: async () => ({ isValid: true }),
  } as unknown as BaseFacilitator;
  return {
    base,
    baseChain: null,
    basePriceMaxAgeSeconds: 3600,
    solana: null,
    solanaChain: null,
    solanaPriceMaxAgeSeconds: 120,
    store: new MemoryStore(),
    verifyEvmMessage: null,
    internalSecret: null,
    quoteSecret: null,
    refill: {
      baseGasFloorWei: 1n,
      baseUsdcBuffer: 1n,
      baseRefillMaxUsdc: 1n,
      baseMinSwapUsdc: 1_000_000n,
      solanaGasFloorLamports: 1n,
      solanaUsdcBuffer: 1n,
      solanaRefillMaxUsdc: 1n,
      solanaMinSwapUsdc: 1_000_000n,
      zeroxApiKey: null,
      jupiterApiKey: null,
    },
    witness: w.reporter,
    fetch: noFetch,
    now: () => Date.now(),
    disabledReasons: { base: null, solana: 'off' },
    outputSigner,
  };
}

const REQ = { scheme: 'exact', network: 'eip155:8453', asset: '0x0', amount: '1', payTo: '0x0', maxTimeoutSeconds: 10, extra: {} };
const SETTLE_BODY = { x402Version: 2, paymentPayload: { x402Version: 2, accepted: REQ, payload: {} }, paymentRequirements: REQ };

describe('POST /settle — the receipt carries Provian-Output-Signature over its exact bytes', () => {
  it('a successful receipt is signed by the gas EOA; the header names the hash of the body served', async () => {
    const ok = { success: true, transaction: `0x${'ab'.repeat(32)}`, network: 'eip155:8453', payer: `0x${'11'.repeat(20)}` };
    const res = await request(createApp(depsWith(ok, account))).post('/settle').send(SETTLE_BODY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(ok);
    const header = res.headers[OUTPUT_SIGNATURE_HEADER.toLowerCase()];
    expect(typeof header).toBe('string');
    const sig = JSON.parse(Buffer.from(header as string, 'base64url').toString('utf8')) as VectorCase['signature'];
    expect(sig.hash).toBe(`sha256:${createHash('sha256').update(res.text, 'utf8').digest('hex')}`);
    expect(sig.signer).toEqual({ id: account.address.toLowerCase(), kind: 'wallet' });
    const recovered = await recoverMessageAddress({ message: outputSignatureMessage(sig.hash), signature: sig.sig as `0x${string}` });
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it('RED — a failed settlement is not signed, and no signer means no header', async () => {
    const failed = { success: false, errorReason: 'insufficient_funds', transaction: '', network: 'eip155:8453' };
    const r1 = await request(createApp(depsWith(failed, account))).post('/settle').send(SETTLE_BODY);
    expect(r1.body).toEqual(failed);
    expect(r1.headers[OUTPUT_SIGNATURE_HEADER.toLowerCase()]).toBeUndefined();
    const ok = { success: true, transaction: '0x1', network: 'eip155:8453' };
    const r2 = await request(createApp(depsWith(ok, null))).post('/settle').send(SETTLE_BODY);
    expect(r2.body).toEqual(ok);
    expect(r2.headers[OUTPUT_SIGNATURE_HEADER.toLowerCase()]).toBeUndefined();
  });
});
