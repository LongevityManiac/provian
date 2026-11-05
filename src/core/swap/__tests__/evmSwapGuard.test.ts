/**
 * the EVM swap signing guard against REAL 0x v2 allowance-holder quotes (Base,
 * __fixtures__/evm-route-fixtures.json) and real LI.FI EVM-source quote targets on Base,
 * Arbitrum and Optimism, plus each made malicious.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { TOKEN_ADDRESSES } from '../../chains/evm/config';
import { PROVIAN_EVM_TREASURY } from '../../fees/FeeConfig';
import {
    LIFI_DIAMOND,
    NATIVE_ETH_SENTINEL,
    SwapRouteRefusedError,
    ZEROX_ALLOWANCE_HOLDER,
    ZEROX_DEPLOYER,
    assertGenuineZeroXSettler,
    assertLifiEvmRoute,
    assertLifiMayanEvmToSolana,
    LIFI_FEE_FORWARDER,
    LIFI_NON_EVM_RECEIVER,
    MAYAN_WRAP_PROTOCOL,
    WETH_BY_CHAIN,
    type LifiEvmToSolanaExpectation,
    assertZeroXExecutionMatches,
    assertZeroXSpender,
    decodeZeroXAllowanceHolderTx,
    LIFI_EVM_FEE_COLLECTOR,
    SWIFT_MAX_DEADLINE_SECONDS,
} from '../evmSwapGuard';
import { evmSwiftDeadline, nowBefore } from './swiftClock';

interface ZeroXFixture {
    chainId: number; taker: string; buyToken: string; sellAmount: string;
    transaction: { to: string; data: string; value?: string };
}
interface LifiFixture {
    source: string; expect: 'pass' | 'refuse';
    sourceChainId: number; native: boolean; approvalAddress: string;
    transactionRequest: { to: string; data: string; value: string; chainId: number };
    review: {
        sellToken: string; sellAmount: string; evmAddress: string; solanaReceiver: string; destToken: string;
        destDecimals: number; minOutAtomic: string; provianFee: string; lifiFee: string; slippageBps: number;
        toAmountAtomic: string;
    };
}
const FIX: { zerox: ZeroXFixture[]; lifi: LifiFixture[] } = JSON.parse(
    readFileSync(join(__dirname, '..', '__fixtures__', 'evm-route-fixtures.json'), 'utf8'),
);
const [ethToUsdc, usdcToWeth] = FIX.zerox;
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const SETTLER = '0x4f6f91599858bf0d19fabCF2c5d591fE13f7C059'; // Base ownerOf(2), read 2026-09-26
const ATTACKER = '0x000000000000000000000000000000000000dEaD';

const AH_IFACE = new ethers.Interface(['function exec(address operator, address token, uint256 amount, address target, bytes data)']);
const SETTLER_IFACE = new ethers.Interface(['function execute((address recipient, address buyToken, uint256 minAmountOut) slippage, bytes[] actions, bytes32 zidAndAffiliate)']);
const DEPLOYER_IFACE = new ethers.Interface(['function ownerOf(uint256) view returns (address)', 'function prev(uint128) view returns (address)']);

function code(fn: () => unknown): string {
    try { fn(); return 'pass'; } catch (e) { if (e instanceof SwapRouteRefusedError) return e.code; throw e; }
}
async function codeAsync(fn: () => Promise<unknown>): Promise<string> {
    try { await fn(); return 'pass'; } catch (e) { if (e instanceof SwapRouteRefusedError) return e.code; throw e; }
}

/** Re-encode a real 0x transaction with one field changed. */
function mutate(f: ZeroXFixture, change: { operator?: string; target?: string; token?: string; amount?: bigint; recipient?: string; minOut?: bigint }): string {
    const [operator, token, amount, target, inner] = AH_IFACE.decodeFunctionData('exec', f.transaction.data);
    const [slip, actions, zid] = SETTLER_IFACE.decodeFunctionData('execute', inner);
    const innerOut = SETTLER_IFACE.encodeFunctionData('execute', [
        [change.recipient ?? slip[0], slip[1], change.minOut ?? slip[2]], actions, zid,
    ]);
    return AH_IFACE.encodeFunctionData('exec', [
        change.operator ?? operator, change.token ?? token, change.amount ?? amount, change.target ?? target, innerOut,
    ]);
}

