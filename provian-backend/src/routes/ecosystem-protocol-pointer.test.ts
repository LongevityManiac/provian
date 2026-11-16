/**
 * GET /v1/ecosystem names the permanent protocol pointer and the current kernel
 * resolved through it. The retired predecessor appears only as history, and an
 * unverifiable pointer names no current kernel at all (Unknown = block), never
 * the predecessor in its place. Recourse is listed beside court and bonds.
 *
 * RED control: the predecessor-as-current assertions fail against the previous
 * document, whose `pvt9.address` named the retired token as the PVT address.
 */

import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import express, { type Express } from 'express';
import request from 'supertest';
import { createEcosystemRouter } from './ecosystem';

const KERNEL = '0x2Af3A065dc3c0c51b054Cb8C6BAEE7Df76189e0e';
const RECOURSE_POOL = '0x92e9c83D00000000000000000000000000000001';
const POINTER = '0x619eAe740CE56C5a8edbB2B047E58369281ddAD7';
const PREDECESSOR = '0x8811441914381143b9408c5C32247367F86F173A';

function appWith(currentDeployment: () => Promise<{ addresses: { kernel: string; recoursePool: string } }>): Express {
  const app = express();
  app.use('/v1/ecosystem', createEcosystemRouter(undefined, { currentDeployment }));
  return app;
}

describe('GET /v1/ecosystem — the current PVT token comes from the protocol pointer', () => {
  let priorLaunch: string | undefined;
  beforeAll(() => { priorLaunch = process.env.PUBLIC_LAUNCH; process.env.PUBLIC_LAUNCH = 'true'; });
  afterAll(() => { if (priorLaunch === undefined) delete process.env.PUBLIC_LAUNCH; else process.env.PUBLIC_LAUNCH = priorLaunch; });

  it('names the pointer and the verified current kernel; the predecessor only as retired history', async () => {
    const res = await request(appWith(async () => ({ addresses: { kernel: KERNEL, recoursePool: RECOURSE_POOL } }))).get('/v1/ecosystem');
    expect(res.status).toBe(200);
    expect(res.body.pvt9).toBeUndefined();
    expect(res.body.pvt).toMatchObject({
      network: { name: 'Base', chain_id: 8453 },
      protocol_pointer: POINTER,
      current_kernel: KERNEL,
      current_kernel_status: 'verified',
      predecessor: { address: PREDECESSOR, status: 'retired' },
    });
    // The predecessor address appears exactly once: in the retired-history block.
    expect(JSON.stringify(res.body).split(PREDECESSOR).length - 1).toBe(1);
  });

  it('an unverifiable pointer names no current kernel, never the predecessor in its place', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = await request(appWith(async () => { throw new Error('protocol_verification_unavailable'); })).get('/v1/ecosystem');
      expect(res.status).toBe(200);
      expect(res.body.pvt).toMatchObject({ protocol_pointer: POINTER, current_kernel: null, current_kernel_status: 'unavailable' });
      expect(res.body.services.recourse.recourse_pool).toBeNull();
      expect(JSON.stringify(res.body).split(PREDECESSOR).length - 1).toBe(1);
      expect(res.body.pvt.predecessor.status).toBe('retired');
    } finally {
      spy.mockRestore();
    }
  });

  it('lists Recourse beside court and bonds, with amounts left to the signed rule', async () => {
    const res = await request(appWith(async () => ({ addresses: { kernel: KERNEL, recoursePool: RECOURSE_POOL } }))).get('/v1/ecosystem');
    const services = res.body.services as Record<string, unknown>;
    const keys = Object.keys(services);
    expect(keys.indexOf('recourse')).toBe(keys.indexOf('bonds') + 1);
    expect(services.recourse).toMatchObject({
      status: 'live',
      membership: 'optional',
      recourse_pool: RECOURSE_POOL,
      public_endpoints: expect.arrayContaining(['GET /v1/recourse/membership-rules/:hash']),
    });
    const text = JSON.stringify(services.recourse).toLowerCase();
    expect(text).not.toContain('insurance');
    expect(text).not.toMatch(/\d+ ?%|\b100 pvt\b/);
  });
});
