/**
 * Shared private/internal IP predicate for SSRF guards.
 *
 * ONE implementation so the webhook-delivery guard, the Commons avatar proxy and the
 * requester-key fetch (and any future relay-side outbound fetch) cannot drift into two
 * different blocklists — the "self-referential control" shape warns about, where the
 * two copies diverge and whichever the test binds to is the one that stays right.
 *
 * The address is PARSED, never prefix-matched as text (2026-10-17 bug check: the text form let an
 * uncompressed `0:0:0:0:0:0:0:1`, a bracketed `[::1]` and the shared / benchmarking / multicast
 * IPv4 ranges through). Blocked: IPv4 unspecified, loopback, RFC 1918, shared address space
 * (100.64/10), link-local (which carries the 169.254.169.254 cloud-metadata address), the IETF
 * protocol block (192.0.0/24), benchmarking (198.18/15), multicast and reserved (224/4, 240/4);
 * IPv6 unspecified, loopback, link-local, site-local, unique-local, multicast, documentation, and
 * every form that embeds an IPv4 address — IPv4-mapped (any spelling), IPv4-compatible, NAT64
 * (64:ff9b::/96, 64:ff9b:1::/48) and 6to4 (2002::/16) — judged by the embedded address. Anything
 * that does not parse as exactly one IPv4 / IPv6 address is blocked (fail-closed).
 */

const V4_OCTET = /^(?:0|[1-9][0-9]{0,2})$/;

/** Four decimal octets, no leading zeros (an octal-looking octet is not an address here). */
function parseIpv4(text: string): number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!V4_OCTET.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

function isPrivateIpv4(p: readonly number[]): boolean {
  if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // shared address space (CGNAT) 100.64/10
  if (p[0] === 169 && p[1] === 254) return true; // link-local, incl. the cloud-metadata address
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 192 && p[1] === 0 && p[2] === 0) return true; // IETF protocol assignments 192.0.0/24
  if (p[0] === 198 && (p[1] === 18 || p[1] === 19)) return true; // benchmarking 198.18/15
  if (p[0] >= 224) return true; // multicast 224/4, reserved 240/4, broadcast
  return false;
}

/** Eight 16-bit segments, or null when the text is not exactly one IPv6 address. */
function parseIpv6(raw: string): number[] | null {
  let text = raw.replace(/^\[|\]$/g, '');
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone); // a zone id (fe80::1%eth0) names an interface, not a different address
  if (text.length === 0 || !/^[0-9a-fA-F:.]+$/.test(text)) return null;
  if (text.includes('.')) {
    // A dotted IPv4 tail (::ffff:10.0.0.1) folds into the last two segments.
    const lastColon = text.lastIndexOf(':');
    if (lastColon === -1) return null;
    const v4 = parseIpv4(text.slice(lastColon + 1));
    if (v4 === null) return null;
    text = `${text.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let segments: string[];
  if (halves.length === 2) {
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null;
    segments = [...left, ...new Array<string>(missing).fill('0'), ...right];
  } else {
    segments = left;
  }
  if (segments.length !== 8) return null;
  const out: number[] = [];
  for (const segment of segments) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(segment)) return null;
    out.push(parseInt(segment, 16));
  }
  return out;
}

function isPrivateIpv6(s: readonly number[]): boolean {
  const zeroThrough = (n: number): boolean => s.slice(0, n).every((x) => x === 0);
  if (zeroThrough(8)) return true; // ::
  if (zeroThrough(7) && s[7] === 1) return true; // ::1
  const embedded = [s[6] >> 8, s[6] & 0xff, s[7] >> 8, s[7] & 0xff];
  // Every IPv4-embedding form under ::/80 is refused outright — mapped `::ffff:a.b.c.d`, translated
  // `::ffff:0:a.b.c.d` (SIIT) and compatible `::a.b.c.d` — whatever the embedded address: a public
  // host is reached by its plain IPv4, and a translation path is a way to reach a private one
  // (the translated form had slipped through as "public").
  if (zeroThrough(4) && (s[4] === 0 || s[4] === 0xffff) && (s[5] === 0 || s[5] === 0xffff)) return true;
  if (s[0] === 0x0064 && s[1] === 0xff9b && ((s[2] === 0 && s[3] === 0 && s[4] === 0 && s[5] === 0) || s[2] === 1)) {
    return isPrivateIpv4(embedded); // NAT64
  }
  if (s[0] === 0x2002) return isPrivateIpv4([s[1] >> 8, s[1] & 0xff, s[2] >> 8, s[2] & 0xff]); // 6to4
  if ((s[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((s[0] & 0xffc0) === 0xfec0) return true; // site-local fec0::/10 (deprecated)
  if ((s[0] & 0xfe00) === 0xfc00) return true; // unique-local fc00::/7
  if ((s[0] & 0xff00) === 0xff00) return true; // multicast ff00::/8
  if (s[0] === 0x2001 && s[1] === 0x0db8) return true; // documentation 2001:db8::/32 — never routable
  return false;
}

export function isPrivateIp(ip: string): boolean {
  const text = ip.trim();
  if (text.includes(':')) {
    const segments = parseIpv6(text);
    return segments === null ? true : isPrivateIpv6(segments);
  }
  const octets = parseIpv4(text);
  return octets === null ? true : isPrivateIpv4(octets);
}
