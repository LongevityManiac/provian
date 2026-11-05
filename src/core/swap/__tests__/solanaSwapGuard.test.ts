/**
 * the Solana swap signing guard, against REAL transactions (Jupiter via
 * lite-api.jup.ag and LI.FI Solana-source via li.quest, with the lookup tables they load:
 * __fixtures__/solana-route-fixtures.json) and against each of those made malicious one
 * instruction at a time. Every negative control is a transaction the app signed before this
 * guard existed (CrossChainSwapEngine signed any VersionedTransaction the relay returned).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Buffer } from 'buffer';
import {
    AddressLookupTableAccount,
    ComputeBudgetProgram,
    Keypair,
    PublicKey,
    SystemProgram,
    TransactionInstruction,
    TransactionMessage,
    VersionedTransaction,
} from '@solana/web3.js';
import {
    createApproveInstruction,
    createAssociatedTokenAccountIdempotentInstruction,
    createCloseAccountInstruction,
    createSetAuthorityInstruction,
    createSyncNativeInstruction,
    createTransferCheckedInstruction,
    AuthorityType,
    getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
    LIFI_SOLANA_FEE_WALLET,
    LIFI_TRACKER_PROGRAM_ID,
    JUPITER_V6_PROGRAM_ID,
    MAYAN_CPI_PROXY_PROGRAM_ID,
    MAYAN_SWIFT_V2_PROGRAM_ID,
    SOLANA_USDC_MINT,
    SOLANA_WSOL_MINT,
    parseLookupTableAccount,
    verifySolanaSwapTransaction,
    type SolanaRouteReview,
} from '../solanaSwapGuard';
import { SWIFT_MAX_DEADLINE_SECONDS, SwapRouteRefusedError } from '../evmSwapGuard';
import { PROVIAN_SOLANA_TREASURY } from '../../fees/FeeConfig';
import { nowBefore, solanaSwiftDeadline } from './swiftClock';

interface FixtureCase {
    name: string;
    kind: 'jupiter' | 'lifi';
    expect: 'pass' | 'refuse';
    /** A live Swift transaction refused for a named reason ( ). */
    refuseCode?: string;
    user: string;
    tx: string;
    alts: Record<string, { owner: string; data: string }>;
    fees?: { provian: string; lifi: string; treasuryDepositLamports: string; sourceMint: string; sourceAmount?: string };
    /** LI.FI: the Mayan order the quote reviewed (the user's EVM address, chain, token, minimum). */
    bridge?: { evmAddress: string; wormholeChain: number; destToken: string; destDecimals: number; minOutAtomic: string; toAmountAtomic: string };
    /** The slippage the transaction was requested at (the user's choice). */
    slippageBps: number;
    /** Jupiter: the swap the quote showed, atomic units. */
    jupiter?: { inputMint: string; outputMint: string; inAmount: string; outAmount: string };
}
const FIXTURES: FixtureCase[] = JSON.parse(
    readFileSync(join(__dirname, '..', '__fixtures__', 'solana-route-fixtures.json'), 'utf8'),
).cases;

/** A bound no real swap's network fee reaches: the fixture passes are about programs and transfers. */
const GENEROUS_NETWORK_FEE = 1_000_000_000n;

function reviewFor(c: FixtureCase, over: Partial<SolanaRouteReview> = {}): SolanaRouteReview {
    return {
        kind: c.kind,
        user: c.user,
        networkFeeLamports: GENEROUS_NETWORK_FEE,
        slippageBps: c.slippageBps,
        ...(c.jupiter ? {
            jupiter: {
                inputMint: c.jupiter.inputMint,
                outputMint: c.jupiter.outputMint,
                inAmount: BigInt(c.jupiter.inAmount),
                outAmount: BigInt(c.jupiter.outAmount),
            },
        } : {}),
        ...(c.fees ? {
            lifi: {
                sourceMint: c.fees.sourceMint,
                provianFee: BigInt(c.fees.provian),
                lifiFee: BigInt(c.fees.lifi),
                treasuryDepositLamports: BigInt(c.fees.treasuryDepositLamports),
                sourceAmount: BigInt(c.fees.sourceAmount ?? '0'),
                bridge: c.bridge
                    ? { ...c.bridge, minOutAtomic: BigInt(c.bridge.minOutAtomic), toAmountAtomic: BigInt(c.bridge.toAmountAtomic) }
                    // A capture with no quote reviewed nothing: it can only be refused.
                    : { evmAddress: '0x' + '0'.repeat(40), wormholeChain: 0, destToken: '0x' + '0'.repeat(64), destDecimals: 18, minOutAtomic: 1n, toAmountAtomic: 1n },
            },
        } : {}),
        ...over,
    };
}

function loaderFor(c: FixtureCase) {
    return async (key: string): Promise<string[] | null> => {
        const a = c.alts[key];
        return a ? parseLookupTableAccount(a.owner, a.data) : null;
    };
}

/**
 * The clock a fixture is checked at ( ): CAPTURE_LEAD_SEC before its own Swift
 * order's deadline (these captures record no time), or the wall clock when it places no order.
 */
function nowFor(c: FixtureCase): number {
    const deadline = solanaSwiftDeadline(c.tx);
    return deadline === null ? Math.floor(Date.now() / 1000) : nowBefore(deadline);
}

