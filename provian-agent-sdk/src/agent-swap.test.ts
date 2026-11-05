/**
 * the agent's own swap: the relay quotes, the SDK checks the unsigned 0x
 * transaction is exactly the swap asked for (the guard, ported to viem), approves exactly
 * the sell amount, signs with the agent's own key, and records through /swap/record.
 *
 * RED controls: every guard refusal fires BEFORE anything is signed (no eth_sendRawTransaction),
 * and a counterfeit Settler / unreadable registry refuses.
 */
import { describe, it, expect } from 'vitest';
import { custom, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, parseTransaction, decodeFunctionData, type Hex } from 'viem';
import {
  decodeZeroXAllowanceHolderTx,
  assertZeroXExecutionMatches,
  assertGenuineZeroXSettler,
  ZEROX_ALLOWANCE_HOLDER,
  ZEROX_DEPLOYER,
  BASE_WETH,
  BASE_CHAINLINK_ETH_USD,
  ORACLE_MAX_AGE_SECONDS,
  SwapRouteRefusedError,
  assertSwapWithinOracleBounds,
  oracleExpectedOut,
  readEthUsdPrice,
} from './zerox-swap-guard';
import { executeAgentSwap, type AgentSwapQuote } from './agent-swap';
import { TOKEN_ALLOWLIST } from './evm-allowlist';

const TEST_PRIV_KEY = '0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d';
const TEST_ADDRESS = '0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1';
const WALLET = { privateKeyHex: TEST_PRIV_KEY, address: TEST_ADDRESS };
const USDC = TOKEN_ALLOWLIST.base.USDC.address;
const SETTLER = '0x5C9bdC801a600c006c388FC032dCb27355154cC9';
const OTHER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

const AH_ABI = parseAbi(['function exec(address operator, address token, uint256 amount, address target, bytes data) payable returns (bytes)']);
const SETTLER_ABI = parseAbi(['function execute((address recipient, address buyToken, uint256 minAmountOut) slippage, bytes[] actions, bytes32 zidAndAffiliate) payable returns (bool)']);
const APPROVE_ABI = parseAbi(['function approve(address spender, uint256 amount) returns (bool)']);

function zeroXTx(o: { operator?: string; target?: string; token?: string; amount?: bigint; recipient?: string; buyToken?: string; min?: bigint } = {}): { to: string; data: Hex } {
  const inner = encodeFunctionData({
    abi: SETTLER_ABI, functionName: 'execute',
    args: [{ recipient: (o.recipient ?? TEST_ADDRESS) as Hex, buyToken: (o.buyToken ?? BASE_WETH) as Hex, minAmountOut: o.min ?? 995n }, [], `0x${'0'.repeat(64)}`],
  });
  const data = encodeFunctionData({
    abi: AH_ABI, functionName: 'exec',
    args: [(o.operator ?? SETTLER) as Hex, (o.token ?? USDC) as Hex, o.amount ?? 1_000_000n, (o.target ?? SETTLER) as Hex, inner],
  });
  return { to: ZEROX_ALLOWANCE_HOLDER, data };
}

const WANT = { sellToken: USDC, sellAmount: 1_000_000n, buyToken: BASE_WETH, recipient: TEST_ADDRESS, value: 0n, quotedBuyAmount: 1000n, slippageBps: 50 };