describe(' 0x — real allowance-holder quotes decode and match what was reviewed', () => {
    it('ETH → USDC (native sell): AllowanceHolder → the Base Settler, paying the taker at least minAmountOut', () => {
        const x = decodeZeroXAllowanceHolderTx(8453, ethToUsdc.transaction);
        expect(x.settler).toBe(SETTLER);
        expect(x.recipient.toLowerCase()).toBe(ethToUsdc.taker.toLowerCase());
        expect(x.minAmountOut).toBe(26914297n);
        expect(code(() => assertZeroXExecutionMatches(x, {
            sellToken: 'native', sellAmount: BigInt(ethToUsdc.sellAmount), buyToken: BASE_USDC,
            recipient: ethToUsdc.taker, value: BigInt(ethToUsdc.sellAmount),
        }))).toBe('pass');
    });

    it('USDC → WETH (ERC-20 sell): pulls exactly the sell amount of USDC, sends no ETH', () => {
        const x = decodeZeroXAllowanceHolderTx(8453, usdcToWeth.transaction);
        expect(x.minAmountOut).toBe(3681236004520699n);
        expect(code(() => assertZeroXExecutionMatches(x, {
            sellToken: BASE_USDC, sellAmount: 10_000_000n, buyToken: usdcToWeth.buyToken,
            recipient: usdcToWeth.taker, value: 0n,
        }))).toBe('pass');
    });

    it('the approval spender is AllowanceHolder on Base, Arbitrum and Optimism, and nothing else', () => {
        for (const c of [8453, 42161, 10]) expect(code(() => assertZeroXSpender(c, ZEROX_ALLOWANCE_HOLDER))).toBe('pass');
        expect(code(() => assertZeroXSpender(8453, ATTACKER))).toBe('zerox_unknown_spender');
        expect(code(() => assertZeroXSpender(1, ZEROX_ALLOWANCE_HOLDER))).toBe('zerox_unknown_spender');
    });
});

describe(' 0x — each real transaction made malicious', () => {
    const want = {
        sellToken: BASE_USDC, sellAmount: 10_000_000n, buyToken: usdcToWeth.buyToken, recipient: usdcToWeth.taker, value: 0n,
    };
    const check = (data: string, to = usdcToWeth.transaction.to) =>
        code(() => assertZeroXExecutionMatches(decodeZeroXAllowanceHolderTx(8453, { to, data }), want));

    it('RED: a transaction to anything but AllowanceHolder', () => {
        expect(check(usdcToWeth.transaction.data, ATTACKER)).toBe('zerox_unknown_target');
    });
    it('RED: AllowanceHolder lets one address pull while calling another', () => {
        expect(check(mutate(usdcToWeth, { operator: ATTACKER }))).toBe('zerox_operator_mismatch');
    });
    it('RED: pulls more than the amount reviewed', () => {
        expect(check(mutate(usdcToWeth, { amount: 10_000_001n }))).toBe('zerox_wrong_amount');
    });
    it('RED: pulls a different token', () => {
        expect(check(mutate(usdcToWeth, { token: ATTACKER }))).toBe('zerox_wrong_sell_token');
    });
    it('RED: pays the output to someone else', () => {
        expect(check(mutate(usdcToWeth, { recipient: ATTACKER }))).toBe('zerox_wrong_recipient');
    });
    it('RED: enforces no minimum', () => {
        expect(check(mutate(usdcToWeth, { minOut: 0n }))).toBe('zerox_no_minimum');
    });
    it('RED: calldata that is not AllowanceHolder.exec', () => {
        expect(check('0xa9059cbb' + '00'.repeat(64))).toBe('zerox_unknown_call');
    });
    it('RED: an ERC-20 swap that also sends ETH', () => {
        const x = decodeZeroXAllowanceHolderTx(8453, usdcToWeth.transaction);
        expect(code(() => assertZeroXExecutionMatches(x, { ...want, value: 1n }))).toBe('zerox_wrong_value');
    });
    it('RED: a native swap whose value is not the amount reviewed', () => {
        const x = decodeZeroXAllowanceHolderTx(8453, ethToUsdc.transaction);
        expect(code(() => assertZeroXExecutionMatches(x, {
            sellToken: 'native', sellAmount: BigInt(ethToUsdc.sellAmount), buyToken: BASE_USDC,
            recipient: ethToUsdc.taker, value: BigInt(ethToUsdc.sellAmount) + 1n,
        }))).toBe('zerox_wrong_value');
    });
    it('RED: pays out a token other than the one reviewed (ETH buy is the 0xEeee sentinel)', () => {
        const x = decodeZeroXAllowanceHolderTx(8453, usdcToWeth.transaction);
        expect(code(() => assertZeroXExecutionMatches(x, { ...want, buyToken: 'native' }))).toBe('zerox_wrong_buy_token');
        expect(NATIVE_ETH_SENTINEL).toBe('0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE');
    });
});

