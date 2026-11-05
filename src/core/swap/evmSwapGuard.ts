/**
 * The EVM half of the swap signing guard. The app signs an aggregator transaction only
 * to a known router, and only one that does what the user reviewed.
 *
 * 0x v2, allowance-holder flow (SwapEngine):
 * - the approval spender and the transaction `to` are both AllowanceHolder, a fixed contract
 * per chain (0x's integration guide: 0x0000000000001fF3684f28c67538d4D072C22734 on every
 * Cancun chain, which Base, Arbitrum and Optimism are; bytecode read on each chain
 * 2026-09-26). An allowance to AllowanceHolder can only be spent inside an `exec` the owner
 * sends themselves, so it is never a standing drain;
 * - the calldata is `AllowanceHolder.exec(operator, token, amount, target, data)` with
 * operator == target == a GENUINE Settler. Settler addresses rotate, so they are never
 * pinned: the target must be what 0x's Deployer/registry
 * (0x00000000000004533Fe15556B1E086BB1A72cEae, same address on every chain) names today for
 * the taker-submitted feature (2) through `ownerOf(2)`, or `prev(2)` during 0x's dwell
 * period. A revert of either read means the feature is paused: refused;
 * - `token`/`amount` are exactly the sell token and amount the user reviewed, and the inner
 * `Settler.execute(slippage, actions, zid)` pays the user's own wallet at least the minimum
 * the user reviewed, in the token the user asked for. The Settler enforces that minimum
 * on-chain, so whatever else the actions do, the user receives at least what they saw.
 *
 * LI.FI, EVM source (CrossChainSwapEngine): the approval spender and the transaction `to` are
 * the LI.FI Diamond (0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE, the same on Base, Arbitrum and
 * Optimism; bytecode read on each chain 2026-09-26, and it is the `to` and `approvalAddress` of
 * every live LI.FI quote sampled from all three chains that day), and the transaction is for the
 * source chain the user chose. The Diamond calldata is decoded (round 2): the one LI.FI
 * bridge the relay requests is Mayan Swift v2 (allowBridges=mayan, allowExchanges=none), through
 * LI.FI's MayanFacet v2.0.0 (0x124Aa9169E6c0851a4A54D0ebb9158f2313d9Dd8, the facet the Diamond's
 * loupe names for both v2 selectors on all three chains; lifinance/contracts deployments/*.json).
 * What leaves the wallet is exactly the amount reviewed; the only source "swap" is LI.FI's
 * FeeForwarder v2.0.0 (0xCE40449B773a3E6E5e769ADb4e567179d4828cbd on all three chains, same
 * source) paying no more than the reviewed Provian fee to Provian's treasury and the reviewed
 * LI.FI fee to LI.FI; native ETH reaches the order only through Mayan's whitelisted wrapper
 * (`wrap()` into the chain's WETH, 1:1 within the reviewed slippage); and the Swift v2 order
 * (`createOrderWithToken`, Mayan's forwarder 0x337685fdaB40D39bd02028545a4FfA7D287cC3E2, whose
 * `mayanProtocols` names Swift v2 0x40fFE85A28DC9993541449464d7529a922142960) pays this
 * wallet's Solana key the reviewed token at least the reviewed minimum, refunds this wallet,
 * carries no payload and no referrer fee, and bounds its relayer fees.
 *
 * the same route carries Base ⇄ Arbitrum ⇄ Optimism. For an EVM destination the order
 * pays this wallet's own EVM address (BridgeData.receiver and the order's full 32-byte destAddr),
 * on the EVM chain picked (BridgeData.destinationChainId and the order's Wormhole destChainId),
 * in the token picked on THAT chain (tokenOut), with no other party as non-EVM receiver, no gas drop, and the
 * 25 bps Provian fee paid to the treasury exactly (assertLifiMayanEvmSource).
 *
 * : the Swift order's deadline must be in the future and at most an hour
 * away (Swift refunds an unfilled order only after its deadline; SWIFT_MAX_DEADLINE_SECONDS), the
 * reviewed Provian fee is no less than its 25 bps (assertReviewedLifiFees), LI.FI's no more than
 * its 25 bps, and every fee that is not Provian's goes to LI.FI's pinned collector.
 *
 * Every check throws SwapRouteRefusedError; callers run them BEFORE any approve or send.
 */

import { ethers } from 'ethers';
import { PROVIAN_EVM_TREASURY } from '../fees/FeeConfig';

export class SwapRouteRefusedError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
        super(message);
        this.name = 'SwapRouteRefusedError';
        this.code = code;
    }
}

/** 0x AllowanceHolder (Cancun chains). */
export const ZEROX_ALLOWANCE_HOLDER = '0x0000000000001fF3684f28c67538d4D072C22734';
/** Chains the in-app 0x engine swaps on, each mapped to its AllowanceHolder. */
export const ZEROX_ALLOWANCE_HOLDER_BY_CHAIN: Readonly<Record<number, string>> = {
    8453: ZEROX_ALLOWANCE_HOLDER, // Base
    42161: ZEROX_ALLOWANCE_HOLDER, // Arbitrum One
    10: ZEROX_ALLOWANCE_HOLDER, // Optimism
};
/** 0x Deployer/registry: `ownerOf(featureId)` is the current Settler, `prev(featureId)` the last. */
export const ZEROX_DEPLOYER = '0x00000000000004533Fe15556B1E086BB1A72cEae';
/** 0x Settler feature id for taker-submitted swaps (the allowance-holder flow). */
export const ZEROX_TAKER_SUBMITTED_FEATURE = 2;

/** LI.FI Diamond. */
export const LIFI_DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE';
export const LIFI_DIAMOND_BY_CHAIN: Readonly<Record<number, string>> = {
    8453: LIFI_DIAMOND,
    42161: LIFI_DIAMOND,
    10: LIFI_DIAMOND,
};

