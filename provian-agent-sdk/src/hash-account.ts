import { concat } from 'ethers';
import { recoverySigningRoot, signRecoveryIntent } from './recourse-hash-authorization';
import { hashAccountContractDigest, hashAccountIntentDigest, type HashAccountIntent, type SignedHashAccountOperation } from './hash-account-data';
export * from './hash-account-data';

/** Stateless message proof for EIP-1271 consumers. It cannot execute an account
 * transaction; the consuming registry binds its own exact nonce and expiry. */
export async function signHashAccountMessage(account: string, digest: string, signingSeed: Uint8Array): Promise<string> {
  const commitment = await recoverySigningRoot(signingSeed);
  const proof = await signRecoveryIntent(signingSeed, hashAccountContractDigest(account, commitment, digest), {
    async reserve() { /* Message signing does not rotate account material. */ },
  });
  return concat([proof.publicKey, proof.signature]);
}
/** The durable callback must encrypt and retain both the exact intent and the
 * successor seed before any public signature is returned. A failed inner call
 * still rotates the account's key; the caller must retain the successor then. */
export async function prepareHashAccountOperation(input: {
  intent: Omit<HashAccountIntent, 'nextCommitment'>; signingSeed: Uint8Array; nextSigningSeed: Uint8Array;
  persistBeforeSigning(intent: HashAccountIntent, nextSeed: Uint8Array): Promise<void>;
}): Promise<SignedHashAccountOperation> {
  const nextCommitment = await recoverySigningRoot(input.nextSigningSeed);
  const intent = { ...input.intent, nextCommitment };
  if (nextCommitment === await recoverySigningRoot(input.signingSeed)) throw new Error('hash_account_reused_key');
  const digest = hashAccountIntentDigest(intent);
  const signed = await signRecoveryIntent(input.signingSeed, digest, {
    async reserve() { await input.persistBeforeSigning(intent, input.nextSigningSeed); },
  });
  return { ...intent, ...signed };
}
