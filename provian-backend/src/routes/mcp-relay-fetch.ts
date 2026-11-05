import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';

/**
 * Internal REST hop, with no extra execution/body deadline. Native fetch has a
 * headers timeout even without AbortSignal.timeout; a valid multi-proof REST
 * invocation can outlive it. The REST handler and service own execution limits.
 * This client does not follow redirects or buffer/cap the response body.
 */
export const fetchMcpRelay: typeof fetch = async (input, init) => {
  const request = new globalThis.Request(input, init);
  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Invalid relay protocol');
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
  return new Promise<globalThis.Response>((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const upstream = send(url, {
      method: request.method,
      headers: Object.fromEntries(request.headers),
      agent: false,
      timeout: 0,
      signal: request.signal,
    }, response => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, item);
      }
      const status = response.statusCode ?? 502;
      const stream = status === 204 || status === 205 || status === 304 ? null
        : Readable.toWeb(response) as ReadableStream<Uint8Array>;
      resolve(new globalThis.Response(stream, { status, headers }));
    });
    upstream.on('error', reject);
    upstream.end(body);
  });
};
