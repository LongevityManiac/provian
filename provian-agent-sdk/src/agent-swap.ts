import { guardedFetch } from './guarded-fetch';
/**
 * The agent's own token swap on Base : relay quote → guard → sign → record.
 *
 * The relay route already exists on master and is the only value path used:
 * 1. `POST /v1/agent/wallet/:wallet_id/swap` returns a 0x v2 allowance-holder quote with the
 * UNSIGNED transaction. The relay verifies Provian's 25 bps fee sits in the buy token and
 * goes to the treasury (`core/swap/swap-fees.ts::verifyZeroXQuoteFee`) before answering.
 * 2. This module checks the unsigned transaction does exactly the swap asked for
 * (`zerox-swap-guard.ts`), bounds its on-chain minimum against Chainlink's ETH / USD feed on
 * Base (a price the quote does not supply — a dust quote is refused), approves EXACTLY the sell amount to 0x AllowanceHolder when the
 * current allowance is short (the signer's bounded-approve guard applies), signs and
 * broadcasts the swap with the agent's own key, and waits for it to mine.
 * 3. `POST /v1/agent/wallet/:wallet_id/swap/record` re-verifies on-chain that THIS wallet sent
 * the transaction and seals `agent_token_swap`.
 *
 * Tokens: the relay quotes USDC and WETH only. Nothing here moves value the relay did not quote,
 * and nothing is signed before the guard passes.
 */
import { createPublicClient, http, parseAbi, type Transport } from 'viem';
import { sendTransaction, EvmSignerError, type EvmWallet } from './evm-signer';
import { VIEM_CHAINS, getToken } from './evm-allowlist';
import { encodeApprove, waitForReceipt } from './evm-bond';
import {
  BASE_WETH,
  ZEROX_ALLOWANCE_HOLDER,
  SwapRouteRefusedError,
  assertGenuineZeroXSettler,
  assertSwapWithinOracleBounds,
  assertZeroXExecutionMatches,
  decodeZeroXAllowanceHolderTx,
  readEthUsdPrice,
  type EthCall,
} from './zerox-swap-guard';

export type AgentSwapToken = 'USDC' | 'WETH';

/** The pinned Base address for each swappable token (never taken from the quote). */
export function agentSwapTokenAddress(token: AgentSwapToken): `0x${string}` {
  return token === 'USDC' ? getToken('base', 'USDC').address : (BASE_WETH as `0x${string}`);
}

export function isAgentSwapToken(v: unknown): v is AgentSwapToken {
  return v === 'USDC' || v === 'WETH';
}

/** The relay's quote (the shape `POST /:wallet_id/swap` answers). */
export interface AgentSwapQuote {
  chain_id: number;
  from_token: string;
  to_token: string;
  from_token_address: string;
  to_token_address: string;
  sell_amount: string;
  buy_amount: string;
  affiliate_fee: string;
  unsigned_tx: { to: string; data: string; value: string; gas?: string; gasPrice?: string };
}

export interface AgentSwapParams {
  fromToken: AgentSwapToken;
  toToken: AgentSwapToken;
  /** Sell amount in the sell token's atomic units. */
  amountAtomic: string;
  /** Slippage the agent accepts (default 50 bps — the relay's default). */
  slippageBps?: number;
  rpcUrl?: string;
  /** Pre-built viem transport (tests inject a mock; overrides rpcUrl). */
  transport?: Transport;
  /**
   * Confirmations to wait before the relay record (default 12 — the relay's Base finality floor;
   * `/swap/record` refuses a shallower transaction).
   */
  confirmations?: number;
}

export interface AgentSwapResult {
  fromToken: AgentSwapToken;
  toToken: AgentSwapToken;
  sellAmountAtomic: string;
  quotedBuyAmountAtomic: string;
  minBuyAmountAtomic: string;
  feeAtomic: string;
  approveTxHash: string | null;
  swapTxHash: string;
  peId: string;
}

export interface AgentSwapIO {
  quote(body: { fromToken: AgentSwapToken; toToken: AgentSwapToken; amount: string; slippageBps: number }): Promise<AgentSwapQuote>;
  record(body: { tx_hash: string; from_token: string; to_token: string; from_amount: string; to_amount: string; fee_amount: string }): Promise<{ pe_id?: unknown }>;
}

const ERC20_ALLOWANCE_ABI = parseAbi(['function allowance(address owner, address spender) view returns (uint256)']);

