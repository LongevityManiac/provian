import dns from 'dns';
import http from 'http';
import https from 'https';
import net, { type LookupFunction } from 'net';
import { createGunzip } from 'zlib';
import { makeError, type FetchGetUrlFunc, type GetUrlResponse } from 'ethers';
import { isPrivateIp } from '../net/private-ip';

/** Resolve once at connection time; the socket uses these validated addresses. */
export const publicRpcLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { all: true }, (error, addresses) => {
    if (error) { callback(error, '', 4); return; }
    if (!addresses.length || addresses.some(entry => isPrivateIp(entry.address))) {
      callback(new Error('rpc_private_destination'), '', 4); return;
    }
    // Node 20 asks for every address when selecting an IP family.
    if (typeof options === 'object' && options !== null && options.all) {
      callback(null, addresses);
    } else callback(null, addresses[0].address, addresses[0].family);
  });
};

/** The FetchRequest layer retains redirects, throttle retries and RPC errors.
 * This transport refuses redirects and assembles response chunks once, decompressing asynchronously,
 * instead of copying every previous byte for every incoming network chunk. */
export const linearRpcGetUrl: FetchGetUrlFunc = async (req, signal): Promise<GetUrlResponse> => {
  signal?.checkSignal();
  const url = new URL(req.url), host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw makeError('unsupported RPC protocol', 'UNSUPPORTED_OPERATION', { operation: 'request' });
  if (net.isIP(host) && isPrivateIp(host)) throw new Error('rpc_private_destination');
  if (url.protocol !== 'https:' && req.credentials && !req.allowInsecureAuthentication) {
    throw makeError('insecure authorized connections unsupported', 'UNSUPPORTED_OPERATION', { operation: 'request' });
  }
  return new Promise<GetUrlResponse>((resolve, reject) => {
    let done = false;
    let response: http.IncomingMessage | undefined;
    let decoded: ReturnType<typeof createGunzip> | undefined;
    const chunks: Buffer[] = []; let bytes = 0;
    const finish = (error?: Error, result?: GetUrlResponse): void => {
      if (done) return; done = true; clearTimeout(timer);
      chunks.length = 0;
      if (error) {
        decoded?.destroy(); response?.destroy(); request.destroy(); reject(error);
      } else if (result) resolve(result);
    };
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: req.method, headers: req.headers, lookup: publicRpcLookup,
    });
    const timer = setTimeout(() => finish(makeError('request timeout', 'TIMEOUT')), req.timeout);
    timer.unref();
    signal?.addListener(() => finish(makeError('request cancelled', 'CANCELLED')));
    request.on('error', (error: Error) => finish(error));
    request.on('response', incoming => {
      if (done) { incoming.destroy(); return; }
      response = incoming;
      if ((incoming.statusCode ?? 0) >= 300 && (incoming.statusCode ?? 0) < 400) {
        finish(new Error('rpc_redirect_refused')); return;
      }
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(incoming.headers)) headers[key] = Array.isArray(value) ? value.join(', ') : value ?? '';
      incoming.on('aborted', () => finish(new Error('rpc_response_aborted')));
      incoming.on('error', (error: Error) => finish(error));
      const stream = headers['content-encoding'] === 'gzip' ? (decoded = createGunzip()) : incoming;
      if (decoded) incoming.pipe(decoded);
      stream.on('error', (error: Error) => finish(error));
      stream.on('data', (chunk: Buffer) => { if (!done) { chunks.push(chunk); bytes += chunk.length; } });
      stream.on('end', () => {
        if (done) return;
        const body = bytes ? Buffer.concat(chunks, bytes) : null;
        finish(undefined, { statusCode: incoming.statusCode ?? 0, statusMessage: incoming.statusMessage ?? '', headers, body });
      });
    });
    const body = req.body;
    if (body) request.write(body);
    request.end();
  });
};
