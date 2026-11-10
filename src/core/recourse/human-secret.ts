import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes } from '@noble/hashes/utils';

export function humanRecoverySecret(mnemonic: string, generation = 0): Uint8Array {
  if (!Number.isSafeInteger(generation) || generation < 0 || generation >= 0x80000000) throw new Error('recourse_account_index_invalid');
  return hkdf(sha256, utf8ToBytes(mnemonic.normalize('NFKD')),
    utf8ToBytes('provian.ownership.recovery.salt'), utf8ToBytes(generation === 0
      ? 'provian.ownership.recovery.secret' : `provian.ownership.recovery.secret:${generation}`), 32);
}

/** This key is independently domain-derived; revealing the recovery secret does
 * not reveal the hash-signing seed. Both remain recoverable from the seed backup. */
export function humanRecoverySigningSeed(mnemonic: string, generation = 0): Uint8Array {
  if (!Number.isSafeInteger(generation) || generation < 0 || generation >= 0x80000000) throw new Error('recourse_account_index_invalid');
  return hkdf(sha256, utf8ToBytes(mnemonic.normalize('NFKD')),
    utf8ToBytes('provian.ownership.hash-authorization.salt'),
    utf8ToBytes(`provian.ownership.hash-authorization.seed:${generation}`), 32);
}

export interface HumanBreakKeyContext {
  readonly identity: string;
  readonly breakOrigin: string;
  readonly chainId: string;
}
/** The existing encrypted mnemonic backup reconstructs every hash-key generation.
 * Each actual break has a separate domain, even when its last-good snapshot
 * rolls back to a commitment that was used before an earlier break. */
export function humanBreakKey(mnemonic: string, context: HumanBreakKeyContext,
  purpose: 'spending' | 'recovery-secret' | 'recovery-signing', generation: string): Uint8Array {
  if (!/^0x[0-9a-f]{64}$/.test(context.identity) || /^0x0+$/.test(context.identity)
    || !/^0x[0-9a-f]{40}$/.test(context.breakOrigin) || /^0x0+$/.test(context.breakOrigin)
    || !/^[1-9][0-9]*$/.test(context.chainId) || BigInt(context.chainId) >= 2n ** 256n
    || !/^(0|[1-9][0-9]*)$/.test(generation) || BigInt(generation) >= 2n ** 256n
    || !['spending', 'recovery-secret', 'recovery-signing'].includes(purpose)) throw Error('recourse_break_key_context_invalid');
  const material = utf8ToBytes(mnemonic.normalize('NFKD'));
  try {
    return hkdf(sha256, material, utf8ToBytes('provian.human.break.keys.v1'),
      utf8ToBytes(JSON.stringify([context.chainId, context.identity, context.breakOrigin, purpose, generation])), 32);
  } finally { material.fill(0); }
}
