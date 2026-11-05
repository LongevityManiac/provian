vi.mock('../../security/ActionWallet', async () => ({ ActionWallet: (await import('ethers')).ethers.Wallet }));
/**
 * SwapEngine.executeSwap — the 0x money path, end to end through getQuote (relay answer
 * stubbed) with only the chain boundary mocked (provider, wallet, token contract).
 *
 * [Audit Pass-3 #32/#33] Orphaned ERC-20 allowances are revoked on an aborted or reverted swap.
 * [] Nothing is approved or sent unless the transaction is AllowanceHolder → a Settler
 * 0x's registry names, pulling exactly the reviewed amount and paying this wallet at least the
 * reviewed minimum; and a re-quote after the approval is never broadcast when it guarantees
 * less than the quote the user reviewed — it comes back as `requoteRequired` for a new review.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const AH = '0x0000000000001fF3684f28c67538d4D072C22734';
const SETTLER = '0x4f6f91599858bf0d19fabCF2c5d591fE13f7C059';
const OTHER_SETTLER = '0x7747F8D2a76BD6345Cc29622a946A929647F2359';
const ATTACKER = '0x000000000000000000000000000000000000dEaD';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ETH_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const WALLET = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

const state = vi.hoisted(() => ({
    approveCalls: [] as Array<{ spender: string; amount: string }>,
    sent: [] as Array<{ to: string; data: string; value: bigint }>,
    allowance: 0n,
    swapStatus: 1,
    registry: { ownerOf: '', prev: '' } as { ownerOf: string | null; prev: string | null },
}));

vi.mock('ethers', async (importOriginal) => {
    const actual = await importOriginal<typeof import('ethers')>();
    const deployer = new actual.ethers.Interface([
        'function ownerOf(uint256) view returns (address)',
        'function prev(uint128) view returns (address)',
    ]);
    class MockProvider {
        constructor(public url: string) {}
        async call(tx: { to: string; data: string }): Promise<string> {
            const fn = tx.data.startsWith(deployer.getFunction('ownerOf')!.selector) ? 'ownerOf' : 'prev';
            const v = state.registry[fn];
            if (v === null) throw new Error('execution reverted');
            return deployer.encodeFunctionResult(fn, [v]);
        }
    }
    class MockWallet {
        address = WALLET;
        constructor(_pk: string, public provider?: unknown) {}
        async sendTransaction(tx: { to: string; data: string; value: bigint }) {
            state.sent.push(tx);
            return { hash: '0xswap', wait: async () => ({ status: state.swapStatus, hash: '0xswap', blockNumber: 1 }) };
        }
    }
    class MockContract {
        constructor(public address: string, _iface: unknown, _signer: unknown) {}
        async allowance(): Promise<bigint> { return state.allowance; }
        async approve(spender: string, amount: bigint) {
            state.approveCalls.push({ spender, amount: amount.toString() });
            return { hash: '0xapprove', wait: async () => ({ status: 1, hash: '0xapprove' }) };
        }
    }
    return {
        ...actual,
        ethers: { ...actual.ethers, JsonRpcProvider: MockProvider, Wallet: MockWallet, Contract: MockContract },
    };
});

vi.mock('../../wallet/SeedManager', () => ({
    default: {
        requireBiometricSession: vi.fn().mockResolvedValue(undefined),
        getEVMPrivateKey: vi.fn().mockResolvedValue('0x' + '1'.repeat(64)),
    },
}));
vi.mock('../../provenance/ProvenanceEnvelopeManager', () => ({
    default: {
        createEnvelope: vi.fn().mockResolvedValue({ envelope_id: 'pe' }),
        enqueueDeferredEnvelope: vi.fn().mockResolvedValue(undefined),
    },
}));
vi.mock('../../AppModeManager', () => ({ assertWalletEnabled: vi.fn() }));
vi.mock('../../simulation/SimulationEngine', () => ({ default: {} }));
vi.mock('../../../services/ProxyConfig', () => ({
    default: {
        getZeroXUrl: vi.fn(async (endpoint: string) => `https://relay.test/api/proxy/zerox/${endpoint}`),
        getProxyHeaders: vi.fn(async () => ({ Authorization: 'Bearer t' })),
    },
}));

import { ethers } from 'ethers';
import SwapEngine, { SwapQuoteResult } from '../SwapEngine';

const AH_IFACE = new ethers.Interface(['function exec(address operator, address token, uint256 amount, address target, bytes data)']);
const SETTLER_IFACE = new ethers.Interface(['function execute((address recipient, address buyToken, uint256 minAmountOut) slippage, bytes[] actions, bytes32 zidAndAffiliate)']);

/** A relay-shaped 0x v2 allowance-holder answer for USDC → ETH on Base. */
function usdcToEth(o: { minOut: bigint; to?: string; spender?: string; settler?: string; amount?: bigint; recipient?: string } ) {
    const settler = o.settler ?? SETTLER;
    const inner = SETTLER_IFACE.encodeFunctionData('execute', [[o.recipient ?? WALLET, ETH_SENTINEL, o.minOut], [], ethers.ZeroHash]);
    return {
        liquidityAvailable: true,
        buyToken: ETH_SENTINEL,
        buyAmount: (o.minOut + o.minOut / 199n).toString(),
        sellAmount: '5000000',
        minBuyAmount: o.minOut.toString(),
        provian_fee: { bps: 25, amount: '5000000000000', token: ETH_SENTINEL },
        issues: { allowance: { actual: '0', spender: o.spender ?? AH } },
        transaction: {
            to: o.to ?? AH,
            data: AH_IFACE.encodeFunctionData('exec', [settler, USDC, o.amount ?? 5_000_000n, settler, inner]),
            value: '0',
            gas: '300000',
        },
    };
}