describe('0x allowance-holder guard (decode + match)', () => {
  it('decodes a well-formed exec → Settler.execute', () => {
    const exec = decodeZeroXAllowanceHolderTx(zeroXTx());
    expect(exec).toMatchObject({ settler: SETTLER, amount: 1_000_000n, minAmountOut: 995n });
    expect(() => assertZeroXExecutionMatches(exec, WANT)).not.toThrow();
  });

  const refusals: Array<[string, () => void, string]> = [
    ['a target other than AllowanceHolder', () => decodeZeroXAllowanceHolderTx({ ...zeroXTx(), to: OTHER }), 'ZEROX_UNKNOWN_TARGET'],
    ['calldata that is not exec', () => decodeZeroXAllowanceHolderTx({ to: ZEROX_ALLOWANCE_HOLDER, data: '0xdeadbeef' }), 'ZEROX_UNKNOWN_CALL'],
    ['operator ≠ target', () => decodeZeroXAllowanceHolderTx(zeroXTx({ operator: OTHER })), 'ZEROX_OPERATOR_MISMATCH'],
    ['no minimum out', () => decodeZeroXAllowanceHolderTx(zeroXTx({ min: 0n })), 'ZEROX_NO_MINIMUM'],
    ['a different sell token', () => assertZeroXExecutionMatches(decodeZeroXAllowanceHolderTx(zeroXTx({ token: BASE_WETH })), WANT), 'ZEROX_WRONG_SELL_TOKEN'],
    ['a different amount', () => assertZeroXExecutionMatches(decodeZeroXAllowanceHolderTx(zeroXTx({ amount: 2_000_000n })), WANT), 'ZEROX_WRONG_AMOUNT'],
    ['output paid to someone else', () => assertZeroXExecutionMatches(decodeZeroXAllowanceHolderTx(zeroXTx({ recipient: OTHER })), WANT), 'ZEROX_WRONG_RECIPIENT'],
    ['a different buy token', () => assertZeroXExecutionMatches(decodeZeroXAllowanceHolderTx(zeroXTx({ buyToken: USDC })), WANT), 'ZEROX_WRONG_BUY_TOKEN'],
    ['a minimum looser than quote − slippage', () => assertZeroXExecutionMatches(decodeZeroXAllowanceHolderTx(zeroXTx({ min: 900n })), WANT), 'ZEROX_MINIMUM_TOO_LOW'],
    ['ETH riding an ERC-20 sell', () => assertZeroXExecutionMatches(decodeZeroXAllowanceHolderTx(zeroXTx()), { ...WANT, value: 1n }), 'ZEROX_WRONG_VALUE'],
  ];
  for (const [name, fn, code] of refusals) {
    it(`RED: refuses ${name}`, () => {
      try { fn(); } catch (e) {
        expect(e).toBeInstanceOf(SwapRouteRefusedError);
        expect((e as SwapRouteRefusedError).code).toBe(code);
        return;
      }
      throw new Error(`guard did not refuse ${name}`);
    });
  }
});

describe('genuine Settler (0x registry)', () => {
  const addrWord = (a: string) => encodeAbiParameters([{ type: 'address' }], [a as Hex]);
  const call = (owner: string, prev: string) => async ({ to, data }: { to: string; data: string }) => {
    expect(to).toBe(ZEROX_DEPLOYER);
    const fn = decodeFunctionData({ abi: parseAbi(['function ownerOf(uint256)', 'function prev(uint128)']), data: data as Hex }).functionName;
    return addrWord(fn === 'ownerOf' ? owner : prev);
  };
  it('accepts the current Settler, and the previous one', async () => {
    await expect(assertGenuineZeroXSettler(SETTLER, call(SETTLER, OTHER))).resolves.toBeUndefined();
    await expect(assertGenuineZeroXSettler(SETTLER, call(OTHER, SETTLER))).resolves.toBeUndefined();
  });
  it('RED: a Settler the registry does not name is counterfeit', async () => {
    await expect(assertGenuineZeroXSettler(SETTLER, call(OTHER, OTHER))).rejects.toMatchObject({ code: 'ZEROX_COUNTERFEIT_SETTLER' });
  });
  it('RED: an unreadable registry refuses (never assumed genuine)', async () => {
    await expect(assertGenuineZeroXSettler(SETTLER, async () => { throw new Error('rpc'); })).rejects.toMatchObject({ code: 'ZEROX_REGISTRY_UNAVAILABLE' });
  });
});

// The independent price ( , defect 2): ETH at $2,000 → 1 USDC buys 5e14 wei.
const NOW = 1_790_000_000n;
const ETH_USD = 2_000n * 10n ** 8n;
const FAIR_BUY = 498_750_000_000_000n; // 5e14 less Provian's 25 bps fee
const FAIR_MIN = (FAIR_BUY * 9_950n) / 10_000n; // quote less the 50 bps slippage accepted

const FEED_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)',
]);
interface FeedState { decimals?: number; answer?: bigint; updatedAt?: bigint; broken?: boolean }
function feedCall(f: FeedState = {}) {
  return async ({ to, data }: { to: string; data: string }): Promise<string> => {
    expect(to).toBe(BASE_CHAINLINK_ETH_USD);
    if (f.broken) throw new Error('rpc down');
    const fn = decodeFunctionData({ abi: FEED_ABI, data: data as Hex }).functionName;
    if (fn === 'decimals') return encodeAbiParameters([{ type: 'uint8' }], [f.decimals ?? 8]);
    const at = f.updatedAt ?? NOW - 60n;
    return encodeAbiParameters(
      [{ type: 'uint80' }, { type: 'int256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint80' }],
      [7n, f.answer ?? ETH_USD, at, at, 7n],
    );
  };
}

