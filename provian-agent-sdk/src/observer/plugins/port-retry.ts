import type * as http from 'http';

/** After a stray observer is stopped: how often, and for how long, a waiting lane tries its port. */
export const PORT_RETRY_BURST_MS = 2_000;
export const PORT_RETRY_BURST_ATTEMPTS = 30; // 60 s: past a stray's bounded 15 s shutdown

/**
 * Bind a lane's loopback server once at start. When the port is taken the lane WAITS: it does not
 * contend for it on its own (a user's own collector restarting must never lose its port to us). It
 * tries again only when `retry()` is called — by the lock holder right after it stopped a stray
 * observer that held the port (follow-up, review rounds 4–5) — in a burst of
 * `PORT_RETRY_BURST_ATTEMPTS` tries every `PORT_RETRY_BURST_MS`, then waits again. `first` settles
 * after the first attempt, bound or not, so a daemon's start never waits on a port.
 */
export function listenWithRetry(opts: {
  create: () => http.Server;
  port: number;
  host: string;
  onBound: (server: http.Server) => void;
  /** The port is taken; `first` is true for the start attempt only (log once, not every retry). */
  onInUse: (first: boolean) => void;
  /** Any other listen failure: the lane stays down (a wrong address does not fix itself). */
  onError: (err: NodeJS.ErrnoException) => void;
  burstMs?: number;
  burstAttempts?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): { first: Promise<void>; retry: () => void; cancel: () => void } {
  const burstMs = opts.burstMs ?? PORT_RETRY_BURST_MS;
  const burstAttempts = opts.burstAttempts ?? PORT_RETRY_BURST_ATTEMPTS;
  const setTimer = opts.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  let state: 'binding' | 'waiting' | 'bound' | 'failed' | 'cancelled' = 'binding';
  let left = 0;
  let timer: unknown = null;
  const attempt = (first: boolean): Promise<void> => new Promise<void>((resolve) => {
    if (state === 'cancelled') { resolve(); return; }
    state = 'binding';
    const server = opts.create();
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener('error', onError);
      if (state === 'cancelled') { resolve(); return; }
      if (err.code === 'EADDRINUSE') {
        state = 'waiting';
        opts.onInUse(first);
        if (left > 0) { left -= 1; timer = setTimer(() => { timer = null; void attempt(false); }, burstMs); }
      } else {
        state = 'failed';
        opts.onError(err);
      }
      resolve();
    };
    server.once('error', onError);
    server.listen(opts.port, opts.host, () => {
      server.removeListener('error', onError);
      if (state === 'cancelled') { server.close(); resolve(); return; }
      state = 'bound';
      opts.onBound(server);
      resolve();
    });
  });
  return {
    first: attempt(true),
    retry: () => {
      if (state !== 'waiting' || timer !== null) { if (state === 'waiting') left = burstAttempts - 1; return; }
      left = burstAttempts - 1;
      void attempt(false);
    },
    cancel: () => {
      state = 'cancelled';
      if (timer !== null) { clearTimer(timer); timer = null; }
    },
  };
}
