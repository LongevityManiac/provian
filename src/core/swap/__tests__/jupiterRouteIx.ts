/**
 * Test helper : a Jupiter v6 `route_v2` swap instruction, laid out exactly as Jupiter's
 * on-chain Anchor IDL (account C88XWfp26heEmDkmfSzeXP7Fd7GQJ2j9dDTUsyiZbUTa) declares it, paying
 * the user's own account — the shape the relay's Jupiter order returns. Engine tests use it so the
 * transactions they feed the signing guard carry the one Jupiter swap a Jupiter route must have.
 */
import { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Buffer } from 'buffer';
import { JUPITER_V6_PROGRAM_ID } from '../solanaSwapGuard';

const ROUTE_V2_DISCRIMINATOR = Buffer.from('bb64facc31c4af14', 'hex');
const JUPITER_EVENT_AUTHORITY = new PublicKey('D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf');

export interface JupiterSwapShape {
    user: PublicKey;
    inputMint: string;
    outputMint: string;
    inAmount: bigint;
    outAmount: bigint;
    slippageBps: number;
    feeBps?: number;
}

export function jupiterRouteV2Ix(o: JupiterSwapShape): TransactionInstruction {
    const jup = new PublicKey(JUPITER_V6_PROGRAM_ID);
    const inMint = new PublicKey(o.inputMint);
    const outMint = new PublicKey(o.outputMint);
    const data = Buffer.alloc(8 + 8 + 8 + 2 + 2 + 2 + 4);
    ROUTE_V2_DISCRIMINATOR.copy(data, 0);
    data.writeBigUInt64LE(o.inAmount, 8);
    data.writeBigUInt64LE(o.outAmount, 16);
    data.writeUInt16LE(o.slippageBps, 24);
    data.writeUInt16LE(o.feeBps ?? 25, 26);
    data.writeUInt16LE(0, 28); // positive_slippage_bps
    data.writeUInt32LE(0, 30); // route_plan: empty vec
    return new TransactionInstruction({
        programId: jup,
        keys: [
            { pubkey: o.user, isSigner: true, isWritable: true }, // user_transfer_authority
            { pubkey: getAssociatedTokenAddressSync(inMint, o.user), isSigner: false, isWritable: true },
            { pubkey: getAssociatedTokenAddressSync(outMint, o.user), isSigner: false, isWritable: true },
            { pubkey: inMint, isSigner: false, isWritable: false },
            { pubkey: outMint, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: jup, isSigner: false, isWritable: false }, // destination_token_account: none
            { pubkey: JUPITER_EVENT_AUTHORITY, isSigner: false, isWritable: false },
            { pubkey: jup, isSigner: false, isWritable: false }, // program
        ],
        data,
    });
}

/** An unsigned v0 transaction the user pays for, carrying only that Jupiter swap. */
export function jupiterSwapTxBase64(o: JupiterSwapShape): string {
    const msg = new TransactionMessage({
        payerKey: o.user,
        recentBlockhash: new PublicKey(Buffer.alloc(32, 3)).toBase58(),
        instructions: [jupiterRouteV2Ix(o)],
    }).compileToV0Message();
    return Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64');
}
