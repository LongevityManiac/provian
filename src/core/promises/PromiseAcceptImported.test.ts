import { describe, it, expect, beforeEach, vi } from 'vitest';

// P4-06 — the RECIPIENT side of the share-link "Open to accept" flow. A promise
// imported via the E2E share link / QR lands as an `owed_to_me` 'pending' record
// whose only prior actions (Fulfill/Dispute/Broken) all threw Invalid transition.
// acceptImportedPromise / declineImportedPromise give the recipient a real
// Accept/Decline. The relay (Firestore) is mocked; this isolates the service.

const relay = vi.hoisted(() => ({
  publishPromiseCreated: vi.fn(async () => true),
  publishPromiseAccepted: vi.fn(async () => true),
  tryPublishAcceptance: vi.fn(
    async (): Promise<'published' | 'offline' | 'not_found'> => 'published',
  ),
  publishPromiseRejected: vi.fn(async () => true),
  publishCloseoutSignature: vi.fn(async () => ({ ok: true, mode: 'awaiting_counterparty' as const })),
  publishPromiseDisputed: vi.fn(async () => true),
  checkPromiseStatus: vi.fn(),
  getUid: vi.fn(() => 'uidMe'),
  subscribeToPromise: vi.fn(() => () => undefined),
}));

vi.mock('./PromiseRelayService', () => ({ promiseRelayService: relay }));
vi.mock('./promiseSigning', () => ({
  computePromiseDigest: vi.fn(async () => 'd'.repeat(64)),
  signHumanPromisePhase: vi.fn(async (phase: string) => `sig:${phase}`),
}));
vi.mock('./PromiseTermsVault', () => ({
  encryptTermsToSelf: vi.fn(async () => 'ciphertext'),
  decryptTermsFromSelf: vi.fn(async () => null),
  clearPromiseTermsKey: vi.fn(),
}));
vi.mock('../provenance/ProvenanceEnvelopeManager', () => ({
  default: {
    createEnvelope: vi.fn(async () => ({ envelope_id: 'pe1' })),
    getEnvelopeHashById: vi.fn(async () => null),
  },
}));
vi.mock('../provenance/CorroborationManager', () => ({
  default: { emitCorroboration: vi.fn(async () => undefined) },
}));
vi.mock('../recovery/cloud/CloudBackupV2', () => ({ hasCloudBackup: () => false }));

import PromiseService, { type PromiseQRPayload } from './PromiseService';

const ME = '0xME';
const CREATOR = '0xCREATOR';

/** Import a promise as the recipient (mirrors a scanned QR / opened share link). */
async function importAsRecipient(id = 'p_import_1'): Promise<string> {
  const payload: PromiseQRPayload = {
    version: 2,
    promiseId: id,
    theyGave: 'Tamales',
    theyOwe: '50 pesos',
    who: 'Creator',
    creatorAddress: CREATOR,
    creatorName: 'Creator',
    creatorSignature: 'sig_creator',
    timestamp: Date.now(),
  };
  const p = await PromiseService.importPromiseFromQR(payload, ME);
  expect(p?.status).toBe('pending');
  expect(p?.direction).toBe('owed_to_me');
  expect(p?.creatorAddress).toBe(CREATOR); // the OTHER party — I am the recipient
  return id;
}

describe('PromiseService — accept/decline imported (recipient) promise', () => {
  beforeEach(async () => {
    await PromiseService.deleteAllPromises();
    relay.tryPublishAcceptance.mockReset();
    relay.tryPublishAcceptance.mockResolvedValue('published');
    relay.publishPromiseRejected.mockClear();
  });

  it('accept publishes to the relay → accepted_synced + relay-backed', async () => {
    const id = await importAsRecipient();

    const res = await PromiseService.acceptImportedPromise(id, ME, 'Me');

    expect(res?.mode).toBe('accepted_synced');
    expect(relay.tryPublishAcceptance).toHaveBeenCalledWith(
      id, expect.any(String), expect.any(String), expect.any(String), expect.toSatisfy((value: unknown) => value === undefined || (typeof value === 'object' && value !== null && 'nativeId' in value)),
    );
    const after = await PromiseService.getPromise(id);
    expect(after?.status).toBe('accepted');
    expect(after?.relayBacked).toBe(true);
    expect(after?.counterpartySignature).toBeTruthy();
    expect(after?.events.filter(e => e.type === 'accepted')).toHaveLength(1);
  });

  it('accept while offline → accepted_local, not relay-backed (a later sync re-publishes)', async () => {
    const id = await importAsRecipient();
    relay.tryPublishAcceptance.mockResolvedValue('offline');

    const res = await PromiseService.acceptImportedPromise(id, ME, 'Me');

    expect(res?.mode).toBe('accepted_local');
    const after = await PromiseService.getPromise(id);
    expect(after?.status).toBe('accepted');
    expect(after?.relayBacked).toBeFalsy();
  });

  it('retries while the creator doc is not present yet, then syncs', async () => {
    vi.useFakeTimers();
    try {
      const id = await importAsRecipient();
      relay.tryPublishAcceptance
        .mockResolvedValueOnce('not_found')
        .mockResolvedValueOnce('not_found')
        .mockResolvedValueOnce('published');

      const promiseP = PromiseService.acceptImportedPromise(id, ME, 'Me');
      await vi.runAllTimersAsync(); // flush the backoff sleeps
      const res = await promiseP;

      expect(res?.mode).toBe('accepted_synced');
      expect(relay.tryPublishAcceptance).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('accept is idempotent — a re-tap does not double-sign or double-append', async () => {
    const id = await importAsRecipient();

    await PromiseService.acceptImportedPromise(id, ME, 'Me');
    const res2 = await PromiseService.acceptImportedPromise(id, ME, 'Me');

    expect(res2?.promise.status).toBe('accepted');
    const after = await PromiseService.getPromise(id);
    // Exactly one acceptance event survives the second call.
    expect(after?.events.filter(e => e.type === 'accepted')).toHaveLength(1);
  });

  it('decline marks the promise rejected and signals the creator', async () => {
    const id = await importAsRecipient();

    const res = await PromiseService.declineImportedPromise(id, ME);

    expect(res?.status).toBe('rejected');
    expect(relay.publishPromiseRejected).toHaveBeenCalledWith(id, expect.toSatisfy((value: unknown) => value === undefined || (typeof value === 'object' && value !== null && 'nativeId' in value)));
    const after = await PromiseService.getPromise(id);
    expect(after?.status).toBe('rejected');
    expect(after?.events.filter(e => e.type === 'negotiation_rejected')).toHaveLength(1);
  });

  it('decline is idempotent on an already-resolved promise', async () => {
    const id = await importAsRecipient();
    await PromiseService.declineImportedPromise(id, ME);
    relay.publishPromiseRejected.mockClear();

    const res = await PromiseService.declineImportedPromise(id, ME);
    expect(res?.status).toBe('rejected');
    // No second publish / no second event on the no-op path.
    expect(relay.publishPromiseRejected).not.toHaveBeenCalled();
    const after = await PromiseService.getPromise(id);
    expect(after?.events.filter(e => e.type === 'negotiation_rejected')).toHaveLength(1);
  });

  it('returns null for an unknown promise id', async () => {
    expect(await PromiseService.acceptImportedPromise('nope', ME, 'Me')).toBeNull();
    expect(await PromiseService.declineImportedPromise('nope', ME)).toBeNull();
  });
});
