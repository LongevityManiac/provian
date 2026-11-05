import { describe, it, expect } from 'vitest';
import RiskEngine from './RiskEngine';
import AddressHistoryService from '../protection/AddressHistoryService';

// An unmapped chainId short-circuits the eth_getCode contract check inside
// checkRecipientRisk (getChainById returns undefined), keeping these tests
// hermetic - no real network call, regardless of which branch runs.
const UNMAPPED_CHAIN_ID = 999999;

function baseTx(to: string) {
    return {
        from: '0x0000000000000000000000000000000000dead',
        to,
        data: '0x',
        value: '1',
        chainId: UNMAPPED_CHAIN_ID,
        assetSymbol: 'ETH',
    };
}

// Wiring for D-address-poisoning-audit: a recipient matching the known
// scam/address-poisoning blocklist, or a lookalike of an address this wallet
// already trusts, must hard-block a send - "Unknown = Block, Not Warn", and
// a KNOWN-bad or KNOWN-confusable address is stronger than merely unknown.
describe('RiskEngine recipient checks (address-poisoning)', () => {
    it('hard-blocks a recipient on the known scam/address-poisoning blocklist', async () => {
        // src/data/scam-contracts.ts KNOWN_SCAM_CONTRACTS - "Address poisoning deployer"
        const scamAddress = '0x00000000004c4bc1c6db5f1732a2e67b0ca8d00e';

        const result = await RiskEngine.calculateRiskScore({ tx: baseTx(scamAddress) });

        expect(result.overallRisk).toBe('critical');
        expect(result.recommendedAction).toBe('block');
        expect(result.signals.some(s => s.source === 'reputation' && s.riskLevel === 'critical')).toBe(true);
    });

    it('hard-blocks a lookalike of a previously-used address (shared prefix + suffix, different middle)', async () => {
        const known = `0x7777${'3'.repeat(32)}dddd`;
        const lookalike = `0x7777${'4'.repeat(32)}dddd`;
        await AddressHistoryService.saveContact(known, 'Trusted Exchange');

        const result = await RiskEngine.calculateRiskScore({ tx: baseTx(lookalike) });

        expect(result.overallRisk).toBe('critical');
        expect(result.recommendedAction).toBe('block');
        expect(result.signals.some(s => s.source === 'reputation' && /Trusted Exchange/.test(s.details))).toBe(true);
    });

    // Negative control: a brand-new address with no scam-list hit and no
    // resemblance to anything known must NOT be hard-blocked - only the
    // ordinary low-severity "first-time send" signal. Guards against a
    // vacuous implementation that blocks every unrecognized recipient.
    it('does not block an ordinary new, unrelated recipient', async () => {
        const unrelated = `0x2222${'5'.repeat(32)}9999`;

        const result = await RiskEngine.calculateRiskScore({ tx: baseTx(unrelated) });

        expect(result.overallRisk).not.toBe('critical');
        expect(result.recommendedAction).not.toBe('block');
    });
});
