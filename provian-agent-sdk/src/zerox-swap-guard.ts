/**
 * 0x v2 allowance-holder signing guard for the AGENT's own swap.
 *
 * The relay's `POST /v1/agent/wallet/:wallet_id/swap` hands back an UNSIGNED 0x
 * transaction (the relay never holds a key). The agent signs it with its OWN key,
 * so before anything is signed the SDK checks the transaction does exactly what
 * the agent asked for — the same checks the app runs on the human's 0x swaps
 * (`src/core/swap/evmSwapGuard.ts`,), ported to viem:
 *
 * - `to` is 0x AllowanceHolder (a fixed contract on every Cancun chain; Base is one);
 * - the call is `AllowanceHolder.exec(operator, token, amount, target, data)` with
 * operator == target, `token`/`amount` exactly the sell leg asked for;
 * - the inner call is `Settler.execute((recipient, buyToken, minAmountOut), …)` paying
 * THIS wallet, in the buy token asked for, with a non-zero minimum the Settler enforces
 * on-chain;
 * - the Settler is GENUINE: 0x's Deployer/registry names it for the taker-submitted
 * feature now (`ownerOf(2)`) or just before (`prev(2)`). An unreadable registry refuses.
 *
 * This is the SDK's existing guardrail shape (a pinned target, a bounded approve), not a
 * governance layer: the agent's spending is its own; the guard only makes sure the bytes it
 * signs are the swap it requested, so a compromised quote cannot redirect its tokens.
 */
import { decodeFunctionData, decodeFunctionResult, encodeFunctionData, getAddress, parseAbi, type Hex } from 'viem';
import { ProvianError } from './errors';

export class SwapRouteRefusedError extends ProvianError {
  constructor(code: string, message: string) {
    super(message, code);
    this.name = 'SwapRouteRefusedError';
  }
}

/** 0x AllowanceHolder (Cancun chains — Base, Arbitrum, Optimism). */
export const ZEROX_ALLOWANCE_HOLDER = '0x0000000000001fF3684f28c67538d4D072C22734';
/** 0x Deployer/registry: `ownerOf(featureId)` is the current Settler, `prev(featureId)` the last. */
export const ZEROX_DEPLOYER = '0x00000000000004533Fe15556B1E086BB1A72cEae';
/** 0x Settler feature id for taker-submitted swaps (the allowance-holder flow). */
export const ZEROX_TAKER_SUBMITTED_FEATURE = 2n;
/** Canonical WETH on Base (OP-stack predeploy). */
export const BASE_WETH = '0x4200000000000000000000000000000000000006';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const ALLOWANCE_HOLDER_ABI = parseAbi([
  'function exec(address operator, address token, uint256 amount, address target, bytes data) payable returns (bytes)',
]);
const SETTLER_ABI = parseAbi([
  'function execute((address recipient, address buyToken, uint256 minAmountOut) slippage, bytes[] actions, bytes32 zidAndAffiliate) payable returns (bool)',
]);
const DEPLOYER_ABI = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function prev(uint128 featureId) view returns (address)',
]);

const same = (a: string | null | undefined, b: string | null | undefined): boolean =>
  typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/** A 0x allowance-holder transaction, decoded. */
export interface ZeroXExecution {
  settler: string;
  token: string;
  amount: bigint;
  recipient: string;
  buyToken: string;
  minAmountOut: bigint;
}

/**
 * Decode a 0x v2 allowance-holder transaction and check its shape. Pure: no network.
 */
