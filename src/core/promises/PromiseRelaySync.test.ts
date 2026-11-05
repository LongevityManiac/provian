import { describe, it, expect, beforeEach, vi } from 'vitest';

// PromiseRelayService no longer writes to Firestore — it delegates to the
// wallet-authenticated relay (RelayAPIService) and PROJECTS the relay's
// human-promise document into the local PromiseSyncDocument shape the reducer
// consumes. This proves (a) each write forwards the right arguments, (b) the
// accept-outcome mapping (published / not_found / offline / error), (c) close-out
// returns the relay's authoritative { ok, mode }, and (d) the doc projection —
// address-keyed maps, lowercased, carrying each party's own terms ciphertext.

const ME = '0xAbCd000000000000000000000000000000000001';
const BOB = '0xBoB0000000000000000000000000000000000002';

type W = { ok: boolean; httpStatus?: number; status?: string; mode?: string; error?: string };

const relay = vi.hoisted(() => ({
  createHumanPromise: vi.fn((): Promise<W> => Promise.resolve({ ok: true, httpStatus: 200, status: 'pending' })),
  acceptHumanPromise: vi.fn((): Promise<W> => Promise.resolve({ ok: true, httpStatus: 200, status: 'accepted' })),
  counterHumanPromise: vi.fn((): Promise<W> => Promise.resolve({ ok: true, httpStatus: 200, status: 'countered' })),
  rejectHumanPromise: vi.fn((): Promise<W> => Promise.resolve({ ok: true, httpStatus: 200 })),
  closeOutHumanPromise: vi.fn((): Promise<W> => Promise.resolve({ ok: true, httpStatus: 200, mode: 'awaiting_counterparty' })),
  disputeHumanPromise: vi.fn((): Promise<W> => Promise.resolve({ ok: true, httpStatus: 200 })),
  brokenHumanPromise: vi.fn((): Promise<W> => Promise.resolve({ ok: true, httpStatus: 200 })),
  getHumanPromise: vi.fn(async () => null as unknown),
  listMyHumanPromises: vi.fn(async () => null as unknown),
}));

// The detailed read derives from the plain one (2026-10-17): no doc → 404.
Object.assign(relay, {
  getHumanPromiseDetailed: vi.fn(async (...args: unknown[]) => {
    const promise = await (relay.getHumanPromise as unknown as (...a: unknown[]) => Promise<unknown>)(...args);
    return promise ? { ok: true, promise } : { ok: false, httpStatus: 404 };
  }),
});
vi.mock('../../services/RelayAPIService', () => ({ __esModule: true, default: relay }));
vi.mock('../../store/walletStore', () => ({
  useWalletStore: { getState: () => ({ address: ME }) },
}));

import { promiseRelayService } from './PromiseRelayService';

function rawDoc(over: Record<string, unknown> = {}) {
  return {
    promise_id: 'p-read',
    digest: 'd'.repeat(64),
    status: 'accepted',
    creator_address: ME.toLowerCase(),
    acceptor_address: BOB.toLowerCase(),
    parties: {
      [ME.toLowerCase()]: {
        address: ME.toLowerCase(), role: 'creator', signature: 'sigCreate',
        signed_digest: 'd'.repeat(64), signed_at: 1, terms_ciphertext: 'ctA',
      },
      [BOB.toLowerCase()]: {
        address: BOB.toLowerCase(), role: 'acceptor', signature: 'sigAccept',
        signed_digest: 'd'.repeat(64), signed_at: 2, terms_ciphertext: 'ctB',
      },
    },
    closeout: {
      [ME.toLowerCase()]: { address: ME.toLowerCase(), signature: 'closeA', signed_at: 3 },
    },
    created_at: 1,
    updated_at: 2,
    expires_at: 3,
    ...over,
  };
}