/** Execute the whole swap. See the module comment for the order of operations. */
export async function executeAgentSwap(io: AgentSwapIO, wallet: EvmWallet, params: AgentSwapParams): Promise<AgentSwapResult> {
  if (!isAgentSwapToken(params.fromToken) || !isAgentSwapToken(params.toToken)) {
    throw new SwapRouteRefusedError('SWAP_TOKEN_UNSUPPORTED', 'the relay swaps USDC and WETH on Base only');
  }
  if (params.fromToken === params.toToken) {
    throw new SwapRouteRefusedError('SWAP_SAME_TOKEN', 'from and to must differ');
  }
  if (!/^[0-9]+$/.test(params.amountAtomic) || BigInt(params.amountAtomic) <= 0n) {
    throw new SwapRouteRefusedError('SWAP_BAD_AMOUNT', 'amountAtomic must be a positive integer string');
  }
  const slippageBps = params.slippageBps ?? 50;
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 1_000) {
    throw new SwapRouteRefusedError('SWAP_BAD_SLIPPAGE', 'slippageBps must be an integer 0..1000');
  }
  const transport = params.transport ?? (params.rpcUrl ? http(params.rpcUrl, { fetchFn: guardedFetch }) : undefined);
  if (!transport) throw new EvmSignerError('rpcUrl or transport is required to swap', 'NO_TRANSPORT');

  const sellToken = agentSwapTokenAddress(params.fromToken);
  const buyToken = agentSwapTokenAddress(params.toToken);
  const sellAmount = BigInt(params.amountAtomic);

  const quote = await io.quote({ fromToken: params.fromToken, toToken: params.toToken, amount: params.amountAtomic, slippageBps });
  if (quote.chain_id !== 8453) throw new SwapRouteRefusedError('SWAP_WRONG_CHAIN', `quote is for chain ${quote.chain_id}, not Base`);
  if (quote.from_token_address?.toLowerCase() !== sellToken.toLowerCase()
    || quote.to_token_address?.toLowerCase() !== buyToken.toLowerCase()) {
    throw new SwapRouteRefusedError('SWAP_QUOTE_TOKEN_MISMATCH', 'quote names tokens other than the ones requested');
  }
  if (quote.sell_amount !== params.amountAtomic) {
    throw new SwapRouteRefusedError('SWAP_QUOTE_AMOUNT_MISMATCH', `quote sells ${quote.sell_amount}, not ${params.amountAtomic}`);
  }
  const tx = quote.unsigned_tx;
  if (!tx || typeof tx.to !== 'string' || typeof tx.data !== 'string') {
    throw new SwapRouteRefusedError('SWAP_QUOTE_MALFORMED', 'quote carries no unsigned transaction');
  }
  const value = BigInt(tx.value || '0');
  const exec = decodeZeroXAllowanceHolderTx(tx);
  assertZeroXExecutionMatches(exec, {
    sellToken, sellAmount, buyToken, recipient: wallet.address, value,
    quotedBuyAmount: BigInt(quote.buy_amount), slippageBps,
  });

  const client = createPublicClient({ chain: VIEM_CHAINS.base, transport });
  const ethCall: EthCall = async ({ to, data }) => {
    const r = await client.call({ to: to as `0x${string}`, data: data as `0x${string}` });
    return r.data ?? '0x';
  };
  await assertGenuineZeroXSettler(exec.settler, ethCall);

  // : the minimum above is only as honest as the quote it came from. Bound it
  // against an independent on-chain price (Chainlink ETH / USD on Base, read over the agent's own
  // RPC, freshness judged against the latest block) before anything — approve included — is signed.
  let chainNowSeconds: bigint;
  try {
    chainNowSeconds = (await client.getBlock({ blockTag: 'latest' })).timestamp;
  } catch {
    throw new SwapRouteRefusedError('SWAP_ORACLE_UNAVAILABLE', 'the latest Base block could not be read to judge the price feed; not signing');
  }
  const ethUsd = await readEthUsdPrice(ethCall, chainNowSeconds);
  assertSwapWithinOracleBounds({
    sellToken: params.fromToken, sellAmount, minAmountOut: exec.minAmountOut, slippageBps, ethUsd,
  });

  // Approve EXACTLY the sell amount to AllowanceHolder when the standing allowance is short.
  // USDC is an allowlisted token; WETH is not, so its approve names the pinned Base WETH
  // explicitly (the target is fixed above, never taken from the quote).
  let approveTxHash: string | null = null;
  const allowance = await client.readContract({
    address: sellToken, abi: ERC20_ALLOWANCE_ABI, functionName: 'allowance',
    args: [wallet.address as `0x${string}`, ZEROX_ALLOWANCE_HOLDER as `0x${string}`],
  });
  if (allowance < sellAmount) {
    const approve = await sendTransaction(wallet, {
      to: sellToken, data: encodeApprove(ZEROX_ALLOWANCE_HOLDER, sellAmount), chain: 'base', transport,
      allowUnlistedTarget: params.fromToken === 'WETH',
      waitForReceipt: true,
    });
    approveTxHash = approve.hash;
  }

  // The swap itself: AllowanceHolder is not a token/institution contract, so the allowlist is
  // opted out HERE ONLY, after the calldata was decoded and matched and the Settler verified.
  const sent = await sendTransaction(wallet, {
    to: ZEROX_ALLOWANCE_HOLDER, data: tx.data, value, chain: 'base', transport, allowUnlistedTarget: true,
  });
  const status = await waitForReceipt({
    chain: 'base', hash: sent.hash as `0x${string}`, transport, confirmations: params.confirmations ?? 12,
  });
  if (status !== 'success') {
    throw new EvmSignerError(`swap ${sent.hash} was mined but REVERTED on-chain; nothing was swapped`, 'TX_REVERTED');
  }

  const rec = await io.record({
    tx_hash: sent.hash,
    from_token: params.fromToken,
    to_token: params.toToken,
    from_amount: quote.sell_amount,
    to_amount: quote.buy_amount,
    fee_amount: quote.affiliate_fee || '0',
  });
  if (typeof rec.pe_id !== 'string' || rec.pe_id.length === 0) {
    throw new EvmSignerError(`swap ${sent.hash} mined but the relay record returned no pe_id`, 'SWAP_RECORD_MISSING_PE');
  }
  return {
    fromToken: params.fromToken,
    toToken: params.toToken,
    sellAmountAtomic: quote.sell_amount,
    quotedBuyAmountAtomic: quote.buy_amount,
    minBuyAmountAtomic: exec.minAmountOut.toString(),
    feeAtomic: quote.affiliate_fee || '0',
    approveTxHash,
    swapTxHash: sent.hash,
    peId: rec.pe_id,
  };
}
