/**
 * SolanaTransactionService — money-path correctness.
 *
 * Builds a real transaction through the service (mocking only the
 * biometric/seed/RPC boundaries), then DECODES the serialized bytes back with
 * @solana/web3.js and asserts: correct fee payer, correct recipient, exact
 * amount, ATA-creation when (and only when) the recipient account is missing,
 * and a valid signature. A serialization/amount bug would surface here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Buffer } from 'buffer';
import {
    Keypair,
    PublicKey,
    Transaction,
    SystemProgram,
    SystemInstruction,
} from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';

const KEYPAIR = Keypair.fromSeed(new Uint8Array(32).fill(7));
const RECIPIENT = Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey.toBase58();
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PYUSD_MINT = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo';
/** PYUSD's mint extensions, as mainnet parses them (2026-09-25). Its transfer hook has no program. */
const PYUSD_EXTENSIONS = [
    { extension: 'mintCloseAuthority' }, { extension: 'permanentDelegate' }, { extension: 'transferFeeConfig' },
    { extension: 'confidentialTransferMint' }, { extension: 'confidentialTransferFeeConfig' },
    { extension: 'transferHook', state: { authority: '2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk', programId: null } },
    { extension: 'metadataPointer' }, { extension: 'tokenMetadata' },
];
const BLOCKHASH = bs58.encode(new Uint8Array(32).fill(3));

const mocks = vi.hoisted(() => ({
    requireBiometricSession: vi.fn(async () => {}),
    getSolanaSeed: vi.fn(async () => new Uint8Array(32).fill(7)),
    getLatestBlockhash: vi.fn(async () => ({ blockhash: '', lastValidBlockHeight: 1 })),
    sendRawTransaction: vi.fn(async (_b64: string) => 'SIGNATURE_PLACEHOLDER'),
    accountExists: vi.fn(async () => true as boolean | null),
    getBalanceLamports: vi.fn(async (_address: string) => 1_000_000_000),
    getMintParsed: vi.fn(async (_mint: string) => null as { owner: string; extensions: Array<{ extension: string; state?: Record<string, unknown> }> } | null),
    getMinimumBalanceForRentExemption: vi.fn(async (size: number) => (size + 128) * 5080),
}));
const {
    requireBiometricSession, getSolanaSeed, getLatestBlockhash, sendRawTransaction, accountExists, getBalanceLamports,
    getMintParsed, getMinimumBalanceForRentExemption,
} = mocks;

vi.mock('../../AppModeManager', () => ({ assertWalletEnabled: vi.fn() }));
vi.mock('../../wallet/SeedManager', () => ({
    default: { requireBiometricSession: mocks.requireBiometricSession, getSolanaSeed: mocks.getSolanaSeed },
}));
vi.mock('./SolanaRpc', () => ({
    default: {
        getLatestBlockhash: mocks.getLatestBlockhash,
        sendRawTransaction: mocks.sendRawTransaction,
        accountExists: mocks.accountExists,
        getBalanceLamports: mocks.getBalanceLamports,
        getMintParsed: mocks.getMintParsed,
        getMinimumBalanceForRentExemption: mocks.getMinimumBalanceForRentExemption,
    },
}));

// Imported after the mocks are registered.
import solanaTx, {
    InsufficientSolForFeesError,
    isSolanaWalletAddress,
    SOLANA_ACCOUNT_RENT_EXEMPT_MIN_LAMPORTS,
    SOLANA_BASE_FEE_LAMPORTS,
    SPL_TOKEN_ACCOUNT_RENT_LAMPORTS,
    splSendFunding,
    token2022AccountSize,
} from './SolanaTransactionService';

function decodeLastSentTx(): Transaction {
    const base64 = sendRawTransaction.mock.calls.at(-1)?.[0] as string;
    return Transaction.from(Buffer.from(base64, 'base64'));
}

beforeEach(() => {
    sendRawTransaction.mockClear();
    requireBiometricSession.mockClear();
    getLatestBlockhash.mockResolvedValue({ blockhash: BLOCKHASH, lastValidBlockHeight: 1 });
    getSolanaSeed.mockResolvedValue(new Uint8Array(32).fill(7));
    requireBiometricSession.mockResolvedValue(undefined);
    accountExists.mockReset();
    accountExists.mockResolvedValue(true);
    getBalanceLamports.mockReset();
    getBalanceLamports.mockResolvedValue(1_000_000_000);
    getMintParsed.mockReset();
    getMintParsed.mockImplementation(async (mint: string) =>
        mint === PYUSD_MINT
            ? { owner: TOKEN_2022_PROGRAM_ID.toBase58(), extensions: PYUSD_EXTENSIONS }
            : { owner: TOKEN_PROGRAM_ID.toBase58(), extensions: [] });
    getMinimumBalanceForRentExemption.mockReset();
    getMinimumBalanceForRentExemption.mockImplementation(async (size: number) => (size + 128) * 5080);
});