describe(' 0x — the Settler must be one 0x\'s registry names', () => {
    const registry = (owner: string | Error, prev: string | Error) => vi.fn(async (tx: { to: string; data: string }) => {
        expect(tx.to).toBe(ZEROX_DEPLOYER);
        const fn = tx.data.startsWith(DEPLOYER_IFACE.getFunction('ownerOf')!.selector) ? 'ownerOf' : 'prev';
        const v = fn === 'ownerOf' ? owner : prev;
        if (v instanceof Error) throw v;
        const [feature] = DEPLOYER_IFACE.decodeFunctionData(fn, tx.data);
        expect(feature).toBe(2n); // taker-submitted
        return DEPLOYER_IFACE.encodeFunctionResult(fn, [v]);
    });

    it('the current Settler (ownerOf(2)) passes', async () => {
        expect(await codeAsync(() => assertGenuineZeroXSettler(SETTLER, registry(SETTLER, ATTACKER)))).toBe('pass');
    });
    it('the previous Settler (prev(2)) passes during 0x\'s dwell period', async () => {
        expect(await codeAsync(() => assertGenuineZeroXSettler(SETTLER, registry(ATTACKER, SETTLER)))).toBe('pass');
    });
    it('RED: a Settler the registry does not name', async () => {
        expect(await codeAsync(() => assertGenuineZeroXSettler(SETTLER, registry(ATTACKER, ATTACKER)))).toBe('zerox_counterfeit_settler');
    });
    it('RED: a paused feature (ownerOf reverts) refuses even if prev matches', async () => {
        expect(await codeAsync(() => assertGenuineZeroXSettler(SETTLER, registry(new Error('paused'), SETTLER)))).toBe('zerox_registry_unavailable');
    });
    it('RED: a zero address is never a Settler', async () => {
        expect(await codeAsync(() => assertGenuineZeroXSettler(ethers.ZeroAddress, registry(ethers.ZeroAddress, ethers.ZeroAddress)))).toBe('zerox_counterfeit_settler');
    });
});

describe(' LI.FI EVM source — real quotes on Base, Arbitrum and Optimism', () => {
    const passes = FIX.lifi.filter((l) => l.expect === 'pass');
    it('the population is real and covers all three chains, native and ERC-20', () => {
        expect(new Set(passes.map((l) => l.sourceChainId))).toEqual(new Set([8453, 42161, 10]));
        expect(passes.filter((l) => l.native).length).toBe(6);
        expect(passes.length).toBe(12);
    });
    for (const l of passes) {
        it(`routes to the Diamond: ${l.source.split(' ')[1]}`, () => {
            expect(code(() => assertLifiEvmRoute(l.sourceChainId, l.transactionRequest, l.approvalAddress, !l.native))).toBe('pass');
        });
    }
    const l = passes.find((f) => f.sourceChainId === 8453 && !f.native)!;
    it('RED: a transaction to anything but the LI.FI Diamond', () => {
        expect(code(() => assertLifiEvmRoute(8453, { ...l.transactionRequest, to: ATTACKER }, l.approvalAddress, true))).toBe('lifi_unknown_target');
    });
    it('RED: an approval to anything but the LI.FI Diamond', () => {
        expect(code(() => assertLifiEvmRoute(8453, l.transactionRequest, ATTACKER, true))).toBe('lifi_unknown_spender');
    });
    it('RED: an ERC-20 source with no approval address refuses', () => {
        expect(code(() => assertLifiEvmRoute(8453, l.transactionRequest, undefined, true))).toBe('lifi_unknown_spender');
    });
    it('RED: a transaction for another chain than the one swapped from', () => {
        expect(code(() => assertLifiEvmRoute(8453, { to: LIFI_DIAMOND, chainId: 42161 }, LIFI_DIAMOND, true))).toBe('lifi_wrong_chain');
    });
});

