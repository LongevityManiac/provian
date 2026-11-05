/**
 * Swap fees — the ONE place the relay builds and checks Provian's 0.25% swap fee.
 *
 * the standing rule : every swap through Provian charges 25 bps, human and agent, on
 * every route that exists, and the fee is applied ON THE RELAY so no client-built request
 * (including one from a modified app) gets a fee-free swap through Provian's swap routes.
 *
 * Route Aggregator Fee mechanism Recipient
 * same-chain EVM 0x v2 swapFeeRecipient/Bps/Token (buy tok) 0x086e0F37… (EVM treasury)
 * same-chain Solana Jupiter platformFeeBps + feeAccount the treasury 5PHJDHY…'s token
 * account for the fee mint (USDC
 * → E8WkRW…; else SOL, else a side)
 * cross-chain (any) LI.FI integrator=provian, fee=0.0025 portal-registered wallets:
 * EVM 0x086e0F37…, Solana 5PHJDHY…
 *
 * Every builder here takes the client's request, keeps ONLY an allowlisted set of routing
 * parameters, and sets the fee parameters itself — a client-sent fee field is dropped, never
 * merged. Every verifier then refuses an upstream response whose fee is missing, at the wrong
 * rate, or bound to a destination other than the named recipient. A verifier failure is a
 * refusal (fail closed): the relay never forwards a quote it could not prove is fee-bearing.
 *
 * The recipients are PINNED here, not read from the client and not merely read from env: the
 * live `SWAP_FEE_RECIPIENT` must EQUAL the pinned treasury or the quote is refused. A deploy that
 * pointed the variable elsewhere closes the swap routes rather than paying a different address.
 *
 * Live probes behind these shapes (2026-09-25, docs/wp-runs/SWAP_FEE_ALL_ROUTES_2026-09-25.md):
 * - 0x: eth_simulateV1 of a relay-shaped quote moved exactly 25 bps of the gross buy amount to
 * the treasury; 0x's own fee went to 0x's wallet and exists with or without ours.
 * - LI.FI EVM source: the FeeForwarder paid 25 bps to the treasury and LI.FI's own fixed
 * 25 bps to LI.FI's wallet; LI.FI's fee is charged with or without an integrator fee, so it
 * takes none of Provian's 25 bps.
 * - LI.FI Solana source: TransferChecked of 25 bps to E8WkRW… (created in-tx for 5PHJDHY…).
 * - Jupiter: simulateTransaction moved exactly platformFee.amount (output-side) / 25 bps of
 * the input (input-side) to the treasury's account for the fee mint — SOL⇄USDC into E8WkRW…,
 * and non-USDC pairs (SOL→BONK, BONK→JUP, JUP→SOL) into the treasury's wSOL / BONK account,
 * created in the same transaction when it did not exist yet.
 */

import { createHash } from 'crypto';
import { assertLiveValueRecipient, PROVIAN_TREASURY } from '../config/live-value-recipients';

// =============================================================================
// Rate + recipients
// =============================================================================

/** The swap fee, in basis points. 25 bps = 0.25%. */
export const SWAP_FEE_BPS = 25;

/** LI.FI takes the fee as a 0–1 fraction. Must equal SWAP_FEE_BPS / 10_000. */
export const LIFI_FEE_FRACTION = '0.0025';

/** The integrator string the operator registered at portal.li.fi with both fee wallets. */
export const LIFI_INTEGRATOR = 'provian';

/** Provian's Solana treasury: the Solana address of the same MetaMask account as the EVM treasury. */
export const PROVIAN_SOLANA_TREASURY = '5PHJDHYveHA1LhqiWpCDRVEgSezDgPBMyL1rwAoMBTco';

/** Circle USDC on Solana. */
export const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** Wrapped SOL — Jupiter's name for native SOL. */
export const SOLANA_WSOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * The treasury's USDC associated token account — the Jupiter fee account whenever a pair has USDC,
 * and LI.FI's Solana-source USDC fee destination.
 *
 * Pinned as well as derived: planJupiterFee derives the treasury's account for the fee mint and
 * refuses unless the USDC derivation equals this pin (seen created for exactly that owner+mint by
 * LI.FI's own Solana-source fee instruction). The relay also checks on-chain before a Jupiter
 * build that the fee account is the treasury's token account for the fee mint. A wrong pin fails
 * closed.
 */
export const PROVIAN_SOLANA_USDC_FEE_ACCOUNT = 'E8WkRWFrrpJH2nvVDB3jTnLrRJQqpCT8qftV4vU7QQkB';

/** Jupiter's aggregator program. The fee account must be an account of one of its instructions. */
export const JUPITER_PROGRAM_ID = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

/** The System Program (native SOL transfers). */
export const SOLANA_SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

/** SPL Token programs: classic, Token-2022, and the set of both. */
export const SOLANA_TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const SOLANA_TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const SOLANA_TOKEN_PROGRAM_IDS: ReadonlySet<string> = new Set([SOLANA_TOKEN_PROGRAM_ID, SOLANA_TOKEN_2022_PROGRAM_ID]);

/** The Associated Token Account program (derives + creates the treasury's fee accounts). */
export const SOLANA_ATA_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

/** The address lookup table program (owner of every table a v0 transaction loads keys from). */
export const SOLANA_LOOKUP_TABLE_PROGRAM_ID = 'AddressLookupTab1e1111111111111111111111111';


/** Solana's packet limit for a serialized transaction. */
export const SOLANA_MAX_TX_BYTES = 1232;

/** LI.FI's name for native SOL as a token address. */
export const LIFI_SOLANA_NATIVE_TOKEN = '11111111111111111111111111111111';

/** LI.FI's chain id for Solana. */
export const LIFI_SOLANA_CHAIN_ID = 1151111081099710;

/** Chains the swap routes serve. Anything else is refused before any upstream call. */
export const EVM_SWAP_CHAIN_IDS: ReadonlySet<number> = new Set([8453, 42161, 10]);
export const LIFI_CHAIN_IDS: ReadonlySet<number> = new Set([8453, 42161, 10, LIFI_SOLANA_CHAIN_ID]);

export class SwapFeeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 502,
  ) {
    super(message);
    this.name = 'SwapFeeError';
  }
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT_STRING = /^[0-9]{1,78}$/;

