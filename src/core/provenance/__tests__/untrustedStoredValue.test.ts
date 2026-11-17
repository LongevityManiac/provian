/**
 * A stored value without a valid integrity tag is untrusted.
 *
 * The PE history, the tiered store and the chain head are read through the integrity-checked
 * storage. Anyone who can write the app's storage file can replace one of them with plain JSON.
 * Such a value must read as absent — never returned as the person's record, and never signed with
 * the install's key (which would turn planted data into a trusted value on the next read).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mem } = vi.hoisted(() => ({ mem: new Map<string, string>() }));

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => (mem.has(k) ? mem.get(k)! : null)),
        setItem: vi.fn(async (k: string, v: string) => { mem.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { mem.delete(k); }),
        clear: vi.fn(async () => { mem.clear(); }),
    },
}));
vi.mock('../../security/KeyManager', () => ({ default: {} }));
vi.mock('../../footprint/FootprintService', () => ({ ingestPE: vi.fn(), estimateFromPE: vi.fn() }));
vi.mock('../../../services/RelayAPIService', () => ({ default: {} }));
vi.mock('../PELifecycleManager', () => ({ default: { addPEToHotTier: vi.fn(), initialize: vi.fn(), setPEHidden: vi.fn() } }));

import ProvenanceEnvelopeManager from '../ProvenanceEnvelopeManager';
import { getItemHmac, setItemHmac } from '../../security/hmacAsyncStorage';

const PLANTED = [{ envelope_id: 'planted-a', action_type: 'send', amount: '1000000' }];

beforeEach(() => { mem.clear(); });

describe('plain JSON planted at an integrity-checked key', () => {
    it('is not returned as PE history, and is not signed', async () => {
        const planted = JSON.stringify(PLANTED);
        mem.set('provian_pe_history', planted);

        expect(await ProvenanceEnvelopeManager.getHistoryRaw()).toEqual([]);
        // Not adopted: what is stored is still the untagged text, so the next read rejects it too.
        expect(mem.get('provian_pe_history')).toBe(planted);
        expect(await getItemHmac('provian_pe_history')).toBeNull();
        expect(await ProvenanceEnvelopeManager.getHistoryRaw()).toEqual([]);
    });

    it('is not returned from the tiered store either', async () => {
        mem.set('provian_pe_tiered', JSON.stringify({ hotPEs: PLANTED }));
        expect(await ProvenanceEnvelopeManager.getHistoryRaw()).toEqual([]);
        expect(JSON.parse(mem.get('provian_pe_tiered')!)).toEqual({ hotPEs: PLANTED });
    });

    it('control: the same history written through the integrity-checked storage IS returned', async () => {
        await setItemHmac('provian_pe_history', PLANTED);
        expect((await ProvenanceEnvelopeManager.getHistoryRaw()).map((pe) => pe.envelope_id)).toEqual(['planted-a']);
    });
});
