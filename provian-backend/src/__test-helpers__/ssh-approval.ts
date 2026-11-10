import crypto from 'crypto';
import { decodeOpenSshEd25519PublicKey, type SshApprovalSignature, type SshApprovalVerifierConfig } from '../core/pvt/policy/approval-signature';
/** Ephemeral test-only key; never reads a real signing key or an agent socket. */
const MAGIC = Buffer.from('SSHSIG', 'ascii');

function sshString(value: Buffer | string): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value) : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

export function signTestSshApproval(
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

