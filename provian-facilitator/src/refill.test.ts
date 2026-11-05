import { beforeEach, describe, expect, it } from 'vitest';
import { decodeFunctionData } from 'viem';
import {
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type KeyPairSigner,
} from '@solana/kit';
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget';
import { MIN_SWAP_USDC, planRefill, planSweep, refillBase, refillSolana, validateJupiterQuote, validateJupiterTransaction, validateZeroXQuote, type RefillReport } from './refill.js';
import { MemoryStore, refillStatePatch } from './store.js';
import { FakeBaseChain, FakeSolanaChain } from './test-support/fakes.js';
import { keypairs } from './test-support/svm-tx.js';
import { erc20Abi } from './base/abi.js';
import { BASE_REVENUE_WALLET, BASE_USDC, SOLANA_REVENUE_WALLET, SOLANA_USDC_MINT, SOLANA_WSOL_MINT, ZEROX_ALLOWANCE_HOLDER, ZEROX_NATIVE_ETH } from './constants.js';

const policy = { gasFloor: 1_000n, usdcBuffer: 2_000_000n, refillMax: 5_000_000n };

describe('refill plan', () => {
  it('above the floor: no swap, sweep allowed', () => {
    expect(planRefill(1_000n, 9_000_000n, policy)).toEqual({ swap: 0n, sweepAfterSwap: true });
  });
  it('below the floor: swap bounded by refillMax', () => {
    expect(planRefill(999n, 9_000_000n, policy)).toEqual({ swap: 5_000_000n, sweepAfterSwap: true });
    expect(planRefill(999n, 3_000_000n, policy)).toEqual({ swap: 3_000_000n, sweepAfterSwap: true });
  });
  it('RED: below the floor with dust USDC: no swap, no sweep', () => {
    expect(planRefill(999n, MIN_SWAP_USDC - 1n, policy)).toEqual({ swap: 0n, sweepAfterSwap: false });
  });
  it('an operator-set minimum swaps the fee income already held (a refill provable without ~300 settlements)', () => {
    expect(planRefill(999n, 6_030n, { ...policy, minSwap: 5_000n })).toEqual({ swap: 6_030n, sweepAfterSwap: true });
    // RED: the same balance under the default $1 minimum does not swap.
    expect(planRefill(999n, 6_030n, policy)).toEqual({ swap: 0n, sweepAfterSwap: false });
    // Still bounded by the floor: above it, no swap whatever the minimum.
    expect(planRefill(1_000n, 6_030n, { ...policy, minSwap: 5_000n })).toEqual({ swap: 0n, sweepAfterSwap: true });
  });
  it('RED: a zero minimum is never honoured (it falls back to $1)', () => {
    expect(planRefill(999n, 6_030n, { ...policy, minSwap: 0n })).toEqual({ swap: 0n, sweepAfterSwap: false });
  });
  it('sweep never takes the balance below the buffer', () => {
    expect(planSweep(2_000_000n, 2_000_000n)).toBe(0n);
    expect(planSweep(1_000_000n, 2_000_000n)).toBe(0n);
    expect(planSweep(2_500_001n, 2_000_000n)).toBe(500_001n);
  });
});

describe('0x quote validation (the gas wallet signs what 0x returns)', () => {
  const good = {
    transaction: { to: ZEROX_ALLOWANCE_HOLDER, data: '0xdeadbeef', value: '0' },
    buyToken: ZEROX_NATIVE_ETH,
    sellToken: BASE_USDC,
    sellAmount: '5000000',
    minBuyAmount: '1900000000000000',
  };
  it('accepts a quote at fair value', () => {
    expect(validateZeroXQuote(good, 5_000_000n, 1_950_000_000_000_000n).minBuy).toBe(1_900_000_000_000_000n);
  });
  it('RED: another target, value, token or amount is refused', () => {
    expect(() => validateZeroXQuote({ ...good, transaction: { ...good.transaction, to: '0x1111111111111111111111111111111111111111' } }, 5_000_000n, 1n)).toThrow(/allowance holder/);
    expect(() => validateZeroXQuote({ ...good, transaction: { ...good.transaction, value: '1' } }, 5_000_000n, 1n)).toThrow(/value/);
    expect(() => validateZeroXQuote({ ...good, buyToken: BASE_USDC }, 5_000_000n, 1n)).toThrow(/wrong token/);
    expect(() => validateZeroXQuote(good, 6_000_000n, 1n)).toThrow(/wrong amount/);
  });
  it('RED: a route below 95% of oracle fair value is refused', () => {
    expect(() => validateZeroXQuote(good, 5_000_000n, 2_100_000_000_000_000n)).toThrow(/fair value/);
  });
});