async function outcome(tx: string, review: SolanaRouteReview, c: FixtureCase, nowSec = nowFor(c)): Promise<string> {
    try {
        await verifySolanaSwapTransaction(tx, review, loaderFor(c), nowSec);
        return 'pass';
    } catch (e) {
        if (e instanceof SwapRouteRefusedError) return e.code;
        throw e;
    }
}

function fixture(name: string): FixtureCase {
    const c = FIXTURES.find((f) => f.name === name);
    if (!c) throw new Error(`no fixture ${name}`);
    return c;
}

/** Rebuild a real transaction, editing its instructions (lookup tables kept). */
function rebuilt(c: FixtureCase, edit: (ixs: TransactionInstruction[]) => void): string {
    const vtx = VersionedTransaction.deserialize(new Uint8Array(Buffer.from(c.tx, 'base64')));
    const alts = vtx.message.addressTableLookups.map((l) => new AddressLookupTableAccount({
        key: l.accountKey,
        state: {
            deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0,
            addresses: parseLookupTableAccount(c.alts[l.accountKey.toBase58()].owner, c.alts[l.accountKey.toBase58()].data).map((a) => new PublicKey(a)),
        },
    }));
    const msg = TransactionMessage.decompile(vtx.message, { addressLookupTableAccounts: alts });
    edit(msg.instructions);
    return Buffer.from(new VersionedTransaction(msg.compileToV0Message(alts)).serialize()).toString('base64');
}

/** Rebuild a real transaction with extra instructions appended (lookup tables kept). */
function withExtra(c: FixtureCase, extra: TransactionInstruction[]): string {
    return rebuilt(c, (ixs) => { ixs.push(...extra); });
}

/** Rebuild a real transaction with its (single) Jupiter swap instruction edited. */
function withJupiterEdit(c: FixtureCase, edit: (ix: TransactionInstruction) => void): string {
    return rebuilt(c, (ixs) => {
        const jupIxs = ixs.filter((ix) => ix.programId.toBase58() === JUPITER_V6_PROGRAM_ID);
        if (jupIxs.length !== 1) throw new Error(`${c.name} has ${jupIxs.length} Jupiter instructions`);
        edit(jupIxs[0]);
    });
}

const ATTACKER = Keypair.generate().publicKey;
const usdc = new PublicKey(SOLANA_USDC_MINT);

describe(' Solana guard — real Jupiter and LI.FI transactions', () => {
    const passes = FIXTURES.filter((c) => c.expect === 'pass');
    const refusals = FIXTURES.filter((c) => c.expect === 'refuse' && !c.refuseCode);
    const unpaid = FIXTURES.filter((c) => c.refuseCode);

    it('the population is real and non-empty (Jupiter, and Mayan Swift v2 — the one LI.FI tool the relay requests — to all three chains)', () => {
        expect(passes.filter((c) => c.kind === 'jupiter').length).toBeGreaterThanOrEqual(6);
        const swift = passes.filter((c) => c.kind === 'lifi');
        // 12 live Swift captures; one pays no fee at all and is refused ( ).
        expect(swift.length).toBe(11);
        expect(unpaid.map((c) => c.name)).toEqual(['lifi mayan 10-usdc-to-eth']);
        expect(new Set(swift.map((c) => c.bridge!.wormholeChain))).toEqual(new Set([30, 23, 24]));
        expect(refusals.filter((c) => /mayanFastMCTP/.test(c.name)).length).toBe(4);
        expect(refusals.filter((c) => /mayanMCTP/.test(c.name)).length).toBe(4);
        expect(refusals.filter((c) => /^lifi eco /.test(c.name)).length).toBe(1);
    });

    for (const c of passes) {
        it(`signs: ${c.name}`, async () => {
            expect(await outcome(c.tx, reviewFor(c), c)).toBe('pass');
        });
    }

    // Mayan Fast MCTP / MCTP, Eco and the other tools: their instructions cannot be bound to the
    // minimum the user reviewed, so their deposits go nowhere this wallet accepts (unknown = block).
    for (const c of refusals) {
        it(`RED: refuses ${c.name} (a bridge whose order the wallet cannot decode)`, async () => {
            expect(['solana_disallowed_destination', 'solana_unknown_program', 'solana_route_mismatch'])
                .toContain(await outcome(c.tx, reviewFor(c), c));
        });
    }
    for (const c of unpaid) {
        it(`RED: refuses ${c.name} (${c.refuseCode}: the live transaction pays Provian nothing)`, async () => {
            expect(await outcome(c.tx, reviewFor(c), c)).toBe(c.refuseCode);
        });
    }
});

