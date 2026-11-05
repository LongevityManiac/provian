/**
 * The chain side of "paid means THIS authorization moved the fee" (PE Archive human-path run,
 * 2026-10-07; fourth review). Shared by the PE Archive and the $1 payout.
 *
 * Fixtures are Atlas's real archive payment on Base (ap_136c37f8…, tx 0x6500f6a1…): USDC emitted
 * AuthorizationUsed(payer, nonce) at logIndex 0x97 and the Transfer it caused at 0x98.
 */
import { describe, it, expect } from '@jest/globals';
import { ethers } from 'ethers';
import {
  authorizationPaidFee,
  FIND_CHARGE_SLACK_SECONDS,
  findChargeVia,
  type ChargeLog,
  type ChargeSearchProvider,
} from './usdc-charge-chain';
import { BASE_USDC_ADDRESS, USDC_CHARGE_EXPIRY_GRACE_SECONDS, type UsdcChargePayment } from './usdc-charge';

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const PAYER = '0x5326130a700183a9d934a3aba495d7099ced9885';
const NONCE = '0x38326498f849197a703f5156926171818b89e36af3ec2bf20e4c0a01b9d7d5da';
const TX = '0x6500f6a1aa06755023704f467e2cd861c522dd0b44e5f0dc7182a13fc07dae16';
const AUTH_USED = '0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad = (addr: string): string => ethers.zeroPadValue(addr, 32);
const word = (n: bigint): string => ethers.zeroPadValue(ethers.toBeHex(n), 32);

/** Atlas's receipt logs, verbatim from Base. */
const ATLAS_LOGS: ChargeLog[] = [
  { address: USDC, topics: [AUTH_USED, pad(PAYER), NONCE], data: '0x', index: 0x97, transactionHash: TX },
  { address: USDC, topics: [TRANSFER, pad(PAYER), '0x000000000000000000000000086e0f377af1245b8888540f39e99a42a7daf1da'], data: '0x00000000000000000000000000000000000000000000000000000000004c4b40', index: 0x98, transactionHash: TX },
];

const VALID_BEFORE = 1_790_000_300;
const paymentFor = (nonce: string, value = '5000000'): UsdcChargePayment => ({
  signature: '0x' + '00'.repeat(65),
  authorization: { from: PAYER, to: '0x086e0f377af1245b8888540f39e99a42a7daf1da', value, validAfter: '0', validBefore: String(VALID_BEFORE), nonce },
}) as UsdcChargePayment;

describe('authorizationPaidFee — the Transfer must be the one THIS authorization caused', () => {
  it('Atlas\'s real receipt: the authorization paid the fee', () => {
    expect(BASE_USDC_ADDRESS).toBe(USDC);
    expect(ethers.id('AuthorizationUsed(address,bytes32)')).toBe(AUTH_USED);
    expect(authorizationPaidFee(ATLAS_LOGS, paymentFor(NONCE))).toBe(true);
  });

  it('RED: one real $5 payment in a batch does not pay for the other authorizations used beside it', () => {
    const N1 = '0x' + '11'.repeat(32);
    const N2 = '0x' + '22'.repeat(32);
    const logs: ChargeLog[] = [
      // N1 used by the payer's own self-addressed authorization: $0 to itself.
      { address: USDC, topics: [AUTH_USED, pad(PAYER), N1], data: '0x', index: 10, transactionHash: '0xb' },
      { address: USDC, topics: [TRANSFER, pad(PAYER), pad(PAYER)], data: word(0n), index: 11, transactionHash: '0xb' },
      // One real fee payment with another nonce.
      { address: USDC, topics: [AUTH_USED, pad(PAYER), N2], data: '0x', index: 12, transactionHash: '0xb' },
      { ...ATLAS_LOGS[1], index: 13, transactionHash: '0xb' },
    ];
    expect(authorizationPaidFee(logs, paymentFor(N1))).toBe(false);
    expect(authorizationPaidFee(logs, paymentFor(N2))).toBe(true);
  });

  it('RED: a fee Transfer that is not the very next log, from another contract, of another value, or another nonce is not payment', () => {
    const gap = [ATLAS_LOGS[0], { ...ATLAS_LOGS[1], index: 0x99 }];
    expect(authorizationPaidFee(gap, paymentFor(NONCE))).toBe(false);
    const fakeToken = [ATLAS_LOGS[0], { ...ATLAS_LOGS[1], address: '0x' + '99'.repeat(20) }];
    expect(authorizationPaidFee(fakeToken, paymentFor(NONCE))).toBe(false);
    const fakeUsed = [{ ...ATLAS_LOGS[0], address: '0x' + '99'.repeat(20) }, ATLAS_LOGS[1]];
    expect(authorizationPaidFee(fakeUsed, paymentFor(NONCE))).toBe(false);
    expect(authorizationPaidFee(ATLAS_LOGS, paymentFor(NONCE, '1000000'))).toBe(false);
    expect(authorizationPaidFee(ATLAS_LOGS, paymentFor('0x' + '33'.repeat(32)))).toBe(false);
    expect(authorizationPaidFee([ATLAS_LOGS[1]], paymentFor(NONCE))).toBe(false);
  });
});

