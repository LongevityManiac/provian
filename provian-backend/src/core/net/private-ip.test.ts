/**
 * The ONE private-address predicate behind every relay-side outbound fetch (webhooks, the
 * avatar proxy, the requester-key fetch). Parsed, never prefix-matched: the 2026-10-17 bug check
 * found the text form passing an uncompressed loopback, a bracketed literal and four IPv4 ranges.
 */
import { isPrivateIp } from './private-ip';

describe('isPrivateIp', () => {
  // The ranges the text-matching predicate missed are marked RED: each passed it as public.
  const blocked: Array<[string, string]> = [
    ['127.0.0.1', 'loopback'], ['10.0.0.1', 'RFC 1918 A'], ['172.16.0.1', 'RFC 1918 B'], ['172.31.255.255', 'RFC 1918 B end'],
    ['192.168.1.1', 'RFC 1918 C'], ['169.254.169.254', 'cloud metadata'], ['0.0.0.0', 'unspecified'], ['0.1.2.3', 'this network'],
    ['100.64.0.1', 'RED shared address space'], ['100.127.255.255', 'RED shared address space end'],
    ['198.18.0.1', 'RED benchmarking'], ['198.19.255.255', 'RED benchmarking end'],
    ['224.0.0.1', 'RED multicast'], ['239.255.255.255', 'RED multicast end'], ['240.0.0.1', 'RED reserved'], ['255.255.255.255', 'RED broadcast'],
    ['192.0.0.1', 'RED IETF protocol block'],
    ['::1', 'v6 loopback'], ['::', 'v6 unspecified'], ['fe80::1', 'v6 link-local'], ['fe80::1%en0', 'v6 link-local with zone'],
    ['fec0::1', 'v6 site-local'], ['fc00::1', 'v6 ULA'], ['fd12:3456::1', 'v6 ULA'], ['ff02::1', 'RED v6 multicast'],
    ['::ffff:10.0.0.1', 'mapped private'], ['::ffff:127.0.0.1', 'mapped loopback'], ['::ffff:7f00:1', 'mapped loopback (hex)'],
    ['0:0:0:0:0:0:0:1', 'RED uncompressed loopback'], ['[::1]', 'RED bracketed loopback'],
    ['0000:0000:0000:0000:0000:ffff:7f00:0001', 'RED uncompressed mapped loopback'], ['::7f00:1', 'v4-compatible loopback'],
    ['64:ff9b::7f00:1', 'RED NAT64 loopback'], ['64:ff9b::a9fe:a9fe', 'RED NAT64 metadata'], ['64:ff9b:1::a00:1', 'RED NAT64 local-use private'],
    ['2002:7f00:1::', 'RED 6to4 loopback'], ['2002:a9fe:a9fe::', 'RED 6to4 metadata'], ['2001:db8::1', 'RED documentation'],
    // Reviewer 2026-10-17: the IPv4-translated form (SIIT) parsed as public; every ::/80 embedding form is refused.
    ['::ffff:0:7f00:1', 'RED translated loopback'], ['::ffff:0:a9fe:a9fe', 'RED translated metadata'],
    ['::ffff:0:5db8:d822', 'translated public — refused outright'], ['::ffff:93.184.216.34', 'mapped public — refused outright'],
    ['::ffff:5db8:d822', 'mapped public (hex) — refused outright'], ['::5db8:d822', 'compatible public — refused outright'],
    ['not-an-ip', 'unparseable'], ['1.2.3', 'short'], ['1.2.3.4.5', 'long'], ['2130706433', 'decimal loopback'], ['0x7f.0.0.1', 'hex octet'],
    ['01.2.3.4', 'leading zero octet'], ['1:2:3:4:5:6:7::8', 'malformed v6'], ['::g', 'malformed v6'], ['', 'empty'],
  ];
  it.each(blocked)('blocks %s (%s)', (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  const allowed: Array<[string, string]> = [
    ['8.8.8.8', 'public'], ['93.184.216.34', 'public'], ['203.0.113.7', 'documentation v4 stays as the avatar proxy test pins it'],
    ['100.128.0.1', 'just past the shared space'], ['198.20.0.1', 'just past benchmarking'], ['223.255.255.255', 'last unicast'],
    ['2606:2800:220:1:248:1893:25c8:1946', 'public v6'],
    ['64:ff9b::5db8:d822', 'NAT64 public (DNS64 on an IPv6-only network)'], ['2002:5db8:d822::', '6to4 public'],
    ['[2606:2800:220:1:248:1893:25c8:1946]', 'bracketed public v6'],
  ];
  it.each(allowed)('passes %s (%s)', (ip) => {
    expect(isPrivateIp(ip)).toBe(false);
  });
});
