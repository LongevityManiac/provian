/**
 * The Solana half of the swap signing guard. Before the app signs a Jupiter or LI.FI
 * Solana transaction it decodes every instruction, resolving the address lookup tables the
 * transaction loads (read from chain), and refuses unless:
 *
 * 1. the user pays the fee and signs first;
 * 2. every program is a known one, and each program is used only for what the route needs:
 * Compute Budget; System (Transfer only); Token / Token-2022 (SyncNative, CloseAccount back
 * to the user, and Transfer / TransferChecked to the destinations in 3 — never Approve,
 * SetAuthority, Burn or anything else); Associated Token (create for an allowed owner, paid
 * by the user); Jupiter v6 (JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4). A LI.FI
 * Solana-source route may also use Mayan Swift v2 (the one LI.FI tool the relay requests,
 * allowBridges=mayan; program id from Mayan's swap-sdk addresses), whose instruction is
 * decoded in full (rule 6); Mayan's CPI proxy, which is unwrapped and its inner
 * instruction checked by these same rules; and LI.FI's transaction-tracking program,
 * which is admitted only with no writable and no signer account (it can then change
 * nothing). Mayan MCTP, Fast MCTP, Swift v1 and the Eco Routes portal are refused: MCTP's
 * on-chain IDL does not carry the instruction LI.FI's route uses and its destination
 * amount depends on fees no instruction states, Fast MCTP's destination amount depends
 * on a protocol fee held in program state (live quotes pay ~3 bps it never names), so
 * neither can be bound to the minimum the user reviewed;
 * 3. no top-level (or proxied) transfer moves the user's SOL or tokens anywhere but: the user's
 * own associated token accounts; for a LI.FI route, Provian's treasury and LI.FI's fee
 * wallet (each at most the fee the user reviewed), and a Mayan bridge deposit — a token
 * account created in this same transaction for an owner that is a program address (off the
 * ed25519 curve, so no key controls it) and that the Mayan instruction itself takes as a
 * writable account, which Mayan's program validates as its own ledger/state (a wrong one
 * fails the whole transaction atomically);
 * 4. the network fee the Compute Budget instructions set is no more than the one reviewed;
 * 5. Jupiter's own swap instruction is one of its four exact-in routes (decoded by Jupiter's
 * on-chain Anchor IDL) and pays its output to the user's own account (or, on a LI.FI route,
 * to a Mayan bridge deposit as in 3), allows no more slippage than the user chose, takes no
 * positive slippage, and takes at most Provian's 25 bps platform fee, to Provian's treasury
 * (none on a LI.FI route, which pays its fees by transfer). On a Jupiter route there is
 * exactly one, selling exactly the amount reviewed for the pair reviewed and promising at
 * least the output reviewed;
 * 6. a LI.FI route places exactly one Mayan Swift v2 `init_order` (layout: Swift v2's on-chain
 * Anchor IDL, account from its `anchor:idl` seed, identical to swap-sdk's InitSwiftLayout),
 * whose refund address and relayer are this wallet, with no custom payload and Mayan's fee
 * manager program; that pays the user's reviewed EVM address on the reviewed chain in the
 * reviewed token at least the reviewed minimum (8-decimal normalized as Mayan stores it); with
 * no referrer fee and cancel + refund relayer fees at most 1% of its input. Everything the
 * route spends of the source token — bridge deposits and a Jupiter leg's input — plus the
 * reviewed fees is at most the amount the user asked to send.
 * 7. ( ) the Swift order's deadline is in the future and at most an hour
 * away (Swift refunds an unfilled order only after its deadline, so a far deadline locks the
 * funds); the reviewed Provian fee is exactly its 25 bps of the amount sent and is paid to
 * the treasury in full, and LI.FI's is at most its 25 bps (both only to their pinned
 * accounts, item 3).
 *
 * Anything else — an unknown program, an extra transfer out, an approval, a transfer to a
 * NEAR-style deposit address no program checks — refuses. The value that moves inside a program
 * (Jupiter's route, a bridge's own transfers) is that program's to enforce; that is what
 * allowlisting the program means.
 */

import {
    AddressLookupTableAccount,
    PublicKey,
    VersionedTransaction,
} from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Buffer } from 'buffer';
import {
    SWIFT_AUCTION_MODES,
    mayanFloorForShown,
    SwapRouteRefusedError,
    assertReviewedLifiFees,
    assertSwiftDeadline,
    unixNow,
} from './evmSwapGuard';
import { PROVIAN_SOLANA_TREASURY, PROVIAN_SOLANA_USDC_FEE_ACCOUNT } from '../fees/FeeConfig';

export const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const ADDRESS_LOOKUP_TABLE_PROGRAM_ID = 'AddressLookupTab1e1111111111111111111111111';
export const JUPITER_V6_PROGRAM_ID = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

