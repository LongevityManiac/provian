/**
 * joinCommons — the agent self-service join.
 *
 * Two invariants proven here:
 * 1. IDEMPOTENT: an agent that already holds an ACTIVE Commons profile and
 * re-runs join gets a clean no-op — the existing profile back, NO second
 * `commons_profile_created` PE, and never a 400.
 * 2. ZERO-CONFIG display name: an agent that omits display_name joins under
 * the name it registered its wallet with (agent_wallets.display_name).
 * 3. JOINING = REACHABLE : an agent joins only with its thread
 * message key published in the same step (or already on file).
 *
 * The PE-emission counter (mockGeneratePE) is the discriminating control: a
 * fresh join emits exactly one PE; the idempotent re-run emits ZERO. If the
 * no-op guard were removed, the re-run would fall through to registerForCommons,
 * which throws "Already registered on the Commons" (the human-path behaviour,
 * asserted directly in profiles.wave4.test.ts).
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const mockGeneratePE = jest.fn(async (_deps: unknown, _args: unknown) => ({ peId: 'pe_join_stub' }));
jest.mock('../agent-bank/pe-utils', () => ({
  generatePE: (deps: unknown, args: unknown) => mockGeneratePE(deps, args),
}));

import {
  COMMONS_MESSAGE_KEY_REQUIRED,
  COMMONS_TEST_PLATFORM_EXCLUSION,
  joinCommons,
  registerForCommons,
} from './profiles';
import type { CommonsProfile } from './types';

const REGISTERED_NAME = 'Atlas Registered';
/** A well-formed x25519 public key, base64url (43 chars). */
const PUBKEY = 'A'.repeat(43);
const PUBKEY_2 = 'B'.repeat(43);

