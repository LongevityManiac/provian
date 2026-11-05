import { describe, it, expect, beforeEach, vi } from 'vitest';

// Proves the CLIENT side of the remote close-out on the RELAY model, where
// the SERVER is authoritative: PromiseService posts its EIP-191 close-out
// signature and the relay reports `{ ok, mode }` — `awaiting_counterparty` for the
// first party, `fulfilled` once BOTH signatures are present. There is no
// client-driven finalize. The relay (RelayAPIService) is mocked here; the wallet
// signing + terms encryption are mocked so this isolates the reducer logic.

const relay = vi.hoisted(() => ({
  publishPromiseCreated: vi.fn(async () => true),
  publishPromiseAccepted: vi.fn(async () => true),
  publishCloseoutSignature: vi.fn(
    async (): Promise<{ ok: boolean; mode?: 'fulfilled' | 'awaiting_counterparty' }> => ({ ok: true, mode: 'awaiting_counterparty' }),
  ),
  publishPromiseDisputed: vi.fn(async () => true),
  publishPromiseRejected: vi.fn(async () => true),
  checkPromiseStatus: vi.fn(),
  getUid: vi.fn(() => 'uidme'),
  subscribeToPromise: vi.fn(() => () => undefined),
}));

// The detailed read derives from the plain one, as the service's own does (2026-10-17).
Object.assign(relay, {
  checkPromiseStatusDetailed: vi.fn(async (...args: unknown[]) => {
    const doc = await (relay.checkPromiseStatus as unknown as (...a: unknown[]) => Promise<unknown>)(...args);
    return doc ? { kind: 'found', doc } : { kind: 'unavailable' };
  }),
  publishPromiseBroken: vi.fn(async () => true),
});
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

import PromiseService from './PromiseService';
import ProvenanceEnvelopeManager from '../provenance/ProvenanceEnvelopeManager';
import CorroborationManager from '../provenance/CorroborationManager';

const ME = '0xME';
const BOB = '0xBOB';
const DIGEST = 'd'.repeat(64);

function fulfilledPECalls(): unknown[] {
  return vi.mocked(ProvenanceEnvelopeManager.createEnvelope).mock.calls.filter(
    ([arg]) => (arg as { actionType?: string } | undefined)?.actionType === 'promise_fulfilled',
  );
}

function remoteDoc(promiseId: string, over: Record<string, unknown>) {
  return {
    promiseId,
    creatorUid: 'uidme',
    acceptorUid: 'uidbob',
    digest: DIGEST,
    signatures: {
      uidme: { role: 'creator', signature: 'termsA', at: 1 },
      uidbob: { role: 'acceptor', signature: 'termsB', at: 2 },
    },
    closeout: {},
    status: 'accepted',
    createdAt: 1,
    updatedAt: 2,
    expiresAt: 3,
    ...over,
  };
}

async function makeAccepted(): Promise<string> {
  // create + accept both publish successfully (mock → true), so the promise is
  // RELAY-BACKED before close-out (create/accept mark it via markRelayBacked).
  const p = await PromiseService.createPromise({
    theyGave: 'Tamales', theyOwe: '50 pesos', who: 'Bob', whoAddress: BOB,
    direction: 'owed_to_me', creatorAddress: ME,
  });
  await PromiseService.acceptPromise(p.id, BOB);
  return p.id;
}

