/**
 * SSRF egress guard (SDK-side enforcement).
 *
 * WS3 audit fix. The architecture promised that non-payment agent egress was
 * SSRF/IP-pinning enforced, but the device-side gate that was supposed to do it
 * had zero callers and the agent performed the fetch itself with no checks.
 * Enforcement belongs where the fetch actually happens — here, in the SDK. (The
 * unwired device module was deleted outright in; this is the only egress
 * enforcement point, not a second one.)
 *
 * This is a self-contained port of the device SSRFValidator's synchronous
 * classifier (src/core/credentials/proxy/SSRFValidator.ts), plus an async
 * resolve-and-recheck step with an INJECTABLE resolver so it is portable
 * (Node `dns` by default) and unit-testable (DNS-rebinding can be exercised by
 * injecting a resolver that returns a private IP for a public-looking host).
 *
 * `guarded-fetch.ts` binds these exact addresses to the connection's lookup while
 * retaining the original hostname for TLS/SNI and Host. Empty/failed DNS is refused.
 */

const IPV4_REGEX = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
const IPV6_REGEX = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^(?:[0-9a-fA-F]{1,4}:){1,7}:$|^(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}$|^(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}$|^(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}$|^(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}$|^(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}$|^[0-9a-fA-F]{1,4}:(?::[0-9a-fA-F]{1,4}){1,6}$|^:(?::[0-9a-fA-F]{1,4}){1,7}$|^::$/;

function isValidIPAddress(value: string): boolean {
  if (!value || typeof value !== 'string') return false;
  const t = value.trim();
  return IPV4_REGEX.test(t) || IPV6_REGEX.test(t);
}

const BLOCKED_IPV4_RANGES: Array<{ start: string; end: string; name: string }> = [
  { start: '127.0.0.0', end: '127.255.255.255', name: 'loopback' },
  { start: '10.0.0.0', end: '10.255.255.255', name: 'private-class-a' },
  { start: '172.16.0.0', end: '172.31.255.255', name: 'private-class-b' },
  { start: '192.168.0.0', end: '192.168.255.255', name: 'private-class-c' },
  { start: '169.254.0.0', end: '169.254.255.255', name: 'link-local' },
  { start: '0.0.0.0', end: '0.255.255.255', name: 'current-network' },
  { start: '255.255.255.255', end: '255.255.255.255', name: 'broadcast' },
  { start: '100.64.0.0', end: '100.127.255.255', name: 'shared-address-space' },
  { start: '198.18.0.0', end: '198.19.255.255', name: 'benchmark-testing' },
  { start: '240.0.0.0', end: '255.255.255.254', name: 'reserved-future' },
  { start: '224.0.0.0', end: '239.255.255.255', name: 'multicast' },
];

const BLOCKED_HOSTNAMES = new Set([
  'localhost', 'localhost.localdomain', '127.0.0.1', '::1', '[::1]', '0.0.0.0',
  '169.254.169.254', 'metadata.google.internal',
]);

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    const num = parseInt(part, 10);
    if (isNaN(num) || num < 0 || num > 255) return null;
    result = (result << 8) + num;
  }
  return result >>> 0;
}

function normalizeIpAddress(input: string): string | null {
  if (IPV4_REGEX.test(input)) return input;
  if (/^\d+$/.test(input)) {
    const num = parseInt(input, 10);
    if (num >= 0 && num <= 0xFFFFFFFF) {
      return [(num >>> 24) & 0xFF, (num >>> 16) & 0xFF, (num >>> 8) & 0xFF, num & 0xFF].join('.');
    }
    return null;
  }
  if (/^0x[0-9a-fA-F]+$/.test(input)) {
    const num = parseInt(input, 16);
    if (num >= 0 && num <= 0xFFFFFFFF) {
      return [(num >>> 24) & 0xFF, (num >>> 16) & 0xFF, (num >>> 8) & 0xFF, num & 0xFF].join('.');
    }
    return null;
  }
  const parts = input.split('.');
  if (parts.length >= 1 && parts.length <= 4) {
    const octets: number[] = [];
    for (const part of parts) {
      let val: number;
      if (part.startsWith('0x') || part.startsWith('0X')) val = parseInt(part, 16);
      else if (part.startsWith('0') && part.length > 1) val = parseInt(part, 8);
      else val = parseInt(part, 10);
      if (isNaN(val) || val < 0) return null;
      octets.push(val);
    }
    if (octets.length === 1 && octets[0] <= 0xFFFFFFFF) {
      const n = octets[0];
      return [(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF].join('.');
    }
    if (octets.length === 2 && octets[0] <= 0xFF && octets[1] <= 0xFFFFFF) {
      return [octets[0], (octets[1] >>> 16) & 0xFF, (octets[1] >>> 8) & 0xFF, octets[1] & 0xFF].join('.');
    }
    if (octets.length === 3 && octets[0] <= 0xFF && octets[1] <= 0xFF && octets[2] <= 0xFFFF) {
      return [octets[0], octets[1], (octets[2] >>> 8) & 0xFF, octets[2] & 0xFF].join('.');
    }
    if (octets.length === 4 && octets.every(o => o <= 0xFF)) return octets.join('.');
  }
  return null;
}

function isBlockedIPv4(ip: string): { blocked: boolean; reason?: string } {
  if (ip.includes(':')) return { blocked: false };
  const normalized = normalizeIpAddress(ip);
  if (normalized && normalized !== ip) return isBlockedIPv4(normalized);
  const ipInt = ipv4ToInt(ip);
  if (ipInt === null) return { blocked: false };
  for (const range of BLOCKED_IPV4_RANGES) {
    const s = ipv4ToInt(range.start);
    const e = ipv4ToInt(range.end);
    if (s !== null && e !== null && ipInt >= s && ipInt <= e) {
      return { blocked: true, reason: `IP ${ip} is in blocked range: ${range.name}` };
    }
  }
  return { blocked: false };
}

function looksLikePrivateHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  const m = lower.match(/(?:^|[.-])(\d{1,3})[.-](\d{1,3})[.-](\d{1,3})[.-](\d{1,3})(?:[.-]|$)/);
  if (m && isBlockedIPv4(`${m[1]}.${m[2]}.${m[3]}.${m[4]}`).blocked) return true;
  if (lower.includes('localhost') || lower.includes('127.0.0.1') || lower.includes('0.0.0.0')) return true;
  if (lower.endsWith('.local') || lower.endsWith('.internal') || lower.endsWith('.corp') ||
      lower.endsWith('.home') || lower.endsWith('.lan')) return true;
  return false;
}