// ── round 2: the Diamond calldata, decoded ──────────────────────────────────────────
const BRIDGE_DATA = '(bytes32 transactionId, string bridge, string integrator, address referrer, address sendingAssetId, address receiver, uint256 minAmount, uint256 destinationChainId, bool hasSourceSwaps, bool hasDestinationCall)';
const SWAP_DATA = '(address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, bool requiresDeposit)';
const MAYAN_DATA = '(bytes32 nonEVMReceiver, address mayanProtocol, bytes protocolData, address swapProtocol, bytes swapData, address middleToken, uint256 minMiddleAmount, address refundRecipient, uint256 mayanAmountIn)';
// LI.FI's published MayanFacet v2 / FeeForwarder v2 ABIs and Mayan Swift v2's createOrderWithToken.
const FACET = new ethers.Interface([
    `function swapAndStartBridgeTokensViaMayan(${BRIDGE_DATA} bridgeData, ${SWAP_DATA}[] swapData, ${MAYAN_DATA} mayanData)`,
    `function startBridgeTokensViaMayan(${BRIDGE_DATA} bridgeData, ${MAYAN_DATA} mayanData)`,
    'function startBridgeTokensViaAcrossV3((bytes32,string,string,address,address,address,uint256,uint256,bool,bool) bridgeData, bytes acrossData)',
]);
const FEES = new ethers.Interface([
    'function forwardERC20Fees(address token, (address recipient, uint256 amount)[] distributions)',
    'function forwardNativeFees((address recipient, uint256 amount)[] distributions)',
]);
const SWIFT = new ethers.Interface([
    'function createOrderWithToken(address tokenIn, uint256 amountIn, (uint8 payloadType, bytes32 trader, bytes32 destAddr, uint16 destChainId, bytes32 referrerAddr, bytes32 tokenOut, uint64 minAmountOut, uint64 gasDrop, uint64 cancelFee, uint64 refundFee, uint64 deadline, uint8 referrerBps, uint8 auctionMode, bytes32 random) params, bytes customPayload)',
]);
const ATTACKER_SOL = '0x' + 'ab'.repeat(32);
const ONEINCH = '0x111111125421cA6dc452d289314280a0f8842A65';

function expectationOf(f: LifiFixture): LifiEvmToSolanaExpectation {
    const r = f.review;
    return {
        sellToken: r.sellToken, sellAmount: BigInt(r.sellAmount), value: BigInt(f.transactionRequest.value),
        evmAddress: r.evmAddress, solanaReceiver: r.solanaReceiver, destToken: r.destToken, destDecimals: r.destDecimals,
        minOutAtomic: BigInt(r.minOutAtomic), provianFee: BigInt(r.provianFee), lifiFee: BigInt(r.lifiFee), slippageBps: r.slippageBps,
        toAmountAtomic: BigInt(r.toAmountAtomic),
    };
}
function decimalsOn(chainId: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [sym, a] of Object.entries(TOKEN_ADDRESSES[chainId])) out[a.toLowerCase()] = sym === 'DAI' || sym === 'WETH' ? 18 : 6;
    return out;
}
/**
 * The clock a fixture is checked at ( ): CAPTURE_LEAD_SEC before its own
 * order's deadline (these captures record no time); the wall clock for a non-Mayan capture.
 */
function fixtureNow(f: LifiFixture): number {
    try {
        return nowBefore(evmSwiftDeadline(f.transactionRequest.data));
    } catch {
        return Math.floor(Date.now() / 1000);
    }
}
function check(f: LifiFixture, data = f.transactionRequest.data, over: Partial<LifiEvmToSolanaExpectation> = {}, nowSec = fixtureNow(f)): string {
    return code(() => assertLifiMayanEvmToSolana(f.sourceChainId, { ...f.transactionRequest, data }, { ...expectationOf(f), ...over }, decimalsOn(f.sourceChainId), nowSec));
}
/** Re-encode a real LI.FI call with its bridge data, swaps, Mayan data or Swift order edited. */
function mutateLifi(f: LifiFixture, edit: (m: { bd: unknown[]; swaps: unknown[][]; md: unknown[]; order: unknown[]; params: unknown[] }) => void): string {
    const t = FACET.parseTransaction({ data: f.transactionRequest.data })!;
    const bd = [...(t.args.bridgeData as ethers.Result)];
    const swaps = t.name === 'swapAndStartBridgeTokensViaMayan' ? (t.args.swapData as ethers.Result[]).map((x) => [...x]) : [];
    const md = [...(t.args.mayanData as ethers.Result)];
    const o = SWIFT.decodeFunctionData('createOrderWithToken', md[2] as string);
    const params = [...(o[2] as ethers.Result)];
    const order = [o[0], o[1], params, o[3]];
    edit({ bd, swaps, md, order, params });
    order[2] = params;
    md[2] = SWIFT.encodeFunctionData('createOrderWithToken', order);
    return t.name === 'swapAndStartBridgeTokensViaMayan'
        ? FACET.encodeFunctionData(t.name, [bd, swaps, md])
        : FACET.encodeFunctionData(t.name, [bd, md]);
}
/** Order params indices (Swift v2 OrderParams). */
const P = { trader: 1, destAddr: 2, destChainId: 3, tokenOut: 5, minAmountOut: 6, cancelFee: 8, refundFee: 9, deadline: 10, referrerBps: 11, auctionMode: 12 } as const;
/** MayanData indices. */
const M = { nonEVMReceiver: 0, mayanProtocol: 1, swapProtocol: 3, swapData: 4, middleToken: 5, minMiddleAmount: 6, refundRecipient: 7 } as const;
/** BridgeData indices. */
const B = { receiver: 5, minAmount: 6, destinationChainId: 7, hasDestinationCall: 9 } as const;