function mockChain(opts: { allowance?: bigint; registrySettler?: string; feed?: FeedState } = {}) {
  const raws: Hex[] = [];
  const feed = feedCall(opts.feed);
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      switch (method) {
        case 'eth_chainId': return '0x2105';
        case 'eth_getTransactionCount': return `0x${raws.length.toString(16)}`;
        case 'eth_estimateGas': return '0x30d40';
        case 'eth_maxPriorityFeePerGas': return '0x3b9aca00';
        case 'eth_gasPrice': return '0x3b9aca00';
        case 'eth_getBlockByNumber': return { number: '0x1', hash: `0x${'1'.repeat(64)}`, baseFeePerGas: '0x3b9aca00', timestamp: `0x${NOW.toString(16)}`, transactions: [] };
        case 'eth_blockNumber': return '0x1';
        case 'eth_call': {
          const [{ to, data }] = params as [{ to: string; data: Hex }];
          if (to.toLowerCase() === ZEROX_DEPLOYER.toLowerCase()) return encodeAbiParameters([{ type: 'address' }], [(opts.registrySettler ?? SETTLER) as Hex]);
          if (to.toLowerCase() === BASE_CHAINLINK_ETH_USD.toLowerCase()) return feed({ to: BASE_CHAINLINK_ETH_USD, data });
          if (to.toLowerCase() === USDC.toLowerCase() && data.startsWith('0xdd62ed3e')) return encodeAbiParameters([{ type: 'uint256' }], [opts.allowance ?? 0n]);
          throw new Error(`unexpected eth_call to ${to}`);
        }
        case 'eth_sendRawTransaction': {
          const raw = (params as Hex[])[0];
          raws.push(raw);
          return keccak256(raw);
        }
        case 'eth_getTransactionReceipt': {
          const hash = (params as string[])[0];
          return {
            transactionHash: hash, status: '0x1', blockNumber: '0x1', blockHash: `0x${'1'.repeat(64)}`, transactionIndex: '0x0',
            from: TEST_ADDRESS, to: ZEROX_ALLOWANCE_HOLDER, cumulativeGasUsed: '0x1', gasUsed: '0x1', contractAddress: null,
            logs: [], logsBloom: `0x${'0'.repeat(512)}`, type: '0x2', effectiveGasPrice: '0x3b9aca00',
          };
        }
        default: throw new Error(`mock transport: unexpected RPC method ${method}`);
      }
    },
  });
  return { transport, raws };
}

function quoteOf(over: Partial<AgentSwapQuote> = {}, tx = zeroXTx({ min: FAIR_MIN })): AgentSwapQuote {
  return {
    chain_id: 8453, from_token: 'USDC', to_token: 'WETH', from_token_address: USDC, to_token_address: BASE_WETH,
    sell_amount: '1000000', buy_amount: FAIR_BUY.toString(), affiliate_fee: '1250000000000',
    unsigned_tx: { to: tx.to, data: tx.data, value: '0', gas: '0x1', gasPrice: '0x1' },
    ...over,
  };
}

