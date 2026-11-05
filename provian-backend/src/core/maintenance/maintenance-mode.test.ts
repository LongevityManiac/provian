import { describe, it, expect, jest } from '@jest/globals';
import type { NextFunction, Request, Response } from 'express';
import { maintenanceMiddleware } from './maintenance-mode';

function run(env: NodeJS.ProcessEnv, method: string) {
  const res = { statusCode: 200, headers: {} as Record<string, string>, body: undefined as unknown,
    setHeader(k: string, v: string) { this.headers[k] = v; },
    status(code: number) { this.statusCode = code; return this; },
    json(b: unknown) { this.body = b; return this; } };
  const next = jest.fn() as unknown as NextFunction;
  maintenanceMiddleware(env)({ method } as Request, res as unknown as Response, next);
  return { res, next: next as unknown as jest.Mock };
}

describe('relay maintenance switch ', () => {
  it('off: every request passes', () => {
    expect(run({}, 'POST').next).toHaveBeenCalled();
    expect(run({ RELAY_MAINTENANCE: '0' }, 'POST').next).toHaveBeenCalled();
  });
  it('on: a write answers 503 with Retry-After (a device keeps and re-sends its batch)', () => {
    const { res, next } = run({ RELAY_MAINTENANCE: '1' }, 'POST');
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('600');
    for (const m of ['PUT', 'PATCH', 'DELETE']) expect(run({ RELAY_MAINTENANCE: '1' }, m).res.statusCode).toBe(503);
  });
  it('on: reads still pass', () => {
    for (const m of ['GET', 'HEAD', 'OPTIONS']) expect(run({ RELAY_MAINTENANCE: '1' }, m).next).toHaveBeenCalled();
  });
});