let answers: unknown[] = [];
const fetchMock = vi.fn(async () => {
    const body = answers.shift();
    if (!body) throw new Error('no stubbed 0x answer left');
    return { ok: true, status: 200, json: async () => body };
});
const slippageBpsOfCall = (n: number) =>
    new URL((fetchMock.mock.calls[n] as unknown as [string])[0]).searchParams.get('slippageBps');

type Private = {
    getEVMChainConfig: (chainId: number) => Promise<{ rpcUrl: string; name: string } | null>;
    callDataCache: Map<string, Record<string, unknown>>;
    quotes: Map<string, SwapQuoteResult>;
};
const priv = SwapEngine as unknown as Private;

async function quote(body: unknown, slippage = 0.5): Promise<SwapQuoteResult> {
    answers.push(body);
    const q = await SwapEngine.getQuote('Base', 'USDC', 'ETH', '5', slippage, WALLET, 'Base');
    if (!q) throw new Error('quote refused');
    return q;
}

beforeEach(() => {
    state.approveCalls.length = 0;
    state.sent.length = 0;
    state.allowance = 0n;
    state.swapStatus = 1;
    state.registry = { ownerOf: SETTLER, prev: OTHER_SETTLER };
    answers = [];
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
    SwapEngine.stopQuoteCleanup();
    priv.callDataCache.clear();
    vi.spyOn(priv, 'getEVMChainConfig').mockResolvedValue({ rpcUrl: 'http://rpc', name: 'Base' });
});