describe('sendSOL', () => {
    it('builds a valid, correctly-signed native transfer', async () => {
        await solanaTx.sendSOL({ to: RECIPIENT, amount: '0.25' });

        const tx = decodeLastSentTx();
        expect(tx.feePayer?.toBase58()).toBe(KEYPAIR.publicKey.toBase58());
        expect(tx.recentBlockhash).toBe(BLOCKHASH);
        expect(tx.instructions).toHaveLength(1);
        const ix = tx.instructions[0];
        expect(ix.programId.equals(SystemProgram.programId)).toBe(true);
        // Decode SystemProgram transfer to assert recipient + lamports.
        const decoded = SystemInstruction.decodeTransfer(ix);
        expect(decoded.toPubkey.toBase58()).toBe(RECIPIENT);
        expect(decoded.lamports.toString()).toBe('250000000'); // 0.25 SOL
        expect(tx.verifySignatures()).toBe(true);
    });

    it('FAIL CLOSED: rejects a non-base58 / off-curve recipient', async () => {
        await expect(solanaTx.sendSOL({ to: 'not-an-address', amount: '1' })).rejects.toThrow(
            /Invalid Solana recipient/,
        );
        await expect(solanaTx.sendSOL({ to: RECIPIENT, amount: '0' })).rejects.toThrow(/zero/);
    });

    it('a native send keeps the sender rent-exempt or empties it exactly; anything between is refused before signing (2026-10-17)', async () => {
        const amount = 250_000_000; // 0.25 SOL
        const fee = 5000;
        const rent = 890_880;
        // RED: the balance covers the amount and the fee but leaves 1 lamport — the node rejects
        // this with "insufficient funds for rent"; before the preflight it was signed and broadcast.
        getBalanceLamports.mockResolvedValueOnce(amount + fee + 1);
        sendRawTransaction.mockClear();
        await expect(solanaTx.sendSOL({ to: RECIPIENT, amount: '0.25' })).rejects.toMatchObject({ code: 'INSUFFICIENT_SOL_FOR_FEES' });
        expect(sendRawTransaction).not.toHaveBeenCalled();
        // Short of the fee itself.
        getBalanceLamports.mockResolvedValueOnce(amount + fee - 1);
        await expect(solanaTx.sendSOL({ to: RECIPIENT, amount: '0.25' })).rejects.toMatchObject({ code: 'INSUFFICIENT_SOL_FOR_FEES' });
        expect(sendRawTransaction).not.toHaveBeenCalled();
        // Exactly amount + fee empties the account: valid.
        getBalanceLamports.mockResolvedValueOnce(amount + fee);
        await solanaTx.sendSOL({ to: RECIPIENT, amount: '0.25' });
        expect(sendRawTransaction).toHaveBeenCalledTimes(1);
        // Leaving the rent-exempt minimum: valid.
        getBalanceLamports.mockResolvedValueOnce(amount + fee + rent);
        await solanaTx.sendSOL({ to: RECIPIENT, amount: '0.25' });
        expect(sendRawTransaction).toHaveBeenCalledTimes(2);
        // The screen's preflight answers the same question without a key.
        getBalanceLamports.mockResolvedValueOnce(amount + fee + 1);
        const req = await solanaTx.solSendSolRequirement({ from: KEYPAIR.publicKey.toBase58(), amount: '0.25' });
        expect(req).toEqual({ sufficient: false, haveLamports: amount + fee + 1, neededLamports: amount + fee + rent });
    });
});