export const MAYAN_CPI_PROXY_PROGRAM_ID = 'D8C8iW6zmoKg5TRr8nQ7h14TMWqQX8FiBdj2ju5MF3wa';
export const MAYAN_SWIFT_V2_PROGRAM_ID = 'mayan34VedncxdK2XobtvWFDXQASUTBXhUVzt2kKgny';
/** Mayan's fee-manager program, the one Swift v2 init_order takes (swap-sdk FEE_MANAGER_PROGRAM_ID). */
export const MAYAN_FEE_MANAGER_PROGRAM_ID = '5VtQHnhs2pfVEr68qQsbTRwKh4JV5GTu9mBHgHFxpHeQ';
/** Swift v2 init_order discriminator (sha256("global:init_order")[0..8], = the IDL's). */
const SWIFT_INIT_ORDER_DISCRIMINATOR = '204c290c27a284db';
/** 8 discriminator + InitOrderParams (Swift v2 IDL): 8+1+8+32+2+32+8+8+8+8+8+32+1+1+1+32. */
const SWIFT_INIT_ORDER_LENGTH = 198;
/** The largest share of a Swift order's input its cancel + refund relayer fees may take (1%). */
const MAX_RELAYER_FEE_BPS = 100n;
/** LI.FI's transaction-tracking program: its data is 0x00 + the quote's transactionId. */
export const LIFI_TRACKER_PROGRAM_ID = '3i5JeuZuUxeKtVysUnwQNGerJP2bSMX9fTFfS4Nxe3Br';
/**
 * LI.FI's Solana fee wallet: every LI.FI Solana-source quote pays feeSplit.lifiFee to it (SOL)
 * or to its USDC account (LIFI_SOLANA_USDC_FEE_ACCOUNT, owner verified on chain 2026-09-26).
 */
export const LIFI_SOLANA_FEE_WALLET = '34FKjAdVcTax2DHqV2XnbXa9J3zmyKcFuFKWbcmgxjgm';
export const LIFI_SOLANA_USDC_FEE_ACCOUNT = '8jjWmLhYdqrtFMcEkiMDdqkEN85cvEFnNS4LFgNf5NRv';

export const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
/** Ether (Portal): Wormhole's canonical wrapped ETH on Solana, 8 decimals. */
export const SOLANA_PORTAL_WETH_MINT = '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs';
/** Native USDC on Base, Arbitrum and Optimism (= TOKEN_ADDRESSES[chain].USDC). */
const EVM_USDC = [
    '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
];
/**
 * The Solana token that IS the EVM destination asset: a Mayan route that swaps first (Jupiter)
 * must swap into it, so an order that is never filled refunds the asset the user asked for.
 */
function solanaCounterpart(destTokenWord: string): { mint: string; decimals: number } | null {
    if (destTokenWord === '0'.repeat(64)) return { mint: SOLANA_PORTAL_WETH_MINT, decimals: 8 };
    if (EVM_USDC.some((a) => word32(a) === destTokenWord)) return { mint: SOLANA_USDC_MINT, decimals: 6 };
    return null;
}
export const SOLANA_WSOL_MINT = 'So11111111111111111111111111111111111111112';

/** Mayan programs whose instructions take a bridge deposit's ledger/state account. */
const MAYAN_DEPOSIT_PROGRAMS: ReadonlySet<string> = new Set([MAYAN_SWIFT_V2_PROGRAM_ID]);
const TOKEN_PROGRAMS: ReadonlySet<string> = new Set([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]);

/**
 * Jupiter v6 swap instructions the app signs: the four exact-in routes, by Anchor discriminator.
 * Names, discriminators, account order and argument layout are Jupiter's own on-chain Anchor IDL
 * (account C88XWfp26heEmDkmfSzeXP7Fd7GQJ2j9dDTUsyiZbUTa, read 2026-09-27). Every other Jupiter
 * instruction (exact-out, token-ledger routes, claim, close, create) refuses.
 *   route / shared_accounts_route: `route_plan` first, then in_amount u64, quoted_out_amount u64,
 *     slippage_bps u16, platform_fee_bps u8 — the trailing 19 bytes;
 *   route_v2 / shared_accounts_route_v2: [id u8 for shared] in_amount u64, quoted_out_amount u64,
 *     slippage_bps u16, platform_fee_bps u16, positive_slippage_bps u16, then `route_plan`.
 * An absent optional account is the Jupiter program id itself (Anchor's convention).
 */
type JupiterVariant = 'route' | 'shared_accounts_route' | 'route_v2' | 'shared_accounts_route_v2';
const JUPITER_ROUTE_DISCRIMINATORS: Readonly<Record<string, JupiterVariant>> = {
    e517cb977ae3ad2a: 'route',
    c1209b3341d69c81: 'shared_accounts_route',
    bb64facc31c4af14: 'route_v2',
    d19853937cfed8e9: 'shared_accounts_route_v2',
};
/** The platform fee the relay sets on a Jupiter order (its SWAP_FEE_BPS, paid to Provian's treasury). */
export const JUPITER_PROVIAN_FEE_BPS = 25;

const LAMPORTS_PER_SIGNATURE = 5000n;
const DEFAULT_UNITS_PER_INSTRUCTION = 200_000n;
const MAX_UNITS = 1_400_000n;

/** What the user reviewed for this route. */
export interface SolanaRouteReview {
    kind: 'jupiter' | 'lifi';
    /** The user's Solana address: fee payer, first signer, owner of their own accounts. */
    user: string;
    /** The network fee the review showed (relay-measured `network_fee_lamports`). */
    networkFeeLamports: bigint;
    /** The slippage the user chose, in basis points: no Jupiter leg may allow more. */
    slippageBps: number;
    /** Jupiter route only: the swap the review showed, atomic units. */
    jupiter?: {
        inputMint: string;
        outputMint: string;
        /** Exactly what the user asked to sell. */
        inAmount: bigint;
        /** The quoted output the review showed; the transaction may promise no less. */
        outAmount: bigint;
    };
    /** LI.FI route only: the source token and the fees the review showed, atomic units of it. */
    lifi?: {
        sourceMint: 'native' | string;
        provianFee: bigint;
        lifiFee: bigint;
        /** Extra SOL the review showed for Provian's treasury (`treasury_fee_account_lamports`). */
        treasuryDepositLamports: bigint;
        /** Exactly what the user asked to send, atomic units of the source token (fees included). */
        sourceAmount: bigint;
        /** The Mayan Swift v2 order the route must place. */
        bridge: {
            /** The user's EVM address that receives on the destination chain. */
            evmAddress: string;
            /** Wormhole chain id of the destination (Base 30, Arbitrum 23, Optimism 24). */
            wormholeChain: number;
            /** The destination token as a 0x + 64-hex word (zero for native ETH). */
            destToken: string;
            destDecimals: number;
            /** The guaranteed amount reviewed, destination atomic units. */
            minOutAtomic: bigint;
            /** The amount the review displays as received, destination atomic units. */
            toAmountAtomic: bigint;
        };
    };
}