export function decodeZeroXAllowanceHolderTx(tx: { to: string; data: string }): ZeroXExecution {
  if (!same(tx.to, ZEROX_ALLOWANCE_HOLDER)) {
    throw new SwapRouteRefusedError('ZEROX_UNKNOWN_TARGET', `swap transaction targets ${tx.to}, not 0x AllowanceHolder`);
  }
  let outer: { functionName: string; args?: readonly unknown[] };
  try {
    outer = decodeFunctionData({ abi: ALLOWANCE_HOLDER_ABI, data: tx.data as Hex });
  } catch {
    throw new SwapRouteRefusedError('ZEROX_UNKNOWN_CALL', 'swap calldata is not AllowanceHolder.exec');
  }
  const [operator, token, amount, target, inner] = (outer.args ?? []) as [string, string, bigint, string, Hex];
  if (!same(operator, target)) {
    throw new SwapRouteRefusedError('ZEROX_OPERATOR_MISMATCH', 'AllowanceHolder operator is not the Settler it calls');
  }
  let exec: { functionName: string; args?: readonly unknown[] };
  try {
    exec = decodeFunctionData({ abi: SETTLER_ABI, data: inner });
  } catch {
    throw new SwapRouteRefusedError('ZEROX_UNKNOWN_CALL', 'Settler calldata is not execute(slippage, actions, zid)');
  }
  const slippage = (exec.args ?? [])[0] as { recipient: string; buyToken: string; minAmountOut: bigint };
  if (!slippage || slippage.minAmountOut <= 0n) {
    throw new SwapRouteRefusedError('ZEROX_NO_MINIMUM', 'Settler call enforces no minimum amount out');
  }
  return {
    settler: getAddress(target),
    token,
    amount,
    recipient: slippage.recipient,
    buyToken: slippage.buyToken,
    minAmountOut: slippage.minAmountOut,
  };
}

/** What the agent asked for, in the terms the transaction must match. */
export interface ZeroXExpectation {
  sellToken: string;
  sellAmount: bigint;
  buyToken: string;
  /** This wallet — the one that signs and must receive the output. */
  recipient: string;
  /** Wei the transaction sends (an ERC-20 sell sends none). */
  value: bigint;
  /** The quoted buy amount and the slippage the agent accepted: the on-chain minimum may not be looser. */
  quotedBuyAmount: bigint;
  slippageBps: number;
}

/** The decoded transaction moves exactly the requested sell leg and pays the requested buy leg to this wallet. */
export function assertZeroXExecutionMatches(exec: ZeroXExecution, want: ZeroXExpectation): void {
  if (!same(exec.token, want.sellToken)) {
    throw new SwapRouteRefusedError('ZEROX_WRONG_SELL_TOKEN', 'swap pulls a token other than the one requested');
  }
  if (want.value !== 0n) {
    throw new SwapRouteRefusedError('ZEROX_WRONG_VALUE', 'ERC-20 swap also sends ETH');
  }
  if (exec.amount !== want.sellAmount) {
    throw new SwapRouteRefusedError('ZEROX_WRONG_AMOUNT', `swap pulls ${exec.amount}, not the ${want.sellAmount} requested`);
  }
  if (!same(exec.recipient, want.recipient)) {
    throw new SwapRouteRefusedError('ZEROX_WRONG_RECIPIENT', 'swap pays its output to an address other than this wallet');
  }
  if (!same(exec.buyToken, want.buyToken)) {
    throw new SwapRouteRefusedError('ZEROX_WRONG_BUY_TOKEN', 'swap pays out a token other than the one requested');
  }
  // The Settler's minimum may not be looser than the quote minus the slippage the agent accepted
  // (one atomic unit of rounding allowed).
  const floor = (want.quotedBuyAmount * BigInt(10_000 - want.slippageBps)) / 10_000n;
  if (exec.minAmountOut + 1n < floor) {
    throw new SwapRouteRefusedError(
      'ZEROX_MINIMUM_TOO_LOW',
      `swap guarantees at least ${exec.minAmountOut}, below the quoted ${want.quotedBuyAmount} less ${want.slippageBps} bps`,
    );
  }
}

/** A read-only `eth_call`. */
export type EthCall = (tx: { to: string; data: string }) => Promise<string>;

/**
 * The Settler is the one 0x's registry names for taker-submitted swaps now (`ownerOf(2)`) or
 * just before (`prev(2)`). Any failed read refuses.
 */