describe('PromiseService — remote close-out client reducer (relay-authoritative)', () => {
  beforeEach(async () => {
    await PromiseService.deleteAllPromises();
    relay.checkPromiseStatus.mockReset();
    relay.publishCloseoutSignature.mockClear();
    relay.publishCloseoutSignature.mockResolvedValue({ ok: true, mode: 'awaiting_counterparty' });
    relay.publishPromiseCreated.mockResolvedValue(true);
    relay.publishPromiseAccepted.mockResolvedValue(true);
    relay.getUid.mockReturnValue('uidme');
  });

  it('initiator: relay says awaiting → stays accepted, posts my close-out signature', async () => {
    const id = await makeAccepted();
    relay.checkPromiseStatus.mockResolvedValueOnce(remoteDoc(id, { closeout: {} }));
    relay.publishCloseoutSignature.mockResolvedValueOnce({ ok: true, mode: 'awaiting_counterparty' });

    const res = await PromiseService.closeOutPromise(id, ME);

    expect(res?.mode).toBe('awaiting_counterparty');
    expect(relay.publishCloseoutSignature).toHaveBeenCalledWith(id, expect.any(String), expect.toSatisfy((value: unknown) => value === undefined || (typeof value === 'object' && value !== null && 'nativeId' in value)));
    const after = await PromiseService.getPromise(id);
    expect(after?.status).toBe('accepted');
    expect(after?.closeoutInitiatedByMe).toBe(true);
    expect(after?.fulfillmentSignatures?.mine).toBeTruthy();
  });

  it('confirmer: relay says fulfilled → status fulfilled, both close-out signatures recorded', async () => {
    const id = await makeAccepted();
    relay.checkPromiseStatus.mockResolvedValueOnce(remoteDoc(id, {
      closeout: { uidbob: { address: 'uidbob', signature: 'fulfillB', signed_at: 5 } },
    }));
    relay.publishCloseoutSignature.mockResolvedValueOnce({ ok: true, mode: 'fulfilled' });

    const res = await PromiseService.closeOutPromise(id, ME);

    expect(res?.mode).toBe('fulfilled');
    expect(relay.publishCloseoutSignature).toHaveBeenCalledWith(id, expect.any(String), expect.toSatisfy((value: unknown) => value === undefined || (typeof value === 'object' && value !== null && 'nativeId' in value)));
    const after = await PromiseService.getPromise(id);
    expect(after?.status).toBe('fulfilled');
    expect(after?.fulfillmentSignatures?.mine).toBeTruthy();
    expect(after?.fulfillmentSignatures?.counterparty).toBe('fulfillB');
  });

  it('sync: counterparty accepted → local accepted + counterparty terms signature recorded', async () => {
    const p = await PromiseService.createPromise({
      theyGave: 'Tamales', theyOwe: '50 pesos', who: 'Bob', whoAddress: BOB,
      direction: 'owed_to_me', creatorAddress: ME,
    }); // pending
    relay.checkPromiseStatus.mockResolvedValueOnce(remoteDoc(p.id, {
      signatures: {
        uidme: { role: 'creator', signature: 'termsA', at: 1 },
        uidbob: { role: 'acceptor', signature: 'termsBob', at: 2 },
      },
      status: 'accepted',
    }));

    const n = await PromiseService.syncPendingPromises();

    expect(n).toBe(1);
    const after = await PromiseService.getPromise(p.id);
    expect(after?.status).toBe('accepted');
    expect(after?.counterpartySignature).toBe('termsBob');
  });

  it('sync: counterparty initiated a close-out → surfaced (not auto-closed)', async () => {
    const id = await makeAccepted();
    relay.checkPromiseStatus.mockResolvedValueOnce(remoteDoc(id, {
      closeout: { uidbob: { address: 'uidbob', signature: 'fulfillBob', signed_at: 5 } },
      status: 'accepted',
    }));

    const n = await PromiseService.syncPendingPromises();

    expect(n).toBe(1);
    const after = await PromiseService.getPromise(id);
    expect(after?.status).toBe('accepted'); // NOT auto-closed by one side
    expect(after?.closeoutInitiatedByCounterparty).toBe(true);
    expect(after?.fulfillmentSignatures?.counterparty).toBe('fulfillBob');
  });
});

