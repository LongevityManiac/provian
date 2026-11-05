/**
 * the LI.FI / Mayan Swift signing guard for EVM → EVM (Base ⇄ Arbitrum ⇄ Optimism),
 * against the 24 LIVE li.quest quotes captured with the relay's exact query
 * (__fixtures__/evm-evm-route-fixtures.json), each reviewed by the app's own review builder
 * (lifiReview.evmSourceExpectation) — and each made malicious.
 *
 * Verified against the published sources: LI.FI MayanFacet v2.0.0 `_startBridge` (a receiver
 * other than NON_EVM_ADDRESS must equal address(uint160(order.destAddr)); nonEVMReceiver unread)
 * and Mayan Swift v2 `createOrderWithToken(tokenIn, amountIn, OrderParams, customPayload)`.
 */
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { TOKEN_ADDRESSES } from '../../chains/evm/config';
import { PROVIAN_EVM_TREASURY } from '../../fees/FeeConfig';
import {
    SwapRouteRefusedError,
    WORMHOLE_CHAIN_BY_EVM,
    assertLifiEvmRoute,
    assertLifiMayanEvmSource,
    mayanNormalize,
    LIFI_EVM_FEE_COLLECTOR,
    SWIFT_MAX_DEADLINE_SECONDS,
    type LifiEvmSourceExpectation,
} from '../evmSwapGuard';
import { evmSourceExpectation, evmTokenDecimals } from '../lifiReview';
import { EVM_EVM, REQUIRED, assetOf, relayFees, type EvmEvmCapture } from './evmEvmFixtures';
import { captureSec, evmSwiftDeadline } from './swiftClock';

const ATTACKER = '0x000000000000000000000000000000000000dEaD';
const code = (fn: () => unknown): string => {
    try { fn(); return 'pass'; } catch (e) { if (e instanceof SwapRouteRefusedError) return e.code; throw e; }
};

/** The review the app builds for a capture: from the pair and amount entered, never the estimate. */
function reviewOf(c: EvmEvmCapture, over: { toAmountMin?: bigint } = {}): LifiEvmSourceExpectation {
    const fees = relayFees(c);
    return evmSourceExpectation(
        { fromAsset: assetOf(c.sourceChainId, c.sell), toAsset: assetOf(c.destChainId, c.buy), amount: c.amount, slippage: EVM_EVM.slippagePercent, evmAddress: EVM_EVM.user, solanaAddress: '' },
        c.quote!.transactionRequest.value,
        {
            minOutAtomic: over.toAmountMin ?? BigInt(c.quote!.estimate.toAmountMin),
            toAmountAtomic: BigInt(c.quote!.estimate.toAmount),
            provianFee: BigInt(fees.provianFee),
            lifiFee: BigInt(fees.lifiFee),
        },
    );
}
/** Each capture is checked at the moment it was captured (the Swift deadline is bound to the clock). */
function check(
    c: EvmEvmCapture,
    data = c.quote!.transactionRequest.data,
    over: Partial<LifiEvmSourceExpectation> = {},
    toAmountMin?: bigint,
    nowSec = captureSec(c.capturedAt),
): string {
    return code(() => assertLifiMayanEvmSource(c.sourceChainId, { ...c.quote!.transactionRequest, data }, { ...reviewOf(c, { toAmountMin }), ...over }, evmTokenDecimals(c.sourceChainId), nowSec));
}

