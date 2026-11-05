/**
 * PURE presentation-request rules. Every transition + guard ships with
 * its RED negative control : a green assertion here is meaningless unless
 * the same rule is shown REJECTING the violating input, so each guard is proven
 * to actually fire (the state machine rejects out-of-order transitions, a bad
 * tier / oversized note is refused, and the agent projection is proven to OMIT
 * the Tier-3 note + human identity).
 */
import { describe, it, expect } from '@jest/globals';
import {
  buildPresentationRequest,
  applyComposedChallenge,
  applyPresentation,
  applyVerdict,
  applyDecline,
  isExpired,
  toAgentFacingRequest,
  toHumanFacingRequest,
  PRESENTATION_REQUEST_TTL_MS,
  type PresentationRequestRecord,
} from './presentation-request';

const NOW = 1_700_000_000_000;

function built(overrides: Partial<Parameters<typeof buildPresentationRequest>[0]> = {}) {
  const r = buildPresentationRequest({ agentWalletId: 'wallet_aw_1', humanUserId: 'user_frank', nowMs: NOW, ...overrides });
  if (!r.ok) throw new Error(`build failed: ${r.error}`);
  return r.record;
}

describe('buildPresentationRequest', () => {
  it('builds a pending request with a preq_ id, default reputation tier, 7-day TTL, and null challenge/verdict fields', () => {
    const rec = built();
    expect(rec.request_id).toMatch(/^preq_[0-9a-f]{32}$/);
    expect(rec.direction).toBe('agent_presents_to_human');
    expect(rec.initiator).toBe('agent');
    expect(rec.tier).toBe('reputation');
    expect(rec.status).toBe('requested');
    expect(rec.note).toBeNull();
    expect(rec.audience).toBeNull();
    expect(rec.challenge).toBeNull();
    expect(rec.predicates).toBeNull();
    expect(rec.verdict).toBeNull();
    expect(rec.expires_at_ms).toBe(NOW + PRESENTATION_REQUEST_TTL_MS);
  });

  it('accepts pe_fact tier and a trimmed note', () => {
    const rec = built({ tier: 'pe_fact', note: '  please confirm my standing  ' });
    expect(rec.tier).toBe('pe_fact');
    expect(rec.note).toBe('please confirm my standing');
  });

  // RED CONTROLS — each MUST fail closed.
  it('RED: rejects a missing agent wallet', () => {
    expect(buildPresentationRequest({ agentWalletId: '  ', humanUserId: 'u', nowMs: NOW })).toEqual({ ok: false, error: 'agent_wallet_id is required' });
  });
  it('RED: rejects a missing linked human', () => {
    expect(buildPresentationRequest({ agentWalletId: 'w', humanUserId: '', nowMs: NOW })).toEqual({ ok: false, error: 'no linked human to present to' });
  });
  it('RED: rejects a bad tier', () => {
    expect(buildPresentationRequest({ agentWalletId: 'w', humanUserId: 'u', tier: 'gold', nowMs: NOW })).toEqual({ ok: false, error: 'tier must be pe_fact|reputation' });
  });
  it('RED: rejects an oversized note (>240 chars)', () => {
    const r = buildPresentationRequest({ agentWalletId: 'w', humanUserId: 'u', note: 'x'.repeat(241), nowMs: NOW });
    expect(r).toEqual({ ok: false, error: 'note exceeds 240 chars' });
  });
  it('RED: rejects a non-string note', () => {
    const r = buildPresentationRequest({ agentWalletId: 'w', humanUserId: 'u', note: { evil: true }, nowMs: NOW });
    expect(r).toEqual({ ok: false, error: 'note must be a string' });
  });
});