describe('0x swap — legitimate routes still sign ', () => {
    it('ERC-20 with an allowance already in place: sends the reviewed calldata to AllowanceHolder', async () => {
        state.allowance = 10n ** 18n;
        const q = await quote(usdcToEth({ minOut: 2_000_000_000_000_000n }));
        expect(q.guaranteedAmount).toBe('0.002'); // the minimum the Settler call enforces
        const r = await SwapEngine.executeSwap(q, WALLET, 'Base');
        expect(r.success).toBe(true);
        expect(state.approveCalls).toHaveLength(0);
        expect(state.sent).toHaveLength(1);
        expect(state.sent[0].to).toBe(AH);
    });

    it('a real 0x ETH → USDC quote (Base, recorded 2026-09-25) signs', async () => {
        const fix = JSON.parse(readFileSync(join(__dirname, '..', '__fixtures__', 'evm-route-fixtures.json'), 'utf8')).zerox[0];
        // The recorded fixture keeps only transaction.to/data; 0x v2 sends a native sell's amount as
        // transaction.value, which the guard requires to equal the amount reviewed.
        const transaction = { ...fix.transaction, value: fix.sellAmount };
        answers.push({ ...fix, transaction, liquidityAvailable: true, provian_fee: { bps: 25, amount: fix.fees.integratorFee.amount, token: fix.buyToken } });
        const q = await SwapEngine.getQuote('Base', 'ETH', 'USDC', '0.01', 0.5, WALLET, 'Base');
        expect(q).not.toBeNull();
        expect(q!.guaranteedAmount).toBe('26.914297');
        const r = await SwapEngine.executeSwap(q!, WALLET, 'Base');
        expect(r.success).toBe(true);
        expect(state.sent[0].to.toLowerCase()).toBe(AH.toLowerCase());
        expect(state.sent[0].value).toBe(10n ** 16n);
    });

    it('the previous Settler (0x dwell period) still signs', async () => {
        state.allowance = 10n ** 18n;
        state.registry = { ownerOf: OTHER_SETTLER, prev: SETTLER };
        const r = await SwapEngine.executeSwap(await quote(usdcToEth({ minOut: 10n ** 15n })), WALLET, 'Base');
        expect(r.success).toBe(true);
    });
});

describe('0x swap — the enforced minimum meets the user\'s slippage (round 2)', () => {
    const fix = JSON.parse(readFileSync(join(__dirname, '..', '__fixtures__', 'evm-route-fixtures.json'), 'utf8')).zerox[0];
    /** The real Base ETH → USDC answer, its Settler call rewritten as a compromised relay would. */
    function realWith(o: { minOut?: bigint; extraActions?: string[]; minBuyAmount?: string }) {
        const [operator, token, amount, target, inner] = AH_IFACE.decodeFunctionData('exec', fix.transaction.data) as unknown as [string, string, bigint, string, string];
        const [slip, actions, zid] = SETTLER_IFACE.decodeFunctionData('execute', inner) as unknown as [[string, string, bigint], string[], string];
        const newInner = SETTLER_IFACE.encodeFunctionData('execute', [
            [slip[0], slip[1], o.minOut ?? slip[2]], [...actions, ...(o.extraActions ?? [])], zid,
        ]);
        const data = AH_IFACE.encodeFunctionData('exec', [operator, token, amount, target, newInner]);
        return {
            ...fix, liquidityAvailable: true,
            minBuyAmount: o.minBuyAmount ?? fix.minBuyAmount,
            transaction: { ...fix.transaction, data, value: fix.sellAmount },
            provian_fee: { bps: 25, amount: fix.fees.integratorFee.amount, token: fix.buyToken },
        };
    }
    const ethToUsdc = async (body: unknown) => {
        answers.push(body);
        return SwapEngine.getQuote('Base', 'ETH', 'USDC', '0.01', 0.5, WALLET, 'Base');
    };
    // An extra action paying the user's USDC out: transfer(ATTACKER, 26 USDC).
    const transferOut = new ethers.Interface(['function transfer(address to, uint256 amount)'])
        .encodeFunctionData('transfer', [ATTACKER, 26_000_000n]);

    it('control: the real quote (buyAmount 27049545, min 26914297 at 50 bps) is shown, with its slippage', async () => {
        const q = await ethToUsdc(realWith({}));
        expect(q).not.toBeNull();
        expect(q!.guaranteedAmount).toBe('26.914297');
        expect(q!.slippagePercent).toBe(0.5);
    });

    it('RED: minOut = 1 plus an extra transfer action, the relay reporting minBuyAmount 1, is never shown', async () => {
        // Old code: minOut > 0 and minOut >= the reported minBuyAmount, so it quoted and signed this.
        expect(await ethToUsdc(realWith({ minOut: 1n, extraActions: [transferOut], minBuyAmount: '1' }))).toBeNull();
        expect(state.sent).toHaveLength(0);
    });

    it('RED: one unit below floor(buyAmount × 9950 / 10000) is not shown; the floor itself is', async () => {
        const floor = (BigInt(fix.buyAmount) * 9950n) / 10000n; // 26914297
        expect(floor).toBe(26_914_297n);
        expect(await ethToUsdc(realWith({ minOut: floor - 1n, minBuyAmount: String(floor - 1n) }))).toBeNull();
        expect(await ethToUsdc(realWith({ minOut: floor, minBuyAmount: String(floor) }))).not.toBeNull();
    });

    it('the floor follows the slippage the user chose (1% admits what 0.5% refuses)', async () => {
        const at1pct = (BigInt(fix.buyAmount) * 9900n) / 10000n;
        answers.push(realWith({ minOut: at1pct, minBuyAmount: String(at1pct) }));
        const q = await SwapEngine.getQuote('Base', 'ETH', 'USDC', '0.01', 1, WALLET, 'Base');
        expect(q).not.toBeNull();
        expect(q!.slippagePercent).toBe(1);
        expect(await ethToUsdc(realWith({ minOut: at1pct, minBuyAmount: String(at1pct) }))).toBeNull();
    });
});

