/**
 * What an answer to `POST /v1/archive/mobile/pay` means for the person's money (PE Archive
 * human-path run, 2026-10-07; reviewer defect 1).
 *
 * The sheet tells the person "Nothing was charged" for every `refused`. So `refused` may only ever be
 * an answer the RELAY gave and named before (or instead of) taking money. A bare 503 from Cloud Run
 * or a proxy timing out mid-charge proves nothing about the charge and must be `unreachable`, which
 * the sheet follows up by request id instead of calling uncharged.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../NotificationService', () => ({ default: {} }));

import RelayAPIService, { archiveBuyOutcomeOf } from '../RelayAPIService';

type AuthFetch = (endpoint: string, options?: RequestInit, retryOnAuth?: boolean) => Promise<Response>;
const svc = RelayAPIService as unknown as { makeAuthenticatedRequest: AuthFetch };

const RECORDED = { request_id: 'ap_' + 'a'.repeat(40), state: 'charge_failed', credited: false, last_error: 'payment_insufficient_funds' };

describe('archiveBuyOutcomeOf', () => {
    it('200 / 202 are paid', () => {
        expect(archiveBuyOutcomeOf(200, { request_id: RECORDED.request_id, state: 'charged', credited: true }).kind).toBe('paid');
        expect(archiveBuyOutcomeOf(202, { request_id: RECORDED.request_id, state: 'charge_unconfirmed', credited: false }).kind).toBe('paid');
    });

    it('a recorded payment whose charge failed is refused with its reason', () => {
        const out = archiveBuyOutcomeOf(402, RECORDED);
        expect(out).toMatchObject({ kind: 'refused', status: 402, code: 'payment_insufficient_funds' });
    });

    it('a 4xx the relay named is refused (count > 0)', () => {
        const cases: [number, string][] = [
            [402, 'payment_insufficient_funds'], [409, 'archive_space_available'], [409, 'payment_already_used'],
            [401, 'Authentication required'], [409, 'archive_owner_unresolved'],
        ];
        expect(cases.length).toBeGreaterThan(0);
        for (const [status, error] of cases) expect(archiveBuyOutcomeOf(status, { error })).toEqual({ kind: 'refused', status, code: error });
    });

    it('the three 503s the relay sends before recording anything are refused', () => {
        for (const error of ['waits_for_gas', 'archive_payments_not_configured', 'archive_not_configured']) {
            expect(archiveBuyOutcomeOf(503, { error })).toEqual({ kind: 'refused', status: 503, code: error });
        }
    });

    it('RED: a bare 503 (Cloud Run / proxy, empty body) is unreachable, never "nothing was charged"', () => {
        expect(archiveBuyOutcomeOf(503, {})).toEqual({ kind: 'unreachable', error: 'archive_http_503' });
        expect(archiveBuyOutcomeOf(503, { error: 'Service Unavailable' })).toEqual({ kind: 'unreachable', error: 'archive_http_503:Service Unavailable' });
    });

    it('RED: 500 / 502 / 504 and a 4xx with no relay code are unreachable', () => {
        for (const status of [500, 502, 504]) expect(archiveBuyOutcomeOf(status, { error: 'archive_failed' }).kind).toBe('unreachable');
        expect(archiveBuyOutcomeOf(429, {}).kind).toBe('unreachable');
        expect(archiveBuyOutcomeOf(413, { error: '' }).kind).toBe('unreachable');
    });
});

describe('buyArchiveGb end to end over the response', () => {
    const respond = (status: number, body: unknown): Response => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => { if (body === null) throw new Error('not json'); return body; },
    }) as unknown as Response;

    it('an HTML 503 from the platform is unreachable; RED: the relay\'s waits_for_gas 503 is refused', async () => {
        svc.makeAuthenticatedRequest = vi.fn(async () => respond(503, null));
        expect((await RelayAPIService.buyArchiveGb('p')).kind).toBe('unreachable');
        svc.makeAuthenticatedRequest = vi.fn(async () => respond(503, { error: 'waits_for_gas' }));
        expect(await RelayAPIService.buyArchiveGb('p')).toEqual({ kind: 'refused', status: 503, code: 'waits_for_gas' });
    });

    it('a throw before sending is session_unavailable; any other throw is unreachable', async () => {
        svc.makeAuthenticatedRequest = vi.fn(async () => { throw new Error('Not authenticated'); });
        expect(await RelayAPIService.buyArchiveGb('p')).toEqual({ kind: 'refused', status: 0, code: 'session_unavailable' });
        svc.makeAuthenticatedRequest = vi.fn(async () => { throw new Error('Network request failed'); });
        expect(await RelayAPIService.buyArchiveGb('p')).toEqual({ kind: 'unreachable', error: 'Network request failed' });
    });
});
