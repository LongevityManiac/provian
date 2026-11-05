import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  parseKeytoolDigests,
  parseSignerDigests,
  registrationProblems,
  GOOGLE_SERVICES_PATH,
  ASSETLINKS_PATH,
} from './check-android-signing-registration.mjs';

// The committed registrations — the same files the build check reads (no test copy).
const googleServices = JSON.parse(fs.readFileSync(GOOGLE_SERVICES_PATH, 'utf8'));
const assetlinks = JSON.parse(fs.readFileSync(ASSETLINKS_PATH, 'utf8'));

const APKSIGNER_OUT = [
  'Signer #1 certificate DN: CN=Provian',
  'Signer #1 certificate SHA-256 digest: cbe7bdd00c32ef859778b199d51eb71590d1d0dd100e2ecb5593d9dd8af4635a',
  'Signer #1 certificate SHA-1 digest: efcfbac1eda0a2f478636dab7308d03b223aa5ab',
].join('\n');

describe('Android signing registration (the 2026-09-23 status-10 regression)', () => {
  it('reads the signer digests from apksigner output', () => {
    expect(parseSignerDigests(APKSIGNER_OUT)).toEqual({
      sha1: 'efcfbac1eda0a2f478636dab7308d03b223aa5ab',
      sha256: 'cbe7bdd00c32ef859778b199d51eb71590d1d0dd100e2ecb5593d9dd8af4635a',
    });
  });

  it('reads the signer digests of a Play bundle from keytool output, and holds it to the same registration', () => {
    const keytool = [
      'Signer #1:',
      'Certificate #1:',
      'Owner: CN=Provian Wallet, O=Provian',
      'Certificate fingerprints:',
      '\t SHA1: EF:CF:BA:C1:ED:A0:A2:F4:78:63:6D:AB:73:08:D0:3B:22:3A:A5:AB',
      '\t SHA256: CB:E7:BD:D0:0C:32:EF:85:97:78:B1:99:D5:1E:B7:15:90:D1:D0:DD:10:0E:2E:CB:55:93:D9:DD:8A:F4:63:5A',
    ].join('\n');
    expect(parseKeytoolDigests(keytool)).toEqual(parseSignerDigests(APKSIGNER_OUT));
    expect(registrationProblems(parseKeytoolDigests(keytool), googleServices, assetlinks)).toEqual([]);
    // RED: a bundle signed by any other key (an upload key, a debug key) is refused.
    const other = keytool.replace('CB:E7', 'CB:E8').replace('EF:CF', 'EF:CE');
    expect(registrationProblems(parseKeytoolDigests(other), googleServices, assetlinks).length).toBe(2);
  });

  it('the launch key is registered in the committed google-services.json AND assetlinks.json', () => {
    expect(registrationProblems(parseSignerDigests(APKSIGNER_OUT), googleServices, assetlinks)).toEqual([]);
  });

  it('RED: the pre-fix pairing — OAuth client still naming the retired key — is refused', () => {
    const stale = JSON.parse(JSON.stringify(googleServices));
    for (const c of stale.client) for (const o of c.oauth_client ?? []) {
      if (o.android_info) o.android_info.certificate_hash = '471c69db701cb3a5403726b2e1039f178852a53e';
    }
    const problems = registrationProblems(parseSignerDigests(APKSIGNER_OUT), stale, assetlinks);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/status 10/);
  });

  it('RED: a signer missing from assetlinks, or no Android OAuth client at all, is refused', () => {
    const other = { sha1: 'efcfbac1eda0a2f478636dab7308d03b223aa5ab', sha256: '00'.repeat(32) };
    expect(registrationProblems(other, googleServices, assetlinks)).toEqual([expect.stringMatching(/assetlinks/)]);
    expect(registrationProblems(parseSignerDigests(APKSIGNER_OUT), { client: [] }, assetlinks)).toEqual([expect.stringMatching(/registered: none/)]);
  });
});