describe(' Solana guard — each real transaction made malicious (old code signed every one)', () => {
    const jup = fixture('jupiter sol-to-usdc');
    const user = new PublicKey(jup.user);
    const userUsdc = getAssociatedTokenAddressSync(usdc, user);
    const attackerUsdc = getAssociatedTokenAddressSync(usdc, ATTACKER);

    it('control: the unmodified transaction signs', async () => {
        expect(await outcome(withExtra(jup, []), reviewFor(jup), jup)).toBe('pass');
    });

    it('RED: an extra SPL TransferChecked of the user\'s USDC to an outside account', async () => {
        const tx = withExtra(jup, [createTransferCheckedInstruction(userUsdc, usdc, attackerUsdc, user, 1_000_000n, 6)]);
        expect(await outcome(tx, reviewFor(jup), jup)).toBe('solana_disallowed_destination');
    });

    it('RED: an extra SOL transfer to an outside address', async () => {
        const tx = withExtra(jup, [SystemProgram.transfer({ fromPubkey: user, toPubkey: ATTACKER, lamports: 1 })]);
        expect(await outcome(tx, reviewFor(jup), jup)).toBe('solana_disallowed_destination');
    });

    it('RED: an SPL Approve of the user\'s account to a delegate', async () => {
        const tx = withExtra(jup, [createApproveInstruction(userUsdc, ATTACKER, user, 1n)]);
        expect(await outcome(tx, reviewFor(jup), jup)).toBe('solana_disallowed_instruction');
    });

    it('RED: SetAuthority handing the user\'s token account to someone else', async () => {
        const tx = withExtra(jup, [createSetAuthorityInstruction(userUsdc, user, AuthorityType.AccountOwner, ATTACKER)]);
        expect(await outcome(tx, reviewFor(jup), jup)).toBe('solana_disallowed_instruction');
    });

    it('RED: CloseAccount sending the user\'s rent/wrapped SOL to someone else', async () => {
        const wsol = getAssociatedTokenAddressSync(new PublicKey(SOLANA_WSOL_MINT), user);
        const tx = withExtra(jup, [createCloseAccountInstruction(wsol, ATTACKER, user)]);
        expect(await outcome(tx, reviewFor(jup), jup)).toBe('solana_disallowed_destination');
    });

    it('RED: an instruction to a program that is not a known swap or bridge program', async () => {
        const tx = withExtra(jup, [new TransactionInstruction({
            programId: Keypair.generate().publicKey,
            keys: [{ pubkey: user, isSigner: true, isWritable: true }],
            data: Buffer.from([1]),
        })]);
        expect(await outcome(tx, reviewFor(jup), jup)).toBe('solana_unknown_program');
    });

    it('RED: a token account created (with the user\'s SOL) for an owner outside the route', async () => {
        const tx = withExtra(jup, [createAssociatedTokenAccountIdempotentInstruction(user, attackerUsdc, ATTACKER, usdc)]);
        expect(await outcome(tx, reviewFor(jup), jup)).toBe('solana_disallowed_destination');
    });

    it('RED: a Jupiter route may not use a LI.FI bridge program or the Mayan proxy', async () => {
        const tx = withExtra(jup, [new TransactionInstruction({
            programId: new PublicKey(MAYAN_CPI_PROXY_PROGRAM_ID),
            keys: [{ pubkey: SystemProgram.programId, isSigner: false, isWritable: false }],
            data: Buffer.alloc(0),
        })]);
        expect(await outcome(tx, reviewFor(jup), jup)).toBe('solana_unknown_program');
    });

    it('RED: a priority fee above the network fee the user reviewed', async () => {
        // The real transaction carries a Compute Budget price, so 5000 lamports (signature only) is short.
        expect(await outcome(jup.tx, reviewFor(jup, { networkFeeLamports: 5000n }), jup)).toBe('solana_fee_exceeds_review');
    });

    it('RED: a transaction paid by anyone but this wallet', async () => {
        expect(await outcome(jup.tx, reviewFor(jup, { user: ATTACKER.toBase58() }), jup)).toBe('solana_wrong_payer');
    });

    it('RED: a lookup table that cannot be read refuses (never signs blind)', async () => {
        const blind = { ...jup, alts: {} };
        expect(await outcome(jup.tx, reviewFor(jup), blind)).toBe('solana_lookup_table_unavailable');
    });
});

describe(' Solana guard — LI.FI (Mayan) routes made malicious', () => {
    const mayan = fixture('lifi mayan 8453-sol-to-usdc');
    const user = new PublicKey(mayan.user);

    it('control: the unmodified transaction signs', async () => {
        expect(await outcome(withExtra(mayan, []), reviewFor(mayan), mayan)).toBe('pass');
    });

    it('RED: a SOL transfer to an outside address hidden inside Mayan\'s CPI proxy', async () => {
        const inner = SystemProgram.transfer({ fromPubkey: user, toPubkey: ATTACKER, lamports: 1 });
        const tx = withExtra(mayan, [new TransactionInstruction({
            programId: new PublicKey(MAYAN_CPI_PROXY_PROGRAM_ID),
            keys: [{ pubkey: inner.programId, isSigner: false, isWritable: false }, ...inner.keys],
            data: inner.data,
        })]);
        expect(await outcome(tx, reviewFor(mayan), mayan)).toBe('solana_disallowed_destination');
    });

    it('RED: more SOL to LI.FI\'s fee wallet than the LI.FI fee reviewed', async () => {
        const tx = withExtra(mayan, [SystemProgram.transfer({ fromPubkey: user, toPubkey: new PublicKey(LIFI_SOLANA_FEE_WALLET), lamports: 1 })]);
        expect(await outcome(tx, reviewFor(mayan), mayan)).toBe('solana_fee_exceeds_review');
    });

    it('RED: a "bridge deposit" to a program address that no Mayan instruction takes', async () => {
        // A smaller real Mayan transaction, so two more instructions still fit in a packet.
        const fast = fixture('lifi mayan 42161-usdc-to-usdc');
        expect(await outcome(withExtra(fast, []), reviewFor(fast), fast)).toBe('pass');
        // Off-curve like a real ledger, but not an account of any Mayan instruction here.
        const [pda] = PublicKey.findProgramAddressSync([Buffer.from('LEDGER_BRIDGE')], Keypair.generate().publicKey);
        const pdaUsdc = getAssociatedTokenAddressSync(usdc, pda, true);
        const tx = withExtra(fast, [
            createAssociatedTokenAccountIdempotentInstruction(user, pdaUsdc, pda, usdc),
            createTransferCheckedInstruction(getAssociatedTokenAddressSync(usdc, user), usdc, pdaUsdc, user, 1n, 6),
        ]);
        expect(await outcome(tx, reviewFor(fast), fast)).toBe('solana_disallowed_destination');
    });

    it('RED: LI.FI\'s tracker given a writable account', async () => {
        const tx = withExtra(mayan, [new TransactionInstruction({
            programId: new PublicKey(LIFI_TRACKER_PROGRAM_ID),
            keys: [{ pubkey: ATTACKER, isSigner: false, isWritable: true }],
            data: Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8]),
        })]);
        expect(await outcome(tx, reviewFor(mayan), mayan)).toBe('solana_disallowed_instruction');
    });

    it('RED: the reviewed LI.FI fee is below what the transaction pays LI.FI', async () => {
        const review = reviewFor(mayan);
        review.lifi!.lifiFee -= 1n;
        expect(await outcome(mayan.tx, review, mayan)).toBe('solana_fee_exceeds_review');
    });

    it('RED: a LI.FI route with no reviewed fees refuses', async () => {
        const review = reviewFor(mayan);
        delete review.lifi;
        expect(await outcome(mayan.tx, review, mayan)).toBe('solana_review_missing');
    });
});

