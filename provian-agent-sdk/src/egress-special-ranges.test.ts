/**
 * Special-purpose address space is never an egress target: as an IPv4 literal, in every IPv6
 * form that carries the same IPv4 address, and as the answer a public-looking name resolves to.
 */
import { describe, it, expect } from 'vitest';
import { validateEgressTarget, isSSRFTarget } from './egress-guard';

const publicResolver = async () => ['93.184.216.34'];

/** One address from inside each special-purpose IPv4 block, with the block it stands for. */
const SPECIAL_V4: Array<[string, string]> = [
  ['0.1.2.3', '0.0.0.0/8'],
  ['10.1.2.3', '10.0.0.0/8'],
  ['100.64.0.1', '100.64.0.0/10'],
  ['100.127.255.254', '100.64.0.0/10'],
  ['127.0.0.2', '127.0.0.0/8'],
  ['169.254.169.254', '169.254.0.0/16'],
  ['172.16.0.1', '172.16.0.0/12'],
  ['192.0.0.1', '192.0.0.0/24'],
  ['192.0.0.192', '192.0.0.0/24 (cloud metadata)'],
  ['192.0.0.255', '192.0.0.0/24'],
  ['192.0.2.1', '192.0.2.0/24'],
  ['192.88.99.1', '192.88.99.0/24'],
  ['192.168.1.1', '192.168.0.0/16'],
  ['198.18.0.1', '198.18.0.0/15'],
  ['198.19.255.254', '198.18.0.0/15'],
  ['198.51.100.7', '198.51.100.0/24'],
  ['203.0.113.7', '203.0.113.0/24'],
  ['224.0.0.1', '224.0.0.0/4'],
  ['240.0.0.1', '240.0.0.0/4'],
  ['255.255.255.255', 'broadcast'],
];
/** Addresses just outside those blocks, which stay reachable. */
const PUBLIC_V4 = ['1.1.1.1', '8.8.8.8', '93.184.216.34', '100.63.255.255', '100.128.0.1', '192.0.1.1', '192.0.3.1', '192.88.98.1', '198.17.255.255', '198.20.0.1', '198.51.99.1', '198.51.101.1', '203.0.112.1', '203.0.114.1', '223.255.255.254'];

const hex = (ip: string): string => { const o = ip.split('.').map(Number); return `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`; };
const v6Forms = (ip: string): Array<[string, string]> => [
  ['IPv4-mapped, dotted', `::ffff:${ip}`],
  ['IPv4-mapped, hexadecimal', `::ffff:${hex(ip)}`],
  ['IPv4-mapped, uncompressed', `0:0:0:0:0:ffff:${hex(ip)}`],
  ['IPv4-translated', `::ffff:0:${hex(ip)}`],
  ['NAT64 well-known, hexadecimal', `64:ff9b::${hex(ip)}`],
  ['NAT64 well-known, dotted', `64:ff9b::${ip}`],
  ['NAT64 local-use', `64:ff9b:1::${hex(ip)}`],
  ['6to4', `2002:${hex(ip)}::1`],
];

describe('egress guard — special-purpose address space', () => {
  it('the tables are not empty', () => {
    expect(SPECIAL_V4.length).toBeGreaterThanOrEqual(20);
    expect(PUBLIC_V4.length).toBeGreaterThanOrEqual(10);
    expect(v6Forms('10.0.0.1')).toHaveLength(8);
  });

  for (const [ip, block] of SPECIAL_V4) {
    it(`refuses ${ip} (${block}) as a literal, in every IPv6 form, and as a DNS answer`, async () => {
      expect(isSSRFTarget(ip)).toBe(true);
      expect(await validateEgressTarget(`https://${ip}/x`, { resolveHost: publicResolver })).toMatchObject({ ok: false, code: 'SSRF_BLOCKED' });
      expect(await validateEgressTarget('https://public-looking.example.com/x', { resolveHost: async () => ['93.184.216.34', ip] }))
        .toMatchObject({ ok: false, code: 'SSRF_BLOCKED' });
      for (const [form, address] of v6Forms(ip)) {
        expect(isSSRFTarget(address), `${form}: ${address}`).toBe(true);
        expect(isSSRFTarget(`[${address}]`), `${form}: [${address}]`).toBe(true);
        expect((await validateEgressTarget(`https://[${address}]/x`, { resolveHost: publicResolver })).ok, `${form}: ${address}`).toBe(false);
      }
    });
  }

  it('RED CONTROL: public addresses beside each block stay reachable, in IPv4 and through NAT64 / 6to4', async () => {
    for (const ip of PUBLIC_V4) {
      expect(isSSRFTarget(ip), ip).toBe(false);
      expect((await validateEgressTarget(`https://${ip}/x`)).ok, ip).toBe(true);
      expect(await validateEgressTarget('https://api.example.com/x', { resolveHost: async () => [ip] })).toMatchObject({ ok: true, resolvedIps: [ip] });
      expect(isSSRFTarget(`64:ff9b::${hex(ip)}`), ip).toBe(false);
      expect(isSSRFTarget(`64:ff9b::${ip}`), ip).toBe(false);
      expect(isSSRFTarget(`2002:${hex(ip)}::1`), ip).toBe(false);
    }
  });

  it('a dotted tail that is not an IPv4 address is not read as one, and such a URL is invalid', async () => {
    expect(isSSRFTarget('64:ff9b::10.0.0.256')).toBe(false);
    expect(await validateEgressTarget('https://[64:ff9b::10.0.0.256]/x')).toMatchObject({ ok: false, code: 'INVALID_URL' });
  });
});
