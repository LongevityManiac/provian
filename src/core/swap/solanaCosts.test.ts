/**
 * solanaCosts — the relay's `solana_costs` answer, parsed fail-closed for the swap screen.
 * FRESH is shaped like the relay's answer for a wallet holding no SOL that swaps 0.01 SOL into
 * a token it has no account for (receiving account + a temporary wrapped-SOL account).
 */
import { describe, it, expect } from 'vitest';
import { parseSolanaCosts, solanaCostRows, lamportsToSol } from './solanaCosts';

const FRESH = {
    network_fee_lamports: '5000', receiving_account_lamports: '1488440', treasury_fee_account_lamports: '0',
    temporary_account_lamports: '1488440', other_accounts_lamports: '0', sol_swapped_lamports: '10000000',
    spend_lamports: '11493440', required_lamports: '12981880', balance_lamports: '0',
    rent_exempt_minimum_lamports: '650240', sufficient: false, shortfall_lamports: '12981880', measured: true,
};

describe('parseSolanaCosts', () => {
    it('reads a consistent answer', () => {
        const c = parseSolanaCosts(FRESH)!;
        expect(c.sufficient).toBe(false);
        expect(c.shortfallLamports).toBe('12981880');
        expect(c.lamports.receiving).toBe('1488440');
        expect(c.measured).toBe(true);
    });

    it('RED: missing, malformed, or non-adding figures are refused', () => {
        expect(parseSolanaCosts(undefined)).toBeNull();
        expect(parseSolanaCosts({ ...FRESH, network_fee_lamports: 5000 })).toBeNull();
        expect(parseSolanaCosts({ ...FRESH, other_accounts_lamports: '-1' })).toBeNull();
        expect(parseSolanaCosts({ ...FRESH, spend_lamports: '11493441' })).toBeNull();
        expect(parseSolanaCosts({ ...FRESH, required_lamports: '11493440' })).toBeNull(); // < spend + temporary
        expect(parseSolanaCosts({ ...FRESH, shortfall_lamports: '1' })).toBeNull();
        expect(parseSolanaCosts({ ...FRESH, sufficient: 'no' })).toBeNull();
        // Sufficient must carry a zero shortfall.
        expect(parseSolanaCosts({ ...FRESH, sufficient: true })).toBeNull();
        expect(parseSolanaCosts({ ...FRESH, balance_lamports: '20000000', sufficient: true, shortfall_lamports: '0' })).not.toBeNull();
    });

    it('RED: a `sufficient` that contradicts the send-screen rule is refused (it gates sending)', () => {
        const claim = (balance: bigint) => ({ ...FRESH, balance_lamports: String(balance), sufficient: true, shortfall_lamports: '0' });
        const spend = 11_493_440n; const temporary = 1_488_440n; const rentMin = 650_240n;
        expect(parseSolanaCosts(claim(0n))).toBeNull(); // an empty wallet
        expect(parseSolanaCosts(claim(spend + temporary - 1n))).toBeNull(); // cannot hold the temporary account
        expect(parseSolanaCosts(claim(spend + rentMin - 1n))).toBeNull(); // would end below the rent minimum
        expect(parseSolanaCosts(claim(spend + temporary))).not.toBeNull();
        expect(parseSolanaCosts({ ...FRESH, rent_exempt_minimum_lamports: undefined })).toBeNull();
    });
});

describe('solanaCostRows', () => {
    it('shows the network fee always and each deposit only when non-zero, never the SOL swapped', () => {
        const rows = solanaCostRows(parseSolanaCosts(FRESH)!);
        expect(rows.map((r) => r.kind)).toEqual(['network', 'receiving', 'temporary']);
        const treasury = solanaCostRows(parseSolanaCosts({
            ...FRESH, treasury_fee_account_lamports: '1600200', spend_lamports: '13093640',
            required_lamports: '14582080', shortfall_lamports: '14582080',
        })!);
        expect(treasury.find((r) => r.kind === 'treasury')?.lamports).toBe('1600200');
    });
});

describe('lamportsToSol', () => {
    it('is exact', () => {
        expect(lamportsToSol('1488440')).toBe('0.00148844');
        expect(lamportsToSol('1000000000')).toBe('1');
        expect(lamportsToSol('0')).toBe('0');
        expect(lamportsToSol('12345678901')).toBe('12.345678901');
    });
});