function positiveUint(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UINT_STRING.test(value) || BigInt(value) <= 0n) {
    throw new SwapFeeError('invalid_request', `${field} must be a positive integer string`, 400);
  }
  return value;
}

/**
 * Resolve the EVM fee recipient from `SWAP_FEE_RECIPIENT` and refuse anything but the pinned
 * treasury. Runs the existing exposed-key guard first so its reason text still surfaces for the
 * legacy EOA.
 */
export function resolveEvmSwapFeeRecipient(env: Record<string, string | undefined>): string {
  const raw = (env.SWAP_FEE_RECIPIENT ?? '').trim();
  if (!raw) {
    throw new SwapFeeError('swap_fee_recipient_unset', 'Swap fee recipient not configured', 503);
  }
  assertLiveValueRecipient('SWAP_FEE_RECIPIENT', raw);
  if (!EVM_ADDRESS.test(raw) || raw.toLowerCase() !== PROVIAN_TREASURY) {
    throw new SwapFeeError(
      'swap_fee_recipient_not_treasury',
      `SWAP_FEE_RECIPIENT must be the Provian treasury ${PROVIAN_TREASURY}; refusing to route swap fees elsewhere`,
      503,
    );
  }
  return raw;
}

// =============================================================================
// 0x (same-chain EVM)
// =============================================================================

/** The only 0x routing parameters a client may choose. Fee fields are deliberately absent. */
const ZEROX_CLIENT_PARAMS = ['chainId', 'sellToken', 'buyToken', 'sellAmount', 'taker', 'slippageBps'] as const;

/**
 * Build the 0x v2 allowance-holder query from a client query. Keeps only the allowlisted routing
 * parameters (so a client-sent swapFeeBps=0, a foreign swapFeeRecipient, a buyAmount exact-out,
 * or any other field is dropped), then sets the fee triple itself: 25 bps of the BUY token to the
 * treasury — the same shape the agent route has used in production since.
 */
export function buildZeroXQuoteQuery(
  client: Record<string, unknown>,
  feeRecipient: string,
): URLSearchParams {
  const q = new URLSearchParams();
  for (const key of ZEROX_CLIENT_PARAMS) {
    const v = client[key];
    if (v === undefined) continue;
    if (typeof v !== 'string') {
      throw new SwapFeeError('invalid_request', `${key} must be a single string`, 400);
    }
    q.set(key, v);
  }
  const chainId = Number(q.get('chainId'));
  if (!EVM_SWAP_CHAIN_IDS.has(chainId)) {
    throw new SwapFeeError('unsupported_chain', 'chainId must be Base, Arbitrum or Optimism', 400);
  }
  const sellToken = q.get('sellToken') ?? '';
  const buyToken = q.get('buyToken') ?? '';
  if (!EVM_ADDRESS.test(sellToken) || !EVM_ADDRESS.test(buyToken)) {
    throw new SwapFeeError('invalid_request', 'sellToken and buyToken must be token addresses', 400);
  }
  positiveUint(q.get('sellAmount') ?? '', 'sellAmount');
  const taker = q.get('taker');
  if (!taker || !EVM_ADDRESS.test(taker)) {
    throw new SwapFeeError('invalid_request', 'taker must be an address', 400);
  }
  q.set('swapFeeRecipient', feeRecipient);
  q.set('swapFeeBps', String(SWAP_FEE_BPS));
  q.set('swapFeeToken', buyToken);
  return q;
}

export interface ZeroXFeeView {
  integratorFee?: { amount?: string; token?: string } | null;
  integratorFees?: Array<{ amount?: string; token?: string }> | null;
  zeroExFee?: { amount?: string; token?: string } | null;
}

export interface ZeroXQuoteView {
  liquidityAvailable?: boolean;
  buyAmount?: string;
  buyToken?: string;
  fees?: ZeroXFeeView | null;
  transaction?: { data?: string } | null;
}

/**
 * Refuse a 0x quote that is not carrying exactly one Provian fee of 25 bps in the buy token to
 * the treasury. The 0x integrator fee is 25 bps of the GROSS buy amount (net buy + our fee + 0x's
 * own fee when 0x takes it in the same token); ±1% tolerance absorbs 0x's own rounding. When the
 * quote carries calldata, the treasury address must appear in it — the Settler transfer target.
 */
export function verifyZeroXQuoteFee(
  quote: ZeroXQuoteView,
  expected: { buyToken: string; feeRecipient: string },
): { feeAmount: string; feeToken: string } {
  if (quote.liquidityAvailable === false) {
    throw new SwapFeeError('no_liquidity', 'No liquidity available for this swap pair', 422);
  }
  const fees = quote.fees ?? null;
  const fee = fees?.integratorFee ?? null;
  const list = fees?.integratorFees ?? null;
  if (!fee || typeof fee.amount !== 'string' || !UINT_STRING.test(fee.amount)) {
    throw new SwapFeeError('swap_fee_missing', '0x quote carries no Provian fee; refusing it');
  }
  if (Array.isArray(list) && list.length !== 1) {
    throw new SwapFeeError('swap_fee_unexpected', '0x quote carries more than one integrator fee; refusing it');
  }
  const buyToken = expected.buyToken.toLowerCase();
  if ((fee.token ?? '').toLowerCase() !== buyToken) {
    throw new SwapFeeError('swap_fee_wrong_token', '0x quote fee is not in the buy token; refusing it');
  }
  const net = BigInt(positiveUint(quote.buyAmount, 'buyAmount'));
  const feeAmount = BigInt(fee.amount);
  const zx = fees?.zeroExFee ?? null;
  const zxAmount =
    zx && typeof zx.amount === 'string' && UINT_STRING.test(zx.amount) && (zx.token ?? '').toLowerCase() === buyToken
      ? BigInt(zx.amount)
      : 0n;
  const gross = net + feeAmount + zxAmount;
  const want = (gross * BigInt(SWAP_FEE_BPS)) / 10_000n;
  const slack = want / 100n > 2n ? want / 100n : 2n;
  const diff = feeAmount > want ? feeAmount - want : want - feeAmount;
  if (feeAmount <= 0n || diff > slack) {
    throw new SwapFeeError('swap_fee_wrong_rate', `0x quote fee ${feeAmount} is not 25 bps of ${gross}; refusing it`);
  }
  const data = quote.transaction?.data;
  if (typeof data === 'string' && data.length > 2) {
    if (!data.toLowerCase().includes(expected.feeRecipient.toLowerCase().slice(2))) {
      throw new SwapFeeError('swap_fee_wrong_recipient', '0x calldata does not pay the treasury; refusing it');
    }
  }
  return { feeAmount: feeAmount.toString(), feeToken: buyToken };
}

