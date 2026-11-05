/** Local-only decryption, compatible with the SDK's sealed thread boxes. */
import { createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, hkdfSync } from 'node:crypto';
import { hchacha20 } from './recovery-seal';
import { splitThreadOutputSignature, type OutputSignature } from './output-signature';

export interface ThreadTextView {
  text: string | null;
  provian_output_signature: OutputSignature | null;
}

export function readThreadPlaintext(plaintext: string): ThreadTextView {
  const { text, signature } = splitThreadOutputSignature(plaintext);
  return { text, provian_output_signature: signature };
}

export function decryptLocalThreadMessage(privateKeyHex: string, ciphertext: string): ThreadTextView {
  const key = Buffer.from(privateKeyHex.replace(/^0x/, ''), 'hex');
  if (key.length !== 32 || !/^[A-Za-z0-9_-]+$/.test(ciphertext)) throw new Error('invalid thread key or ciphertext');
  const secret = Buffer.from(hkdfSync('sha256', key, Buffer.from('provian-thread-msgkey-v1'), Buffer.from('provian.thread.msgkey.v1'), 32));
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), secret]), type: 'pkcs8', format: 'der' });
  const pubkey = Buffer.from(createPublicKey(privateKey).export({ type: 'spki', format: 'der' })).subarray(-32);
  const blob = Buffer.from(ciphertext, 'base64url');
  if (blob.length < 49 || blob[0] !== 1) throw new Error('invalid thread ciphertext');
  let shared: Buffer | undefined;
  let okm: Buffer | undefined;
  let subkey: Buffer | undefined;
  try {
    const ephemeral = blob.subarray(1, 33);
    const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), ephemeral]), type: 'spki', format: 'der' });
    shared = diffieHellman({ privateKey, publicKey });
    okm = Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephemeral, pubkey]), Buffer.from('provian-agent-recovery-v1'), 56));
    const nonce = okm.subarray(32);
    subkey = hchacha20(okm.subarray(0, 32), nonce.subarray(0, 16));
    const decipher = createDecipheriv('chacha20-poly1305', subkey, Buffer.concat([Buffer.alloc(4), nonce.subarray(16)]), { authTagLength: 16 });
    const body = blob.subarray(33, -16);
    decipher.setAuthTag(blob.subarray(-16));
    decipher.setAAD(Buffer.concat([Buffer.of(1), pubkey]), { plaintextLength: body.length });
    return readThreadPlaintext(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'));
  } finally { key.fill(0); secret.fill(0); shared?.fill(0); okm?.fill(0); subkey?.fill(0); }
}
