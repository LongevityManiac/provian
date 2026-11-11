import { test, expect, vi } from 'vitest';
import { Wallet, getBytes } from 'ethers';
import { exerciseSignatureQueue } from './exercise-signature-queue.mjs';
import { exerciseMembershipChallenge } from './exercise-membership.mjs';
const owner = new Wallet('0x' + '11'.repeat(32)), other = new Wallet('0x' + '22'.repeat(32));
const challenge = () => exerciseMembershipChallenge({ chainId: '31337', pointer: '0x' + '33'.repeat(20),
  kernel: '0x' + '44'.repeat(20), pool: '0x' + '55'.repeat(20) }, 'setAddressConsent', {
  binding: '0x' + '66'.repeat(32), account: owner.address.toLowerCase(), nonce: '0', joined: true, revision: '1',
  ruleHash: '0x' + '77'.repeat(32), expiresAt: '1900000000' });
test('only the requested wallet and exact signature can resolve a pending exercise command', async () => {
  const q = exerciseSignatureQueue(), original = challenge(), pending = q.request(original);
  original.summary = 'changed'; const row = q.read(owner.address);
  expect(row.challenge.summary).not.toBe('changed'); expect(q.read(other.address)).toBeNull();
  await expect(q.request(challenge())).rejects.toThrow('already_pending');
  const signature = await owner.signMessage(getBytes(row.challenge.messageHex));
  expect(() => q.submit(other.address, row.id, signature)).toThrow('request_changed');
  expect(() => q.submit(owner.address, 'wrong', signature)).toThrow('request_changed');
  const wrong = await other.signMessage(getBytes(row.challenge.messageHex));
  expect(() => q.submit(owner.address, row.id, wrong)).toThrow('wrong_wallet');
  q.submit(owner.address, row.id, signature); expect(await pending).toBe(signature); expect(q.read(owner.address)).toBeNull();
  expect(() => q.submit(owner.address, row.id, signature)).toThrow('request_changed');
});
test('timeout and workbench closure stop the exercise without fabricating a signature', async () => {
  vi.useFakeTimers();
  try {
    const q = exerciseSignatureQueue(), first = q.request(challenge()), expired = expect(first).rejects.toThrow('expired');
    await vi.advanceTimersByTimeAsync(180000); await expired; expect(q.read(owner.address)).toBeNull();
    const second = q.request(challenge()), closed = expect(second).rejects.toThrow('workbench_closed'); q.close(); await closed;
  } finally { vi.useRealTimers(); }
});