// C4 (CRITICAL): the list-screen "Mark Fulfilled" routes through closeOutPromise —
// the SAME mutual path the detail screen uses. For an ACCEPTED bilateral promise a
// single device must NEVER emit a settlement PE / corroboration without the
// counterparty's close-out.
describe('PromiseService — C4: no unilateral settlement on an accepted bilateral promise', () => {
  beforeEach(async () => {
    await PromiseService.deleteAllPromises();
    relay.checkPromiseStatus.mockReset();
    relay.publishCloseoutSignature.mockClear();
    relay.publishCloseoutSignature.mockResolvedValue({ ok: true, mode: 'awaiting_counterparty' });
    relay.getUid.mockReturnValue('uidme');
  });

  it('initiating a close-out writes NO promise_fulfilled PE and NO corroboration', async () => {
    const id = await makeAccepted();
    relay.checkPromiseStatus.mockResolvedValueOnce(remoteDoc(id, { closeout: {} }));
    relay.publishCloseoutSignature.mockResolvedValueOnce({ ok: true, mode: 'awaiting_counterparty' });
    vi.mocked(ProvenanceEnvelopeManager.createEnvelope).mockClear();
    vi.mocked(CorroborationManager.emitCorroboration).mockClear();

    const res = await PromiseService.closeOutPromise(id, ME);

    expect(res?.mode).toBe('awaiting_counterparty');
    expect(fulfilledPECalls()).toHaveLength(0);
    expect(CorroborationManager.emitCorroboration).not.toHaveBeenCalled();
    const after = await PromiseService.getPromise(id);
    expect(after?.status).toBe('accepted'); // still pending mutual confirmation
  });

  it('contrast: the OLD direct fulfillPromise DID settle unilaterally (why the list must not call it)', async () => {
    const id = await makeAccepted();
    vi.mocked(ProvenanceEnvelopeManager.createEnvelope).mockClear();

    await PromiseService.fulfillPromise(id, ME);

    expect(fulfilledPECalls().length).toBeGreaterThan(0); // unilateral settlement PE
    const after = await PromiseService.getPromise(id);
    expect(after?.status).toBe('fulfilled');
  });
});

// C11: the creator confirms the relay doc landed BEFORE presenting the online
// accept path. publishCreatedPromise must AWAIT the relay and report the result,
// now carrying the digest + encrypted terms.
describe('PromiseService — C11: publishCreatedPromise confirms before online acceptance', () => {
  beforeEach(async () => {
    await PromiseService.deleteAllPromises();
    relay.publishPromiseCreated.mockClear();
    relay.publishPromiseCreated.mockResolvedValue(true);
  });

  it('awaits the relay publish and returns whether it landed', async () => {
    const p = await PromiseService.createPromise({
      theyGave: 'Tamales', theyOwe: '50 pesos', who: 'Bob',
      direction: 'owed_to_me', creatorAddress: ME, deferRelayPublish: true,
    });
    // deferRelayPublish skips the fire-and-forget publish (but still SIGNS), so the
    // explicit confirm below is the only publish call.
    expect(relay.publishPromiseCreated).not.toHaveBeenCalled();
    expect(p.creatorSignature).toBeTruthy();

    relay.publishPromiseCreated.mockResolvedValueOnce(true);
    await expect(PromiseService.publishCreatedPromise(p)).resolves.toBe(true);

    relay.publishPromiseCreated.mockResolvedValueOnce(false);
    await expect(PromiseService.publishCreatedPromise(p)).resolves.toBe(false);

    expect(relay.publishPromiseCreated).toHaveBeenLastCalledWith(
      p.id, DIGEST, p.creatorSignature, expect.any(String), expect.toSatisfy((value: unknown) => value === undefined || (typeof value === 'object' && value !== null && 'nativeId' in value)),
    );
  });
});

// C4 state-gated: the local-fulfill vs mutual-close-out choice is made by PROMISE
// STATE (relayBacked), NOT by current reachability. An accepted promise that IS
// relay-backed but is OFFLINE at fulfill time must DEFER (offline_pending) — never
// a unilateral settlement.
describe('PromiseService — C4 state-gated: relayBacked + offline → offline_pending', () => {
  beforeEach(async () => {
    await PromiseService.deleteAllPromises();
    relay.checkPromiseStatus.mockReset();
    relay.publishCloseoutSignature.mockClear();
    relay.getUid.mockReturnValue('uidme');
  });

  it('accepted + relayBacked + checkPromiseStatus→null → offline_pending, NO PE, NO corroboration', async () => {
    const id = await makeAccepted();
    await PromiseService.markRelayBacked(id); // positive relay evidence, persisted
    relay.checkPromiseStatus.mockResolvedValueOnce(null); // relay unreachable NOW
    vi.mocked(ProvenanceEnvelopeManager.createEnvelope).mockClear();
    vi.mocked(CorroborationManager.emitCorroboration).mockClear();

    const res = await PromiseService.closeOutPromise(id, ME);

    // Selected by STATE (relayBacked), not reachability → deferred, not settled.
    expect(res?.mode).toBe('offline_pending');
    expect(fulfilledPECalls()).toHaveLength(0); // NO unilateral settlement PE
    expect(CorroborationManager.emitCorroboration).not.toHaveBeenCalled();
    const after = await PromiseService.getPromise(id);
    expect(after?.status).toBe('accepted');
    expect(after?.closeoutInitiatedByMe).toBe(true);
    expect(after?.pendingCloseoutPublish).toBe(true);
    expect(after?.fulfillmentSignatures?.mine).toBeTruthy();
  });
});