const BD = '(bytes32 transactionId, string bridge, string integrator, address referrer, address sendingAssetId, address receiver, uint256 minAmount, uint256 destinationChainId, bool hasSourceSwaps, bool hasDestinationCall)';
const SD = '(address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, bool requiresDeposit)';
const MD = '(bytes32 nonEVMReceiver, address mayanProtocol, bytes protocolData, address swapProtocol, bytes swapData, address middleToken, uint256 minMiddleAmount, address refundRecipient, uint256 mayanAmountIn)';
const FACET = new ethers.Interface([
    `function swapAndStartBridgeTokensViaMayan(${BD} bridgeData, ${SD}[] swapData, ${MD} mayanData)`,
    `function startBridgeTokensViaMayan(${BD} bridgeData, ${MD} mayanData)`,
]);
const SWIFT = new ethers.Interface([
    'function createOrderWithToken(address tokenIn, uint256 amountIn, (uint8 payloadType, bytes32 trader, bytes32 destAddr, uint16 destChainId, bytes32 referrerAddr, bytes32 tokenOut, uint64 minAmountOut, uint64 gasDrop, uint64 cancelFee, uint64 refundFee, uint64 deadline, uint8 referrerBps, uint8 auctionMode, bytes32 random) params, bytes customPayload)',
]);
const FEES = new ethers.Interface(['function forwardERC20Fees(address token, (address recipient, uint256 amount)[] distributions)', 'function forwardNativeFees((address recipient, uint256 amount)[] distributions)']);
/** OrderParams, MayanData, BridgeData indices. */
const P = { trader: 1, destAddr: 2, destChainId: 3, tokenOut: 5, minAmountOut: 6, gasDrop: 7, deadline: 10, referrerBps: 11, auctionMode: 12 } as const;
const M = { nonEVMReceiver: 0, mayanProtocol: 1, protocolData: 2, refundRecipient: 7 } as const;
const B = { receiver: 5, destinationChainId: 7, hasDestinationCall: 9 } as const;

/** Re-encode a real LI.FI call with its bridge data, swaps, Mayan data or Swift order edited. */
function mutate(c: EvmEvmCapture, edit: (m: { bd: unknown[]; swaps: unknown[][]; md: unknown[]; order: unknown[]; params: unknown[] }) => void): string {
    const t = FACET.parseTransaction({ data: c.quote!.transactionRequest.data })!;
    const bd = [...(t.args.bridgeData as ethers.Result)];
    const swaps = t.name === 'swapAndStartBridgeTokensViaMayan' ? (t.args.swapData as ethers.Result[]).map((x) => [...x]) : [];
    const md = [...(t.args.mayanData as ethers.Result)];
    const o = SWIFT.decodeFunctionData('createOrderWithToken', md[M.protocolData] as string);
    const params = [...(o[2] as ethers.Result)];
    const order = [o[0], o[1], params, o[3]];
    edit({ bd, swaps, md, order, params });
    order[2] = params;
    md[M.protocolData] = SWIFT.encodeFunctionData('createOrderWithToken', order);
    return t.name === 'swapAndStartBridgeTokensViaMayan'
        ? FACET.encodeFunctionData(t.name, [bd, swaps, md])
        : FACET.encodeFunctionData(t.name, [bd, md]);
}
const word = (addr: string) => ethers.zeroPadValue(addr, 32);

describe('every live EVM → EVM quote is signed only as reviewed', () => {
    it('the population is the 24 required pairs: 6 directions × ETH/USDC in and out, every one quoted and relay-verified', () => {
        expect(REQUIRED.length).toBe(24);
        const dirs = new Set(REQUIRED.map((c) => `${c.sourceChainId}>${c.destChainId}`));
        expect(dirs.size).toBe(6);
        for (const c of REQUIRED) {
            expect(c.quote, `${c.pair}: ${c.message ?? ''}`).toBeDefined();
            expect(relayFees(c).provianFee).toMatch(/^[1-9][0-9]*$/);
        }
    });

    for (const c of REQUIRED) {
        it(`signs ${c.sell} on ${c.sourceChainId} → ${c.buy} on ${c.destChainId}: this wallet, the chain and token picked, at least the minimum shown`, () => {
            expect(code(() => assertLifiEvmRoute(c.sourceChainId, c.quote!.transactionRequest, c.quote!.estimate.approvalAddress, c.sell !== 'ETH'))).toBe('pass');
            const want = reviewOf(c);
            // What the app binds for this pair: the picked chain and token, from the canonical table.
            expect(want.destination).toEqual({ kind: 'evm', chainId: c.destChainId });
            expect(want.destToken).toBe(c.buy === 'ETH' ? ethers.ZeroHash : word(TOKEN_ADDRESSES[c.destChainId].USDC).toLowerCase());
            const out = assertLifiMayanEvmSource(c.sourceChainId, c.quote!.transactionRequest, want, evmTokenDecimals(c.sourceChainId), captureSec(c.capturedAt));
            const d = want.destDecimals;
            expect(mayanNormalize(out.minOutAtomic, d)).toBeGreaterThanOrEqual(mayanNormalize(BigInt(c.quote!.estimate.toAmountMin), d));
            // …and the order itself, decoded independently: this wallet, the Wormhole id of the chain picked.
            const t = FACET.parseTransaction({ data: c.quote!.transactionRequest.data })!;
            const o = SWIFT.decodeFunctionData('createOrderWithToken', (t.args.mayanData as ethers.Result)[M.protocolData] as string);
            const p = o[2] as ethers.Result;
            expect((p[P.destAddr] as string).toLowerCase()).toBe(word(EVM_EVM.user).toLowerCase());
            expect(Number(p[P.destChainId])).toBe(WORMHOLE_CHAIN_BY_EVM[c.destChainId]);
            expect(((t.args.bridgeData as ethers.Result)[B.receiver] as string).toLowerCase()).toBe(EVM_EVM.user.toLowerCase());
        });
    }

    it('the Wormhole ids are Mayan swap-sdk\'s: Base 30, Arbitrum 23, Optimism 24', () => {
        expect(WORMHOLE_CHAIN_BY_EVM).toEqual({ 8453: 30, 42161: 23, 10: 24 });
    });
});

