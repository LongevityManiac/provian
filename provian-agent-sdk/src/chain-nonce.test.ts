import { describe, it, expect } from 'vitest';
import { Wallet, Transaction, keccak256 } from 'ethers';
import { sendChainOperation, ChainNonceError, type ChainNonceRuntime } from './chain-nonce';
import type { NonceJournal, NonceJournalStore, SignedNonceAttempt } from './canonical-nonce';
const signer = new Wallet(`0x${'12'.repeat(32)}`), KEY = `8453_${signer.address.toLowerCase()}`, CALL = 'intended-call';
function memory() {
  const docs = new Map<string, NonceJournal>();
  const store: NonceJournalStore = { transact: async (key, change) => {
    const next = change(docs.get(key) ?? null); docs.set(key, next); return next;
  } };
  return { docs, store };
}
function chain() {
  let nonce = 0, confirmed = 0, generation = 0;
  const included = new Set<string>(), wire: SignedNonceAttempt[] = [];
  const rig = (store = memory().store): ChainNonceRuntime => ({
    store, now: () => 1000, uuid: () => `worker${generation++}`,
    nonce: async () => nonce, resolveConsumption: async a => included.has(a.hash) ? 'own' : confirmed > a.nonce ? 'other' : 'unknown',
    included: async hash => included.has(hash), assertApproved: () => undefined,
    broadcast: async a => { wire.push(a); },
    validate: a => {
      const tx = Transaction.from(a.raw);
      if (tx.hash !== a.hash || tx.nonce !== a.nonce || tx.from !== signer.address) throw new Error('binding');
    },
  });
  return { rig, wire, included, mine: (a: SignedNonceAttempt) => { nonce = a.nonce + 1; confirmed = nonce; included.add(a.hash); }, count: () => nonce };
}
async function prepare(nonce: number, fee = 1n): Promise<Omit<SignedNonceAttempt, 'intent' | 'ready'>> {
  const raw = await signer.signTransaction({ to: signer.address, chainId: 8453, nonce,
    type: 2, gasLimit: 21000, maxFeePerGas: fee, maxPriorityFeePerGas: fee, value: 0n });
  return { raw, hash: keccak256(raw), nonce };
}
describe('canonical chain coordination and durable operation recovery', () => {
  it('two devices race the same nonce; the loser never silently moves the payment to another nonce', async () => {
    const c = chain(), a = c.rig(), b = c.rig();
    const first = await sendChainOperation(a, KEY, 'deviceA', CALL, prepare);
    await expect(sendChainOperation({ ...b, broadcast: async () => { throw new Error('replacement underpriced'); } }, KEY, 'deviceB', CALL, n => prepare(n, 2n)))
      .rejects.toMatchObject({ code: 'SUBMISSION_UNCERTAIN', operationId: 'deviceB' });
    c.mine(first);
    await expect(sendChainOperation(b, KEY, 'deviceB', CALL, prepare, { resume: true })).rejects.toMatchObject({ code: 'NONCE_CONFLICT' });
    expect(c.wire.map(a => a.nonce)).toEqual([0]);
    expect((await sendChainOperation(a, KEY, 'deviceA', CALL, prepare, { resume: true })).hash).toBe(first.hash);
  });
  it('a lost wire response resumes the exact operation/hash without a second payment nonce', async () => {
    const c = chain(), runtime = c.rig();
    await expect(sendChainOperation({ ...runtime, broadcast: async a => { c.wire.push(a); throw new Error('lost reply'); } }, KEY, 'payment', CALL, prepare))
      .rejects.toBeInstanceOf(ChainNonceError);
    const recovered = await sendChainOperation(runtime, KEY, 'payment', CALL, prepare, { resume: true });
    expect(c.wire).toHaveLength(2); expect(new Set(c.wire.map(a => a.hash)).size).toBe(1);
    expect(recovered.nonce).toBe(0); expect(c.count()).toBe(0);
  });
  it('intentional identical payments have distinct IDs/nonces; terminal retries retain their result', async () => {
    const c = chain(), runtime = c.rig();
    const first = await sendChainOperation(runtime, KEY, 'first', CALL, prepare); c.mine(first);
    const second = await sendChainOperation(runtime, KEY, 'second', CALL, prepare); c.mine(second);
    expect(c.wire.map(a => a.nonce)).toEqual([0, 1]);
    expect((await sendChainOperation(runtime, KEY, 'first', CALL, prepare, { resume: true })).hash).toBe(first.hash);
    expect(c.wire).toHaveLength(2);
  });
  it('a pre-wire crash preserves bytes and requires explicit fresh approval to submit them', async () => {
    const c = chain(), m = memory(); let crash = true;
    const store: NonceJournalStore = { transact: async (key, change) => {
      const next = change(m.docs.get(key) ?? null);
      if (crash && key.endsWith('_saved') && next.attempts.length) { crash = false; throw new Error('process died before wire'); }
      m.docs.set(key, next); return next;
    } };
    const runtime = c.rig(store);
    await expect(sendChainOperation(runtime, KEY, 'saved', CALL, prepare)).rejects.toThrow('process died'); expect(c.wire).toHaveLength(0);
    await expect(sendChainOperation({ ...runtime, assertApproved: () => { throw new Error('fresh approval required'); } }, KEY, 'saved', CALL,
      async () => { throw new Error('must not sign twice'); }, { resume: true })).rejects.toThrow('fresh approval');
    const recovered = await sendChainOperation(runtime, KEY, 'saved', CALL, async () => { throw new Error('must not sign twice'); }, { resume: true });
    expect(c.wire.map(a => a.hash)).toEqual([recovered.hash]);
  });
  it('changed semantics under one ID refuse before sign/wire', async () => {
    const c = chain(), runtime = c.rig(); await sendChainOperation(runtime, KEY, 'same-id', CALL, prepare);
    await expect(sendChainOperation(runtime, KEY, 'same-id', 'different amount', async () => { throw new Error('unreachable'); }, { resume: true }))
      .rejects.toMatchObject({ code: 'OPERATION_MISMATCH' }); expect(c.wire).toHaveLength(1);
  });
  it('receipt read errors cannot authorize another payment or become a conflict claim', async () => {
    const c = chain(), runtime = c.rig(); await sendChainOperation(runtime, KEY, 'saved', CALL, prepare);
    await expect(sendChainOperation({ ...runtime, included: async () => { throw new Error('receipt RPC unavailable'); } }, KEY, 'saved', CALL, prepare, { resume: true }))
      .rejects.toMatchObject({ code: 'SUBMISSION_UNCERTAIN', operationId: 'saved' }); expect(c.wire).toHaveLength(1);
  });
});