/** Rebuild a real LI.FI transaction with its Mayan Swift v2 init_order (inside the CPI proxy) edited. */
function withSwiftEdit(c: FixtureCase, edit: (data: Buffer, keys: TransactionInstruction['keys'], ixs: TransactionInstruction[], at: number) => void): string {
    return rebuilt(c, (ixs) => {
        const at = ixs.findIndex((ix) => ix.programId.toBase58() === MAYAN_CPI_PROXY_PROGRAM_ID
            && ix.keys[0]?.pubkey.toBase58() === MAYAN_SWIFT_V2_PROGRAM_ID);
        if (at < 0) throw new Error(`${c.name} has no Swift order`);
        // The proxy's first account is Swift v2; the order's own accounts follow.
        edit(ixs[at].data, ixs[at].keys.slice(1), ixs, at);
    });
}
/** InitOrderParams offsets (Swift v2 IDL; 8-byte discriminator first). */
const SWIFT = { feeSubmit: 17, addrDest: 25, chainDest: 57, tokenOut: 59, amountOutMin: 91, feeCancel: 107, feeRefund: 115, deadline: 123, feeRateRef: 163, auctionMode: 165 } as const;
const ATTACKER_EVM = Buffer.from('bad0000000000000000000000000000000000bad', 'hex');