function parseIPv6(ip: string): { segments: number[]; isIPv4Mapped: boolean; mappedIPv4?: string } | null {
  let cleanIp = ip.replace(/^\[|\]$/g, '');
  const mapped = cleanIp.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mapped) return { segments: [0, 0, 0, 0, 0, 0xFFFF, 0, 0], isIPv4Mapped: true, mappedIPv4: mapped[1] };
  if (cleanIp.includes('::')) {
    const parts = cleanIp.split('::');
    if (parts.length > 2) return null;
    const left = parts[0] ? parts[0].split(':') : [];
    const right = parts[1] ? parts[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    cleanIp = [...left, ...Array(missing).fill('0'), ...right].join(':');
  }
  const segStrs = cleanIp.split(':');
  if (segStrs.length !== 8) return null;
  const segments: number[] = [];
  for (const seg of segStrs) {
    const num = parseInt(seg, 16);
    if (isNaN(num) || num < 0 || num > 0xFFFF) return null;
    segments.push(num);
  }
  return { segments, isIPv4Mapped: false };
}

function isBlockedIPv6(ip: string): { blocked: boolean; reason?: string } {
  const parsed = parseIPv6(ip);
  if (!parsed) return { blocked: false };
  if (parsed.isIPv4Mapped && parsed.mappedIPv4) {
    const c = isBlockedIPv4(parsed.mappedIPv4);
    if (c.blocked) return { blocked: true, reason: `IPv4-mapped IPv6: ${c.reason}` };
  }
  const s = parsed.segments;
  const firstFiveZero = s[0] === 0 && s[1] === 0 && s[2] === 0 && s[3] === 0 && s[4] === 0;
  const embedded = `${s[6] >> 8}.${s[6] & 0xFF}.${s[7] >> 8}.${s[7] & 0xFF}`;
  if (firstFiveZero && s[5] === 0xFFFF) {
    const c = isBlockedIPv4(embedded);
    if (c.blocked) return { blocked: true, reason: `IPv4-mapped IPv6: ${c.reason}` };
  }
  if (firstFiveZero && s[5] === 0 && (s[6] !== 0 || s[7] !== 0)) {
    if (!(s[6] === 0 && s[7] === 1)) {
      const c = isBlockedIPv4(embedded);
      if (c.blocked) return { blocked: true, reason: `IPv4-compatible IPv6: ${c.reason}` };
    }
  }
  // IPv4-translated (SIIT, ::ffff:0:a.b.c.d): the same embedded address one segment further along
  // (the form parsed as an ordinary public IPv6 address).
  if (s[0] === 0 && s[1] === 0 && s[2] === 0 && s[3] === 0 && s[4] === 0xFFFF && s[5] === 0) {
    const c = isBlockedIPv4(embedded);
    if (c.blocked) return { blocked: true, reason: `IPv4-translated IPv6: ${c.reason}` };
  }
  // NAT64 (64:ff9b::/96 well-known, 64:ff9b:1::/48 local-use) and 6to4 (2002::/16) carry an IPv4
  // address inside the IPv6 one; a private v4 reached that way is the same private host.
  if (s[0] === 0x0064 && s[1] === 0xFF9B && ((s[2] === 0 && s[3] === 0 && s[4] === 0 && s[5] === 0) || s[2] === 1)) {
    const c = isBlockedIPv4(embedded);
    if (c.blocked) return { blocked: true, reason: `NAT64 IPv6: ${c.reason}` };
  }
  if (s[0] === 0x2002) {
    const c = isBlockedIPv4(`${s[1] >> 8}.${s[1] & 0xFF}.${s[2] >> 8}.${s[2] & 0xFF}`);
    if (c.blocked) return { blocked: true, reason: `6to4 IPv6: ${c.reason}` };
  }
  if ((s[0] & 0xFF00) === 0xFF00) return { blocked: true, reason: 'IPv6 multicast (ff00::/8)' };
  if (s.every(x => x === 0)) return { blocked: true, reason: 'IPv6 all-interfaces' };
  if (s[0] === 0 && s[1] === 0 && s[2] === 0 && s[3] === 0 && s[4] === 0 && s[5] === 0 && s[6] === 0 && s[7] === 1) {
    return { blocked: true, reason: 'IPv6 loopback' };
  }
  if ((s[0] & 0xFFC0) === 0xFE80) return { blocked: true, reason: 'IPv6 link-local (fe80::/10)' };
  if ((s[0] & 0xFE00) === 0xFC00) return { blocked: true, reason: 'IPv6 unique-local (fc00::/7)' };
  if ((s[0] & 0xFFC0) === 0xFEC0) return { blocked: true, reason: 'IPv6 site-local' };
  return { blocked: false };
}

