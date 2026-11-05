/**
 * (app) — a confirmed send / swap envelope carries its transaction hash to
 * the relay (inside its PE v2's pricing inputs), which queues a Base hash for its chain-record lane. Every other
 * envelope is byte-identical (no key, no wire field). Each guard ships its RED
 * control.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ProvenanceEnvelope } from './types';
import { hashEnvelopeCanonical } from './peHash';

const TX = `0x${'Ab'.repeat(32)}`;

function makePE(over: Partial<ProvenanceEnvelope>): ProvenanceEnvelope {
    return {
        envelope_id: 'e1', prev_envelope_hash: 'GENESIS', timestamp: 1,
        action_type: 'send', intent_text: 'send to a friend', chain_id: 8453,
        device_attestation_id: 'dev_abc',
        ...over,
    } as ProvenanceEnvelope;
}

describe('txHashFields', () => {
    it('GREEN: a well-formed hash forwards with its numeric chain id', async () => {
        const { txHashFields } = await import('./txHash');
        expect(txHashFields(makePE({ tx_hash: TX.toLowerCase() }))).toEqual({ tx_hash: TX.toLowerCase(), chain_id: 8453 });
    });
    it('RED: no hash, a short hash, or a Solana signature forwards nothing', async () => {
        const { txHashFields } = await import('./txHash');
        expect(txHashFields(makePE({}))).toEqual({});
        expect(txHashFields(makePE({ tx_hash: '0x1234' }))).toEqual({});
        expect(txHashFields(makePE({ tx_hash: '5h8xQ1rUYbD3o2fZTg9w', chain_id: 'Solana' }))).toEqual({});
    });
});

describe('the envelope hash is forward-only', () => {
    it('an envelope without tx_hash hashes identically to tx_hash: undefined; with one it differs', async () => {
        const without = await hashEnvelopeCanonical(makePE({}));
        expect(await hashEnvelopeCanonical(makePE({ tx_hash: undefined }))).toBe(without);
        expect(await hashEnvelopeCanonical(makePE({ tx_hash: TX.toLowerCase() }))).not.toBe(without);
    });
});

describe('createEnvelope + the PE v2 carry the hash end to end', () => {
    it('GREEN: createEnvelope({ txHash }) sets a lowercased tx_hash; the PE v2 carries it with chain_id; RED: none without', async () => {
        vi.doMock('../security/KeyManager', () => ({
            default: {
                getAddress: vi.fn().mockResolvedValue('0xabc0000000000000000000000000000000000001'),
                performDeviceAttestation: vi.fn().mockResolvedValue({ deviceId: 'dev-1', isHardwareBacked: true, securityLevel: 'tee' }),
                signPayload: vi.fn().mockResolvedValue('sig'),
            },
        }));
        vi.doMock('../footprint/FootprintService', () => ({ ingestPE: vi.fn(), estimateFromPE: vi.fn().mockReturnValue(0) }));
        vi.resetModules();
        const mgr = (await import('./ProvenanceEnvelopeManager')).default as unknown as {
            createEnvelope(p: Record<string, unknown>): Promise<ProvenanceEnvelope>;
        };
        const { phonePricingOf } = await import('../meter/phonePeBuilder');
        const base = {
            actionType: 'send', intentText: 'Send 1 USDT on Base to a friend', assetSymbol: 'USDT', amount: '1',
            chainId: 8453, riskScore: 0, riskCategory: 'low', policyDecision: 'allow',
        };
        const withHash = await mgr.createEnvelope({ ...base, txHash: TX });
        const withoutHash = await mgr.createEnvelope(base);
        const malformed = await mgr.createEnvelope({ ...base, txHash: '0xnothex' });
        expect(withHash.tx_hash).toBe(TX.toLowerCase());
        expect('tx_hash' in withoutHash).toBe(false);
        expect('tx_hash' in malformed).toBe(false);

        const pricedWith = phonePricingOf(withHash, 'd'.repeat(64));
        const pricedWithout = phonePricingOf(withoutHash, 'd'.repeat(64));
        expect(pricedWith).toMatchObject({ tx_hash: TX.toLowerCase(), chain_id: 8453 });
        expect('tx_hash' in pricedWithout).toBe(false);
        expect('chain_id' in pricedWithout).toBe(false);
    });
});