describe('0x swap — routers outside the allowlist are refused before any approve or send ', () => {
    /** Seed execution data straight into the cache, as a compromised relay answer would land it. */
    function seeded(over: Record<string, unknown>): SwapQuoteResult {
        const body = usdcToEth({ minOut: 10n ** 15n });
        const q = { ...({} as SwapQuoteResult), quoteId: 'seeded', provider: '0x', fromToken: 'USDC', toToken: 'ETH', fromAmount: '5', toAmount: '0.001', chainId: 8453, expiresAt: Date.now() + 60_000 } as SwapQuoteResult;
        priv.callDataCache.set('seeded', {
            to: body.transaction.to, data: body.transaction.data, value: '0', spender: AH, gas: '300000',
            minBuyAtomic: 10n ** 15n, slippage: 0.5, ...over,
        });
        priv.quotes.set('seeded', q); // the engine's own record: fetched for Base (8453)
        return q;
    }

    it('RED: a transaction `to` outside the allowlist is refused (old code approved it and sent it)', async () => {
        const r = await SwapEngine.executeSwap(seeded({ to: ATTACKER }), WALLET, 'Base');
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/not 0x AllowanceHolder.*Nothing was signed/);
        expect(state.approveCalls).toHaveLength(0);
        expect(state.sent).toHaveLength(0);
    });

    it('RED: an approval spender outside the allowlist is refused (old code approved it)', async () => {
        const r = await SwapEngine.executeSwap(seeded({ spender: ATTACKER }), WALLET, 'Base');
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/spender/);
        expect(state.approveCalls).toHaveLength(0);
        expect(state.sent).toHaveLength(0);
    });

    it('RED: a Settler 0x\'s registry does not name is refused (old code signed it)', async () => {
        state.allowance = 10n ** 18n;
        const q = await quote(usdcToEth({ minOut: 10n ** 15n, settler: ATTACKER }));
        const r = await SwapEngine.executeSwap(q, WALLET, 'Base');
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/not a 0x Settler/);
        expect(state.sent).toHaveLength(0);
    });

    it('RED: an unreadable registry refuses (fail closed)', async () => {
        state.allowance = 10n ** 18n;
        state.registry = { ownerOf: null, prev: SETTLER };
        const r = await SwapEngine.executeSwap(await quote(usdcToEth({ minOut: 10n ** 15n })), WALLET, 'Base');
        expect(r.success).toBe(false);
        expect(state.sent).toHaveLength(0);
    });

    it('RED: a transaction paying the output to another address is refused', async () => {
        state.allowance = 10n ** 18n;
        const r = await SwapEngine.executeSwap(await quote(usdcToEth({ minOut: 10n ** 15n, recipient: ATTACKER })), WALLET, 'Base');
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/address other than this wallet/);
        expect(state.sent).toHaveLength(0);
    });

    it('a route `to` outside the allowlist is not even shown as a quote', async () => {
        answers.push(usdcToEth({ minOut: 10n ** 15n, to: ATTACKER }));
        expect(await SwapEngine.getQuote('Base', 'USDC', 'ETH', '5', 0.5, WALLET, 'Base')).toBeNull();
    });
});