describe('sendSPL (USDC)', () => {
    it('builds a transferChecked with exact amount + decimals when ATA exists', async () => {
        accountExists.mockResolvedValue(true);
        await solanaTx.sendSPL({ to: RECIPIENT, amount: '12.5', mint: USDC_MINT, decimals: 6 });

        const tx = decodeLastSentTx();
        expect(tx.instructions).toHaveLength(1); // no create-ATA
        const ix = tx.instructions[0];
        expect(ix.programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
        // TransferChecked layout: [instruction(12), amount(u64 LE), decimals(u8)]
        expect(ix.data[0]).toBe(12);
        const amount = ix.data.readBigUInt64LE(1);
        expect(amount.toString()).toBe('12500000'); // 12.5 USDC @ 6dp
        expect(ix.data[9]).toBe(6);
        // Source ATA = sender's ATA, present in the account metas.
        const fromAta = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), KEYPAIR.publicKey);
        expect(ix.keys.some((k) => k.pubkey.equals(fromAta))).toBe(true);
        expect(tx.verifySignatures()).toBe(true);
    });

    it('prepends create-ATA when the recipient token account is missing', async () => {
        accountExists.mockResolvedValue(false);
        await solanaTx.sendSPL({ to: RECIPIENT, amount: '1', mint: USDC_MINT, decimals: 6 });

        const tx = decodeLastSentTx();
        expect(tx.instructions).toHaveLength(2); // create-ATA + transfer
        expect(tx.verifySignatures()).toBe(true);
    });

    it('FAIL CLOSED: aborts if recipient account existence is unknown (RPC failure)', async () => {
        accountExists.mockResolvedValue(null);
        await expect(
            solanaTx.sendSPL({ to: RECIPIENT, amount: '1', mint: USDC_MINT, decimals: 6 }),
        ).rejects.toThrow(/verify recipient token account/i);
        expect(sendRawTransaction).not.toHaveBeenCalled();
    });
});

describe('SPL send needs SOL for fees (a USDC balance pays no fee)', () => {
    const SPL = { to: RECIPIENT, amount: '1', mint: USDC_MINT, decimals: 6 };
    const FEE = SOLANA_BASE_FEE_LAMPORTS;
    const RENT = SPL_TOKEN_ACCOUNT_RENT_LAMPORTS;
    const MIN = SOLANA_ACCOUNT_RENT_EXEMPT_MIN_LAMPORTS;

    it('RED: a wallet with 0 SOL is refused before broadcast, naming fee + rent + minimum when the recipient account is missing', async () => {
        accountExists.mockResolvedValue(false);
        getBalanceLamports.mockResolvedValue(0);
        const err = await solanaTx.sendSPL(SPL).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(InsufficientSolForFeesError);
        const e = err as InsufficientSolForFeesError;
        expect(e.neededLamports).toBe(FEE + RENT + MIN);
        expect(e.haveLamports).toBe(0);
        expect(e.createsTokenAccount).toBe(true);
        expect(sendRawTransaction).not.toHaveBeenCalled();
    });

    it('RED: fee-only shortfall when the recipient account exists (one lamport short of the fee)', async () => {
        accountExists.mockResolvedValue(true);
        getBalanceLamports.mockResolvedValue(FEE - 1);
        await expect(solanaTx.sendSPL(SPL)).rejects.toMatchObject({
            code: 'INSUFFICIENT_SOL_FOR_FEES',
            neededLamports: FEE + MIN,
            createsTokenAccount: false,
        });
        expect(sendRawTransaction).not.toHaveBeenCalled();
    });

    it('RED: enough for fee + rent but the remainder would sit below the rent-exempt minimum', async () => {
        // the negative control: 2,500,000 lamports, recipient has no token account → would end at
        // 455,720, which the node rejects with "insufficient funds for rent".
        accountExists.mockResolvedValue(false);
        getBalanceLamports.mockResolvedValue(2_500_000);
        await expect(solanaTx.sendSPL(SPL)).rejects.toBeInstanceOf(InsufficientSolForFeesError);
        getBalanceLamports.mockResolvedValue(FEE + RENT + MIN - 1);
        await expect(solanaTx.sendSPL(SPL)).rejects.toBeInstanceOf(InsufficientSolForFeesError);
        expect(sendRawTransaction).not.toHaveBeenCalled();
    });

    it('GREEN at the boundary: fee + rent + minimum held, the send goes out with create-ATA', async () => {
        accountExists.mockResolvedValue(false);
        getBalanceLamports.mockResolvedValue(FEE + RENT + MIN);
        await solanaTx.sendSPL(SPL);
        expect(sendRawTransaction).toHaveBeenCalledTimes(1);
        expect(decodeLastSentTx().instructions).toHaveLength(2);
    });

    it('GREEN: exactly fee + rent drains the account to 0, which Solana allows', async () => {
        accountExists.mockResolvedValue(false);
        getBalanceLamports.mockResolvedValue(FEE + RENT);
        await solanaTx.sendSPL(SPL);
        expect(sendRawTransaction).toHaveBeenCalledTimes(1);
    });

    it('the balance is read for the SENDER, not the recipient', async () => {
        await solanaTx.sendSPL(SPL);
        expect(getBalanceLamports).toHaveBeenCalledWith(KEYPAIR.publicKey.toBase58());
    });

    it('splSendFunding: the valid set is {spend} ∪ [spend + minimum, ∞)', () => {
        const spend = FEE + RENT;
        expect(splSendFunding(false, spend - 1).sufficient).toBe(false);
        expect(splSendFunding(false, spend).sufficient).toBe(true);
        expect(splSendFunding(false, spend + 1).sufficient).toBe(false);
        expect(splSendFunding(false, spend + MIN - 1).sufficient).toBe(false);
        expect(splSendFunding(false, spend + MIN).sufficient).toBe(true);
        expect(splSendFunding(true, FEE + MIN).sufficient).toBe(true);
        expect(splSendFunding(true, FEE + MIN - 1).sufficient).toBe(false);
    });

    it('preflight: reports the requirement without signing anything', async () => {
        accountExists.mockResolvedValue(false);
        getBalanceLamports.mockResolvedValue(0);
        const r = await solanaTx.splSendSolRequirement({ from: KEYPAIR.publicKey.toBase58(), to: RECIPIENT, mint: USDC_MINT });
        expect(r).toEqual({ createsTokenAccount: true, neededLamports: FEE + RENT + MIN, haveLamports: 0, sufficient: false });
        expect(getBalanceLamports).toHaveBeenCalledWith(KEYPAIR.publicKey.toBase58());
        expect(requireBiometricSession).not.toHaveBeenCalled();

        accountExists.mockResolvedValue(true);
        getBalanceLamports.mockResolvedValue(FEE + MIN);
        const ok = await solanaTx.splSendSolRequirement({ from: KEYPAIR.publicKey.toBase58(), to: RECIPIENT, mint: USDC_MINT });
        expect(ok.sufficient).toBe(true);
        expect(ok.createsTokenAccount).toBe(false);
    });

    it('preflight fails closed on unknown recipient-account state', async () => {
        accountExists.mockResolvedValue(null);
        await expect(
            solanaTx.splSendSolRequirement({ from: KEYPAIR.publicKey.toBase58(), to: RECIPIENT, mint: USDC_MINT }),
        ).rejects.toThrow(/verify recipient token account/i);
    });

    it('rent constants match the rent-exempt formula ((bytes + 128) * 3480 * 2)', () => {
        expect(RENT).toBe((165 + 128) * 3480 * 2);
        expect(MIN).toBe((0 + 128) * 3480 * 2);
    });
});

