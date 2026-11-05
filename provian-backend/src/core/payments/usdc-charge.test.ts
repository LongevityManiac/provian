/**
 * The shared USDC charge path never calls a charge failed while it could still land (PE Archive
 * human-path run, 2026-10-07; second review, defect 1). Shared by the PE Archive and the $1
 * on-demand payout.
 *
 * A submit that throws may have been broadcast (ethers resolves sendRawTransaction alongside a
 * block-number read; a lost reply looks the same) and the transaction can sit in the mempool while
 * USDC still reads the authorization as unused. "Not charged" is said only when this request
 * broadcast nothing, or once the authorization has expired unused.
 */
import { describe, it, expect } from '@jest/globals';
import { Wallet } from 'ethers';
import { signedPaymentHeader } from '../payout/payout-test-fixtures';
import {
  chargeStatusNow,
  checkUsdcChargePayment,
  submitUsdcCharge,
  USDC_CHARGE_MAX_REMAINING_VALIDITY_SECONDS,
  type UsdcChargeChain,
  type UsdcChargePayment,
  type UsdcChargeRuntime,
} from './usdc-charge';

const VALID_BEFORE = 1_800_000_000;
const payment = {
  authorization: { from: '0x' + '11'.repeat(20), to: '0x' + '22'.repeat(20), value: '5000000', validAfter: '0', validBefore: String(VALID_BEFORE), nonce: '0x' + 'ab'.repeat(32) },
} as unknown as UsdcChargePayment;

function runtime(opts: {
  submit?: () => Promise<string>;
  used?: () => Promise<boolean>;
  receipt?: () => Promise<'confirmed' | 'reverted' | 'pending'>;
  found?: () => Promise<string | null>;
  closed?: boolean;
  lease?: 'busy';
  nowS?: number;
}): UsdcChargeRuntime {
  const chain = {
    gasAddress: '0x' + '35'.repeat(20),
    authorizationUsed: opts.used ?? (async () => false),
    usdcBalance: async () => 0n,
    gasBalanceWei: async () => 0n,
    gasPriceWei: async () => 0n,
    l1FeeUpperBoundWei: async () => 0n,
    submitCharge: opts.submit ?? (async () => '0x' + '01'.repeat(32)),
    confirmCharge: opts.receipt ?? (async () => 'pending'),
    headBlock: async () => 1000,
    findCharge: async () => {
      const txHash = opts.found ? await opts.found() : null;
      return { txHash, windowClosed: opts.closed ?? false };
    },
  } as UsdcChargeChain;
  return {
    chain,
    withGasKeyLease: async <T>(fn: () => Promise<T>) => (opts.lease === 'busy' ? 'lease_busy' as const : fn()),
    now: () => (opts.nowS ?? VALID_BEFORE - 200) * 1000,
    sleep: async () => undefined,
  };
}

describe('submitUsdcCharge', () => {
  it('RED: a submit that throws is never "not charged", even with the authorization still reading unused', async () => {
    const out = await submitUsdcCharge(runtime({ submit: async () => { throw new Error('getBlockNumber timeout'); }, used: async () => false }), payment);
    expect(out).toEqual({ kind: 'not_submitted', mayBeCharged: true, reason: 'getBlockNumber timeout' });
  });

  it('a busy lease (nothing broadcast) with the authorization unused is "not charged"', async () => {
    expect(await submitUsdcCharge(runtime({ lease: 'busy', used: async () => false }), payment))
      .toEqual({ kind: 'not_submitted', mayBeCharged: false, reason: 'gas_key_busy' });
  });

  it('RED: a busy lease with the authorization used or unreadable may be charged', async () => {
    expect(await submitUsdcCharge(runtime({ lease: 'busy', used: async () => true }), payment)).toMatchObject({ mayBeCharged: true });
    const unreadable = await submitUsdcCharge(runtime({ lease: 'busy', used: async () => { throw new Error('rpc'); } }), payment);
    expect(unreadable).toMatchObject({ mayBeCharged: true });
  });

  it('a clean submit returns its hash', async () => {
    expect(await submitUsdcCharge(runtime({}), payment)).toEqual({ kind: 'submitted', txHash: '0x' + '01'.repeat(32) });
  });
});

describe('chargeStatusNow — paid means this authorization moved the fee', () => {
  const at = { txHash: null, payment, since: { block: 1000, ms: (VALID_BEFORE - 300) * 1000 } };
  const PAID = '0x' + 'fe'.repeat(32);

  it('our receipt showing the fee → confirmed with that hash', async () => {
    expect(await chargeStatusNow(runtime({ receipt: async () => 'confirmed' }), { ...at, txHash: '0xaa' })).toEqual({ status: 'confirmed', txHash: '0xaa' });
  });

  it('any transaction in which this authorization moved the fee → confirmed with ITS hash (a third party\'s submission counts)', async () => {
    expect(await chargeStatusNow(runtime({ found: async () => PAID }), at)).toEqual({ status: 'confirmed', txHash: PAID });
    expect(await chargeStatusNow(runtime({ receipt: async () => 'reverted', found: async () => PAID }), { ...at, txHash: '0xaa' })).toEqual({ status: 'confirmed', txHash: PAID });
  });

  it('RED: a used authorization with no fee (cancelAuthorization / nonce reused) is NEVER confirmed; it fails once the chain window closes', async () => {
    expect((await chargeStatusNow(runtime({ used: async () => true }), at)).status).toBe('pending');
    expect((await chargeStatusNow(runtime({ used: async () => true, closed: true }), at)).status).toBe('reverted');
  });

  it('RED: a reverted receipt is not the end while the window is open (the signature is public)', async () => {
    expect((await chargeStatusNow(runtime({ receipt: async () => 'reverted' }), { ...at, txHash: '0xaa' })).status).toBe('pending');
    expect((await chargeStatusNow(runtime({ receipt: async () => 'reverted', closed: true }), { ...at, txHash: '0xaa' })).status).toBe('reverted');
  });

  it('RED: the relay\'s clock never closes a charge — only the chain search does', async () => {
    expect((await chargeStatusNow(runtime({ nowS: VALID_BEFORE + 86_400 }), at)).status).toBe('pending');
  });

  it('RED: an unreadable chain is pending, never reverted', async () => {
    expect((await chargeStatusNow(runtime({ found: async () => { throw new Error('rpc'); }, closed: true }), at)).status).toBe('pending');
  });
});

describe('checkUsdcChargePayment — the authorization window is bounded', () => {
  const payer = Wallet.createRandom();
  const now = 1_800_000_000;

  it('the clients\' now + 300 is accepted; the bound itself is accepted', async () => {
    expect(checkUsdcChargePayment(await signedPaymentHeader(payer, now), now, 1_000_000n).ok).toBe(true);
    const edge = await signedPaymentHeader(payer, now, { validBefore: String(now + USDC_CHARGE_MAX_REMAINING_VALIDITY_SECONDS) });
    expect(checkUsdcChargePayment(edge, now, 1_000_000n).ok).toBe(true);
  });

  it('RED: an authorization valid for longer is refused before anything is recorded (count > 0)', async () => {
    const tooLong = [now + USDC_CHARGE_MAX_REMAINING_VALIDITY_SECONDS + 1, now + 86_400, 10 ** 30];
    expect(tooLong.length).toBeGreaterThan(0);
    for (const vb of tooLong) {
      const header = await signedPaymentHeader(payer, now, { validBefore: BigInt(vb).toString() });
      expect(checkUsdcChargePayment(header, now, 1_000_000n)).toEqual({ ok: false, reason: 'payment_expires_too_late' });
    }
  });
});
