/**
 * Operator announcements + broadcast — security gate and fan-out targeting.
 *
 * The load-bearing claim is the OPERATOR GATE: only a wallet whose resolved
 * on-chain address is in OPERATOR_COMMONS_WALLETS may post to the announcements
 * channel or broadcast. Per the project's negative-control doctrine, every
 * assertion here is paired with its failing control:
 *  - the gate is exercised against a NON-operator (must refuse) — so a
 *    hardwired-open gate would fail this suite, not pass it;
 *  - the gate is exercised with the allowlist UNSET (fail-closed) — so even the
 *    real operator address is refused when nothing is configured;
 *  - the broadcast opt-out filter is exercised against BOTH an opted-out user
 *    (must skip) AND an opted-in user (must send) — so a filter that skipped
 *    everyone (the vacuous pass) would fail the "must send" half.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
  isOperatorCommonsWallet,
  createOperatorAnnouncement,
  broadcastAnnouncementPush,
  ANNOUNCEMENTS_CHANNEL,
} from './announcements';
import { createPost as createPostRaw } from './forum';
import { TEST_WINDOW, actorOf } from './__test-helpers__/speech';
const createPost = (deps: Parameters<typeof createPostRaw>[0], w: string, a: string, addr: string | null, body: Parameters<typeof createPostRaw>[2]) => createPostRaw(deps, actorOf(w, a, addr), body, TEST_WINDOW);
import { COMMONS_COLLECTIONS } from './types';
import type { CommonsDeps, CommonsForumPost } from './types';
import { ForbiddenError } from '../agent-bank/errors';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';

const DAY = 24 * 60 * 60 * 1000;
const OPERATOR_ADDR = '0xCa37a15A64213b2ACD1784ae3f8e6Cbd4600D9D3';
const NON_OP_ADDR = '0xdEAD0000000000000000000000000000BEEF0001';
const OP_WALLET = 'user_operator_1'; // wallet id (a user_id for a human) — NOT the address
const NON_OP_WALLET = 'user_regular_1';

function makeDeps(db: FakeFirestore): CommonsDeps {
  return {
    db,
    cache: { checkRateLimit: async () => ({ allowed: true, retryAfter: 0 }) },
    peBuffer: { enqueue: () => {} },
    recordPEAccrual: async () => {},
  } as unknown as CommonsDeps;
}

function seedChannels(db: FakeFirestore): void {
  db.store.set(`${COMMONS_COLLECTIONS.FORUM_CHANNELS}/${ANNOUNCEMENTS_CHANNEL}`, { channel_id: ANNOUNCEMENTS_CHANNEL });
  db.store.set(`${COMMONS_COLLECTIONS.FORUM_CHANNELS}/general`, { channel_id: 'general' });
}

function seedProfile(db: FakeFirestore, walletId: string, participant_type: 'human' | 'agent' = 'human'): void {
  db.store.set(`${COMMONS_COLLECTIONS.PROFILES}/${walletId}`, {
    status: 'active',
    commons_join_date: Date.now() - 40 * DAY, // established → no new-account daily cap
    pe_count: 100,
    participant_type,
  });
}

const ORIGINAL_ENV = process.env.OPERATOR_COMMONS_WALLETS;
afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.OPERATOR_COMMONS_WALLETS;
  else process.env.OPERATOR_COMMONS_WALLETS = ORIGINAL_ENV;
});

describe('isOperatorCommonsWallet — fail-closed allowlist', () => {
  it('CONTROL: with the allowlist UNSET, even the operator address is NOT an operator', () => {
    delete process.env.OPERATOR_COMMONS_WALLETS;
    expect(isOperatorCommonsWallet(OPERATOR_ADDR)).toBe(false);
  });

  it('recognizes an allowlisted address, case-insensitively', () => {
    process.env.OPERATOR_COMMONS_WALLETS = OPERATOR_ADDR.toLowerCase();
    expect(isOperatorCommonsWallet(OPERATOR_ADDR)).toBe(true); // mixed-case input
    expect(isOperatorCommonsWallet(OPERATOR_ADDR.toUpperCase())).toBe(true);
  });

  it('refuses a non-allowlisted address, and null/empty', () => {
    process.env.OPERATOR_COMMONS_WALLETS = OPERATOR_ADDR;
    expect(isOperatorCommonsWallet(NON_OP_ADDR)).toBe(false);
    expect(isOperatorCommonsWallet(null)).toBe(false);
    expect(isOperatorCommonsWallet('')).toBe(false);
  });
});

describe('createOperatorAnnouncement — operator gate', () => {
  beforeEach(() => {
    process.env.OPERATOR_COMMONS_WALLETS = OPERATOR_ADDR;
  });

  it('operator creates a PINNED post in the announcements channel', async () => {
    const db = createFakeFirestore();
    seedChannels(db);
    seedProfile(db, OP_WALLET);

    const post = await createOperatorAnnouncement(
      makeDeps(db),
      { walletId: OP_WALLET, agentId: OP_WALLET, actorAddress: OPERATOR_ADDR },
      { title: 'Launch is near', content: 'Welcome to the Commons.' },
      TEST_WINDOW,
    );

    expect(post.channel).toBe(ANNOUNCEMENTS_CHANNEL);
    expect(post.is_pinned).toBe(true);
    const stored = db.store.get(`${COMMONS_COLLECTIONS.FORUM_POSTS}/${post.post_id}`) as unknown as CommonsForumPost;
    expect(stored.is_pinned).toBe(true);
    expect(stored.channel).toBe(ANNOUNCEMENTS_CHANNEL);
  });

  it('NEGATIVE CONTROL: a non-operator address is refused', async () => {
    const db = createFakeFirestore();
    seedChannels(db);
    seedProfile(db, NON_OP_WALLET);

    await expect(
      createOperatorAnnouncement(
        makeDeps(db),
        { walletId: NON_OP_WALLET, agentId: NON_OP_WALLET, actorAddress: NON_OP_ADDR },
        { content: 'fake announcement' },
        TEST_WINDOW,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // ...and nothing was written.
    const posts = [...db.store.keys()].filter((k) => k.startsWith(`${COMMONS_COLLECTIONS.FORUM_POSTS}/`));
    expect(posts).toHaveLength(0);
  });

  it('CONTROL: with the allowlist unset, even the operator address is refused', async () => {
    delete process.env.OPERATOR_COMMONS_WALLETS;
    const db = createFakeFirestore();
    seedChannels(db);
    seedProfile(db, OP_WALLET);
    await expect(
      createOperatorAnnouncement(
        makeDeps(db),
        { walletId: OP_WALLET, agentId: OP_WALLET, actorAddress: OPERATOR_ADDR },
        { content: 'hi' },
        TEST_WINDOW,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('createPost — announcements channel is operator-write / everyone-reply', () => {
  beforeEach(() => {
    process.env.OPERATOR_COMMONS_WALLETS = OPERATOR_ADDR;
  });

  it('NEGATIVE CONTROL: a non-operator top-level post to announcements is refused', async () => {
    const db = createFakeFirestore();
    seedChannels(db);
    seedProfile(db, NON_OP_WALLET);
    await expect(
      createPost(makeDeps(db), NON_OP_WALLET, NON_OP_WALLET, NON_OP_ADDR, {
        channel: ANNOUNCEMENTS_CHANNEL,
        content: 'not allowed',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('the operator CAN post top-level to announcements (same path, allowlisted address)', async () => {
    const db = createFakeFirestore();
    seedChannels(db);
    seedProfile(db, OP_WALLET);
    const post = await createPost(makeDeps(db), OP_WALLET, OP_WALLET, OPERATOR_ADDR, {
      channel: ANNOUNCEMENTS_CHANNEL,
      content: 'official',
    });
    expect(post.channel).toBe(ANNOUNCEMENTS_CHANNEL);
  });

  it('anyone may REPLY under an announcement (two-way discussion)', async () => {
    const db = createFakeFirestore();
    seedChannels(db);
    seedProfile(db, OP_WALLET);
    seedProfile(db, NON_OP_WALLET);
    const announcement = await createPost(makeDeps(db), OP_WALLET, OP_WALLET, OPERATOR_ADDR, {
      channel: ANNOUNCEMENTS_CHANNEL,
      content: 'official',
    });
    const reply = await createPost(makeDeps(db), NON_OP_WALLET, NON_OP_WALLET, NON_OP_ADDR, {
      channel: ANNOUNCEMENTS_CHANNEL,
      content: 'a citizen replies',
      parent_post_id: announcement.post_id,
    });
    expect(reply.parent_post_id).toBe(announcement.post_id);
  });
});

describe('broadcastAnnouncementPush — opt-out targeting (default ON)', () => {
  function seedUser(db: FakeFirestore, id: string, tokens: string[], announcements?: boolean): void {
    db.store.set(`users/${id}`, { fcm_tokens: tokens });
    if (announcements !== undefined) {
      db.store.set(`user_preferences/${id}`, { notifications: { announcements } });
    }
  }

  const makeSendPush = () =>
    jest.fn(async (tokens: string[]) => ({
      successCount: tokens.length,
      failureCount: 0,
      invalidTokens: [] as string[],
      expoCount: tokens.length,
      fcmCount: 0,
    }));

  // The strict firebase-admin Firestore type is structurally huge; the fake
  // implements only the slice broadcastAnnouncementPush touches (collection /
  // orderBy / limit / startAfter / doc / get), so cast at the boundary — the
  // same pattern makeDeps uses for CommonsDeps.
  const bdeps = (db: FakeFirestore, sendPush: unknown, pruneUserTokens: unknown) =>
    ({
      db: db as unknown as FirebaseFirestore.Firestore,
      sendPush: sendPush as never,
      pruneUserTokens: pruneUserTokens as never,
      log: () => {},
    });

  it('sends to opted-in / default users and SKIPS opted-out and token-less users', async () => {
    const db = createFakeFirestore();
    seedUser(db, 'u_default', ['tok_default']); // no pref → default ON → send
    seedUser(db, 'u_optedin', ['tok_optedin'], true); // explicit ON → send
    seedUser(db, 'u_optedout', ['tok_optedout'], false); // explicit OFF → skip
    seedUser(db, 'u_notokens', []); // no tokens → skip

    const sendPush = makeSendPush();
    const pruneUserTokens = jest.fn(async () => {});

    const result = await broadcastAnnouncementPush(
      bdeps(db, sendPush, pruneUserTokens),
      { postId: 'post_abc', title: 'Hello', body: 'body' },
    );

    expect(result.usersScanned).toBe(4);
    expect(result.usersPushed).toBe(2); // default + optedin
    expect(result.usersOptedOut).toBe(1);
    expect(result.usersWithoutTokens).toBe(1);
    expect(result.pushSuccess).toBe(2);

    // The opted-in / default users WERE pushed...
    expect(sendPush).toHaveBeenCalledWith(['tok_default'], expect.objectContaining({
      data: expect.objectContaining({ type: 'commons_announcement', postId: 'post_abc' }),
    }));
    expect(sendPush).toHaveBeenCalledWith(['tok_optedin'], expect.anything());
    // ...and the opted-out user was NOT (the discriminating half of the control).
    expect(sendPush).not.toHaveBeenCalledWith(['tok_optedout'], expect.anything());
    expect(sendPush).toHaveBeenCalledTimes(2);
  });

  it('CONTROL: flipping the opted-out user to ON makes it receive the push', async () => {
    const db = createFakeFirestore();
    seedUser(db, 'u_flip', ['tok_flip'], true); // was OFF in the case above; ON here
    const sendPush = makeSendPush();
    const pruneUserTokens = jest.fn(async () => {});

    const result = await broadcastAnnouncementPush(
      bdeps(db, sendPush, pruneUserTokens),
      { postId: 'post_xyz', title: 'Hello', body: 'body' },
    );

    expect(result.usersPushed).toBe(1);
    expect(sendPush).toHaveBeenCalledWith(['tok_flip'], expect.anything());
  });

  it('prunes invalid tokens returned by the transport', async () => {
    const db = createFakeFirestore();
    seedUser(db, 'u1', ['good', 'bad']);
    const sendPush = jest.fn(async () => ({
      successCount: 1,
      failureCount: 1,
      invalidTokens: ['bad'],
      expoCount: 2,
      fcmCount: 0,
    }));
    const pruneUserTokens = jest.fn(async () => {});

    const result = await broadcastAnnouncementPush(
      bdeps(db, sendPush, pruneUserTokens),
      { postId: 'p', title: 't', body: 'b' },
    );

    expect(pruneUserTokens).toHaveBeenCalledWith(db, 'u1', ['bad']);
    expect(result.tokensPruned).toBe(1);
  });
});
