/**
 * The app's PE list from the PEs the phone holds: own PEs with their receipt's disposition,
 * mailbox PEs (v2 and the handed-back v1 history) counted too. MONEY-SAFETY : no row ever
 * carries a PVT amount — record points are not PVT, and the phone computes no settlement projection.
 */
import { describe, it, expect } from 'vitest';
import { peHashOf, PE_V2_SCHEMA, type PeV2 } from '../meter-wire';
import { PhoneBatcher } from '../phoneBatcher';
import { formatAtomic1, localHistoryEntries } from '../peHistoryView';
import { FakeRelay, openStore, recordPes } from './meterTestkit';

describe('localHistoryEntries', () => {
    it('own PEs carry their receipt disposition (unsent ones none); received v2 + v1 are listed; no row has a PVT amount', async () => {
        const { store } = await openStore();
        await recordPes(store, 2, { intent_text: 'Asked Claude about tamales' });
        await new PhoneBatcher({ store, transport: new FakeRelay(), resendDelayMs: 0 }).flush();
        await recordPes(store, 1);
        const pe: PeV2 = { schema: PE_V2_SCHEMA, pe_id: 'agent_pe', device_id: 'device_agent', prev_hash: 'genesis', timestamp: 3, action_type: 'coding_session' };
        await store.recordReceived({ mailbox_id: 'm1', pe_id: 'agent_pe', format: 'pe_v2', pe, pe_hash: peHashOf(pe), from_device: 'device_agent', from_actor: 'a', batch_hash: '', created_at_ms: 1, received_at_ms: 2 });
        await store.recordReceived({ mailbox_id: 'm2', pe_id: 'pe_old', format: 'v1_envelope', pe: { id: 'pe_old', action_type: 'wallet_created', timestamp: 2, mint_status: 'record_only' }, pe_hash: 'e'.repeat(64), from_device: '', from_actor: '', batch_hash: '', created_at_ms: 1, received_at_ms: 2 });

        const rows = await localHistoryEntries(store);
        expect(rows).toHaveLength(5);
        const own = rows.filter((r) => r.description?.includes('tamales'));
        expect(own.map((r) => r.mintStatus)).toEqual(['eligible', 'eligible']);
        expect(own[0].recordPoints).toBe('1.0');
        const unsent = rows.find((r) => !r.description?.includes('tamales') && r.actionType === 'ai_conversation');
        expect(unsent?.mintStatus).toBeNull();
        expect(rows.find((r) => r.peId === 'pe_old')?.mintStatus).toBe('record_only');
        expect(rows.find((r) => r.peId === 'agent_pe')?.actionType).toBe('coding_session');
        // RED guard: a PVT amount on any row would be a record-points sum shown as earnings.
        for (const r of rows) {
            expect(r.currentSettlementProjectionPVT).toBeNull();
            expect(r.currentSettlementProjectionAtomic).toBeNull();
        }
    });

    it('formatAtomic1 formats 18-decimal atomic points', () => {
        expect(formatAtomic1('1500000000000000000')).toBe('1.5');
        expect(formatAtomic1('not a number')).toBe('0.0');
    });
});
