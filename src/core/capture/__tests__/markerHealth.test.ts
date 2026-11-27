import { describe, it, expect } from 'vitest';
import { MarkerHealthReporter, markerHealthBody, type MarkerHealthBody, type MarkerHealthVerdict } from '../markerHealth';

function memoryStorage() {
    const m = new Map<string, string>();
    return { getItem: async (k: string) => m.get(k) ?? null, setItem: async (k: string, v: string) => { m.set(k, v); } };
}
const verdict = (o: Partial<MarkerHealthVerdict> = {}): MarkerHealthVerdict => ({
    t: 'marker_health', provider: 'chatgpt', matched: false, candidate: -1, counts: [0, 0, 0], account: 'signed_in', ...o,
});

describe('MarkerHealthReporter', () => {
    it('sends provider, verdict and counts only', async () => {
        const sent: MarkerHealthBody[] = [];
        const r = new MarkerHealthReporter({ send: async b => { sent.push(b); return true; }, storage: memoryStorage(), now: () => 0 });
        expect(await r.report(verdict())).toBe('sent');
        expect(sent).toEqual([{ schema: 'chat_markers/v1', provider: 'chatgpt', account: 'signed_in', matched: false, candidate: -1, counts: [0, 0, 0] }]);
        expect(Object.keys(markerHealthBody(verdict())).sort()).toEqual(['account', 'candidate', 'counts', 'matched', 'provider', 'schema']);
    });

    it('sends the same verdict at most once an hour, but each different verdict', async () => {
        let now = 0;
        const sent: MarkerHealthBody[] = [];
        const r = new MarkerHealthReporter({ send: async b => { sent.push(b); return true; }, storage: memoryStorage(), now: () => now });
        await r.report(verdict());
        expect(await r.report(verdict())).toBe('deduped');
        expect(await r.report(verdict({ matched: true, candidate: 0 }))).toBe('sent');
        expect(await r.report(verdict({ account: 'signed_out' }))).toBe('sent');
        now = 60 * 60 * 1000;
        expect(await r.report(verdict())).toBe('sent');
        expect(sent).toHaveLength(4);
    });

    it('a failed send is not remembered, so the next verdict tries again', async () => {
        let ok = false;
        const r = new MarkerHealthReporter({ send: async () => ok, storage: memoryStorage(), now: () => 0 });
        expect(await r.report(verdict())).toBe('failed');
        ok = true;
        expect(await r.report(verdict())).toBe('sent');
    });

    it('never throws when sending or storage fails', async () => {
        const r = new MarkerHealthReporter({
            send: async () => { throw new Error('offline'); },
            storage: { getItem: async () => { throw new Error('x'); }, setItem: async () => { throw new Error('y'); } },
        });
        expect(await r.report(verdict())).toBe('failed');
    });
});