// =============================================================================
// LI.FI (cross-chain)
// =============================================================================

const LIFI_CLIENT_PARAMS = [
  'fromChain',
  'toChain',
  'fromToken',
  'toToken',
  'fromAmount',
  'fromAddress',
  'toAddress',
  'slippage',
] as const;

/**
 * Build the LI.FI /v1/quote query. Only the allowlisted routing fields survive; the relay sets
 * `integrator` and `fee` itself. Same-chain requests are refused: same-chain EVM is 0x and
 * same-chain Solana is Jupiter , so this route is cross-chain only.
 */
export function buildLifiQuoteQuery(client: Record<string, unknown>): URLSearchParams {
  const q = new URLSearchParams();
  for (const key of LIFI_CLIENT_PARAMS) {
    const v = client[key];
    if (v === undefined) continue;
    if (typeof v !== 'string' || v.length === 0 || v.length > 128) {
      throw new SwapFeeError('invalid_request', `${key} must be a single string`, 400);
    }
    q.set(key, v);
  }
  for (const key of LIFI_CLIENT_PARAMS) {
    if (key !== 'slippage' && !q.get(key)) {
      throw new SwapFeeError('invalid_request', `${key} is required`, 400);
    }
  }
  const fromChain = Number(q.get('fromChain'));
  const toChain = Number(q.get('toChain'));
  if (!LIFI_CHAIN_IDS.has(fromChain) || !LIFI_CHAIN_IDS.has(toChain)) {
    throw new SwapFeeError('unsupported_chain', 'unsupported chain for a cross-chain swap', 400);
  }
  if (fromChain === toChain) {
    throw new SwapFeeError(
      'same_chain_not_lifi',
      'same-chain swaps route through 0x (EVM) or Jupiter (Solana), not LI.FI',
      400,
    );
  }
  positiveUint(q.get('fromAmount'), 'fromAmount');
  const slippage = q.get('slippage');
  if (slippage !== null) {
    const s = Number(slippage);
    if (!Number.isFinite(s) || s < 0 || s > 0.5) {
      throw new SwapFeeError('invalid_request', 'slippage must be a 0–0.5 fraction', 400);
    }
  }
  q.set('integrator', LIFI_INTEGRATOR);
  q.set('fee', LIFI_FEE_FRACTION);
  // Every direction: the one bridge the wallet decodes, and no DEX leg (round 2).
  q.set('allowBridges', LIFI_ALLOWED_BRIDGES.join(','));
  q.set('allowExchanges', LIFI_ALLOWED_EXCHANGES);
  return q;
}

/**
 * round 2: the LI.FI tools any quote may use, in both directions — the ones whose order the
 * wallet's signing guard decodes in full and binds to the reviewed receiver, chain and minimum:
 * Mayan Swift v2 only (EVM: src/core/swap/evmSwapGuard.ts assertLifiMayanEvmToSolana, MayanFacet
 * v2 + createOrderWithToken; Solana: solanaSwapGuard.ts, Swift v2 init_order). Mayan Fast MCTP
 * and MCTP are not requested: their destination amount depends on protocol fees no instruction
 * states (Fast MCTP's lives in program state; MCTP's on-chain IDL lacks the instruction LI.FI's
 * route uses), so the wallet cannot bind them to the minimum shown. Eco, NEAR Intents and the
 * rest pay deposit addresses no program checks. The wallet refuses every other tool, so asking
 * LI.FI for one would only turn a swap into "no route" at signing.
 */
export const LIFI_ALLOWED_BRIDGES: readonly string[] = ['mayan'];
/**
 * No DEX leg (round 2). A source-chain DEX swap returns whatever its own minimum — set by
 * whoever built the calldata — allows, into the bridge order; the wallet cannot bind that to the
 * price reviewed, so it refuses one. With allowExchanges=none LI.FI routes every Solana ⇄
 * Base/Arbitrum/Optimism pair the wallet offers through the fee step and the Swift order alone
 * (live quotes, 2026-09-27: all 12 EVM-source and all Solana-source pairs sampled).
 */
export const LIFI_ALLOWED_EXCHANGES = 'none';

interface LifiFeeSplit {
  lifiFee?: string;
  integratorFee?: string;
  recipients?: Array<{ name?: string; fee?: string }>;
}

export interface LifiQuoteView {
  action?: { fromChainId?: number; fromAmount?: string; fromToken?: { address?: string } };
  estimate?: {
    fromAmount?: string;
    feeCosts?: Array<{ name?: string; amount?: string; feeSplit?: LifiFeeSplit | null }> | null;
  };
  transactionRequest?: { data?: string } | null;
}

/**
 * Refuse a LI.FI quote unless its fee split pays Provian exactly 25 bps of the source amount and
 * pays no one but `provian` and LI.FI itself (the only other destination the operator allowed on this
 * route), AND the executable transaction itself moves exactly that amount to Provian:
 * - EVM source: the calldata carries the FeeForwarder recipient pair
 * (treasury address word, fee amount word) — the address alone is not enough.
 * - Solana source: an instruction transfers exactly the fee to the treasury — a System Program
 * transfer to PROVIAN_SOLANA_TREASURY for native SOL, an SPL Transfer/TransferChecked to the
 * treasury's USDC account for USDC. Any other Solana source token is refused.
 *
 * `solanaTx` is the decoded Solana source transaction; it is required when the source is Solana.
 */
