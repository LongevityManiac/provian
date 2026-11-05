import { describe, it, expect, vi } from 'vitest';

const cluster = vi.hoisted(() => ({ isTestnet: false }));
vi.mock('./config', () => ({ getActiveSolanaCluster: () => cluster }));

import { getListedSolanaTokens, swapDestinationAssets, SPL_TOKEN_2022_PROGRAM_ID } from './tokens';
import type { Asset } from '../../../store/walletStore';

const SOL: Asset = { symbol: 'SOL', name: 'Solana', balance: '1', price: 150, chain: 'Solana', decimals: 9 };
const HELD_BONK: Asset = {
    symbol: 'BONK', name: 'Bonk', balance: '100000', price: 0, chain: 'Solana',
    tokenAddress: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', decimals: 5,
};

describe('listed Solana tokens', () => {
    it('offers SOL→BONK and BONK→JUP destinations the relay now routes', () => {
        const to = swapDestinationAssets([SOL]);
        expect(to.map((a) => a.symbol)).toEqual(['SOL', 'BONK', 'JUP', 'WIF', 'PYUSD']);
        expect(to.find((a) => a.symbol === 'BONK')).toMatchObject({ balance: '0', chain: 'Solana', decimals: 5 });
    });

    it('a held token is not offered twice', () => {
        const to = swapDestinationAssets([SOL, HELD_BONK]);
        expect(to.filter((a) => a.symbol === 'BONK')).toEqual([HELD_BONK]);
    });

    it('PYUSD is listed as Token-2022', () => {
        expect(getListedSolanaTokens().find((t) => t.symbol === 'PYUSD')?.tokenProgram).toBe(SPL_TOKEN_2022_PROGRAM_ID);
    });

    it('none on devnet (the mints are mainnet-only)', () => {
        cluster.isTestnet = true;
        expect(getListedSolanaTokens()).toEqual([]);
        expect(swapDestinationAssets([SOL])).toEqual([SOL]);
        cluster.isTestnet = false;
    });
});
