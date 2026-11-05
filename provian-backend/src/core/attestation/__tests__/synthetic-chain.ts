/**
 * Synthetic Android attestation chain builder for hermetic tests.
 *
 * Mints a root -> intermediate -> leaf chain with @peculiar/x509 under a TEST
 * trust anchor, embedding a crafted KeyDescription extension in the leaf. This
 * exercises every reject/accept branch of the verifier with NO physical
 * StrongBox device and NO Google PKI. The real-Google-root happy path is a
 * separate fixture-gated test (see verify.real-chain.test.ts).
 */
import {
  X509Certificate,
  X509CertificateGenerator,
  Extension,
  BasicConstraintsExtension,
} from '@peculiar/x509';
import { AsnConvert, OctetString } from '@peculiar/asn1-schema';
import {
  KeyDescription,
  AuthorizationList,
  RootOfTrust,
  SecurityLevel,
  VerifiedBootState,
  id_ce_keyDescription,
} from '@peculiar/asn1-android';
import { nodeCrypto } from '../crypto-provider';
import { buildTrustAnchorSet, type TrustAnchorSet } from '../roots';
import type { RevocationStatusSource } from '../types';
import type { webcrypto } from 'crypto';

// This tsconfig has no DOM lib; use Node's webcrypto namespace types.
type CryptoKey = webcrypto.CryptoKey;
type CryptoKeyPair = webcrypto.CryptoKeyPair;

const ECDSA_P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN_ALG = { name: 'ECDSA', hash: 'SHA-256' } as const;

export const TEST_NOW = Date.UTC(2026, 0, 1); // 2026-01-01, inside all default windows.

export interface KeyDescriptionOptions {
  attestationVersion?: number;
  attestationSecurityLevel?: SecurityLevel;
  keymasterSecurityLevel?: SecurityLevel;
  challenge?: Uint8Array;
  /** Hardware origin. Defaults to KM_ORIGIN_GENERATED (0). */
  origin?: number;
  /** Omit the origin tag entirely (to exercise the absent-origin reject). */
  omitOrigin?: boolean;
  verifiedBootState?: VerifiedBootState;
  deviceLocked?: boolean;
  includeRootOfTrust?: boolean;
}

export function generateP256(): Promise<CryptoKeyPair> {
  return nodeCrypto.subtle.generateKey(ECDSA_P256, true, ['sign', 'verify']) as Promise<CryptoKeyPair>;
}

export async function publicKeyHex(key: CryptoKey): Promise<string> {
  const raw = await nodeCrypto.subtle.exportKey('raw', key);
  return Buffer.from(raw).toString('hex');
}

export function buildKeyDescriptionExtension(opts: KeyDescriptionOptions = {}): Extension {
  const challenge = opts.challenge ?? new Uint8Array([1, 2, 3, 4]);
  const includeRoT = opts.includeRootOfTrust ?? true;

  const teeFields: Partial<AuthorizationList> = {};
  if (!opts.omitOrigin) teeFields.origin = opts.origin ?? 0;
  if (includeRoT) {
    teeFields.rootOfTrust = new RootOfTrust({
      verifiedBootKey: new OctetString(new Uint8Array(32)),
      deviceLocked: opts.deviceLocked ?? true,
      verifiedBootState: opts.verifiedBootState ?? VerifiedBootState.verified,
    });
  }

  const kd = new KeyDescription({
    attestationVersion: opts.attestationVersion ?? 200,
    attestationSecurityLevel: opts.attestationSecurityLevel ?? SecurityLevel.strongBox,
    keymasterVersion: 200,
    keymasterSecurityLevel: opts.keymasterSecurityLevel ?? SecurityLevel.strongBox,
    attestationChallenge: new OctetString(challenge),
    uniqueId: new OctetString(new Uint8Array(0)),
    softwareEnforced: new AuthorizationList({}),
    teeEnforced: new AuthorizationList(teeFields),
  });

  return new Extension(id_ce_keyDescription, false, AsnConvert.serialize(kd));
}

interface MintCertOptions {
  subject: string;
  issuer: string;
  publicKey: CryptoKey;
  signingKey: CryptoKey;
  serialNumber: string;
  notBefore?: Date;
  notAfter?: Date;
  extensions?: Extension[];
  /** Add basicConstraints cA=true (required for issuer/CA certs). */
  ca?: boolean;
}

