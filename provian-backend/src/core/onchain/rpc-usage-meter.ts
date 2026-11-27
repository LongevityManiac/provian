/**
 * RPC USAGE METER — which request spends which JSON-RPC calls.
 *
 * Provider bills are per call and per method. Relay JSON-RPC through ethers enters
 * through `JsonRpcProvider.send` (the relay's own provider class inherits it;
 * ethers' internal `_perform` reaches it too); the few paths that post JSON-RPC
 * with a plain fetch (the app's RPC proxy, the swap route's Solana reads, the
 * facilitator's Solana reader, the legacy mint reader) call `recordRpcCalls`
 * before they send. The ethers entry runs synchronously in
 * the caller's async context, before ethers queues the call and sends a batch from
 * a shared timer, so each call is counted in the request that made it, even when
 * concurrent requests share one provider. One structured log line is written per
 * request that made any call. Scheduled jobs are requests too, so the line names
 * the job. A transport retry of the same call is not counted again.
 *
 * It observes only: it never changes, delays or drops a call, and a fault in
 * the meter itself is swallowed. The provider label comes from the URL's host
 * alone (`base-mainnet.alchemy`, `drpc`, …); the URL itself, which can carry an
 * API key in its path, is never read into a label or a log.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';
import { JsonRpcProvider } from 'ethers';

type Counts = Map<string, number>;
const usage = new AsyncLocalStorage<Counts>();
let installed = false;

const HOST_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['drpc.org', 'drpc'], ['drpc.live', 'drpc'], ['infura.io', 'infura'], ['quicknode.pro', 'quicknode'],
  ['mainnet.base.org', 'base-foundation'], ['arb1.arbitrum.io', 'offchain-labs'], ['mainnet.optimism.io', 'optimism-foundation'],
  ['publicnode.com', 'publicnode'],
];

/** A provider label from the host only: `<network>.alchemy` for Alchemy, a known operator id, else `other`. */
export function rpcHostLabel(url: string): string {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return 'other'; }
  if (host === 'alchemy.com' || host.endsWith('.alchemy.com')) {
    const network = host.split('.')[0];
    return /^[a-z0-9-]{1,40}$/.test(network) ? `${network}.alchemy` : 'alchemy';
  }
  for (const [suffix, label] of HOST_LABELS) if (host === suffix || host.endsWith(`.${suffix}`)) return label;
  return 'other';
}

function count(provider: JsonRpcProvider, method: unknown): void {
  const counts = usage.getStore();
  if (!counts) return;
  const label = rpcHostLabel(provider._getConnection().url);
  const key = `${label} ${typeof method === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(method) ? method : 'unknown'}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/** Count calls a plain-fetch JSON-RPC path is about to send (one per method; a batch lists each). */
export function recordRpcCalls(url: string, methods: readonly unknown[]): void {
  try {
    const counts = usage.getStore();
    if (!counts) return;
    const label = rpcHostLabel(url);
    for (const method of methods) {
      const key = `${label} ${typeof method === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(method) ? method : 'unknown'}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  } catch { /* the meter never affects a call */ }
}

/** Patch `JsonRpcProvider.send` once, at startup. */
export function installRpcUsageMeter(): void {
  if (installed) return;
  installed = true;
  const original = JsonRpcProvider.prototype.send;
  JsonRpcProvider.prototype.send = function meteredSend(this: JsonRpcProvider, method: string, params: Array<unknown> | Record<string, unknown>) {
    try { count(this, method); } catch { /* the meter never affects a call */ }
    return original.call(this, method, params);
  };
}

/** The request's route, as a template where Express matched one (no ids in the label). */
function routeLabel(req: Request): string {
  const template = req.route && typeof req.route.path === 'string' ? `${req.baseUrl}${req.route.path}` : null;
  const path = template ?? req.path.split('/').slice(0, 5).map(part => (/^[a-z][a-z0-9-]{0,40}$/.test(part) || part === '' ? part : ':id')).join('/');
  return `${req.method} ${path}`;
}

/** Run each request in its own count; log the counts when the response finishes. */
export function rpcUsageMiddleware(req: Request, res: Response, next: NextFunction): void {
  const counts: Counts = new Map();
  res.on('finish', () => {
    if (counts.size === 0) return;
    try {
      const calls = Object.fromEntries([...counts.entries()].sort());
      const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
      console.log(JSON.stringify({ message: 'rpc_usage', rpc_usage: { route: routeLabel(req), status: res.statusCode, total, calls } }));
    } catch { /* never fail a response over its meter line */ }
  });
  usage.run(counts, next);
}

/** Tests: count the calls made inside `fn`. */
export async function withRpcUsage<T>(fn: () => Promise<T>): Promise<{ result: T; calls: Record<string, number> }> {
  const counts: Counts = new Map();
  const result = await usage.run(counts, fn);
  return { result, calls: Object.fromEntries(counts) };
}