// Invariant 1: a share link can be created+shared BEFORE (or without) the relay
// doc being published, so import must NOT infer relayBacked — otherwise an imported
// promise with no relay doc would route to offline_pending and never complete.
describe('PromiseService — Invariant 1: share-link import does NOT infer relayBacked', () => {
  beforeEach(async () => {
    await PromiseService.deleteAllPromises();
    relay.checkPromiseStatus.mockReset();
    relay.publishPromiseCreated.mockResolvedValue(true);
    relay.getUid.mockReturnValue('uidme');
  });

  it('an imported promise is NOT relayBacked; an offline close-out LOCAL-fulfills (no stranding)', async () => {
    const created = await PromiseService.createPromise({
      theyGave: 'Tamales', theyOwe: '50 pesos', who: 'Bob', whoAddress: BOB,
      direction: 'owed_to_me', creatorAddress: ME, creatorName: 'Alice', deferRelayPublish: true,
    });
    const { universalUrl } = await PromiseService.buildShareLink(created);
    const url = new URL(universalUrl);
    const d = url.searchParams.get('d')!;
    const k = new URLSearchParams(url.hash.slice(1)).get('k')!;

    await PromiseService.deleteAllPromises(); // fresh device (counterparty)

    const imported = await PromiseService.importPromiseFromShareLink(d, k, BOB);
    expect(imported?.relayBacked).toBeFalsy(); // import alone proves nothing

    // Accept locally (no relay confirmation) and close out while offline.
    await PromiseService.acceptPromiseOffline(imported!.id, BOB, 'Bob');
    relay.checkPromiseStatus.mockResolvedValueOnce(null);
    const res = await PromiseService.closeOutPromise(imported!.id, BOB);

    expect(res?.mode).toBe('local_fulfilled'); // NOT offline_pending → not stranded
    expect((await PromiseService.getPromise(imported!.id))?.status).toBe('fulfilled');
  });
});

