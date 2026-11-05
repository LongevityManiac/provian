import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import i18next from 'i18next';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('./AddressHistoryService', () => ({ default: { isFirstTimeSend: async () => true } }));
vi.mock('../relay/DevHostDiscovery', () => ({ resolveRelayBaseUrl: () => 'https://example.invalid' }));
vi.mock('../../data/scam-contracts', () => ({ KNOWN_SCAM_CONTRACTS: new Set(['0xbad']), KNOWN_SCAM_DEPLOYERS: new Set() }));
vi.mock('./TokenVerifier', () => ({
    isVerifiableToken: (symbol: string) => symbol === 'USDC',
    verifyTokenAddress: () => ({ isCanonical: false, expectedAddress: '0xcanonical' }),
}));
import protection from './UserProtectionManager';

const directory = join(import.meta.dirname, '../../i18n/locales');
const resources = Object.fromEntries(readdirSync(directory).filter(name => name.endsWith('.json')).map(name =>
    [name.slice(0, -5), { translation: JSON.parse(readFileSync(join(directory, name), 'utf8')) }]));

describe('Warnings retain their protection while translating display text', () => {
    beforeAll(async () => { await i18next.init({ resources, lng: 'en', fallbackLng: 'en', interpolation: { escapeValue: false } }); });
    afterAll(async () => { await i18next.changeLanguage('en'); });

    it('all locales interpolate assets and amounts without changing blocking or acknowledgment', async () => {
        for (const language of Object.keys(resources)) {
            await i18next.changeLanguage(language);
            const [approval] = await protection.checkForWarnings({ action: 'approve', approvalAmount: 'unlimited', amount: 12.5, assetSymbol: 'ETH' });
            expect(approval).toMatchObject({ id: 'unlimited_approval', severity: 'critical', canProceed: true, requiresConfirmation: true });
            expect(approval.title).toBe(i18next.t('userProtection.unlimited_approval.title'));
            expect(approval.recommendation).toContain('12.5 ETH');
            const sends = await protection.checkForWarnings({ action: 'send', recipient: '0x1234', amount: 950, userBalance: 1000, amountUsd: 550, assetSymbol: 'ETH' });
            expect(sends.map(w => [w.id, w.severity, w.canProceed, w.requiresConfirmation])).toEqual([
                ['first_time_large_send', 'high', true, true],
                ['large_balance_percent', 'high', true, true],
            ]);
            expect(sends[0].message).toContain('$550.00');
            expect(sends[1].title).toContain('95%');
            expect(sends[1].consequences).toContain('50.0000 ETH');
            const small = await protection.checkForWarnings({ action: 'send', recipient: '0x1234', amountUsd: 499, assetSymbol: 'ETH' });
            expect(small[0]).toMatchObject({ id: 'first_time_send', severity: 'medium', canProceed: true, requiresConfirmation: false });
            const network = await protection.checkForWarnings({ action: 'send', recipient: '0x' + 'a'.repeat(40), networkId: 999 });
            const suspicious = await protection.checkForWarnings({ action: 'approve', contract: '0xbad' });
            const fake = await protection.checkForWarnings({ action: 'swap', assetSymbol: 'USDC', contract: '0xfake', networkId: 8453 });
            for (const warning of [...network.filter(w => w.id === 'wrong_network'), ...suspicious, ...fake]) {
                expect(warning.canProceed).toBe(false);
                expect(warning.requiresConfirmation).toBe(false);
                expect(warning.severity).toBe('critical');
                expect(protection.hasBlockingWarnings([warning])).toBe(true);
            }
            expect(fake[0].consequences).toContain('0xcanonical');
            const [sign] = await protection.checkForWarnings({ action: 'sign' });
            expect(sign).toMatchObject({ id: 'blind_sign', severity: 'high', canProceed: true, requiresConfirmation: true });
            for (const warning of [approval, ...sends, ...small, ...network, ...suspicious, ...fake, sign]) {
                for (const field of ['title', 'message', 'plainEnglish', 'consequences', 'recommendation'] as const) {
                    expect(warning[field]).not.toMatch(/{{|userProtection\./);
                }
            }
        }
    });
});