/** What the check established, for the review to show. */
export interface SolanaRouteCheck {
    /** LI.FI: the minimum the Mayan order enforces, destination atomic units. */
    bridgeMinOutAtomic?: bigint;
}

/** Mayan stores amounts with at most 8 decimals (swap-sdk getAmountOfFractionalAmount). */
function mayanNormalize(amount: bigint, decimals: number): bigint {
    return decimals > 8 ? amount / 10n ** BigInt(decimals - 8) : amount;
}
function mayanDenormalize(amount: bigint, decimals: number): bigint {
    return decimals > 8 ? amount * 10n ** BigInt(decimals - 8) : amount;
}
/** A 0x-hex EVM address or 32-byte word as 64 lowercase hex chars, left-padded (Mayan's form). */
function word32(hex: string): string {
    const h = hex.toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]{1,64}$/.test(h)) throw new SwapRouteRefusedError('solana_review_missing', 'reviewed address is not hex');
    return h.padStart(64, '0');
}

/** Reads an address lookup table's addresses from chain; null when it does not exist. */
export type LookupTableLoader = (tableKey: string) => Promise<string[] | null>;

const refuse = (code: string, message: string): never => {
    throw new SwapRouteRefusedError(code, message);
};

/** Addresses stored in a lookup table account (owner must be the lookup table program). */
export function parseLookupTableAccount(owner: string, dataBase64: string): string[] {
    if (owner !== ADDRESS_LOOKUP_TABLE_PROGRAM_ID) {
        refuse('solana_bad_lookup_table', 'lookup table is not owned by the lookup table program');
    }
    const data = Buffer.from(dataBase64, 'base64');
    if (data.length < 56 || (data.length - 56) % 32 !== 0) {
        refuse('solana_bad_lookup_table', 'lookup table account data is malformed');
    }
    const out: string[] = [];
    for (let o = 56; o < data.length; o += 32) out.push(new PublicKey(data.subarray(o, o + 32)).toBase58());
    return out;
}

/** Decode, resolve lookup tables, and check. Throws SwapRouteRefusedError; returns on pass. */
export async function verifySolanaSwapTransaction(
    txBase64: string,
    review: SolanaRouteReview,
    loadTable: LookupTableLoader,
    /** Unix seconds a Swift order's deadline is checked against ( ). */
    nowSec: number = unixNow(),
): Promise<SolanaRouteCheck> {
    let vtx: VersionedTransaction;
    try {
        vtx = VersionedTransaction.deserialize(new Uint8Array(Buffer.from(txBase64, 'base64')));
    } catch {
        return refuse('solana_tx_malformed', 'swap transaction could not be decoded');
    }
    const tables: AddressLookupTableAccount[] = [];
    for (const l of vtx.message.addressTableLookups) {
        let addresses: string[] | null;
        try {
            addresses = await loadTable(l.accountKey.toBase58());
        } catch {
            addresses = null;
        }
        if (!addresses) return refuse('solana_lookup_table_unavailable', `lookup table ${l.accountKey.toBase58()} could not be read; not signing`);
        tables.push(new AddressLookupTableAccount({
            key: l.accountKey,
            state: {
                deactivationSlot: BigInt('18446744073709551615'),
                lastExtendedSlot: 0,
                lastExtendedSlotStartIndex: 0,
                addresses: addresses.map((a) => new PublicKey(a)),
            },
        }));
    }
    let keys: string[];
    try {
        const resolved = vtx.message.getAccountKeys({ addressLookupTableAccounts: tables });
        keys = [];
        for (let i = 0; i < resolved.length; i += 1) keys.push(resolved.get(i)!.toBase58());
    } catch {
        return refuse('solana_lookup_table_mismatch', 'transaction references lookup table entries that do not exist');
    }
    return verifyResolvedSolanaSwap(vtx, keys, review, nowSec);
}

interface EffectiveIx {
    program: string;
    accounts: number[];
    data: Uint8Array;
}

interface CreatedAta {
    owner: string;
    mint: string;
}

function u32(d: Uint8Array, at: number): number {
    return (d[at] | (d[at + 1] << 8) | (d[at + 2] << 16)) + d[at + 3] * 0x1000000;
}

function u64(d: Uint8Array, at: number): bigint {
    let v = 0n;
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[at + i]);
    return v;
}

function ata(owner: string, mint: string, tokenProgram: string): string {
    return getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), true, new PublicKey(tokenProgram)).toBase58();
}

/**
 * The check itself, over a decoded transaction whose account keys are already resolved (static
 * keys, then each lookup table's writable entries, then each one's readonly entries). Pure.
 */