describe('Base refill', () => {
  let chain: FakeBaseChain;
  const quoteJson = (sellAmount: string) => ({
    transaction: { to: ZEROX_ALLOWANCE_HOLDER, data: '0xabcdef', value: '0' },
    buyToken: ZEROX_NATIVE_ETH,
    sellToken: BASE_USDC,
    sellAmount,
    minBuyAmount: '1840000000000000', // ~$4.97 at $2,700 for $5
  });
  const fetchQuote = (calls: string[]) =>
    (async (url: string) => {
      calls.push(url);
      const sellAmount = new URL(url).searchParams.get('sellAmount') ?? '0';
      return new Response(JSON.stringify(quoteJson(sellAmount)), { status: 200 });
    }) as unknown as typeof fetch;

  beforeEach(() => {
    chain = new FakeBaseChain();
  });

  it('gas below floor: exact approval of the pinned spender, then the swap, then a bounded sweep', async () => {
    chain.native = 500n;
    chain.balances.set(chain.key(BASE_USDC, chain.operator), 9_000_000n);
    chain.nativeBalance = async () => (chain.raw.length >= 2 ? 10n ** 16n : 500n);
    chain.balanceOf = async () => (chain.raw.length >= 2 ? 4_000_000n : 9_000_000n);
    const calls: string[] = [];
    const r = await refillBase({ chain, policy, zeroxApiKey: 'k', fetch: fetchQuote(calls) });
    expect(r.error).toBeNull();
    expect(r.swapped_usdc).toBe('5000000');
    const approve = decodeFunctionData({ abi: erc20Abi, data: chain.raw[0]!.data });
    expect(approve).toMatchObject({ functionName: 'approve', args: [ZEROX_ALLOWANCE_HOLDER, 5_000_000n] });
    expect(chain.raw[1]!.to.toLowerCase()).toBe(ZEROX_ALLOWANCE_HOLDER.toLowerCase());
    const sweep = decodeFunctionData({ abi: erc20Abi, data: chain.raw[2]!.data });
    expect(sweep.functionName).toBe('transfer');
    expect(String(sweep.args[0]).toLowerCase()).toBe(BASE_REVENUE_WALLET.toLowerCase());
    expect(sweep.args[1]).toBe(2_000_000n);
    expect(r.swept_usdc).toBe('2000000');
  });

  it('the swap waits until the RPC shows the approval (Base pre-confirms the approve receipt)', async () => {
    chain.native = 500n;
    chain.balances.set(chain.key(BASE_USDC, chain.operator), 9_000_000n);
    chain.approvalLagReads = 3;
    const slept: number[] = [];
    const r = await refillBase({ chain, policy, zeroxApiKey: 'k', fetch: fetchQuote([]), sleep: async (ms) => { slept.push(ms); } });
    expect(r.error).toBeNull();
    expect(r.swapped_usdc).toBe('5000000');
    expect(slept).toHaveLength(3);
    expect(chain.raw[1]!.to.toLowerCase()).toBe(ZEROX_ALLOWANCE_HOLDER.toLowerCase());
  });

  it('RED: an approval the RPC never shows sends no swap', async () => {
    chain.native = 500n;
    chain.balances.set(chain.key(BASE_USDC, chain.operator), 9_000_000n);
    chain.approvalLagReads = 1_000;
    const r = await refillBase({ chain, policy, zeroxApiKey: 'k', fetch: fetchQuote([]), sleep: async () => undefined });
    expect(r.error).toMatch(/approval not visible/);
    expect(r.swap_tx).toBeNull();
    expect(chain.raw).toHaveLength(1); // the approve only
  });

  it('gas above floor: no swap, sweep only above the buffer', async () => {
    chain.balances.set(chain.key(BASE_USDC, chain.operator), 2_300_000n);
    const r = await refillBase({ chain, policy, zeroxApiKey: 'k', fetch: fetchQuote([]) });
    expect(r.swap_tx).toBeNull();
    expect(r.swept_usdc).toBe('300000');
    expect(chain.raw).toHaveLength(1);
  });

  it('RED: a failed swap holds the sweep (USDC stays for the next refill)', async () => {
    chain.native = 500n;
    chain.balances.set(chain.key(BASE_USDC, chain.operator), 9_000_000n);
    const r = await refillBase({ chain, policy, zeroxApiKey: null, fetch: fetchQuote([]) });
    expect(r.error).toMatch(/ZEROX_API_KEY/);
    expect(r.skipped).toContain('sweep held: gas still below floor');
    expect(chain.raw).toHaveLength(0);
  });
});

