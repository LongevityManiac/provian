import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';

const salt = utf8ToBytes('provian.recourse.hash-signature.salt');
const domain = utf8ToBytes('provian.recourse.hash-signature.slh-dsa-sha2-128s');
export interface OwnerIntentJournal {
  /** Persist before publishing to make retries repeatable; signature safety
   * does not depend on retaining this journal after a backup restoration. */
  reserve(root: string, intent: string): Promise<void>;
}
export interface HashOwnerSignature { readonly signingRoot: string; readonly publicKey: string; readonly signature: string; }
async function signingKeys(seed: Uint8Array): Promise<{ publicKey: Uint8Array; secretKey: Uint8Array }> {
  const { slh_dsa_sha2_128s } = await import("@noble/post-quantum/slh-dsa.js");
  if (seed.length !== 32) throw new Error('recourse_signing_seed_invalid');
  const expanded = hkdf(sha256, seed, salt, domain, 48);
  try { return slh_dsa_sha2_128s.keygen(expanded); } finally { expanded.fill(0); }
}
/** Signing seed is independent of the disclosed recovery secret. */
export async function recoverySigningRoot(signingSeed: Uint8Array): Promise<string> {
  const keys = await signingKeys(signingSeed);
  try { return `0x${bytesToHex(sha256(keys.publicKey))}`; } finally { keys.secretKey.fill(0); }
}
export function recoveryCommitment(secret: Uint8Array, signingRoot: string): string {
  if (secret.length !== 32 || !/^0x[0-9a-f]{64}$/.test(signingRoot)) throw new Error('recourse_commitment_invalid');
  const preimage = new Uint8Array(64);
  preimage.set(secret); preimage.set(hexToBytes(signingRoot.slice(2)), 32);
  try { return `0x${bytesToHex(sha256(preimage))}`; } finally { preimage.fill(0); }
}
/** Stateless SLH-DSA remains safe across retries, concurrent devices and old
 * backups. The on-chain nonce and full intent prevent transaction replay. */
export async function signRecoveryIntent(signingSeed: Uint8Array, intent: string, journal: OwnerIntentJournal): Promise<HashOwnerSignature> {
  if (!/^0x[0-9a-f]{64}$/.test(intent)) throw new Error('recourse_intent_invalid');
  const keys = await signingKeys(signingSeed);
  try {
    const signingRoot = `0x${bytesToHex(sha256(keys.publicKey))}`;
    await journal.reserve(signingRoot, intent);
    // Deterministic mode is specified by SLH-DSA; repeated messages need no new
    // randomness and different messages remain safe under the same signing key.
    const { slh_dsa_sha2_128s } = await import("@noble/post-quantum/slh-dsa.js");
    const signature = slh_dsa_sha2_128s.sign(hexToBytes(intent.slice(2)), keys.secretKey, { extraEntropy: false });
    return { signingRoot, publicKey: `0x${bytesToHex(keys.publicKey)}`, signature: `0x${bytesToHex(signature)}` };
  } finally { keys.secretKey.fill(0); }
}