/** True if a hostname/IP literal is an SSRF target (private / loopback / metadata). */
export function isSSRFTarget(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(lower)) return true;
  if (isBlockedIPv4(lower).blocked) return true;
  if (looksLikePrivateHost(lower)) return true;
  const v6 = lower.replace(/^\[|\]$/g, '');
  if (isBlockedIPv6(v6).blocked) return true;
  if (lower.includes(':') && isBlockedIPv6(lower).blocked) return true;
  return false;
}

export interface EgressGuardResult {
  ok: boolean;
  reason?: string;
  code?: 'INVALID_URL' | 'HTTPS_REQUIRED' | 'CREDENTIALS_IN_URL' | 'SSRF_BLOCKED' | 'DNS_FAILED';
  hostname?: string;
  resolvedIps?: string[];
}

export type HostResolver = (hostname: string) => Promise<string[]>;

/** Default Node resolver (lazy-imported so non-Node runtimes don't break at load). */
async function defaultResolveHost(hostname: string): Promise<string[]> {
  try {
    const dns = await import('node:dns/promises');
    const records = await dns.lookup(hostname, { all: true });
    return records.map(r => r.address);
  } catch {
    return [];
  }
}

/**
 * Validate an egress target. Hard-rejects:
 *  - non-HTTPS URLs and URLs carrying credentials
 *  - SSRF targets (private/loopback/link-local IPs, IPv6 ULA, cloud metadata)
 *  - hosts that RESOLVE to a private IP (DNS rebinding at check time)
 */
export async function validateEgressTarget(
  url: string,
  opts?: { resolveHost?: HostResolver },
): Promise<EgressGuardResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, code: 'INVALID_URL', reason: 'Invalid destination URL' };
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, code: 'HTTPS_REQUIRED', reason: `Egress must be HTTPS, got ${parsed.protocol}`, hostname: parsed.hostname };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, code: 'CREDENTIALS_IN_URL', reason: 'Credentials in URL are not allowed', hostname: parsed.hostname };
  }

  const hostname = parsed.hostname;
  if (isSSRFTarget(hostname)) {
    return { ok: false, code: 'SSRF_BLOCKED', reason: `Blocked SSRF target: ${hostname}`, hostname };
  }

  // Every approval carries the addresses the transport must use.
  const isIpLiteral = IPV4_REGEX.test(hostname) || hostname.includes(':');
  if (!isIpLiteral) {
    const resolve = opts?.resolveHost ?? defaultResolveHost;
    let ips: string[];
    // A resolver may explain an empty answer by throwing (e.g. which lookups it tried); the
    // reason carries that note so a caller can say what actually happened. Still refused.
    let note = '';
    try { ips = await resolve(hostname); } catch (err) { ips = []; note = err instanceof Error && err.message ? ` (${err.message})` : ''; }
    if (ips.length === 0 || ips.some(ip => !isValidIPAddress(ip))) {
      return { ok: false, code: 'DNS_FAILED', reason: `No valid DNS addresses for ${hostname}${note}`, hostname, resolvedIps: ips };
    }
    for (const ip of ips) {
      if (isBlockedIPv4(ip).blocked || isBlockedIPv6(ip).blocked) {
        return { ok: false, code: 'SSRF_BLOCKED', reason: `Host ${hostname} resolved to blocked IP ${ip}`, hostname, resolvedIps: ips };
      }
    }
    return { ok: true, hostname, resolvedIps: ips };
  }

  return { ok: true, hostname, resolvedIps: [hostname.replace(/^\[|\]$/g, '')] };
}
