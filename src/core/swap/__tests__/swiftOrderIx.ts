/**
 * Test helper (round 2): a Mayan Swift v2 `init_order` instruction, laid out as Swift v2's
 * on-chain Anchor IDL declares it (= Mayan swap-sdk InitSwiftLayout), and an unsigned LI.FI
 * Solana-source transaction carrying it — the one bridge order the signing guard admits. Engine
 * tests use it so the LI.FI transactions they feed the guard have the shape a real one has.
 */
import {
    Keypair,
    PublicKey,
    SystemProgram,
    TransactionInstruction,
    TransactionMessage,
    VersionedTransaction,
} from '@solana/web3.js';
import { createSyncNativeInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Buffer } from 'buffer';
import { LIFI_SOLANA_FEE_WALLET, MAYAN_FEE_MANAGER_PROGRAM_ID, MAYAN_SWIFT_V2_PROGRAM_ID, SOLANA_WSOL_MINT } from '../solanaSwapGuard';
import { PROVIAN_SOLANA_TREASURY } from '../../fees/FeeConfig';

export interface SwiftOrderShape {
    user: PublicKey;
    /** The token the order takes (the source mint when no swap precedes it). */
    mintFrom: string;
    /** The EVM address paid on the destination chain. */
    evmAddress: string;
    /** Wormhole chain id of the destination (Base 30). */
    wormholeChain: number;
    /** The destination token as 0x + 64 hex. */
    tokenOutWord: string;
    amountInMin: bigint;
    /** Mayan-normalized (at most 8 decimals). */
    amountOutMin: bigint;
    /** Unix seconds; default 15 minutes from now, as live orders carry ( ). */
    deadline?: bigint;
}

/** The fees a LI.FI Solana-source route pays by transfer, in the source token (SOL when `mint` is absent). */
export interface LifiRouteFees {
    provian: bigint;
    lifi: bigint;
    /** SPL source: the mint and its decimals. */
    mint?: string;
    decimals?: number;
}

export function swiftInitOrderIx(o: SwiftOrderShape): TransactionInstruction {
    const data = Buffer.alloc(198);
    Buffer.from('204c290c27a284db', 'hex').copy(data, 0);
    data.writeBigUInt64LE(o.amountInMin, 8);
    data[16] = 0; // native_input
    data.writeBigUInt64LE(0n, 17); // fee_submit
    Buffer.from(o.evmAddress.slice(2).toLowerCase().padStart(64, '0'), 'hex').copy(data, 25);
    data.writeUInt16LE(o.wormholeChain, 57);
    Buffer.from(o.tokenOutWord.slice(2), 'hex').copy(data, 59);
    data.writeBigUInt64LE(o.amountOutMin, 91);
    // gas_drop, fee_cancel, fee_refund = 0; deadline; addr_ref = 0; fee rates 0
    data.writeBigUInt64LE(o.deadline ?? BigInt(Math.floor(Date.now() / 1000) + 900), 123);
    data[165] = 2; // auction_mode: the regular auction, as every live order carries
    Buffer.alloc(32, 5).copy(data, 166); // key_rnd
    const swift = new PublicKey(MAYAN_SWIFT_V2_PROGRAM_ID);
    const w = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
    const r = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
    return new TransactionInstruction({
        programId: swift,
        keys: [
            { pubkey: o.user, isSigner: true, isWritable: false }, // trader
            { pubkey: o.user, isSigner: true, isWritable: true }, // relayer
            w(Keypair.fromSeed(new Uint8Array(32).fill(21)).publicKey), // state
            w(Keypair.fromSeed(new Uint8Array(32).fill(22)).publicKey), // state_from_acc
            w(getAssociatedTokenAddressSync(new PublicKey(o.mintFrom), o.user)), // relayer_fee_acc: the user's own
            r(swift), // custom_payload_store: none
            r(new PublicKey(o.mintFrom)),
            r(new PublicKey(MAYAN_FEE_MANAGER_PROGRAM_ID)),
            r(TOKEN_PROGRAM_ID),
            r(SystemProgram.programId),
        ],
        data,
    });
}

/** The fee transfers a LI.FI Solana-source route makes: Provian's treasury and LI.FI's fee wallet. */
export function lifiFeeTransfers(user: PublicKey, fees: LifiRouteFees): TransactionInstruction[] {
    const out: TransactionInstruction[] = [];
    const pay = (to: string, amount: bigint) => {
        if (amount <= 0n) return;
        if (!fees.mint) {
            out.push(SystemProgram.transfer({ fromPubkey: user, toPubkey: new PublicKey(to), lamports: amount }));
            return;
        }
        const mint = new PublicKey(fees.mint);
        out.push(createTransferCheckedInstruction(
            getAssociatedTokenAddressSync(mint, user), mint, getAssociatedTokenAddressSync(mint, new PublicKey(to)), user, amount, fees.decimals ?? 6,
        ));
    };
    pay(PROVIAN_SOLANA_TREASURY, fees.provian);
    pay(LIFI_SOLANA_FEE_WALLET, fees.lifi);
    return out;
}

/**
 * An unsigned LI.FI Solana-source transaction: pay the route's fees (when given), wrap the user's
 * own SOL, then one Swift order.
 */
export function lifiSwiftTxBase64(o: SwiftOrderShape, extra: TransactionInstruction[] = [], fees?: LifiRouteFees): string {
    const wsol = getAssociatedTokenAddressSync(new PublicKey(SOLANA_WSOL_MINT), o.user);
    return Buffer.from(new VersionedTransaction(new TransactionMessage({
        payerKey: o.user,
        recentBlockhash: new PublicKey(Buffer.alloc(32, 3)).toBase58(),
        instructions: [
            ...(fees ? lifiFeeTransfers(o.user, fees) : []),
            SystemProgram.transfer({ fromPubkey: o.user, toPubkey: wsol, lamports: 1 }),
            createSyncNativeInstruction(wsol),
            swiftInitOrderIx(o),
            ...extra,
        ],
    }).compileToV0Message()).serialize()).toString('base64');
}

/** A 0x + 64-hex word of an EVM address (Mayan's bytes32 form). */
export const evmWord = (address: string): string => '0x' + address.slice(2).toLowerCase().padStart(64, '0');