export function verifyLifiQuoteFee(
  quote: LifiQuoteView,
  expected: {
    fromChain: number;
    fromAmount: string;
    fromToken: string;
    solanaTx?: DecodedSolanaTx;
    /**
     * Native-SOL source only: the rent-exempt minimum for a 0-byte account, passed ONLY when the
     * Solana treasury address holds 0 lamports. A transfer of less than that to an empty address
     * would fail, so LI.FI raises its fee transfer to exactly this amount; the excess is the
     * treasury deposit the user pays, reported as `treasuryDepositLamports`.
     */
    emptyTreasuryMinimum?: bigint;
  },
): { feeAmount: string; lifiFeeAmount: string; treasuryDepositLamports: string } {
  const costs = quote.estimate?.feeCosts ?? [];
  let integrator = 0n;
  let lifi = 0n;
  let splits = 0;
  for (const c of costs) {
    const split = c.feeSplit;
    if (!split) continue;
    splits += 1;
    for (const r of split.recipients ?? []) {
      if (r.name !== LIFI_INTEGRATOR && r.name !== 'lifi') {
        throw new SwapFeeError(
          'swap_fee_foreign_recipient',
          `LI.FI fee split pays "${String(r.name)}"; only provian and lifi are allowed`,
        );
      }
    }
    if (split.integratorFee !== undefined) integrator += BigInt(positiveOrZero(split.integratorFee));
    if (split.lifiFee !== undefined) lifi += BigInt(positiveOrZero(split.lifiFee));
    const named = (split.recipients ?? []).find((r) => r.name === LIFI_INTEGRATOR);
    if (split.integratorFee && BigInt(split.integratorFee) > 0n) {
      if (!named || named.fee !== split.integratorFee) {
        throw new SwapFeeError('swap_fee_wrong_recipient', 'LI.FI integrator fee is not assigned to provian');
      }
    }
  }
  if (splits === 0 || integrator <= 0n) {
    throw new SwapFeeError('swap_fee_missing', 'LI.FI quote carries no Provian fee; refusing it');
  }
  const want = (BigInt(positiveUint(expected.fromAmount, 'fromAmount')) * BigInt(SWAP_FEE_BPS)) / 10_000n;
  const diff = integrator > want ? integrator - want : want - integrator;
  if (diff > 1n) {
    throw new SwapFeeError('swap_fee_wrong_rate', `LI.FI Provian fee ${integrator} is not 25 bps (${want}); refusing it`);
  }
  let treasuryDeposit = 0n;
  if (expected.fromChain === LIFI_SOLANA_CHAIN_ID) {
    if (!expected.solanaTx) {
      throw new SwapFeeError('lifi_tx_missing', 'LI.FI returned no Solana transaction');
    }
    let destination: string;
    let kind: 'system' | 'spl';
    if (expected.fromToken === LIFI_SOLANA_NATIVE_TOKEN) {
      destination = PROVIAN_SOLANA_TREASURY;
      kind = 'system';
    } else if (expected.fromToken === SOLANA_USDC_MINT) {
      destination = PROVIAN_SOLANA_USDC_FEE_ACCOUNT;
      kind = 'spl';
    } else {
      throw new SwapFeeError('unsupported_solana_source', 'Solana-source swaps support SOL and USDC only', 400);
    }
    const topUp = kind === 'system' && expected.emptyTreasuryMinimum !== undefined && expected.emptyTreasuryMinimum > integrator
      ? expected.emptyTreasuryMinimum
      : null;
    if (findSolanaFeeTransfer(expected.solanaTx, { kind, destination, amount: integrator })) {
      treasuryDeposit = 0n;
    } else if (topUp !== null && findSolanaFeeTransfer(expected.solanaTx, { kind, destination, amount: topUp })) {
      treasuryDeposit = topUp - integrator;
    } else {
      throw new SwapFeeError(
        'swap_fee_wrong_recipient',
        'LI.FI Solana transaction does not transfer the Provian fee to the Solana treasury',
      );
    }
  } else {
    const data = (quote.transactionRequest?.data ?? '').toLowerCase();
    const pair = '0'.repeat(24) + PROVIAN_TREASURY.slice(2) + integrator.toString(16).padStart(64, '0');
    if (!data.includes(pair)) {
      throw new SwapFeeError('swap_fee_wrong_recipient', 'LI.FI calldata does not pay the Provian fee to the EVM treasury');
    }
  }
  return { feeAmount: integrator.toString(), lifiFeeAmount: lifi.toString(), treasuryDepositLamports: treasuryDeposit.toString() };
}

/**
 * True when the transaction contains a single instruction that moves exactly `amount` to
 * `destination` — a System Program transfer (native SOL) or an SPL Transfer / TransferChecked
 * (token). The destination must be a static, writable key; one resolved through an address lookup
 * table is not accepted (fail closed).
 */
export function findSolanaFeeTransfer(
  tx: DecodedSolanaTx,
  want: { kind: 'system' | 'spl'; destination: string; amount: bigint },
): boolean {
  const destIdx = tx.staticKeys.indexOf(want.destination);
  if (destIdx < 0 || !tx.isWritable(destIdx)) return false;
  return tx.instructions.some((ix) => {
    const program = tx.staticKeys[ix.programIdIndex];
    const d = ix.data;
    if (want.kind === 'system') {
      if (program !== SOLANA_SYSTEM_PROGRAM_ID || d.length < 12) return false;
      const disc = d[0] | (d[1] << 8) | (d[2] << 16) | (d[3] << 24);
      return disc === 2 && ix.accounts[1] === destIdx && readU64(d, 4) === want.amount;
    }
    if (!SOLANA_TOKEN_PROGRAM_IDS.has(program) || d.length < 9) return false;
    if (d[0] === 3) return ix.accounts[1] === destIdx && readU64(d, 1) === want.amount; // Transfer
    if (d[0] === 12) return ix.accounts[2] === destIdx && readU64(d, 1) === want.amount; // TransferChecked
    return false;
  });
}

function readU64(d: Uint8Array, at: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[at + i]);
  return v;
}

function positiveOrZero(v: string): string {
  if (!UINT_STRING.test(v)) throw new SwapFeeError('swap_fee_malformed', 'LI.FI fee amount is malformed');
  return v;
}

// =============================================================================
// Jupiter (same-chain Solana)
// =============================================================================

const BASE58_PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * The fee is taken in one mint of the pair, into the treasury's associated token account for that
 * mint. Jupiter allows either side of an ExactIn swap. Order, first match wins:
 * USDC (the pinned E8WkRW… account) → SOL (wrapped) → the input mint → the output mint.
 * Any SPL mint qualifies, classic or Token-2022 (: a Token-2022 fee mint is
 * allowed, and a transfer fee on it reduces what the treasury receives). A Token-2022 fee account
 * needs Jupiter's V2 route instruction (without it the swap fails on-chain, custom 6014).
 */
