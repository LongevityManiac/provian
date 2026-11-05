/**
 * FeeConfig — the app-side swap-fee record agrees with the relay and with the
 * Solana PDA derivation (the relay pins the fee account; this recomputes it).
 */
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
    PROVIAN_SWAP_FEE_BPS,
    PROVIAN_SWAP_FEE_PERCENT,
    PROVIAN_SOLANA_TREASURY,
    PROVIAN_SOLANA_USDC_FEE_ACCOUNT,
} from './FeeConfig';

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

describe('FeeConfig', () => {
    it('is 25 bps', () => {
        expect(PROVIAN_SWAP_FEE_BPS).toBe(25);
        expect(PROVIAN_SWAP_FEE_PERCENT).toBe(0.0025);
    });

    it('the Jupiter fee account is the Solana treasury\'s USDC associated token account', () => {
        const [ata] = PublicKey.findProgramAddressSync(
            [new PublicKey(PROVIAN_SOLANA_TREASURY).toBuffer(), TOKEN_PROGRAM.toBuffer(), USDC_MINT.toBuffer()],
            ATA_PROGRAM,
        );
        expect(ata.toBase58()).toBe(PROVIAN_SOLANA_USDC_FEE_ACCOUNT);
    });

    it('RED: a different owner derives a different account', () => {
        const [other] = PublicKey.findProgramAddressSync(
            [new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM').toBuffer(), TOKEN_PROGRAM.toBuffer(), USDC_MINT.toBuffer()],
            ATA_PROGRAM,
        );
        expect(other.toBase58()).not.toBe(PROVIAN_SOLANA_USDC_FEE_ACCOUNT);
    });
});