describe('executeAgentSwap', () => {
  it('quotes, approves exactly the sell amount, signs the swap, records it', async () => {
    const { transport, raws } = mockChain({ allowance: 0n });
    const quoted: unknown[] = [];
    const recorded: unknown[] = [];
    const out = await executeAgentSwap({
      quote: async (b) => { quoted.push(b); return quoteOf(); },
      record: async (b) => { recorded.push(b); return { pe_id: 'pe_swap' }; },
    }, WALLET, { fromToken: 'USDC', toToken: 'WETH', amountAtomic: '1000000', transport, confirmations: 1 });

    expect(quoted).toEqual([{ fromToken: 'USDC', toToken: 'WETH', amount: '1000000', slippageBps: 50 }]);
    expect(raws).toHaveLength(2);
    const approve = parseTransaction(raws[0]);
    expect(approve.to?.toLowerCase()).toBe(USDC.toLowerCase());
    const a = decodeFunctionData({ abi: APPROVE_ABI, data: approve.data as Hex });
    expect(a.args).toEqual([ZEROX_ALLOWANCE_HOLDER, 1_000_000n]);
    const swap = parseTransaction(raws[1]);
    expect(swap.to?.toLowerCase()).toBe(ZEROX_ALLOWANCE_HOLDER.toLowerCase());
    expect(swap.data).toBe(zeroXTx({ min: FAIR_MIN }).data);
    expect(recorded).toEqual([{ tx_hash: keccak256(raws[1]), from_token: 'USDC', to_token: 'WETH', from_amount: '1000000', to_amount: FAIR_BUY.toString(), fee_amount: '1250000000000' }]);
    expect(out).toMatchObject({ approveTxHash: keccak256(raws[0]), swapTxHash: keccak256(raws[1]), peId: 'pe_swap', minBuyAmountAtomic: FAIR_MIN.toString() });
  });

  it('skips the approve when the standing allowance covers the sell', async () => {
    const { transport, raws } = mockChain({ allowance: 5_000_000n });
    const out = await executeAgentSwap({ quote: async () => quoteOf(), record: async () => ({ pe_id: 'pe_s' }) },
      WALLET, { fromToken: 'USDC', toToken: 'WETH', amountAtomic: '1000000', transport, confirmations: 1 });
    expect(raws).toHaveLength(1);
    expect(out.approveTxHash).toBeNull();
  });

  const bad: Array<[string, AgentSwapQuote, string]> = [
    ['a quote paying someone else', quoteOf({}, zeroXTx({ recipient: OTHER })), 'ZEROX_WRONG_RECIPIENT'],
    ['a quote for another amount', quoteOf({ sell_amount: '2000000' }), 'SWAP_QUOTE_AMOUNT_MISMATCH'],
    ['a quote naming other tokens', quoteOf({ to_token_address: OTHER }), 'SWAP_QUOTE_TOKEN_MISMATCH'],
    ['a quote on another chain', quoteOf({ chain_id: 1 }), 'SWAP_WRONG_CHAIN'],
    ['a quote to an unknown router', quoteOf({}, { ...zeroXTx(), to: OTHER }), 'ZEROX_UNKNOWN_TARGET'],
    // , defect 2 — a self-consistent DUST quote (buy_amount 1000 wei for $1,
    // minimum 995 = quote less slippage) passes every quote-relative check; only the independent
    // price catches it.
    ['a self-consistent dust quote (minimum far below the ETH / USD feed)', quoteOf({ buy_amount: '1000' }, zeroXTx({ min: 995n })), 'SWAP_PRICE_OUT_OF_BOUNDS'],
  ];
  for (const [name, q, code] of bad) {
    it(`RED: ${name} is refused before anything is signed`, async () => {
      const { transport, raws } = mockChain();
      let recordedCalls = 0;
      await expect(executeAgentSwap({ quote: async () => q, record: async () => { recordedCalls++; return { pe_id: 'x' }; } },
        WALLET, { fromToken: 'USDC', toToken: 'WETH', amountAtomic: '1000000', transport, confirmations: 1 })).rejects.toMatchObject({ code });
      expect(raws).toHaveLength(0);
      expect(recordedCalls).toBe(0);
    });
  }

  it('RED: a counterfeit Settler is refused before anything is signed', async () => {
    const { transport, raws } = mockChain({ registrySettler: OTHER });
    await expect(executeAgentSwap({ quote: async () => quoteOf(), record: async () => ({ pe_id: 'x' }) },
      WALLET, { fromToken: 'USDC', toToken: 'WETH', amountAtomic: '1000000', transport, confirmations: 1 })).rejects.toMatchObject({ code: 'ZEROX_COUNTERFEIT_SETTLER' });
    expect(raws).toHaveLength(0);
  });

  const feedFailures: Array<[string, FeedState]> = [
    ['a stale ETH / USD answer', { updatedAt: NOW - ORACLE_MAX_AGE_SECONDS - 1n }],
    ['an unreadable feed', { broken: true }],
    ['a non-positive answer', { answer: 0n }],
    ['a feed reporting other decimals', { decimals: 18 }],
    ['an answer stamped in the future', { updatedAt: NOW + 3_600n }],
  ];
  for (const [name, feed] of feedFailures) {
    it(`RED: ${name} refuses (fail closed) before anything is signed`, async () => {
      const { transport, raws } = mockChain({ feed });
      await expect(executeAgentSwap({ quote: async () => quoteOf(), record: async () => ({ pe_id: 'x' }) },
        WALLET, { fromToken: 'USDC', toToken: 'WETH', amountAtomic: '1000000', transport, confirmations: 1 })).rejects.toMatchObject({ code: 'SWAP_ORACLE_UNAVAILABLE' });
      expect(raws).toHaveLength(0);
    });
  }

  it('RED: tokens the relay does not quote are refused before the quote', async () => {
    let quoted = 0;
    await expect(executeAgentSwap({ quote: async () => { quoted++; return quoteOf(); }, record: async () => ({ pe_id: 'x' }) },
      WALLET, { fromToken: 'PVT' as 'USDC', toToken: 'WETH', amountAtomic: '1', rpcUrl: 'https://rpc.test' })).rejects.toMatchObject({ code: 'SWAP_TOKEN_UNSUPPORTED' });
    expect(quoted).toBe(0);
  });
});