export interface JupiterFeePlan {
  feeMint: string;
  feeAccount: string;
  /** The token program that owns the fee mint (and so the fee account). */
  tokenProgram: string;
}

/** What the relay read from chain about a mint. */
export interface SolanaMintInfo {
  program: string;
  /** Token-2022 extension names as jsonParsed reports them (empty for classic). */
  extensions: string[];
  /** DefaultAccountState = frozen: a newly created account of this mint cannot receive. */
  defaultFrozen: boolean;
}

export interface JupiterOrderRequest {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps: number;
  userPublicKey: string;
}

/** Validate a client's Jupiter order request. Any two distinct Solana mints; the fee is set later. */
export function parseJupiterOrderRequest(body: Record<string, unknown>): JupiterOrderRequest {
  const { inputMint, outputMint, amount, slippageBps, userPublicKey } = body;
  if (typeof inputMint !== 'string' || typeof outputMint !== 'string'
    || !isSolanaPubkey(inputMint) || !isSolanaPubkey(outputMint) || inputMint === outputMint) {
    throw new SwapFeeError('unsupported_pair', 'inputMint and outputMint must be two different Solana mints', 400);
  }
  if (typeof userPublicKey !== 'string' || !isSolanaPubkey(userPublicKey)) {
    throw new SwapFeeError('invalid_request', 'userPublicKey must be a Solana address', 400);
  }
  const slip = typeof slippageBps === 'number' ? slippageBps : Number(slippageBps);
  if (!Number.isInteger(slip) || slip < 0 || slip > 5000) {
    throw new SwapFeeError('invalid_request', 'slippageBps must be an integer 0–5000', 400);
  }
  return {
    inputMint,
    outputMint,
    amount: positiveUint(amount, 'amount'),
    slippageBps: slip,
    userPublicKey,
  };
}