describe(' round 2 — the Mayan Swift v2 order is decoded and bound to the review', () => {
    const sol = fixture('lifi mayan 8453-sol-to-usdc'); // SOL → Jupiter → USDC → Swift, to Base USDC
    const usdcEth = fixture('lifi mayan 42161-usdc-to-eth'); // USDC → Jupiter → SOL → Swift, to Arbitrum ETH
    const small = fixture('lifi mayan 42161-usdc-to-usdc'); // USDC deposited straight into Swift
    const owner = new PublicKey(small.user);
    const outcomeOf = (c: FixtureCase, tx: string, over: (r: SolanaRouteReview) => void = () => undefined) => {
        const review = reviewFor(c);
        over(review);
        return outcome(tx, review, c);
    };

    it('control: every unmodified rebuild signs', async () => {
        for (const c of [sol, usdcEth, small]) expect(await outcome(withSwiftEdit(c, () => undefined), reviewFor(c), c)).toBe('pass');
    });

    it('control: the order\'s minimum is at least the reviewed toAmountMin in Mayan\'s 8-decimal units', async () => {
        for (const c of FIXTURES.filter((f) => f.kind === 'lifi' && f.expect === 'pass')) {
            const vtx = rebuilt(c, () => undefined);
            expect(await outcome(vtx, reviewFor(c), c)).toBe('pass');
        }
    });

    it('RED: the order pays an attacker\'s EVM address', async () => {
        const tx = withSwiftEdit(sol, (d) => { ATTACKER_EVM.copy(d, SWIFT.addrDest + 12); });
        expect(await outcome(tx, reviewFor(sol), sol)).toBe('solana_wrong_receiver');
    });

    it('RED: the order goes to another chain than the one reviewed', async () => {
        const tx = withSwiftEdit(sol, (d) => { d.writeUInt16LE(23, SWIFT.chainDest); });
        expect(await outcome(tx, reviewFor(sol), sol)).toBe('solana_wrong_destination');
    });

    it('RED: the order pays out another token than the one reviewed', async () => {
        const tx = withSwiftEdit(sol, (d) => { d[SWIFT.tokenOut + 31] ^= 1; });
        expect(await outcome(tx, reviewFor(sol), sol)).toBe('solana_wrong_buy_token');
    });

    it('RED: minimum out = 1 (the attacker keeps the rest)', async () => {
        const tx = withSwiftEdit(sol, (d) => { d.writeBigUInt64LE(1n, SWIFT.amountOutMin); });
        expect(await outcome(tx, reviewFor(sol), sol)).toBe('solana_min_out_below_review');
    });

    it('RED: one unit below the reviewed minimum refuses; the reviewed minimum itself signs', async () => {
        const reviewed = BigInt(usdcEth.bridge!.minOutAtomic) / 10n ** 10n; // ETH: 18 → 8 decimals
        const at = (v: bigint) => withSwiftEdit(usdcEth, (d) => { d.writeBigUInt64LE(v, SWIFT.amountOutMin); });
        expect(await outcome(at(reviewed - 1n), reviewFor(usdcEth), usdcEth)).toBe('solana_min_out_below_review');
        expect(await outcome(at(reviewed), reviewFor(usdcEth), usdcEth)).toBe('pass');
    });

    it('RED: Mayan\'s pre-swap floor (the order\'s amount_in_min) set to 1 — a sandwiched swap whose unfilled order refunds dust', async () => {
        // The Jupiter leg's own floor is the relay's to set; Swift refuses a smaller input than
        // amount_in_min (AmountInTooSmall), so that is the floor bound to the reviewed minimum.
        expect(await outcome(withSwiftEdit(sol, () => undefined), reviewFor(sol), sol)).toBe('pass');
        // (relayer fees zeroed so the 1% relayer-fee bound, which would also refuse, is not what fires)
        const tx = withSwiftEdit(sol, (d) => {
            d.writeBigUInt64LE(1n, 8);
            d.writeBigUInt64LE(0n, SWIFT.feeCancel);
            d.writeBigUInt64LE(0n, SWIFT.feeRefund);
        });
        expect(await outcome(tx, reviewFor(sol), sol)).toBe('solana_min_out_below_review');
        const outMin = (() => { let v = 0n; withSwiftEdit(sol, (d) => { v = d.readBigUInt64LE(SWIFT.amountOutMin); }); return v; })();
        expect(await outcome(withSwiftEdit(sol, (d) => { d.writeBigUInt64LE(outMin - 1n, 8); }), reviewFor(sol), sol)).toBe('solana_min_out_below_review');
        expect(await outcome(withSwiftEdit(sol, (d) => { d.writeBigUInt64LE(outMin, 8); }), reviewFor(sol), sol)).toBe('pass');
    });

    it('RED: a pre-swap into a token other than the Solana form of the reviewed destination', async () => {
        // The reviewed destination is Base USDC; the order (and swap) carry Solana USDC. Review
        // a destination with no Solana counterpart and the same transaction is refused.
        const other = '0x' + '11'.repeat(20);
        const tx = withSwiftEdit(sol, (d) => { Buffer.from(other.slice(2).padStart(64, '0'), 'hex').copy(d, SWIFT.tokenOut); });
        expect(await outcomeOf(sol, tx, (r) => { r.lifi!.bridge.destToken = other; })).toBe('solana_route_mismatch');
    });

    it('round 3: every live order meets the amount SHOWN less the slippage shown, pays no submit fee, relayer fee to the user, auction 2/3', async () => {
        for (const c of FIXTURES.filter((f) => f.kind === 'lifi' && f.expect === 'pass')) {
            let min = 0n; let submit = -1n; let auction = -1; let feeAcc = ''; let mint = ''; let tokenProgram = '';
            withSwiftEdit(c, (d, keys) => {
                min = d.readBigUInt64LE(SWIFT.amountOutMin); submit = d.readBigUInt64LE(SWIFT.feeSubmit); auction = d[SWIFT.auctionMode];
                feeAcc = keys[4].pubkey.toBase58(); mint = keys[6].pubkey.toBase58(); tokenProgram = keys[8].pubkey.toBase58();
            });
            const d = c.bridge!.destDecimals;
            const floor = (BigInt(c.bridge!.toAmountAtomic) * 9950n) / 10000n;
            expect(min).toBeGreaterThanOrEqual(d > 8 ? floor / 10n ** BigInt(d - 8) : floor);
            expect(submit).toBe(0n);
            expect([2, 3]).toContain(auction);
            expect(feeAcc).toBe(getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(c.user), true, new PublicKey(tokenProgram)).toBase58());
        }
    });

    it('RED (round 3): toAmountMin and the order minimum at 10% of an honest toAmount', async () => {
        const shown = BigInt(sol.bridge!.toAmountAtomic); // Base USDC, 6 decimals
        const tenth = shown / 10n;
        const lowered = (r: SolanaRouteReview) => { r.lifi!.bridge.minOutAtomic = tenth; };
        const tx = withSwiftEdit(sol, (d) => { d.writeBigUInt64LE(tenth, SWIFT.amountOutMin); });
        expect(await outcomeOf(sol, tx, lowered)).toBe('solana_min_out_below_review');
        const floor = (shown * 9950n) / 10000n;
        expect(await outcomeOf(sol, withSwiftEdit(sol, (d) => { d.writeBigUInt64LE(floor - 1n, SWIFT.amountOutMin); }), lowered)).toBe('solana_min_out_below_review');
        expect(await outcomeOf(sol, withSwiftEdit(sol, (d) => { d.writeBigUInt64LE(floor, SWIFT.amountOutMin); }), lowered)).toBe('pass');
        // Sol → ETH: 18 decimals, compared in Mayan's 8.
        const eth = usdcEth;
        const ethShown = BigInt(eth.bridge!.toAmountAtomic);
        const ethTenth8 = (ethShown / 10n) / 10n ** 10n;
        const ethTx = withSwiftEdit(eth, (d) => { d.writeBigUInt64LE(ethTenth8, SWIFT.amountOutMin); });
        expect(await outcomeOf(eth, ethTx, (r) => { r.lifi!.bridge.minOutAtomic = ethShown / 10n; })).toBe('solana_min_out_below_review');
    });

    it('RED (round 3): an auction mode outside {2, 3}', async () => {
        for (const mode of [0, 1, 4, 255]) {
            expect(await outcome(withSwiftEdit(sol, (d) => { d[SWIFT.auctionMode] = mode; }), reviewFor(sol), sol)).toBe('solana_auction_mode');
        }
        expect(await outcome(withSwiftEdit(sol, (d) => { d[SWIFT.auctionMode] = 3; }), reviewFor(sol), sol)).toBe('pass');
    });

    it('RED (round 3): a nonzero fee_submit', async () => {
        const tx = withSwiftEdit(small, (d) => { d.writeBigUInt64LE(1n, SWIFT.feeSubmit); });
        expect(await outcome(tx, reviewFor(small), small)).toBe('solana_relayer_fee');
    });

    it('RED (round 3): relayer_fee_acc set to an attacker\'s token account; the program id (absent) signs', async () => {
        const attackerUsdc = getAssociatedTokenAddressSync(usdc, ATTACKER);
        const tx = withSwiftEdit(small, (_d, keys) => { keys[4].pubkey = attackerUsdc; });
        expect(await outcome(tx, reviewFor(small), small)).toBe('solana_disallowed_destination');
        const absent = withSwiftEdit(small, (_d, keys) => { keys[4].pubkey = new PublicKey(MAYAN_SWIFT_V2_PROGRAM_ID); keys[4].isWritable = false; });
        expect(await outcome(absent, reviewFor(small), small)).toBe('pass');
    });

    it('RED: a referrer fee', async () => {
        const tx = withSwiftEdit(sol, (d) => { d[SWIFT.feeRateRef] = 1; });
        expect(await outcome(tx, reviewFor(sol), sol)).toBe('solana_referrer_fee');
    });

    it('RED: cancel + refund fees above 1% of the order input', async () => {
        const tx = withSwiftEdit(small, (d) => { d.writeBigUInt64LE(d.readBigUInt64LE(8), SWIFT.feeCancel); });
        expect(await outcome(tx, reviewFor(small), small)).toBe('solana_relayer_fee');
    });

    it('RED: the order refunds an attacker (trader account replaced)', async () => {
        const tx = withSwiftEdit(small, (_d, keys) => { keys[0].pubkey = ATTACKER; keys[0].isSigner = false; });
        expect(await outcome(tx, reviewFor(small), small)).toBe('solana_wrong_refund');
    });

    it('RED: a Swift instruction other than init_order', async () => {
        const tx = withSwiftEdit(small, (d) => { d[0] ^= 0xff; });
        expect(await outcome(tx, reviewFor(small), small)).toBe('solana_disallowed_instruction');
    });

    it('RED: a LI.FI route with its Swift order removed', async () => {
        const tx = withSwiftEdit(small, (_d, _k, ixs, at) => { ixs.splice(at, 1); });
        expect(['solana_route_mismatch', 'solana_disallowed_destination']).toContain(await outcome(tx, reviewFor(small), small));
    });

    it('RED: the reviewed order to another EVM address than the one this transaction pays', async () => {
        expect(await outcomeOf(sol, sol.tx, (r) => { r.lifi!.bridge.evmAddress = '0x' + ATTACKER_EVM.toString('hex'); })).toBe('solana_wrong_receiver');
    });

    it('RED: a deposit above the amount the user asked to send (an extra transfer into the order\'s escrow)', async () => {
        const userUsdc = getAssociatedTokenAddressSync(usdc, owner);
        const tx = withSwiftEdit(small, (_d, keys, ixs, at) => {
            const escrow = keys[3].pubkey; // state_from_acc: the order's token escrow
            ixs.splice(at, 0, createTransferCheckedInstruction(userUsdc, usdc, escrow, owner, 1n, 6));
        });
        expect(await outcome(tx, reviewFor(small), small)).toBe('solana_spend_exceeds_review');
    });

    it('RED: the reviewed source amount one unit below what the route spends', async () => {
        const spent = BigInt(small.fees!.sourceAmount!);
        expect(await outcomeOf(small, small.tx, (r) => { r.lifi!.sourceAmount = spent - 1n; })).toBe('solana_spend_exceeds_review');
    });
});