describe('each live EVM → EVM quote made malicious is refused', () => {
    const uu = REQUIRED.find((c) => c.sourceChainId === 8453 && c.destChainId === 42161 && c.sell === 'USDC' && c.buy === 'USDC')!;
    const ee = REQUIRED.find((c) => c.sourceChainId === 42161 && c.destChainId === 10 && c.sell === 'ETH' && c.buy === 'ETH')!;
    const ue = REQUIRED.find((c) => c.sourceChainId === 10 && c.destChainId === 8453 && c.sell === 'USDC' && c.buy === 'ETH')!;

    it('controls: the unmodified quotes sign', () => {
        for (const c of [uu, ee, ue]) expect(check(c)).toBe('pass');
    });

    it('RED: an attacker destAddr (alone, or with BridgeData.receiver moved to match, which MayanFacet itself would accept)', () => {
        for (const c of [uu, ee, ue]) {
            expect(check(c, mutate(c, ({ params }) => { params[P.destAddr] = word(ATTACKER); }))).toBe('lifi_wrong_receiver');
            expect(check(c, mutate(c, ({ bd, params }) => { bd[B.receiver] = ATTACKER; params[P.destAddr] = word(ATTACKER); }))).toBe('lifi_wrong_receiver');
        }
    });

    it('RED: BridgeData.receiver ≠ destAddr, and a destAddr with dirty upper bytes (MayanFacet truncates to uint160)', () => {
        expect(check(uu, mutate(uu, ({ bd }) => { bd[B.receiver] = ATTACKER; }))).toBe('lifi_wrong_receiver');
        const dirty = '0xff' + word(EVM_EVM.user).slice(4);
        expect(check(uu, mutate(uu, ({ params }) => { params[P.destAddr] = dirty; }))).toBe('lifi_wrong_receiver');
    });

    it('RED: the wrong destination chain — in the order, in BridgeData, or Solana', () => {
        expect(check(uu, mutate(uu, ({ params }) => { params[P.destChainId] = 24; }))).toBe('lifi_wrong_destination'); // Optimism, not Arbitrum
        expect(check(uu, mutate(uu, ({ params }) => { params[P.destChainId] = 30; }))).toBe('lifi_wrong_destination'); // back to Base
        expect(check(uu, mutate(uu, ({ params }) => { params[P.destChainId] = 1; }))).toBe('lifi_wrong_destination'); // Solana
        expect(check(uu, mutate(uu, ({ bd }) => { bd[B.destinationChainId] = 10n; }))).toBe('lifi_wrong_destination');
    });

    it('RED: the wrong tokenOut — the SOURCE chain\'s USDC (the old silent substitution), native ETH, or another token', () => {
        expect(check(uu, mutate(uu, ({ params }) => { params[P.tokenOut] = word(TOKEN_ADDRESSES[8453].USDC); }))).toBe('lifi_wrong_buy_token');
        expect(check(uu, mutate(uu, ({ params }) => { params[P.tokenOut] = ethers.ZeroHash; }))).toBe('lifi_wrong_buy_token');
        expect(check(ue, mutate(ue, ({ params }) => { params[P.tokenOut] = word(TOKEN_ADDRESSES[8453].WETH); }))).toBe('lifi_wrong_buy_token');
        expect(check(ee, mutate(ee, ({ params }) => { params[P.tokenOut] = word(TOKEN_ADDRESSES[10].USDC); }))).toBe('lifi_wrong_buy_token');
    });

    it('RED: the minimum at 10% of the amount displayed (toAmountMin moved with it) — and the exact floor boundary', () => {
        for (const c of [uu, ee]) {
            const shown = BigInt(c.quote!.estimate.toAmount);
            const tenth = shown / 10n;
            const d = c.buy === 'ETH' ? 18 : 6;
            expect(check(c, mutate(c, ({ params }) => { params[P.minAmountOut] = mayanNormalize(tenth, d); }), {}, tenth)).toBe('lifi_min_out_below_shown');
            const floor8 = mayanNormalize((shown * 9950n) / 10000n, d);
            expect(check(c, mutate(c, ({ params }) => { params[P.minAmountOut] = floor8 - 1n; }), {}, tenth)).toBe('lifi_min_out_below_shown');
            expect(check(c, mutate(c, ({ params }) => { params[P.minAmountOut] = floor8; }), {}, tenth)).toBe('pass');
        }
    });

    it('RED: an auction mode outside the ones the wallet signs', () => {
        for (const mode of [0, 1, 4, 255]) expect(check(uu, mutate(uu, ({ params }) => { params[P.auctionMode] = mode; }))).toBe('lifi_auction_mode');
    });

    it('RED: fees over the review — an extra payee, LI.FI\'s share taken from Provian\'s, a reviewed Provian fee above 25 bps', () => {
        const fees = relayFees(uu);
        const token = TOKEN_ADDRESSES[8453].USDC;
        const feeData = (dists: [string, bigint][]) => FEES.encodeFunctionData('forwardERC20Fees', [token, dists]);
        const pf = BigInt(fees.provianFee);
        const lf = BigInt(fees.lifiFee);
        const lifi = LIFI_EVM_FEE_COLLECTOR[8453];
        expect(check(uu, mutate(uu, ({ swaps }) => { swaps[0][5] = feeData([[PROVIAN_EVM_TREASURY, pf], [lifi, lf + 1n]]); }))).toBe('lifi_fee_exceeds_review');
        // Same total, but Provian's treasury is paid less than the 25 bps reviewed.
        expect(check(uu, mutate(uu, ({ swaps }) => { swaps[0][5] = feeData([[PROVIAN_EVM_TREASURY, pf - 1000n], [lifi, lf + 1000n]]); }))).toBe('lifi_fee_exceeds_review');
        expect(check(uu, mutate(uu, ({ swaps }) => { swaps[0][5] = feeData([[PROVIAN_EVM_TREASURY, pf - 1000n], [lifi, lf]]); }))).toBe('lifi_provian_fee');
        // Any payee other than the treasury and LI.FI's collector ( ).
        expect(check(uu, mutate(uu, ({ swaps }) => { swaps[0][5] = feeData([[PROVIAN_EVM_TREASURY, pf], [ATTACKER, lf]]); }))).toBe('lifi_fee_recipient');
        expect(check(uu, uu.quote!.transactionRequest.data, { provianFee: pf * 2n })).toBe('lifi_fee_exceeds_review');
    });

    it('RED: a Mayan protocol other than Swift v2, or a Swift call other than createOrderWithToken', () => {
        expect(check(uu, mutate(uu, ({ md }) => { md[M.mayanProtocol] = ATTACKER; }))).toBe('lifi_unknown_protocol');
        const t = FACET.parseTransaction({ data: uu.quote!.transactionRequest.data })!;
        const md = [...(t.args.mayanData as ethers.Result)];
        md[M.protocolData] = '0xb866e173' + (md[M.protocolData] as string).slice(10); // Swift createOrderWithEth
        const swaps = (t.args.swapData as ethers.Result[]).map((x) => [...x]);
        expect(check(uu, FACET.encodeFunctionData(t.name, [[...(t.args.bridgeData as ethers.Result)], swaps, md]))).toBe('lifi_unknown_protocol');
    });

    it('RED: hasDestinationCall, a non-EVM receiver, a gas drop, a referrer fee, refunds or trader elsewhere', () => {
        expect(check(uu, mutate(uu, ({ bd }) => { bd[B.hasDestinationCall] = true; }))).toBe('lifi_destination_call');
        expect(check(uu, mutate(uu, ({ md }) => { md[M.nonEVMReceiver] = word(ATTACKER); }))).toBe('lifi_wrong_receiver');
        expect(check(uu, mutate(uu, ({ md }) => { md[M.nonEVMReceiver] = ethers.ZeroHash; }))).toBe('pass'); // unread by the facet: zero or this wallet only
        expect(check(uu, mutate(uu, ({ params }) => { params[P.gasDrop] = 1n; }))).toBe('lifi_gas_drop');
        expect(check(uu, mutate(uu, ({ params }) => { params[P.referrerBps] = 1; }))).toBe('lifi_referrer_fee');
        expect(check(uu, mutate(uu, ({ md }) => { md[M.refundRecipient] = ATTACKER; }))).toBe('lifi_wrong_refund');
        expect(check(uu, mutate(uu, ({ params }) => { params[P.trader] = word(ATTACKER); }))).toBe('lifi_wrong_refund');
    });

    it('RED: a direct bridge with no fee step (Provian\'s 25 bps unpaid) is refused', () => {
        const t = FACET.parseTransaction({ data: uu.quote!.transactionRequest.data })!;
        const bd = [...(t.args.bridgeData as ethers.Result)];
        bd[8] = false; // hasSourceSwaps
        const direct = FACET.encodeFunctionData('startBridgeTokensViaMayan', [bd, [...(t.args.mayanData as ethers.Result)]]);
        expect(check(uu, direct)).toBe('lifi_provian_fee');
    });

    it('RED: a review whose destination is the source chain, or a chain the wallet does not hold (Ethereum mainnet)', () => {
        expect(check(uu, uu.quote!.transactionRequest.data, { destination: { kind: 'evm', chainId: 8453 } })).toBe('lifi_same_chain');
        expect(check(uu, uu.quote!.transactionRequest.data, { destination: { kind: 'evm', chainId: 1 } })).toBe('lifi_unsupported_chain');
    });

    it('RED: an EVM → EVM quote reviewed as if it went to Solana (and vice versa) is refused', () => {
        expect(check(uu, uu.quote!.transactionRequest.data, { destination: { kind: 'solana', solanaReceiver: word(EVM_EVM.user) } })).toBe('lifi_wrong_receiver');
    });
});

