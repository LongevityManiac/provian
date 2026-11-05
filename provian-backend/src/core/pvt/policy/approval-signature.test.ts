import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  decodeOpenSshEd25519PublicKey,
  verifySshApprovalSignature,
  type SshApprovalSignature,
  type SshApprovalVerifierConfig,
} from './approval-signature';

const MAGIC = Buffer.from('SSHSIG', 'ascii');

function sshString(value: Buffer | string): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value) : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function fixture(
  message: Buffer,
  namespace = 'provian-pvt-policy',
  reserved = Buffer.alloc(0),
) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const rawKey = spki.subarray(spki.length - 32);
  const publicBlob = Buffer.concat([sshString('ssh-ed25519'), sshString(rawKey)]);
  const openSshPublicKey = `ssh-ed25519 ${publicBlob.toString('base64')} frank-test`;
  const publicKeySha256 = decodeOpenSshEd25519PublicKey(openSshPublicKey).sha256;
  const hashAlgorithm = 'sha512';
  const digest = crypto.createHash(hashAlgorithm).update(message).digest();
  const signedData = Buffer.concat([
    MAGIC,
    sshString(namespace),
    sshString(reserved),
    sshString(hashAlgorithm),
    sshString(digest),
  ]);
  const rawSignature = crypto.sign(null, signedData, privateKey);
  const signatureBlob = Buffer.concat([
    sshString('ssh-ed25519'),
    sshString(rawSignature),
  ]);
  const version = Buffer.alloc(4);
  version.writeUInt32BE(1);
  const sshsig = Buffer.concat([
    MAGIC,
    version,
    sshString(publicBlob),
    sshString(namespace),
    sshString(reserved),
    sshString(hashAlgorithm),
    sshString(signatureBlob),
  ]);
  const base64 = sshsig.toString('base64').match(/.{1,70}/g)!.join('\n');
  const signature: SshApprovalSignature = {
    scheme: 'sshsig-ed25519',
    signer_identity: 'frank',
    namespace,
    public_key_sha256: publicKeySha256,
    armored_signature:
      `-----BEGIN SSH SIGNATURE-----\n${base64}\n-----END SSH SIGNATURE-----`,
  };
  const config: SshApprovalVerifierConfig = {
    signerIdentity: 'frank',
    namespace: 'provian-pvt-policy',
    openSshPublicKey,
    publicKeySha256,
  };
  return { signature, config };
}

describe('exact-manifest SSHSIG approval verification', () => {
  const message = Buffer.from('{"exact":"manifest"}\n', 'utf8');

  it('verifies a valid Ed25519 SSHSIG over the exact bytes', () => {
    const { signature, config } = fixture(message);
    expect(verifySshApprovalSignature(message, signature, config)).toBe(true);
  });

  it('rejects any changed manifest byte', () => {
    const { signature, config } = fixture(message);
    expect(verifySshApprovalSignature(
      Buffer.from('{"exact":"manifest"} \n', 'utf8'),
      signature,
      config,
    )).toBe(false);
  });

  it('rejects a different configured personal key', () => {
    const signed = fixture(message);
    const other = fixture(message);
    expect(verifySshApprovalSignature(message, signed.signature, {
      ...other.config,
      publicKeySha256: signed.signature.public_key_sha256,
    })).toBe(false);
  });

  it('rejects the wrong namespace and a non-Frank signer identity', () => {
    const wrongNamespace = fixture(message, 'file');
    expect(verifySshApprovalSignature(
      message,
      wrongNamespace.signature,
      wrongNamespace.config,
    )).toBe(false);
    const signed = fixture(message);
    expect(verifySshApprovalSignature(message, {
      ...signed.signature,
      signer_identity: 'automation',
    }, signed.config)).toBe(false);
  });

  it('rejects a non-signature reference string disguised as armor', () => {
    const { signature, config } = fixture(message);
    expect(verifySshApprovalSignature(message, {
      ...signature,
      armored_signature: 'ssh-signature:non-empty-reference',
    }, config)).toBe(false);
  });

  it('rejects a genuine SSHSIG carrying a non-empty reserved/reference field', () => {
    const { signature, config } = fixture(
      message,
      'provian-pvt-policy',
      Buffer.from('reference-not-supported', 'utf8'),
    );
    expect(verifySshApprovalSignature(message, signature, config)).toBe(false);
  });

  it('rejects malformed and truncated SSHSIG input', () => {
    const { signature, config } = fixture(message);
    expect(verifySshApprovalSignature(message, {
      ...signature,
      armored_signature: '-----BEGIN SSH SIGNATURE-----\nU1NIU0lH\n-----END SSH SIGNATURE-----',
    }, config)).toBe(false);
  });
});

describe('real OpenSSH Ed25519 SSHSIG fixtures', () => {
  const fixtureDir = path.join(__dirname, '__fixtures__', 'approval');
  const publicKey = fs.readFileSync(path.join(fixtureDir, 'fixture-key.pub'), 'utf8').trim();
  const publicKeySha256 = decodeOpenSshEd25519PublicKey(publicKey).sha256;
  const config: SshApprovalVerifierConfig = {
    signerIdentity: 'frank',
    namespace: 'provian-pvt-policy',
    openSshPublicKey: publicKey,
    publicKeySha256,
  };
  const signature = (name: 'a' | 'b'): SshApprovalSignature => ({
    scheme: 'sshsig-ed25519',
    signer_identity: 'frank',
    namespace: 'provian-pvt-policy',
    public_key_sha256: publicKeySha256,
    armored_signature: fs.readFileSync(
      path.join(fixtureDir, `manifest-${name}.json.sig`),
      'utf8',
    ),
  });
  const manifestA = fs.readFileSync(path.join(fixtureDir, 'manifest-a.json'));
  const manifestB = fs.readFileSync(path.join(fixtureDir, 'manifest-b.json'));

  it('verifies two distinct exact byte sequences produced by ssh-keygen -Y sign', () => {
    expect(manifestA.equals(manifestB)).toBe(false);
    expect(verifySshApprovalSignature(manifestA, signature('a'), config)).toBe(true);
    expect(verifySshApprovalSignature(manifestB, signature('b'), config)).toBe(true);
  });

  it('proves a signature for manifest A cannot authorize manifest B', () => {
    expect(verifySshApprovalSignature(manifestB, signature('a'), config)).toBe(false);
    expect(verifySshApprovalSignature(manifestA, signature('b'), config)).toBe(false);
  });
});
