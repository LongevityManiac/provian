import type { RequestHandler } from 'express';

export const FIRESTORE_PROBE_DEADLINE_MS = 4_000;
export const REQUEST_DEADLINE_MS = 180_000;
export const SCHEDULED_REQUEST_DEADLINE_MS = 1_200_000;
export const BODY_DEADLINE_MS = 180_000;

/** An incomplete upload may close its own socket, never retire unrelated work. */
export function bodyDeadline(deadlineMs = BODY_DEADLINE_MS): RequestHandler {
  return (req, res, next) => {
    if (!req.complete) {
      const timer = setTimeout(() => {
        if (!res.headersSent) res.status(408).json({ error: 'request_body_deadline_exceeded' });
        req.destroy();
      }, deadlineMs);
      timer.unref();
      const clear = (): void => { clearTimeout(timer); };
      req.once('end', clear);
      req.once('aborted', clear);
      res.once('finish', clear);
    }
    next();
  };
}

/** A failed dependency check retires this process; only a fresh instance can recover. */
export class InstanceHealth {
  private failed = false;
  private checking: Promise<boolean> | undefined;
  public started = false;

  public constructor(private readonly roundTrip: () => Promise<unknown>) {}

  public get healthy(): boolean { return !this.failed; }

  public async check(): Promise<boolean> {
    if (this.failed) return false;
    if (this.checking) return this.checking;
    this.checking = this.probe();
    try { return await this.checking; }
    finally { this.checking = undefined; }
  }

  private async probe(): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(this.roundTrip),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('firestore_probe_deadline')), FIRESTORE_PROBE_DEADLINE_MS);
        }),
      ]);
      return true;
    } catch {
      this.failed = true;
      console.error('[instance-health] Firestore check failed; instance retired');
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  public readonly startup: RequestHandler = (_req, res) => {
    res.status(this.started && this.healthy ? 200 : 503).json({ status: this.started && this.healthy ? 'ok' : 'unavailable' });
  };

  public readonly liveness: RequestHandler = async (_req, res) => {
    const ok = this.started && await this.check();
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'unavailable' });
  };

  public readonly admit: RequestHandler = (_req, res, next) => {
    if (!this.started || !this.healthy) {
      res.setHeader('Retry-After', '5');
      res.status(503).json({ error: 'instance_unavailable' });
      return;
    }
    next();
  };
}

/**
 * Cloud Run's timeout only disconnects the caller. A response-only timer would
 * leave the handler free to write later. End this process synchronously instead;
 * durable outboxes and idempotency keys are the existing crash-recovery boundary.
 * The 503 is best effort: the platform may report a disconnected container as 502.
 */
export function requestDeadline(
  terminate: () => never = () => process.exit(1),
  deadlineMs?: number,
): RequestHandler {
  return (req, res, next) => {
    const routePath = req.path.toLowerCase(); // Express's static routes are case-insensitive.
    const scheduled = routePath.startsWith('/v1/internal/scheduler/')
      || routePath.startsWith('/v1/internal/settlement/')
      || /^\/v1\/internal\/tasks\/github\/?$/.test(routePath);
    const timer = setTimeout(() => {
      console.error('[request-deadline] terminating overdue instance', req.method, req.path);
      try {
        if (!res.headersSent) res.status(503).json({ error: 'request_deadline_exceeded' });
      } finally {
        terminate();
      }
    }, deadlineMs ?? (scheduled ? SCHEDULED_REQUEST_DEADLINE_MS : REQUEST_DEADLINE_MS));
    timer.unref();
    res.once('finish', () => clearTimeout(timer));
    // A disconnected client does not mean its handler stopped running.
    next();
  };
}
