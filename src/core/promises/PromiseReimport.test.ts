import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// R9 (bug check 2026-10-17, closed by): re-importing a promise's ORIGINAL share link
// after a counter-offer must resolve to the existing local record in its current state —
// never a second record, never a reset of its signature phases.

const relay = vi.hoisted(() => ({
  publishPromiseCreated: vi.fn(async () => true),
  publishPromiseAccepted: vi.fn(async () => true),
  publishPromiseCountered: vi.fn(async () => true),
  publishCloseoutSignature: vi.fn(async () => ({ ok: true, mode: 'awaiting_counterparty' as const })),
  publishPromiseDisputed: vi.fn(async () => true),
  checkPromiseStatus: vi.fn(),
  // A re-shared code with different terms reads the relay first (two-sim finding, 2026-10-17).
  checkPromiseStatusDetailed: vi.fn(async () => ({ kind: 'unavailable' as const })),
  getUid: vi.fn(() => 'uidMe'),
  subscribeToPromise: vi.fn((_id: string, cb: (doc: unknown) => void) => { subscribed.cb = cb; return () => undefined; }),
  tryPublishAcceptance: vi.fn(async () => 'published' as const),
}));
const subscribed = vi.hoisted(() => ({ cb: null as null | ((doc: unknown) => Promise<void> | void) }));