/**
 * , on the live EVM → EVM captures: the Swift order's deadline (Swift refunds
 * an unfilled order only after it: SwiftDest.cancelOrder reverts while block.timestamp <=
 * deadline) and the fee step's lower bound and recipients. Each RED is a live capture re-encoded
 * with one field changed, checked at the moment the capture was taken.
 */
describe(' — Swift deadline and fee bounds on the live EVM → EVM quotes', () => {
    const quoted = EVM_EVM.captures.filter((c) => c.quote);
    const uu = REQUIRED.find((c) => c.sourceChainId === 8453 && c.destChainId === 42161 && c.sell === 'USDC' && c.buy === 'USDC')!;
    const ee = REQUIRED.find((c) => c.sourceChainId === 42161 && c.destChainId === 10 && c.sell === 'ETH' && c.buy === 'ETH')!;
    const ue = REQUIRED.find((c) => c.sourceChainId === 10 && c.destChainId === 8453 && c.sell === 'USDC' && c.buy === 'ETH')!;
    const feeData = (c: EvmEvmCapture, dists: [string, bigint][]) => c.sell === 'ETH'
        ? FEES.encodeFunctionData('forwardNativeFees', [dists])
        : FEES.encodeFunctionData('forwardERC20Fees', [TOKEN_ADDRESSES[c.sourceChainId][c.sell], dists]);

    it('every live order (26): deadline 1–60 min after capture, fees exactly 25 bps each to the treasury and LI.FI\'s collector; each signs', () => {
        const leads: number[] = [];
        for (const c of quoted) {
            const lead = Number(evmSwiftDeadline(c.quote!.transactionRequest.data)) - captureSec(c.capturedAt);
            expect(lead).toBeGreaterThan(0);
            expect(lead).toBeLessThanOrEqual(Number(SWIFT_MAX_DEADLINE_SECONDS));
            leads.push(lead);
            const t = FACET.parseTransaction({ data: c.quote!.transactionRequest.data })!;
            const fee = (t.args.swapData as ethers.Result[])[0];
            const dists = (FEES.parseTransaction({ data: fee[5] as string })!.args.distributions as ethers.Result[])
                .map((d) => [(d[0] as string).toLowerCase(), d[1] as bigint]);
            const floor = (BigInt(fee[4] as bigint) * 25n) / 10000n;
            expect(dists).toHaveLength(2);
            expect(new Map(dists as [string, bigint][])).toEqual(new Map([
                [PROVIAN_EVM_TREASURY.toLowerCase(), floor], [LIFI_EVM_FEE_COLLECTOR[c.sourceChainId].toLowerCase(), floor],
            ]));
            if (c.relay && !('refused' in c.relay)) expect(check(c)).toBe('pass');
        }
        expect(leads).toHaveLength(26);
        expect(Math.min(...leads)).toBe(716);
        expect(Math.max(...leads)).toBe(901);
    });

    it('RED: deadline = 2^64 − 1 (never cancellable), 0, and now + 3601 s; now + 3600 s and now + 1 s sign', () => {
        for (const c of [uu, ee, ue]) {
            const now = captureSec(c.capturedAt);
            const at = (deadline: bigint) => check(c, mutate(c, ({ params }) => { params[P.deadline] = deadline; }));
            expect(at(2n ** 64n - 1n)).toBe('lifi_deadline');
            expect(at(0n)).toBe('lifi_deadline');
            expect(at(BigInt(now) + SWIFT_MAX_DEADLINE_SECONDS + 1n)).toBe('lifi_deadline');
            expect(at(BigInt(now))).toBe('lifi_deadline');
            expect(at(BigInt(now) + SWIFT_MAX_DEADLINE_SECONDS)).toBe('pass');
            expect(at(BigInt(now) + 1n)).toBe('pass');
        }
        // The live order checked after its own deadline (a quote held past it) is refused.
        expect(check(uu, undefined, {}, undefined, Number(evmSwiftDeadline(uu.quote!.transactionRequest.data)))).toBe('lifi_deadline');
    });

    it('RED: Provian\'s fee 0 with the whole fee sent to 0x…dEaD (USDC and ETH)', () => {
        for (const c of [uu, ee]) {
            const f = relayFees(c);
            const total = BigInt(f.provianFee) + BigInt(f.lifiFee);
            const data = mutate(c, ({ swaps }) => { swaps[0][5] = feeData(c, [[ATTACKER, total]]); });
            expect(check(c, data, { provianFee: 0n, lifiFee: total })).toBe('lifi_provian_fee');
            expect(check(c, data)).toBe('lifi_fee_recipient');
        }
    });

    it('RED: a 4 USDC "LI.FI fee" skim to LI.FI\'s own collector; a Provian fee one unit short', () => {
        const f = relayFees(uu);
        const pf = BigInt(f.provianFee);
        const skim = 4_000_000n;
        const data = mutate(uu, ({ swaps, bd, order }) => {
            swaps[0][5] = feeData(uu, [[PROVIAN_EVM_TREASURY, pf], [LIFI_EVM_FEE_COLLECTOR[8453], skim]]);
            bd[6] = 20_000_000n - pf - skim; // BridgeData.minAmount: what is left for the order
            order[1] = bd[6];
        });
        expect(check(uu, data, { lifiFee: skim })).toBe('lifi_fee_exceeds_review');
        expect(check(uu, data)).toBe('lifi_fee_exceeds_review');
        expect(check(uu, undefined, { provianFee: pf - 1n })).toBe('lifi_provian_fee');
        expect(check(uu, undefined, { provianFee: pf + 1n })).toBe('lifi_provian_fee'); // the reviewed fee is paid exactly
        expect(check(uu, undefined, { provianFee: pf + 2n })).toBe('lifi_fee_exceeds_review');
    });

    it('RED: an unknown fee collector — LI.FI\'s share, same amount, another address', () => {
        const stranger = '0x1111111111111111111111111111111111111111';
        for (const c of [uu, ee, ue]) {
            const f = relayFees(c);
            const data = mutate(c, ({ swaps }) => { swaps[0][5] = feeData(c, [[PROVIAN_EVM_TREASURY, BigInt(f.provianFee)], [stranger, BigInt(f.lifiFee)]]); });
            expect(check(c, data)).toBe('lifi_fee_recipient');
        }
        // Another chain's view of the pin: the same collector, so a Base pin is not a loophole on Optimism.
        expect(new Set(Object.values(LIFI_EVM_FEE_COLLECTOR)).size).toBe(1);
    });
});