/** The native-ETH sentinel 0x v2 and Settler use for a native buy token. */
export const NATIVE_ETH_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_WORD = '0x' + '0'.repeat(64);

const ALLOWANCE_HOLDER_IFACE = new ethers.Interface([
    'function exec(address operator, address token, uint256 amount, address target, bytes data) payable returns (bytes)',
]);
const SETTLER_IFACE = new ethers.Interface([
    'function execute((address recipient, address buyToken, uint256 minAmountOut) slippage, bytes[] actions, bytes32 zidAndAffiliate) payable returns (bool)',
]);
const DEPLOYER_IFACE = new ethers.Interface([
    'function ownerOf(uint256 tokenId) view returns (address)',
    'function prev(uint128 featureId) view returns (address)',
]);

const same = (a: string | null | undefined, b: string | null | undefined): boolean =>
    typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/** A 0x allowance-holder transaction, decoded. */
export interface ZeroXExecution {
    settler: string;
    /** The token AllowanceHolder lets the Settler pull (0x0 / 0xEeee for a native sell). */
    token: string;
    amount: bigint;
    recipient: string;
    buyToken: string;
    minAmountOut: bigint;
}

/**
 * Decode a 0x v2 allowance-holder transaction and check its shape: `to` is this chain's
 * AllowanceHolder, the call is `exec` with operator == target, and the inner call is
 * `Settler.execute` with a non-zero minimum. Pure: no network.
 */
export function decodeZeroXAllowanceHolderTx(chainId: number, tx: { to: string; data: string }): ZeroXExecution {
    const holder = ZEROX_ALLOWANCE_HOLDER_BY_CHAIN[chainId];
    if (!holder) {
        throw new SwapRouteRefusedError('zerox_unsupported_chain', `0x swaps are not supported on chain ${chainId}`);
    }
    if (!same(tx.to, holder)) {
        throw new SwapRouteRefusedError('zerox_unknown_target', `swap transaction targets ${tx.to}, not 0x AllowanceHolder`);
    }
    let outer: ethers.Result;
    try {
        outer = ALLOWANCE_HOLDER_IFACE.decodeFunctionData('exec', tx.data);
    } catch {
        throw new SwapRouteRefusedError('zerox_unknown_call', 'swap calldata is not AllowanceHolder.exec');
    }
    const [operator, token, amount, target, inner] = outer as unknown as [string, string, bigint, string, string];
    if (!same(operator, target)) {
        throw new SwapRouteRefusedError('zerox_operator_mismatch', 'AllowanceHolder operator is not the Settler it calls');
    }
    let exec: ethers.Result;
    try {
        exec = SETTLER_IFACE.decodeFunctionData('execute', inner);
    } catch {
        throw new SwapRouteRefusedError('zerox_unknown_call', 'Settler calldata is not execute(slippage, actions, zid)');
    }
    const slippage = exec[0] as unknown as [string, string, bigint];
    const [recipient, buyToken, minAmountOut] = slippage;
    if (minAmountOut <= 0n) {
        throw new SwapRouteRefusedError('zerox_no_minimum', 'Settler call enforces no minimum amount out');
    }
    return { settler: ethers.getAddress(target), token, amount, recipient, buyToken, minAmountOut };
}

/** What the user reviewed, in the terms the transaction must match. */
export interface ZeroXExpectation {
    /** ERC-20 sell token address, or 'native'. */
    sellToken: string | 'native';
    sellAmount: bigint;
    /** ERC-20 buy token address, or 'native'. */
    buyToken: string | 'native';
    /** The wallet that signs and must receive the output. */
    recipient: string;
    /** The wei the transaction sends. */
    value: bigint;
}

/** The decoded transaction moves exactly the reviewed sell leg and pays the reviewed buy leg to the user. */
export function assertZeroXExecutionMatches(exec: ZeroXExecution, want: ZeroXExpectation): void {
    if (want.sellToken === 'native') {
        if (!(same(exec.token, ZERO_ADDRESS) || same(exec.token, NATIVE_ETH_SENTINEL))) {
            throw new SwapRouteRefusedError('zerox_wrong_sell_token', 'native-ETH swap lets the Settler pull an ERC-20');
        }
        if (want.value !== want.sellAmount) {
            throw new SwapRouteRefusedError('zerox_wrong_value', 'native-ETH swap sends a value other than the amount reviewed');
        }
    } else {
        if (!same(exec.token, want.sellToken)) {
            throw new SwapRouteRefusedError('zerox_wrong_sell_token', 'swap pulls a token other than the one reviewed');
        }
        if (want.value !== 0n) {
            throw new SwapRouteRefusedError('zerox_wrong_value', 'ERC-20 swap also sends ETH');
        }
    }
    if (exec.amount !== want.sellAmount) {
        throw new SwapRouteRefusedError('zerox_wrong_amount', `swap pulls ${exec.amount}, not the ${want.sellAmount} reviewed`);
    }
    if (!same(exec.recipient, want.recipient)) {
        throw new SwapRouteRefusedError('zerox_wrong_recipient', 'swap pays its output to an address other than this wallet');
    }
    const buy = want.buyToken === 'native' ? NATIVE_ETH_SENTINEL : want.buyToken;
    if (!same(exec.buyToken, buy)) {
        throw new SwapRouteRefusedError('zerox_wrong_buy_token', 'swap pays out a token other than the one reviewed');
    }
}

/** The approval spender of a 0x allowance-holder quote is this chain's AllowanceHolder, nothing else. */
export function assertZeroXSpender(chainId: number, spender: string): void {
    const holder = ZEROX_ALLOWANCE_HOLDER_BY_CHAIN[chainId];
    if (!holder || !same(spender, holder)) {
        throw new SwapRouteRefusedError('zerox_unknown_spender', `approval spender ${spender} is not 0x AllowanceHolder`);
    }
}

