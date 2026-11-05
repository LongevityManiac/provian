import { beforeEach, describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, getAddress, type Hex } from 'viem';
import { BaseFacilitator } from './facilitator.js';
import { settlerAbi } from './abi.js';
import type { SettleCall } from './chain.js';
import { MemoryStore } from '../store.js';
import { FakeBaseChain, recordingWitness, seller, noFetch } from '../test-support/fakes.js';
import { BASE_PVT, BASE_USDC, X402_EXACT_PERMIT2_PROXY } from '../constants.js';
import type { Payload, Requirements } from '../x402-types.js';
import { retryPendingWitness } from '../witness.js';

const BUYER = getAddress('0x1000000000000000000000000000000000000001');
const SELLER = getAddress('0x2000000000000000000000000000000000000002');
const NONCE = `0x${'ab'.repeat(32)}` as Hex;

function req(overrides: Partial<Requirements> = {}): Requirements {
  return {
    scheme: 'exact',
    network: 'eip155:8453',
    asset: BASE_USDC,
    amount: '1000000',
    payTo: SELLER,
    maxTimeoutSeconds: 60,
    extra: { name: 'USD Coin', version: '2' },
    ...overrides,
  };
}

function eip3009Payload(r: Requirements = req(), opts: { from?: string; to?: string; nonce?: string; extensions?: Record<string, unknown> } = {}): Payload {
  return {
    x402Version: 2,
    accepted: r,
    payload: {
      signature: `0x${'11'.repeat(65)}`,
      authorization: {
        from: opts.from ?? BUYER,
        to: opts.to ?? SELLER,
        value: r.amount,
        validAfter: '0',
        validBefore: String(Math.floor(Date.now() / 1000) + 600),
        nonce: opts.nonce ?? NONCE,
      },
    },
    ...(opts.extensions ? { extensions: opts.extensions } : {}),
  };
}

function permit2Payload(r: Requirements, opts: { spender?: string } = {}): Payload {
  return {
    x402Version: 2,
    accepted: r,
    payload: {
      signature: `0x${'22'.repeat(65)}`,
      permit2Authorization: {
        from: BUYER,
        permitted: { token: r.asset, amount: r.amount },
        spender: opts.spender ?? X402_EXACT_PERMIT2_PROXY,
        nonce: '77',
        deadline: String(Math.floor(Date.now() / 1000) + 600),
        witness: { to: SELLER, validAfter: '0' },
      },
    },
  };
}

/** The FeeSettled log the real settler emits for `call`. */
function feeSettledLog(chain: FakeBaseChain) {
  return (call: SettleCall) => {
    const token = call.kind === 'eip3009' ? BASE_USDC : call.token;
    const value = call.kind === 'eip3009' ? call.value : call.amount;
    return [
      {
        address: chain.settler,
        topics: encodeEventTopics({ abi: settlerAbi, eventName: 'FeeSettled', args: { buyer: call.buyer, seller: call.seller, token } }) as [Hex, ...Hex[]],
        data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [value, call.fee]),
        blockHash: null,
        blockNumber: null,
        logIndex: null,
        transactionHash: null,
        transactionIndex: null,
        removed: false,
      },
    ];
  };
}

let chain: FakeBaseChain;
let store: MemoryStore;
let witness: ReturnType<typeof recordingWitness>;
let stdValid: { isValid: boolean; invalidReason?: string };
let fac: BaseFacilitator;

function build(fetchImpl: typeof noFetch = noFetch) {
  fac = new BaseFacilitator({
    chain,
    store,
    relayUrl: 'https://relay.test',
    fetch: fetchImpl,
    witness: witness.reporter,
    priceMaxAgeSeconds: 3600,
    now: () => Date.now(),
    standardVerify: async () => stdValid,
  });
}

beforeEach(async () => {
  chain = new FakeBaseChain();
  chain.logsFor = feeSettledLog(chain);
  store = new MemoryStore();
  witness = recordingWitness();
  stdValid = { isValid: true };
  await store.upsertSeller(seller('base', SELLER, { pvt_prices: [{ resource: '/x', amount_atomic: '5000000000000000000' }] }));
  chain.allowances.set(chain.key(BASE_USDC, SELLER, chain.settler), 1_000_000n);
  build();
});