describe('Solana refill', () => {
  let wallet: KeyPairSigner;
  let stranger: KeyPairSigner;
  beforeEach(async () => {
    [wallet, stranger] = (await keypairs(2)) as [KeyPairSigner, KeyPairSigner];
  });

  function txWith(feePayer: string, program: string): string {
    const msg = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(address(feePayer), m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash('11111111111111111111111111111111'), lastValidBlockHeight: 1n }, m),
      (m) =>
        appendTransactionMessageInstructions(
          [getSetComputeUnitLimitInstruction({ units: 100_000 }), { programAddress: address(program), data: new Uint8Array([1]), accounts: [] }],
          m,
        ),
    );
    return getBase64EncodedWireTransaction(compileTransaction(msg));
  }

  it('accepts a Jupiter transaction paid by the gas wallet', () => {
    expect(() => validateJupiterTransaction(txWith(wallet.address, 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'), wallet.address)).not.toThrow();
  });
  it('RED: a transaction calling the System program (could move SOL) is refused', () => {
    expect(() => validateJupiterTransaction(txWith(wallet.address, '11111111111111111111111111111111'), wallet.address)).toThrow(/allowlist/);
  });
  it('RED: a transaction paid by someone else is refused', () => {
    expect(() => validateJupiterTransaction(txWith(stranger.address, 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'), wallet.address)).toThrow(/fee payer/);
  });
  it('RED: a Jupiter quote for the wrong pair, amount, or below fair value is refused', () => {
    const q = { inputMint: SOLANA_USDC_MINT, outputMint: SOLANA_WSOL_MINT, inAmount: '5000000', otherAmountThreshold: '40000000' };
    expect(() => validateJupiterQuote(q, 5_000_000n, 41_000_000n)).not.toThrow();
    expect(() => validateJupiterQuote({ ...q, outputMint: SOLANA_USDC_MINT }, 5_000_000n, 1n)).toThrow(/pair/);
    expect(() => validateJupiterQuote(q, 4_000_000n, 1n)).toThrow(/amount/);
    expect(() => validateJupiterQuote(q, 5_000_000n, 50_000_000n)).toThrow(/fair value/);
  });

  it('sweep: only above the buffer, only to the pinned revenue wallet, only when gas is above floor', async () => {
    const chain = new FakeSolanaChain(wallet.address, wallet);
    chain.usdc = 3_500_000n;
    const r = await refillSolana({ chain, policy: { ...policy, gasFloor: 1n }, jupiterApiKey: null, priceMaxAgeSeconds: 120, fetch: fetch });
    expect(chain.sweeps).toEqual([{ to: SOLANA_REVENUE_WALLET, amount: 1_500_000n }]);
    expect(r.swept_usdc).toBe('1500000');
    const held = new FakeSolanaChain(wallet.address, wallet);
    held.balanceLamports = 0n;
    held.usdc = 500_000n; // below MIN_SWAP: no swap possible, and no sweep while gas is low
    const r2 = await refillSolana({ chain: held, policy, jupiterApiKey: null, priceMaxAgeSeconds: 120, fetch: fetch });
    expect(held.sweeps).toHaveLength(0);
    expect(r2.skipped).toContain('sweep held: gas still below floor');
  });
});

describe('refill state kept for the Command Center', () => {
  const run = (over: Partial<RefillReport>): RefillReport => ({
    chain: 'base', gas_before: '1', usdc_before: '6030', swapped_usdc: '0', swap_tx: null,
    swept_usdc: '0', sweep_tx: null, skipped: [], error: null, ...over,
  });

  it('a later run keeps the last swap and the last error; the latest run\'s own fields replace the old', async () => {
    const store = new MemoryStore();
    await store.recordRefill(run({ error: 'approval not visible on the RPC; swap not sent' }), 1);
    await store.recordRefill(run({ swapped_usdc: '6030', swap_tx: '0xswap' }), 2);
    await store.recordRefill(run({ usdc_before: '0', skipped: ['sweep held: gas still below floor'] }), 3);
    expect(store.refills.get('base')).toMatchObject({
      last_run_at_ms: 3, usdc_before: '0', error: null, skipped: ['sweep held: gas still below floor'],
      last_swap: { tx: '0xswap', usdc: '6030', at_ms: 2 },
      last_error: { error: 'approval not visible on the RPC; swap not sent', at_ms: 1 },
    });
  });

  it('RED: a run with no swap writes no last_swap', () => {
    expect(refillStatePatch(run({}), 5)).not.toHaveProperty('last_swap');
    expect(refillStatePatch(run({}), 5)).not.toHaveProperty('last_error');
  });
});