export function mintCert(opts: MintCertOptions): Promise<X509Certificate> {
  const extensions = [...(opts.extensions ?? [])];
  if (opts.ca) {
    extensions.push(new BasicConstraintsExtension(true, undefined, true));
  }
  return X509CertificateGenerator.create({
    serialNumber: opts.serialNumber,
    subject: opts.subject,
    issuer: opts.issuer,
    notBefore: opts.notBefore ?? new Date(Date.UTC(2025, 0, 1)),
    notAfter: opts.notAfter ?? new Date(Date.UTC(2035, 0, 1)),
    signingAlgorithm: SIGN_ALG,
    publicKey: opts.publicKey,
    signingKey: opts.signingKey,
    extensions,
  });
}

export interface SyntheticChain {
  /** Leaf-first DER chain (leaf, intermediate, root). */
  derChain: Uint8Array[];
  anchors: TrustAnchorSet;
  /** The leaf P-256 public key as 130-hex SEC1 uncompressed point. */
  registeredKeyHex: string;
  /** The challenge bytes baked into the leaf's KeyDescription. */
  challenge: Uint8Array;
  leafSerial: string;
  /** All cert objects for fine-grained assertions. */
  certs: { leaf: X509Certificate; intermediate: X509Certificate; root: X509Certificate };
  rootKeys: CryptoKeyPair;
  intermediateKeys: CryptoKeyPair;
  leafKeys: CryptoKeyPair;
}

export interface MintChainOptions {
  keyDescription?: KeyDescriptionOptions | null; // null = omit the extension entirely
  leafNotBefore?: Date;
  leafNotAfter?: Date;
  includeRootInChain?: boolean;
  leafSerial?: string;
}

function toDer(cert: X509Certificate): Uint8Array {
  return new Uint8Array(cert.rawData);
}

/** Mint a valid-by-construction chain under a fresh test root. */
export async function mintChain(opts: MintChainOptions = {}): Promise<SyntheticChain> {
  const rootKeys = await generateP256();
  const intermediateKeys = await generateP256();
  const leafKeys = await generateP256();

  const leafSerial = opts.leafSerial ?? '0a0b0c';
  const kdOpts = opts.keyDescription === undefined ? {} : opts.keyDescription;
  const challenge = kdOpts?.challenge ?? new Uint8Array([1, 2, 3, 4]);

  const root = await mintCert({
    subject: 'CN=Test Android Keystore Root',
    issuer: 'CN=Test Android Keystore Root',
    publicKey: rootKeys.publicKey,
    signingKey: rootKeys.privateKey,
    serialNumber: '01',
    ca: true,
  });
  const intermediate = await mintCert({
    subject: 'CN=Test Android Keystore Intermediate',
    issuer: 'CN=Test Android Keystore Root',
    publicKey: intermediateKeys.publicKey,
    signingKey: rootKeys.privateKey,
    serialNumber: '02',
    ca: true,
  });
  const leafExtensions = kdOpts === null ? [] : [buildKeyDescriptionExtension(kdOpts)];
  const leaf = await mintCert({
    subject: 'CN=Test Android Keystore Leaf',
    issuer: 'CN=Test Android Keystore Intermediate',
    publicKey: leafKeys.publicKey,
    signingKey: intermediateKeys.privateKey,
    serialNumber: leafSerial,
    notBefore: opts.leafNotBefore,
    notAfter: opts.leafNotAfter,
    extensions: leafExtensions,
  });

  const includeRoot = opts.includeRootInChain ?? true;
  const derChain = includeRoot
    ? [toDer(leaf), toDer(intermediate), toDer(root)]
    : [toDer(leaf), toDer(intermediate)];

  return {
    derChain,
    anchors: buildTrustAnchorSet([root.toString('pem')]),
    registeredKeyHex: await publicKeyHex(leafKeys.publicKey),
    challenge,
    leafSerial,
    certs: { leaf, intermediate, root },
    rootKeys,
    intermediateKeys,
    leafKeys,
  };
}

/** A revocation source where no serial is revoked. */
export const ALLOW_ALL_REVOCATION: RevocationStatusSource = {
  available: true,
  isRevoked: () => ({ revoked: false }),
};

/** A revocation source that is unavailable (forces fail-closed). */
export const UNAVAILABLE_REVOCATION: RevocationStatusSource = {
  available: false,
  isRevoked: () => ({ revoked: false }),
};

/** A revocation source that revokes the given normalized serials. */
export function revokeSerials(serials: string[]): RevocationStatusSource {
  const set = new Set(serials);
  return {
    available: true,
    isRevoked: (serial: string) => ({ revoked: set.has(serial) }),
  };
}

export { SecurityLevel, VerifiedBootState };
