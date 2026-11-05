/**
 * runtime boundary / C-2: GET /v1/pvt/estimate route behavior.
 *
 * Launch gate (404 pre-flip), validation 400s, per-IP rate limiting, and the
 * response contract. Estimator arithmetic is pinned in core/pvt/estimate.test.ts;
 * parity with the money path in core/pvt/policy/record-path-estimate.parity.test.ts.
 *
 * The route now takes `db` because the estimate prices through the record path,
 * which READS the action-policy pointer, the signed monetary activation, and the
 * Genesis activation. It still writes nothing — asserted below.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import express, { Express } from 'express';
import request from 'supertest';
import type { Firestore } from 'firebase-admin/firestore';
import type { RedisCache } from '../cache';
import { createPVTEstimateRouter } from './pvt-estimate';
import {
  createFakeFirestore,
  type FakeFirestore,
} from '../core/pvt/__test-helpers__/fake-firestore';

function createCache(overrides?: { rateLimited?: boolean }): RedisCache {
  return {
    checkRateLimit: jest.fn(async () =>
      overrides?.rateLimited
        ? { allowed: false, current: 61, limit: 60, retryAfter: 30 }
        : { allowed: true, current: 1, limit: 60 }),
  } as unknown as RedisCache;
}

let db: FakeFirestore;

function buildApp(cache = createCache()): Express {
  const app = express();
  app.use('/v1/pvt', createPVTEstimateRouter({ cache, db: db as unknown as Firestore }));
  return app;
}

describe('GET /v1/pvt/estimate', () => {
  let priorLaunch: string | undefined;

  beforeEach(() => {
    db = createFakeFirestore();
    priorLaunch = process.env.PUBLIC_LAUNCH;
    process.env.PUBLIC_LAUNCH = 'true';
  });

  afterEach(() => {
    if (priorLaunch === undefined) delete process.env.PUBLIC_LAUNCH;
    else process.env.PUBLIC_LAUNCH = priorLaunch;
  });

  it('404s before the launch flip (PUBLIC_LAUNCH gate)', async () => {
    delete process.env.PUBLIC_LAUNCH;
    const res = await request(buildApp()).get('/v1/pvt/estimate?action_type=send');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not found' });
  });

  it('returns the points/PVT/disposition contract for the acceptance query', async () => {
    const res = await request(buildApp())
      .get('/v1/pvt/estimate?action_type=agent_tool_orchestration&attestation_tier=software');
    expect(res.status).toBe(200);
    expect(typeof res.body.record_points_atomic).toBe('string');
    expect(typeof res.body.estimated_pvt_atomic).toBe('string');
    expect(typeof res.body.mint_disposition).toBe('string');
    expect(res.body.inputs).toMatchObject({
      action_type: 'agent_tool_orchestration',
      novelty: 0,
      count: 0,
      human_linked: false,
      durable_submission_path: false,
    });
    expect(Array.isArray(res.body.disclaimers)).toBe(true);
    expect(Array.isArray(res.body.assumptions)).toBe(true);
    expect(res.body.disclaimers.join(' ')).toContain(
      'every act of work mints PVT once at its best-supported value',
    );
    expect(res.body.disclaimers.join(' ')).toContain('scenario input only');
    expect(res.body.disclaimers.join(' ')).toContain('0.5x-2.5x');
    expect(res.body.disclaimers.join(' ')).toContain('no daily diminishing multiplier');
    expect(res.body.disclaimers.join(' ')).toContain('not a second multiplier');
    // The distinction the endpoint exists to stop blurring.
    expect(res.body.disclaimers.join(' ')).toContain('NOT PVT');
  });

  it('is a pure read: serving an estimate writes nothing', async () => {
    const res = await request(buildApp())
      .get('/v1/pvt/estimate?action_type=agent_work_product_code');
    expect(res.status).toBe(200);
    // The fake Firestore records every mutation it is asked to perform. An
    // estimate that queued a pending-policy observation would show up here.
    expect(db.ops.length).toBe(0);
    expect(db.store.size).toBe(0);
  });

  it('threads novelty, count and the linkage scenario through to the estimator', async () => {
    // count=51 was beyond the former qualification bound; volume
    // no longer disqualifies anything, and the response carries no
    // daily_qualified field. agent-work is external_proof_priced with the
    // software discount (0.8x); this scenario carries the hardware tier for the
    // full 1.0x observable points, and the default software tier earns 0.8x
    // (asserted below), sealed record_only by the best-effort path.
    const res = await request(buildApp())
      .get('/v1/pvt/estimate?action_type=agent_work_product_code&novelty=1&count=51&human_linked=true&attestation_tier=hardware');
    expect(res.status).toBe(200);
    expect(res.body.inputs).toMatchObject({
      novelty: 1,
      count: 51,
      human_linked: true,
    });
    expect(res.body.inputs.daily_qualified).toBeUndefined();
    // On the best-effort path the PE is record_only regardless of count, so
    // the points survive — they are simply unpayable. The PVT figure, which
    // is what the user acts on, is 0.
    expect(BigInt(res.body.record_points_atomic)).toBeGreaterThan(0n);
    expect(res.body.estimated_pvt).toBe(0);
    expect(res.body.estimated_pvt_atomic).toBe('0');
    expect(res.body.mint_disposition).toBe('record_only');

    // on a DURABLE inlet extreme volume estimates IDENTICALLY to zero
    // volume — same points, same disposition. No overrun exists.
    const durableBeyond = await request(buildApp())
      .get('/v1/pvt/estimate?action_type=wallet_created&count=51&durable_submission_path=true');
    const durableZero = await request(buildApp())
      .get('/v1/pvt/estimate?action_type=wallet_created&count=0&durable_submission_path=true');
    expect(durableBeyond.body.record_points_atomic).toBe(durableZero.body.record_points_atomic);
    expect(durableBeyond.body.mint_disposition).toBe(durableZero.body.mint_disposition);

    // Volume never reprices: the same points at count 49 as at ordinal 1
    // with the same novelty ordinal.
    const inside = await request(buildApp())
      .get('/v1/pvt/estimate?action_type=agent_work_product_code&novelty=1&count=49&human_linked=true&attestation_tier=hardware');
    expect(inside.status).toBe(200);
    expect(BigInt(inside.body.record_points_atomic)).toBeGreaterThan(0n);
    expect(inside.body.record_points_atomic).toBe(res.body.record_points_atomic);

    // the DEFAULT (software) tier for the same type earns the 0.8x
    // discount in its points (no longer floored to 0), but the best-effort path
    // seals record_only, so the PVT figure is still 0 — points are not PVT.
    const discounted = await request(buildApp())
      .get('/v1/pvt/estimate?action_type=agent_work_product_code&novelty=1&count=51&human_linked=true');
    expect(discounted.status).toBe(200);
    expect(BigInt(discounted.body.record_points_atomic)).toBeGreaterThan(0n);
    expect(discounted.body.estimated_pvt).toBe(0);
    expect(discounted.body.mint_disposition).toBe('record_only');
    expect(discounted.body.mint_reason_code).toBe('policy_record_only');
  });

  it('accepts durable_submission_path and it changes the PVT figure, not the points', async () => {
    const bestEffort = await request(buildApp())
      .get('/v1/pvt/estimate?action_type=wallet_created');
    const durable = await request(buildApp())
      .get('/v1/pvt/estimate?action_type=wallet_created&durable_submission_path=true');
    expect(bestEffort.status).toBe(200);
    expect(durable.status).toBe(200);
    expect(durable.body.record_points_atomic).toBe(bestEffort.body.record_points_atomic);
    expect(bestEffort.body.estimated_pvt_atomic).toBe('0');
    expect(BigInt(durable.body.estimated_pvt_atomic)).toBeGreaterThan(0n);
  });

  it('400s without action_type', async () => {
    const res = await request(buildApp()).get('/v1/pvt/estimate');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('400s on a malformed action_type', async () => {
    const res = await request(buildApp())
      .get('/v1/pvt/estimate?action_type=' + encodeURIComponent('drop table;--'));
    expect(res.status).toBe(400);
  });

  it('400s on an unknown attestation_tier and lists the valid ones', async () => {
    const res = await request(buildApp())
      .get('/v1/pvt/estimate?action_type=send&attestation_tier=quantum');
    expect(res.status).toBe(400);
    expect(res.body.valid_attestation_tiers).toContain('software');
    expect(res.body.valid_attestation_tiers).toContain('hardware');
  });

  it('400s on negative or non-integer novelty/count', async () => {
    const negative = await request(buildApp()).get('/v1/pvt/estimate?action_type=send&novelty=-1');
    expect(negative.status).toBe(400);
    const fractional = await request(buildApp()).get('/v1/pvt/estimate?action_type=send&count=1.5');
    expect(fractional.status).toBe(400);
  });

  it('400s on a malformed durable_submission_path', async () => {
    const res = await request(buildApp())
      .get('/v1/pvt/estimate?action_type=send&durable_submission_path=maybe');
    expect(res.status).toBe(400);
  });

  it('429s when the per-IP rate limit trips', async () => {
    const res = await request(buildApp(createCache({ rateLimited: true })))
      .get('/v1/pvt/estimate?action_type=send');
    expect(res.status).toBe(429);
    expect(res.body.retry_after).toBe(30);
  });
});
