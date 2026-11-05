/**
 * the human P2P promise relay state machine.
 *
 * Exercises every transition and the invariants that the retired
 * firestore.rules:100-144 enforced, now server-side: a transition is authorized
 * only by a PARTY's wallet; real EIP-191 signatures over the digest for the
 * agreement phases; no unilateral close (both close-out signatures required);
 * terminal states terminal. Signatures are REAL (ethers wallets), so the
 * verification arm is never mocked.
 *
 * The negative controls the operator named are here by name (see the RED-* cases).
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import { ethers } from 'ethers';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import type { Firestore } from 'firebase-admin/firestore';
import {
  createHumanPromise,
  acceptHumanPromise,
  counterHumanPromise,
  rejectHumanPromise,
  closeOutHumanPromise,
  disputeHumanPromise,
  brokenHumanPromise,
  getHumanPromise,
  listMyHumanPromises,
  type HumanPromiseCaller,
} from './human-promises';
import { humanPromiseSignMessage } from './promise-signing';
import { HUMAN_PROMISES_COLLECTION, HUMAN_PROMISE_TTL_MS, type HumanPromiseDocument } from './types';
import { ValidationError, NotFoundError, ForbiddenError } from '../agent-bank/errors';

const PROMISE = '11111111-1111-4111-8111-111111111111';
const DIGEST = 'a'.repeat(64);
const DIGEST2 = 'b'.repeat(64);

const WALLET_CREATOR = new ethers.Wallet(`0x${'11'.repeat(32)}`);
const WALLET_ACCEPTOR = new ethers.Wallet(`0x${'22'.repeat(32)}`);
const WALLET_STRANGER = new ethers.Wallet(`0x${'33'.repeat(32)}`);

const CREATOR: HumanPromiseCaller = { userId: 'user_creator', address: WALLET_CREATOR.address.toLowerCase() };
const ACCEPTOR: HumanPromiseCaller = { userId: 'user_acceptor', address: WALLET_ACCEPTOR.address.toLowerCase() };
const STRANGER: HumanPromiseCaller = { userId: 'user_stranger', address: WALLET_STRANGER.address.toLowerCase() };

function sign(wallet: ethers.Wallet, phase: 'create' | 'accept' | 'counter' | 'closeout', digest: string): Promise<string> {
  return wallet.signMessage(humanPromiseSignMessage(phase, PROMISE, digest));
}

let fs: FakeFirestore;
const db = (): Firestore => fs as unknown as Firestore;
function readStored(): HumanPromiseDocument | undefined {
  return fs.store.get(`${HUMAN_PROMISES_COLLECTION}/${PROMISE}`) as HumanPromiseDocument | undefined;
}

beforeEach(() => {
  fs = createFakeFirestore({ strictTransactionOrder: true });
});

async function seedCreated(): Promise<void> {
  await createHumanPromise(db(), CREATOR, {
    promiseId: PROMISE,
    digest: DIGEST,
    signature: await sign(WALLET_CREATOR, 'create', DIGEST),
    termsCiphertext: 'creator-ct',
  });
}

async function seedAccepted(): Promise<void> {
  await seedCreated();
  await acceptHumanPromise(db(), ACCEPTOR, {
    promiseId: PROMISE,
    digest: DIGEST,
    signature: await sign(WALLET_ACCEPTOR, 'accept', DIGEST),
    termsCiphertext: 'acceptor-ct',
  });
}

describe('human promise — the happy path (non-vacuity for the RED controls)', () => {
  it('create → accept → close-out (both) → fulfilled', async () => {
    await seedAccepted();
    expect(readStored()?.status).toBe('accepted');

    // First party closes out → awaiting the counterparty (NOT fulfilled).
    const r1 = await closeOutHumanPromise(db(), CREATOR, { promiseId: PROMISE, signature: await sign(WALLET_CREATOR, 'closeout', DIGEST) });
    expect(r1.mode).toBe('awaiting_counterparty');
    expect(readStored()?.status).toBe('accepted');

    // Second party closes out → fulfilled, both signatures present.
    const r2 = await closeOutHumanPromise(db(), ACCEPTOR, { promiseId: PROMISE, signature: await sign(WALLET_ACCEPTOR, 'closeout', DIGEST) });
    expect(r2.mode).toBe('fulfilled');
    const doc = readStored()!;
    expect(doc.status).toBe('fulfilled');
    expect(Object.keys(doc.closeout).sort()).toEqual([ACCEPTOR.address, CREATOR.address].sort());
    // Both parties hold their own opaque terms ciphertext.
    expect(doc.parties[CREATOR.address].terms_ciphertext).toBe('creator-ct');
    expect(doc.parties[ACCEPTOR.address].terms_ciphertext).toBe('acceptor-ct');
  });

  it('fulfillment RESETS the 30-day expiry from the close (earning-witness survives promotion); a single close-out does NOT', async () => {
    await seedAccepted();
    // Simulate an about-to-purge promise: force a stale (near-expired) expiry so
    // the "reset from close" is discriminating (not swamped by created_at ≈ now).
    const STALE = 1000;
    const seeded = readStored()!;
    fs.store.set(`${HUMAN_PROMISES_COLLECTION}/${PROMISE}`, { ...seeded, expires_at: STALE });

    // First close-out → awaiting: the record is NOT yet the fulfilled witness, so
    // its expiry must be left ALONE (RED discriminator — the reset is gated on
    // BOTH signatures, not on any close-out write).
    await closeOutHumanPromise(db(), CREATOR, { promiseId: PROMISE, signature: await sign(WALLET_CREATOR, 'closeout', DIGEST) });
    expect(readStored()!.expires_at).toBe(STALE);

    // Second close-out → fulfilled: expiry reset to ~now + TTL so the pending-
    // evidence resolver cannot be raced by the purge sweep.
    const before = Date.now();
    await closeOutHumanPromise(db(), ACCEPTOR, { promiseId: PROMISE, signature: await sign(WALLET_ACCEPTOR, 'closeout', DIGEST) });
    const doc = readStored()!;
    expect(doc.status).toBe('fulfilled');
    expect(doc.expires_at).toBeGreaterThan(STALE);
    expect(doc.expires_at).toBeGreaterThanOrEqual(before + HUMAN_PROMISE_TTL_MS - 1000);
    expect(doc.expires_at).toBeLessThanOrEqual(Date.now() + HUMAN_PROMISE_TTL_MS + 1000);
  });

  it('acceptance RESETS the 30-day expiry from the accept (RED: it kept the creation clock and purged an active promise)', async () => {
    await seedCreated();
    const STALE = 1000;
    const seeded = readStored()!;
    fs.store.set(`${HUMAN_PROMISES_COLLECTION}/${PROMISE}`, { ...seeded, expires_at: STALE });
    const before = Date.now();
    await acceptHumanPromise(db(), ACCEPTOR, {
      promiseId: PROMISE, digest: DIGEST, signature: await sign(WALLET_ACCEPTOR, 'accept', DIGEST), termsCiphertext: 'acceptor-ct',
    });
    const doc = readStored()!;
    expect(doc.status).toBe('accepted');
    expect(doc.expires_at).toBeGreaterThanOrEqual(before + HUMAN_PROMISE_TTL_MS - 1000);
    expect(doc.expires_at).toBeLessThanOrEqual(Date.now() + HUMAN_PROMISE_TTL_MS + 1000);
  });

  it('counter → countered, then the creator accepts the counter → accepted', async () => {
    await seedCreated();
    // The recipient counters with new terms (new digest).
    await counterHumanPromise(db(), ACCEPTOR, {
      promiseId: PROMISE,
      digest: DIGEST2,
      signature: await sign(WALLET_ACCEPTOR, 'counter', DIGEST2),
      termsCiphertext: 'acceptor-counter-ct',
    });
    let doc = readStored()!;
    expect(doc.status).toBe('countered');
    expect(doc.digest).toBe(DIGEST2);
    expect(doc.acceptor_address).toBe(ACCEPTOR.address);

    // The creator accepts the countered terms (signs the NEW digest).
    await acceptHumanPromise(db(), CREATOR, {
      promiseId: PROMISE,
      digest: DIGEST2,
      signature: await sign(WALLET_CREATOR, 'accept', DIGEST2),
      termsCiphertext: 'creator-counter-ct',
    });
    doc = readStored()!;
    expect(doc.status).toBe('accepted');
  });

  it('reject → rejected (terminal); dispute → disputed; broken → broken', async () => {
    // reject on a fresh promise
    await seedCreated();
    await rejectHumanPromise(db(), ACCEPTOR, PROMISE);
    expect(readStored()?.status).toBe('rejected');

    // dispute + broken need a fresh accepted promise
    fs = createFakeFirestore({ strictTransactionOrder: true });
    await seedAccepted();
    await disputeHumanPromise(db(), CREATOR, PROMISE);
    expect(readStored()?.status).toBe('disputed');
    await brokenHumanPromise(db(), ACCEPTOR, PROMISE);
    expect(readStored()?.status).toBe('broken');
  });

  it('lists a caller\'s promises as creator and as acceptor', async () => {
    await seedAccepted();
    const asCreator = await listMyHumanPromises(db(), CREATOR);
    const asAcceptor = await listMyHumanPromises(db(), ACCEPTOR);
    expect(asCreator.map((p) => p.promise_id)).toContain(PROMISE);
    expect(asAcceptor.map((p) => p.promise_id)).toContain(PROMISE);
  });
});

describe('human promise — RED negative controls (the operator’s named set)', () => {
  it('RED — a NON-PARTY wallet cannot transition a promise (dispute / broken / close-out)', async () => {
    await seedAccepted();
    await expect(disputeHumanPromise(db(), STRANGER, PROMISE)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(brokenHumanPromise(db(), STRANGER, PROMISE)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      closeOutHumanPromise(db(), STRANGER, { promiseId: PROMISE, signature: await sign(WALLET_STRANGER, 'closeout', DIGEST) }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // Non-vacuity: a genuine party CAN dispute.
    await expect(disputeHumanPromise(db(), CREATOR, PROMISE)).resolves.toBeDefined();
  });

  it('RED — a BAD signature is refused (create + accept)', async () => {
    // create: signature over a DIFFERENT digest than the one submitted.
    await expect(createHumanPromise(db(), CREATOR, {
      promiseId: PROMISE, digest: DIGEST,
      signature: await sign(WALLET_CREATOR, 'create', DIGEST2), // signs DIGEST2, submits DIGEST
      termsCiphertext: 'x',
    })).rejects.toBeInstanceOf(ValidationError);
    // Non-vacuity: a correct create succeeds.
    await seedCreated();
    // accept: signature by the WRONG wallet (stranger's key, but claiming acceptor).
    await expect(acceptHumanPromise(db(), ACCEPTOR, {
      promiseId: PROMISE, digest: DIGEST,
      signature: await sign(WALLET_STRANGER, 'accept', DIGEST), // recovers to stranger, not acceptor
      termsCiphertext: 'x',
    })).rejects.toBeInstanceOf(ValidationError);
  });

  it('RED — close-out requires BOTH signatures; one party alone does NOT fulfill', async () => {
    await seedAccepted();
    const r = await closeOutHumanPromise(db(), CREATOR, { promiseId: PROMISE, signature: await sign(WALLET_CREATOR, 'closeout', DIGEST) });
    expect(r.mode).toBe('awaiting_counterparty');
    expect(readStored()?.status).not.toBe('fulfilled');
  });

  it('RED — a stranger cannot displace an established acceptor (two-party cap)', async () => {
    // The recipient counters (becomes the acceptor of record) while the promise
    // is still in a counterable state; a stranger then tries to accept it.
    await seedCreated();
    await counterHumanPromise(db(), ACCEPTOR, {
      promiseId: PROMISE, digest: DIGEST2,
      signature: await sign(WALLET_ACCEPTOR, 'counter', DIGEST2),
      termsCiphertext: 'acceptor-counter-ct',
    });
    expect(readStored()?.acceptor_address).toBe(ACCEPTOR.address);
    // A stranger cannot displace the established acceptor on the countered promise.
    await expect(acceptHumanPromise(db(), STRANGER, {
      promiseId: PROMISE, digest: DIGEST2,
      signature: await sign(WALLET_STRANGER, 'accept', DIGEST2),
      termsCiphertext: 'x',
    })).rejects.toBeInstanceOf(ForbiddenError);
    // And a stranger cannot counter it either.
    await expect(counterHumanPromise(db(), STRANGER, {
      promiseId: PROMISE, digest: 'c'.repeat(64),
      signature: await sign(WALLET_STRANGER, 'counter', 'c'.repeat(64)),
      termsCiphertext: 'x',
    })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('RED — a terminal promise cannot transition (accept a rejected one)', async () => {
    await seedCreated();
    await rejectHumanPromise(db(), ACCEPTOR, PROMISE);
    await expect(acceptHumanPromise(db(), ACCEPTOR, {
      promiseId: PROMISE, digest: DIGEST,
      signature: await sign(WALLET_ACCEPTOR, 'accept', DIGEST),
      termsCiphertext: 'x',
    })).rejects.toBeInstanceOf(ValidationError);
  });

  it('RED — accept with a digest that does not match the current terms is refused', async () => {
    await seedCreated();
    await expect(acceptHumanPromise(db(), ACCEPTOR, {
      promiseId: PROMISE, digest: DIGEST2, // does not match the stored DIGEST
      signature: await sign(WALLET_ACCEPTOR, 'accept', DIGEST2),
      termsCiphertext: 'x',
    })).rejects.toBeInstanceOf(ValidationError);
  });

  it('RED — a self-accept (acceptor == creator) cannot complete a two-party agreement', async () => {
    await seedCreated();
    await expect(acceptHumanPromise(db(), CREATOR, {
      promiseId: PROMISE, digest: DIGEST,
      signature: await sign(WALLET_CREATOR, 'accept', DIGEST),
      termsCiphertext: 'x',
    })).rejects.toBeInstanceOf(ValidationError);
  });

  it('RED — dispute is invalid from pending (only accepted → disputed)', async () => {
    await seedCreated();
    await expect(disputeHumanPromise(db(), CREATOR, PROMISE)).rejects.toBeInstanceOf(ValidationError);
  });

  it('reads a promise by id (possession is the read capability); missing → NotFound', async () => {
    await seedCreated();
    const doc = await getHumanPromise(db(), PROMISE);
    expect(doc.status).toBe('pending');
    await expect(getHumanPromise(db(), '00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(NotFoundError);
  });
});