describe('independent price bound ( , defect 2)', () => {
  it('values both directions from the one ETH / USD feed', () => {
    expect(oracleExpectedOut('USDC', 1_000_000n, ETH_USD)).toBe(500_000_000_000_000n); // $1 → 5e14 wei
    expect(oracleExpectedOut('WETH', 10n ** 18n, ETH_USD)).toBe(2_000_000_000n); // 1 ETH → 2,000 USDC
  });

  it('a fair quote passes in both directions; a dust quote is refused in both', () => {
    expect(() => assertSwapWithinOracleBounds({ sellToken: 'USDC', sellAmount: 1_000_000n, minAmountOut: FAIR_MIN, slippageBps: 50, ethUsd: ETH_USD })).not.toThrow();
    expect(() => assertSwapWithinOracleBounds({ sellToken: 'WETH', sellAmount: 10n ** 18n, minAmountOut: 1_985_000_000n, slippageBps: 50, ethUsd: ETH_USD })).not.toThrow();
    for (const bad of [
      { sellToken: 'USDC' as const, sellAmount: 1_000_000n, minAmountOut: 995n },
      { sellToken: 'WETH' as const, sellAmount: 10n ** 18n, minAmountOut: 1n },
    ]) {
      expect(() => assertSwapWithinOracleBounds({ ...bad, slippageBps: 50, ethUsd: ETH_USD })).toThrow(expect.objectContaining({ code: 'SWAP_PRICE_OUT_OF_BOUNDS' }));
    }
  });

  it('the bound sits exactly at feed value less slippage, fee and tolerance', () => {
    const expected = oracleExpectedOut('USDC', 1_000_000n, ETH_USD);
    const floor = (expected * BigInt(10_000 - 50 - 25 - 100)) / 10_000n;
    expect(() => assertSwapWithinOracleBounds({ sellToken: 'USDC', sellAmount: 1_000_000n, minAmountOut: floor, slippageBps: 50, ethUsd: ETH_USD })).not.toThrow();
    expect(() => assertSwapWithinOracleBounds({ sellToken: 'USDC', sellAmount: 1_000_000n, minAmountOut: floor - 1n, slippageBps: 50, ethUsd: ETH_USD }))
      .toThrow(expect.objectContaining({ code: 'SWAP_PRICE_OUT_OF_BOUNDS' }));
  });

  it('readEthUsdPrice returns a live answer and refuses a stale / broken / wrong-scale feed', async () => {
    await expect(readEthUsdPrice(feedCall(), NOW)).resolves.toBe(ETH_USD);
    await expect(readEthUsdPrice(feedCall({ updatedAt: NOW - ORACLE_MAX_AGE_SECONDS }), NOW)).resolves.toBe(ETH_USD);
    for (const f of [{ updatedAt: NOW - ORACLE_MAX_AGE_SECONDS - 1n }, { broken: true }, { answer: -1n }, { decimals: 6 }, { updatedAt: 0n }]) {
      await expect(readEthUsdPrice(feedCall(f), NOW)).rejects.toMatchObject({ code: 'SWAP_ORACLE_UNAVAILABLE' });
    }
  });
});
