/**
 * the person-side vouch. RED controls: the SAME profile with the link removed must show the
 * action (so "hidden for my linked agent" is proven to key on the link, not on the profile).
 */
import { describe, it, expect } from 'vitest';
import { CommonsError } from './CommonsService';
import { canShowVouch, classifyVouchError, hasVouchedFor } from './vouchModel';

const LINKED = [{ wallet_id: 'wallet_aw_mine', agent_id: 'agent_mine' }];

describe('canShowVouch', () => {
  it('hides Vouch on my own beneficiary-linked agent (by wallet id or agent id)', () => {
    expect(canShowVouch({ viewerId: 'user_me', targetId: 'wallet_aw_mine', linkedAgents: LINKED })).toBe(false);
    expect(canShowVouch({ viewerId: 'user_me', targetId: 'wallet_aw_x', targetAgentId: 'agent_mine', linkedAgents: LINKED })).toBe(false);
  });

  it('RED: the same agent profile without the link shows Vouch', () => {
    expect(canShowVouch({ viewerId: 'user_me', targetId: 'wallet_aw_mine', linkedAgents: [] })).toBe(true);
  });

  it('shows Vouch on someone else (a person or an unlinked agent); hides it on my own profile', () => {
    expect(canShowVouch({ viewerId: 'user_me', targetId: 'user_them', linkedAgents: LINKED })).toBe(true);
    expect(canShowVouch({ viewerId: 'user_me', targetId: 'wallet_aw_other', linkedAgents: LINKED })).toBe(true);
    expect(canShowVouch({ viewerId: 'user_me', targetId: 'user_me', linkedAgents: LINKED })).toBe(false);
    expect(canShowVouch({ viewerId: null, targetId: 'user_them', linkedAgents: LINKED })).toBe(false);
  });
});

describe('hasVouchedFor', () => {
  it('matches the target id (or its agent id)', () => {
    const mine = [{ target_id: 'user_them' }, { target_id: 'agent_x' }];
    expect(hasVouchedFor(mine, 'user_them')).toBe(true);
    expect(hasVouchedFor(mine, 'wallet_aw_x', 'agent_x')).toBe(true);
    expect(hasVouchedFor(mine, 'user_new')).toBe(false);
  });
});

describe('classifyVouchError', () => {
  it('routes a 428 to the presentation and explains a 403 linked pair', () => {
    expect(classifyVouchError(new CommonsError('present first', 428, 'rail_handshake_required'))).toBe('needs_presentation');
    expect(classifyVouchError(new CommonsError('no', 403, 'linked_pair_vouch_refused'))).toBe('linked_pair');
    expect(classifyVouchError(new CommonsError('cannot vouch for yourself', 400))).toBe('self');
    expect(classifyVouchError(new CommonsError('vouchee not found', 404))).toBe('not_found');
    expect(classifyVouchError(new Error('network'))).toBe('other');
  });
});
