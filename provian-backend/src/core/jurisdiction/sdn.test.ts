jest.unmock('./sdn');
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { parseSdn, screenAddresses, approvedSdnUrl, SDN_URL, refreshSdn } from './sdn';
const HIT = '0x252a8bd2319d8a555b872990601221b3a2053bce';
function xml(count = 1000, digital = true): string {
  return `<sdnList><publshInformation><Publish_Date>10/28/2026</Publish_Date><Record_Count>${count}</Record_Count></publshInformation>${Array.from({ length: 1000 }, (_, i) =>
    `<sdnEntry><uid>${i}</uid>${digital ? `<idList><id><idType>Digital Currency Address - ETH</idType><idNumber>${i === 0 ? HIT : '0x' + i.toString(16).padStart(40, '0')}</idNumber></id></idList>` : ''}</sdnEntry>`).join('')}</sdnList>`;
}
it('parses a nonempty SDN population and screens a canonical address', async () => {
  const snapshot = parseSdn(xml(), Date.now());
  expect(snapshot.addresses).toHaveLength(1000);
  const fake = createFakeFirestore(); fake.store.set('jurisdiction_screening_v1/ofac_sdn', { ...snapshot });
  const db = fake as unknown as Firestore;
  expect(await screenAddresses(db, [HIT.toUpperCase().replace('0X', '0x')])).toBe('hit');
  expect(await screenAddresses(db, ['0x' + 'f'.repeat(40)])).toBe('clear');
});
it.each([xml(999), xml(1000, false), '<!DOCTYPE x><sdnList/>', '<sdnList/>'])('refuses malformed or vacuous official-feed content', body => {
  expect(() => parseSdn(body, Date.now())).toThrow();
});
it.each([
  { addresses: Array.from({ length: 100 }, () => HIT) },
  { addresses: [...Array.from({ length: 100 }, (_, i) => `address-${i}`), null] },
])('corrupt stored population fails closed', ({ addresses }) => {
  const fake = createFakeFirestore(); fake.store.set('jurisdiction_screening_v1/ofac_sdn', {
    checked_at_ms: Date.now(), published: '10/28/2026', sha256: 'a'.repeat(64), addresses,
  });
  return expect(screenAddresses(fake as unknown as Firestore, [HIT])).resolves.toBe('unknown');
});

it('accepts OFAC and its published GovCloud export redirect only', () => {
  expect(approvedSdnUrl(SDN_URL).hostname).toBe('sanctionslistservice.ofac.treas.gov');
  expect(approvedSdnUrl('https://wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com/Published/a/2026-10-28/b/SDN.XML?X-Amz-Signature=example').protocol).toBe('https:');
});
it.each([
  'http://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML',
  'https://127.0.0.1/SDN.XML',
  'https://example.com/Published/a/SDN.XML',
  'https://sanctionslistservice.ofac.treas.gov.evil.test/api/PublicationPreview/exports/SDN.XML',
  'https://user:password@sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML',
  'https://wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com/other.xml',
])('refuses an untrusted export redirect %s', url => { expect(() => approvedSdnUrl(url)).toThrow(); });

it('malformed upstream Location rejects safely inside the response callback', async () => {
  const https = require('https') as typeof import('https');
  const { Resolver } = require('dns/promises') as typeof import('dns/promises');
  const { EventEmitter } = require('events') as typeof import('events');
  const v4 = jest.spyOn(Resolver.prototype, 'resolve4').mockResolvedValue(['8.8.8.8'] as never);
  const v6 = jest.spyOn(Resolver.prototype, 'resolve6').mockResolvedValue([] as never);
  const requestSpy = jest.spyOn(https, 'request').mockImplementation(((_url: URL, _options: import('https').RequestOptions,
    callback: (response: import('http').IncomingMessage) => void) => {
    const outgoing = new EventEmitter() as import('http').ClientRequest;
    outgoing.end = (() => {
      setImmediate(() => callback({ statusCode: 302, headers: { location: 'https://[' }, destroy: jest.fn() } as unknown as import('http').IncomingMessage));
      return outgoing;
    }) as typeof outgoing.end;
    return outgoing;
  }) as typeof https.request);
  try {
    const fake = createFakeFirestore();
    const lastGood = parseSdn(xml(), Date.now());
    fake.store.set('jurisdiction_screening_v1/ofac_sdn', { ...lastGood });
    await expect(refreshSdn(fake as unknown as Firestore)).rejects.toThrow('sdn_refresh_failed');
    expect(fake.store.get('jurisdiction_screening_v1/ofac_sdn')).toEqual(lastGood);
    expect(await screenAddresses(fake as unknown as Firestore, ['0x' + 'f'.repeat(40)])).toBe('clear');
    expect(fake.store.get('jurisdiction_screening_v1/ofac_sdn_refresh')).toMatchObject({ last_error_code: 'refresh_failed', last_failure_at_ms: expect.any(Number) });
    expect(JSON.stringify(fake.store.get('jurisdiction_screening_v1/ofac_sdn_refresh'))).not.toContain('https:');
  } finally { requestSpy.mockRestore(); v4.mockRestore(); v6.mockRestore(); }
});
