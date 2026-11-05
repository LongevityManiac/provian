/**
 * The served blocklist never names a contract the relay's own commerce lane recognises as a
 * swap target or asset (2026-10-17 bug check: production served the 0x AllowanceHolder and the
 * Uniswap Universal Router as "fake DEX routers").
 */
import { STATIC_SCAM_FALLBACK } from './scam-list';
import { BASE_SWAP_TARGETS, BASE_NON_USDC_ASSETS, WETH_BASE, ZEROX_ALLOWANCE_HOLDER_BASE } from '../core/pvt/wallet-exchange';

describe('scam-list static fallback', () => {
  it('names none of the relay\'s own recognised swap targets or assets', () => {
    const listed = new Set([...STATIC_SCAM_FALLBACK.contracts, ...STATIC_SCAM_FALLBACK.deployers].map((a) => a.toLowerCase()));
    const own = [
      ...BASE_SWAP_TARGETS,
      ...Object.values(BASE_NON_USDC_ASSETS),
      WETH_BASE,
      ZEROX_ALLOWANCE_HOLDER_BASE,
      '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad', // Uniswap Universal Router (RED)
      '0x881d40237659c251811cec9c364ef91dc08d300c', // MetaMask Swap Router (RED)
    ].map((a) => a.toLowerCase());
    expect(own.length).toBeGreaterThan(4);
    for (const address of own) expect(listed.has(address)).toBe(false);
    expect(listed.has('0x0000db5c8b030ae20308ac975898e09f02bafc36')).toBe(true); // Inferno stays
  });
});

// Reviewer 2026-10-17, round 2: the fallback had listed OpenSea Seaport 1.2 as a drainer kit.
describe('static scam fallback — genuine marketplaces are never listed', () => {
  it('does not name OpenSea Seaport 1.2 or 1.5', () => {
    const listed = new Set(STATIC_SCAM_FALLBACK.contracts.map((c) => c.toLowerCase()));
    expect(listed.has('0x00000000000006c7676171937c444f6bde3d6282')).toBe(false);
    expect(listed.has('0x00000000000000adc04c56bf30ac9d3c0aaf14dc')).toBe(false);
  });
});