describe(' round 2 — LI.FI EVM → Solana: the Mayan calldata is decoded and bound to the review', () => {
    const passes = FIX.lifi.filter((f) => f.expect === 'pass');
    const dexLegs = FIX.lifi.filter((f) => f.expect === 'refuse');
    const usdc = passes.find((f) => f.source.includes('none-8453-usdc-to-sol'))!;
    const eth = passes.find((f) => f.source.includes('none-8453-eth-to-sol'))!;

    it('the pins are the chain facts: WETH per chain, the treasury, the fee forwarder', () => {
        for (const c of [8453, 42161, 10]) expect(WETH_BY_CHAIN[c]).toBe(TOKEN_ADDRESSES[c].WETH);
        expect(LIFI_FEE_FORWARDER).toBe('0xCE40449B773a3E6E5e769ADb4e567179d4828cbd');
        expect(MAYAN_WRAP_PROTOCOL).toBe('0x529863940BF6065d8C122a550c2ff37c1cfeFa16');
        expect(PROVIAN_EVM_TREASURY).toBe('0x086e0F377af1245B8888540f39e99A42a7daF1dA');
    });

    for (const f of passes) {
        it(`signs: ${f.source.split(' ')[1]} (enforced minimum ≥ the reviewed one, 8-decimal normalized)`, () => {
            const out = assertLifiMayanEvmToSolana(f.sourceChainId, f.transactionRequest, expectationOf(f), decimalsOn(f.sourceChainId), fixtureNow(f));
            const d = f.review.destDecimals;
            const norm = (v: bigint) => (d > 8 ? v / 10n ** BigInt(d - 8) : v);
            expect(norm(out.minOutAtomic)).toBeGreaterThanOrEqual(norm(BigInt(f.review.minOutAtomic)));
        });
    }
    for (const f of dexLegs) {
        it(`RED: refuses ${f.source.split(' ')[1]} (a DEX source leg whose output the relay sets)`, () => {
            expect(check(f)).toBe('lifi_bad_swaps');
        });
    }

    it('RED: the order pays an attacker\'s Solana address (Mayan receiver and order destination both)', () => {
        const data = mutateLifi(usdc, ({ md, params }) => { md[M.nonEVMReceiver] = ATTACKER_SOL; params[P.destAddr] = ATTACKER_SOL; });
        expect(check(usdc, data)).toBe('lifi_wrong_receiver');
        expect(check(usdc, mutateLifi(usdc, ({ params }) => { params[P.destAddr] = ATTACKER_SOL; }))).toBe('lifi_wrong_receiver');
    });

    it('RED: minimum out = 1 plus an extra DEX action paying the attacker', () => {
        const drain = [ONEINCH, ONEINCH, usdc.review.sellToken, usdc.review.sellToken, 1n, '0x12aa3caf', false];
        const both = mutateLifi(usdc, ({ params, swaps }) => { params[P.minAmountOut] = 1n; swaps.push(drain); });
        expect(check(usdc, both)).toBe('lifi_bad_swaps');
        expect(check(usdc, mutateLifi(usdc, ({ params }) => { params[P.minAmountOut] = 1n; }))).toBe('lifi_min_out_below_review');
    });

    it('RED: one unit below the reviewed minimum refuses; the reviewed minimum signs', () => {
        const reviewed = BigInt(usdc.review.minOutAtomic) / 10n; // SOL 9 → 8 decimals
        expect(check(usdc, mutateLifi(usdc, ({ params }) => { params[P.minAmountOut] = reviewed - 1n; }))).toBe('lifi_min_out_below_review');
        expect(check(usdc, mutateLifi(usdc, ({ params }) => { params[P.minAmountOut] = reviewed; }))).toBe('pass');
    });

    it('RED: over-approval — the route takes more than the amount reviewed', () => {
        const more = BigInt(usdc.review.sellAmount) * 2n;
        const data = mutateLifi(usdc, ({ swaps, bd, order }) => {
            swaps[0][4] = more;
            bd[B.minAmount] = more - 100_000n; order[1] = more - 100_000n;
        });
        expect(check(usdc, data)).toBe('lifi_wrong_amount');
    });

    it('RED: fees above the review — to an attacker, or more to Provian than reviewed', () => {
        const feeData = (dists: [string, bigint][]) => FEES.encodeFunctionData('forwardERC20Fees', [usdc.review.sellToken, dists]);
        const lifiFee = BigInt(usdc.review.lifiFee);
        const provianFee = BigInt(usdc.review.provianFee);
        const extra = mutateLifi(usdc, ({ swaps }) => { swaps[0][5] = feeData([[ATTACKER, lifiFee + 1n], [PROVIAN_EVM_TREASURY, provianFee]]); });
        // : a payee that is not LI.FI's collector is refused as such.
        expect(check(usdc, extra)).toBe('lifi_fee_recipient');
        const skim = mutateLifi(usdc, ({ swaps }) => { swaps[0][5] = feeData([[ATTACKER, lifiFee], [PROVIAN_EVM_TREASURY, provianFee], [ATTACKER, 5_000_000n]]); });
        expect(check(usdc, skim)).toBe('lifi_fee_recipient');
        // More than reviewed to LI.FI's own collector.
        const collector = LIFI_EVM_FEE_COLLECTOR[usdc.sourceChainId];
        const over = mutateLifi(usdc, ({ swaps }) => { swaps[0][5] = feeData([[collector, lifiFee + 1n], [PROVIAN_EVM_TREASURY, provianFee]]); });
        expect(check(usdc, over)).toBe('lifi_fee_exceeds_review');
    });

    it('RED: a fee step that is not LI.FI\'s fee forwarder', () => {
        expect(check(usdc, mutateLifi(usdc, ({ swaps }) => { swaps[0][0] = ATTACKER; swaps[0][1] = ATTACKER; }))).toBe('lifi_bad_swaps');
    });

    it('RED: transaction value — ERC-20 with value, native with more or less than the amount', () => {
        expect(check(usdc, usdc.transactionRequest.data, { value: 1n })).toBe('lifi_wrong_value');
        expect(check(eth, eth.transactionRequest.data, { value: BigInt(eth.review.sellAmount) + 1n })).toBe('lifi_wrong_value');
        expect(check(eth, eth.transactionRequest.data, { value: 0n })).toBe('lifi_wrong_value');
    });

    it('RED: native ETH swapped (not wrapped) before the order, or its wrap floor removed', () => {
        expect(check(eth, mutateLifi(eth, ({ md }) => { md[M.swapProtocol] = ONEINCH; }))).toBe('lifi_bad_swaps');
        expect(check(eth, mutateLifi(eth, ({ md }) => { md[M.middleToken] = TOKEN_ADDRESSES[8453].USDC; }))).toBe('lifi_bad_swaps');
        expect(check(eth, mutateLifi(eth, ({ md, order }) => { md[M.minMiddleAmount] = 1n; order[1] = 1n; }))).toBe('lifi_min_out_below_review');
    });

    it('RED: an unknown facet selector (Mayan v1, or another bridge) is refused', () => {
        const v1 = '0x30c48952' + usdc.transactionRequest.data.slice(10);
        expect(check(usdc, v1)).toBe('lifi_unknown_facet');
        const t = FACET.parseTransaction({ data: usdc.transactionRequest.data })!;
        const across = FACET.encodeFunctionData('startBridgeTokensViaAcrossV3', [t.args.bridgeData, '0x']);
        expect(check(usdc, across)).toBe('lifi_unknown_facet');
    });

    it('RED: bridge data — another receiver, another chain, a destination call', () => {
        expect(check(usdc, mutateLifi(usdc, ({ bd }) => { bd[B.receiver] = ATTACKER; }))).toBe('lifi_wrong_receiver');
        expect(check(usdc, mutateLifi(usdc, ({ bd }) => { bd[B.destinationChainId] = 1n; }))).toBe('lifi_wrong_destination');
        expect(check(usdc, mutateLifi(usdc, ({ bd }) => { bd[B.hasDestinationCall] = true; }))).toBe('lifi_destination_call');
        expect(LIFI_NON_EVM_RECEIVER).toBe('0x11f111f111f111F111f111f111F111f111f111F1');
    });

    it('RED: refunds to an attacker, a referrer fee, another output token, unbounded relayer fees', () => {
        expect(check(usdc, mutateLifi(usdc, ({ md }) => { md[M.refundRecipient] = ATTACKER; }))).toBe('lifi_wrong_refund');
        expect(check(usdc, mutateLifi(usdc, ({ params }) => { params[P.trader] = ethers.zeroPadValue(ATTACKER, 32); }))).toBe('lifi_wrong_refund');
        expect(check(usdc, mutateLifi(usdc, ({ params }) => { params[P.referrerBps] = 1; }))).toBe('lifi_referrer_fee');
        expect(check(usdc, mutateLifi(usdc, ({ params }) => { params[P.tokenOut] = ATTACKER_SOL; }))).toBe('lifi_wrong_buy_token');
        expect(check(usdc, mutateLifi(usdc, ({ params }) => { params[P.cancelFee] = 10_000_000n; }))).toBe('lifi_relayer_fee');
    });

    it(' round 3 — every live order meets the amount SHOWN less the slippage shown, in auction mode 2 or 3', () => {
        for (const f of passes) {
            const t = FACET.parseTransaction({ data: f.transactionRequest.data })!;
            const o = SWIFT.decodeFunctionData('createOrderWithToken', (t.args.mayanData as ethers.Result)[2] as string);
            const d = f.review.destDecimals;
            const floor = (BigInt(f.review.toAmountAtomic) * 9950n) / 10000n;
            expect((o[2] as ethers.Result)[6]).toBeGreaterThanOrEqual(d > 8 ? floor / 10n ** BigInt(d - 8) : floor);
            expect([2n, 3n]).toContain((o[2] as ethers.Result)[12]);
        }
    });

    it('RED (round 3): toAmountMin and the order minimum at 10% of an honest toAmount — a filler keeps ~90%', () => {
        // The relay keeps toAmount (what the screen shows) honest and moves toAmountMin and the
        // Swift minimum together, so every round-2 check (order ≥ toAmountMin) passes.
        const shown = BigInt(usdc.review.toAmountAtomic); // SOL, 9 decimals
        const tenth = shown / 10n;
        const data = mutateLifi(usdc, ({ params }) => { params[P.minAmountOut] = tenth / 10n; });
        expect(check(usdc, data, { minOutAtomic: tenth })).toBe('lifi_min_out_below_shown');
        // Boundary: floor(shown × 9950 / 10000) in Mayan's 8 decimals signs; one unit less refuses.
        const floor8 = ((shown * 9950n) / 10000n) / 10n;
        expect(check(usdc, mutateLifi(usdc, ({ params }) => { params[P.minAmountOut] = floor8 - 1n; }), { minOutAtomic: tenth })).toBe('lifi_min_out_below_shown');
        expect(check(usdc, mutateLifi(usdc, ({ params }) => { params[P.minAmountOut] = floor8; }), { minOutAtomic: tenth })).toBe('pass');
        // The floor follows the slippage shown: at 90% the same order would pass.
        expect(check(usdc, data, { minOutAtomic: tenth, slippageBps: 9000 })).toBe('pass');
    });

    it('RED (round 3): an auction mode outside {2, 3}', () => {
        for (const mode of [0, 1, 4, 255]) {
            expect(check(usdc, mutateLifi(usdc, ({ params }) => { params[P.auctionMode] = mode; }))).toBe('lifi_auction_mode');
        }
        expect(check(usdc, mutateLifi(usdc, ({ params }) => { params[P.auctionMode] = 3; }))).toBe('pass');
    });

    it('RED: a Mayan protocol other than Swift v2', () => {
        expect(check(usdc, mutateLifi(usdc, ({ md }) => { md[M.mayanProtocol] = ATTACKER; }))).toBe('lifi_unknown_protocol');
    });
});

