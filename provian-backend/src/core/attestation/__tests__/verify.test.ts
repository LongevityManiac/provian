/**
 * Adversarial unit tests for the Android Key Attestation verifier.
 *
 * Every test is hermetic: synthetic chains under a test trust anchor, an
 * injected clock, and a stubbed revocation source. No physical device, no
 * Google PKI, no network. The single real-Google-root happy path lives in
 * verify.real-chain.test.ts (fixture-gated).
 */
import { verifyAndroidKeyAttestation } from '../verify';
import { normalizeSerial } from '../revocation';
import {
  mintChain,
  mintCert,
  generateP256,
  publicKeyHex,
  buildKeyDescriptionExtension,
  ALLOW_ALL_REVOCATION,
  UNAVAILABLE_REVOCATION,
  revokeSerials,
  SecurityLevel,
  VerifiedBootState,
  TEST_NOW,
} from './synthetic-chain';
import { buildTrustAnchorSet } from '../roots';

function baseInput(chain: Awaited<ReturnType<typeof mintChain>>) {
  return {
    derChain: chain.derChain,
    expectedChallenge: chain.challenge,
    registeredSigningPublicKeyHex: chain.registeredKeyHex,
    anchors: chain.anchors,
    revocation: ALLOW_ALL_REVOCATION,
    now: TEST_NOW,
  };
}

describe('verifyAndroidKeyAttestation - positive paths', () => {
  it('promotes a valid StrongBox chain to hardware_full', async () => {
    const chain = await mintChain();
    const res = await verifyAndroidKeyAttestation(baseInput(chain));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.attestedTier).toBe('hardware_full');
      expect(res.securityLevel).toBe('StrongBox');
      expect(res.bootState).toBe('Verified');
    }
  });

  it('promotes a valid TEE chain to hardware_tpm', async () => {
    const chain = await mintChain({
      keyDescription: {
        attestationSecurityLevel: SecurityLevel.trustedEnvironment,
        keymasterSecurityLevel: SecurityLevel.trustedEnvironment,
      },
    });
    const res = await verifyAndroidKeyAttestation(baseInput(chain));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.attestedTier).toBe('hardware_tpm');
  });

  it('verifies a chain whose root is omitted (anchored by embedded key)', async () => {
    const chain = await mintChain({ includeRootInChain: false });
    const res = await verifyAndroidKeyAttestation(baseInput(chain));
    expect(res.ok).toBe(true);
  });
});

