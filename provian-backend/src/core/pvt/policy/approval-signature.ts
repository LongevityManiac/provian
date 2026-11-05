import crypto from 'crypto';

const SSHSIG_MAGIC = Buffer.from('SSHSIG', 'ascii');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const HASH_ALGORITHMS = new Set(['sha256', 'sha512']);
const MAX_SSH_FIELD_BYTES = 128 * 1024;

export interface SshApprovalVerifierConfig {
  readonly signerIdentity: string;
  readonly namespace: string;
  readonly openSshPublicKey: string;
  /** sha256 hex commitment to the decoded SSH public-key blob. */
  readonly publicKeySha256: string;
}

export interface SshApprovalSignature {
  readonly scheme: 'sshsig-ed25519';
  readonly signer_identity: string;
  readonly namespace: string;
  readonly public_key_sha256: string;
  readonly armored_signature: string;
}

interface Cursor {
  offset: number;
}

function readSshString(bytes: Buffer, cursor: Cursor): Buffer {
  if (cursor.offset + 4 > bytes.length) throw new Error('sshsig_truncated');
  const length = bytes.readUInt32BE(cursor.offset);
  cursor.offset += 4;
  if (length > MAX_SSH_FIELD_BYTES || cursor.offset + length > bytes.length) {
    throw new Error('sshsig_field_invalid');
  }
  const value = bytes.subarray(cursor.offset, cursor.offset + length);
  cursor.offset += length;
  return value;
}

function sshString(value: Buffer | string): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
}

function decodeArmoredSignature(armored: string): Buffer {
  const match = armored.trim().match(
    /^-----BEGIN SSH SIGNATURE-----\s+([A-Za-z0-9+/=\s]+?)\s+-----END SSH SIGNATURE-----$/,
  );
  if (!match) throw new Error('sshsig_armor_invalid');
  const normalized = match[1].replace(/\s+/g, '');
  if (!normalized || normalized.length > 256 * 1024) throw new Error('sshsig_armor_invalid');
  const bytes = Buffer.from(normalized, 'base64');
  if (bytes.length === 0 || bytes.toString('base64').replace(/=+$/, '')
    !== normalized.replace(/=+$/, '')) {
    throw new Error('sshsig_base64_invalid');
  }
  return bytes;
}

export function decodeOpenSshEd25519PublicKey(openSsh: string): {
  blob: Buffer;
  rawKey: Buffer;
  sha256: string;
} {
  const parts = openSsh.trim().split(/\s+/);
  if (parts.length < 2 || parts[0] !== 'ssh-ed25519') {
    throw new Error('approval_public_key_not_ed25519');
  }
  const blob = Buffer.from(parts[1], 'base64');
  const cursor: Cursor = { offset: 0 };
  const algorithm = readSshString(blob, cursor).toString('ascii');
  const rawKey = readSshString(blob, cursor);
  if (algorithm !== 'ssh-ed25519' || rawKey.length !== 32 || cursor.offset !== blob.length) {
    throw new Error('approval_public_key_invalid');
  }
  return {
    blob,
    rawKey,
    sha256: `sha256:${crypto.createHash('sha256').update(blob).digest('hex')}`,
  };
}

export function verifySshApprovalSignature(
  exactMessageBytes: Buffer,
  signature: SshApprovalSignature,
  config: SshApprovalVerifierConfig,
): boolean {
  try {
    if (signature.scheme !== 'sshsig-ed25519'
      || signature.signer_identity !== config.signerIdentity
      || signature.namespace !== config.namespace
      || signature.public_key_sha256 !== config.publicKeySha256
      || !/^sha256:[a-f0-9]{64}$/.test(config.publicKeySha256)) return false;
    const configured = decodeOpenSshEd25519PublicKey(config.openSshPublicKey);
    if (configured.sha256 !== config.publicKeySha256) return false;

    const bytes = decodeArmoredSignature(signature.armored_signature);
    if (bytes.length < SSHSIG_MAGIC.length
      || !bytes.subarray(0, SSHSIG_MAGIC.length).equals(SSHSIG_MAGIC)) return false;
    const cursor: Cursor = { offset: SSHSIG_MAGIC.length };
    const version = bytes.readUInt32BE(cursor.offset);
    cursor.offset += 4;
    if (version !== 1) return false;
    const embeddedPublicKey = readSshString(bytes, cursor);
    const namespace = readSshString(bytes, cursor).toString('utf8');
    const reserved = readSshString(bytes, cursor);
    const hashAlgorithm = readSshString(bytes, cursor).toString('ascii');
    const signatureBlob = readSshString(bytes, cursor);
    if (cursor.offset !== bytes.length
      || !embeddedPublicKey.equals(configured.blob)
      || namespace !== config.namespace
      || namespace !== signature.namespace
      || reserved.length !== 0
      || !HASH_ALGORITHMS.has(hashAlgorithm)) return false;

    const signatureCursor: Cursor = { offset: 0 };
    const signatureAlgorithm = readSshString(signatureBlob, signatureCursor).toString('ascii');
    const rawSignature = readSshString(signatureBlob, signatureCursor);
    if (signatureAlgorithm !== 'ssh-ed25519'
      || rawSignature.length !== 64
      || signatureCursor.offset !== signatureBlob.length) return false;

    const messageHash = crypto.createHash(hashAlgorithm).update(exactMessageBytes).digest();
    const signedData = Buffer.concat([
      SSHSIG_MAGIC,
      sshString(namespace),
      sshString(reserved),
      sshString(hashAlgorithm),
      sshString(messageHash),
    ]);
    const publicKey = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, configured.rawKey]),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(null, signedData, publicKey, rawSignature);
  } catch {
    return false;
  }
}

export function approvalVerifierConfigFromEnv(): SshApprovalVerifierConfig | null {
  const openSshPublicKey = process.env.FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY;
  const publicKeySha256 = process.env.FRANK_PVT_APPROVAL_SSH_KEY_SHA256;
  if (!openSshPublicKey || !publicKeySha256) return null;
  return {
    signerIdentity: 'frank',
    namespace: 'provian-pvt-policy',
    openSshPublicKey,
    publicKeySha256,
  };
}