describe('isSolanaWalletAddress', () => {
    it('accepts an on-curve wallet key; refuses a token-account (off-curve) address, EVM, short and junk input', () => {
        expect(isSolanaWalletAddress(RECIPIENT)).toBe(true);
        const tokenAccount = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), new PublicKey(RECIPIENT)).toBase58();
        expect(PublicKey.isOnCurve(new PublicKey(tokenAccount).toBytes())).toBe(false);
        expect(isSolanaWalletAddress(tokenAccount)).toBe(false);
        expect(isSolanaWalletAddress('0x086e0F37000000000000000000000000000aF1dA')).toBe(false);
        expect(isSolanaWalletAddress('abc')).toBe(false);
        expect(isSolanaWalletAddress('')).toBe(false);
    });

    it('agrees with the send path: an address it refuses, sendSPL refuses too', async () => {
        const tokenAccount = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), new PublicKey(RECIPIENT)).toBase58();
        await expect(solanaTx.sendSPL({ to: tokenAccount, amount: '1', mint: USDC_MINT, decimals: 6 })).rejects.toThrow(
            /not a valid wallet address/,
        );
    });
});

describe('amount entry as typed on the Send screen', () => {
    it('RED case: ".01" USDC sends exactly 10,000 base units (was refused as "Invalid amount")', async () => {
        await solanaTx.sendSPL({ to: RECIPIENT, amount: '.01', mint: USDC_MINT, decimals: 6 });
        const ix = decodeLastSentTx().instructions.at(-1)!;
        expect(ix.data[0]).toBe(12);
        expect(ix.data.readBigUInt64LE(1).toString()).toBe('10000');
    });

    it('".5" SOL sends exactly 500,000,000 lamports', async () => {
        await solanaTx.sendSOL({ to: RECIPIENT, amount: '.5' });
        expect(SystemInstruction.decodeTransfer(decodeLastSentTx().instructions[0]).lamports.toString()).toBe('500000000');
    });
});

