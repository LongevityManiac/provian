/**
 * Test-only reader for the unencrypted `openssh-key-v1` private keys the relay
 * generates for deploy-key proofs: the public key blob and its fingerprint,
 * and the private section's fields.
 */
import { OPENSSH_PEM_BEGIN, OPENSSH_PEM_END, sshFingerprint } from '../forge-deploy-key';

class Reader {
  private offset = 0;
  constructor(private readonly bytes: Buffer) {}
  uint32(): number {
    const value = this.bytes.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }
  string(): Buffer {
    const length = this.uint32();
    const value = this.bytes.subarray(this.offset, this.offset + length);
    if (value.length !== length) throw new Error('truncated ssh string');
    this.offset += length;
    return value;
  }
  raw(length: number): Buffer {
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
  rest(): Buffer {
    return this.bytes.subarray(this.offset);
  }
}

export interface ParsedOpenSshKey {
  cipher: string;
  kdf: string;
  publicBlob: Buffer;
  fingerprint: string;
  check1: Buffer;
  check2: Buffer;
  keyType: string;
  publicKey: Buffer;
  /** 64 bytes: seed || public key. */
  secret: Buffer;
  comment: string;
  padding: Buffer;
}

export function parseOpenSshPrivateKey(pem: string): ParsedOpenSshKey {
  const prefix = `${OPENSSH_PEM_BEGIN}\n`;
  const suffix = `\n${OPENSSH_PEM_END}\n`;
  const armored = pem.startsWith(prefix) && pem.endsWith(suffix) ? pem.slice(prefix.length, pem.length - suffix.length) : null;
  const match = armored !== null && /^[A-Za-z0-9+/=\n]+$/.test(armored) ? [pem, armored] : null;
  if (!match) throw new Error('not an OpenSSH private key');
  const body = Buffer.from(match[1].replace(/\n/g, ''), 'base64');
  const magic = Buffer.from('openssh-key-v1\0');
  if (!body.subarray(0, magic.length).equals(magic)) throw new Error('bad magic');
  const outer = new Reader(body.subarray(magic.length));
  const cipher = outer.string().toString();
  const kdf = outer.string().toString();
  outer.string();
  if (outer.uint32() !== 1) throw new Error('expected one key');
  const publicBlob = outer.string();
  const section = new Reader(outer.string());
  const check1 = section.raw(4);
  const check2 = section.raw(4);
  const keyType = section.string().toString();
  const publicKey = section.string();
  const secret = section.string();
  const comment = section.string().toString();
  return {
    cipher, kdf, publicBlob, fingerprint: sshFingerprint(publicBlob),
    check1, check2, keyType, publicKey, secret, comment, padding: section.rest(),
  };
}

/** The `SHA256:` fingerprint of the key a runner was handed. */
export function fingerprintOfPrivateKey(pem: string): string {
  return parseOpenSshPrivateKey(pem).fingerprint;
}