function buildProfile(overrides: Partial<CommonsProfile> = {}): CommonsProfile {
  const now = Date.now();
  return {
    wallet_id: 'wallet_aw_agent',
    participant_type: 'agent',
    display_name: 'Atlas',
    attestation_tier: 'software',
    identity_verification_level: 'device_attested',
    pe_count: 3,
    promise_fulfillment_rate: 1,
    court_record: {
      cases_as_plaintiff: 0, cases_as_defendant: 0, cases_as_arbitrator: 0,
      wins: 0, losses: 0, arbitrations_completed: 0, slashing_events: 0,
    },
    commons_join_date: now,
    first_pe_date: now,
    human_jobs_completed: 0,
    human_jobs_avg_rating: 0,
    human_jobs_categories: [],
    human_jobs_posted: 0,
    human_jobs_avg_human_rating: 0,
    forum_post_count: 0,
    forum_upvotes_received: 0,
    published_pe_count: 0,
    status: 'active',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

interface State {
  profile?: CommonsProfile;
  walletPlatform?: string;
  messageKey?: { party_id: string; kind: string; pubkey_b64u: string; key_version: number; published_at: number };
}

function makeFakeDb(state: State): any {
  const setSpy = jest.fn(async (next: CommonsProfile) => { state.profile = next; });
  const profileDoc = {
    set: setSpy,
    update: jest.fn(),
    async get() {
      return state.profile
        ? { exists: true, data: () => state.profile }
        : { exists: false, data: () => ({}) };
    },
  };
  const agentWalletDoc = {
    async get() {
      return {
        exists: true,
        data: () => ({
          display_name: REGISTERED_NAME,
          created_at: 0,
          ...(state.walletPlatform ? { platform: state.walletPlatform } : {}),
        }),
      };
    },
  };
  const messageKeyDoc = {
    async get() {
      return state.messageKey ? { exists: true, data: () => state.messageKey } : { exists: false, data: () => undefined };
    },
  };
  const db = {
    _setSpy: setSpy,
    async runTransaction(fn: (txn: unknown) => Promise<unknown>) {
      return fn({
        get: (ref: { get: () => Promise<unknown> }) => ref.get(),
        set: (_ref: unknown, data: State['messageKey']) => { state.messageKey = data; },
      });
    },
    collection(name: string) {
      const chain = {
        where() { return chain; },
        orderBy() { return chain; },
        limit() { return chain; },
        async get() { return { empty: true, docs: [] }; },
        doc() {
          if (name === 'agent_wallets') return agentWalletDoc;
          if (name === 'commons_profiles') return profileDoc;
          if (name === 'commons_message_keys') return messageKeyDoc;
          return { async get() { return { exists: false, data: () => ({}) }; }, set: jest.fn(), update: jest.fn() };
        },
      };
      return chain;
    },
    batch() {
      const ops: Array<() => void> = [];
      return { update() { /* unused */ }, delete() {}, async commit() { ops.forEach((fn) => fn()); } };
    },
  };
  return db;
}

const fakeDeps = (state: State): any => ({
  db: makeFakeDb(state),
  cache: { checkRateLimit: async () => ({ allowed: true, retryAfter: 0 }) },
  peBuffer: { enqueue: jest.fn() },
  recordPEAccrual: async () => undefined,
});

beforeEach(() => {
  jest.clearAllMocks();
});

const keyOnFile = (pubkey = PUBKEY): NonNullable<State['messageKey']> => ({
  party_id: 'wallet_aw_agent', kind: 'agent', pubkey_b64u: pubkey, key_version: 1, published_at: 1,
});

describe('joinCommons: idempotent autonomous join', () => {
  it('a fresh agent join writes the profile and emits exactly ONE record-only PE', async () => {
    const state: State = {};
    const deps = fakeDeps(state);
    const result = await joinCommons(deps, 'wallet_aw_agent', 'agent_x', '0xabc', { display_name: 'Atlas', message_pubkey: PUBKEY });
    expect(result.already_member).toBeFalsy();
    expect(result.registration_pe_id).toBe('pe_join_stub');
    expect(mockGeneratePE).toHaveBeenCalledTimes(1);
    expect(deps.db._setSpy).toHaveBeenCalledTimes(1);
    expect(state.profile?.status).toBe('active');
  });

  it('IDEMPOTENT: re-running for an ACTIVE agent profile is a clean no-op — NO new PE, NO write, no throw', async () => {
    const state: State = { profile: buildProfile({ status: 'active' }) };
    const deps = fakeDeps(state);
    const result = await joinCommons(deps, 'wallet_aw_agent', 'agent_x', '0xabc', { display_name: 'Atlas' });
    expect(result.already_member).toBe(true);
    if (!result.profile) throw new Error('Expected the existing public Commons profile');
    expect(result.profile.wallet_id).toBe('wallet_aw_agent');
    // The discriminating control: the no-op path emits zero PEs and writes nothing.
    expect(mockGeneratePE).not.toHaveBeenCalled();
    expect(deps.db._setSpy).not.toHaveBeenCalled();
  });

  it('an INACTIVE profile is NOT a no-op: it rehydrates and re-emits the join PE', async () => {
    const state: State = { profile: buildProfile({ status: 'inactive', left_at: Date.now() - 1000 }), messageKey: keyOnFile() };
    const deps = fakeDeps(state);
    const result = await joinCommons(deps, 'wallet_aw_agent', 'agent_x', '0xabc', { display_name: 'Atlas' });
    expect(result.already_member).toBeFalsy();
    expect(mockGeneratePE).toHaveBeenCalledTimes(1);
    expect(state.profile?.status).toBe('active');
  });
});

describe('joinCommons: zero-config display name', () => {
  it('defaults display_name to the registered agent name when the agent omits it', async () => {
    const state: State = {};
    const deps = fakeDeps(state);
    // No display_name supplied.
    await joinCommons(deps, 'wallet_aw_agent', 'agent_x', '0xabc', { message_pubkey: PUBKEY } as any);
    expect(state.profile?.display_name).toBe(REGISTERED_NAME);
  });

  it('a supplied display_name is honoured over the registered name', async () => {
    const state: State = {};
    const deps = fakeDeps(state);
    await joinCommons(deps, 'wallet_aw_agent', 'agent_x', '0xabc', { display_name: 'Chosen Name', message_pubkey: PUBKEY });
    expect(state.profile?.display_name).toBe('Chosen Name');
  });
});

describe('joinCommons: test-platform exclusion', () => {
  it('RED: a platform:test agent is a successful internal no-op with no public profile or PE', async () => {
    const state: State = { walletPlatform: 'test' };
    const deps = fakeDeps(state);

    const result = await joinCommons(
      deps,
      'wallet_aw_agent',
      'agent_test',
      '0xabc',
      { display_name: 'Smoke Bot' },
    );

    expect(result).toEqual({
      profile: null,
      registration_pe_id: '',
      already_member: false,
      excluded_test: true,
    });
    expect(state.profile).toBeUndefined();
    expect(deps.db._setSpy).not.toHaveBeenCalled();
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('the canonical register writer also refuses a test-platform agent', async () => {
    const state: State = { walletPlatform: 'test' };
    const deps = fakeDeps(state);

    await expect(registerForCommons(
      deps,
      'wallet_aw_agent',
      'agent_test',
      '0xabc',
      { display_name: 'Smoke Bot', participant_type: 'agent' },
    )).rejects.toThrow(COMMONS_TEST_PLATFORM_EXCLUSION);

    expect(state.profile).toBeUndefined();
    expect(deps.db._setSpy).not.toHaveBeenCalled();
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });
});

describe('joinCommons: joining = reachable ', () => {
  it('RED: a fresh agent join with no key supplied and none on file is refused before any profile or PE', async () => {
    const state: State = {};
    const deps = fakeDeps(state);
    await expect(joinCommons(deps, 'wallet_aw_agent', 'agent_x', '0xabc', { display_name: 'Atlas' }))
      .rejects.toThrow(COMMONS_MESSAGE_KEY_REQUIRED);
    expect(state.profile).toBeUndefined();
    expect(deps.db._setSpy).not.toHaveBeenCalled();
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('a fresh join with message_pubkey publishes the key in the same step, before the profile', async () => {
    const state: State = {};
    const deps = fakeDeps(state);
    const order: string[] = [];
    const realSet = deps.db._setSpy.getMockImplementation();
    deps.db._setSpy.mockImplementation(async (p: CommonsProfile) => { order.push(state.messageKey ? 'profile_after_key' : 'profile_before_key'); return realSet(p); });
    await joinCommons(deps, 'wallet_aw_agent', 'agent_x', '0xabc', { display_name: 'Atlas', message_pubkey: PUBKEY });
    expect(state.messageKey).toMatchObject({ party_id: 'wallet_aw_agent', kind: 'agent', pubkey_b64u: PUBKEY, key_version: 1 });
    expect(order).toEqual(['profile_after_key']);
    expect(state.profile?.status).toBe('active');
  });

  it('a fresh join with no message_pubkey succeeds when a key is already on file', async () => {
    const state: State = { messageKey: keyOnFile() };
    const deps = fakeDeps(state);
    const result = await joinCommons(deps, 'wallet_aw_agent', 'agent_x', '0xabc', { display_name: 'Atlas' });
    expect(result.registration_pe_id).toBe('pe_join_stub');
    expect(state.messageKey?.key_version).toBe(1);
  });

  it('a malformed message_pubkey is refused before any profile or PE', async () => {
    const state: State = {};
    const deps = fakeDeps(state);
    await expect(joinCommons(deps, 'wallet_aw_agent', 'agent_x', '0xabc', { display_name: 'Atlas', message_pubkey: 'not-a-key' }))
      .rejects.toThrow(/message_pubkey must be/);
    expect(state.profile).toBeUndefined();
    expect(state.messageKey).toBeUndefined();
    expect(mockGeneratePE).not.toHaveBeenCalled();
  });

  it('an idempotent re-join with message_pubkey repairs a missing key (no PE, no profile write)', async () => {
    const state: State = { profile: buildProfile({ status: 'active' }) };
    const deps = fakeDeps(state);
    const result = await joinCommons(deps, 'wallet_aw_agent', 'agent_x', '0xabc', { display_name: 'Atlas', message_pubkey: PUBKEY });
    expect(result.already_member).toBe(true);
    expect(state.messageKey?.pubkey_b64u).toBe(PUBKEY);
    expect(mockGeneratePE).not.toHaveBeenCalled();
    expect(deps.db._setSpy).not.toHaveBeenCalled();
  });

  it('an idempotent re-join with a rotated message_pubkey re-publishes it (version bumps)', async () => {
    const state: State = { profile: buildProfile({ status: 'active' }), messageKey: keyOnFile(PUBKEY) };
    const deps = fakeDeps(state);
    await joinCommons(deps, 'wallet_aw_agent', 'agent_x', '0xabc', { display_name: 'Atlas', message_pubkey: PUBKEY_2 });
    expect(state.messageKey).toMatchObject({ pubkey_b64u: PUBKEY_2, key_version: 2 });
  });

  it('RED: the canonical register writer refuses an agent with no key', async () => {
    const state: State = {};
    const deps = fakeDeps(state);
    await expect(registerForCommons(deps, 'wallet_aw_agent', 'agent_x', '0xabc', { display_name: 'Atlas', participant_type: 'agent' }))
      .rejects.toThrow(COMMONS_MESSAGE_KEY_REQUIRED);
    expect(state.profile).toBeUndefined();
  });

  it('a test-platform agent never publishes a key (it never joins)', async () => {
    const state: State = { walletPlatform: 'test' };
    const deps = fakeDeps(state);
    await joinCommons(deps, 'wallet_aw_agent', 'agent_test', '0xabc', { display_name: 'Smoke Bot', message_pubkey: PUBKEY });
    expect(state.messageKey).toBeUndefined();
  });
});
