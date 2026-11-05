import { createRequire } from 'node:module';
const { ethers } = createRequire(new URL('../../provian-backend/package.json', import.meta.url))('ethers');

/** One durable CREATE operation; an uncertain send never moves to a new nonce. */
export async function sendCanonicalDeployment({ provider, signer, call, prior, persist, expectedNonce, confirmations = 2 }) {
  const from = (await signer.getAddress()).toLowerCase();
  const chainId = (await provider.getNetwork()).chainId;
  if (chainId !== 8453n || call.to != null || BigInt(call.value ?? 0) !== 0n) throw new Error('deployment_call_invalid');
  const callHash = ethers.keccak256(call.data);
  let attempt = prior;
  if (attempt && (attempt.from !== from || attempt.callHash !== callHash || !Number.isSafeInteger(attempt.nonce) || attempt.nonce < 0)) throw new Error('deployment_operation_mismatch');
  if (!attempt) {
    const nonce = await provider.getTransactionCount(from, 'latest');
    if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error('deployment_nonce_invalid');
    if (expectedNonce !== undefined && nonce !== expectedNonce) throw new Error('deployment_nonce_conflict');
    attempt = { from, callHash, nonce, raw: null, hash: null };
    await persist(attempt);
  }
  if (expectedNonce !== undefined && attempt.nonce !== expectedNonce) throw new Error('deployment_nonce_conflict');
  if (!attempt.raw) {
    if (await provider.getTransactionCount(from, 'latest') !== attempt.nonce) throw new Error('deployment_nonce_conflict');
    const populated = await signer.populateTransaction({ ...call, nonce: attempt.nonce, chainId });
    const raw = await signer.signTransaction(populated);
    attempt = { ...attempt, raw, hash: ethers.keccak256(raw) };
    await persist(attempt);
  }
  const tx = ethers.Transaction.from(attempt.raw);
  if (tx.hash !== attempt.hash || tx.from?.toLowerCase() !== from || tx.chainId !== chainId
    || tx.nonce !== attempt.nonce || tx.to !== null || tx.value !== 0n || ethers.keccak256(tx.data) !== callHash) throw new Error('deployment_signed_binding_invalid');
  let receipt = await provider.getTransactionReceipt(attempt.hash);
  if (!receipt) {
    // Another device can consume this nonce. Keep the original bytes and refuse;
    // never turn an ambiguous deployment into another CREATE at the next nonce.
    if (await provider.getTransactionCount(from, 'latest') !== attempt.nonce) throw new Error(`deployment_submission_uncertain:${attempt.hash}`);
    try {
      const sent = await provider.broadcastTransaction(attempt.raw);
      if (sent.hash !== attempt.hash) throw new Error('deployment_broadcast_hash_mismatch');
    } catch (error) {
      if (!/already known|already imported/i.test(String(error))) throw error;
    }
  }
  // A recovered receipt must honor the same requested depth as a fresh send.
  receipt = await provider.waitForTransaction(attempt.hash, confirmations);
  if (!receipt || receipt.hash !== attempt.hash || receipt.status !== 1) throw new Error(`deployment_not_successful:${attempt.hash}`);
  return { receipt, hash: attempt.hash, nonce: attempt.nonce, predicted: ethers.getCreateAddress({ from, nonce: attempt.nonce }) };
}
