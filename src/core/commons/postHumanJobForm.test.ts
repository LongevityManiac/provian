/**
 * Tests for the form -> request body mapping used by the
 * CommonsHumanJobsPost screen.
 */

import { describe, it, expect } from 'vitest';
import {
  buildPostHumanJobBody,
  PostHumanJobValidationError,
  type PostHumanJobForm,
} from './postHumanJobForm';

const VALID_FORM: PostHumanJobForm = {
  title: 'Visit a hardware store and verify a SKU is in stock',
  description: 'Drive to the local store, photograph the shelf, send back the photo.',
  category: 'physical_task',
  skillsRequired: 'local_knowledge, photo_capture',
  locationType: 'on_site',
  locationRegion: 'US-TX',
  compensationType: 'pvt',
  budgetPvtWhole: '5',
  deadlineHours: '48',
  requiresIdentityVerification: false,
  requiresPeHistory: false,
  seeking: 'human',
};

describe('buildPostHumanJobBody', () => {
  it('happy path: produces a backend-ready body', () => {
    const body = buildPostHumanJobBody(VALID_FORM);
    expect(body).toEqual({
      title: 'Visit a hardware store and verify a SKU is in stock',
      description: 'Drive to the local store, photograph the shelf, send back the photo.',
      category: 'physical_task',
      skills_required: ['local_knowledge', 'photo_capture'],
      location: { type: 'on_site', region: 'US-TX' },
      compensation_type: 'pvt',
      budget_pvt: '5000000000000000000', // 5 PVT in 18d atomic units
      requires_identity_verification: false,
      requires_pe_history: false,
      deadline_hours: 48,
      seeking: 'human',
    });
  });

  it('omits region when not supplied', () => {
    const { location } = buildPostHumanJobBody({
      ...VALID_FORM,
      locationRegion: undefined,
    });
    expect(location).toEqual({ type: 'on_site' });
  });

  it('omits region when blank/whitespace', () => {
    const { location } = buildPostHumanJobBody({
      ...VALID_FORM,
      locationRegion: '   ',
    });
    expect(location).toEqual({ type: 'on_site' });
  });

  it('a USDC job sends currency + budget_usdc (dollars) and no budget_pvt', () => {
    const body = buildPostHumanJobBody({ ...VALID_FORM, currency: 'usdc', budgetUsdc: '12.50', seeking: 'human' });
    expect(body.currency).toBe('usdc');
    expect(body.budget_usdc).toBe(12.5);
    expect(body.budget_pvt).toBeUndefined();
    expect(body.seeking).toBe('human');
  });

  it('a PVT job with a chosen seeking sends currency pvt + budget_pvt', () => {
    const body = buildPostHumanJobBody({ ...VALID_FORM, currency: 'pvt', seeking: 'agent' });
    expect(body).toMatchObject({ currency: 'pvt', seeking: 'agent', budget_pvt: '5000000000000000000' });
    expect(body.budget_usdc).toBeUndefined();
  });

  it('RED: a USDC budget with more than 6 decimals, zero, or over 10,000 is refused on its field', () => {
    for (const bad of ['1.1234567', '0', '10000.01', '', 'abc']) {
      try {
        buildPostHumanJobBody({ ...VALID_FORM, currency: 'usdc', budgetUsdc: bad });
        throw new Error(`expected '${bad}' to throw`);
      } catch (err) {
        expect(err).toBeInstanceOf(PostHumanJobValidationError);
        expect((err as PostHumanJobValidationError).field).toBe('budgetUsdc');
      }
    }
  });

  it('RED: a deadline over 672 hours is refused (the relay ceiling)', () => {
    expect(() => buildPostHumanJobBody({ ...VALID_FORM, deadlineHours: '673' })).toThrow(PostHumanJobValidationError);
  });

  it('threads the optional direction field when supplied', () => {
    const body = buildPostHumanJobBody({ ...VALID_FORM, direction: 'human_seeking_agent' });
    expect(body.direction).toBe('human_seeking_agent');
  });

  it('rejects empty title', () => {
    expect(() => buildPostHumanJobBody({ ...VALID_FORM, title: '   ' }))
      .toThrowError(PostHumanJobValidationError);
  });

  it('rejects title longer than 200 chars', () => {
    expect(() => buildPostHumanJobBody({ ...VALID_FORM, title: 'x'.repeat(201) }))
      .toThrowError(PostHumanJobValidationError);
  });

  it('rejects empty description', () => {
    expect(() => buildPostHumanJobBody({ ...VALID_FORM, description: '' }))
      .toThrowError(PostHumanJobValidationError);
  });

  it('rejects empty skills', () => {
    expect(() => buildPostHumanJobBody({ ...VALID_FORM, skillsRequired: ' , , ' }))
      .toThrowError(PostHumanJobValidationError);
  });

  it('rejects fractional budget', () => {
    expect(() => buildPostHumanJobBody({ ...VALID_FORM, budgetPvtWhole: '5.5' }))
      .toThrowError(PostHumanJobValidationError);
  });

  it('rejects zero budget', () => {
    expect(() => buildPostHumanJobBody({ ...VALID_FORM, budgetPvtWhole: '0' }))
      .toThrowError(PostHumanJobValidationError);
  });

  it('rejects negative-looking budget (no leading sign allowed)', () => {
    expect(() => buildPostHumanJobBody({ ...VALID_FORM, budgetPvtWhole: '-5' }))
      .toThrowError(PostHumanJobValidationError);
  });

  it('handles very large budget without precision loss (BigInt)', () => {
    // 1,000,000 PVT - well past Number.MAX_SAFE_INTEGER once converted
    // to atomic units (Number.MAX_SAFE_INTEGER ~= 9e15; 1e6 * 1e18 = 1e24).
    const body = buildPostHumanJobBody({ ...VALID_FORM, budgetPvtWhole: '1000000' });
    expect(body.budget_pvt).toBe('1000000000000000000000000');
  });

  it('rejects non-positive deadline', () => {
    expect(() => buildPostHumanJobBody({ ...VALID_FORM, deadlineHours: '0' }))
      .toThrowError(PostHumanJobValidationError);
  });

  it('rejects non-integer deadline', () => {
    expect(() => buildPostHumanJobBody({ ...VALID_FORM, deadlineHours: '24.5' }))
      .toThrowError(PostHumanJobValidationError);
  });

  it('attaches the field name to the error so the form can highlight it', () => {
    try {
      buildPostHumanJobBody({ ...VALID_FORM, budgetPvtWhole: 'abc' });
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PostHumanJobValidationError);
      expect((err as PostHumanJobValidationError).field).toBe('budgetPvtWhole');
    }
  });

  it('RED: no choice of who the job hires refuses the post (never a silent default)', () => {
    const { seeking: _omit, ...noSeeking } = VALID_FORM;
    expect(() => buildPostHumanJobBody(noSeeking)).toThrow(PostHumanJobValidationError);
    try { buildPostHumanJobBody(noSeeking); } catch (e) { expect((e as PostHumanJobValidationError).field).toBe('seeking'); }
  });

  it('a legacy direction still names who the job hires without seeking', () => {
    const { seeking: _omit, ...noSeeking } = VALID_FORM;
    expect(buildPostHumanJobBody({ ...noSeeking, direction: 'human_seeking_human' }).direction).toBe('human_seeking_human');
  });
});