/** A read-only `eth_call`. */
export type EthCall = (tx: { to: string; data: string }) => Promise<string>;

/**
 * The Settler is the one 0x's registry names for taker-submitted swaps now (`ownerOf(2)`) or
 * just before (`prev(2)`). Any failed read refuses: a revert means 0x paused the feature, and
 * an unreadable registry is not evidence of anything.
 */
export async function assertGenuineZeroXSettler(settler: string, call: EthCall): Promise<void> {
    const read = async (fn: 'ownerOf' | 'prev'): Promise<string> => {
        const data = DEPLOYER_IFACE.encodeFunctionData(fn, [ZEROX_TAKER_SUBMITTED_FEATURE]);
        let raw: string;
        try {
            raw = await call({ to: ZEROX_DEPLOYER, data });
        } catch {
            throw new SwapRouteRefusedError('zerox_registry_unavailable', `0x registry ${fn}(2) could not be read; not signing`);
        }
        try {
            return DEPLOYER_IFACE.decodeFunctionResult(fn, raw)[0] as string;
        } catch {
            throw new SwapRouteRefusedError('zerox_registry_unavailable', `0x registry ${fn}(2) returned no address; not signing`);
        }
    };
    const current = await read('ownerOf');
    if (same(current, settler) && !same(current, ZERO_ADDRESS)) return;
    const previous = await read('prev');
    if (same(previous, settler) && !same(previous, ZERO_ADDRESS)) return;
    throw new SwapRouteRefusedError('zerox_counterfeit_settler', `${settler} is not a 0x Settler the registry names`);
}

/**
 * A LI.FI EVM-source transaction goes to the LI.FI Diamond on the chain the user swaps from,
 * and any approval it needs is to the same Diamond.
 */