describe('0x swap — the post-approval re-quote ', () => {
    it('RED: a fresh quote guaranteeing less than the one reviewed is NOT broadcast; it comes back for review', async () => {
        const reviewed = await quote(usdcToEth({ minOut: 2_000_000_000_000_000n }));
        answers.push(usdcToEth({ minOut: 1_990_000_000_000_000n })); // price moved against the user
        const r = await SwapEngine.executeSwap(reviewed, WALLET, 'Base');
        expect(r.success).toBe(false);
        expect(r.requoteRequired).toBe(true);
        expect(r.freshQuote?.guaranteedAmount).toBe('0.00199');
        expect(state.sent).toHaveLength(0); // old code broadcast this
        // The exact-amount approval to AllowanceHolder is kept for the re-reviewed swap.
        expect(state.approveCalls).toEqual([{ spender: AH, amount: '5000000' }]);
    });

    it('the re-reviewed fresh quote then swaps with no second approval', async () => {
        const reviewed = await quote(usdcToEth({ minOut: 2_000_000_000_000_000n }));
        answers.push(usdcToEth({ minOut: 1_990_000_000_000_000n }));
        const r = await SwapEngine.executeSwap(reviewed, WALLET, 'Base');
        state.allowance = 5_000_000n; // the approval above, now on chain
        const second = await SwapEngine.executeSwap(r.freshQuote!, WALLET, 'Base');
        expect(second.success).toBe(true);
        expect(state.approveCalls).toHaveLength(1);
        expect(state.sent).toHaveLength(1);
    });

    it('a fresh quote equal to the reviewed minimum is broadcast, with the fresh calldata', async () => {
        const reviewed = await quote(usdcToEth({ minOut: 2_000_000_000_000_000n }));
        const fresh = usdcToEth({ minOut: 2_000_000_000_000_000n });
        answers.push(fresh);
        const r = await SwapEngine.executeSwap(reviewed, WALLET, 'Base');
        expect(r.success).toBe(true);
        expect(state.sent).toHaveLength(1);
        expect(state.sent[0].data).toBe(fresh.transaction.data);
    });

    it('RED: the re-quote uses the slippage the user reviewed, not a fixed 0.5%', async () => {
        const reviewed = await quote(usdcToEth({ minOut: 2_000_000_000_000_000n }), 1.0);
        answers.push(usdcToEth({ minOut: 2_000_000_000_000_000n }));
        await SwapEngine.executeSwap(reviewed, WALLET, 'Base');
        expect(slippageBpsOfCall(0)).toBe('100');
        expect(slippageBpsOfCall(1)).toBe('100'); // old code sent 50
    });

    it('RED: a re-quote whose route is refused is not broadcast and its approval is revoked', async () => {
        const reviewed = await quote(usdcToEth({ minOut: 2_000_000_000_000_000n }));
        answers.push(usdcToEth({ minOut: 2_000_000_000_000_000n, settler: ATTACKER }));
        const r = await SwapEngine.executeSwap(reviewed, WALLET, 'Base');
        expect(r.success).toBe(false);
        expect(state.sent).toHaveLength(0);
        expect(state.approveCalls).toEqual([{ spender: AH, amount: '5000000' }, { spender: AH, amount: '0' }]);
    });
});

describe('0x swap — orphaned-allowance revocation (#32/#33)', () => {
    it('#33 revokes the approval when the post-approval quote refresh fails', async () => {
        const reviewed = await quote(usdcToEth({ minOut: 10n ** 15n }));
        answers.push({ liquidityAvailable: false }); // refresh gets no live quote
        const r = await SwapEngine.executeSwap(reviewed, WALLET, 'Base');
        expect(r.success).toBe(false);
        expect(state.approveCalls).toEqual([{ spender: AH, amount: '5000000' }, { spender: AH, amount: '0' }]);
    });

    it('#32 revokes the approval when the swap reverts', async () => {
        state.swapStatus = 0;
        const reviewed = await quote(usdcToEth({ minOut: 10n ** 15n }));
        answers.push(usdcToEth({ minOut: 10n ** 15n }));
        const r = await SwapEngine.executeSwap(reviewed, WALLET, 'Base');
        expect(r.success).toBe(false);
        expect(state.sent).toHaveLength(1);
        expect(state.approveCalls).toEqual([{ spender: AH, amount: '5000000' }, { spender: AH, amount: '0' }]);
    });
});