// Invariant 2: offline_pending must not deadlock. (a) the deferred completion is
// fired by syncPendingPromises which FLUSHES the stored signature; (b) if BOTH
// devices defer, they converge once both reconnect.
describe('PromiseService — Invariant 2: offline_pending converges (no deadlock)', () => {
  beforeEach(async () => {
    await PromiseService.deleteAllPromises();
    relay.checkPromiseStatus.mockReset();
    relay.publishCloseoutSignature.mockClear();
    relay.publishCloseoutSignature.mockResolvedValue({ ok: true, mode: 'awaiting_counterparty' });
    relay.getUid.mockReturnValue('uidme');
  });

  it('2a: the deferred close-out signature is FLUSHED (published) on the next syncPendingPromises', async () => {
    const id = await makeAccepted();
    await PromiseService.markRelayBacked(id);
    relay.checkPromiseStatus.mockResolvedValueOnce(null); // offline → defer
    await PromiseService.closeOutPromise(id, ME);
    expect((await PromiseService.getPromise(id))?.pendingCloseoutPublish).toBe(true);

    relay.publishCloseoutSignature.mockClear();
    relay.publishCloseoutSignature.mockResolvedValueOnce({ ok: true, mode: 'awaiting_counterparty' });
    // Reconnect: relay doc present, no counterparty close-out yet.
    relay.checkPromiseStatus.mockResolvedValueOnce(remoteDoc(id, { closeout: {} }));
    const n = await PromiseService.syncPendingPromises();

    expect(n).toBe(1);
    expect(relay.publishCloseoutSignature).toHaveBeenCalledWith(id, expect.any(String), expect.toSatisfy((value: unknown) => value === undefined || (typeof value === 'object' && value !== null && 'nativeId' in value)));
    const after = await PromiseService.getPromise(id);
    expect(after?.pendingCloseoutPublish).toBe(false); // flushed
    expect(after?.closeoutInitiatedByMe).toBe(true); // now awaiting counterparty
    expect(after?.status).toBe('accepted');
  });

  it('2b: BOTH parties go offline_pending → converge to fulfilled when both reconnect', async () => {
    const id = await makeAccepted();
    await PromiseService.markRelayBacked(id);

    // Alice (creator, uidme) closes out OFFLINE → offline_pending, signature stored.
    relay.checkPromiseStatus.mockResolvedValueOnce(null);
    const aliceRes = await PromiseService.closeOutPromise(id, ME);
    expect(aliceRes?.mode).toBe('offline_pending');
    const aliceSig = (await PromiseService.getPromise(id))!.fulfillmentSignatures!.mine!;

    // Alice reconnects: relay doc carries NO close-out yet → flush publishes hers.
    relay.publishCloseoutSignature.mockClear();
    relay.publishCloseoutSignature.mockResolvedValueOnce({ ok: true, mode: 'awaiting_counterparty' });
    relay.checkPromiseStatus.mockResolvedValueOnce(remoteDoc(id, { closeout: {} }));
    await PromiseService.syncPendingPromises();
    expect(relay.publishCloseoutSignature).toHaveBeenCalledWith(id, aliceSig, expect.toSatisfy((value: unknown) => value === undefined || (typeof value === 'object' && value !== null && 'nativeId' in value)));
    expect((await PromiseService.getPromise(id))?.status).toBe('accepted'); // still awaiting Bob

    // Bob also deferred + reconnected → the shared relay doc now carries BOTH
    // close-out signatures. Alice's next sync settles via the reconcile bothCloseout
    // path (the relay already flipped status; the client just applies it).
    relay.checkPromiseStatus.mockResolvedValueOnce(remoteDoc(id, {
      closeout: {
        uidme: { address: 'uidme', signature: aliceSig, signed_at: 10 },
        uidbob: { address: 'uidbob', signature: 'bobFulfill', signed_at: 11 },
      },
      status: 'fulfilled',
    }));
    await PromiseService.syncPendingPromises();

    const final = await PromiseService.getPromise(id);
    expect(final?.status).toBe('fulfilled'); // converged — no deadlock
    expect(final?.fulfillmentSignatures?.counterparty).toBe('bobFulfill');
  });

  // withTimeout bounds the AWAIT but a relay write has no client abort, so a write
  // that the UI timed out on still LANDS on reconnect. (a) the timeout must keep
  // pendingCloseoutPublish=true; (b) when the in-flight write lands later, the flush
  // must be idempotent — see its signature already present, NOT re-publish.

  it('2c-(a): a close-out publish that TIMES OUT → offline_pending, retry preserved (no hang)', async () => {
    const id = await makeAccepted();
    await PromiseService.markRelayBacked(id);
    relay.checkPromiseStatus.mockResolvedValueOnce(remoteDoc(id, { closeout: {} })); // readable → publish branch
    // The underlying relay write NEVER resolves (real offline behavior).
    relay.publishCloseoutSignature.mockReturnValueOnce(new Promise(() => { /* never */ }) as never);
    vi.mocked(ProvenanceEnvelopeManager.createEnvelope).mockClear();

    vi.useFakeTimers();
    let res: Awaited<ReturnType<typeof PromiseService.closeOutPromise>> = null;
    try {
      const pending = PromiseService.closeOutPromise(id, ME);
      await vi.runAllTimersAsync(); // fire withTimeout's timer
      res = await pending;
    } finally {
      vi.useRealTimers();
    }

    expect(res?.mode).toBe('offline_pending');                       // did NOT hang
    expect(relay.publishCloseoutSignature).toHaveBeenCalledTimes(1); // attempted exactly once
    const after = await PromiseService.getPromise(id);
    expect(after?.pendingCloseoutPublish).toBe(true);               // retry PRESERVED
    expect(fulfilledPECalls()).toHaveLength(0);                     // no unilateral settlement
  });

  it('2c-(b): timeout → the in-flight write LANDS LATE → flush is idempotent (no double-publish, ONE PE, fulfilled)', async () => {
    const id = await makeAccepted();
    await PromiseService.markRelayBacked(id);
    relay.checkPromiseStatus.mockResolvedValueOnce(remoteDoc(id, { closeout: {} }));
    relay.publishCloseoutSignature.mockReturnValueOnce(new Promise(() => { /* never */ }) as never);

    // Reach offline_pending via a REAL withTimeout expiry (write left in-flight).
    vi.useFakeTimers();
    try {
      const pending = PromiseService.closeOutPromise(id, ME);
      await vi.runAllTimersAsync();
      await pending;
    } finally {
      vi.useRealTimers();
    }
    const after1 = await PromiseService.getPromise(id);
    expect(after1?.pendingCloseoutPublish).toBe(true);
    const mySig = after1!.fulfillmentSignatures!.mine!;

    // The timed-out write now LANDS on the server: the doc carries MY close-out
    // signature. The counterparty has since closed too → both present, status flipped.
    relay.publishCloseoutSignature.mockClear();
    vi.mocked(ProvenanceEnvelopeManager.createEnvelope).mockClear();
    relay.checkPromiseStatus.mockResolvedValueOnce(remoteDoc(id, {
      closeout: {
        uidme: { address: 'uidme', signature: mySig, signed_at: 20 },
        uidbob: { address: 'uidbob', signature: 'bobFulfill', signed_at: 21 },
      },
      status: 'fulfilled',
    }));
    const n = await PromiseService.syncPendingPromises();

    expect(n).toBe(1);
    expect(relay.publishCloseoutSignature).not.toHaveBeenCalled(); // idempotent: saw my signature → NO re-publish
    const after2 = await PromiseService.getPromise(id);
    expect(after2?.pendingCloseoutPublish).toBe(false);           // flag cleared
    expect(after2?.status).toBe('fulfilled');                     // single converged settlement
    expect(fulfilledPECalls()).toHaveLength(1);                   // exactly ONE PE (no duplicate)
    expect(after2?.fulfillmentSignatures?.counterparty).toBe('bobFulfill');
  });
});