describe('PromiseRelayService — identity + delegation', () => {
  beforeEach(() => {
    for (const fn of Object.values(relay)) (fn as ReturnType<typeof vi.fn>).mockClear();
    relay.closeOutHumanPromise.mockResolvedValue({ ok: true, httpStatus: 200, mode: 'awaiting_counterparty' });
    relay.acceptHumanPromise.mockResolvedValue({ ok: true, httpStatus: 200, status: 'accepted' });
  });

  it('getUid returns the caller wallet address, lowercased', () => {
    expect(promiseRelayService.getUid()).toBe(ME.toLowerCase());
    expect(promiseRelayService.isAvailable()).toBe(true);
  });

  it('publishPromiseCreated forwards (promiseId, digest, signature, ciphertext)', async () => {
    const ok = await promiseRelayService.publishPromiseCreated('p1', 'd'.repeat(64), 'sig', 'ct');
    expect(ok).toBe(true);
    expect(relay.createHumanPromise).toHaveBeenCalledWith('p1', 'd'.repeat(64), 'sig', 'ct', expect.toSatisfy((value: unknown) => value === undefined || (typeof value === 'object' && value !== null && 'nativeId' in value)));
  });

  it('publishPromiseCountered forwards to counterHumanPromise', async () => {
    const ok = await promiseRelayService.publishPromiseCountered('p1', 'e'.repeat(64), 'sig', 'ct');
    expect(ok).toBe(true);
    expect(relay.counterHumanPromise).toHaveBeenCalledWith('p1', 'e'.repeat(64), 'sig', 'ct', expect.toSatisfy((value: unknown) => value === undefined || (typeof value === 'object' && value !== null && 'nativeId' in value)));
  });

  it('publishPromiseDisputed / Broken / Rejected forward and return ok', async () => {
    expect(await promiseRelayService.publishPromiseDisputed('p1')).toBe(true);
    expect(await promiseRelayService.publishPromiseBroken('p1')).toBe(true);
    expect(await promiseRelayService.publishPromiseRejected('p1')).toBe(true);
    expect(relay.disputeHumanPromise).toHaveBeenCalledWith('p1', expect.toSatisfy((value: unknown) => value === undefined || (typeof value === 'object' && value !== null && 'nativeId' in value)));
    expect(relay.brokenHumanPromise).toHaveBeenCalledWith('p1', undefined);
    expect(relay.rejectHumanPromise).toHaveBeenCalledWith('p1', undefined);
  });
});

describe('PromiseRelayService — acceptance outcome mapping', () => {
  beforeEach(() => {
    relay.acceptHumanPromise.mockReset();
  });

  it('ok → "published"', async () => {
    relay.acceptHumanPromise.mockResolvedValueOnce({ ok: true, httpStatus: 200, status: 'accepted' });
    expect(await promiseRelayService.tryPublishAcceptance('p', 'd'.repeat(64), 'sig', 'ct')).toBe('published');
  });

  it('404 → "not_found" (creator doc not replicated yet)', async () => {
    relay.acceptHumanPromise.mockResolvedValueOnce({ ok: false, httpStatus: 404, error: 'Promise not found' });
    expect(await promiseRelayService.tryPublishAcceptance('p', 'd'.repeat(64), 'sig', 'ct')).toBe('not_found');
  });

  it('no httpStatus → "offline"', async () => {
    relay.acceptHumanPromise.mockResolvedValueOnce({ ok: false, error: 'network' });
    expect(await promiseRelayService.tryPublishAcceptance('p', 'd'.repeat(64), 'sig', 'ct')).toBe('offline');
  });

  it('other status → "error"', async () => {
    relay.acceptHumanPromise.mockResolvedValueOnce({ ok: false, httpStatus: 400, error: 'bad sig' });
    expect(await promiseRelayService.tryPublishAcceptance('p', 'd'.repeat(64), 'sig', 'ct')).toBe('error');
  });

  it('publishPromiseAccepted is true ONLY when the accept published', async () => {
    relay.acceptHumanPromise.mockResolvedValueOnce({ ok: false, httpStatus: 404 });
    expect(await promiseRelayService.publishPromiseAccepted('p', 'd'.repeat(64), 'sig', 'ct')).toBe(false);
    relay.acceptHumanPromise.mockResolvedValueOnce({ ok: true, httpStatus: 200 });
    expect(await promiseRelayService.publishPromiseAccepted('p', 'd'.repeat(64), 'sig', 'ct')).toBe(true);
  });
});