/**
 * , on the live EVM → Solana captures (the same decoder as EVM → EVM): the
 * Swift order's deadline (an unfillable order is refunded only after it) and the fee step's
 * lower bound and recipients. Each RED is a live capture re-encoded with one field changed.
 */
describe(' — LI.FI EVM → Solana: Swift deadline and fee bounds', () => {
    const passes = FIX.lifi.filter((f) => f.expect === 'pass');
    const usdc = passes.find((f) => f.source.includes('none-8453-usdc-to-sol'))!;
    const eth = passes.find((f) => f.source.includes('none-8453-eth-to-sol'))!;
    const feeData = (f: LifiFixture, dists: [string, bigint][]) => f.native
        ? FEES.encodeFunctionData('forwardNativeFees', [dists])
        : FEES.encodeFunctionData('forwardERC20Fees', [f.review.sellToken, dists]);

    it('every live order: deadline 1–60 min after the moment checked, fees exactly 25 bps each to the treasury and LI.FI\'s collector', () => {
        let n = 0;
        for (const f of passes) {
            expect(check(f)).toBe('pass');
            const t = FACET.parseTransaction({ data: f.transactionRequest.data })!;
            const fee = (t.args.swapData as ethers.Result[])[0];
            const dists = (FEES.parseTransaction({ data: fee[5] as string })!.args.distributions as ethers.Result[]).map((d) => [d[0] as string, d[1] as bigint] as const);
            const floor = (BigInt(f.review.sellAmount) * 25n) / 10000n;
            expect(dists.map(([r, a]) => [r.toLowerCase(), a])).toEqual(expect.arrayContaining([
                [PROVIAN_EVM_TREASURY.toLowerCase(), floor], [LIFI_EVM_FEE_COLLECTOR[f.sourceChainId].toLowerCase(), floor],
            ]));
            expect(dists).toHaveLength(2);
            n += 1;
        }
        expect(n).toBe(12);
    });

    it('RED: deadline = 2^64 − 1 (the order could never be cancelled), 0, and now + 3601 s; now + 3600 s signs', () => {
        const now = fixtureNow(usdc);
        const at = (deadline: bigint) => check(usdc, mutateLifi(usdc, ({ params }) => { params[P.deadline] = deadline; }), {}, now);
        expect(at(2n ** 64n - 1n)).toBe('lifi_deadline');
        expect(at(0n)).toBe('lifi_deadline');
        expect(at(BigInt(now) + SWIFT_MAX_DEADLINE_SECONDS + 1n)).toBe('lifi_deadline');
        expect(at(BigInt(now))).toBe('lifi_deadline'); // expired: now is not before it
        expect(at(BigInt(now) + SWIFT_MAX_DEADLINE_SECONDS)).toBe('pass');
        expect(at(BigInt(now) + 1n)).toBe('pass');
        // The live order itself, checked after its deadline (a quote held too long), is refused.
        expect(check(usdc, usdc.transactionRequest.data, {}, Number(evmSwiftDeadline(usdc.transactionRequest.data)))).toBe('lifi_deadline');
    });

    it('RED: Provian\'s fee 0 with the whole fee sent to 0x…dEaD', () => {
        const total = BigInt(usdc.review.provianFee) + BigInt(usdc.review.lifiFee);
        const data = mutateLifi(usdc, ({ swaps }) => { swaps[0][5] = feeData(usdc, [[ATTACKER, total]]); });
        // Reviewed as the relay would have to claim it: Provian 0, LI.FI the rest.
        expect(check(usdc, data, { provianFee: 0n, lifiFee: total })).toBe('lifi_provian_fee');
        // Reviewed honestly, the calldata still pays a stranger.
        expect(check(usdc, data)).toBe('lifi_fee_recipient');
    });

    it('RED: a 4 USDC "LI.FI fee" skim (to LI.FI\'s own collector), and a Provian fee shaved by one unit', () => {
        const collector = LIFI_EVM_FEE_COLLECTOR[usdc.sourceChainId];
        const provianFee = BigInt(usdc.review.provianFee);
        const skim = 4_000_000n;
        const data = mutateLifi(usdc, ({ swaps, bd, order }) => {
            swaps[0][5] = feeData(usdc, [[collector, skim], [PROVIAN_EVM_TREASURY, provianFee]]);
            bd[B.minAmount] = BigInt(usdc.review.sellAmount) - skim - provianFee;
            order[1] = bd[B.minAmount];
        });
        expect(check(usdc, data, { lifiFee: skim })).toBe('lifi_fee_exceeds_review');
        // Reviewed at LI.FI's real 25 bps, the calldata still pays it 4 USDC.
        expect(check(usdc, data)).toBe('lifi_fee_exceeds_review');
        expect(check(usdc, usdc.transactionRequest.data, { provianFee: provianFee - 1n })).toBe('lifi_provian_fee');
        // Native too: 0.004 ETH of a 0.01 ETH swap as LI.FI's fee.
        const ethSkim = 4_000_000_000_000_000n;
        expect(check(eth, eth.transactionRequest.data, { lifiFee: ethSkim })).toBe('lifi_fee_exceeds_review');
    });

    it('RED: an unknown fee collector (LI.FI\'s share, same amount, another address)', () => {
        const lifiFee = BigInt(usdc.review.lifiFee);
        const provianFee = BigInt(usdc.review.provianFee);
        const stranger = '0x1111111111111111111111111111111111111111';
        const data = mutateLifi(usdc, ({ swaps }) => { swaps[0][5] = feeData(usdc, [[stranger, lifiFee], [PROVIAN_EVM_TREASURY, provianFee]]); });
        expect(check(usdc, data)).toBe('lifi_fee_recipient');
        const ethData = mutateLifi(eth, ({ swaps }) => { swaps[0][5] = feeData(eth, [[stranger, BigInt(eth.review.lifiFee)], [PROVIAN_EVM_TREASURY, BigInt(eth.review.provianFee)]]); });
        expect(check(eth, ethData)).toBe('lifi_fee_recipient');
    });

    it('the collector pin is one address on all three chains', () => {
        for (const c of [8453, 42161, 10]) expect(LIFI_EVM_FEE_COLLECTOR[c]).toBe('0xC06ebbefD94032B85424D51906e2A335EFAe264B');
    });
});