// Expected fee for the fake chain's defaults:
// gasLimit = ceil(90,000 × 1.1) = 99,000; maxFee = ceil(5e6 × 1.25) + 1e6 = 7,250,000 wei
// wei = 99,000 × 7,250,000 + 2e9 = 719,750,000,000; × $2,700 / 1e20 = 1,943.325 → 1,944; + 300 = 2,244.
const EXPECTED_FEE = 2_244n;

describe('Base verify', () => {
  it('a valid USDC payment to a registered seller verifies, quoting the fee', async () => {
    const r = await fac.verify(eip3009Payload(), req());
    expect(r).toMatchObject({ isValid: true, payer: BUYER });
    expect(r.extra).toEqual({ provianFee: { amount: EXPECTED_FEE.toString(), asset: BASE_USDC, payer: 'seller' } });
  });

  const refusals: Array<[string, () => Promise<{ payload: Payload; req: Requirements }>, string]> = [
    ['unregistered seller', async () => {
      store.sellers.clear();
      return { payload: eip3009Payload(), req: req() };
    }, 'seller_not_registered'],
    ['suspended seller', async () => {
      await store.suspendSeller(`base:${SELLER.toLowerCase()}`);
      return { payload: eip3009Payload(), req: req() };
    }, 'seller_suspended'],
    ['sponsored approval extension', async () => ({ payload: eip3009Payload(req(), { extensions: { erc20ApprovalGasSponsoring: {} } }), req: req() }), 'sponsored_approval_refused'],
    ['PVT over EIP-3009', async () => ({ payload: eip3009Payload(req({ asset: BASE_PVT })), req: req({ asset: BASE_PVT }) }), 'asset_not_supported'],
    ['unknown asset over Permit2', async () => {
      const r = req({ asset: '0x3000000000000000000000000000000000000003' });
      return { payload: permit2Payload(r), req: r };
    }, 'asset_not_supported'],
    ['wrong EIP-712 domain', async () => {
      const r = req({ extra: { name: 'USDC', version: '2' } });
      return { payload: eip3009Payload(r), req: r };
    }, 'invalid_eip712_domain'],
    ['PVT at a price the seller never registered', async () => {
      const r = req({ asset: BASE_PVT, amount: '4000000000000000000' });
      return { payload: permit2Payload(r), req: r };
    }, 'pvt_price_not_registered'],
    ['Permit2 naming another spender', async () => {
      const r = req({ asset: BASE_PVT, amount: '5000000000000000000' });
      return { payload: permit2Payload(r, { spender: '0x4000000000000000000000000000000000000004' }), req: r };
    }, 'invalid_permit2_spender'],
    ['self payment', async () => ({ payload: eip3009Payload(req(), { from: SELLER }), req: req() }), 'self_payment_refused'],
    ['the facilitator as buyer', async () => ({ payload: eip3009Payload(req(), { from: chain.operator }), req: req() }), 'facilitator_wallet_party_refused'],
    ['authorization paying someone else', async () => ({ payload: eip3009Payload(req(), { to: BUYER }), req: req() }), 'recipient_mismatch'],
    ['accepted ≠ requirements', async () => ({ payload: eip3009Payload(req({ amount: '999' })), req: req() }), 'requirements_mismatch'],
    ['presentation required but absent', async () => {
      await store.upsertSeller(seller('base', SELLER, { require_presentation: { tier: 'reputation' } }));
      store.sellers.set(`base:${SELLER.toLowerCase()}`, seller('base', SELLER, { require_presentation: { tier: 'reputation' } }));
      return { payload: eip3009Payload(), req: req() };
    }, 'presentation_required'],
    ['x402 standard verification fails', async () => {
      stdValid = { isValid: false, invalidReason: 'invalid_exact_evm_signature' };
      return { payload: eip3009Payload(), req: req() };
    }, 'invalid_exact_evm_signature'],
    ['seller has not approved the fee', async () => {
      chain.allowances.clear();
      return { payload: eip3009Payload(), req: req() };
    }, 'fee_uncollectable'],
    ['the exact settle call does not simulate', async () => {
      chain.simulateError = new Error('execution reverted');
      return { payload: eip3009Payload(), req: req() };
    }, 'fee_uncollectable'],
    ['the settle call cannot be estimated', async () => {
      chain.estimateError = new Error('execution reverted: FeeOutOfRange');
      return { payload: eip3009Payload(), req: req() };
    }, 'fee_uncollectable'],
    ['gas so high the fee exceeds the settler cap', async () => {
      chain.baseFee = 10n ** 12n;
      return { payload: eip3009Payload(), req: req() };
    }, 'fee_uncollectable'],
    ['a payment too small to carry the fee', async () => {
      const r = req({ amount: '2000' });
      return { payload: eip3009Payload(r), req: r };
    }, 'fee_uncollectable'],
    ['a stale ETH/USD price', async () => {
      chain.price = { ...chain.price, updatedAt: Math.floor(Date.now() / 1000) - 7200 };
      return { payload: eip3009Payload(), req: req() };
    }, 'fee_price_unavailable'],
    ['PVT seller whose USDC cannot cover the fee', async () => {
      const r = req({ asset: BASE_PVT, amount: '5000000000000000000' });
      return { payload: permit2Payload(r), req: r };
    }, 'fee_uncollectable'],
  ];

  for (const [name, setup, reason] of refusals) {
    it(`RED: ${name} → ${reason}, and settle broadcasts NOTHING`, async () => {
      const { payload, req: r } = await setup();
      build();
      const v = await fac.verify(payload, r);
      expect(v.isValid).toBe(false);
      expect(v.invalidReason).toBe(reason);
      const s = await fac.settle(payload, r);
      expect(s.success).toBe(false);
      expect(s.errorReason).toBe(reason);
      expect(chain.sent).toHaveLength(0);
      expect(witness.reports).toHaveLength(0);
    });
  }

  it('control: the PVT seller WITH enough USDC verifies (so the RED above is the balance, not the path)', async () => {
    chain.balances.set(chain.key(BASE_USDC, SELLER), 1_000_000n);
    const r = req({ asset: BASE_PVT, amount: '5000000000000000000' });
    const v = await fac.verify(permit2Payload(r), r);
    expect(v).toMatchObject({ isValid: true });
  });
});

