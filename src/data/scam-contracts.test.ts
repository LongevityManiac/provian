import { describe, it, expect } from 'vitest';
import { KNOWN_SCAM_CONTRACTS, KNOWN_SCAM_DEPLOYERS } from './scam-contracts';
import { TOKEN_ADDRESSES, PVT9_TOKEN } from '../core/chains/evm/config';
import { ZEROX_ALLOWANCE_HOLDER, ZEROX_DEPLOYER, LIFI_DIAMOND } from '../core/swap/evmSwapGuard';

/**
 * 2026-10-17 bug check: the on-device blocklist carried nineteen genuine contracts — the 0x
 * AllowanceHolder this wallet's own swaps approve, Permit2, the Uniswap / 1inch / MetaMask routers,
 * the ARB / SHIB / MKR / MATIC / CAKE tokens — each labelled as a "fake". Bound to the single
 * sources the wallet reads for its own targets, so the two can never disagree again.
 */
const GENUINE_MAINSTREAM: Record<string, string> = {
    '0x0000000000001ff3684f28c67538d4d072c22734': '0x AllowanceHolder',
    '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': 'Uniswap Universal Router',
    '0x1111111254eeb25477b68fb85ed929f73a960582': '1inch AggregationRouterV5',
    '0x881d40237659c251811cec9c364ef91dc08d300c': 'MetaMask Swap Router',
    '0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2': 'MKR',
    '0x7d1afa7b718fb893db30a3abc0cfc608aacfebb0': 'MATIC',
    '0x10ed43c718714eb63d5aa57b78b54704e256024e': 'PancakeSwap Router v2',
    '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d': 'BAYC',
    '0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce': 'SHIB',
    '0x000000000022d473030f116ddee9f6b43ac78ba3': 'Permit2',
    '0xc36442b4a4522e871399cd717abdd847ab11fe88': 'Uniswap V3 positions',
    '0x912ce59144191c1204e64559fe8253a0e49e6548': 'ARB',
    '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82': 'CAKE',
    '0x7a250d5630b4cf539739df2c5dacb4c659f2488d': 'Uniswap V2 Router02',
    '0x4e5b2e1dc63f6b91cb6cd759936495434c7e972f': 'StarkNet provisions',
    '0x6c6bc977e13df9b0de53b251522280bb72383700': 'Uniswap V3 DAI/USDC pool',
    '0x0000000000000000000000000000000000000064': 'ArbSys precompile',
    '0x0000000000000000000000000000000000000001': 'ecrecover precompile',
    '0xa1e4380a3b1f749673e270229993ee55f35663b4': 'first Ethereum transaction recipient',
};

function walletOwnTargets(): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const [chainId, byToken] of Object.entries(TOKEN_ADDRESSES as Record<string, Record<string, string>>)) {
        for (const [symbol, address] of Object.entries(byToken)) out.push([address.toLowerCase(), `${symbol} on chain ${chainId}`]);
    }
    out.push([PVT9_TOKEN.address.toLowerCase(), 'PVT9']);
    out.push([ZEROX_ALLOWANCE_HOLDER.toLowerCase(), '0x AllowanceHolder (evmSwapGuard)']);
    out.push([ZEROX_DEPLOYER.toLowerCase(), '0x deployer (evmSwapGuard)']);
    out.push([LIFI_DIAMOND.toLowerCase(), 'LI.FI diamond (evmSwapGuard)']);
    return out;
}

describe('scam-contracts never names what the wallet itself transacts with', () => {
    it('binds to the wallet\'s own pinned targets', () => {
        const targets = walletOwnTargets();
        expect(targets.length).toBeGreaterThan(5); // never a vacuous pass
        for (const [address, name] of targets) {
            expect(KNOWN_SCAM_CONTRACTS.has(address), name).toBe(false);
            expect(KNOWN_SCAM_DEPLOYERS.has(address), name).toBe(false);
        }
    });

    it('RED: the genuine mainstream contracts that were listed as fakes stay out', () => {
        for (const [address, name] of Object.entries(GENUINE_MAINSTREAM)) {
            expect(KNOWN_SCAM_CONTRACTS.has(address), name).toBe(false);
        }
    });

    it('still blocks the drainer kits (non-vacuity)', () => {
        expect(KNOWN_SCAM_CONTRACTS.has('0x0000db5c8b030ae20308ac975898e09f02bafc36')).toBe(true); // Inferno
        expect(KNOWN_SCAM_CONTRACTS.has('0x000000000000aaeb6d7670e522a718067cc6c302')).toBe(true); // Pink
        expect(KNOWN_SCAM_CONTRACTS.size).toBeGreaterThan(40);
    });
});

// Reviewer 2026-10-17 (RED on the first cut): four more GENUINE contracts had stayed listed as
// "fakes" — none on a chain this wallet transacts on, but a blocklist that names a real token or
// bridge is wrong wherever it is read. Identified by their well-known addresses.
const GENUINE_NEVER_LISTED: ReadonlyArray<[string, string]> = [
    ['0x04fa0d235c4abf4bcf4787af4cf447de572ef828', 'UMA voting token (Ethereum)'],
    ['0x1a2a1c938ce3ec39b6d47113c7955baa9dd454f2', 'Ronin bridge (Ethereum)'],
    ['0xdab529f40e671a1d4bf91361c21bf9f0c9712ab7', 'BUSD (PoS) on Polygon'],
    ['0x2c89bbc92bd86f8075d1decc58c7f4e0107f286b', 'AVAX (PoS) on Polygon'],
    // Round 2: two OpenSea Seaport deployments had been listed as drainers.
    ['0x00000000000000adc04c56bf30ac9d3c0aaf14dc', 'OpenSea Seaport 1.5'],
    ['0x00000000000006c7676171937c444f6bde3d6282', 'OpenSea Seaport 1.2'],
];
describe('scam list — genuine contracts the reviewer found still listed (2026-10-17)', () => {
    it.each(GENUINE_NEVER_LISTED)('never names %s (%s)', (address) => {
        expect(KNOWN_SCAM_CONTRACTS.has(address)).toBe(false);
        expect(KNOWN_SCAM_DEPLOYERS.has(address)).toBe(false);
    });
});
