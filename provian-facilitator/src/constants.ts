/**
 * Provian x402 facilitator — pinned constants.
 *
 * Every address here is PINNED in code, never read from an untrusted 402, a request body or a
 * seller profile. An environment variable may only narrow (e.g. name the deployed settler); it
 * can never point the fee or a payment somewhere else.
 */

export const X402_VERSION = 2 as const;

// ── Base ────────────────────────────────────────────────────────────────────────────────────
export const BASE_NETWORK = 'eip155:8453' as const;
export const BASE_CHAIN_ID = 8453;
/** Base native USDC (FiatToken v2.2 — EIP-3009 with the bytes-signature overload). */
export const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
/** The EIP-712 domain Base USDC signs under (never read from the 402). */
export const BASE_USDC_EIP712 = { name: 'USD Coin', version: '2' } as const;
/** Provian's PVT9 token on Base (successor). No EIP-3009 → paid through x402's Permit2 path. */
export const BASE_PVT = '0x8811441914381143b9408c5C32247367F86F173A' as const;
/** The facilitator's Base gas EOA: the settler's operator AND its fee recipient. */
export const BASE_GAS_WALLET = '0xA37fC594E98e951571C771C9e77CDC73f67d3efB' as const;
/** Provian's revenue wallet on Base (`PROVIAN_TREASURY`). Fee income above the gas buffer sweeps here. */
export const BASE_REVENUE_WALLET = '0x086e0f377af1245b8888540f39e99a42a7daf1da' as const;
/** Chainlink ETH/USD on Base (8 decimals). */
export const BASE_CHAINLINK_ETH_USD = '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70' as const;
/** OP-stack GasPriceOracle predeploy (the L1 data fee). */
export const OP_GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000F' as const;
/** Uniswap Permit2 and x402's exact Permit2 proxy (the spender a buyer's Permit2 signature names). */
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const;
export const X402_EXACT_PERMIT2_PROXY = '0x402085c248EeA27D92E8b30b2C58ed07f9E20001' as const;
/** 0x AllowanceHolder (the spender a 0x allowance-holder quote names on Base). */
export const ZEROX_ALLOWANCE_HOLDER = '0x0000000000001fF3684f28c67538d4D072C22734' as const;
/** Native ETH sentinel for 0x. */
export const ZEROX_NATIVE_ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' as const;

// ── Solana ──────────────────────────────────────────────────────────────────────────────────
export const SOLANA_NETWORK = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' as const;
export const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as const;
export const SOLANA_USDC_DECIMALS = 6;
/** The facilitator's Solana gas wallet: fee payer AND the owner of the USDC fee account. */
export const SOLANA_GAS_WALLET = 'DPB89TipwTCxFnQCdtvJE8cm8718jytvzyYEBfQP3t2' as const;
/** Provian's revenue wallet on Solana (the swap-fee wallet). */
export const SOLANA_REVENUE_WALLET = '5PHJDHYveHA1LhqiWpCDRVEgSezDgPBMyL1rwAoMBTco' as const;
export const SOLANA_WSOL_MINT = 'So11111111111111111111111111111111111111112' as const;
/**
 * SOL/USD: Pyth's on-chain push feed, read through our own Solana RPC (keyless — the public Hermes
 * HTTP endpoint answers 401 without an API key as of 2026-10). The account is the Pyth Push Oracle
 * PDA [shard 0 (u16 LE), feed id]; its owner must be the Pyth Solana Receiver program.
 */
export const PYTH_SOL_USD_FEED_ID = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d' as const;
export const PYTH_SOL_USD_PRICE_ACCOUNT = '7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE' as const;
export const PYTH_RECEIVER_PROGRAM = 'rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ' as const;
/** Solana's base fee per signature. */
export const SOLANA_LAMPORTS_PER_SIGNATURE = 5000n;

// ── Fee policy (the operator: "Fee = actual gas + $0.0003, no free tier") ──────────────────────────
/** $0.0003 in USDC atomic units (6 decimals). */
export const FEE_MARGIN_USDC_ATOMIC = 300n;
/** The settler's immutable cap (`ProvianX402FeeSettler.MAX_FEE`): $0.05. A fee above it is never submitted. */
export const MAX_FEE_USDC_ATOMIC = 50_000n;
/** Solana compute bounds the facilitator co-signs (priority fees are paid by the buyer through the fee). */
export const SOLANA_MAX_COMPUTE_UNITS = 400_000n;
export const SOLANA_MAX_PRIORITY_MICROLAMPORTS = 5_000_000n;
export const SOLANA_MAX_REQUIRED_SIGNATURES = 4;
/** A Solana fee quote is honored for this long (the margin then absorbs price moves; coverage is re-checked at the live price). */
export const SOLANA_QUOTE_TTL_MS = 5 * 60_000;

// ── Extensions ──────────────────────────────────────────────────────────────────────────────
export const PRESENTATION_EXTENSION_KEY = 'provian-presentation' as const;
/** x402 approval gas-sponsoring extensions. the operator: "No sponsored approvals." Payloads carrying them are refused. */
export const SPONSORED_APPROVAL_EXTENSION_KEYS = ['eip2612GasSponsoring', 'erc20ApprovalGasSponsoring'] as const;

export type ChainName = 'base' | 'solana';
