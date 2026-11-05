import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommonsProfile } from '../core/commons/CommonsService';

const commonsService = vi.hoisted(() => ({
  getJoinContext: vi.fn(),
  getAgentProfile: vi.fn(),
}));

vi.mock('../core/commons/CommonsService', () => commonsService);

import useCommonsStore from './commonsStore';

const PROFILE: CommonsProfile = {
  wallet_id: 'user_frank',
  participant_type: 'human',
  display_name: 'the operator',
  attestation_tier: 'hardware',
  identity_verification_level: 'device_verified',
  pe_count: 3309,
  promise_fulfillment_rate: 1,
  court_record: {
    cases_as_plaintiff: 0,
    cases_as_defendant: 0,
    cases_as_arbitrator: 0,
    wins: 0,
    losses: 0,
    arbitrations_completed: 0,
    slashing_events: 0,
  },
  commons_join_date: 1,
  human_jobs_completed: 0,
  human_jobs_avg_rating: 0,
  human_jobs_posted: 0,
  forum_post_count: 0,
  forum_upvotes_received: 0,
  published_pe_count: 0,
  status: 'active',
  created_at: 1,
  updated_at: 1,
};

const JOINED_CONTEXT = {
  wallet_id: PROFILE.wallet_id,
  participant_type: 'human' as const,
  can_autojoin: false,
  join_method: 'biometric' as const,
  already_joined: true,
};

describe('Commons membership reconciliation', () => {
  beforeEach(() => {
    commonsService.getJoinContext.mockReset();
    commonsService.getAgentProfile.mockReset();
    useCommonsStore.getState().reset();
  });

  it('hydrates a registered wallet from relay truth after a cold start', async () => {
    commonsService.getJoinContext.mockResolvedValue(JOINED_CONTEXT);
    commonsService.getAgentProfile.mockResolvedValue(PROFILE);

    expect(useCommonsStore.getState()).toMatchObject({
      isJoined: false,
      membershipStatus: 'unknown',
    });

    await expect(useCommonsStore.getState().refreshMembership()).resolves.toBe(true);
    expect(useCommonsStore.getState()).toMatchObject({
      isJoined: true,
      membershipStatus: 'joined',
      profile: PROFILE,
    });
  });

  it('does not erase confirmed membership when profile hydration is temporarily unavailable', async () => {
    commonsService.getJoinContext.mockResolvedValue(JOINED_CONTEXT);
    commonsService.getAgentProfile.mockRejectedValue(new Error('relay unavailable'));

    await expect(useCommonsStore.getState().refreshMembership()).resolves.toBe(true);
    expect(useCommonsStore.getState()).toMatchObject({
      isJoined: true,
      membershipStatus: 'joined',
      profile: null,
    });
  });

  it('marks setup only when the authenticated relay explicitly says not joined', async () => {
    useCommonsStore.setState({
      profile: PROFILE,
      isJoined: true,
      membershipStatus: 'joined',
    });
    commonsService.getJoinContext.mockResolvedValue({
      ...JOINED_CONTEXT,
      already_joined: false,
    });

    await expect(useCommonsStore.getState().refreshMembership()).resolves.toBe(false);
    expect(useCommonsStore.getState()).toMatchObject({
      isJoined: false,
      membershipStatus: 'not_joined',
      profile: null,
    });
  });

  it('keeps membership unknown instead of converting a relay failure into setup', async () => {
    commonsService.getJoinContext.mockRejectedValue(new Error('offline'));

    await expect(useCommonsStore.getState().refreshMembership()).resolves.toBeNull();
    expect(useCommonsStore.getState()).toMatchObject({
      isJoined: false,
      membershipStatus: 'unknown',
    });
  });
});