export async function assertGenuineZeroXSettler(settler: string, call: EthCall): Promise<void> {
  const read = async (fn: 'ownerOf' | 'prev'): Promise<string> => {
    const data = encodeFunctionData({ abi: DEPLOYER_ABI, functionName: fn, args: [ZEROX_TAKER_SUBMITTED_FEATURE] });
    let raw: string;
    try {
      raw = await call({ to: ZEROX_DEPLOYER, data });
    } catch {
      throw new SwapRouteRefusedError('ZEROX_REGISTRY_UNAVAILABLE', `0x registry ${fn}(2) could not be read; not signing`);
    }
    try {
      return decodeFunctionResult({ abi: DEPLOYER_ABI, functionName: fn, data: raw as Hex }) as string;
    } catch {
      throw new SwapRouteRefusedError('ZEROX_REGISTRY_UNAVAILABLE', `0x registry ${fn}(2) returned no address; not signing`);
    }
  };
  const current = await read('ownerOf');
  if (same(current, settler) && !same(current, ZERO_ADDRESS)) return;
  const previous = await read('prev');
  if (same(previous, settler) && !same(previous, ZERO_ADDRESS)) return;
  throw new SwapRouteRefusedError('ZEROX_COUNTERFEIT_SETTLER', `${settler} is not a 0x Settler the registry names`);
}

// ---------------------------------------------------------------------------
// Independent price bound ( , defect 2)
// ---------------------------------------------------------------------------
//
// Every check above binds the transaction to the QUOTE — and the quote is the thing that may be
// compromised. A hostile quote can set its own buy_amount to dust, set minAmountOut to match, and
// route the sell through a genuine Settler into a pool it controls: every shape check passes and
// the agent signs away its sell leg for nothing. So before anything is signed, the on-chain
// minimum is bounded against a price the quote does not supply: Chainlink's ETH / USD feed on
// Base, read over the agent's own RPC. The swappable pair is USDC ⇄ WETH only, so one feed covers
// both directions (USDC is valued at $1; its own depeg is outside this bound).

/**
 * Chainlink ETH / USD price feed (EACAggregatorProxy) on Base mainnet. Verified on chain
 * 2026-09-28: `description()` = "ETH / USD", `decimals()` = 8, underlying aggregator
 * 0x05c84a58FE042275b37db038bAAcD15F410c7bB0; the feed's heartbeat on Base is 20 minutes.
 */
export const BASE_CHAINLINK_ETH_USD = '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70';
/** The feed's answer scale; a feed reporting anything else is refused, never rescaled. */
export const ETH_USD_FEED_DECIMALS = 8;
/**
 * Oldest feed answer accepted: three 20-minute heartbeats. One missed update is tolerated; a feed
 * that has stopped updating (or a sequencer outage the price has not caught up from) refuses.
 */
export const ORACLE_MAX_AGE_SECONDS = 3_600n;
/** A feed answer stamped later than the chain's latest block by more than this is refused. */
export const ORACLE_FUTURE_SKEW_SECONDS = 60n;
/**
 * How far a quote's guaranteed output may sit below the feed's fair value BEYOND the slippage the
 * agent accepted and Provian's fee: the feed's 0.15 % deviation threshold, its lag inside a
 * heartbeat, and pool spread / price impact for an ordinary agent-sized swap. A swap whose price
 * impact exceeds this is refused rather than signed — a refusal the agent can retry smaller.
 */
export const SWAP_ORACLE_TOLERANCE_BPS = 100;
/** Provian's swap fee, taken in the buy token (the relay verifies it); the minimum is net of it. */
export const PROVIAN_SWAP_FEE_BPS = 25;

const USDC_DECIMALS = 6n;
const WETH_DECIMALS = 18n;

const FEED_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);

/**
 * Read ETH / USD (8 decimals) from the pinned feed and check it is live: the pinned decimals, a
 * positive answer, updated within ORACLE_MAX_AGE_SECONDS of `chainNowSeconds` (the latest block's
 * timestamp) and not in its future. Any failure refuses with SWAP_ORACLE_UNAVAILABLE.
 */