function isSolanaPubkey(s: string): boolean {
  if (!BASE58_PUBKEY.test(s)) return false;
  try {
    base58Decode32(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pick the fee mint and the treasury account it lands in. `mints` holds what the relay read from
 * chain for each mint of the order. `skip` removes a candidate (a mint whose new treasury account
 * would be created frozen), moving to the next in the order.
 */
export function planJupiterFee(
  order: JupiterOrderRequest,
  mints: Record<string, SolanaMintInfo | undefined>,
  skip: ReadonlySet<string> = new Set(),
): JupiterFeePlan {
  for (const mint of [order.inputMint, order.outputMint]) {
    const program = mints[mint]?.program;
    if (!program || !SOLANA_TOKEN_PROGRAM_IDS.has(program)) {
      throw new SwapFeeError('unsupported_mint', `${mint} is not an SPL token mint`, 400);
    }
  }
  const pair = [order.inputMint, order.outputMint];
  const candidates = [SOLANA_USDC_MINT, SOLANA_WSOL_MINT, order.inputMint, order.outputMint];
  const feeMint = candidates.find((m) => pair.includes(m) && !skip.has(m));
  if (!feeMint) {
    throw new SwapFeeError('unsupported_pair', 'no side of this pair can receive the 25 bps fee', 400);
  }
  const tokenProgram = mints[feeMint]!.program;
  const feeAccount = associatedTokenAddress(PROVIAN_SOLANA_TREASURY, feeMint, tokenProgram);
  if (feeMint === SOLANA_USDC_MINT && feeAccount !== PROVIAN_SOLANA_USDC_FEE_ACCOUNT) {
    throw new SwapFeeError('swap_fee_wrong_recipient', 'derived USDC fee account does not match the pinned account', 503);
  }
  return { feeMint, feeAccount, tokenProgram };
}

/**
 * Bytes of a new associated token account for a mint. Classic SPL: 165. Token-2022: the 165-byte
 * base, the account-type byte, and a 4-byte TLV header per account extension the token program
 * adds at creation: ImmutableOwner (always, for an ATA) plus the ones its mint's extensions
 * require — TransferFeeAmount (8), TransferHookAccount (1), NonTransferableAccount (0),
 * PausableAccount (0). The other mint extensions add nothing at creation (a PYUSD account is 187
 * bytes on mainnet, which this reproduces). An extension name not listed here is refused: the
 * relay will not state a deposit it cannot compute.
 */
export function tokenAccountSize(mint: SolanaMintInfo): number {
  if (mint.program === SOLANA_TOKEN_PROGRAM_ID) return 165;
  if (mint.program !== SOLANA_TOKEN_2022_PROGRAM_ID) {
    throw new SwapFeeError('unsupported_mint', 'mint is not owned by an SPL token program', 400);
  }
  let size = 165 + 1 + 4; // base + account type + ImmutableOwner
  for (const ext of mint.extensions) {
    if (!Object.prototype.hasOwnProperty.call(TOKEN_2022_ACCOUNT_EXTENSION_BYTES, ext)) {
      throw new SwapFeeError('unsupported_mint', `unrecognised Token-2022 extension ${ext}`, 400);
    }
    const bytes = TOKEN_2022_ACCOUNT_EXTENSION_BYTES[ext];
    if (bytes !== null) size += 4 + bytes;
  }
  return size;
}

/** Mint extension → bytes of the account extension it adds at creation (null = adds none). */
const TOKEN_2022_ACCOUNT_EXTENSION_BYTES: Readonly<Record<string, number | null>> = {
  transferFeeConfig: 8,
  transferHook: 1,
  nonTransferable: 0,
  pausableConfig: 0,
  mintCloseAuthority: null,
  confidentialTransferMint: null,
  confidentialTransferFeeConfig: null,
  confidentialMintBurn: null,
  defaultAccountState: null,
  interestBearingConfig: null,
  permanentDelegate: null,
  metadataPointer: null,
  tokenMetadata: null,
  groupPointer: null,
  tokenGroup: null,
  groupMemberPointer: null,
  tokenGroupMember: null,
  scaledUiAmountConfig: null,
};

/**
 * Route sizes to ask Jupiter for, in order, when the treasury's fee account must be created in the
 * same transaction and the route Jupiter picked leaves no room for the create (1232-byte cap). A
 * smaller `maxAccounts` gives a route with fewer accounts; the first that fits is used.
 */
export const JUPITER_ROOM_MAX_ACCOUNTS: readonly number[] = [40, 24];

/**
 * The Jupiter /quote query. ExactIn only (so the fee may sit on either side), fee forced. A
 * Token-2022 fee account needs the V2 route instruction. `maxAccounts` is set only by the relay.
 */
export function buildJupiterQuoteQuery(order: JupiterOrderRequest, plan: JupiterFeePlan, maxAccounts?: number): URLSearchParams {
  const q = new URLSearchParams({
    inputMint: order.inputMint,
    outputMint: order.outputMint,
    amount: order.amount,
    slippageBps: String(order.slippageBps),
    swapMode: 'ExactIn',
    platformFeeBps: String(SWAP_FEE_BPS),
  });
  if (plan.tokenProgram === SOLANA_TOKEN_2022_PROGRAM_ID) q.set('instructionVersion', 'V2');
  if (maxAccounts !== undefined) q.set('maxAccounts', String(maxAccounts));
  return q;
}

export interface JupiterQuoteView {
  inputMint?: string;
  outputMint?: string;
  inAmount?: string;
  outAmount?: string;
  otherAmountThreshold?: string;
  swapMode?: string;
  platformFee?: { amount?: string; feeBps?: number } | null;
}

/**
 * Refuse a Jupiter quote that is not the relay's order at 25 bps, and return the fee Provian
 * actually takes, on the side of the fee mint:
 *   fee mint = output: exactly quote.platformFee.amount of the output mint.
 *   fee mint = input:  exactly floor(inAmount × 25 / 10_000) of the input mint.
 * (Both matched a mainnet simulateTransaction to the unit, SOL⇄USDC and non-USDC pairs alike.)
 */
export function verifyJupiterQuote(
  quote: JupiterQuoteView,
  order: JupiterOrderRequest,
  feeMint: string,
): { feeAmount: string; feeSide: 'input' | 'output' } {
  if (quote.inputMint !== order.inputMint || quote.outputMint !== order.outputMint
    || quote.inAmount !== order.amount || quote.swapMode !== 'ExactIn') {
    throw new SwapFeeError('jupiter_quote_mismatch', 'Jupiter quote does not match the order; refusing it');
  }
  if (!quote.platformFee || quote.platformFee.feeBps !== SWAP_FEE_BPS) {
    throw new SwapFeeError('swap_fee_missing', 'Jupiter quote carries no 25 bps platform fee; refusing it');
  }
  positiveUint(quote.outAmount, 'outAmount');
  if (feeMint === order.outputMint) {
    return { feeAmount: positiveUint(quote.platformFee.amount, 'platformFee.amount'), feeSide: 'output' };
  }
  if (feeMint !== order.inputMint) {
    throw new SwapFeeError('swap_fee_wrong_recipient', 'fee mint is not a side of the swap');
  }
  const fee = (BigInt(order.amount) * BigInt(SWAP_FEE_BPS)) / 10_000n;
  if (fee <= 0n) {
    throw new SwapFeeError('amount_too_small', 'amount is too small to carry the swap fee', 400);
  }
  return { feeAmount: fee.toString(), feeSide: 'input' };
}

/** The Jupiter /swap body. The fee account is set here, never taken from the client. */
export function buildJupiterSwapBody(quote: unknown, userPublicKey: string, feeAccount: string): Record<string, unknown> {
  return {
    quoteResponse: quote,
    userPublicKey,
    feeAccount,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
  };
}

/**
 * Refuse the Jupiter-built transaction unless the user pays for it, the fee account is a static
 * writable key, and that key is an account of a Jupiter program instruction.
 */
export function verifyJupiterTransaction(txBase64: string, userPublicKey: string, feeAccount: string): void {
  let tx: DecodedSolanaTx;
  try {
    tx = decodeSolanaTransaction(Buffer.from(txBase64, 'base64'));
  } catch {
    throw new SwapFeeError('jupiter_tx_malformed', 'Jupiter transaction could not be decoded');
  }
  if (tx.staticKeys[0] !== userPublicKey || tx.header.numRequiredSignatures < 1 || !tx.isWritable(0)) {
    throw new SwapFeeError('jupiter_tx_wrong_payer', 'Jupiter transaction is not paid by the user');
  }
  const feeIdx = tx.staticKeys.indexOf(feeAccount);
  if (feeIdx < 0 || !tx.isWritable(feeIdx)) {
    throw new SwapFeeError('swap_fee_wrong_recipient', 'Jupiter transaction does not pay the Solana fee account');
  }
  const jupIdx = tx.staticKeys.indexOf(JUPITER_PROGRAM_ID);
  const used = tx.instructions.some((ix) => ix.programIdIndex === jupIdx && ix.accounts.includes(feeIdx));
  if (jupIdx < 0 || !used) {
    throw new SwapFeeError('swap_fee_wrong_recipient', 'Jupiter instruction does not reference the fee account');
  }
}

/** Addresses stored in an on-chain address lookup table account (56-byte header, then keys). */
export function parseLookupTableAddresses(owner: string, dataBase64: string): string[] {
  if (owner !== SOLANA_LOOKUP_TABLE_PROGRAM_ID) {
    throw new SwapFeeError('jupiter_tx_malformed', 'lookup table is not owned by the lookup table program');
  }
  const data = Buffer.from(dataBase64, 'base64');
  if (data.length < 56 || (data.length - 56) % 32 !== 0) {
    throw new SwapFeeError('jupiter_tx_malformed', 'lookup table account data is malformed');
  }
  const out: string[] = [];
  for (let o = 56; o < data.length; o += 32) out.push(base58Encode(data.subarray(o, o + 32)));
  return out;
}

/**
 * Jupiter only pays into an initialised fee account, and fails the whole swap on-chain when it is
 * missing (custom error 6025, observed 2026-09-25). So when the treasury has no account for the
 * fee mint yet, the relay puts an idempotent create of it at the front of the user's swap
 * transaction: the account is created for the treasury (owner PROVIAN_SOLANA_TREASURY, rent paid
 * by the user) and the fee lands in it in the same atomic transaction. Nothing else in the
 * transaction changes except the account indexes the new keys shift.
 *
 * `lookupTables` maps each lookup table the transaction uses to its on-chain addresses, so a key
 * already loaded through a table is referenced there rather than added twice.
 */
export function addFeeAccountCreation(
  txBase64: string,
  lookupTables: Record<string, string[]>,
  args: { userPublicKey: string; feeMint: string; feeAccount: string; tokenProgram: string },
): string {
  if (!SOLANA_TOKEN_PROGRAM_IDS.has(args.tokenProgram)
    || associatedTokenAddress(PROVIAN_SOLANA_TREASURY, args.feeMint, args.tokenProgram) !== args.feeAccount) {
    throw new SwapFeeError('swap_fee_wrong_recipient', 'fee account is not the treasury account for the fee mint', 503);
  }
  verifyJupiterTransaction(txBase64, args.userPublicKey, args.feeAccount);
  const tx = decodeSolanaTransaction(Buffer.from(txBase64, 'base64'));

  const loaded: string[] = [];
  for (const kind of ['writable', 'readonly'] as const) {
    for (const l of tx.lookups) {
      const table = lookupTables[l.tableKey];
      if (!table) throw new SwapFeeError('jupiter_tx_malformed', 'lookup table contents missing');
      for (const i of kind === 'writable' ? l.writableIndexes : l.readonlyIndexes) {
        if (i >= table.length) throw new SwapFeeError('jupiter_tx_malformed', 'lookup table index out of range');
        loaded.push(table[i]);
      }
    }
  }
  const staticCount = tx.staticKeys.length;
  const appended: string[] = [];
  // Returns the NEW message index of a key the instruction reads (never needs write/sign).
  const readonlyIndex = (key: string, mustBeStatic: boolean): number => {
    const s = tx.staticKeys.indexOf(key);
    if (s >= 0) return s;
    const l = loaded.indexOf(key);
    if (l >= 0) {
      if (mustBeStatic) throw new SwapFeeError('jupiter_tx_malformed', 'program id is only reachable through a lookup table');
      return -1 - l; // resolved after `appended` is final
    }
    let a = appended.indexOf(key);
    if (a < 0) {
      appended.push(key);
      a = appended.length - 1;
    }
    return staticCount + a;
  };
  const feeIdx = tx.staticKeys.indexOf(args.feeAccount); // static + writable, checked above
  const raw = [
    0, // funder = user, signer + writable (checked above)
    feeIdx,
    readonlyIndex(PROVIAN_SOLANA_TREASURY, false),
    readonlyIndex(args.feeMint, false),
    readonlyIndex(SOLANA_SYSTEM_PROGRAM_ID, false),
    readonlyIndex(args.tokenProgram, false),
  ];
  const programIdx = readonlyIndex(SOLANA_ATA_PROGRAM_ID, true);
  const shift = appended.length;
  const resolve = (i: number) => (i < 0 ? staticCount + shift + (-1 - i) : i);
  const remap = (i: number) => (i >= staticCount ? i + shift : i);

  const out: DecodedSolanaTx = {
    ...tx,
    staticKeys: [...tx.staticKeys, ...appended],
    header: { ...tx.header, numReadonlyUnsigned: tx.header.numReadonlyUnsigned + shift },
    instructions: [
      { programIdIndex: programIdx, accounts: raw.map(resolve), data: Uint8Array.of(1) }, // CreateIdempotent
      ...tx.instructions.map((ix) => ({ ...ix, programIdIndex: remap(ix.programIdIndex), accounts: ix.accounts.map(remap) })),
    ],
  };
  const bytes = encodeSolanaTransaction(out);
  if (bytes.length > SOLANA_MAX_TX_BYTES) {
    throw new SwapFeeError('jupiter_tx_too_large', 'swap transaction has no room to create the fee account', 503);
  }
  const b64 = Buffer.from(bytes).toString('base64');
  verifyJupiterTransaction(b64, args.userPublicKey, args.feeAccount);
  return b64;
}

// =============================================================================
// Minimal Solana wire decoding / encoding (no web3.js on the relay)
// =============================================================================

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

/** Decode a base58 Solana public key to its 32 bytes; throws unless it is exactly 32 bytes. */
export function base58Decode32(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const v = B58.indexOf(c);
    if (v < 0) throw new Error('bad base58');
    n = n * 58n + BigInt(v);
  }
  const body: number[] = [];
  while (n > 0n) {
    body.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  let zeros = 0;
  for (const c of s) {
    if (c !== '1') break;
    zeros += 1;
  }
  const out = [...new Array<number>(zeros).fill(0), ...body];
  if (out.length !== 32) throw new Error('not a 32-byte key');
  return Uint8Array.from(out);
}

// ed25519 field arithmetic — only to reject on-curve PDA candidates, exactly as findProgramAddress.
const ED_P = (1n << 255n) - 19n;
const ED_D = mod(-121665n * modInv(121666n));
const ED_SQRT_M1 = modPow(2n, (ED_P - 1n) / 4n);

function mod(a: bigint): bigint {
  const r = a % ED_P;
  return r >= 0n ? r : r + ED_P;
}
function modPow(b: bigint, e: bigint): bigint {
  let r = 1n;
  let x = mod(b);
  while (e > 0n) {
    if (e & 1n) r = (r * x) % ED_P;
    x = (x * x) % ED_P;
    e >>= 1n;
  }
  return r;
}
function modInv(a: bigint): bigint {
  return modPow(a, ED_P - 2n);
}

/** True when the 32 bytes decode to a point on ed25519 (RFC 8032 decoding, y < p required). */
export function isOnEd25519Curve(bytes: Uint8Array): boolean {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  const xOdd = (bytes[31] & 0x80) !== 0;
  if (y >= ED_P) return false;
  const y2 = (y * y) % ED_P;
  const u = mod(y2 - 1n);
  const v = mod(ED_D * y2 + 1n);
  const v3 = (v * v % ED_P) * v % ED_P;
  const v7 = (v3 * v3 % ED_P) * v % ED_P;
  let x = (u * v3 % ED_P) * modPow(u * v7, (ED_P - 5n) / 8n) % ED_P;
  const vx2 = (v * x % ED_P) * x % ED_P;
  if (vx2 === u) {
    // root found
  } else if (vx2 === mod(-u)) {
    x = (x * ED_SQRT_M1) % ED_P;
  } else {
    return false;
  }
  return !(x === 0n && xOdd);
}

/** Solana's findProgramAddress: the highest bump whose sha256 lands off the curve. */
export function findProgramAddress(seeds: Uint8Array[], programId: string): string {
  const program = base58Decode32(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash('sha256');
    for (const s of seeds) h.update(s);
    h.update(Uint8Array.of(bump));
    h.update(program);
    h.update(Buffer.from('ProgramDerivedAddress'));
    const candidate = new Uint8Array(h.digest());
    if (!isOnEd25519Curve(candidate)) return base58Encode(candidate);
  }
  throw new Error('no viable bump');
}

/** The associated token account of `owner` for `mint` under `tokenProgram` (classic by default). */
export function associatedTokenAddress(owner: string, mint: string, tokenProgram: string = SOLANA_TOKEN_PROGRAM_ID): string {
  return findProgramAddress(
    [base58Decode32(owner), base58Decode32(tokenProgram), base58Decode32(mint)],
    SOLANA_ATA_PROGRAM_ID,
  );
}

export interface DecodedSolanaTx {
  version: 'legacy' | 0;
  signatureCount: number;
  staticKeys: string[];
  header: { numRequiredSignatures: number; numReadonlySigned: number; numReadonlyUnsigned: number };
  recentBlockhash: Uint8Array;
  instructions: Array<{ programIdIndex: number; accounts: number[]; data: Uint8Array }>;
  lookups: Array<{ tableKey: string; writableIndexes: number[]; readonlyIndexes: number[] }>;
  isWritable(index: number): boolean;
}

/** Decode a signed-or-unsigned legacy / v0 Solana transaction far enough to read keys + instructions. */
export function decodeSolanaTransaction(buf: Uint8Array): DecodedSolanaTx {
  let o = 0;
  const need = (n: number) => {
    if (o + n > buf.length) throw new Error('truncated');
  };
  const compact = (): number => {
    let v = 0;
    for (let shift = 0; shift < 21; shift += 7) {
      need(1);
      const b = buf[o++];
      v |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return v;
    }
    throw new Error('bad compact-u16');
  };
  const sigs = compact();
  need(sigs * 64);
  o += sigs * 64;
  need(1);
  let version: 'legacy' | 0 = 'legacy';
  if (buf[o] & 0x80) {
    if ((buf[o] & 0x7f) !== 0) throw new Error('unsupported tx version');
    version = 0;
    o += 1;
  }
  need(3);
  const header = {
    numRequiredSignatures: buf[o],
    numReadonlySigned: buf[o + 1],
    numReadonlyUnsigned: buf[o + 2],
  };
  o += 3;
  const nKeys = compact();
  const staticKeys: string[] = [];
  for (let i = 0; i < nKeys; i++) {
    need(32);
    staticKeys.push(base58Encode(buf.subarray(o, o + 32)));
    o += 32;
  }
  need(32);
  const recentBlockhash = buf.slice(o, o + 32);
  o += 32;
  const nIx = compact();
  const instructions: Array<{ programIdIndex: number; accounts: number[]; data: Uint8Array }> = [];
  for (let i = 0; i < nIx; i++) {
    need(1);
    const programIdIndex = buf[o++];
    const nAcc = compact();
    need(nAcc);
    const accounts = Array.from(buf.subarray(o, o + nAcc));
    o += nAcc;
    const dataLen = compact();
    need(dataLen);
    const data = buf.slice(o, o + dataLen);
    o += dataLen;
    instructions.push({ programIdIndex, accounts, data });
  }
  const lookups: DecodedSolanaTx['lookups'] = [];
  if (version === 0) {
    const nLookups = compact();
    for (let i = 0; i < nLookups; i++) {
      need(32);
      const tableKey = base58Encode(buf.subarray(o, o + 32));
      o += 32;
      const nw = compact();
      need(nw);
      const writableIndexes = Array.from(buf.subarray(o, o + nw));
      o += nw;
      const nr = compact();
      need(nr);
      const readonlyIndexes = Array.from(buf.subarray(o, o + nr));
      o += nr;
      lookups.push({ tableKey, writableIndexes, readonlyIndexes });
    }
  }
  if (o !== buf.length) throw new Error('trailing bytes');
  const nLoadedWritable = lookups.reduce((n, l) => n + l.writableIndexes.length, 0);
  const isWritable = (i: number): boolean => {
    if (i < 0) return false;
    if (i < header.numRequiredSignatures) return i < header.numRequiredSignatures - header.numReadonlySigned;
    if (i < nKeys) return i < nKeys - header.numReadonlyUnsigned;
    return i < nKeys + nLoadedWritable;
  };
  return { version, signatureCount: sigs, staticKeys, header, recentBlockhash, instructions, lookups, isWritable };
}

/** Serialize a decoded transaction with blank signatures (the user signs it). */
export function encodeSolanaTransaction(tx: DecodedSolanaTx): Uint8Array {
  const out: number[] = [];
  const compact = (n: number) => {
    let v = n;
    for (;;) {
      const b = v & 0x7f;
      v >>= 7;
      if (v === 0) {
        out.push(b);
        return;
      }
      out.push(b | 0x80);
    }
  };
  const bytes = (b: Uint8Array | number[]) => {
    for (const x of b) out.push(x);
  };
  compact(tx.header.numRequiredSignatures);
  bytes(new Uint8Array(64 * tx.header.numRequiredSignatures));
  if (tx.version === 0) out.push(0x80);
  out.push(tx.header.numRequiredSignatures, tx.header.numReadonlySigned, tx.header.numReadonlyUnsigned);
  compact(tx.staticKeys.length);
  for (const k of tx.staticKeys) bytes(base58Decode32(k));
  bytes(tx.recentBlockhash);
  compact(tx.instructions.length);
  for (const ix of tx.instructions) {
    if (ix.programIdIndex > 255 || ix.accounts.some((a) => a > 255)) throw new Error('account index overflow');
    out.push(ix.programIdIndex);
    compact(ix.accounts.length);
    bytes(ix.accounts);
    compact(ix.data.length);
    bytes(ix.data);
  }
  if (tx.version === 0) {
    compact(tx.lookups.length);
    for (const l of tx.lookups) {
      bytes(base58Decode32(l.tableKey));
      compact(l.writableIndexes.length);
      bytes(l.writableIndexes);
      compact(l.readonlyIndexes.length);
      bytes(l.readonlyIndexes);
    }
  }
  return Uint8Array.from(out);
}
