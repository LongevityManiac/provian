/**
 * — the relay's maintenance switch for the database move (: devices
 * queue during cutover, nothing lost).
 *
 * While `RELAY_MAINTENANCE=1`, every request that could write answers 503 with `Retry-After`, so the
 * database being copied cannot change under the copy. Reads (GET/HEAD/OPTIONS) still answer from the
 * database being copied. The device and phone batches are built for exactly this: on a 5xx the SAME
 * batch stays in flight on the device and is re-sent later (`provian-agent-sdk/src/meter/batcher.ts`),
 * so a PE is never lost — it waits on its owner's device. Scheduler jobs get the same 503 and run on
 * their next tick.
 */
import type { NextFunction, Request, Response } from 'express';

export const MAINTENANCE_ENV = 'RELAY_MAINTENANCE';
export const MAINTENANCE_RETRY_AFTER_SECONDS = 600;
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function maintenanceActive(env: NodeJS.ProcessEnv): boolean {
  return env[MAINTENANCE_ENV] === '1';
}

export function maintenanceMiddleware(env: NodeJS.ProcessEnv = process.env) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!maintenanceActive(env) || READ_METHODS.has(req.method.toUpperCase())) {
      next();
      return;
    }
    res.setHeader('Retry-After', String(MAINTENANCE_RETRY_AFTER_SECONDS));
    res.status(503).json({
      error: 'maintenance',
      retry_after: MAINTENANCE_RETRY_AFTER_SECONDS,
      message: 'The relay is moving its database. Nothing is lost: devices keep their batches and re-send them; try again in a few minutes.',
    });
  };
}