export async function readEthUsdPrice(call: EthCall, chainNowSeconds: bigint): Promise<bigint> {
  const raw = async (fn: 'decimals' | 'latestRoundData'): Promise<Hex> => {
    try {
      return await call({ to: BASE_CHAINLINK_ETH_USD, data: encodeFunctionData({ abi: FEED_ABI, functionName: fn }) }) as Hex;
    } catch {
      throw new SwapRouteRefusedError('SWAP_ORACLE_UNAVAILABLE', `ETH / USD feed ${fn}() could not be read; not signing`);
    }
  };
  const unusable = (fn: string) =>
    new SwapRouteRefusedError('SWAP_ORACLE_UNAVAILABLE', `ETH / USD feed ${fn}() returned nothing usable; not signing`);
  let decimals: number;
  try {
    decimals = Number(decodeFunctionResult({ abi: FEED_ABI, functionName: 'decimals', data: await raw('decimals') }));
  } catch (e) {
    if (e instanceof SwapRouteRefusedError) throw e;
    throw unusable('decimals');
  }
  if (decimals !== ETH_USD_FEED_DECIMALS) {
    throw new SwapRouteRefusedError('SWAP_ORACLE_UNAVAILABLE', `ETH / USD feed reports ${decimals} decimals, not ${ETH_USD_FEED_DECIMALS}`);
  }
  let round: readonly [bigint, bigint, bigint, bigint, bigint];
  try {
    round = decodeFunctionResult({ abi: FEED_ABI, functionName: 'latestRoundData', data: await raw('latestRoundData') });
  } catch (e) {
    if (e instanceof SwapRouteRefusedError) throw e;
    throw unusable('latestRoundData');
  }
  const answer = round[1];
  const updatedAt = round[3];
  if (answer <= 0n) throw new SwapRouteRefusedError('SWAP_ORACLE_UNAVAILABLE', 'ETH / USD feed answer is not positive');
  if (updatedAt === 0n) throw new SwapRouteRefusedError('SWAP_ORACLE_UNAVAILABLE', 'ETH / USD feed round is incomplete');
  if (updatedAt > chainNowSeconds + ORACLE_FUTURE_SKEW_SECONDS) {
    throw new SwapRouteRefusedError('SWAP_ORACLE_UNAVAILABLE', 'ETH / USD feed answer is stamped in the future');
  }
  if (chainNowSeconds - updatedAt > ORACLE_MAX_AGE_SECONDS) {
    throw new SwapRouteRefusedError(
      'SWAP_ORACLE_UNAVAILABLE',
      `ETH / USD feed answer is ${chainNowSeconds - updatedAt}s old (limit ${ORACLE_MAX_AGE_SECONDS}s); not signing`,
    );
  }
  return answer;
}

/** The fair output of selling `sellAmount` of `sellToken` at `ethUsd` (8 decimals), in the buy token's atomic units. */
export function oracleExpectedOut(sellToken: 'USDC' | 'WETH', sellAmount: bigint, ethUsd: bigint): bigint {
  const scale = 10n ** (WETH_DECIMALS - USDC_DECIMALS + BigInt(ETH_USD_FEED_DECIMALS));
  return sellToken === 'USDC' ? (sellAmount * scale) / ethUsd : (sellAmount * ethUsd) / scale;
}

/**
 * The transaction's on-chain minimum must be at least the feed's fair output less the slippage
 * the agent accepted, Provian's fee, and SWAP_ORACLE_TOLERANCE_BPS. Otherwise SWAP_PRICE_OUT_OF_BOUNDS.
 */
export function assertSwapWithinOracleBounds(input: {
  sellToken: 'USDC' | 'WETH';
  sellAmount: bigint;
  minAmountOut: bigint;
  slippageBps: number;
  ethUsd: bigint;
}): void {
  const expected = oracleExpectedOut(input.sellToken, input.sellAmount, input.ethUsd);
  const keepBps = 10_000 - input.slippageBps - PROVIAN_SWAP_FEE_BPS - SWAP_ORACLE_TOLERANCE_BPS;
  const floor = keepBps > 0 ? (expected * BigInt(keepBps)) / 10_000n : 0n;
  if (expected <= 0n || input.minAmountOut < floor) {
    throw new SwapRouteRefusedError(
      'SWAP_PRICE_OUT_OF_BOUNDS',
      `swap guarantees at least ${input.minAmountOut}, below ${floor} (the ETH / USD feed values it at ${expected}, `
      + `less ${input.slippageBps} bps slippage, ${PROVIAN_SWAP_FEE_BPS} bps fee and ${SWAP_ORACLE_TOLERANCE_BPS} bps tolerance); not signing`,
    );
  }
}
