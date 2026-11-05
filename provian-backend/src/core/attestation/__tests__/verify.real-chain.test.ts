/**
 * Happy-path test against a REAL Google-rooted StrongBox attestation chain.
 *
 * Fixtures are the canonical sample chain from google/android-key-attestation
 * (src/test/resources/pem/algorithm_EC_SecurityLevel_StrongBox). The chain has
 * an EC P-256 StrongBox leaf rooted in Google's (RSA) hardware attestation root,
 * so this single test exercises the real ASN.1 KeyDescription parse, real
 * certificate signatures across mixed ECDSA/RSA algorithms, and anchoring to a
 * real Google root.
 *
 * Deterministic and always-on: the fixture chain is committed, the clock is
 * injected inside the chain's 2018-2028 validity window, and revocation is
 * stubbed. Nothing here touches the network or the wall clock. (A test that hits
 * the LIVE Google root/status endpoints would be non-deterministic and is
 * intentionally NOT included.)
 *
 * The sample was generated on a dev device, so its verified-boot state is
 * `Unverified` / unlocked. That lets us assert BOTH: promotion succeeds when
 * boot policy is relaxed, AND the same real chain is correctly REJECTED under
 * the default verified-boot-required policy.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { X509Certificate } from '@peculiar/x509';
import { verifyAndroidKeyAttestation } from '../verify';
import { buildTrustAnchorSet } from '../roots';
import { nodeCrypto } from '../crypto-provider';
import { ALLOW_ALL_REVOCATION } from './synthetic-chain';

const FIXTURE_DIR = join(__dirname, 'fixtures', 'strongbox-ec');
const REAL_CHALLENGE = new Uint8Array(Buffer.from('abc', 'utf8')); // baked into the sample
const NOW_IN_WINDOW = Date.UTC(2020, 5, 1); // inside 2018-2028

function loadPem(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

function loadDer(name: string): Uint8Array {
  return new Uint8Array(new X509Certificate(loadPem(name)).rawData);
}

async function leafKeyHex(): Promise<string> {
  const leaf = new X509Certificate(loadPem('cert0.pem'));
  const key = await nodeCrypto.subtle.importKey(
    'spki',
    leaf.publicKey.rawData,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    [],
  );
  const raw = await nodeCrypto.subtle.exportKey('raw', key);
  return Buffer.from(raw).toString('hex');
}

describe('verifyAndroidKeyAttestation - real Google StrongBox chain', () => {
  it('promotes the real chain to hardware_full when boot policy is relaxed', async () => {
    const res = await verifyAndroidKeyAttestation({
      derChain: [loadDer('cert0.pem'), loadDer('cert1.pem'), loadDer('cert2.pem'), loadDer('cert3.pem')],
      expectedChallenge: REAL_CHALLENGE,
      registeredSigningPublicKeyHex: await leafKeyHex(),
      anchors: buildTrustAnchorSet([loadPem('cert3.pem')]),
      revocation: ALLOW_ALL_REVOCATION,
      now: NOW_IN_WINDOW,
      policy: { requireVerifiedBoot: false },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.attestedTier).toBe('hardware_full');
      expect(res.securityLevel).toBe('StrongBox');
    }
  });

  it('rejects the real dev-device chain under the default verified-boot policy', async () => {
    const res = await verifyAndroidKeyAttestation({
      derChain: [loadDer('cert0.pem'), loadDer('cert1.pem'), loadDer('cert2.pem'), loadDer('cert3.pem')],
      expectedChallenge: REAL_CHALLENGE,
      registeredSigningPublicKeyHex: await leafKeyHex(),
      anchors: buildTrustAnchorSet([loadPem('cert3.pem')]),
      revocation: ALLOW_ALL_REVOCATION,
      now: NOW_IN_WINDOW,
    });
    expect(res).toMatchObject({ ok: false, code: 'BOOT_STATE_UNTRUSTED' });
  });

  it('rejects the real chain when anchored to the wrong root', async () => {
    // Anchor to the leaf instead of the real root -> not trusted.
    const res = await verifyAndroidKeyAttestation({
      derChain: [loadDer('cert0.pem'), loadDer('cert1.pem'), loadDer('cert2.pem'), loadDer('cert3.pem')],
      expectedChallenge: REAL_CHALLENGE,
      registeredSigningPublicKeyHex: await leafKeyHex(),
      anchors: buildTrustAnchorSet([loadPem('cert0.pem')]),
      revocation: ALLOW_ALL_REVOCATION,
      now: NOW_IN_WINDOW,
      policy: { requireVerifiedBoot: false },
    });
    expect(res).toMatchObject({ ok: false, code: 'ROOT_NOT_TRUSTED' });
  });
});
