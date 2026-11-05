/**
 * POST /api/proxy/alchemy/rpc/:network — the wallet's keyed Alchemy JSON-RPC proxy
 * (EVM + Solana clusters), wallet-auth'd, with the API key added server-side.
 *
 * bounds it on both sides:
 * - REQUEST: a JSON-RPC batch is capped at ALCHEMY_RPC_MAX_BATCH calls (400 over the
 * cap, and an empty batch is refused), and EVERY call in a batch is charged against
 * the per-user proxy rate limit. Before, a ~1,000-call batch (express.json's 100 kB
 * fits that many small calls) was forwarded verbatim and counted as ONE hit.
 * - RESPONSE: the upstream exchange runs under one deadline across connect + headers
 * + the whole body, and the body is capped at ALCHEMY_RPC_MAX_RESPONSE_BYTES —
 * aborted past the cap (502), never buffered whole (core/net/bounded-fetch.ts).
 *
 * Cap rationale (measured against real callers, not guessed):
 * - Batch: no first-party caller sends a batch at all. The app's two callers
 * (TransactionHistoryService.alchemyRpc, SolanaRpc.call) each POST exactly one
 * `{jsonrpc, method, params, id}` object; parallelism is Promise.all over single
 * calls. 20 leaves headroom for a future small batch while holding the fan-out of
 * one request to one-fifth of the per-minute budget.
 * - Response: the largest first-party call is alchemy_getAssetTransfers at
 * maxCount 0x32 (50 transfers with metadata, tens of kB); the Solana calls
 * (getTransaction jsonParsed, getSignaturesForAddress limit 25) are smaller still.
 * 5 MiB is ~50x the largest legitimate answer and bounds what one hostile/buggy
 * upstream answer can make the relay hold.
 */

import type { Request, Response } from 'express';
import { ResponseTooLargeError } from '../core/net/bounded-fetch';

/** Max JSON-RPC calls in one batched request. */
export const ALCHEMY_RPC_MAX_BATCH = 20;
/** Max upstream response body the proxy will read (5 MiB). */
export const ALCHEMY_RPC_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

type FetchInit = Parameters<typeof fetch>[1];
type FetchResponse = Awaited<ReturnType<typeof fetch>>;

export interface AlchemyRpcProxyDeps {
  /** Hostname slug for a network, or null when the network is not served. */
  upstreamUrlFor: (network: string) => string | null;
  /** True when the Alchemy API key is configured. */
  apiKeyConfigured: () => boolean;
  /** Per-user proxy rate limit; `cost` units are charged against `maxRequests`. */
  checkProxyRateLimit: (userId: string, service: string, maxRequests: number, cost?: number) => Promise<boolean>;
  rateLimitPerMin: number;
  /** A bounded fetch: one deadline over the whole exchange + a body byte cap. */
  fetch: (url: string, init: FetchInit, maxBytes: number) => Promise<FetchResponse>;
  forwardUpstreamResponse: (res: Response, upstream: { ok: boolean; status: number }, body: unknown) => void;
  isUpstreamTimeout: (err: unknown) => boolean;
  logError: (label: string, err: unknown) => void;
}

export type RpcBodyVerdict =
  | { ok: true; cost: number }
  | { ok: false; error: string; code: 'RPC_BATCH_TOO_LARGE' | 'RPC_BATCH_EMPTY' };

/** How many rate-limit units a request body costs, or why it is refused. */
export function classifyRpcBody(body: unknown): RpcBodyVerdict {
  if (!Array.isArray(body)) return { ok: true, cost: 1 };
  if (body.length === 0) {
    return { ok: false, error: 'Empty JSON-RPC batch', code: 'RPC_BATCH_EMPTY' };
  }
  if (body.length > ALCHEMY_RPC_MAX_BATCH) {
    return {
      ok: false,
      error: `JSON-RPC batch exceeds ${ALCHEMY_RPC_MAX_BATCH} calls`,
      code: 'RPC_BATCH_TOO_LARGE',
    };
  }
  return { ok: true, cost: body.length };
}

export function createAlchemyRpcHandler(deps: AlchemyRpcProxyDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user!.id;
      const upstreamUrl = deps.upstreamUrlFor(req.params.network);
      if (upstreamUrl === null) {
        res.status(400).json({ error: 'Invalid network', code: 'INVALID_NETWORK' });
        return;
      }

      const verdict = classifyRpcBody(req.body);
      if (!verdict.ok) {
        res.status(400).json({ error: verdict.error, code: verdict.code, max_batch: ALCHEMY_RPC_MAX_BATCH });
        return;
      }

      if (!(await deps.checkProxyRateLimit(userId, 'alchemy_rpc', deps.rateLimitPerMin, verdict.cost))) {
        res.status(429).json({ error: 'Rate limit exceeded', code: 'RATE_LIMITED' });
        return;
      }

      if (!deps.apiKeyConfigured()) {
        console.error('[Proxy] Alchemy API key not configured');
        res.status(503).json({ error: 'Service not configured', code: 'SERVICE_UNAVAILABLE' });
        return;
      }

      const upstream = await deps.fetch(
        upstreamUrl,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req.body),
        },
        ALCHEMY_RPC_MAX_RESPONSE_BYTES,
      );
      // The body is already fully read inside the bounded fetch; this parse is instant.
      const data: unknown = await upstream.json();

      // Pass through upstream 4xx status + sanitized body (user-actionable errors like
      // Alchemy free-tier limits); translate 5xx to an opaque 502.
      deps.forwardUpstreamResponse(res, upstream, data);
    } catch (error) {
      if (deps.isUpstreamTimeout(error)) {
        res.status(504).json({ error: 'Upstream timed out', code: 'UPSTREAM_TIMEOUT' });
        return;
      }
      if (error instanceof ResponseTooLargeError) {
        res.status(502).json({ error: 'Upstream response too large', code: 'UPSTREAM_RESPONSE_TOO_LARGE' });
        return;
      }
      deps.logError('[Proxy] Alchemy RPC error:', error);
      res.status(500).json({ error: 'Proxy request failed', code: 'PROXY_ERROR' });
    }
  };
}