export function verifyResolvedSolanaSwap(
    vtx: VersionedTransaction,
    keys: string[],
    review: SolanaRouteReview,
    nowSec: number = unixNow(),
): SolanaRouteCheck {
    const msg = vtx.message;
    const lifi = review.kind === 'lifi' ? review.lifi : undefined;
    if (review.kind === 'lifi' && !lifi) refuse('solana_review_missing', 'LI.FI route has no reviewed fees to check against');
    const jup = review.kind === 'jupiter' ? review.jupiter : undefined;
    if (review.kind === 'jupiter' && !jup) refuse('solana_review_missing', 'Jupiter route has no reviewed swap to check against');
    if (!Number.isInteger(review.slippageBps) || review.slippageBps < 0 || review.slippageBps > 10_000) {
        refuse('solana_review_missing', 'no reviewed slippage to check against');
    }
    if (msg.header.numRequiredSignatures < 1 || msg.staticAccountKeys[0]?.toBase58() !== review.user) {
        refuse('solana_wrong_payer', 'swap transaction is not paid and signed first by this wallet');
    }
    const key = (i: number): string => {
        const k = keys[i];
        if (k === undefined) return refuse('solana_tx_malformed', 'instruction references an account that does not exist');
        return k;
    };

    // Unwrap Mayan's CPI proxy: its first account is the program it calls, the rest are that
    // program's accounts, and the data is passed through unchanged.
    const top = msg.compiledInstructions;
    const effective: EffectiveIx[] = top.map((ix) => {
        const program = key(ix.programIdIndex);
        if (program !== MAYAN_CPI_PROXY_PROGRAM_ID) {
            return { program, accounts: ix.accountKeyIndexes, data: ix.data };
        }
        if (!lifi) return refuse('solana_unknown_program', 'Mayan CPI proxy outside a LI.FI route');
        if (ix.accountKeyIndexes.length < 1) return refuse('solana_tx_malformed', 'CPI proxy names no program');
        const inner = key(ix.accountKeyIndexes[0]);
        if (inner === MAYAN_CPI_PROXY_PROGRAM_ID || inner === COMPUTE_BUDGET_PROGRAM_ID) {
            return refuse('solana_unknown_program', `CPI proxy may not call ${inner}`);
        }
        return { program: inner, accounts: ix.accountKeyIndexes.slice(1), data: ix.data };
    });

    // Accounts a Mayan bridge instruction takes as writable: a deposit's ledger/state.
    const bridgeWritable = new Set<string>();
    for (const ix of effective) {
        if (!lifi || !MAYAN_DEPOSIT_PROGRAMS.has(ix.program)) continue;
        for (const i of ix.accounts) if (msg.isAccountWritable(i)) bridgeWritable.add(key(i));
    }
    const isBridgeOwner = (owner: string): boolean =>
        !!lifi && bridgeWritable.has(owner) && !PublicKey.isOnCurve(new PublicKey(owner).toBytes());

    // Token accounts this transaction creates, by the Associated Token program.
    const created = new Map<string, CreatedAta>();
    for (const ix of effective) {
        if (ix.program !== ASSOCIATED_TOKEN_PROGRAM_ID) continue;
        const d = ix.data;
        if (!(d.length === 0 || (d.length === 1 && (d[0] === 0 || d[0] === 1)))) {
            refuse('solana_disallowed_instruction', 'associated token instruction other than create');
        }
        if (ix.accounts.length < 6) refuse('solana_tx_malformed', 'associated token create is missing accounts');
        const [payer, target, owner, mint, , tokenProgram] = ix.accounts.slice(0, 6).map(key);
        if (payer !== review.user) refuse('solana_disallowed_instruction', 'token account created with another payer');
        if (!TOKEN_PROGRAMS.has(tokenProgram)) refuse('solana_disallowed_instruction', 'token account for an unknown token program');
        if (ata(owner, mint, tokenProgram) !== target) refuse('solana_disallowed_instruction', 'created token account is not the owner\'s associated account');
        const ownerAllowed = owner === review.user || owner === PROVIAN_SOLANA_TREASURY
            || (isBridgeOwner(owner) && bridgeWritable.has(target));
        if (!ownerAllowed) refuse('solana_disallowed_destination', `token account created for ${owner}, who is not in the route`);
        created.set(target, { owner, mint });
    }
    const isBridgeDeposit = (dest: string, mint: string): boolean => {
        const c = created.get(dest);
        return !!c && c.mint === mint && c.owner !== review.user && c.owner !== PROVIAN_SOLANA_TREASURY
            && isBridgeOwner(c.owner) && bridgeWritable.has(dest);
    };

    let provianLamports = 0n;
    let lifiLamports = 0n;
    let provianToken = 0n;
    let lifiToken = 0n;
    const userWsol = ata(review.user, SOLANA_WSOL_MINT, TOKEN_PROGRAM_ID);
    const isUserAccount = (account: string, mint: string): boolean => {
        const c = created.get(account);
        if (c) return c.owner === review.user && c.mint === mint;
        return account === ata(review.user, mint, TOKEN_PROGRAM_ID) || account === ata(review.user, mint, TOKEN_2022_PROGRAM_ID);
    };
    const isTreasuryAccount = (account: string, mint: string): boolean =>
        account === ata(PROVIAN_SOLANA_TREASURY, mint, TOKEN_PROGRAM_ID)
        || account === ata(PROVIAN_SOLANA_TREASURY, mint, TOKEN_2022_PROGRAM_ID);

    // Jupiter's swap instruction: it moves the user's input and pays the output, so it is checked
    // like a transfer. The output goes to the user's own account for the output mint (or, on a
    // LI.FI route, to a Mayan bridge deposit, rule 3); it may allow no more slippage than the user
    // chose; its platform fee is Provian's 25 bps to Provian's treasury (a LI.FI route pays its
    // fees by transfer, so its Jupiter leg takes none); and on a Jupiter route it sells exactly
    // the amount reviewed and promises at least the output reviewed.
    let jupiterRoutes = 0;
    // What the route spends of the source token outside the fee transfers (LI.FI).
    const sourceTokenMint = lifi ? (lifi.sourceMint === 'native' ? SOLANA_WSOL_MINT : lifi.sourceMint) : '';
    let sourceSpent = 0n;
    const depositOf = (mint: string, amount: bigint): void => {
        if (mint !== sourceTokenMint) refuse('solana_disallowed_destination', 'a bridge deposit of a token other than the one being sent');
        sourceSpent += amount;
    };
    // Mayan Swift v2 init_order (rule 6).
    let swiftOrders = 0;
    let swiftMintFrom = '';
    let swiftAmountInMin = 0n;
    let swiftAmountOutMin = 0n;
    // Output mints of a LI.FI route's Jupiter legs (Mayan's pre-swap into the order's token).
    const lifiJupiterOut: string[] = [];
    let bridgeMinOutAtomic: bigint | undefined;
    const checkSwiftOrder = (ix: EffectiveIx): void => {
        if (!lifi) return refuse('solana_unknown_program', 'Mayan Swift outside a LI.FI route');
        const bridge = lifi.bridge;
        const d = ix.data;
        if (d.length !== SWIFT_INIT_ORDER_LENGTH || Buffer.from(d.subarray(0, 8)).toString('hex') !== SWIFT_INIT_ORDER_DISCRIMINATOR) {
            refuse('solana_disallowed_instruction', 'Mayan Swift instruction other than init_order');
        }
        const acct = (n: number): string => {
            if (ix.accounts.length <= n) return refuse('solana_tx_malformed', 'Swift init_order is missing accounts');
            return key(ix.accounts[n]);
        };
        // trader(refund address), relayer, state, state_from_acc, relayer_fee_acc,
        // custom_payload_store, mint_from, fee_manager_program, token_program, system_program
        if (acct(0) !== review.user) refuse('solana_wrong_refund', 'Swift order refunds an address other than this wallet');
        if (acct(1) !== review.user) refuse('solana_wrong_refund', 'Swift order relayer is not this wallet');
        if (acct(5) !== MAYAN_SWIFT_V2_PROGRAM_ID) refuse('solana_custom_payload', 'Swift order carries a custom payload');
        if (acct(7) !== MAYAN_FEE_MANAGER_PROGRAM_ID) refuse('solana_unknown_program', 'Swift order names an unknown fee manager');
        if (!TOKEN_PROGRAMS.has(acct(8)) || acct(9) !== SYSTEM_PROGRAM_ID) refuse('solana_unknown_program', 'Swift order names an unknown token or system program');
        // relayer_fee_acc: where the order's submit fee is paid. The program source is not
        // published, so it is bound: this wallet's own associated account for the order's mint
        // (derived here, never read from the account list), or the program id (absent).
        const relayerFeeAcc = acct(4);
        if (relayerFeeAcc !== MAYAN_SWIFT_V2_PROGRAM_ID && relayerFeeAcc !== ata(review.user, acct(6), acct(8))) {
            refuse('solana_disallowed_destination', `Swift order pays its relayer fee to ${relayerFeeAcc}, which is not this wallet's account`);
        }
        let o = 8;
        const take = (n: number): Uint8Array => { const v = d.subarray(o, o + n); o += n; return v; };
        const amountInMin = u64(take(8), 0);
        const nativeInput = take(1)[0];
        const feeSubmit = u64(take(8), 0);
        const addrDest = Buffer.from(take(32)).toString('hex');
        const chainDest = (() => { const b = take(2); return b[0] | (b[1] << 8); })();
        const tokenOut = Buffer.from(take(32)).toString('hex');
        const amountOutMin = u64(take(8), 0);
        take(8); // gas_drop: extra native delivered to the user
        const feeCancel = u64(take(8), 0);
        const feeRefund = u64(take(8), 0);
        const deadline = u64(take(8), 0);
        take(32); // addr_ref
        const feeRateRef = take(1)[0];
        take(1); // fee_rate_mayan: Mayan's own protocol fee, inside the auction's guarantee
        const auctionMode = take(1)[0];
        if (feeSubmit !== 0n) refuse('solana_relayer_fee', `Swift order pays a ${feeSubmit} submit fee`);
        // Swift refunds an unfilled order only after its deadline (the EVM destination's
        // cancelOrder reverts until then), so it must be soon ( ).
        assertSwiftDeadline(deadline, nowSec, 'solana_deadline');
        if (!SWIFT_AUCTION_MODES.has(auctionMode)) refuse('solana_auction_mode', `Swift order auction mode ${auctionMode} is not one the wallet signs`);
        if (nativeInput !== 0) refuse('solana_disallowed_instruction', 'Swift order pulls native SOL directly');
        if (addrDest !== word32(bridge.evmAddress)) refuse('solana_wrong_receiver', 'Swift order pays an address other than this wallet');
        if (chainDest !== bridge.wormholeChain) refuse('solana_wrong_destination', `Swift order goes to Wormhole chain ${chainDest}, not ${bridge.wormholeChain}`);
        if (tokenOut !== word32(bridge.destToken)) refuse('solana_wrong_buy_token', 'Swift order pays out a token other than the one reviewed');
        const reviewedMin = mayanNormalize(bridge.minOutAtomic, bridge.destDecimals);
        if (amountOutMin <= 0n || amountOutMin < reviewedMin) {
            refuse('solana_min_out_below_review', `Swift order guarantees ${amountOutMin}, below the ${reviewedMin} reviewed`);
        }
        // Tied to what the review DISPLAYS (the amount shown less the slippage shown), not only to
        // the relay's toAmountMin.
        let shownFloor = 0n;
        try {
            shownFloor = mayanFloorForShown(bridge.toAmountAtomic, review.slippageBps, bridge.destDecimals);
        } catch (e) {
            refuse('solana_min_out_below_review', e instanceof Error ? e.message : 'the review shows no amount received');
        }
        if (amountOutMin < shownFloor) {
            refuse('solana_min_out_below_review', `Swift order guarantees ${amountOutMin}, below ${shownFloor}: the amount shown less the slippage shown`);
        }
        if (feeRateRef !== 0) refuse('solana_referrer_fee', 'Swift order pays a referrer fee');
        if ((feeCancel + feeRefund) * 10_000n > amountInMin * MAX_RELAYER_FEE_BPS) {
            refuse('solana_relayer_fee', 'Swift order cancel/refund fees exceed 1% of its input');
        }
        swiftOrders += 1;
        swiftMintFrom = acct(6);
        swiftAmountInMin = amountInMin;
        swiftAmountOutMin = amountOutMin;
        bridgeMinOutAtomic = mayanDenormalize(amountOutMin, bridge.destDecimals);
    };
    const checkJupiter = (ix: EffectiveIx): void => {
        const d = ix.data;
        const variant = d.length >= 8 ? JUPITER_ROUTE_DISCRIMINATORS[Buffer.from(d.subarray(0, 8)).toString('hex')] : undefined;
        if (!variant) return refuse('solana_disallowed_instruction', 'Jupiter instruction other than an exact-in route');
        const acct = (n: number): string => {
            if (ix.accounts.length <= n) return refuse('solana_tx_malformed', 'Jupiter route is missing accounts');
            return key(ix.accounts[n]);
        };
        const optional = (n: number): string | null => {
            const a = acct(n);
            return a === JUPITER_V6_PROGRAM_ID ? null : a;
        };
        let dest: string;
        let destMint: string;
        let srcMint: string | null;
        let feeAccount: string | null;
        let inAmount: bigint;
        let quotedOut: bigint;
        let slippageBps: number;
        let feeBps: number;
        let positiveSlippageBps = 0;
        if (variant === 'route' || variant === 'shared_accounts_route') {
            if (d.length < 8 + 4 + 19) return refuse('solana_tx_malformed', 'Jupiter route data is truncated');
            const n = d.length;
            inAmount = u64(d, n - 19);
            quotedOut = u64(d, n - 11);
            slippageBps = d[n - 3] | (d[n - 2] << 8);
            feeBps = d[n - 1];
            if (variant === 'route') {
                // token_program, user_transfer_authority, user_source, user_destination,
                // destination_token_account?, destination_mint, platform_fee_account?, ...
                dest = optional(4) ?? acct(3);
                destMint = acct(5);
                srcMint = null;
                feeAccount = optional(6);
            } else {
                // token_program, program_authority, user_transfer_authority, source, program_source,
                // program_destination, destination_token_account, source_mint, destination_mint,
                // platform_fee_account?, ...
                dest = acct(6);
                srcMint = acct(7);
                destMint = acct(8);
                feeAccount = optional(9);
            }
        } else {
            const o = variant === 'shared_accounts_route_v2' ? 9 : 8;
            if (d.length < o + 22 + 4) return refuse('solana_tx_malformed', 'Jupiter route data is truncated');
            inAmount = u64(d, o);
            quotedOut = u64(d, o + 8);
            slippageBps = d[o + 16] | (d[o + 17] << 8);
            feeBps = d[o + 18] | (d[o + 19] << 8);
            positiveSlippageBps = d[o + 20] | (d[o + 21] << 8);
            feeAccount = null; // v2 names no fee account; the fee is bounded by its bps below
            if (variant === 'route_v2') {
                // user_transfer_authority, user_source, user_destination, source_mint,
                // destination_mint, source_token_program, destination_token_program,
                // destination_token_account?, ...
                dest = optional(7) ?? acct(2);
                srcMint = acct(3);
                destMint = acct(4);
            } else {
                // program_authority, user_transfer_authority, source, program_source,
                // program_destination, destination_token_account, source_mint, destination_mint, ...
                dest = acct(5);
                srcMint = acct(6);
                destMint = acct(7);
            }
        }
        if (lifi) {
            // A LI.FI route's Jupiter leg swaps the source token; its input is part of what the
            // route spends of it (bounded below by the amount the user asked to send).
            if (srcMint === null || srcMint !== sourceTokenMint) {
                refuse('solana_route_mismatch', 'a LI.FI Jupiter leg swaps a token other than the one being sent');
            }
            sourceSpent += inAmount;
        }
        if (!isUserAccount(dest, destMint) && !(lifi && isBridgeDeposit(dest, destMint))) {
            refuse('solana_disallowed_destination', `Jupiter swap pays its output to ${dest}, which is not in the route`);
        }
        if (lifi) {
            // Mayan's pre-swap: its floor is the order's amount_in_min (Swift rejects a smaller
            // input, AmountInTooSmall), bound below to the reviewed minimum after the loop.
            lifiJupiterOut.push(destMint);
        } else if (slippageBps > review.slippageBps) {
            refuse('solana_slippage_exceeds_review', `Jupiter swap allows ${slippageBps} bps of slippage; ${review.slippageBps} were reviewed`);
        }
        if (positiveSlippageBps !== 0) refuse('solana_disallowed_instruction', 'Jupiter swap takes positive slippage');
        if (feeBps > (lifi ? 0 : JUPITER_PROVIAN_FEE_BPS)) {
            refuse('solana_fee_exceeds_review', `Jupiter swap takes a ${feeBps} bps platform fee`);
        }
        const fee = feeAccount;
        if (feeBps > 0 && fee !== null) {
            const feeMints = [destMint, ...(srcMint ? [srcMint] : []), ...(jup ? [jup.inputMint] : [])];
            if (!feeMints.some((m) => isTreasuryAccount(fee, m))) {
                refuse('solana_disallowed_destination', `Jupiter platform fee paid to ${fee}, which is not Provian's treasury`);
            }
        }
        if (jup) {
            jupiterRoutes += 1;
            if (destMint !== jup.outputMint || (srcMint !== null && srcMint !== jup.inputMint)) {
                refuse('solana_route_mismatch', 'Jupiter swap is for a different pair than the one reviewed');
            }
            if (inAmount !== jup.inAmount) {
                refuse('solana_route_mismatch', `Jupiter swap sells ${inAmount}; ${jup.inAmount} was reviewed`);
            }
            if (quotedOut < jup.outAmount) {
                refuse('solana_route_mismatch', `Jupiter swap promises ${quotedOut}; ${jup.outAmount} was reviewed`);
            }
        }
    };
    const tokenFee = (who: 'provian' | 'lifi', mint: string, amount: bigint) => {
        if (!lifi || lifi.sourceMint === 'native' || mint !== lifi.sourceMint) {
            refuse('solana_disallowed_destination', `a ${who} fee is paid in a token other than the one being swapped`);
        }
        if (who === 'provian') provianToken += amount; else lifiToken += amount;
    };

    for (const ix of effective) {
        const d = ix.data;
        const acct = (n: number): string => {
            if (ix.accounts.length <= n) return refuse('solana_tx_malformed', `${ix.program} instruction is missing accounts`);
            return key(ix.accounts[n]);
        };
        switch (ix.program) {
            case COMPUTE_BUDGET_PROGRAM_ID:
            case ASSOCIATED_TOKEN_PROGRAM_ID: // checked above
                break;
            case JUPITER_V6_PROGRAM_ID:
                checkJupiter(ix);
                break;
            case SYSTEM_PROGRAM_ID: {
                if (d.length !== 12 || u32(d, 0) !== 2) refuse('solana_disallowed_instruction', 'System instruction other than Transfer');
                const to = acct(1);
                const lamports = u64(d, 4);
                if (to === userWsol) break; // wrapping the user's own SOL
                if (lifi && to === PROVIAN_SOLANA_TREASURY) { provianLamports += lamports; break; }
                if (lifi && to === LIFI_SOLANA_FEE_WALLET) { lifiLamports += lamports; break; }
                if (lifi && isBridgeDeposit(to, SOLANA_WSOL_MINT)) { depositOf(SOLANA_WSOL_MINT, lamports); break; }
                refuse('solana_disallowed_destination', `SOL transfer to ${to}, which is not in the route`);
                break;
            }
            case TOKEN_PROGRAM_ID:
            case TOKEN_2022_PROGRAM_ID: {
                const op = d[0];
                if (op === 17 && d.length === 1) break; // SyncNative
                if (op === 9 && d.length === 1) { // CloseAccount: rent and wrapped SOL back to the user
                    if (acct(1) !== review.user) refuse('solana_disallowed_destination', 'token account closed to an address other than this wallet');
                    break;
                }
                if (op === 12 && d.length === 10) { // TransferChecked: source, mint, destination, authority
                    const mint = acct(1);
                    const dest = acct(2);
                    const amount = u64(d, 1);
                    if (dest === ata(review.user, mint, ix.program)) break;
                    if (lifi && dest === ata(PROVIAN_SOLANA_TREASURY, mint, ix.program)) { tokenFee('provian', mint, amount); break; }
                    if (lifi && dest === ata(LIFI_SOLANA_FEE_WALLET, mint, ix.program)) { tokenFee('lifi', mint, amount); break; }
                    if (lifi && isBridgeDeposit(dest, mint)) { depositOf(mint, amount); break; }
                    refuse('solana_disallowed_destination', `token transfer to ${dest}, which is not in the route`);
                    break;
                }
                if (op === 3 && d.length === 9) { // Transfer: source, destination, authority (no mint)
                    const dest = acct(1);
                    const amount = u64(d, 1);
                    const c = created.get(dest);
                    if (c && c.owner === review.user) break;
                    if (lifi && dest === PROVIAN_SOLANA_USDC_FEE_ACCOUNT) { tokenFee('provian', SOLANA_USDC_MINT, amount); break; }
                    if (lifi && dest === LIFI_SOLANA_USDC_FEE_ACCOUNT) { tokenFee('lifi', SOLANA_USDC_MINT, amount); break; }
                    if (lifi && c && isBridgeDeposit(dest, c.mint)) { depositOf(c.mint, amount); break; }
                    refuse('solana_disallowed_destination', `token transfer to ${dest}, which is not in the route`);
                    break;
                }
                refuse('solana_disallowed_instruction', `token instruction ${op} is not allowed (only transfers, SyncNative and CloseAccount)`);
                break;
            }
            case MAYAN_SWIFT_V2_PROGRAM_ID:
                checkSwiftOrder(ix);
                break;
            case LIFI_TRACKER_PROGRAM_ID: {
                if (!lifi) refuse('solana_unknown_program', 'LI.FI tracker outside a LI.FI route');
                if (ix.accounts.some((i) => msg.isAccountWritable(i) || msg.isAccountSigner(i))) {
                    refuse('solana_disallowed_instruction', 'LI.FI tracker given a writable or signing account');
                }
                break;
            }
            default:
                refuse('solana_unknown_program', `program ${ix.program} is not a known swap or bridge program`);
        }
    }

    if (jup && jupiterRoutes !== 1) {
        refuse('solana_route_mismatch', `a Jupiter route must be exactly one Jupiter swap; this transaction has ${jupiterRoutes}`);
    }

    if (lifi) {
        const native = lifi.sourceMint === 'native';
        // The fees reviewed are the ones the relay asked for ( ): Provian's
        // exactly its 25 bps of the amount sent, LI.FI's at most its 25 bps. Both are paid only
        // to the accounts pinned above (Provian's treasury, LI.FI's fee wallet).
        assertReviewedLifiFees(lifi.sourceAmount, lifi.provianFee, lifi.lifiFee, { low: 'solana_provian_fee', high: 'solana_fee_exceeds_review' });
        if (provianLamports > (native ? lifi.provianFee : 0n) + lifi.treasuryDepositLamports) {
            refuse('solana_fee_exceeds_review', 'SOL sent to Provian exceeds the fee reviewed');
        }
        if (lifiLamports > (native ? lifi.lifiFee : 0n)) refuse('solana_fee_exceeds_review', 'SOL sent to LI.FI exceeds the fee reviewed');
        if (provianToken > (native ? 0n : lifi.provianFee)) refuse('solana_fee_exceeds_review', 'tokens sent to Provian exceed the fee reviewed');
        if (lifiToken > (native ? 0n : lifi.lifiFee)) refuse('solana_fee_exceeds_review', 'tokens sent to LI.FI exceed the fee reviewed');
        // And Provian's treasury is paid no less than its fee (the SOL it is sent may also carry
        // the reviewed treasury-account deposit).
        if (native ? provianLamports < lifi.provianFee : provianToken !== lifi.provianFee) {
            refuse('solana_provian_fee', `the route pays Provian's treasury ${native ? provianLamports : provianToken}, not the ${lifi.provianFee} reviewed`);
        }
        if (swiftOrders !== 1) refuse('solana_route_mismatch', `a LI.FI route must place exactly one Mayan Swift order; this transaction places ${swiftOrders}`);
        if (lifiJupiterOut.length > 0) {
            // Swapped first: into the Solana form of the asset the user asked for, at least the
            // reviewed minimum of it, so a refund returns no less than what was reviewed.
            const twin = solanaCounterpart(word32(lifi.bridge.destToken));
            if (!twin || swiftMintFrom !== twin.mint || lifiJupiterOut.some((m) => m !== twin.mint)) {
                refuse('solana_route_mismatch', 'a LI.FI route swaps into a token other than the one it bridges');
            }
            if (mayanNormalize(swiftAmountInMin, twin!.decimals) < swiftAmountOutMin) {
                refuse('solana_min_out_below_review', `the swap before the order may yield ${swiftAmountInMin}, below the ${swiftAmountOutMin} the order must pay`);
            }
        } else if (swiftMintFrom !== sourceTokenMint) {
            refuse('solana_route_mismatch', 'the order takes a token other than the one being sent');
        }
        if (sourceSpent + lifi.provianFee + lifi.lifiFee > lifi.sourceAmount) {
            refuse('solana_spend_exceeds_review', `the route spends ${sourceSpent} plus fees, more than the ${lifi.sourceAmount} reviewed`);
        }
    }

    // The network fee: 5000 lamports per signature plus the priority fee the Compute Budget sets
    // (unit price in micro-lamports × unit limit, rounded up) — the relay's own formula.
    let price = 0n;
    let limit: bigint | null = null;
    let others = 0n;
    for (const ix of top) {
        if (key(ix.programIdIndex) !== COMPUTE_BUDGET_PROGRAM_ID) { others += 1n; continue; }
        const d = ix.data;
        if (d[0] === 2 && d.length >= 5) limit = BigInt(u32(d, 1));
        else if (d[0] === 3 && d.length >= 9) price = u64(d, 1);
    }
    const units = limit ?? (others * DEFAULT_UNITS_PER_INSTRUCTION > MAX_UNITS ? MAX_UNITS : others * DEFAULT_UNITS_PER_INSTRUCTION);
    const networkFee = BigInt(msg.header.numRequiredSignatures) * LAMPORTS_PER_SIGNATURE + (price * units + 999_999n) / 1_000_000n;
    if (networkFee > review.networkFeeLamports) {
        refuse('solana_fee_exceeds_review', `network fee ${networkFee} lamports exceeds the ${review.networkFeeLamports} reviewed`);
    }
    return bridgeMinOutAtomic === undefined ? {} : { bridgeMinOutAtomic };
}