/** A fake Base that really filters logs by address, topics and block range. */
function fakeBase(opts: { timestampAt?: (height: number) => number; head: number; headTs: number; landing?: { block: number; logs: ChargeLog[]; status?: number } }) {
  const calls: { fromBlock: number; toBlock: number; topics: (string | null)[]; address: string }[] = [];
  const provider: ChargeSearchProvider = {
    async getBlock(tag) { const number = tag === 'latest' ? opts.head : tag; return { number, timestamp: opts.timestampAt ? opts.timestampAt(number) : opts.headTs - (opts.head - number) * 2 }; },
    async getLogs(filter) {
      calls.push(filter);
      const l = opts.landing;
      if (l === undefined || l.block < filter.fromBlock || l.block > filter.toBlock) return [];
      return l.logs.filter((log) => log.address.toLowerCase() === filter.address.toLowerCase()
        && filter.topics.every((t, i) => t === null || log.topics[i]?.toLowerCase() === t.toLowerCase()));
    },
    async getTransactionReceipt(hash) {
      const l = opts.landing;
      return l !== undefined && l.logs.some((x) => x.transactionHash === hash) ? { status: l.status ?? 1, logs: l.logs } : null;
    },
  };
  return { provider, calls };
}

describe('findChargeVia — the search window and chain-time closing', () => {
  const BASE_BLOCK_SECONDS = 2; // Legacy-chain fixture only; production searches actual timestamps.
  const FIND_CHARGE_SLACK_BLOCKS = FIND_CHARGE_SLACK_SECONDS / BASE_BLOCK_SECONDS;
  const CREATED_BLOCK = 50_000_000;
  // The request was made at VALID_BEFORE - 300; Base's 2 s blocks put validBefore 150 blocks later.
  const VB_BLOCK = CREATED_BLOCK + 300 / BASE_BLOCK_SECONDS;
  const since = { block: CREATED_BLOCK, ms: (VALID_BEFORE - 300) * 1000 };
  const headAt = (ts: number) => ({ head: VB_BLOCK + (ts - VALID_BEFORE) / BASE_BLOCK_SECONDS, headTs: ts });

  it('searches USDC AuthorizationUsed(payer, nonce) from the recorded block to the block at validBefore, with slack', async () => {
    const { provider, calls } = fakeBase({ ...headAt(VALID_BEFORE + 600) });
    await findChargeVia(provider, paymentFor(NONCE), since);
    expect(calls).toEqual([{
      address: USDC,
      topics: [AUTH_USED, pad(PAYER), NONCE],
      fromBlock: CREATED_BLOCK - FIND_CHARGE_SLACK_BLOCKS,
      toBlock: VB_BLOCK + FIND_CHARGE_SLACK_BLOCKS,
    }]);
  });

  it('finds a charge landing in the creation block and one in the last block before validBefore (RED: the edges are inside)', async () => {
    for (const block of [CREATED_BLOCK, VB_BLOCK - 1, CREATED_BLOCK - FIND_CHARGE_SLACK_BLOCKS]) {
      const { provider } = fakeBase({ ...headAt(VALID_BEFORE + 600), landing: { block, logs: ATLAS_LOGS } });
      expect(await findChargeVia(provider, paymentFor(NONCE), since)).toEqual({ txHash: TX, windowClosed: true });
    }
  });

  it('pages the search under the 500-block getLogs cap and still finds a landing in a later page (2026-10-17)', async () => {
    // A recorded block 300 blocks before the request time widens the window past one page.
    const wide = { block: CREATED_BLOCK - 500, ms: since.ms };
    const { provider, calls } = fakeBase({ ...headAt(VALID_BEFORE + 600), landing: { block: VB_BLOCK - 1, logs: ATLAS_LOGS } });
    expect(await findChargeVia(provider, paymentFor(NONCE), wide)).toEqual({ txHash: TX, windowClosed: true });
    expect(calls.length).toBeGreaterThan(1);
    // The provider cap itself (500), not the module's page constant: the control stays behavioral.
    for (const c of calls) expect(c.toBlock - c.fromBlock + 1).toBeLessThanOrEqual(500);
    expect(calls[0].fromBlock).toBe(CREATED_BLOCK - 500);
    expect(calls[calls.length - 1].toBlock).toBe(VB_BLOCK + FIND_CHARGE_SLACK_BLOCKS);
    // Contiguous pages: nothing between them is skipped.
    for (let i = 1; i < calls.length; i += 1) expect(calls[i].fromBlock).toBe(calls[i - 1].toBlock + 1);
  });

  it('a request without a recorded block searches actual timestamps', async () => {
    const { provider, calls } = fakeBase({ ...headAt(VALID_BEFORE + 600), landing: { block: CREATED_BLOCK, logs: ATLAS_LOGS } });
    expect((await findChargeVia(provider, paymentFor(NONCE), { block: null, ms: since.ms })).txHash).toBe(TX);
    expect(calls[0].fromBlock).toBe(CREATED_BLOCK - FIND_CHARGE_SLACK_BLOCKS);
  });

  it('RED: a reverted transaction, or one where the authorization did not pay the fee, is not found', async () => {
    const reverted = fakeBase({ ...headAt(VALID_BEFORE + 600), landing: { block: CREATED_BLOCK + 3, logs: ATLAS_LOGS, status: 0 } });
    expect((await findChargeVia(reverted.provider, paymentFor(NONCE), since)).txHash).toBeNull();
    const selfPaid = fakeBase({ ...headAt(VALID_BEFORE + 600), landing: { block: CREATED_BLOCK + 3, logs: [ATLAS_LOGS[0], { ...ATLAS_LOGS[1], topics: [TRANSFER, pad(PAYER), pad(PAYER)] }] } });
    expect((await findChargeVia(selfPaid.provider, paymentFor(NONCE), since)).txHash).toBeNull();
  });

  it('closes only by CHAIN time: a head short of validBefore + grace stays open however late the relay\'s clock is (RED)', async () => {
    const open = fakeBase({ ...headAt(VALID_BEFORE + USDC_CHARGE_EXPIRY_GRACE_SECONDS - 2) });
    expect(await findChargeVia(open.provider, paymentFor(NONCE), since)).toEqual({ txHash: null, windowClosed: false });
    const closed = fakeBase({ ...headAt(VALID_BEFORE + USDC_CHARGE_EXPIRY_GRACE_SECONDS) });
    expect(await findChargeVia(closed.provider, paymentFor(NONCE), since)).toEqual({ txHash: null, windowClosed: true });
  });

  it('RED: an unreadable head or receipt throws (the caller keeps the charge pending)', async () => {
    const noHead: ChargeSearchProvider = { ...fakeBase(headAt(VALID_BEFORE)).provider, getBlock: async () => null };
    await expect(findChargeVia(noHead, paymentFor(NONCE), since)).rejects.toThrow('usdc_charge_head_unavailable');
    const lost = fakeBase({ ...headAt(VALID_BEFORE + 600), landing: { block: CREATED_BLOCK, logs: ATLAS_LOGS } });
    const noReceipt: ChargeSearchProvider = { ...lost.provider, getTransactionReceipt: async () => null };
    await expect(findChargeVia(noReceipt, paymentFor(NONCE), since)).rejects.toThrow('usdc_charge_receipt_unavailable');
  });
});


describe('charge recovery across a canonical block cadence change', () => {
  it.each([null, 985])('finds the last valid payment after the switch, stored start=%s', async storedBlock => {
    const switchBlock = 1000, switchTime = VALID_BEFORE - 150;
    const timestampAt = (height: number) => height <= switchBlock
      ? switchTime - (switchBlock - height) * 2 : switchTime + Math.floor((height - switchBlock) / 5);
    const landing = switchBlock + 5 * 150 - 1;
    const head = switchBlock + 5 * 750;
    const r = fakeBase({ head, headTs: timestampAt(head), timestampAt, landing: { block: landing, logs: ATLAS_LOGS } });
    const sinceMs = (switchTime - 30) * 1000;
    expect(head - Math.ceil((timestampAt(head) - sinceMs / 1000) / 2) - 150).toBeGreaterThan(landing);
    expect(await findChargeVia(r.provider, paymentFor(NONCE), { block: storedBlock, ms: sinceMs })).toEqual({ txHash: TX, windowClosed: true });
    expect(r.calls.some(c => c.fromBlock <= landing && c.toBlock >= landing)).toBe(true);
    expect(r.calls.every(c => c.toBlock - c.fromBlock < 500)).toBe(true);
  });
});
