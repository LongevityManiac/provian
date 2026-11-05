/**
 * follow-up — Solana identifiers enter lowercasing keys as exact bytes.
 *
 * The claim store lowercases every subject and event id. Base58 is case-sensitive, so a base58
 * value lowercased can merge two different keys. Each claim form here is checked against that
 * failure directly (RED: lowercasing the base58 collapses a case pair; the claim forms do not).
 */
import { describe, it, expect } from '@jest/globals';
import crypto from 'crypto';
import {
  SOLANA_CLAIM_INSTRUCTION_EVENT,
  SOLANA_CLAIM_SIGNATURE,
  SOLANA_CLAIM_SUBJECT,
  base58Decode,
  base58Encode,
  isSolanaAddress,
  isSolanaSignature,
  solanaClaimInstructionEvent,
  solanaClaimSignature,
  solanaClaimSubject,
  solanaInstructionEventId,
} from './solana-keys';

describe('solana-keys', () => {
  it('round-trips bytes, including leading zero bytes', () => {
    for (const bytes of [crypto.randomBytes(32), Buffer.concat([Buffer.alloc(3), crypto.randomBytes(29)]), crypto.randomBytes(64)]) {
      expect(Buffer.from(base58Decode(base58Encode(bytes)) as Uint8Array).equals(bytes)).toBe(true);
    }
    expect(base58Decode('0OIl')).toBeNull();
  });

  it('accepts a canonical 32-byte address / 64-byte signature only', () => {
    const address = base58Encode(crypto.randomBytes(32));
    const signature = base58Encode(crypto.randomBytes(64));
    expect(isSolanaAddress(address)).toBe(true);
    expect(isSolanaSignature(signature)).toBe(true);
    expect(isSolanaAddress(signature)).toBe(false);
    expect(isSolanaSignature(address)).toBe(false);
    expect(isSolanaAddress(`0x${'1'.repeat(40)}`)).toBe(false);
    expect(isSolanaAddress('z'.repeat(44))).toBe(false); // decodes to more than 32 bytes
    expect(isSolanaAddress(`1${address}`)).toBe(false); // a leading zero byte → 33 bytes
  });

  it('the claim forms are exact bytes in hex: lowercasing is a no-op and a case pair stays distinct', () => {
    // Find an address whose case-swapped spelling is ALSO a valid address (a different key).
    let a = '';
    let b = '';
    for (let i = 0; i < 5000 && !b; i += 1) {
      a = base58Encode(crypto.randomBytes(32));
      const swapped = a.replace(/[a-km-zA-HJ-NP-Z]/, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
      if (swapped !== a && isSolanaAddress(swapped)) b = swapped;
    }
    expect(b).not.toBe('');
    // RED: the naive key (lowercased base58) merges two different keys.
    expect(a.toLowerCase()).toBe(b.toLowerCase());
    // The claim forms do not.
    const sa = solanaClaimSubject(a) as string;
    const sb = solanaClaimSubject(b) as string;
    expect(sa).not.toBe(sb);
    expect(sa.toLowerCase()).toBe(sa);
    expect(SOLANA_CLAIM_SUBJECT.test(sa)).toBe(true);
  });

  it('signature and instruction-event forms', () => {
    const sig = base58Encode(crypto.randomBytes(64));
    const claimSig = solanaClaimSignature(sig) as string;
    expect(SOLANA_CLAIM_SIGNATURE.test(claimSig)).toBe(true);
    const readable = solanaInstructionEventId(sig, 2);
    expect(readable).toBe(`solana:${sig}:2`);
    expect(solanaClaimInstructionEvent(readable)).toBe(`${claimSig}:2`);
    expect(SOLANA_CLAIM_INSTRUCTION_EVENT.test(`${claimSig}:2`)).toBe(true);
    // RED: a leading-zero index, an EVM event, or a non-signature is not a Solana event.
    expect(solanaClaimInstructionEvent(`solana:${sig}:02`)).toBeNull();
    expect(solanaClaimInstructionEvent(`8453:0x${'ab'.repeat(32)}:1`)).toBeNull();
    expect(solanaClaimInstructionEvent(`solana:${base58Encode(crypto.randomBytes(32))}:1`)).toBeNull();
    expect(() => solanaInstructionEventId('nope', 1)).toThrow('solana_signature_invalid');
  });
});