vi.mock('./PromiseRelayService', () => ({ promiseRelayService: relay }));
vi.mock('./promiseSigning', () => ({
  computePromiseDigest: vi.fn(async (t: { theyGave: string; theyOwe: string }) => `digest:${t.theyGave}:${t.theyOwe}`),
  signHumanPromisePhase: vi.fn(async (phase: string, _id: string, digest: string) => `sig:${phase}:${digest}`),
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

const ALICE = '0xAlice';
const BOB = '0xBob';

async function shareLinkOf(promise: Awaited<ReturnType<typeof PromiseService.createPromise>>) {
  const { universalUrl } = await PromiseService.buildShareLink(promise);
  const url = new URL(universalUrl);
  return { d: url.searchParams.get('d')!, k: new URLSearchParams(url.hash.slice(1)).get('k')! };
}

describe('R9: re-importing the original share link after a counter-offer', () => {
  beforeEach(async () => {
    await PromiseService.deleteAllPromises();
  });

  it('the counterparty who countered gets its existing record back, countered, its counter signature intact', async () => {
    const created = await PromiseService.createPromise({
      theyGave: 'Tamales', theyOwe: '50 pesos', who: 'Bob',
      direction: 'owed_to_me', creatorAddress: ALICE, creatorName: 'Alice',
    });
    const link = await shareLinkOf(created);
    await PromiseService.deleteAllPromises(); // device B

    const first = await PromiseService.importPromiseFromShareLink(link.d, link.k, BOB);
    expect(first?.status).toBe('pending');
    await PromiseService.counterPromise(created.id, BOB, { theyGave: 'Tamales', theyOwe: '60 pesos' });
    const before = await PromiseService.getPromise(created.id);
    expect(before?.status).toBe('countered');
    const snapshot = JSON.parse(JSON.stringify(before));

    const again = await PromiseService.importPromiseFromShareLink(link.d, link.k, BOB);
    expect(again?.id).toBe(created.id);
    expect(await PromiseService.getAllPromises()).toHaveLength(1);
    const after = await PromiseService.getPromise(created.id);
    expect(after?.status).toBe('countered');
    expect(after?.theyOwe).toBe('60 pesos');
    expect(after?.digest).toBe(snapshot.digest);
    expect(after?.events).toEqual(snapshot.events);
    expect(after?.creatorSignature).toBe(snapshot.creatorSignature);
    expect(after?.counterpartySignature).toBe(snapshot.counterpartySignature);
  });

  it('the creator who countered its own promise re-opens the original link: its record, new terms, new signature', async () => {
    const created = await PromiseService.createPromise({
      theyGave: 'Coffee', theyOwe: '20 pesos', who: 'Bob',
      direction: 'owed_to_me', creatorAddress: ALICE, creatorName: 'Alice',
    });
    const link = await shareLinkOf(created);
    await PromiseService.counterPromise(created.id, ALICE, { theyGave: 'Coffee', theyOwe: '25 pesos' });
    const snapshot = JSON.parse(JSON.stringify(await PromiseService.getPromise(created.id)));

    const again = await PromiseService.importPromiseFromShareLink(link.d, link.k, ALICE);
    expect(again?.id).toBe(created.id);
    expect(await PromiseService.getAllPromises()).toHaveLength(1);
    expect(await PromiseService.getPromise(created.id)).toEqual(snapshot);
  });

  it('an accepted promise re-imported keeps both signatures and its accepted state', async () => {
    const created = await PromiseService.createPromise({
      theyGave: 'Bread', theyOwe: '10 pesos', who: 'Bob',
      direction: 'owed_to_me', creatorAddress: ALICE, creatorName: 'Alice',
    });
    const link = await shareLinkOf(created);
    await PromiseService.deleteAllPromises();
    await PromiseService.importPromiseFromShareLink(link.d, link.k, BOB);
    await PromiseService.acceptPromise(created.id, BOB);
    const snapshot = JSON.parse(JSON.stringify(await PromiseService.getPromise(created.id)));
    expect(snapshot.status).toBe('accepted');

    await PromiseService.importPromiseFromShareLink(link.d, link.k, BOB);
    expect(await PromiseService.getAllPromises()).toHaveLength(1);
    expect(await PromiseService.getPromise(created.id)).toEqual(snapshot);
  });

  it('a re-scanned ORIGINAL code after a counter resolves to the countered record and cannot be "accepted" with an empty signature', async () => {
    const created = await PromiseService.createPromise({
      theyGave: 'Rice', theyOwe: '30 pesos', who: 'Bob',
      direction: 'owed_to_me', creatorAddress: ALICE, creatorName: 'Alice',
    });
    const link = await shareLinkOf(created);
    await PromiseService.deleteAllPromises();
    await PromiseService.importPromiseFromShareLink(link.d, link.k, BOB);
    await PromiseService.counterPromise(created.id, BOB, { theyGave: 'Rice', theyOwe: '35 pesos' });
    const snapshot = JSON.parse(JSON.stringify(await PromiseService.getPromise(created.id)));
    relay.tryPublishAcceptance.mockClear();

    // The scan screen's preview + Accept on the original code (2026-10-17: it reported
    // success and published an acceptance whose signature was '').
    await PromiseService.importPromiseFromShareLink(link.d, link.k, BOB);
    await expect(PromiseService.acceptImportedPromise(created.id, BOB, 'Bob')).rejects.toThrow(/countered now/);
    expect(relay.tryPublishAcceptance).not.toHaveBeenCalled();
    expect(await PromiseService.getPromise(created.id)).toEqual(snapshot);
    expect(await PromiseService.getAllPromises()).toHaveLength(1);
  });

  it('the counter\'s re-shared link brings the counter\'s terms to the existing record (the A9 message sends people to it)', async () => {
    const created = await PromiseService.createPromise({
      theyGave: 'Fish', theyOwe: '40 pesos', who: 'Bob',
      direction: 'owed_to_me', creatorAddress: ALICE, creatorName: 'Alice',
    });
    const original = await shareLinkOf(created);
    // Alice counters on her phone and re-shares.
    await PromiseService.counterPromise(created.id, ALICE, { theyGave: 'Fish', theyOwe: '45 pesos' });
    const counterLink = await shareLinkOf((await PromiseService.getPromise(created.id))!);

    // Bob's phone: he imported the original, then the relay told him of Alice's counter.
    await PromiseService.deleteAllPromises();
    await PromiseService.importPromiseFromShareLink(original.d, original.k, BOB);
    PromiseService.subscribeToUpdates(created.id, () => undefined);
    await subscribed.cb!({
      promiseId: created.id, creatorUid: ALICE.toLowerCase(), acceptorUid: null,
      digest: 'digest:Fish:45 pesos', signatures: {}, closeout: {}, status: 'countered',
      createdAt: created.createdAt, updatedAt: Date.now(), expiresAt: Date.now() + 1e9,
    });
    const flagged = await PromiseService.getPromise(created.id);
    expect(flagged?.counterTermsPending).toBe(true);
    expect(flagged?.theyOwe).toBe('40 pesos');
    const eventsBefore = JSON.parse(JSON.stringify(flagged?.events));

    // The ORIGINAL link changes nothing.
    await PromiseService.importPromiseFromShareLink(original.d, original.k, BOB);
    expect((await PromiseService.getPromise(created.id))?.counterTermsPending).toBe(true);

    // The counter's link: the terms hash to the relay's counter digest → adopted.
    const resolved = await PromiseService.importPromiseFromShareLink(counterLink.d, counterLink.k, BOB);
    expect(resolved?.id).toBe(created.id);
    expect(await PromiseService.getAllPromises()).toHaveLength(1);
    const after = await PromiseService.getPromise(created.id);
    expect(after?.theyOwe).toBe('45 pesos');
    expect(after?.digest).toBe('digest:Fish:45 pesos');
    expect(after?.counterTermsPending).toBe(false);
    expect(after?.status).toBe('countered');
    expect(after?.events).toEqual(eventsBefore);
  });

  it('a link whose terms do not hash to the counter digest is not adopted', async () => {
    const created = await PromiseService.createPromise({
      theyGave: 'Eggs', theyOwe: '12 pesos', who: 'Bob',
      direction: 'owed_to_me', creatorAddress: ALICE, creatorName: 'Alice',
    });
    const original = await shareLinkOf(created);
    await PromiseService.counterPromise(created.id, ALICE, { theyGave: 'Eggs', theyOwe: '99 pesos' });
    const forged = await shareLinkOf((await PromiseService.getPromise(created.id))!);
    await PromiseService.deleteAllPromises();
    await PromiseService.importPromiseFromShareLink(original.d, original.k, BOB);
    PromiseService.subscribeToUpdates(created.id, () => undefined);
    await subscribed.cb!({
      promiseId: created.id, creatorUid: ALICE.toLowerCase(), acceptorUid: null,
      digest: 'digest:Eggs:15 pesos', signatures: {}, closeout: {}, status: 'countered',
      createdAt: created.createdAt, updatedAt: Date.now(), expiresAt: Date.now() + 1e9,
    });
    await PromiseService.importPromiseFromShareLink(forged.d, forged.k, BOB);
    const after = await PromiseService.getPromise(created.id);
    expect(after?.theyOwe).toBe('12 pesos');
    expect(after?.counterTermsPending).toBe(true);
  });

  it('the scan screen opens a promise already on the phone instead of previewing the code', () => {
    const src = readFileSync(resolve(__dirname, '../../screens/Promise/ScanPromiseScreen.tsx'), 'utf8');
    const scan = src.slice(src.indexOf('const payload = PromiseService.parseQRPayload(data);'));
    expect(scan.indexOf('findExistingForImport(payload)')).toBeGreaterThan(-1);
    expect(scan.indexOf('findExistingForImport(payload)')).toBeLessThan(scan.indexOf("setScanState('preview')"));
    expect(scan).toMatch(/if \(known\) \{\s*navigation\.replace\('PromiseDetail', \{ promiseId: known\.id \}\);\s*return;/);
  });
});
