import { describe, it, expect, beforeEach, vi } from 'vitest';

// 2026-10-17 (the standing rule after): a countered promise showed no actions, so it
// dead-ended for both parties. The party receiving a counter now takes every transition the state
// machine allows from `countered` — accept, counter, decline — each recorded on the relay before
// this device changes, and the countering party's device follows the relay out of `countered`.

const relay = vi.hoisted(() => ({
  publishPromiseCreated: vi.fn(async () => true),
  publishPromiseAccepted: vi.fn(async () => true),
  publishPromiseCountered: vi.fn(async () => true),
  publishPromiseRejected: vi.fn(async () => true),
  publishCloseoutSignature: vi.fn(async () => ({ ok: true, mode: 'awaiting_counterparty' as const })),
  checkPromiseStatus: vi.fn(),
  checkPromiseStatusDetailed: vi.fn(async (): Promise<{ kind: string; doc?: unknown }> => ({ kind: 'unavailable' })),
  getUid: vi.fn(() => 'uidme'),
  subscribeToPromise: vi.fn((_id: string, cb: (doc: unknown) => void) => { subscribed.cb = cb; return () => undefined; }),
  tryPublishAcceptance: vi.fn(async (): Promise<'published' | 'error' | 'offline' | 'not_found'> => 'published'),
  listMine: vi.fn(),
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

import PromiseService, { ACTIVE_LIST_STATUSES, HISTORY_LIST_STATUSES, VALID_TRANSITIONS, type PromiseRecord, type PromiseStatus } from './PromiseService';
import { decryptTermsFromSelf } from './PromiseTermsVault';
import { signHumanPromisePhase } from './promiseSigning';
import {
  COUNTER_OFFER_ACTION_TARGET,
  PROMISE_ACTION_STATUSES,
  counterOfferView,
} from '../../screens/Promise/promiseActions';

// `getUid` is the wallet the relay keys this device's party record by.
const ME = 'uidme';
const OTHER = '0x0ther';

async function linkOf(id: string) {
  const { universalUrl } = await PromiseService.buildShareLink((await PromiseService.getPromise(id))!);
  const url = new URL(universalUrl);
  return { d: url.searchParams.get('d')!, k: new URLSearchParams(url.hash.slice(1)).get('k')! };
}

const remote = (id: string, createdAt: number, over: Record<string, unknown>) => ({
  promiseId: id, creatorUid: ME, acceptorUid: OTHER.toLowerCase(), digest: '', signatures: {}, closeout: {},
  status: 'countered', createdAt, updatedAt: Date.now(), expiresAt: Date.now() + 1e9, ...over,
});

/**
 * The creator's device (ME) after the recipient (OTHER) countered and re-shared the link:
 * the relay told this device of the counter, and the counter's link brought its terms.
 */
async function creatorHoldingRecipientCounter() {
  const created = await PromiseService.createPromise({
    theyGave: 'Tamales', theyOwe: '50 pesos', who: 'Bob', direction: 'owed_to_me', creatorAddress: ME, creatorName: 'Alice',
  });
  // Bob's counter, made on "his phone" to get its link, then this phone is restored.
  const mine = JSON.parse(JSON.stringify(await PromiseService.getPromise(created.id)));
  await PromiseService.counterPromise(created.id, OTHER, { theyGave: 'Tamales', theyOwe: '60 pesos' });
  const counterLink = await linkOf(created.id);
  await PromiseService.deleteAllPromises();
  await PromiseService.updatePromise(mine);

  PromiseService.subscribeToUpdates(created.id, () => undefined);
  await subscribed.cb!(remote(created.id, created.createdAt, {
    digest: 'digest:Tamales:60 pesos',
    signatures: {
      [ME]: { role: 'creator', signature: 'sig:create', at: 1, signedDigest: 'digest:Tamales:50 pesos' },
      [OTHER.toLowerCase()]: { role: 'acceptor', signature: 'sig:counter:digest:Tamales:60 pesos', at: 2, signedDigest: 'digest:Tamales:60 pesos' },
    },
  }));
  const flagged = await PromiseService.getPromise(created.id);
  expect(flagged?.counterTermsPending).toBe(true);
  expect(counterOfferView(flagged!)).toEqual({ kind: 'awaiting_terms', actions: ['decline'] });
  await PromiseService.importPromiseFromShareLink(counterLink.d, counterLink.k, ME);
  const ready = await PromiseService.getPromise(created.id);
  expect(ready).toMatchObject({ status: 'countered', theyOwe: '60 pesos', digest: 'digest:Tamales:60 pesos', counterTermsPending: false, counterFromCounterparty: true });
  return created;
}

describe('the countered state offers every action the state machine allows', () => {
  it('RED before the fix: the Actions card showed for pending and accepted only', () => {
    expect(PROMISE_ACTION_STATUSES.has('countered')).toBe(true);
  });

  it('the receiving party\'s actions cover every transition out of countered except the time-driven expiry', () => {
    const view = counterOfferView({ status: 'countered', counterFromCounterparty: true, counterTermsPending: false });
    expect(view?.kind).toBe('answer');
    const targets = new Set(view!.actions.map((a) => COUNTER_OFFER_ACTION_TARGET[a]));
    const allowed = new Set([...VALID_TRANSITIONS.countered].filter((s) => s !== 'expired'));
    expect(targets).toEqual(allowed);
    expect(allowed.size).toBe(3); // accepted, countered, rejected — a pass over an empty set proves nothing
  });

  it('the countering party shares its link or withdraws; with terms still in transit only a decline is possible', () => {
    expect(counterOfferView({ status: 'countered', counterFromCounterparty: false, counterTermsPending: false }))
      .toEqual({ kind: 'mine', actions: ['share', 'withdraw'] });
    expect(counterOfferView({ status: 'countered', counterFromCounterparty: true, counterTermsPending: true }))
      .toEqual({ kind: 'awaiting_terms', actions: ['decline'] });
    expect(counterOfferView({ status: 'pending', counterFromCounterparty: undefined, counterTermsPending: undefined })).toBeNull();
  });
});

describe('answering a counter-offer', () => {
  beforeEach(async () => {
    await PromiseService.deleteAllPromises();
    vi.clearAllMocks();
    relay.getUid.mockReturnValue(ME);
    relay.tryPublishAcceptance.mockResolvedValue('published');
    relay.publishPromiseRejected.mockResolvedValue(true);
    relay.publishPromiseCountered.mockResolvedValue(true);
  });

  it('accept signs the counter\'s digest, records it on the relay, and only then shows accepted', async () => {
    const created = await creatorHoldingRecipientCounter();
    const accepted = await PromiseService.acceptCounterOffer(created.id, ME);
    expect(relay.tryPublishAcceptance).toHaveBeenCalledWith(created.id, 'digest:Tamales:60 pesos', 'sig:accept:digest:Tamales:60 pesos', 'ciphertext', expect.anything());
    expect(accepted).toMatchObject({ status: 'accepted', creatorSignature: 'sig:accept:digest:Tamales:60 pesos', digest: 'digest:Tamales:60 pesos', theyOwe: '60 pesos', counterFromCounterparty: false });
  });

  it('RED: an acceptance the relay refuses changes nothing on this device', async () => {
    const created = await creatorHoldingRecipientCounter();
    const before = JSON.parse(JSON.stringify(await PromiseService.getPromise(created.id)));
    relay.tryPublishAcceptance.mockResolvedValue('error');
    await expect(PromiseService.acceptCounterOffer(created.id, ME)).rejects.toThrow(/did not reach the relay/);
    expect(await PromiseService.getPromise(created.id)).toEqual(before);
  });

  it('RED: nothing is signed while the counter\'s terms are not on this device, nor by the party who countered', async () => {
    const created = await PromiseService.createPromise({
      theyGave: 'Rice', theyOwe: '30 pesos', who: 'Bob', direction: 'owed_to_me', creatorAddress: ME, creatorName: 'Alice',
    });
    PromiseService.subscribeToUpdates(created.id, () => undefined);
    await subscribed.cb!(remote(created.id, created.createdAt, {
      digest: 'digest:Rice:35 pesos',
      signatures: { [ME]: { role: 'creator', signature: 's', at: 1, signedDigest: 'digest:Rice:30 pesos' } },
    }));
    await expect(PromiseService.acceptCounterOffer(created.id, ME)).rejects.toThrow(/new link/);
    await expect(PromiseService.counterPromise(created.id, ME, { theyGave: 'Rice', theyOwe: '33 pesos' })).rejects.toThrow(/new link/);
    expect(relay.tryPublishAcceptance).not.toHaveBeenCalled();
    expect(relay.publishPromiseCountered).not.toHaveBeenCalled();

    // The party who countered has nothing to accept.
    await PromiseService.deleteAllPromises();
    const own = await PromiseService.createPromise({
      theyGave: 'Fish', theyOwe: '40 pesos', who: 'Bob', direction: 'owed_to_me', creatorAddress: ME, creatorName: 'Alice',
    });
    await PromiseService.counterPromise(own.id, ME, { theyGave: 'Fish', theyOwe: '45 pesos' });
    await expect(PromiseService.acceptCounterOffer(own.id, ME)).rejects.toThrow(/no counter-offer from the other party/);
  });

  it('counter again: recorded on the relay first, then this device waits on the other party', async () => {
    const created = await creatorHoldingRecipientCounter();
    const recountered = await PromiseService.counterPromise(created.id, ME, { theyGave: 'Tamales', theyOwe: '55 pesos' });
    expect(relay.publishPromiseCountered).toHaveBeenLastCalledWith(created.id, 'digest:Tamales:55 pesos', 'sig:counter:digest:Tamales:55 pesos', 'ciphertext', expect.anything());
    expect(recountered).toMatchObject({ status: 'countered', theyOwe: '55 pesos', counterFromCounterparty: false });
    expect(counterOfferView(recountered!)).toEqual({ kind: 'mine', actions: ['share', 'withdraw'] });
  });

  it('RED: a counter the relay refuses changes nothing on this device (it used to show terms the other phone never saw)', async () => {
    const created = await creatorHoldingRecipientCounter();
    const before = JSON.parse(JSON.stringify(await PromiseService.getPromise(created.id)));
    relay.publishPromiseCountered.mockResolvedValue(false);
    await expect(PromiseService.counterPromise(created.id, ME, { theyGave: 'Tamales', theyOwe: '55 pesos' })).rejects.toThrow(/did not reach the relay/);
    expect(await PromiseService.getPromise(created.id)).toEqual(before);
  });

  it('decline is recorded on the relay, then the promise is rejected here; a refused decline changes nothing', async () => {
    const created = await creatorHoldingRecipientCounter();
    const before = JSON.parse(JSON.stringify(await PromiseService.getPromise(created.id)));
    relay.publishPromiseRejected.mockResolvedValueOnce(false);
    await expect(PromiseService.declineCounterOffer(created.id, ME)).rejects.toThrow(/did not reach the relay/);
    expect(await PromiseService.getPromise(created.id)).toEqual(before);
    const declined = await PromiseService.declineCounterOffer(created.id, ME);
    expect(relay.publishPromiseRejected).toHaveBeenCalledTimes(2);
    expect(declined?.status).toBe('rejected');
  });
});

describe('the countering party\'s device follows the relay out of countered', () => {
  beforeEach(async () => {
    await PromiseService.deleteAllPromises();
    vi.clearAllMocks();
    relay.getUid.mockReturnValue(ME);
    relay.publishPromiseCountered.mockResolvedValue(true);
  });

  /** ME is the recipient here: I imported OTHER's promise and countered it. */
  async function recipientWhoCountered() {
    relay.getUid.mockReturnValue(OTHER.toLowerCase());
    const created = await PromiseService.createPromise({
      theyGave: 'Bread', theyOwe: '10 pesos', who: 'Me', direction: 'owed_to_me', creatorAddress: OTHER, creatorName: 'Other',
    });
    const link = await linkOf(created.id);
    await PromiseService.deleteAllPromises();
    relay.getUid.mockReturnValue(ME);
    await PromiseService.importPromiseFromShareLink(link.d, link.k, ME);
    await PromiseService.counterPromise(created.id, ME, { theyGave: 'Bread', theyOwe: '12 pesos' });
    PromiseService.subscribeToUpdates(created.id, () => undefined);
    return created;
  }
  const sigs = (creatorDigest: string) => ({
    [OTHER.toLowerCase()]: { role: 'creator', signature: `sig:accept:${creatorDigest}`, at: 3, signedDigest: creatorDigest },
    [ME]: { role: 'acceptor', signature: 'sig:counter:digest:Bread:12 pesos', at: 2, signedDigest: 'digest:Bread:12 pesos' },
  });

  it('RED before the fix: the other party\'s acceptance of my counter left this phone countered', async () => {
    const created = await recipientWhoCountered();
    await subscribed.cb!(remote(created.id, created.createdAt, {
      creatorUid: OTHER.toLowerCase(), acceptorUid: ME, status: 'accepted', digest: 'digest:Bread:12 pesos', signatures: sigs('digest:Bread:12 pesos'),
    }));
    expect(await PromiseService.getPromise(created.id)).toMatchObject({
      status: 'accepted', digest: 'digest:Bread:12 pesos', theyOwe: '12 pesos',
      creatorSignature: 'sig:accept:digest:Bread:12 pesos', counterFromCounterparty: false,
    });
  });

  it('RED before the fix: the other party\'s decline of my counter left this phone countered', async () => {
    const created = await recipientWhoCountered();
    await subscribed.cb!(remote(created.id, created.createdAt, {
      creatorUid: OTHER.toLowerCase(), acceptorUid: ME, status: 'rejected', digest: 'digest:Bread:12 pesos', signatures: sigs('digest:Bread:10 pesos'),
    }));
    expect((await PromiseService.getPromise(created.id))?.status).toBe('rejected');
  });

  it('while my counter is open the relay says it waits on the other party; their counter back makes it wait on me', async () => {
    const created = await recipientWhoCountered();
    await subscribed.cb!(remote(created.id, created.createdAt, {
      creatorUid: OTHER.toLowerCase(), acceptorUid: ME, digest: 'digest:Bread:12 pesos', signatures: sigs('digest:Bread:10 pesos'),
    }));
    expect(counterOfferView((await PromiseService.getPromise(created.id))!)?.kind).toBe('mine');
    await subscribed.cb!(remote(created.id, created.createdAt, {
      creatorUid: OTHER.toLowerCase(), acceptorUid: ME, digest: 'digest:Bread:11 pesos',
      signatures: { ...sigs('digest:Bread:11 pesos') },
    }));
    const after = await PromiseService.getPromise(created.id);
    expect(after).toMatchObject({ counterTermsPending: true, counterFromCounterparty: true, counterDigestPending: 'digest:Bread:11 pesos' });
    expect(counterOfferView(after!)?.kind).toBe('awaiting_terms');
  });
});

// Review r1 (2026-10-17): a record restored from the relay carries the counter's digest beside this
// party's OWN older terms (its terms copy there is its own). The digest alone cannot say whether the
// counter's terms are here; only hashing the terms can.
describe('a counter restored from the relay after recovery', () => {
  const D1 = 'digest:Bread:10 pesos';
  const D2 = 'digest:Bread:12 pesos';
  const CREATED = 1_760_000_000_000;
  const countered = (over: Record<string, unknown> = {}) => ({
    promiseId: 'p-restore', creatorUid: OTHER.toLowerCase(), acceptorUid: ME, digest: D2, status: 'countered',
    signatures: {
      [ME]: { role: 'acceptor', signature: `sig:accept:${D1}`, at: 1, signedDigest: D1, termsCiphertext: 'ct' },
      [OTHER.toLowerCase()]: { role: 'creator', signature: `sig:counter:${D2}`, at: 2, signedDigest: D2 },
    },
    closeout: {}, createdAt: CREATED, updatedAt: Date.now(), expiresAt: Date.now() + 1e9, ...over,
  });
  const myTerms = { promiseId: 'p-restore', theyGave: 'Bread', theyOwe: '10 pesos', who: 'Other', creatorAddress: OTHER, direction: 'i_owe', createdAt: CREATED };

  beforeEach(async () => {
    await PromiseService.deleteAllPromises();
    vi.clearAllMocks();
    relay.getUid.mockReturnValue(ME);
    relay.tryPublishAcceptance.mockResolvedValue('published');
    vi.mocked(decryptTermsFromSelf).mockResolvedValue(myTerms as never);
  });

  it('restore: the counter waits on this party, and its terms are flagged as not yet here', async () => {
    // The counter's link, made on "the other phone" (terms that hash to D2).
    await PromiseService.updatePromise({
      id: 'p-restore', theyGave: 'Bread', theyOwe: '12 pesos', who: 'Me', direction: 'owed_to_me', status: 'countered',
      createdAt: CREATED, updatedAt: CREATED, creatorAddress: OTHER, creatorSignature: `sig:counter:${D2}`, events: [], digest: D2,
    } as PromiseRecord);
    const counterLink = await linkOf('p-restore');
    await PromiseService.deleteAllPromises();

    relay.listMine.mockResolvedValue({ myAddress: ME, promises: [countered()] });
    expect(await PromiseService.restoreFromRelay()).toBe(1);
    const restored = (await PromiseService.getPromise('p-restore'))!;
    expect(restored).toMatchObject({ theyOwe: '10 pesos', counterFromCounterparty: true, counterTermsPending: true, counterDigestPending: D2 });
    expect(counterOfferView(restored)?.kind).toBe('awaiting_terms'); // RED before the fix: 'mine'
    await expect(PromiseService.acceptCounterOffer('p-restore', ME)).rejects.toThrow(/new link/);

    // The next sync keeps it flagged; the counter's link then brings the terms, and it can be accepted.
    PromiseService.subscribeToUpdates('p-restore', () => undefined);
    await subscribed.cb!(countered());
    expect(counterOfferView((await PromiseService.getPromise('p-restore'))!)?.kind).toBe('awaiting_terms');
    await PromiseService.importPromiseFromShareLink(counterLink.d, counterLink.k, ME);
    expect(counterOfferView((await PromiseService.getPromise('p-restore'))!)?.kind).toBe('answer');
    const accepted = await PromiseService.acceptCounterOffer('p-restore', ME);
    expect(accepted).toMatchObject({ status: 'accepted', theyOwe: '12 pesos', counterpartySignature: `sig:accept:${D2}` });
  });

  it('restore of this party\'s OWN counter (review r2): it waits on the other party; nothing to accept', async () => {
    vi.mocked(decryptTermsFromSelf).mockResolvedValue({ ...myTerms, theyOwe: '12 pesos' } as never);
    relay.listMine.mockResolvedValue({ myAddress: ME, promises: [countered({
      signatures: {
        [ME]: { role: 'acceptor', signature: `sig:counter:${D2}`, at: 2, signedDigest: D2, termsCiphertext: 'ct' },
        [OTHER.toLowerCase()]: { role: 'creator', signature: `sig:create:${D1}`, at: 1, signedDigest: D1 },
      },
    })] });
    expect(await PromiseService.restoreFromRelay()).toBe(1);
    const restored = (await PromiseService.getPromise('p-restore'))!;
    expect(restored.counterFromCounterparty).toBe(false);
    expect(restored.counterTermsPending).toBeFalsy();
    expect(counterOfferView(restored)?.kind).toBe('mine');
    await expect(PromiseService.acceptCounterOffer('p-restore', ME)).rejects.toThrow(/no counter-offer from the other party/);
  });

  it('RED before the fix: reconcile flagged nothing for a record holding the counter\'s digest beside older terms', async () => {
    await PromiseService.updatePromise({
      id: 'p-restore', theyGave: 'Bread', theyOwe: '10 pesos', who: 'Other', direction: 'i_owe', status: 'countered',
      createdAt: CREATED, updatedAt: CREATED, creatorAddress: OTHER, events: [], digest: D2, relayBacked: true,
    } as PromiseRecord);
    PromiseService.subscribeToUpdates('p-restore', () => undefined);
    await subscribed.cb!(countered());
    const after = (await PromiseService.getPromise('p-restore'))!;
    expect(after).toMatchObject({ counterTermsPending: true, counterDigestPending: D2, counterFromCounterparty: true });
    expect(counterOfferView(after)?.kind).toBe('awaiting_terms');
  });

  it('RED: accept never signs a digest the shown terms do not make', async () => {
    await PromiseService.updatePromise({
      id: 'p-restore', theyGave: 'Bread', theyOwe: '10 pesos', who: 'Other', direction: 'i_owe', status: 'countered',
      createdAt: CREATED, updatedAt: CREATED, creatorAddress: OTHER, events: [], digest: D2,
      counterFromCounterparty: true, counterTermsPending: false,
    } as PromiseRecord);
    await expect(PromiseService.acceptCounterOffer('p-restore', ME)).rejects.toThrow(/do not match/);
    expect(signHumanPromisePhase).not.toHaveBeenCalled();
    expect(relay.tryPublishAcceptance).not.toHaveBeenCalled();
  });
});

// Found by the two-simulator proof against the deployed relay (2026-10-17).
describe('two-sim findings: the creator opens a counter it has not synced yet', () => {
  beforeEach(async () => {
    await PromiseService.deleteAllPromises();
    vi.clearAllMocks();
    relay.getUid.mockReturnValue(ME);
    relay.publishPromiseCountered.mockResolvedValue(true);
    relay.checkPromiseStatusDetailed.mockResolvedValue({ kind: 'unavailable' });
  });

  /** The creator's phone as it is when the counter's link arrives: still `pending`, nothing flagged. */
  async function creatorBeforeAnyPoll() {
    const created = await PromiseService.createPromise({
      theyGave: 'Tamales', theyOwe: '50 pesos', who: 'Bob', direction: 'owed_to_me', creatorAddress: ME, creatorName: 'Alice',
    });
    const mine = JSON.parse(JSON.stringify(await PromiseService.getPromise(created.id)));
    await PromiseService.counterPromise(created.id, OTHER, { theyGave: 'Tamales', theyOwe: '50 pesos and a soda' });
    const counterLink = await linkOf(created.id);
    const originalLink = { ...counterLink };
    await PromiseService.deleteAllPromises();
    await PromiseService.updatePromise(mine);
    const doc = remote(created.id, created.createdAt, {
      digest: 'digest:Tamales:50 pesos and a soda',
      signatures: {
        [ME]: { role: 'creator', signature: 'sig:create', at: 1, signedDigest: 'digest:Tamales:50 pesos' },
        [OTHER.toLowerCase()]: { role: 'acceptor', signature: 'sig:counter:digest:Tamales:50 pesos and a soda', at: 2, signedDigest: 'digest:Tamales:50 pesos and a soda' },
      },
    });
    return { created, counterLink, originalLink, doc };
  }

  it('RED before the fix: the counter\'s link was dropped because it arrived before the relay poll', async () => {
    const { created, counterLink, doc } = await creatorBeforeAnyPoll();
    expect((await PromiseService.getPromise(created.id))?.status).toBe('pending');
    relay.checkPromiseStatusDetailed.mockResolvedValue({ kind: 'found', doc });
    await PromiseService.importPromiseFromShareLink(counterLink.d, counterLink.k, ME);
    const after = (await PromiseService.getPromise(created.id))!;
    expect(relay.checkPromiseStatusDetailed).toHaveBeenCalledWith(created.id);
    expect(after).toMatchObject({ status: 'countered', theyOwe: '50 pesos and a soda', digest: 'digest:Tamales:50 pesos and a soda', counterTermsPending: false, counterFromCounterparty: true });
    expect(counterOfferView(after)?.kind).toBe('answer');
  });

  it('RED: terms that do not make the relay\'s counter digest are never adopted, even after the relay read', async () => {
    const { created, counterLink, doc } = await creatorBeforeAnyPoll();
    relay.checkPromiseStatusDetailed.mockResolvedValue({ kind: 'found', doc: { ...doc, digest: 'digest:Tamales:70 pesos' } });
    await PromiseService.importPromiseFromShareLink(counterLink.d, counterLink.k, ME);
    const after = (await PromiseService.getPromise(created.id))!;
    expect(after).toMatchObject({ status: 'countered', theyOwe: '50 pesos', counterTermsPending: true, counterDigestPending: 'digest:Tamales:70 pesos' });
    expect(counterOfferView(after)?.kind).toBe('awaiting_terms');
  });

  it('a relay that cannot be read leaves the record as it was', async () => {
    const { created, counterLink } = await creatorBeforeAnyPoll();
    await PromiseService.importPromiseFromShareLink(counterLink.d, counterLink.k, ME);
    expect(await PromiseService.getPromise(created.id)).toMatchObject({ status: 'pending', theyOwe: '50 pesos' });
  });

  it('re-opening a code with the terms this record already holds asks the relay nothing', async () => {
    const created = await PromiseService.createPromise({
      theyGave: 'Bread', theyOwe: '10 pesos', who: 'Bob', direction: 'owed_to_me', creatorAddress: ME, creatorName: 'Alice',
    });
    const link = await linkOf(created.id);
    await PromiseService.importPromiseFromShareLink(link.d, link.k, ME);
    expect(relay.checkPromiseStatusDetailed).not.toHaveBeenCalled();
  });
});

describe('two-sim findings: every status is listed on one tab', () => {
  it('RED before the fix: a countered promise was on neither tab', () => {
    const statuses = Object.keys(VALID_TRANSITIONS) as PromiseStatus[];
    expect(statuses.length).toBe(9); // a pass over an empty set proves nothing
    for (const status of statuses) {
      expect(Number(ACTIVE_LIST_STATUSES.has(status)) + Number(HISTORY_LIST_STATUSES.has(status))).toBe(1);
    }
    expect(ACTIVE_LIST_STATUSES.has('countered')).toBe(true);
    expect(HISTORY_LIST_STATUSES.has('rejected')).toBe(true);
  });

  it('the list reads go through those sets', async () => {
    await PromiseService.deleteAllPromises();
    for (const status of ['countered', 'rejected', 'pending', 'fulfilled'] as PromiseStatus[]) {
      await PromiseService.updatePromise({
        id: `p-${status}`, theyGave: 'a', theyOwe: 'b', who: 'x', direction: 'i_owe', status,
        createdAt: 1, updatedAt: 1, creatorAddress: OTHER, events: [],
      } as PromiseRecord);
    }
    expect((await PromiseService.getActivePromises()).map((p) => p.status).sort()).toEqual(['countered', 'pending']);
    expect((await PromiseService.getCompletedPromises()).map((p) => p.status).sort()).toEqual(['fulfilled', 'rejected']);
  });
});

describe('two-sim findings: an agreement over a counter holds both signatures over the agreed terms', () => {
  beforeEach(async () => {
    await PromiseService.deleteAllPromises();
    vi.clearAllMocks();
    relay.getUid.mockReturnValue(ME);
    relay.tryPublishAcceptance.mockResolvedValue('published');
  });

  it('RED before the fix: the acceptor kept the creator\'s signature over the original terms', async () => {
    // ME is the recipient; OTHER created, then countered back; ME accepts that counter.
    const D2 = 'digest:Bread:12 pesos';
    await PromiseService.updatePromise({
      id: 'p-agree', theyGave: 'Bread', theyOwe: '12 pesos', who: 'Other', direction: 'owed_to_me', status: 'countered',
      createdAt: 5, updatedAt: 5, creatorAddress: OTHER, events: [], digest: D2,
      creatorSignature: 'sig:create:digest:Bread:10 pesos', counterFromCounterparty: true, counterTermsPending: false,
    } as PromiseRecord);
    await PromiseService.acceptCounterOffer('p-agree', ME);
    PromiseService.subscribeToUpdates('p-agree', () => undefined);
    await subscribed.cb!(remote('p-agree', 5, {
      creatorUid: OTHER.toLowerCase(), acceptorUid: ME, status: 'accepted', digest: D2,
      signatures: {
        [OTHER.toLowerCase()]: { role: 'creator', signature: `sig:counter:${D2}`, at: 3, signedDigest: D2 },
        [ME]: { role: 'acceptor', signature: `sig:accept:${D2}`, at: 4, signedDigest: D2 },
      },
    }));
    expect(await PromiseService.getPromise('p-agree')).toMatchObject({
      status: 'accepted', digest: D2, creatorSignature: `sig:counter:${D2}`, counterpartySignature: `sig:accept:${D2}`,
    });
  });

  it('RED: a relay signature over a different digest is never taken', async () => {
    const D2 = 'digest:Bread:12 pesos';
    await PromiseService.updatePromise({
      id: 'p-agree2', theyGave: 'Bread', theyOwe: '12 pesos', who: 'Other', direction: 'owed_to_me', status: 'accepted',
      createdAt: 5, updatedAt: 5, creatorAddress: OTHER, events: [], digest: D2,
      creatorSignature: 'sig:mine', counterpartySignature: `sig:accept:${D2}`,
    } as PromiseRecord);
    PromiseService.subscribeToUpdates('p-agree2', () => undefined);
    await subscribed.cb!(remote('p-agree2', 5, {
      creatorUid: OTHER.toLowerCase(), acceptorUid: ME, status: 'accepted', digest: D2,
      signatures: { [OTHER.toLowerCase()]: { role: 'creator', signature: 'sig:old', at: 3, signedDigest: 'digest:Bread:10 pesos' } },
    }));
    expect((await PromiseService.getPromise('p-agree2'))?.creatorSignature).toBe('sig:mine');
  });
});
