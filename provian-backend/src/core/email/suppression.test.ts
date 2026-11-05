/**
 * Finding 17 — email suppression + one-click unsubscribe tokens.
 *
 * RED negative controls inline: a tampered token, a wrong-secret token, and the
 * unconfigured (secret-unset) fail-closed branch each make the guard REFUSE, so
 * the round-trip test cannot pass vacuously.
 */

import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import type { Firestore } from 'firebase-admin/firestore';
import {
  EMAIL_SUPPRESSION_COLLECTION,
  emailHash,
  isEmailSuppressed,
  isUnsubscribeConfigured,
  normalizeEmail,
  signUnsubscribeToken,
  suppressEmail,
  verifyUnsubscribeToken,
} from './suppression';

const asDb = (db: FakeFirestore): Firestore => db as unknown as Firestore;

describe('unsubscribe token (finding 17)', () => {
  const ORIGINAL = process.env.UNSUBSCRIBE_TOKEN_SECRET;
  beforeEach(() => {
    process.env.UNSUBSCRIBE_TOKEN_SECRET = 'a-sufficiently-long-test-secret-value';
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.UNSUBSCRIBE_TOKEN_SECRET;
    else process.env.UNSUBSCRIBE_TOKEN_SECRET = ORIGINAL;
  });

  it('round-trips: a signed token verifies back to the normalized email', () => {
    const token = signUnsubscribeToken('  User@Example.COM ');
    expect(token).toBeTruthy();
    expect(verifyUnsubscribeToken(token!)).toBe('user@example.com');
  });

  it('RED: a tampered signature does not verify', () => {
    const token = signUnsubscribeToken('user@example.com')!;
    const tampered = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
    expect(verifyUnsubscribeToken(tampered)).toBeNull();
  });

  it('RED: a token minted under a DIFFERENT secret does not verify', () => {
    const token = signUnsubscribeToken('user@example.com')!;
    process.env.UNSUBSCRIBE_TOKEN_SECRET = 'a-completely-different-secret-value';
    expect(verifyUnsubscribeToken(token)).toBeNull();
  });

  it('RED: a swapped payload (someone else\'s email, original sig) does not verify', () => {
    const token = signUnsubscribeToken('victim@example.com')!;
    const sig = token.slice(token.indexOf('.') + 1);
    const forgedPayload = Buffer.from('attacker@example.com', 'utf8').toString('base64url');
    expect(verifyUnsubscribeToken(`${forgedPayload}.${sig}`)).toBeNull();
  });

  it('FAIL CLOSED: with the secret unset, signing and verifying both refuse', () => {
    delete process.env.UNSUBSCRIBE_TOKEN_SECRET;
    expect(isUnsubscribeConfigured()).toBe(false);
    expect(signUnsubscribeToken('user@example.com')).toBeNull();
    expect(verifyUnsubscribeToken('anything.anything')).toBeNull();
  });

  it('FAIL CLOSED: a too-short secret is treated as absent', () => {
    process.env.UNSUBSCRIBE_TOKEN_SECRET = 'short';
    expect(isUnsubscribeConfigured()).toBe(false);
    expect(signUnsubscribeToken('user@example.com')).toBeNull();
  });

  it('both answers are reachable — verify is not a constant', () => {
    const good = signUnsubscribeToken('user@example.com')!;
    const answers = new Set([verifyUnsubscribeToken(good) !== null, verifyUnsubscribeToken('junk') !== null]);
    expect([...answers].sort()).toEqual([false, true]);
  });
});

describe('email suppression store (finding 17)', () => {
  it('hash is stable and case/whitespace-insensitive', () => {
    expect(emailHash(' User@Example.com ')).toBe(emailHash('user@example.com'));
    expect(normalizeEmail(' A@B.com ')).toBe('a@b.com');
  });

  it('suppress then check: a suppressed address reads suppressed, an untouched one does not', async () => {
    const db = createFakeFirestore();
    expect(await isEmailSuppressed(asDb(db), 'user@example.com')).toBe(false); // RED baseline
    await suppressEmail(asDb(db), 'User@Example.com', 'unsubscribe_link');
    expect(await isEmailSuppressed(asDb(db), 'user@example.com')).toBe(true);
    expect(await isEmailSuppressed(asDb(db), 'someone-else@example.com')).toBe(false);
  });

  it('stores only the hash + metadata, never the raw address', async () => {
    const db = createFakeFirestore();
    await suppressEmail(asDb(db), 'secret@example.com', 'list_unsubscribe_post');
    const snap = await db.collection(EMAIL_SUPPRESSION_COLLECTION).get();
    expect(snap.docs).toHaveLength(1);
    const data = snap.docs[0].data() as Record<string, unknown>;
    expect(JSON.stringify(data)).not.toContain('secret@example.com');
    expect(data.email_hash).toBe(emailHash('secret@example.com'));
    expect(data.source).toBe('list_unsubscribe_post');
  });

  it('is idempotent: re-suppressing the same address keeps a single row', async () => {
    const db = createFakeFirestore();
    await suppressEmail(asDb(db), 'user@example.com', 'a');
    await suppressEmail(asDb(db), 'user@example.com', 'b');
    const snap = await db.collection(EMAIL_SUPPRESSION_COLLECTION).get();
    expect(snap.docs).toHaveLength(1);
  });
});