describe('Promise PE privacy', () => {
  beforeEach(async () => {
    await PromiseService.deleteAllPromises();
    vi.mocked(ProvenanceEnvelopeManager.createEnvelope).mockClear();
    relay.publishPromiseCreated.mockResolvedValue(true);
    relay.publishPromiseAccepted.mockResolvedValue(true);
    relay.getUid.mockReturnValue('uidme');
  });

  it('omits private terms and names while retaining fulfilled earning verification metadata', async () => {
    const id = await makeAccepted();
    await PromiseService.fulfillPromise(id, ME, 'Private fulfillment comment');
    await PromiseService.deletePromise(id);
    const calls = vi.mocked(ProvenanceEnvelopeManager.createEnvelope).mock.calls.map(([arg]) => arg);
    expect(calls.map((arg) => arg.actionType)).toEqual([
      'promise_created', 'promise_accepted', 'promise_fulfilled', 'promise_deleted',
    ]);
    const payload = JSON.stringify(calls);
    for (const privateText of ['Tamales', '50 pesos', 'Bob', 'Private fulfillment comment']) {
      expect(payload).not.toContain(privateText);
    }
    expect(calls.find((arg) => arg.actionType === 'promise_fulfilled')).toMatchObject({
      intentText: 'Promise fulfilled', promiseId: id, counterparty: BOB,
    });
  });

  it('keeps a dispute reason on-device rather than in the lifecycle PE', async () => {
    const id = await makeAccepted();
    await PromiseService.disputePromise(id, ME, 'Private dispute terms and counterparty name');
    const payload = JSON.stringify(vi.mocked(ProvenanceEnvelopeManager.createEnvelope).mock.calls);
    expect(payload).not.toContain('Private dispute');
    expect(payload).not.toContain('Tamales');
    expect(payload).not.toContain('Bob');
    expect((await PromiseService.getPromise(id))?.events.at(-1)?.comment)
      .toBe('Private dispute terms and counterparty name');
  });
});
