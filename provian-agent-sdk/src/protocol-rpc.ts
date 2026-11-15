/** Public RPC reads share one paced lane per endpoint, including across transport
 * factories. Verification still reads both providers and never reuses a result. */
type RpcFetch = (url: string, init: RequestInit) => Promise<Response>;
interface Lane { tail: Promise<void>; nextAt: number }
const lanes = new Map<string, Lane>();
// Public endpoint limits can be stricter than the advertised account limit.
const spacingMs = 1_000;
const maxRetryDelayMs = 30_000;
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function retryDelay(value: string | null, attempt: number): number {
  if (value === null) return 5_000 * 2 ** attempt;
  const delay = /^\d+(?:\.\d+)?$/.test(value.trim())
    ? Number(value) * 1_000 : Date.parse(value) - Date.now();
  // Never retry earlier than the provider requests, or wait without a bound.
  if (!Number.isFinite(delay)) throw new Error('protocol_rpc_unavailable');
  return Math.max(spacingMs, delay);
}

export function protocolRpc(url: string, fetcher: RpcFetch): {
  request(method: string, params: readonly unknown[]): Promise<unknown>;
} {
  let lane = lanes.get(url);
  if (!lane) { lane = { tail: Promise.resolve(), nextAt: 0 }; lanes.set(url, lane); }
  const endpoint = lane;
  return { request(method, params) {
    const work = endpoint.tail.then(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        while (endpoint.nextAt > Date.now()) {
          if (endpoint.nextAt - Date.now() > maxRetryDelayMs) throw new Error('protocol_rpc_unavailable');
          await sleep(endpoint.nextAt - Date.now());
        }
        endpoint.nextAt = Date.now() + spacingMs;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20_000);
        try {
          const response = await fetcher(url, { method: 'POST', redirect: 'error',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
            signal: controller.signal });
          if (response.status === 429) {
            // Consume the response before another request uses the connection.
            await response.text();
            // Even an invalid or too-long delay must not let queued reads bypass
            // the cooldown after this individual request refuses to wait.
            endpoint.nextAt = Date.now() + maxRetryDelayMs;
            endpoint.nextAt = Date.now() + retryDelay(response.headers.get('retry-after'), attempt);
            if (endpoint.nextAt - Date.now() > maxRetryDelayMs) throw new Error('protocol_rpc_unavailable');
            if (attempt < 2) continue;
          }
          if (!response.ok) throw new Error('protocol_rpc_unavailable');
          const reply: unknown = await response.json();
          if (!reply || typeof reply !== 'object' || 'error' in reply || !('result' in reply)) {
            throw new Error('protocol_rpc_invalid');
          }
          return reply.result;
        } finally { clearTimeout(timeout); }
      }
      throw new Error('protocol_rpc_unavailable');
    });
    // One failed read must not poison later independent verification attempts.
    endpoint.tail = work.then(() => {}, () => {});
    return work;
  } };
}