describe('canonical nonce consumer classification', () => {
  const txHash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
  const port = (consumer: 'own' | 'other' | 'missing' | 'authorization', reorg = false) => {
    let fullRead = false;
    return {
      head: async () => 30,
      count: async (height: number) => height < 10 ? 0 : 1,
      block: async (height: number, full: boolean) => {
        const changed = reorg && fullRead;
        if (full) fullRead = true;
        return { number: height, hash: txHash(height + (changed ? 1000 : 0)), transactions: full ? [{
          from: consumer === 'missing' || consumer === 'authorization' ? `0x${'34'.repeat(20)}` : signer.address,
          nonce: 0, hash: consumer === 'own' ? txHash(500) : txHash(600),
          authorizations: consumer === 'authorization' ? [{ authority: signer.address, nonce: 0 }] : [],
        }] : [] };
      },
    };
  };
  it('an owned canonical consumer wins even while its receipt index is absent', async () => {
    const { resolveCanonicalNonceConsumption } = await import('./chain-nonce.js');
    expect(await resolveCanonicalNonceConsumption(port('own'), signer.address, 0, txHash(500))).toBe('own');
    expect(await resolveCanonicalNonceConsumption(port('other'), signer.address, 0, txHash(500))).toBe('other');
  });
  it('missing consumer or changed canonical anchors preserve uncertainty', async () => {
    const { resolveCanonicalNonceConsumption } = await import('./chain-nonce.js');
    expect(await resolveCanonicalNonceConsumption(port('missing'), signer.address, 0, txHash(500))).toBe('unknown');
    expect(await resolveCanonicalNonceConsumption(port('other', true), signer.address, 0, txHash(500))).toBe('unknown');
  });
  it('an adapter-verified authority nonce consumption is another operation', async () => {
    const { resolveCanonicalNonceConsumption } = await import('./chain-nonce.js');
    expect(await resolveCanonicalNonceConsumption(port('authorization'), signer.address, 0, txHash(500))).toBe('other');
  });
  it('an unresolved previous submission blocks a blind new-operation retry even after inclusion', async () => {
    const c = chain(), runtime = c.rig();
    await expect(sendChainOperation({ ...runtime, broadcast: async a => { c.wire.push(a); throw new Error('lost response'); },
      included: async () => false }, KEY, 'old-operation', CALL, prepare)).rejects.toMatchObject({ code: 'SUBMISSION_UNCERTAIN' });
    c.mine(c.wire[0]);
    await expect(sendChainOperation(runtime, KEY, 'new-operation', CALL, prepare)).rejects.toMatchObject({ code: 'SUBMISSION_UNCERTAIN', operationId: 'old-operation' });
    expect(c.wire).toHaveLength(1);
    await sendChainOperation(runtime, KEY, 'old-operation', CALL, prepare, { resume: true });
    await sendChainOperation(runtime, KEY, 'new-operation', CALL, prepare);
    expect(c.wire.map(a => a.nonce)).toEqual([0, 1]);
  });
  it('explicit future nonce queues require acknowledged local ownership of every intervening nonce', async () => {
    const c = chain(), runtime = c.rig();
    await expect(sendChainOperation(runtime, KEY, 'gap', CALL, prepare, { nonce: 1 })).rejects.toMatchObject({ code: 'NONCE_CONFLICT' });
    await sendChainOperation(runtime, KEY, 'approve', CALL, prepare);
    const queued = await sendChainOperation(runtime, KEY, 'post', CALL, prepare, { nonce: 1 });
    expect(queued.nonce).toBe(1); expect(c.wire.map(a => a.nonce)).toEqual([0, 1]);
  });
});