describe('verifyAndroidKeyAttestation - chain rejects', () => {
  it('rejects an empty chain', async () => {
    const chain = await mintChain();
    const res = await verifyAndroidKeyAttestation({ ...baseInput(chain), derChain: [] });
    expect(res).toMatchObject({ ok: false, code: 'CHAIN_EMPTY' });
  });

  it('rejects undecodable DER', async () => {
    const chain = await mintChain();
    const res = await verifyAndroidKeyAttestation({
      ...baseInput(chain),
      derChain: [new Uint8Array([0xde, 0xad, 0xbe, 0xef])],
    });
    expect(res).toMatchObject({ ok: false, code: 'CHAIN_PARSE' });
  });

  it('rejects a chain anchored to the wrong/typo root', async () => {
    const chain = await mintChain();
    const other = await mintChain(); // a different root entirely
    const res = await verifyAndroidKeyAttestation({ ...baseInput(chain), anchors: other.anchors });
    expect(res).toMatchObject({ ok: false, code: 'ROOT_NOT_TRUSTED' });
  });

  it('rejects a forged chain (leaf re-parented under a rogue intermediate)', async () => {
    // Valid root + intermediate, but the intermediate cert placed in the chain
    // is a rogue with the SAME subject and a DIFFERENT key, so the leaf's
    // signature no longer verifies against it.
    const rootKeys = await generateP256();
    const intermediateKeys = await generateP256();
    const rogueIntKeys = await generateP256();
    const leafKeys = await generateP256();

    const root = await mintCert({
      subject: 'CN=R', issuer: 'CN=R', publicKey: rootKeys.publicKey, signingKey: rootKeys.privateKey, serialNumber: '01', ca: true,
    });
    // Real intermediate signs the leaf...
    const realInt = await mintCert({
      subject: 'CN=I', issuer: 'CN=R', publicKey: intermediateKeys.publicKey, signingKey: rootKeys.privateKey, serialNumber: '02', ca: true,
    });
    // ...but a rogue intermediate (same subject, different key, still root-signed) is shipped.
    const rogueInt = await mintCert({
      subject: 'CN=I', issuer: 'CN=R', publicKey: rogueIntKeys.publicKey, signingKey: rootKeys.privateKey, serialNumber: '03', ca: true,
    });
    const leaf = await mintCert({
      subject: 'CN=L', issuer: 'CN=I', publicKey: leafKeys.publicKey, signingKey: intermediateKeys.privateKey, serialNumber: '0a',
      extensions: [buildKeyDescriptionExtension()],
    });
    void realInt;

    const res = await verifyAndroidKeyAttestation({
      derChain: [new Uint8Array(leaf.rawData), new Uint8Array(rogueInt.rawData), new Uint8Array(root.rawData)],
      expectedChallenge: new Uint8Array([1, 2, 3, 4]),
      registeredSigningPublicKeyHex: await publicKeyHex(leafKeys.publicKey),
      anchors: buildTrustAnchorSet([root.toString('pem')]),
      revocation: ALLOW_ALL_REVOCATION,
      now: TEST_NOW,
    });
    expect(res).toMatchObject({ ok: false, code: 'CHAIN_SIG_INVALID' });
  });

  it('rejects a chain whose issuer is not a CA (basicConstraints cA=false)', async () => {
    // Root is a CA, but the intermediate is NOT marked cA=true. Even though all
    // signatures chain correctly, a non-CA cert must not serve as an issuer.
    const rootKeys = await generateP256();
    const intKeys = await generateP256();
    const leafKeys = await generateP256();
    const root = await mintCert({
      subject: 'CN=R', issuer: 'CN=R', publicKey: rootKeys.publicKey, signingKey: rootKeys.privateKey, serialNumber: '01', ca: true,
    });
    const nonCaInt = await mintCert({
      subject: 'CN=I', issuer: 'CN=R', publicKey: intKeys.publicKey, signingKey: rootKeys.privateKey, serialNumber: '02', // no ca
    });
    const leaf = await mintCert({
      subject: 'CN=L', issuer: 'CN=I', publicKey: leafKeys.publicKey, signingKey: intKeys.privateKey, serialNumber: '0a',
      extensions: [buildKeyDescriptionExtension()],
    });
    const res = await verifyAndroidKeyAttestation({
      derChain: [new Uint8Array(leaf.rawData), new Uint8Array(nonCaInt.rawData), new Uint8Array(root.rawData)],
      expectedChallenge: new Uint8Array([1, 2, 3, 4]),
      registeredSigningPublicKeyHex: await publicKeyHex(leafKeys.publicKey),
      anchors: buildTrustAnchorSet([root.toString('pem')]),
      revocation: ALLOW_ALL_REVOCATION,
      now: TEST_NOW,
    });
    expect(res).toMatchObject({ ok: false, code: 'CHAIN_PATH_BROKEN' });
  });

  it('rejects an expired leaf', async () => {
    const chain = await mintChain({
      leafNotBefore: new Date(Date.UTC(2024, 0, 1)),
      leafNotAfter: new Date(Date.UTC(2025, 0, 1)),
    });
    const res = await verifyAndroidKeyAttestation(baseInput(chain));
    expect(res).toMatchObject({ ok: false, code: 'CERT_EXPIRED' });
  });

  it('rejects a not-yet-valid leaf', async () => {
    const chain = await mintChain({
      leafNotBefore: new Date(Date.UTC(2030, 0, 1)),
      leafNotAfter: new Date(Date.UTC(2035, 0, 1)),
    });
    const res = await verifyAndroidKeyAttestation(baseInput(chain));
    expect(res).toMatchObject({ ok: false, code: 'CERT_NOT_YET_VALID' });
  });
});

describe('verifyAndroidKeyAttestation - extension & challenge rejects', () => {
  it('rejects a leaf with no attestation extension', async () => {
    const chain = await mintChain({ keyDescription: null });
    const res = await verifyAndroidKeyAttestation(baseInput(chain));
    expect(res).toMatchObject({ ok: false, code: 'EXTENSION_MISSING' });
  });

  it('rejects when no server challenge is supplied (CHALLENGE_MISSING)', async () => {
    const chain = await mintChain();
    const res = await verifyAndroidKeyAttestation({ ...baseInput(chain), expectedChallenge: undefined });
    expect(res).toMatchObject({ ok: false, code: 'CHALLENGE_MISSING' });
  });

  it('rejects a challenge mismatch', async () => {
    const chain = await mintChain({ keyDescription: { challenge: new Uint8Array([9, 9, 9, 9]) } });
    const res = await verifyAndroidKeyAttestation({
      ...baseInput(chain),
      expectedChallenge: new Uint8Array([1, 2, 3, 4]), // not what was baked in
    });
    expect(res).toMatchObject({ ok: false, code: 'CHALLENGE_MISMATCH' });
  });

  it('rejects a challenge of the wrong length', async () => {
    const chain = await mintChain({ keyDescription: { challenge: new Uint8Array([1, 2, 3, 4]) } });
    const res = await verifyAndroidKeyAttestation({
      ...baseInput(chain),
      expectedChallenge: new Uint8Array([1, 2, 3, 4, 5]),
    });
    expect(res).toMatchObject({ ok: false, code: 'CHALLENGE_MISMATCH' });
  });
});

