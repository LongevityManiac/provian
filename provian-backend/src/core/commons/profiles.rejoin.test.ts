/**
 * Wave 4 HIGH-5 tests: leaveCommons + registerForCommons preserve
 * counters across leave/rejoin, closing the audit reproducer where
 * a wallet could wipe forum_post_count / human_jobs_completed by
 * leaving and re-registering.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// Stub generatePE - registerForCommons emits a PE on success, but the
// counter/state preservation we care about is upstream of that call.
jest.mock('../agent-bank/pe-utils', () => ({
  generatePE: async () => ({ peId: 'pe_stub' }),
}));

import { leaveCommons, registerForCommons } from './profiles';
import type { CommonsProfile } from './types';

function buildProfile(overrides: Partial<CommonsProfile> = {}): CommonsProfile {
  const now = Date.now();
  return {
    wallet_id: 'wal_test',
    participant_type: 'human',
    display_name: 'Test',
    attestation_tier: 'software',
    identity_verification_level: 'biometric_enrolled',
    pe_count: 4,
    promise_fulfillment_rate: 1,
    court_record: {
      cases_as_plaintiff: 0, cases_as_defendant: 0, cases_as_arbitrator: 0,
      wins: 0, losses: 0, arbitrations_completed: 0, slashing_events: 0,
    },
    commons_join_date: now,
    first_pe_date: now,
    human_jobs_completed: 7,
    human_jobs_avg_rating: 4.6,
    human_jobs_categories: ['translation'],
    human_jobs_posted: 0,
    human_jobs_avg_human_rating: 0,
    forum_post_count: 12,
    forum_upvotes_received: 30,
    published_pe_count: 5,
    status: 'active',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

interface FakeRef {
  update: jest.Mock;
  set: jest.Mock;
}

interface State {
  profile?: CommonsProfile;
  publishedFlags: Record<string, { profile_inactive?: boolean; profile_left_at?: number; profile_reactivated_at?: number }>;
}

function makeFakeDb(state: State, opts: { walletIsAgent?: boolean } = {}): any {
  const profileRef: FakeRef = {
    update: jest.fn(async (patch: Record<string, unknown>) => {
      if (state.profile) state.profile = { ...state.profile, ...patch as Partial<CommonsProfile> };
    }) as any,
    set: jest.fn(async (next: CommonsProfile) => {
      state.profile = next;
    }) as any,
  };
  const publishedDocs = Object.keys(state.publishedFlags).map((id) => ({
    ref: {
      update: jest.fn((patch: Record<string, unknown>) => {
        state.publishedFlags[id] = { ...state.publishedFlags[id], ...patch };
      }),
    },
  }));
  return {
    collection(name: string) {
      const chain = {
        where() { return chain; },
        orderBy() { return chain; },
        limit() { return chain; },
        async get() {
          if (name === 'commons_published_pes') {
            return { empty: publishedDocs.length === 0, docs: publishedDocs };
          }
          if (name === 'agent_wallets') {
            return opts.walletIsAgent
              ? {
                  exists: true,
                  data: () => ({ created_at: 0 }),
                }
              : { exists: false, data: () => ({}) };
          }
          return { empty: true, docs: [] };
        },
        doc() {
          return {
            ref: profileRef,
            // Firestore's DocumentReference has .set/.update directly on it
            set: profileRef.set,
            update: profileRef.update,
            async get() {
              if (name === 'commons_profiles') {
                if (state.profile) {
                  return { exists: true, data: () => state.profile, ref: profileRef };
                }
                return { exists: false, data: () => ({}), ref: profileRef };
              }
              if (name === 'agent_wallets') {
                return opts.walletIsAgent
                  ? { exists: true, data: () => ({ created_at: 0 }) }
                  : { exists: false, data: () => ({}) };
              }
              if (name === 'agent_directory') {
                return { exists: false, data: () => ({}) };
              }
              return { exists: false, data: () => ({}) };
            },
          };
        },
      };
      return chain;
    },
    batch() {
      const ops: Array<() => void> = [];
      return {
        update(ref: FakeRef, patch: Record<string, unknown>) {
          ops.push(() => ref.update(patch));
        },
        delete() { /* leave's old behavior - should NOT be used now */ },
        async commit() { ops.forEach((fn) => fn()); },
      };
    },
  };
}

const fakeDeps = (state: State, walletIsAgent = false): any => ({
  db: makeFakeDb(state, { walletIsAgent }),
  cache: {
    checkRateLimit: async () => ({ allowed: true, retryAfter: 0 }),
  },
  peBuffer: { enqueue: jest.fn() },
  recordPEAccrual: async () => undefined,
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('Wave 4 HIGH-5: leaveCommons preserves state', () => {
  it('flips profile.status to inactive and flags published PEs (no delete)', async () => {
    const state: State = {
      profile: buildProfile(),
      publishedFlags: { 'pe_1': {}, 'pe_2': {} },
    };
    await leaveCommons(fakeDeps(state), 'wal_test');
    expect(state.profile?.status).toBe('inactive');
    expect((state.profile as any).left_at).toBeGreaterThan(0);
    expect(state.profile?.forum_post_count).toBe(12);
    expect(state.profile?.human_jobs_completed).toBe(7);
    expect(state.publishedFlags.pe_1.profile_inactive).toBe(true);
    expect(state.publishedFlags.pe_2.profile_inactive).toBe(true);
  });
});

describe('Wave 4 HIGH-5: registerForCommons rehydrates inactive profiles', () => {
  it('keeps counters when re-registering a previously-left profile', async () => {
    const state: State = {
      profile: buildProfile({
        status: 'inactive',
        left_at: Date.now() - 3600_000,
      }),
      publishedFlags: { 'pe_1': { profile_inactive: true, profile_left_at: 1 } },
    };
    const result = await registerForCommons(
      fakeDeps(state, false),
      'wal_test',
      'agent_test',
      '0x1111',
      { display_name: 'Test', participant_type: 'human' },
    );
    expect(result.profile.status).toBe('active');
    expect((result.profile as any).left_at).toBeUndefined();
    expect(result.profile.forum_post_count).toBe(12);
    expect(result.profile.human_jobs_completed).toBe(7);
    expect(result.profile.human_jobs_avg_rating).toBe(4.6);
    expect(result.profile.published_pe_count).toBe(5);
    expect(state.publishedFlags.pe_1.profile_inactive).toBe(false);
    expect(state.publishedFlags.pe_1.profile_reactivated_at).toBeGreaterThan(0);
  });

  it('rejects re-register on a still-active profile (409 path)', async () => {
    const state: State = {
      profile: buildProfile({ status: 'active' }),
      publishedFlags: {},
    };
    await expect(
      registerForCommons(
        fakeDeps(state, false),
        'wal_test',
        'agent_test',
        '0x1111',
        { display_name: 'Test', participant_type: 'human' },
      ),
    ).rejects.toThrow(/Already registered/);
  });
});