describe('Base settle', () => {
  it('broadcasts ONE settler call carrying the fee, reports the witness, and is idempotent', async () => {
    const s = await fac.settle(eip3009Payload(), req());
    expect(s.errorReason).toBeUndefined();
    expect(s).toMatchObject({ success: true, network: 'eip155:8453', payer: BUYER });
    expect(chain.sent).toHaveLength(1);
    expect(chain.sent[0]!.call.fee).toBe(EXPECTED_FEE);
    expect(chain.sent[0]!.call.kind).toBe('eip3009');
    expect(witness.reports).toEqual([
      {
        chain: 'base',
        tx_hash: s.transaction,
        buyer: BUYER.toLowerCase(),
        seller: SELLER.toLowerCase(),
        asset: BASE_USDC.toLowerCase(),
        amount: '1000000',
        fee: EXPECTED_FEE.toString(),
        scheme: 'eip3009',
      },
    ]);
    const again = await fac.settle(eip3009Payload(), req());
    expect(again).toMatchObject({ success: true, transaction: s.transaction });
    // After settlement the authorization's nonce is spent, so x402 verification refuses it — still the same answer.
    stdValid = { isValid: false, invalidReason: 'invalid_exact_evm_nonce_already_used' };
    const third = await fac.settle(eip3009Payload(), req());
    expect(third).toMatchObject({ success: true, transaction: s.transaction });
    expect(chain.sent).toHaveLength(1);
    expect((await store.getSeller(`base:${SELLER.toLowerCase()}`))?.settlement_count).toBe(1);
  });

  it('PVT through Permit2: the fee is still USDC from the seller, in the same call', async () => {
    chain.balances.set(chain.key(BASE_USDC, SELLER), 1_000_000n);
    const r = req({ asset: BASE_PVT, amount: '5000000000000000000' });
    const s = await fac.settle(permit2Payload(r), r);
    expect(s.success).toBe(true);
    expect(chain.sent[0]!.call).toMatchObject({ kind: 'permit2', token: getAddress(BASE_PVT), amount: 5n * 10n ** 18n, fee: EXPECTED_FEE });
  });

  it('RED: a gas wallet that cannot pay for the transaction broadcasts nothing', async () => {
    chain.native = 1000n;
    const s = await fac.settle(eip3009Payload(), req());
    expect(s).toMatchObject({ success: false, errorReason: 'facilitator_gas_low' });
    expect(chain.sent).toHaveLength(0);
  });

  it('a settlement that reverts after broadcast strikes the seller when the SELLER can no longer pay the fee; three strikes suspend it', async () => {
    chain.receiptStatus = 'reverted';
    const sellerAllowance = chain.key(BASE_USDC, SELLER, chain.settler);
    const origSend = chain.sendSettle.bind(chain);
    // The seller withdraws its fee approval right after the broadcast (the front-run the strike is for).
    chain.sendSettle = async (...args: Parameters<typeof origSend>) => {
      const h = await origSend(...args);
      chain.allowances.set(sellerAllowance, 0n);
      return h;
    };
    for (let i = 0; i < 3; i++) {
      chain.allowances.set(sellerAllowance, 1_000_000n);
      const s = await fac.settle(eip3009Payload(req(), { nonce: `0x${String(i).padStart(64, '0')}` }), req());
      expect(s).toMatchObject({ success: false, errorReason: 'transaction_failed' });
    }
    expect((await store.getSeller(`base:${SELLER.toLowerCase()}`))?.status).toBe('suspended');
    expect(witness.reports).toHaveLength(0);
    chain.allowances.set(sellerAllowance, 1_000_000n);
    const s = await fac.settle(eip3009Payload(req(), { nonce: `0x${'99'.repeat(32)}` }), req());
    expect(s.errorReason).toBe('seller_suspended');
    expect(chain.sent).toHaveLength(3);
  });

  it('RED (2026-10-17): a revert the seller did NOT cause is no strike — three buyer-caused reverts leave the seller active', async () => {
    chain.receiptStatus = 'reverted';
    for (let i = 0; i < 3; i++) {
      const s = await fac.settle(eip3009Payload(req(), { nonce: `0x${String(i).padStart(64, '0')}` }), req());
      expect(s).toMatchObject({ success: false, errorReason: 'transaction_failed' });
    }
    const sellerRow = await store.getSeller(`base:${SELLER.toLowerCase()}`);
    expect(sellerRow?.status).not.toBe('suspended');
    expect(sellerRow?.strike_count ?? 0).toBe(0);
    const s = await fac.settle(eip3009Payload(req(), { nonce: `0x${'99'.repeat(32)}` }), req());
    expect(s.errorReason).not.toBe('seller_suspended');
    expect(chain.sent).toHaveLength(4);
  });

  it('a spent (payer, nonce) never answers ANOTHER seller\'s requirements with the first seller\'s receipt (2026-10-17)', async () => {
    const first = await fac.settle(eip3009Payload(), req());
    expect(first.success).toBe(true);
    const SELLER2 = getAddress('0x3000000000000000000000000000000000000003');
    await store.upsertSeller(seller('base', SELLER2));
    chain.allowances.set(chain.key(BASE_USDC, SELLER2, chain.settler), 1_000_000n);
    // The nonce is spent on chain, so x402 verification refuses it; the facilitator must not fall
    // back to seller A's settlement for seller B's terms.
    stdValid = { isValid: false, invalidReason: 'invalid_exact_evm_nonce_already_used' };
    const r2 = req({ payTo: SELLER2, amount: '10000000' });
    const s = await fac.settle(eip3009Payload(r2, { to: SELLER2 }), r2);
    expect(s.success).toBe(false);
    expect(s.errorReason).toBe('settlement_mismatch');
    expect(chain.sent).toHaveLength(1);
    // The same terms are still answered idempotently.
    const again = await fac.settle(eip3009Payload(), req());
    expect(again).toMatchObject({ success: true, transaction: first.transaction });
    // Same seller, a different amount: refused too.
    const r3 = req({ amount: '2000000' });
    const s3 = await fac.settle(eip3009Payload(r3), r3);
    expect(s3).toMatchObject({ success: false, errorReason: 'settlement_mismatch' });
  });

  it('a store failure before broadcast charges nobody: nothing is sent and the retry settles (2026-10-17)', async () => {
    const orig = store.updateSettlement.bind(store);
    let failOnce = true;
    store.updateSettlement = async (key, patch) => {
      if (failOnce && patch.status === 'submitted') { failOnce = false; throw new Error('UNAVAILABLE: firestore'); }
      return orig(key, patch);
    };
    const s = await fac.settle(eip3009Payload(), req());
    expect(s.success).toBe(false);
    expect(chain.sent).toHaveLength(0);
    const retry = await fac.settle(eip3009Payload(), req());
    expect(retry.success).toBe(true);
    expect(chain.sent).toHaveLength(1);
    expect(witness.reports).toHaveLength(1);
  });

  it('a hashless `submitting` record left by a dead attempt is taken over once it is stale (2026-10-17)', async () => {
    let now = Date.now();
    fac = new BaseFacilitator({ chain, store, relayUrl: 'x', fetch: noFetch, witness: witness.reporter, priceMaxAgeSeconds: 3600, now: () => now, standardVerify: async () => stdValid });
    // A dead attempt: claimed, never signed.
    const orig = store.updateSettlement.bind(store);
    store.updateSettlement = async () => { throw new Error('UNAVAILABLE'); };
    const dead = await fac.settle(eip3009Payload(), req());
    expect(dead.success).toBe(false);
    expect(chain.sent).toHaveLength(0);
    store.updateSettlement = orig;
    // Too soon: still "in progress" (another instance may be mid-sign).
    const soon = await fac.settle(eip3009Payload(), req());
    expect(soon).toMatchObject({ success: false, errorReason: 'settlement_in_progress' });
    now += 120_000;
    const later = await fac.settle(eip3009Payload(), req());
    expect(later.success).toBe(true);
    expect(chain.sent).toHaveLength(1);
  });

  it('an authorization signed with validBefore = now + 60 — a seller advertising maxTimeoutSeconds 60 — settles (RED under the 60 s floor, reviewer 2026-10-17)', async () => {
    const r = req();
    const p = eip3009Payload(r);
    (p.payload as { authorization: { validBefore: string } }).authorization.validBefore = String(Math.floor(Date.now() / 1000) + 60);
    expect(await fac.verify(p, r)).toMatchObject({ isValid: true });
    expect((await fac.settle(p, r)).success).toBe(true);
    expect(chain.sent).toHaveLength(1);
  });

  it('RED (2026-10-17): an authorization expiring within 10 s is refused before anything is broadcast', async () => {
    const r = req();
    const p = eip3009Payload(r);
    (p.payload as { authorization: { validBefore: string } }).authorization.validBefore = String(Math.floor(Date.now() / 1000) + 5);
    const v = await fac.verify(p, r);
    expect(v).toMatchObject({ isValid: false, invalidReason: 'authorization_expires_too_soon' });
    const s = await fac.settle(p, r);
    expect(s.success).toBe(false);
    expect(chain.sent).toHaveLength(0);
  });

  it('reconcileStaleSubmitted resolves a submitted record whose receipt wait was lost, and witnesses it (2026-10-17)', async () => {
    let now = Date.now();
    fac = new BaseFacilitator({ chain, store, relayUrl: 'x', fetch: noFetch, witness: witness.reporter, priceMaxAgeSeconds: 3600, now: () => now, standardVerify: async () => stdValid });
    const s = await fac.settle(eip3009Payload(), req());
    expect(s.success).toBe(true);
    const key = `base_eip3009_${BUYER.toLowerCase()}_${NONCE.toLowerCase()}`;
    // The instance died after broadcast: the record knows its hash, nothing else.
    await store.updateSettlement(key, { status: 'submitted', witness_status: 'pending' });
    witness.reports.length = 0;
    now += 300_000;
    const out = await fac.reconcileStaleSubmitted(120_000);
    expect(out).toEqual({ scanned: 1, resolved: 1 });
    expect((await store.getSettlement(key))?.status).toBe('confirmed');
    expect(witness.reports).toHaveLength(1);
  });

  it("reconcileStaleSubmitted closes a submitted record whose authorization expired without ever mining ", async () => {
    let now = Date.now();
    fac = new BaseFacilitator({ chain, store, relayUrl: 'x', fetch: noFetch, witness: witness.reporter, priceMaxAgeSeconds: 3600, now: () => now, standardVerify: async () => stdValid });
    expect((await fac.settle(eip3009Payload(), req())).success).toBe(true); // validBefore = now + 600
    const key = `base_eip3009_${BUYER.toLowerCase()}_${NONCE.toLowerCase()}`;
    await store.updateSettlement(key, { status: 'submitted', witness_status: 'pending' });
    chain.unmined = true; // the broadcast was rejected by the node: the hash never mines (the node knows no receipt)
    now += 300_000; // 5 min: the authorization is still live — the record stays submitted
    expect(await fac.reconcileStaleSubmitted(120_000)).toEqual({ scanned: 1, resolved: 0 });
    expect((await store.getSettlement(key))?.status).toBe('submitted');
    now += 1_500_000; // past validBefore (600 s) + the 15-minute grace: nobody can settle it any more
    expect(await fac.reconcileStaleSubmitted(120_000)).toEqual({ scanned: 1, resolved: 1 });
    expect(await store.getSettlement(key)).toMatchObject({ status: 'failed', error: 'expired_unmined', witness_status: 'not_applicable' });
    // RED control: before `expires_at_sec`, the record was re-waited on every run forever.
  });

  it('RED: a record whose receipt LOOKUP fails is never closed, however old — only "not mined" closes', async () => {
    let now = Date.now();
    fac = new BaseFacilitator({ chain, store, relayUrl: 'x', fetch: noFetch, witness: witness.reporter, priceMaxAgeSeconds: 3600, now: () => now, standardVerify: async () => stdValid });
    expect((await fac.settle(eip3009Payload(), req())).success).toBe(true);
    const key = `base_eip3009_${BUYER.toLowerCase()}_${NONCE.toLowerCase()}`;
    await store.updateSettlement(key, { status: 'submitted', witness_status: 'pending' });
    chain.receiptError = new Error('rpc down'); // the settlement may well have mined; the node cannot be asked
    now += 3_000_000; // long past validBefore + grace
    expect(await fac.reconcileStaleSubmitted(120_000)).toEqual({ scanned: 1, resolved: 0 });
    expect((await store.getSettlement(key))?.status).toBe('submitted');
    // ...and once the node answers, the mined settlement is confirmed and witnessed, never "expired".
    chain.receiptError = null;
    witness.reports.length = 0;
    expect(await fac.reconcileStaleSubmitted(120_000)).toEqual({ scanned: 1, resolved: 1 });
    expect((await store.getSettlement(key))?.status).toBe('confirmed');
    expect(witness.reports).toHaveLength(1);
  });

  it('the Base reconciler leaves Solana records alone', async () => {
    const now = Date.now();
    await store.claimSettlement({
      key: 'solana_sig1', chain: 'solana', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', seller_id: 'sol-seller',
      buyer: 'buyerpk', seller: 'sellerpk', asset: 'mint', amount: '1', fee: '1', scheme: 'svm_exact', status: 'submitted',
      tx_hash: 'sig1', error: null, witness_status: 'pending', witness_attempts: 0, created_at_ms: now - 10_000_000, updated_at_ms: now - 10_000_000,
    });
    chain.unmined = true; // a Base node knows no Solana signature
    expect(await fac.reconcileStaleSubmitted(120_000)).toEqual({ scanned: 0, resolved: 0 });
    expect((await store.getSettlement('solana_sig1'))?.status).toBe('submitted');
  });

  it('RED: a receipt without the matching FeeSettled event is not a settlement', async () => {
    chain.logsFor = () => [];
    const s = await fac.settle(eip3009Payload(), req());
    expect(s).toMatchObject({ success: false, errorReason: 'transaction_failed' });
    expect(witness.reports).toHaveLength(0);
  });

  it('a witness report that fails stays pending and is retried', async () => {
    const failing = recordingWitness(false);
    fac = new BaseFacilitator({ chain, store, relayUrl: 'x', fetch: noFetch, witness: failing.reporter, priceMaxAgeSeconds: 3600, now: () => Date.now(), standardVerify: async () => stdValid });
    const s = await fac.settle(eip3009Payload(), req());
    expect(s.success).toBe(true);
    expect([...store.settlements.values()][0]!.witness_status).toBe('pending');
    const ok = recordingWitness(true);
    expect(await retryPendingWitness(store, ok.reporter)).toEqual({ attempted: 1, reported: 1 });
    expect([...store.settlements.values()][0]!.witness_status).toBe('reported');
    expect(await retryPendingWitness(store, ok.reporter)).toEqual({ attempted: 0, reported: 0 });
  });

  it('a witness report the relay refuses (400/409/422) is final, never retried', async () => {
    const refusing = recordingWitness('refused');
    fac = new BaseFacilitator({ chain, store, relayUrl: 'x', fetch: noFetch, witness: refusing.reporter, priceMaxAgeSeconds: 3600, now: () => Date.now(), standardVerify: async () => stdValid });
    expect((await fac.settle(eip3009Payload(), req())).success).toBe(true);
    expect([...store.settlements.values()][0]!.witness_status).toBe('refused');
    expect(await retryPendingWitness(store, recordingWitness(true).reporter)).toEqual({ attempted: 0, reported: 0 });
  });

  it('presentation: a valid single-use presentation lets the payment through once', async () => {
    store.sellers.set(`base:${SELLER.toLowerCase()}`, seller('base', SELLER, { require_presentation: { tier: 'reputation' } }));
    const fetchOk = (async () =>
      new Response(JSON.stringify({ valid: true, tier: 'reputation', presentation_id: 'burn-1', presenter_address: BUYER.toLowerCase(), predicates: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof noFetch;
    build(fetchOk);
    const ext = { 'provian-presentation': { token: 'tok-'.padEnd(32, 'x'), challenge: `x402-pay:${BUYER.toLowerCase()}` } };
    const first = await fac.settle(eip3009Payload(req(), { extensions: ext }), req());
    expect(first.success).toBe(true);
    const second = await fac.settle(eip3009Payload(req(), { extensions: ext, nonce: `0x${'cd'.repeat(32)}` }), req());
    expect(second).toMatchObject({ success: false, errorReason: 'presentation_already_used' });
    expect(chain.sent).toHaveLength(1);
  });

  it('RED: a buyer racing two payments at once gets one through; the other is refused before broadcast', async () => {
    const original = chain.waitReceipt.bind(chain);
    chain.waitReceipt = async (hash) => {
      await new Promise((r) => setTimeout(r, 30));
      return original(hash);
    };
    const [a, b] = await Promise.all([
      fac.settle(eip3009Payload(req(), { nonce: `0x${'01'.repeat(32)}` }), req()),
      fac.settle(eip3009Payload(req(), { nonce: `0x${'02'.repeat(32)}` }), req()),
    ]);
    const reasons = [a.errorReason, b.errorReason].sort();
    expect(reasons).toEqual(['payer_settlement_in_progress', undefined].sort());
    expect(chain.sent).toHaveLength(1);
    // Control: once the first is done the buyer can pay again.
    expect((await fac.settle(eip3009Payload(req(), { nonce: `0x${'03'.repeat(32)}` }), req())).success).toBe(true);
  });
});