describe('sendSPL (Token-2022, e.g. PYUSD)', () => {
    const PY = { to: RECIPIENT, amount: '2.5', mint: PYUSD_MINT, decimals: 6 };
    const mint = new PublicKey(PYUSD_MINT);

    it('derives both accounts and runs both instructions under the Token-2022 program', async () => {
        accountExists.mockResolvedValue(false);
        await solanaTx.sendSPL(PY);
        const tx = decodeLastSentTx();
        expect(tx.instructions).toHaveLength(2);
        const [create, transfer] = tx.instructions;
        const toAta = getAssociatedTokenAddressSync(mint, new PublicKey(RECIPIENT), false, TOKEN_2022_PROGRAM_ID);
        const fromAta = getAssociatedTokenAddressSync(mint, KEYPAIR.publicKey, false, TOKEN_2022_PROGRAM_ID);
        expect(create.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
        expect(create.keys[1].pubkey.equals(toAta)).toBe(true);
        expect(create.keys.some((k) => k.pubkey.equals(TOKEN_2022_PROGRAM_ID))).toBe(true);
        expect(transfer.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
        expect(transfer.keys[0].pubkey.equals(fromAta)).toBe(true);
        expect(transfer.keys[2].pubkey.equals(toAta)).toBe(true);
        expect(transfer.data[0]).toBe(12);
        expect(transfer.data.readBigUInt64LE(1).toString()).toBe('2500000');
        expect(tx.verifySignatures()).toBe(true);
    });

    it('RED control: the classic-program address is NOT where a Token-2022 send goes', async () => {
        await solanaTx.sendSPL(PY);
        const classicFrom = getAssociatedTokenAddressSync(mint, KEYPAIR.publicKey);
        expect(decodeLastSentTx().instructions[0].keys[0].pubkey.equals(classicFrom)).toBe(false);
    });

    it('prices the recipient account from its size on chain (never below the classic figure)', async () => {
        getMinimumBalanceForRentExemption.mockResolvedValue(3_000_000);
        accountExists.mockResolvedValue(false);
        const r = await solanaTx.splSendSolRequirement({ from: KEYPAIR.publicKey.toBase58(), to: RECIPIENT, mint: PYUSD_MINT });
        expect(getMinimumBalanceForRentExemption).toHaveBeenCalledWith(187);
        expect(r.neededLamports).toBe(SOLANA_BASE_FEE_LAMPORTS + 3_000_000 + SOLANA_ACCOUNT_RENT_EXEMPT_MIN_LAMPORTS);

        getMinimumBalanceForRentExemption.mockResolvedValue(1_600_200); // today's 187-byte figure
        const r2 = await solanaTx.splSendSolRequirement({ from: KEYPAIR.publicKey.toBase58(), to: RECIPIENT, mint: PYUSD_MINT });
        expect(r2.neededLamports).toBe(SOLANA_BASE_FEE_LAMPORTS + SPL_TOKEN_ACCOUNT_RENT_LAMPORTS + SOLANA_ACCOUNT_RENT_EXEMPT_MIN_LAMPORTS);
    });

    it('RED: a Token-2022 mint with an active transfer hook is refused before any key is loaded', async () => {
        getMintParsed.mockResolvedValue({
            owner: TOKEN_2022_PROGRAM_ID.toBase58(),
            extensions: [{ extension: 'transferHook', state: { programId: 'HooK1111111111111111111111111111111111111111' } }],
        });
        await expect(solanaTx.sendSPL(PY)).rejects.toThrow(/transfer hook/);
        expect(requireBiometricSession).not.toHaveBeenCalled();
        expect(sendRawTransaction).not.toHaveBeenCalled();
    });

    it('RED: a mint no token program owns, or that does not exist, is refused', async () => {
        getMintParsed.mockResolvedValue({ owner: SystemProgram.programId.toBase58(), extensions: [] });
        await expect(solanaTx.sendSPL(PY)).rejects.toThrow(/Not a Solana token mint/);
        getMintParsed.mockResolvedValue(null);
        await expect(solanaTx.sendSPL(PY)).rejects.toThrow(/not found/);
        expect(sendRawTransaction).not.toHaveBeenCalled();
    });

    it('token2022AccountSize matches the relay: PYUSD 187, bare 170; unknown and inherited names refused', () => {
        expect(token2022AccountSize(PYUSD_EXTENSIONS.map((e) => e.extension))).toBe(187);
        expect(token2022AccountSize([])).toBe(170);
        expect(() => token2022AccountSize(['someFutureExtension'])).toThrow(/Unrecognised/);
        expect(() => token2022AccountSize(['toString'])).toThrow(/Unrecognised/);
    });
});