describe(' Solana guard — the network-fee bound, exactly', () => {
    // A real LI.FI (Mayan Swift v2) transaction with its Compute Budget set to known values:
    // 1_000_000 micro-lamports × 200_000 units = 200_000 lamports priority + 5000 per signature.
    const c = fixture('lifi mayan 42161-usdc-to-usdc');
    const tx = rebuilt(c, (ixs) => {
        const kept = ixs.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId));
        ixs.splice(0, ixs.length,
            ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 }),
            ...kept);
    });

    it('a fee equal to the one reviewed signs', async () => {
        expect(await outcome(tx, reviewFor(c, { networkFeeLamports: 205_000n }), c)).toBe('pass');
    });
    it('RED: one lamport more than reviewed refuses', async () => {
        expect(await outcome(tx, reviewFor(c, { networkFeeLamports: 204_999n }), c)).toBe('solana_fee_exceeds_review');
    });
});

describe(' Solana guard — Jupiter\'s own swap instruction (decoded by Jupiter\'s on-chain IDL)', () => {
    const jup = fixture('jupiter sol-to-usdc'); // `route`: output to user_destination (account 3)
    const bound = fixture('jupiter sol-to-usdc (quote-bound)'); // review taken from the QUOTE, not the tx
    const user = new PublicKey(jup.user);
    const attackerUsdc = getAssociatedTokenAddressSync(usdc, ATTACKER);

    it('control: the quote-bound capture signs against the quote it came with', async () => {
        expect(bound.jupiter?.outAmount).toBeDefined();
        expect(await outcome(bound.tx, reviewFor(bound), bound)).toBe('pass');
    });

    it('control: an unmodified rebuild signs', async () => {
        expect(await outcome(withJupiterEdit(jup, () => undefined), reviewFor(jup), jup)).toBe('pass');
    });

    it('RED: the swap output redirected to someone else\'s token account', async () => {
        // destination_token_account (account 4) set: Jupiter pays the output there, not to the user.
        const tx = withJupiterEdit(jup, (ix) => { ix.keys[4] = { pubkey: attackerUsdc, isSigner: false, isWritable: true }; });
        expect(await outcome(tx, reviewFor(jup), jup)).toBe('solana_disallowed_destination');
    });

    it('RED: the user_destination account swapped for someone else\'s', async () => {
        const tx = withJupiterEdit(jup, (ix) => { ix.keys[3] = { pubkey: attackerUsdc, isSigner: false, isWritable: true }; });
        expect(await outcome(tx, reviewFor(jup), jup)).toBe('solana_disallowed_destination');
    });

    it('RED: the platform fee paid to an account that is not Provian\'s treasury', async () => {
        const tx = withJupiterEdit(jup, (ix) => { ix.keys[6] = { pubkey: attackerUsdc, isSigner: false, isWritable: true }; });
        expect(await outcome(tx, reviewFor(jup), jup)).toBe('solana_disallowed_destination');
    });

    it('RED: a platform fee above Provian\'s 25 bps', async () => {
        const tx = withJupiterEdit(jup, (ix) => { ix.data[ix.data.length - 1] = 26; });
        expect(await outcome(tx, reviewFor(jup), jup)).toBe('solana_fee_exceeds_review');
    });

    it('RED: more slippage than the user chose', async () => {
        expect(await outcome(bound.tx, reviewFor(bound, { slippageBps: bound.slippageBps - 1 }), bound)).toBe('solana_slippage_exceeds_review');
    });

    it('RED: a promised output below the one the review showed', async () => {
        const review = reviewFor(bound);
        review.jupiter!.outAmount += 1n;
        expect(await outcome(bound.tx, review, bound)).toBe('solana_route_mismatch');
    });

    it('RED: selling a different amount than the one reviewed', async () => {
        const review = reviewFor(bound);
        review.jupiter!.inAmount -= 1n;
        expect(await outcome(bound.tx, review, bound)).toBe('solana_route_mismatch');
    });

    it('RED: a different output token than the one reviewed', async () => {
        const review = reviewFor(bound);
        review.jupiter!.outputMint = SOLANA_WSOL_MINT;
        expect(await outcome(bound.tx, review, bound)).toBe('solana_route_mismatch');
    });

    it('RED: a Jupiter instruction other than an exact-in route (exact_out_route)', async () => {
        const tx = withJupiterEdit(jup, (ix) => { Buffer.from('d033ef977b2bed5c', 'hex').copy(ix.data, 0); });
        expect(await outcome(tx, reviewFor(jup), jup)).toBe('solana_disallowed_instruction');
    });

    it('RED: a Jupiter route with no Jupiter swap in it', async () => {
        const tx = rebuilt(jup, (ixs) => {
            const i = ixs.findIndex((ix) => ix.programId.toBase58() === JUPITER_V6_PROGRAM_ID);
            ixs.splice(i, 1);
        });
        expect(await outcome(tx, reviewFor(jup), jup)).toBe('solana_route_mismatch');
    });

    it('RED: a Jupiter route with no reviewed swap refuses', async () => {
        const review = reviewFor(jup);
        delete review.jupiter;
        expect(await outcome(jup.tx, review, jup)).toBe('solana_review_missing');
    });

    it('RED: a LI.FI route\'s Jupiter leg taking a platform fee (LI.FI pays its fees by transfer)', async () => {
        const lifiV2 = fixture('lifi mayan 8453-sol-to-usdc'); // route_v2: fee bps at data[26..28]
        expect(await outcome(withJupiterEdit(lifiV2, () => undefined), reviewFor(lifiV2), lifiV2)).toBe('pass');
        const tx = withJupiterEdit(lifiV2, (ix) => { ix.data[26] = 1; });
        expect(await outcome(tx, reviewFor(lifiV2), lifiV2)).toBe('solana_fee_exceeds_review');
    });

    it('RED: a LI.FI route\'s Jupiter leg paying its output to someone else', async () => {
        const lifiV2 = fixture('lifi mayan 8453-sol-to-usdc'); // route_v2: destination_token_account = account 7
        const tx = withJupiterEdit(lifiV2, (ix) => { ix.keys[7] = { pubkey: attackerUsdc, isSigner: false, isWritable: true }; });
        expect(await outcome(tx, reviewFor(lifiV2), lifiV2)).toBe('solana_disallowed_destination');
    });

    it('the user is the Jupiter fixtures\' payer (the population is the user\'s own swaps)', () => {
        expect(user.toBase58()).toBe(bound.user);
    });
});

