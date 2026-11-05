/** Fresh, DNS-pinned sockets, including approved forward-proxy CONNECT tunnels. */
import * as http from 'node:http';
import * as https from 'node:https';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import { buildConnector } from 'undici';
import { lookup } from 'node:dns/promises';
import type { HostResolver } from './egress-guard';

export function pinnedLookup(hostname: string, addresses: readonly string[]): LookupFunction {
  return (host, opts, callback) => {
    if (host.replace(/^\[|\]$/g, '') !== hostname.replace(/^\[|\]$/g, '')) { callback(new Error('egress lookup host mismatch'), '', 4); return; }
    const matches = addresses.map(address => ({ address, family: isIP(address) }))
      .filter(a => !opts.family || opts.family === a.family);
    if (!matches.length) { callback(new Error('egress address family unavailable'), '', 4); return; }
    if (opts.all) callback(null, matches);
    else callback(null, matches[0].address, matches[0].family);
  };
}

/** The forward proxy that carries a request to `url`, honouring NO_PROXY; undefined when none. */
export function proxyFor(url: URL): string | undefined {
  const excluded = (process.env.no_proxy || process.env.NO_PROXY || '').split(',').some(raw => {
    const entry = raw.trim().toLowerCase();
    if (!entry) return false;
    if (entry === '*') return true;
    const host = url.hostname.toLowerCase();
    if (entry === host || entry === url.host.toLowerCase()) return true;
    const suffix = entry.replace(/^\*?\./, '');
    return host === suffix || host.endsWith(`.${suffix}`);
  });
  if (excluded) return undefined;
  return url.protocol === 'https:' ? process.env.https_proxy || process.env.HTTPS_PROXY : process.env.http_proxy || process.env.HTTP_PROXY;
}

/**
 * The forward proxy as a URL, read as curl reads it: a value with no scheme
 * (`proxy.local:3128`, `127.0.0.1:3128`) means http://. Null for anything other than an
 * http:// or https:// proxy (Provian speaks only HTTP CONNECT to a proxy).
 */
export function proxyUrlOf(value: string): URL | null {
  const raw = value.trim();
  if (!raw) return null;
  let parsed: URL;
  try { parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`); } catch { return null; }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
}

/**
 * The proxy's addresses. The forward proxy is the OPERATOR's own egress hop — an environment
 * variable only the box's operator sets, and commonly a host on the local network — so the SSRF
 * block does not apply to it: what the guard approved is the TARGET, and CONNECT names the approved
 * target IP. The proxy host is still resolved here, once, and the proxy socket pinned to that
 * answer, so nothing re-resolves it in transit. (Before 2026-10-17 the proxy went through the
 * target guard, which refused every private-network proxy — the corporate deployment.)
 */
async function resolveProxyAddresses(hostname: string, resolveHost?: HostResolver): Promise<string[]> {
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (isIP(bare)) return [bare];
  try {
    const ips = resolveHost ? await resolveHost(bare) : (await lookup(bare, { all: true })).map(r => r.address);
    return ips.filter(ip => isIP(ip) !== 0);
  } catch {
    return [];
  }
}

/** The target is approved and the proxy socket pinned; CONNECT names an IP, never remote DNS. */
export async function pinnedConnector(url: URL, addresses: readonly string[], resolveHost?: HostResolver): Promise<buildConnector.connector> {
  const direct = buildConnector({ lookup: pinnedLookup(url.hostname, addresses) });
  const proxyValue = proxyFor(url);
  if (!proxyValue) return direct;
  const proxy = proxyUrlOf(proxyValue);
  if (!proxy) throw new Error('egress proxy protocol refused');
  const proxyIps = await resolveProxyAddresses(proxy.hostname, resolveHost);
  if (proxyIps.length === 0) throw new Error('egress proxy refused');
  return (options, callback) => {
    const agent = proxy.protocol === 'https:' ? new https.Agent({ keepAlive: false }) : new http.Agent({ keepAlive: false });
    const address = addresses[0], port = options.port || (url.protocol === 'https:' ? '443' : '80');
    const authority = `${isIP(address) === 6 ? `[${address}]` : address}:${port}`;
    const headers: Record<string, string> = { host: authority };
    if (proxy.username || proxy.password) headers['proxy-authorization'] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`;
    const transport = proxy.protocol === 'https:' ? https : http;
    const request = transport.request(proxy, { method: 'CONNECT', path: authority, headers, agent, lookup: pinnedLookup(proxy.hostname, proxyIps), timeout: 10_000 });
    let finished = false;
    const finish: buildConnector.Callback = (err, socket) => {
      if (finished) return; finished = true;
      if (err) { agent.destroy(); callback(err, null); }
      else callback(null, socket!);
    };
    request.on('timeout', () => request.destroy(new Error('egress proxy connection timed out')));
    request.on('error', err => finish(err, null));
    request.on('connect', (response, socket, head) => {
      if (response.statusCode !== 200 || head.length) { socket.destroy(); finish(new Error('egress proxy tunnel refused'), null); return; }
      // An IP-literal target (the DNS-over-HTTPS resolvers) sends no SNI (RFC 6066) and is
      // verified against the certificate's IP SAN instead.
      const bare = url.hostname.replace(/^\[|\]$/g, '');
      if (url.protocol === 'https:') direct({ ...options, httpSocket: socket, ...(isIP(bare) ? {} : { servername: url.hostname }) }, finish);
      else finish(null, socket);
    });
    request.end();
  };
}