describe('applyComposedChallenge (human composes; only from requested)', () => {
  it('moves requested → challenged with audience/challenge/predicates + timestamp', () => {
    const r = applyComposedChallenge(built(), { audience: 'aud-1', challenge: 'chal-1', predicates: [{ field: 'x', op: 'gte', threshold: 1 }], nowMs: NOW + 10 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.status).toBe('challenged');
    expect(r.record.audience).toBe('aud-1');
    expect(r.record.challenge).toBe('chal-1');
    expect(r.record.predicates).toEqual([{ field: 'x', op: 'gte', threshold: 1 }]);
    expect(r.record.challenged_at_ms).toBe(NOW + 10);
  });

  it('accepts null predicates', () => {
    const r = applyComposedChallenge(built(), { audience: 'a', challenge: 'c', predicates: null, nowMs: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.record.predicates).toBeNull();
  });

  // RED CONTROLS
  it('RED: a challenge from `challenged` is rejected (wrong status)', () => {
    const challenged = applyComposedChallenge(built(), { audience: 'a', challenge: 'c', nowMs: NOW });
    if (!challenged.ok) throw new Error('setup');
    const again = applyComposedChallenge(challenged.record, { audience: 'a2', challenge: 'c2', nowMs: NOW });
    expect(again).toEqual({ ok: false, error: "cannot compose a challenge from status 'challenged'" });
  });
  it('RED: empty audience rejected', () => {
    expect(applyComposedChallenge(built(), { audience: '  ', challenge: 'c', nowMs: NOW })).toEqual({ ok: false, error: 'audience must be a non-empty string' });
  });
  it('RED: empty challenge rejected', () => {
    expect(applyComposedChallenge(built(), { audience: 'a', challenge: '', nowMs: NOW })).toEqual({ ok: false, error: 'challenge must be a non-empty string' });
  });
  it('RED: non-array predicates rejected', () => {
    expect(applyComposedChallenge(built(), { audience: 'a', challenge: 'c', predicates: 'nope', nowMs: NOW })).toEqual({ ok: false, error: 'predicates must be an array or null' });
  });
});

describe('applyPresentation (agent posts token; only from challenged)', () => {
  function challenged(): PresentationRequestRecord {
    const r = applyComposedChallenge(built(), { audience: 'a', challenge: 'c', nowMs: NOW });
    if (!r.ok) throw new Error('setup');
    return r.record;
  }

  it('moves challenged → presented with burn_id + token + timestamp', () => {
    const r = applyPresentation(challenged(), { burn_id: 'b'.repeat(64), presentation_token: 'TOKEN', nowMs: NOW + 20 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.status).toBe('presented');
    expect(r.record.burn_id).toBe('b'.repeat(64));
    expect(r.record.presentation_token).toBe('TOKEN');
    expect(r.record.presented_at_ms).toBe(NOW + 20);
  });

  // RED CONTROLS
  it('RED: a presentation from `requested` is rejected (skips the challenge)', () => {
    expect(applyPresentation(built(), { burn_id: 'b', presentation_token: 't', nowMs: NOW })).toEqual({ ok: false, error: "cannot post a presentation from status 'requested'" });
  });
  it('RED: missing burn_id rejected', () => {
    expect(applyPresentation(challenged(), { burn_id: '', presentation_token: 't', nowMs: NOW })).toEqual({ ok: false, error: 'burn_id must be a non-empty string' });
  });
  it('RED: missing presentation_token rejected', () => {
    expect(applyPresentation(challenged(), { burn_id: 'b', presentation_token: '  ', nowMs: NOW })).toEqual({ ok: false, error: 'presentation_token must be a non-empty string' });
  });
});

describe('applyVerdict (human records; only from presented)', () => {
  function presented(): PresentationRequestRecord {
    const c = applyComposedChallenge(built(), { audience: 'a', challenge: 'c', nowMs: NOW });
    if (!c.ok) throw new Error('setup');
    const p = applyPresentation(c.record, { burn_id: 'b', presentation_token: 't', nowMs: NOW });
    if (!p.ok) throw new Error('setup');
    return p.record;
  }

  it('moves presented → verified with verdict + predicate_results + timestamp', () => {
    const r = applyVerdict(presented(), { verdict: 'valid', predicate_results: [{ field: 'x', result: true }], nowMs: NOW + 30 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.status).toBe('verified');
    expect(r.record.verdict).toBe('valid');
    expect(r.record.predicate_results).toEqual([{ field: 'x', result: true }]);
    expect(r.record.verified_at_ms).toBe(NOW + 30);
  });

  it('accepts an invalid verdict', () => {
    const r = applyVerdict(presented(), { verdict: 'invalid', nowMs: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.record.verdict).toBe('invalid');
  });

  // RED CONTROLS
  it('RED: a verdict from `requested` is rejected (spec: verdict from requested rejected)', () => {
    expect(applyVerdict(built(), { verdict: 'valid', nowMs: NOW })).toEqual({ ok: false, error: "cannot record a verdict from status 'requested'" });
  });
  it('RED: a verdict from `challenged` is rejected (no presentation yet)', () => {
    const c = applyComposedChallenge(built(), { audience: 'a', challenge: 'c', nowMs: NOW });
    if (!c.ok) throw new Error('setup');
    expect(applyVerdict(c.record, { verdict: 'valid', nowMs: NOW })).toEqual({ ok: false, error: "cannot record a verdict from status 'challenged'" });
  });
  it('RED: a bogus verdict value is rejected', () => {
    expect(applyVerdict(presented(), { verdict: 'maybe', nowMs: NOW })).toEqual({ ok: false, error: 'verdict must be valid|invalid' });
  });
  it('RED: non-array predicate_results rejected', () => {
    expect(applyVerdict(presented(), { verdict: 'valid', predicate_results: 5, nowMs: NOW })).toEqual({ ok: false, error: 'predicate_results must be an array or null' });
  });
});

describe('verify-at-submit : the fresh verdict stored at present time is authoritative', () => {
  function presentedWithFreshVerdict(verdict: 'valid' | 'invalid', results: unknown[]): PresentationRequestRecord {
    const c = applyComposedChallenge(built(), { audience: 'a', challenge: 'c', nowMs: NOW });
    if (!c.ok) throw new Error('setup');
    // The relay verifies the FRESH token at submit time and stores the verdict here.
    const p = applyPresentation(c.record, {
      burn_id: 'b', presentation_token: 't', nowMs: NOW, verdict, predicate_results: results,
    });
    if (!p.ok) throw new Error('setup');
    return p.record;
  }

  it('applyPresentation stores the fresh submit-time verdict + predicate_results', () => {
    const rec = presentedWithFreshVerdict('valid', [{ field: 'continuity.chain_depth', result: true }]);
    expect(rec.status).toBe('presented');
    expect(rec.verdict).toBe('valid');
    expect(rec.predicate_results).toEqual([{ field: 'continuity.chain_depth', result: true }]);
  });

  it('applyPresentation stores null verdict when none is supplied (in-person immediate flow unchanged)', () => {
    const c = applyComposedChallenge(built(), { audience: 'a', challenge: 'c', nowMs: NOW });
    if (!c.ok) throw new Error('setup');
    const p = applyPresentation(c.record, { burn_id: 'b', presentation_token: 't', nowMs: NOW });
    if (!p.ok) throw new Error('setup');
    expect(p.record.verdict).toBeNull();
    expect(p.record.predicate_results).toBeNull();
  });

  it('applyVerdict keeps the stored fresh verdict and IGNORES a conflicting client verdict', () => {
    // The absent human's app re-verified an EXPIRED token → it would POST `invalid`.
    // The fresh submit-time `valid` must win: the human cannot downgrade a proof the
    // relay already verified while it was live.
    const rec = presentedWithFreshVerdict('valid', [{ field: 'x', result: true }]);
    const r = applyVerdict(rec, { verdict: 'invalid', predicate_results: [], nowMs: NOW + 99 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.status).toBe('verified');
    expect(r.record.verdict).toBe('valid');                       // fresh verdict preserved
    expect(r.record.predicate_results).toEqual([{ field: 'x', result: true }]); // fresh results preserved
    expect(r.record.verified_at_ms).toBe(NOW + 99);
  });

  it('RED: WITHOUT a stored fresh verdict, the client verdict is honored (proves the override is conditional, not blanket)', () => {
    // Same call shape, but no fresh verdict was recorded at submit → the in-person
    // flow trusts the human's own fresh verify. If the override were unconditional,
    // this would wrongly stay null/refuse; it must become 'invalid'.
    const c = applyComposedChallenge(built(), { audience: 'a', challenge: 'c', nowMs: NOW });
    if (!c.ok) throw new Error('setup');
    const p = applyPresentation(c.record, { burn_id: 'b', presentation_token: 't', nowMs: NOW }); // no verdict
    if (!p.ok) throw new Error('setup');
    const r = applyVerdict(p.record, { verdict: 'invalid', predicate_results: [], nowMs: NOW + 5 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.record.verdict).toBe('invalid');
  });
});

describe('applyDecline', () => {
  it('declines from requested', () => {
    const r = applyDecline(built());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.record.status).toBe('declined');
  });
  it('declines from presented', () => {
    const c = applyComposedChallenge(built(), { audience: 'a', challenge: 'c', nowMs: NOW });
    if (!c.ok) throw new Error('setup');
    const p = applyPresentation(c.record, { burn_id: 'b', presentation_token: 't', nowMs: NOW });
    if (!p.ok) throw new Error('setup');
    const r = applyDecline(p.record);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.record.status).toBe('declined');
  });
  it('RED: cannot decline a terminal `verified` request', () => {
    const c = applyComposedChallenge(built(), { audience: 'a', challenge: 'c', nowMs: NOW });
    if (!c.ok) throw new Error('setup');
    const p = applyPresentation(c.record, { burn_id: 'b', presentation_token: 't', nowMs: NOW });
    if (!p.ok) throw new Error('setup');
    const v = applyVerdict(p.record, { verdict: 'valid', nowMs: NOW });
    if (!v.ok) throw new Error('setup');
    expect(applyDecline(v.record)).toEqual({ ok: false, error: "cannot decline from status 'verified'" });
  });
});

describe('isExpired', () => {
  it('true at/after expiry, false before', () => {
    const rec = built();
    expect(isExpired(rec, rec.expires_at_ms - 1)).toBe(false);
    expect(isExpired(rec, rec.expires_at_ms)).toBe(true);
    expect(isExpired(rec, rec.expires_at_ms + 1)).toBe(true);
  });
});

describe('projections — privacy discipline (§3)', () => {
  it('toAgentFacingRequest OMITS note and human_user_id, but INCLUDES audience/challenge/predicates (agent needs them to present)', () => {
    const rec = built({ note: 'secret reason only the human should read' });
    const c = applyComposedChallenge(rec, { audience: 'aud', challenge: 'chal', predicates: [{ field: 'x' }], nowMs: NOW });
    if (!c.ok) throw new Error('setup');
    const view = toAgentFacingRequest(c.record) as Record<string, unknown>;
    // RED: the projection must NOT carry the Tier-3 note or the human's identity.
    expect(view).not.toHaveProperty('note');
    expect(view).not.toHaveProperty('human_user_id');
    expect(Object.values(view)).not.toContain('secret reason only the human should read');
    expect(Object.values(view)).not.toContain('user_frank');
    // But the fields the agent needs to present ARE present.
    expect(view.audience).toBe('aud');
    expect(view.challenge).toBe('chal');
    expect(view.predicates).toEqual([{ field: 'x' }]);
    expect(view.request_id).toBe(rec.request_id);
    expect(view.tier).toBe('reputation');
  });

  it('toHumanFacingRequest INCLUDES the Tier-3 note (this human reads it) and omits nothing they need', () => {
    const rec = built({ note: 'please confirm my standing to the buyer' });
    const view = toHumanFacingRequest(rec) as Record<string, unknown>;
    expect(view.note).toBe('please confirm my standing to the buyer');
    expect(view.agent_wallet_id).toBe('wallet_aw_1');
    expect(view.status).toBe('requested');
    // The human's own id is not echoed back (they know who they are; keep it lean).
    expect(view).not.toHaveProperty('human_user_id');
  });
});