export function assertLifiEvmRoute(
    sourceChainId: number,
    txReq: { to?: string; chainId?: number },
    approvalAddress: string | undefined,
    needsApproval: boolean,
): void {
    const diamond = LIFI_DIAMOND_BY_CHAIN[sourceChainId];
    if (!diamond) {
        throw new SwapRouteRefusedError('lifi_unsupported_chain', `LI.FI swaps are not supported from chain ${sourceChainId}`);
    }
    if (txReq.chainId !== undefined && txReq.chainId !== sourceChainId) {
        throw new SwapRouteRefusedError('lifi_wrong_chain', `LI.FI transaction is for chain ${txReq.chainId}, not ${sourceChainId}`);
    }
    if (!same(txReq.to, diamond)) {
        throw new SwapRouteRefusedError('lifi_unknown_target', `swap transaction targets ${String(txReq.to)}, not the LI.FI Diamond`);
    }
    if (needsApproval && !same(approvalAddress, diamond)) {
        throw new SwapRouteRefusedError('lifi_unknown_spender', `approval spender ${String(approvalAddress)} is not the LI.FI Diamond`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// LI.FI EVM → Solana through Mayan Swift v2 (round 2)
//
// The Diamond calldata is decoded in full; the only call the wallet signs is MayanFacet v2
// (deployed facet 0x124Aa9169E6c0851a4A54D0ebb9158f2313d9Dd8 on Base, Arbitrum and Optimism —
// `facetAddress(0x80c65808)` / `facetAddress(0xb4875292)` read from the Diamond 2026-09-27; the
// v1 selectors route nowhere), whose ABI is LI.FI's published source (lifinance/contracts
// src/Facets/MayanFacet.sol v2.0.0, ILiFi.BridgeData, LibSwap.SwapData). Its Mayan call must be
// Swift v2 `createOrderWithToken` (selector 0xa3a30834 = keccak of the typed signature in that
// source) on Mayan's Swift v2 contract 0x40fFE85A28DC9993541449464d7529a922142960 (whitelisted
// by Mayan's forwarder 0x337685fdaB40D39bd02028545a4FfA7D287cC3E2 — the facet's MAYAN — on all
// three chains, `mayanProtocols(..) == true`). Every other facet, selector or Mayan protocol
// refuses. The relay asks LI.FI for exactly this set: allowBridges=mayan (swap-fees.ts).
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** LI.FI's receiver sentinel for a non-EVM destination (LiFiData.NON_EVM_ADDRESS). */
export const LIFI_NON_EVM_RECEIVER = '0x11f111f111f111F111f111f111F111f111f111F1';
/** LI.FI's chain id for Solana (LiFiData.LIFI_CHAIN_ID_SOLANA). */
export const LIFI_SOLANA_CHAIN_ID = 1151111081099710n;
/** Wormhole chain ids Mayan orders carry (Mayan swap-sdk `chains`). */
export const WORMHOLE_CHAIN_ID = { solana: 1, arbitrum: 23, optimism: 24, base: 30 } as const;
/** Wormhole chain id of each EVM chain the wallet bridges from/to. */
export const WORMHOLE_CHAIN_BY_EVM: Readonly<Record<number, number>> = {
    8453: WORMHOLE_CHAIN_ID.base,
    42161: WORMHOLE_CHAIN_ID.arbitrum,
    10: WORMHOLE_CHAIN_ID.optimism,
};
/** Mayan Swift v2 on Base / Arbitrum / Optimism. */
export const MAYAN_SWIFT_V2_EVM = '0x40fFE85A28DC9993541449464d7529a922142960';
/** Swift v2 createOrderWithToken(address,uint256,OrderParams,bytes). */
export const SWIFT_V2_CREATE_ORDER_WITH_TOKEN = '0xa3a30834';
/** The largest share of the order input its cancel + refund relayer fees may take (1%). */
export const MAX_RELAYER_FEE_BPS = 100n;

const BRIDGE_DATA =
    '(bytes32 transactionId, string bridge, string integrator, address referrer, address sendingAssetId, address receiver, uint256 minAmount, uint256 destinationChainId, bool hasSourceSwaps, bool hasDestinationCall)';
const SWAP_DATA =
    '(address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, bool requiresDeposit)';
const MAYAN_DATA =
    '(bytes32 nonEVMReceiver, address mayanProtocol, bytes protocolData, address swapProtocol, bytes swapData, address middleToken, uint256 minMiddleAmount, address refundRecipient, uint256 mayanAmountIn)';
const MAYAN_FACET_IFACE = new ethers.Interface([
    `function swapAndStartBridgeTokensViaMayan(${BRIDGE_DATA} bridgeData, ${SWAP_DATA}[] swapData, ${MAYAN_DATA} mayanData)`,
    `function startBridgeTokensViaMayan(${BRIDGE_DATA} bridgeData, ${MAYAN_DATA} mayanData)`,
]);
const SWIFT_V2_ORDER_TYPES = [
    'address',
    'uint256',
    'tuple(uint8 payloadType, bytes32 trader, bytes32 destAddr, uint16 destChainId, bytes32 referrerAddr, bytes32 tokenOut, uint64 minAmountOut, uint64 gasDrop, uint64 cancelFee, uint64 refundFee, uint64 deadline, uint8 referrerBps, uint8 auctionMode, bytes32 random)',
    'bytes',
];

/** Mayan's amounts carry at most 8 decimals (swap-sdk getAmountOfFractionalAmount). */
export function mayanNormalize(amount: bigint, decimals: number): bigint {
    return decimals > 8 ? amount / 10n ** BigInt(decimals - 8) : amount;
}
export function mayanDenormalize(amount: bigint, decimals: number): bigint {
    return decimals > 8 ? amount * 10n ** BigInt(decimals - 8) : amount;
}

/** An address or 32-byte key as the 32-byte word Mayan stores (EVM addresses left-padded). */
export function bytes32Of(addressOrHex: string): string {
    return ethers.zeroPadValue(addressOrHex, 32).toLowerCase();
}

/** LI.FI's FeeForwarder v2.0.0 (lifinance/contracts deployments: Base, Arbitrum, Optimism). */
export const LIFI_FEE_FORWARDER = '0xCE40449B773a3E6E5e769ADb4e567179d4828cbd';
const FEE_FORWARDER_IFACE = new ethers.Interface([
    'function forwardERC20Fees(address token, (address recipient, uint256 amount)[] distributions)', // 0x332d746b
    'function forwardNativeFees((address recipient, uint256 amount)[] distributions)', // 0x0e8ae67f
]);
/** Mayan's native-ETH wrapper: in the forwarder's `swapProtocols` whitelist on all three chains. */
export const MAYAN_WRAP_PROTOCOL = '0x529863940BF6065d8C122a550c2ff37c1cfeFa16';
const WRAP_SELECTOR = '0xd46eb119'; // wrap()
/** Canonical WETH per chain (= TOKEN_ADDRESSES[chain].WETH). */
export const WETH_BY_CHAIN: Readonly<Record<number, string>> = {
    8453: '0x4200000000000000000000000000000000000006',
    42161: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    10: '0x4200000000000000000000000000000000000006',
};

/** Where a LI.FI EVM-source Mayan route delivers (another EVM chain as well as Solana). */
export type LifiMayanDestination =
    /** This wallet's Solana public key as 0x + 64 hex. */
    | { kind: 'solana'; solanaReceiver: string }
    /** Another EVM chain the wallet holds (Base / Arbitrum / Optimism), paid to `evmAddress`. */
    | { kind: 'evm'; chainId: number };

/** What the user reviewed for a LI.FI EVM-source route, in the terms the calldata must match. */
export interface LifiEvmSourceExpectation {
    /** ERC-20 sell token, or 'native'. */
    sellToken: string | 'native';
    sellAmount: bigint;
    /** The wei the transaction sends. */
    value: bigint;
    /** This wallet's EVM address: pays, is refunded, is the Mayan trader (and the EVM receiver). */
    evmAddress: string;
    destination: LifiMayanDestination;
    /**
     * The token the user receives as Mayan's 32-byte word: a Solana mint (zero for native SOL),
     * or the token's address on the destination EVM chain, left-padded (zero for native ETH).
     */
    destToken: string;
    destDecimals: number;
    /** The guaranteed amount reviewed, in the destination token's atomic units. */
    minOutAtomic: bigint;
    /** The Provian and LI.FI fees reviewed, in the sell token's atomic units. */
    provianFee: bigint;
    lifiFee: bigint;
    /** The slippage the user chose, in basis points (the one the review displays). */
    slippageBps: number;
    /** The amount the review displays as received, destination atomic units. */
    toAmountAtomic: bigint;
}

/** What the user reviewed for a LI.FI EVM → Solana route (the shape). */
export type LifiEvmToSolanaExpectation = Omit<LifiEvmSourceExpectation, 'destination'> & {
    /** This wallet's Solana public key as 0x + 64 hex. */
    solanaReceiver: string;
};

/** Provian's integrator fee on every LI.FI route, in basis points (the relay's LIFI_FEE_FRACTION). */
export const LIFI_PROVIAN_FEE_BPS = 25n;
/** LI.FI's own fee on every LI.FI route the relay requests, in basis points (feeSplit.lifiFee). */
export const LIFI_OWN_FEE_BPS = 25n;

/**
 * LI.FI's fee collector: the one recipient of a LI.FI route's fee step other than Provian's
 * treasury, in every live LI.FI Mayan quote on file (42, 2026-09-27: 26 EVM → EVM and 16 EVM →
 * Solana, from Base, Arbitrum and Optimism), each paying it exactly LI.FI's 25 bps. It is an
 * externally owned account (no code on any of the three chains, read 2026-09-27). Pinned per
 * chain ( ): a fee paid to any other address is refused.
 */
export const LIFI_EVM_FEE_COLLECTOR: Readonly<Record<number, string>> = {
    8453: '0xC06ebbefD94032B85424D51906e2A335EFAe264B',
    42161: '0xC06ebbefD94032B85424D51906e2A335EFAe264B',
    10: '0xC06ebbefD94032B85424D51906e2A335EFAe264B',
};

/**
 * The reviewed LI.FI-route fees must be the fees the relay was asked to charge, both ways
 * ( ): Provian's integrator fee is 25 bps of the amount sent, floored, give
 * or take the relay's one unit of rounding (never less: a zero or shaved Provian fee is not the
 * route the relay verified), and LI.FI's own fee is at most 25 bps of it (+1 unit). Every live
 * quote on file pays each exactly floor(amount × 25 / 10 000).
 */
export function assertReviewedLifiFees(
    sellAmount: bigint,
    provianFee: bigint,
    lifiFee: bigint,
    codes: { low: string; high: string },
): void {
    const provianFloor = (sellAmount * LIFI_PROVIAN_FEE_BPS) / 10_000n;
    if (provianFee > provianFloor + 1n) {
        throw new SwapRouteRefusedError(codes.high, `the Provian fee ${provianFee} is more than 25 bps of ${sellAmount}`);
    }
    if (provianFee < provianFloor) {
        throw new SwapRouteRefusedError(codes.low, `the Provian fee ${provianFee} is less than 25 bps of ${sellAmount} (${provianFloor})`);
    }
    if (lifiFee < 0n || lifiFee > (sellAmount * LIFI_OWN_FEE_BPS) / 10_000n + 1n) {
        throw new SwapRouteRefusedError(codes.high, `LI.FI's fee ${lifiFee} is more than 25 bps of ${sellAmount}`);
    }
}

/**
 * The longest a Mayan Swift order may stay open ( ). Swift v2 refunds an
 * unfilled order only after its deadline: the destination contract's `cancelOrder` reverts
 * `DeadlineViolation` while `block.timestamp <= params.deadline` (SwiftDest, verified source at
 * 0xd78d199f8c402e7b5cc2abe278df0412400a3bae on Base, Arbitrum and Optimism — the emitter every
 * SwiftSource names for chains 23 / 24 / 30), and the source contract's `refundOrder` pays back
 * only on that cancel's Wormhole message (SwiftSource 0x40fFE85A…, which checks no deadline of
 * its own). So an order whose minimum no solver can meet locks the input until its deadline — a
 * uint64, i.e. up to forever. Every live order on file carries a deadline 716–901 s after
 * capture; one hour is the bound.
 */
export const SWIFT_MAX_DEADLINE_SECONDS = 3600n;

/** A Swift order's deadline must be in the future and at most an hour away (`nowSec`: Unix seconds). */
export function assertSwiftDeadline(deadline: bigint, nowSec: number, code: string): void {
    if (!Number.isFinite(nowSec) || nowSec <= 0) throw new SwapRouteRefusedError(code, 'no clock to check the order deadline against');
    const now = BigInt(Math.floor(nowSec));
    if (deadline <= now) {
        throw new SwapRouteRefusedError(code, `Swift order deadline ${deadline} has passed (now ${now})`);
    }
    if (deadline > now + SWIFT_MAX_DEADLINE_SECONDS) {
        throw new SwapRouteRefusedError(code, `Swift order deadline ${deadline} is more than ${SWIFT_MAX_DEADLINE_SECONDS} s away (now ${now}): an unfilled order would lock the funds until then`);
    }
}

/** The wall clock in Unix seconds (the default `nowSec` of every Swift check). */
export const unixNow = (): number => Math.floor(Date.now() / 1000);

/**
 * Swift auction modes the wallet signs (round 3): the ones every live LI.FI Mayan order
 * carries (2 = the regular auction, 3 = the same-asset mode on USDC → USDC). Any other mode is
 * refused: it changes who may fill the order and at what price.
 */
export const SWIFT_AUCTION_MODES: ReadonlySet<number> = new Set([2, 3]);

/**
 * The least a bridge order may guarantee for the amount the review displays: the displayed
 * amount less the displayed slippage, floored, in Mayan's 8-decimal units (both floors are the
 * requirement's own; the order's minimum is compared as stored, never rounded up).
 */
export function mayanFloorForShown(toAmountAtomic: bigint, slippageBps: number, destDecimals: number): bigint {
    if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
        throw new SwapRouteRefusedError('lifi_bad_slippage', `slippage ${slippageBps} bps is not a valid review`);
    }
    if (toAmountAtomic <= 0n) throw new SwapRouteRefusedError('lifi_min_out_below_shown', 'the review shows no amount received');
    return mayanNormalize((toAmountAtomic * BigInt(10_000 - slippageBps)) / 10_000n, destDecimals);
}

/**
 * Decode and check a LI.FI EVM-source transaction bridging to Solana through Mayan Swift v2.
 * Returns the minimum the Mayan order enforces, in destination atomic units (never above what
 * the order pays; the caller shows it as the guaranteed amount).
 */
export function assertLifiMayanEvmToSolana(
    sourceChainId: number,
    tx: { to?: string; data?: string; chainId?: number },
    want: LifiEvmToSolanaExpectation,
    tokenDecimals: Readonly<Record<string, number>>,
    nowSec: number = unixNow(),
): { minOutAtomic: bigint } {
    const { solanaReceiver, ...rest } = want;
    return assertLifiMayanEvmSource(sourceChainId, tx, { ...rest, destination: { kind: 'solana', solanaReceiver } }, tokenDecimals, nowSec);
}

/**
 * Decode and check a LI.FI EVM-source transaction through Mayan Swift v2, to Solana or to
 * another EVM chain. The order must deliver exactly the token reviewed, on exactly the
 * chain reviewed, to this wallet, at no less than the minimum reviewed.
 *
 * EVM destination (LI.FI MayanFacet v2.0.0 `_startBridge`): a BridgeData.receiver other than
 * NON_EVM_ADDRESS must equal `address(uint160(destAddr))` of the Swift order, and
 * `nonEVMReceiver` is never read. The wallet binds more tightly than the facet: BridgeData's
 * receiver and the order's whole 32-byte destAddr must both be this wallet's own EVM address (no
 * dirty upper bytes), `destinationChainId` the EVM chain picked, `nonEVMReceiver` zero or this wallet, the
 * order's destChainId that chain's Wormhole id, and its tokenOut the picked token on that chain.
 *
 * : the order's deadline is in the future and at most an hour past `nowSec`
 * (an unfillable order can be refunded only after it), Provian's fee is exactly its 25 bps (no
 * less), LI.FI's at most its 25 bps, and every fee not Provian's goes to LI.FI's pinned collector.
 *
 * Returns the minimum the Mayan order enforces, in destination atomic units.
 */
export function assertLifiMayanEvmSource(
    sourceChainId: number,
    tx: { to?: string; data?: string; chainId?: number },
    want: LifiEvmSourceExpectation,
    tokenDecimals: Readonly<Record<string, number>>,
    nowSec: number = unixNow(),
): { minOutAtomic: bigint } {
    const refuse = (code: string, message: string): never => {
        throw new SwapRouteRefusedError(code, message);
    };
    if (typeof tx.data !== 'string') refuse('lifi_unknown_call', 'LI.FI transaction has no calldata');
    let parsed: ethers.TransactionDescription | null = null;
    try {
        parsed = MAYAN_FACET_IFACE.parseTransaction({ data: tx.data as string });
    } catch {
        parsed = null;
    }
    if (!parsed) return refuse('lifi_unknown_facet', 'LI.FI call is not a Mayan bridge this wallet can check');
    const bd = parsed.args.bridgeData as unknown as {
        sendingAssetId: string; receiver: string; minAmount: bigint; destinationChainId: bigint;
        hasSourceSwaps: boolean; hasDestinationCall: boolean;
    };
    const md = parsed.args.mayanData as unknown as {
        nonEVMReceiver: string; mayanProtocol: string; protocolData: string; swapProtocol: string;
        middleToken: string; minMiddleAmount: bigint; refundRecipient: string;
    };
    const sellAsset = want.sellToken === 'native' ? ZERO_ADDRESS : want.sellToken;

    // Where the order must deliver: this wallet, on the chain the user picked.
    const dest = want.destination;
    let destAddrWord: string;
    let destWormholeChain: number;
    if (dest.kind === 'solana') {
        destAddrWord = dest.solanaReceiver.toLowerCase();
        destWormholeChain = WORMHOLE_CHAIN_ID.solana;
        // BridgeData: to Solana, to the non-EVM sentinel.
        if (!same(bd.receiver, LIFI_NON_EVM_RECEIVER)) refuse('lifi_wrong_receiver', 'bridge receiver is not the non-EVM sentinel');
        if (bd.destinationChainId !== LIFI_SOLANA_CHAIN_ID) refuse('lifi_wrong_destination', `bridge goes to chain ${bd.destinationChainId}, not Solana`);
    } else {
        const wormhole = WORMHOLE_CHAIN_BY_EVM[dest.chainId];
        if (wormhole === undefined) {
            return refuse('lifi_unsupported_chain', `chain ${dest.chainId} is not a chain this wallet bridges to`);
        }
        if (dest.chainId === sourceChainId) refuse('lifi_same_chain', 'a bridge back to the chain it starts on is not a cross-chain swap');
        destAddrWord = bytes32Of(want.evmAddress);
        destWormholeChain = wormhole;
        // BridgeData: this wallet's own EVM address, on the chain picked. MayanFacet checks it
        // against the order's destAddr; the wallet checks both against itself.
        if (!same(bd.receiver, want.evmAddress)) refuse('lifi_wrong_receiver', 'bridge receiver is not this wallet');
        if (bd.destinationChainId !== BigInt(dest.chainId)) {
            refuse('lifi_wrong_destination', `bridge goes to chain ${bd.destinationChainId}, not ${dest.chainId}`);
        }
    }
    if (bd.hasDestinationCall) refuse('lifi_destination_call', 'bridge carries a destination call');
    // The fees reviewed are the ones the relay asked for: Provian's integrator fee exactly its
    // 25 bps of the amount sent (the relay's 1 unit of rounding), LI.FI's at most its 25 bps.
    assertReviewedLifiFees(want.sellAmount, want.provianFee, want.lifiFee, { low: 'lifi_provian_fee', high: 'lifi_fee_exceeds_review' });
    const lifiCollector = LIFI_EVM_FEE_COLLECTOR[sourceChainId];
    if (!lifiCollector) refuse('lifi_unsupported_chain', `chain ${sourceChainId} has no known LI.FI fee collector`);

    // What leaves the wallet: exactly the reviewed token and amount, once.
    if (parsed.name === 'swapAndStartBridgeTokensViaMayan') {
        const swaps = parsed.args.swapData as unknown as Array<{
            callTo: string; approveTo: string; sendingAssetId: string; receivingAssetId: string;
            fromAmount: bigint; callData: string; requiresDeposit: boolean;
        }>;
        // Exactly one "swap": LI.FI's fee forwarder. A DEX leg could return any amount of any
        // token to the order (its own minimum is the relay's to set), so none is signed.
        if (!bd.hasSourceSwaps || swaps.length !== 1) refuse('lifi_bad_swaps', `the route carries ${swaps.length} source swaps; only LI.FI's fee forwarder is signed`);
        const fee = swaps[0];
        if (!same(fee.callTo, LIFI_FEE_FORWARDER) || !same(fee.approveTo, LIFI_FEE_FORWARDER)) {
            refuse('lifi_bad_swaps', `source swap calls ${fee.callTo}, not LI.FI's fee forwarder`);
        }
        if (!same(fee.sendingAssetId, sellAsset) || !same(fee.receivingAssetId, sellAsset)) {
            refuse('lifi_wrong_sell_token', 'the fee step spends or yields a token other than the one reviewed');
        }
        if (fee.fromAmount !== want.sellAmount) refuse('lifi_wrong_amount', `the route takes ${fee.fromAmount}, not the ${want.sellAmount} reviewed`);
        if (!fee.requiresDeposit) refuse('lifi_bad_swaps', 'the fee step does not take the deposit');
        let call: ethers.TransactionDescription | null = null;
        try {
            call = FEE_FORWARDER_IFACE.parseTransaction({ data: fee.callData });
        } catch {
            call = null;
        }
        const native = want.sellToken === 'native';
        if (!call || call.name !== (native ? 'forwardNativeFees' : 'forwardERC20Fees')) {
            return refuse('lifi_bad_swaps', 'the fee step is not a fee forward for the token reviewed');
        }
        if (!native && !same(call.args.token as string, sellAsset)) refuse('lifi_wrong_sell_token', 'the fee forward names another token');
        const dists = call.args.distributions as unknown as Array<{ recipient: string; amount: bigint }>;
        let total = 0n;
        let toOthers = 0n;
        for (const d of dists) {
            total += d.amount;
            if (same(d.recipient, PROVIAN_EVM_TREASURY)) continue;
            // Every fee that is not Provian's is LI.FI's, paid to LI.FI's own collector — never
            // a third party, a burn address, or an address the relay names ( ).
            if (!same(d.recipient, lifiCollector as string)) {
                refuse('lifi_fee_recipient', `the fee step pays ${d.recipient}, which is neither Provian's treasury nor LI.FI's fee collector`);
            }
            toOthers += d.amount;
        }
        if (total > want.provianFee + want.lifiFee || toOthers > want.lifiFee) {
            refuse('lifi_fee_exceeds_review', `the fee step pays ${total} (${toOthers} outside Provian's treasury), above the fees reviewed`);
        }
        // Provian's treasury receives exactly the integrator fee reviewed (the 25 bps is
        // bound in the calldata the wallet signs, not only by the relay).
        if (total - toOthers !== want.provianFee) {
            refuse('lifi_provian_fee', `the fee step pays Provian's treasury ${total - toOthers}, not the ${want.provianFee} reviewed`);
        }
        // What the order receives is what is left: every unit the user sent, less the fees.
        if (bd.minAmount !== want.sellAmount - total) {
            refuse('lifi_wrong_amount', `bridge carries ${bd.minAmount}, not the ${want.sellAmount - total} left after the reviewed fees`);
        }
    } else {
        // startBridgeTokensViaMayan has no fee step, so Provian's integrator fee would not be
        // paid: it is not the route the relay verified (the fee is bound here too).
        refuse('lifi_provian_fee', 'the route carries no fee step paying Provian\'s integrator fee');
    }
    if (want.sellToken === 'native' ? want.value !== want.sellAmount : want.value !== 0n) {
        refuse('lifi_wrong_value', 'transaction value is not the amount reviewed (native) or zero (ERC-20)');
    }

    // MayanData: this wallet's Solana key receives; this wallet is refunded; Swift v2 only. For an
    // EVM destination MayanFacet never reads nonEVMReceiver (only with the non-EVM sentinel); every
    // live LI.FI EVM → EVM quote (2026-09-27) sets it to this wallet's own address as a word, so
    // that, or zero, is all the wallet signs — never another party's word.
    const nonEvm = md.nonEVMReceiver.toLowerCase();
    const nonEvmOk = dest.kind === 'solana'
        ? nonEvm === dest.solanaReceiver.toLowerCase()
        : nonEvm === ZERO_WORD || nonEvm === bytes32Of(want.evmAddress);
    if (!nonEvmOk) {
        refuse('lifi_wrong_receiver', dest.kind === 'solana'
            ? 'Mayan receiver is not this wallet\'s Solana address'
            : 'an EVM-destination route names a non-EVM receiver');
    }
    if (!same(md.refundRecipient, want.evmAddress)) refuse('lifi_wrong_refund', 'refunds go to an address other than this wallet');
    if (!same(md.mayanProtocol, MAYAN_SWIFT_V2_EVM)) refuse('lifi_unknown_protocol', `Mayan protocol ${md.mayanProtocol} is not Swift v2`);
    const pd = md.protocolData;
    if (pd.slice(0, 10).toLowerCase() !== SWIFT_V2_CREATE_ORDER_WITH_TOKEN) {
        refuse('lifi_unknown_protocol', `Mayan call ${pd.slice(0, 10)} is not Swift v2 createOrderWithToken`);
    }
    let order: ethers.Result;
    try {
        order = ethers.AbiCoder.defaultAbiCoder().decode(SWIFT_V2_ORDER_TYPES, '0x' + pd.slice(10));
    } catch {
        return refuse('lifi_unknown_protocol', 'Swift v2 order could not be decoded');
    }
    const tokenIn = order[0] as string;
    const amountIn = order[1] as bigint;
    const p = order[2] as unknown as {
        payloadType: bigint; trader: string; destAddr: string; destChainId: bigint; tokenOut: string;
        minAmountOut: bigint; gasDrop: bigint; cancelFee: bigint; refundFee: bigint; deadline: bigint; referrerBps: bigint; auctionMode: bigint;
    };
    const customPayload = order[3] as string;
    // What enters the order: the sell token itself (ERC-20), or native ETH wrapped 1:1 into the
    // chain's WETH by Mayan's whitelisted wrapper. Never a DEX swap into another token.
    const mayanAmountIn = (parsed.args.mayanData as unknown as { mayanAmountIn: bigint }).mayanAmountIn;
    const swapData = (parsed.args.mayanData as unknown as { swapData: string }).swapData;
    if (mayanAmountIn !== bd.minAmount) refuse('lifi_wrong_amount', 'Mayan is handed another amount than the bridge carries');
    if (want.sellToken === 'native') {
        const weth = WETH_BY_CHAIN[sourceChainId];
        if (!same(md.swapProtocol, MAYAN_WRAP_PROTOCOL) || swapData.toLowerCase() !== WRAP_SELECTOR || !weth || !same(md.middleToken, weth)) {
            refuse('lifi_bad_swaps', 'native ETH reaches the order other than by wrapping into WETH');
        }
        if (md.minMiddleAmount * 10_000n < bd.minAmount * BigInt(10_000 - want.slippageBps)) {
            refuse('lifi_min_out_below_review', `the wrap may yield ${md.minMiddleAmount}, below ${bd.minAmount} less the reviewed slippage`);
        }
        // The order is created with the wrapped amount: between the wrap's floor and the ETH sent.
        if (amountIn < md.minMiddleAmount || amountIn > bd.minAmount) {
            refuse('lifi_wrong_amount', 'the order input is not the wrapped amount');
        }
    } else {
        if (!same(md.swapProtocol, ZERO_ADDRESS) || swapData !== '0x') refuse('lifi_bad_swaps', 'an ERC-20 route carries a Mayan source swap');
        if (!same(tokenIn, sellAsset)) refuse('lifi_wrong_sell_token', 'the order takes a token other than the one reviewed');
        if (amountIn !== bd.minAmount) refuse('lifi_wrong_amount', `the order takes ${amountIn}, not the ${bd.minAmount} the bridge carries`);
    }
    if (p.payloadType !== 1n || customPayload !== '0x') refuse('lifi_custom_payload', 'Swift order carries a custom payload');
    if (p.trader.toLowerCase() !== bytes32Of(want.evmAddress)) refuse('lifi_wrong_refund', 'Swift order trader (refund address) is not this wallet');
    if (p.destAddr.toLowerCase() !== destAddrWord) refuse('lifi_wrong_receiver', 'Swift order pays an address other than this wallet');
    if (p.destChainId !== BigInt(destWormholeChain)) {
        refuse('lifi_wrong_destination', `Swift order goes to Wormhole chain ${p.destChainId}, not ${destWormholeChain}`);
    }
    if (p.tokenOut.toLowerCase() !== want.destToken.toLowerCase()) refuse('lifi_wrong_buy_token', 'Swift order pays out a token other than the one reviewed');
    if (p.referrerBps !== 0n) refuse('lifi_referrer_fee', 'Swift order pays a referrer fee');
    // No gas drop : a destination-gas delivery the review does not show, priced into the
    // order. Every live LI.FI Mayan order, to Solana and to EVM, carries 0.
    if (p.gasDrop !== 0n) refuse('lifi_gas_drop', `Swift order asks for a ${p.gasDrop} gas drop the review does not show`);
    if (!SWIFT_AUCTION_MODES.has(Number(p.auctionMode))) refuse('lifi_auction_mode', `Swift order auction mode ${p.auctionMode} is not one the wallet signs`);
    // The order can be refunded only after its deadline, so it must be soon ( ).
    assertSwiftDeadline(p.deadline, nowSec, 'lifi_deadline');
    const reviewedMin = mayanNormalize(want.minOutAtomic, want.destDecimals);
    if (p.minAmountOut <= 0n || p.minAmountOut < reviewedMin) {
        refuse('lifi_min_out_below_review', `Swift order guarantees ${p.minAmountOut}, below the ${reviewedMin} reviewed`);
    }
    // The minimum is tied to what the review DISPLAYS, not only to the relay's toAmountMin: an
    // honest toAmount with a toAmountMin (and order minimum) far below it is refused.
    const shownFloor = mayanFloorForShown(want.toAmountAtomic, want.slippageBps, want.destDecimals);
    if (p.minAmountOut < shownFloor) {
        refuse('lifi_min_out_below_shown', `Swift order guarantees ${p.minAmountOut}, below ${shownFloor}: the amount shown less the slippage shown`);
    }
    // Cancel + refund relayer fees, in the order input's units, are bounded (an unfillable order
    // is refunded minus them). The input is the swapped middle token when Mayan swaps native first.
    const inputToken = md.swapProtocol !== ZERO_ADDRESS ? md.middleToken : tokenIn;
    const inputAmount = md.swapProtocol !== ZERO_ADDRESS ? md.minMiddleAmount : amountIn;
    const inputDecimals = same(inputToken, ZERO_ADDRESS) ? 18 : tokenDecimals[inputToken.toLowerCase()];
    if (inputDecimals === undefined) refuse('lifi_unknown_token', `Swift order input ${inputToken} is not a token this wallet knows`);
    const normIn = mayanNormalize(inputAmount, inputDecimals);
    if ((p.cancelFee + p.refundFee) * 10_000n > normIn * MAX_RELAYER_FEE_BPS) {
        refuse('lifi_relayer_fee', 'Swift order cancel/refund fees exceed 1% of its input');
    }
    return { minOutAtomic: mayanDenormalize(p.minAmountOut, want.destDecimals) };
}