describe('PromiseRelayService — close-out is relay-authoritative', () => {
  it('forwards (promiseId, signature) and returns the relay { ok, mode }', async () => {
    relay.closeOutHumanPromise.mockResolvedValueOnce({ ok: true, httpStatus: 200, mode: 'fulfilled' });
    const r = await promiseRelayService.publishCloseoutSignature('p', 'closeSig');
    expect(relay.closeOutHumanPromise).toHaveBeenCalledWith('p', 'closeSig', expect.toSatisfy((value: unknown) => value === undefined || (typeof value === 'object' && value !== null && 'nativeId' in value)));
    expect(r).toEqual({ ok: true, mode: 'fulfilled', httpStatus: 200 });
  });

  it('maps awaiting_counterparty', async () => {
    relay.closeOutHumanPromise.mockResolvedValueOnce({ ok: true, httpStatus: 200, mode: 'awaiting_counterparty' });
    expect(await promiseRelayService.publishCloseoutSignature('p', 'sig')).toEqual({ ok: true, mode: 'awaiting_counterparty', httpStatus: 200 });
  });

  it('a failed write returns ok:false with no mode', async () => {
    relay.closeOutHumanPromise.mockResolvedValueOnce({ ok: false, httpStatus: 403, error: 'nope' });
    expect(await promiseRelayService.publishCloseoutSignature('p', 'sig')).toEqual({ ok: false, mode: undefined, httpStatus: 403, error: 'nope' });
  });
});

describe('PromiseRelayService — document projection', () => {
  it('checkPromiseStatus projects the raw relay doc into the local shape', async () => {
    relay.getHumanPromise.mockResolvedValueOnce(rawDoc());
    const snap = await promiseRelayService.checkPromiseStatus('p-read');
    expect(snap).toBeTruthy();
    expect(snap!.promiseId).toBe('p-read');
    expect(snap!.creatorUid).toBe(ME.toLowerCase());
    expect(snap!.acceptorUid).toBe(BOB.toLowerCase());
    expect(snap!.digest).toBe('d'.repeat(64));
    expect(snap!.status).toBe('accepted');
    // signatures are keyed by lowercased address and carry the party's OWN terms.
    expect(snap!.signatures[ME.toLowerCase()]).toMatchObject({ role: 'creator', signature: 'sigCreate', termsCiphertext: 'ctA' });
    expect(snap!.signatures[BOB.toLowerCase()]).toMatchObject({ role: 'acceptor', termsCiphertext: 'ctB' });
    // closeout keyed by address, role derived from creator/acceptor.
    expect(snap!.closeout[ME.toLowerCase()]).toMatchObject({ role: 'creator', signature: 'closeA' });
  });

  it('checkPromiseStatus returns null when the relay has no doc', async () => {
    relay.getHumanPromise.mockResolvedValueOnce(null);
    expect(await promiseRelayService.checkPromiseStatus('missing')).toBeNull();
  });

  it('listMine projects every promise + returns myAddress', async () => {
    relay.listMyHumanPromises.mockResolvedValueOnce({
      promises: [rawDoc({ promise_id: 'p1' }), rawDoc({ promise_id: 'p2', status: 'fulfilled' })],
      myAddress: ME.toLowerCase(),
    });
    const res = await promiseRelayService.listMine();
    expect(res?.myAddress).toBe(ME.toLowerCase());
    expect(res?.promises.map((p) => p.promiseId)).toEqual(['p1', 'p2']);
    expect(res?.promises[1].status).toBe('fulfilled');
  });

  it('listMine returns null when the relay is unreachable', async () => {
    relay.listMyHumanPromises.mockResolvedValueOnce(null);
    expect(await promiseRelayService.listMine()).toBeNull();
  });
});
