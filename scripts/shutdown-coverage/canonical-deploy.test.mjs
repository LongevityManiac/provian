import { describe, it, expect, vi } from 'vitest';
import { Wallet, keccak256 } from 'ethers';
import { sendCanonicalDeployment } from './canonical-deploy.mjs';
function rig() {
  const wallet = new Wallet(`0x${'13'.repeat(32)}`);
  let saved, nonce = 0, receipt = null;
  const wire = vi.fn(async raw => { expect(saved.raw).toBe(raw); return { hash: keccak256(raw) }; });
  const provider = { getNetwork: async () => ({ chainId: 8453n }), getTransactionCount: vi.fn(async (_from, tag) => { expect(tag).toBe('latest'); return nonce; }),
    getTransactionReceipt: async () => receipt, broadcastTransaction: wire, waitForTransaction: vi.fn(async hash => ({ hash, status: 1 })) };
  const signer = { getAddress: async () => wallet.address,
    populateTransaction: async tx => { expect(Number.isSafeInteger(tx.nonce)).toBe(true); return { ...tx, type: 2, gasLimit: 1000000, maxFeePerGas: 2, maxPriorityFeePerGas: 1 }; },
    signTransaction: tx => wallet.signTransaction(tx) };
  const run = (call = { data: '0x60006000' }) => sendCanonicalDeployment({ provider, signer, call, prior: saved,
    persist: async attempt => { saved = structuredClone(attempt); } });
  return { run, wire, provider, saved: () => saved, setNonce: n => { nonce = n; }, setReceipt: r => { receipt = r; } };
}
describe('manual CREATE canonical nonce recovery', () => {
  it('persists signed bytes before wire and recovers a lost reply without another CREATE', async () => {
    const r = rig(); r.wire.mockImplementationOnce(async () => { throw new Error('lost reply'); });
    await expect(r.run()).rejects.toThrow('lost reply');
    const attempt = r.saved(); expect(attempt.raw).toMatch(/^0x/);
    r.setNonce(1); r.setReceipt({ hash: attempt.hash, status: 1 });
    expect((await r.run()).hash).toBe(attempt.hash);
    expect(r.wire).toHaveBeenCalledTimes(1);
    expect(r.provider.waitForTransaction).toHaveBeenCalledWith(attempt.hash, 2);
  });
  it('refuses a competing device nonce, changed intent, or mismatched signed bytes', async () => {
    const r = rig(); r.wire.mockRejectedValueOnce(new Error('lost reply'));
    await expect(r.run()).rejects.toThrow('lost reply');
    r.setNonce(1);
    await expect(r.run()).rejects.toThrow('deployment_submission_uncertain');
    await expect(r.run({ data: '0x60016000' })).rejects.toThrow('deployment_operation_mismatch');
    r.saved().hash = `0x${'00'.repeat(32)}`;
    await expect(r.run()).rejects.toThrow('deployment_signed_binding_invalid');
    expect(r.wire).toHaveBeenCalledTimes(1);
  });
  it('a failed persistence boundary cannot reach the wire', async () => {
    const r = rig();
    await expect(sendCanonicalDeployment({ provider: r.provider, signer: { getAddress: async () => '0x'+'13'.repeat(20) }, call: { data: '0x6000' },
      persist: async () => { throw new Error('disk unavailable'); } })).rejects.toThrow('disk unavailable');
    expect(r.wire).not.toHaveBeenCalled();
  });
  it('a nonce changing after the expected CREATE preflight cannot sign or broadcast', async () => {
    const r = rig(); r.setNonce(1); const sign = vi.fn(); const persist = vi.fn();
    await expect(sendCanonicalDeployment({ provider: r.provider, signer: { getAddress: async () => '0x'+'13'.repeat(20), signTransaction: sign },
      call: { data: '0x6000' }, expectedNonce: 0, persist })).rejects.toThrow('deployment_nonce_conflict');
    expect(sign).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled(); expect(r.wire).not.toHaveBeenCalled();
  });

});