describe('verifyAndroidKeyAttestation - key, level, boot, origin rejects', () => {
  it('rejects when the attested key != registered key', async () => {
    const chain = await mintChain();
    const otherKeys = await generateP256();
    const res = await verifyAndroidKeyAttestation({
      ...baseInput(chain),
      registeredSigningPublicKeyHex: await publicKeyHex(otherKeys.publicKey),
    });
    expect(res).toMatchObject({ ok: false, code: 'ATTESTED_KEY_MISMATCH' });
  });

  it('rejects a Software-level attestation', async () => {
    const chain = await mintChain({
      keyDescription: { attestationSecurityLevel: SecurityLevel.software, keymasterSecurityLevel: SecurityLevel.software },
    });
    const res = await verifyAndroidKeyAttestation(baseInput(chain));
    expect(res).toMatchObject({ ok: false, code: 'SECURITY_LEVEL_INSUFFICIENT' });
  });

  it('rejects a TEE attestation when policy requires StrongBox', async () => {
    const chain = await mintChain({
      keyDescription: { attestationSecurityLevel: SecurityLevel.trustedEnvironment, keymasterSecurityLevel: SecurityLevel.trustedEnvironment },
    });
    const res = await verifyAndroidKeyAttestation({ ...baseInput(chain), policy: { minSecurityLevel: 'StrongBox' } });
    expect(res).toMatchObject({ ok: false, code: 'SECURITY_LEVEL_INSUFFICIENT' });
  });

  it('rejects an unverified boot state', async () => {
    const chain = await mintChain({ keyDescription: { verifiedBootState: VerifiedBootState.unverified } });
    const res = await verifyAndroidKeyAttestation(baseInput(chain));
    expect(res).toMatchObject({ ok: false, code: 'BOOT_STATE_UNTRUSTED' });
  });

  it('rejects an unlocked device', async () => {
    const chain = await mintChain({ keyDescription: { deviceLocked: false } });
    const res = await verifyAndroidKeyAttestation(baseInput(chain));
    expect(res).toMatchObject({ ok: false, code: 'BOOT_STATE_UNTRUSTED' });
  });

  it('rejects when there is no hardware-enforced rootOfTrust', async () => {
    const chain = await mintChain({ keyDescription: { includeRootOfTrust: false } });
    const res = await verifyAndroidKeyAttestation(baseInput(chain));
    expect(res).toMatchObject({ ok: false, code: 'BOOT_STATE_UNTRUSTED' });
  });

  it('rejects a key whose hardware origin is not GENERATED', async () => {
    const chain = await mintChain({ keyDescription: { origin: 2 } }); // IMPORTED
    const res = await verifyAndroidKeyAttestation(baseInput(chain));
    expect(res).toMatchObject({ ok: false, code: 'ORIGIN_NOT_GENERATED' });
  });

  it('rejects when hardware origin is absent', async () => {
    const chain = await mintChain({ keyDescription: { omitOrigin: true } });
    const res = await verifyAndroidKeyAttestation(baseInput(chain));
    expect(res).toMatchObject({ ok: false, code: 'ORIGIN_NOT_GENERATED' });
  });

  it('allows an unverified boot when policy relaxes requireVerifiedBoot, still checks origin', async () => {
    const chain = await mintChain({ keyDescription: { verifiedBootState: VerifiedBootState.unverified } });
    const res = await verifyAndroidKeyAttestation({ ...baseInput(chain), policy: { requireVerifiedBoot: false } });
    expect(res.ok).toBe(true);
  });
});

describe('verifyAndroidKeyAttestation - revocation rejects', () => {
  it('rejects a revoked leaf serial', async () => {
    const chain = await mintChain({ leafSerial: 'ff00ff' });
    const res = await verifyAndroidKeyAttestation({
      ...baseInput(chain),
      revocation: revokeSerials([normalizeSerial('ff00ff')]),
    });
    expect(res).toMatchObject({ ok: false, code: 'REVOKED' });
  });

  it('fails closed when the revocation source is unavailable', async () => {
    const chain = await mintChain();
    const res = await verifyAndroidKeyAttestation({ ...baseInput(chain), revocation: UNAVAILABLE_REVOCATION });
    expect(res).toMatchObject({ ok: false, code: 'REVOCATION_UNAVAILABLE' });
  });
});

describe('normalizeSerial', () => {
  it('strips leading zeros and lowercases', () => {
    expect(normalizeSerial('00A0B0')).toBe('a0b0');
    expect(normalizeSerial('0x00FF')).toBe('ff');
    expect(normalizeSerial('0')).toBe('0');
  });
});