/**
 * — the Solana-source Swift decoder: the order's deadline (Swift refunds an
 * unfilled order only after it; the EVM destination's cancelOrder reverts until then), and the
 * route's fee transfers bounded below (Provian's 25 bps, paid in full) as well as above. Each RED
 * is a live LI.FI transaction rebuilt with one field changed.
 */
describe(' — Solana source: Swift deadline and fee bounds', () => {
    const sol = fixture('lifi mayan 8453-sol-to-usdc');
    const small = fixture('lifi mayan 42161-usdc-to-usdc');
    const swiftPasses = FIXTURES.filter((c) => c.kind === 'lifi' && c.expect === 'pass');
    const swiftAll = FIXTURES.filter((c) => c.kind === 'lifi' && (c.expect === 'pass' || c.refuseCode));
    const withDeadline = (c: FixtureCase, deadline: bigint) => withSwiftEdit(c, (d) => { d.writeBigUInt64LE(deadline, SWIFT.deadline); });

    it('every live Swift order (11 signing, 1 fee-less refused) is checked at its moment; the reviewed fees are exactly 25 bps each', async () => {
        for (const c of swiftAll) {
            expect(solanaSwiftDeadline(c.tx)).not.toBeNull();
            expect(await outcome(c.tx, reviewFor(c), c)).toBe(c.refuseCode ?? 'pass');
            const floor = (BigInt(c.fees!.sourceAmount!) * 25n) / 10000n;
            expect(BigInt(c.fees!.provian)).toBe(floor);
            expect(BigInt(c.fees!.lifi)).toBe(floor);
        }
        expect(swiftPasses).toHaveLength(11);
        expect(swiftAll).toHaveLength(12);
    });

    it('RED: deadline = 2^64 − 1 (never cancellable), 0, and now + 3601 s; now + 3600 s signs', async () => {
        for (const c of [sol, small]) {
            const now = nowFor(c);
            // u64 max is the largest the field holds.
            expect(await outcome(withDeadline(c, 2n ** 64n - 1n), reviewFor(c), c, now)).toBe('solana_deadline');
            expect(await outcome(withDeadline(c, 0n), reviewFor(c), c, now)).toBe('solana_deadline');
            expect(await outcome(withDeadline(c, BigInt(now) + SWIFT_MAX_DEADLINE_SECONDS + 1n), reviewFor(c), c, now)).toBe('solana_deadline');
            expect(await outcome(withDeadline(c, BigInt(now)), reviewFor(c), c, now)).toBe('solana_deadline');
            expect(await outcome(withDeadline(c, BigInt(now) + SWIFT_MAX_DEADLINE_SECONDS), reviewFor(c), c, now)).toBe('pass');
        }
        // The live order checked after its own deadline is refused.
        expect(await outcome(small.tx, reviewFor(small), small, Number(solanaSwiftDeadline(small.tx)))).toBe('solana_deadline');
    });

    it('RED: a reviewed Provian fee of 0 (or one unit short of 25 bps)', async () => {
        for (const c of [sol, small]) {
            const r0 = reviewFor(c);
            r0.lifi!.provianFee = 0n;
            expect(await outcome(c.tx, r0, c)).toBe('solana_provian_fee');
            const short = reviewFor(c);
            short.lifi!.provianFee -= 1n;
            expect(await outcome(c.tx, short, c)).toBe('solana_provian_fee');
        }
    });

    it('RED: the transaction pays Provian\'s treasury nothing (its fee transfer removed), SOL and USDC', async () => {
        const noSolFee = rebuilt(sol, (ixs) => {
            const at = ixs.findIndex((ix) => ix.programId.equals(SystemProgram.programId) && ix.keys[1]?.pubkey.toBase58() === PROVIAN_SOLANA_TREASURY);
            if (at < 0) throw new Error('no SOL fee transfer to the treasury');
            ixs.splice(at, 1);
        });
        expect(await outcome(noSolFee, reviewFor(sol), sol)).toBe('solana_provian_fee');
        const treasuryUsdc = getAssociatedTokenAddressSync(usdc, new PublicKey(PROVIAN_SOLANA_TREASURY), true);
        const noUsdcFee = rebuilt(small, (ixs) => {
            const at = ixs.findIndex((ix) => ix.keys.some((k) => k.pubkey.equals(treasuryUsdc)) && !ix.programId.toBase58().startsWith('AToken'));
            if (at < 0) throw new Error('no USDC fee transfer to the treasury');
            ixs.splice(at, 1);
        });
        expect(await outcome(noUsdcFee, reviewFor(small), small)).toBe('solana_provian_fee');
    });

    it('RED: a 4 USDC "LI.FI fee" reviewed (and 0.004 SOL on a SOL route)', async () => {
        const skim = reviewFor(small);
        skim.lifi!.lifiFee = 4_000_000n;
        expect(await outcome(small.tx, skim, small)).toBe('solana_fee_exceeds_review');
        const solSkim = reviewFor(sol);
        solSkim.lifi!.lifiFee = 4_000_000n;
        expect(await outcome(sol.tx, solSkim, sol)).toBe('solana_fee_exceeds_review');
    });

    it('RED: LI.FI\'s share paid to an unknown collector', async () => {
        const stranger = Keypair.fromSeed(new Uint8Array(32).fill(44)).publicKey;
        const tx = rebuilt(sol, (ixs) => {
            const at = ixs.findIndex((ix) => ix.programId.equals(SystemProgram.programId) && ix.keys[1]?.pubkey.toBase58() === LIFI_SOLANA_FEE_WALLET);
            if (at < 0) throw new Error('no SOL fee transfer to LI.FI');
            ixs[at].keys[1] = { ...ixs[at].keys[1], pubkey: stranger };
        });
        expect(await outcome(tx, reviewFor(sol), sol)).toBe('solana_disallowed_destination');
    });
});
