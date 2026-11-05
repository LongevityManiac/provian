import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1';
import { deriveAddressFromPrivateKey, generateAgentKeyPair, signPoPChallenge } from './crypto';
import { signEip191Message } from '../eip191';
import { keccak256 } from './keccak256';

describe('generateAgentKeyPair', () => {
  it('produces a 32-byte private key, 64-byte public key, and checksummed address', () => {
    const kp = generateAgentKeyPair();
    expect(kp.privateKey).toMatch(/^[0-9a-f]{64}$/);
    expect(kp.publicKey).toMatch(/^[0-9a-f]{128}$/);
    expect(kp.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // EIP-55: mixed case (astronomically unlikely to be all-lower for a random key)
    expect(kp.address).not.toBe(kp.address.toLowerCase());
  });

  it('derives the same address from the private key (round-trip)', () => {
    const kp = generateAgentKeyPair();
    expect(deriveAddressFromPrivateKey(kp.privateKey)).toBe(kp.address);
    expect(deriveAddressFromPrivateKey('0x' + kp.privateKey)).toBe(kp.address);
  });

  it('generates distinct keys per call', () => {
    expect(generateAgentKeyPair().privateKey).not.toBe(generateAgentKeyPair().privateKey);
  });
});

describe('signPoPChallenge', () => {
  it('produces a DER ECDSA-SHA256 signature verifiable against the public key', () => {
    const kp = generateAgentKeyPair();
    const challenge = 'provian-pop-challenge-0123456789abcdef';
    const derHex = signPoPChallenge(kp.privateKey, challenge);
    expect(derHex).toMatch(/^[0-9a-f]+$/);

    // Verify exactly the way the relay does: ECDSA over sha256(challenge).
    // lowS: false — Node's createSign does NOT normalize S (openssl style),
    // and the relay accepts that; @noble's strict low-S default would reject
    // roughly half of all valid Node-crypto signatures.
    const msgHash = createHash('sha256').update(challenge).digest();
    const sig = secp256k1.Signature.fromDER(derHex);
    const ok = secp256k1.verify(sig, msgHash, '04' + kp.publicKey, { lowS: false });
    expect(ok).toBe(true);
  });
});

describe('signEip191Message', () => {
  it('produces a 65-byte r||s||v signature that recovers to the signing address', () => {
    const kp = generateAgentKeyPair();
    const message = 'Provian external-address proof: nonce 42';
    const signature = signEip191Message(kp.privateKey, message);
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);

    // Recover the signer the way ethers.verifyMessage does
    const body = Buffer.from(message, 'utf-8');
    const prefixed = Buffer.concat([
      Buffer.from(`\x19Ethereum Signed Message:\n${body.length}`, 'utf-8'),
      body,
    ]);
    const digest = keccak256(prefixed);
    const r = BigInt('0x' + signature.slice(2, 66));
    const s = BigInt('0x' + signature.slice(66, 130));
    const v = parseInt(signature.slice(130, 132), 16);
    const sig = new secp256k1.Signature(r, s).addRecoveryBit(v - 27);
    const recovered = sig.recoverPublicKey(digest).toRawBytes(false);
    const recoveredAddress = '0x' + Buffer.from(keccak256(Buffer.from(recovered.subarray(1))).subarray(12)).toString('hex');
    expect(recoveredAddress.toLowerCase()).toBe(kp.address.toLowerCase());
  });

  it('rejects malformed keys', () => {
    expect(() => signEip191Message('deadbeef', 'x')).toThrow(/64 hex chars/);
  });
});
