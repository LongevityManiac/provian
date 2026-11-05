import { parseNonceJournal, sendWithCanonicalNonce, type NonceJournal, type CanonicalNonceRuntime, type SignedNonceAttempt } from './canonical-nonce';

function rig() {
  let state: NonceJournal | null = null;
  let time = 1000;
  let latest = 0;
  let finalized = 0;
  let generation = 0;
  const prepare = jest.fn(async (nonce: number) => ({ nonce, hash: `0x${(nonce + 1).toString(16).padStart(64, '0')}`, raw: `0x${(nonce + 1).toString(16).padStart(2, '0')}` }));
  const runtime: CanonicalNonceRuntime = {
    store: { transact: async (_key, change) => { state = parseNonceJournal(change(state)); return state!; } },
    now: () => time, owner: () => `worker-${generation++}`,
    latestNonce: async () => latest, finalizedNonce: async () => finalized,
    broadcast: jest.fn(async () => undefined), canReplay: true,
  };
  return { runtime, prepare, state: () => state, tick: (ms: number) => { time += ms; }, mined: (n: number) => { latest = n; }, finalized: (n: number) => { finalized = n; } };
}

describe('durable canonical signer nonce ownership', () => {
  it('persists signed bytes before the first broadcast and never needs pending RPC', async () => {
    const r = rig();
    const broadcast = jest.fn(async () => { expect(r.state()?.attempts[0]).toMatchObject({ nonce: 0, ready: true }); });
    await sendWithCanonicalNonce({ ...r.runtime, broadcast }, 'key', 'first', r.prepare);
    expect(r.state()?.next).toBe(1);
    expect(r.state()?.owner).toBeNull();
    expect(broadcast).toHaveBeenCalledTimes(1);
  });
  it('RED: an ambiguous broadcast survives restart and replays the identical nonce/raw before a new allocation', async () => {
    const r = rig();
    await expect(sendWithCanonicalNonce({ ...r.runtime, broadcast: async () => { throw new Error('lost_reply'); } }, 'key', 'a', r.prepare)).rejects.toThrow('lost_reply');
    const prior = r.state()!.attempts[0];
    const replay = jest.fn(async (_attempt: SignedNonceAttempt) => undefined);
    await sendWithCanonicalNonce({ ...r.runtime, broadcast: replay }, 'key', 'b', r.prepare);
    expect(replay.mock.calls[0][0]).toEqual(prior);
    expect(r.prepare.mock.calls.map(([nonce]) => nonce)).toEqual([0, 1]);
  });
  it('RED: a failed pre-broadcast business commit resumes the same intent and cannot buy a different action', async () => {
    const r = rig();
    await expect(sendWithCanonicalNonce(r.runtime, 'key', 'a', r.prepare, { beforeBroadcast: async () => { throw new Error('commit_failed'); } })).rejects.toThrow('commit_failed');
    expect(r.runtime.broadcast).not.toHaveBeenCalled();
    await expect(sendWithCanonicalNonce(r.runtime, 'key', 'b', r.prepare)).rejects.toThrow('uncommitted');
    const resumed = await sendWithCanonicalNonce(r.runtime, 'key', 'a', r.prepare, { beforeBroadcast: async () => undefined });
    expect(resumed.nonce).toBe(0);
    expect(r.prepare).toHaveBeenCalledTimes(1);
  });
  it('RED: later human approval never automatically submits a prior unconfirmed intent', async () => {
    const r = rig();
    await sendWithCanonicalNonce(r.runtime, 'key', 'a', r.prepare);
    const broadcast = jest.fn();
    await expect(sendWithCanonicalNonce({ ...r.runtime, canReplay: false, broadcast }, 'key', 'a', r.prepare)).rejects.toThrow('unconfirmed');
    expect(broadcast).not.toHaveBeenCalled();
  });
  it('RED: a stale holder cannot commit or broadcast after another process takes over', async () => {
    const r = rig();
    let resume!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { resume = resolve; });
    const old = sendWithCanonicalNonce(r.runtime, 'key', 'a', async (nonce) => { entered(); await blocked; return r.prepare(nonce); });
    await started;
    await expect(sendWithCanonicalNonce(r.runtime, 'key', 'b', r.prepare)).rejects.toThrow('busy');
    r.tick(180001);
    await sendWithCanonicalNonce(r.runtime, 'key', 'b', r.prepare);
    resume();
    await expect(old).rejects.toThrow('lease_lost');
    expect(r.runtime.broadcast).toHaveBeenCalledTimes(1);
    expect(r.state()?.attempts).toHaveLength(1);
  });
  it('canonical inclusion frees the next action; only finalized attempts are pruned', async () => {
    const r = rig();
    await sendWithCanonicalNonce(r.runtime, 'key', 'a', r.prepare);
    r.mined(1);
    await sendWithCanonicalNonce(r.runtime, 'key', 'b', r.prepare);
    expect(r.state()?.attempts.map((a) => a.nonce)).toEqual([0, 1]);
    r.finalized(1);
    await sendWithCanonicalNonce(r.runtime, 'key', 'c', r.prepare);
    expect(r.state()?.attempts.map((a) => a.nonce)).toEqual([1, 2]);
  });
  it('refuses nonce overrides that collide with ownership or leave a gap', async () => {
    const r = rig();
    await expect(sendWithCanonicalNonce(r.runtime, 'key', 'a', r.prepare, { nonce: 5 })).rejects.toThrow('conflicts');
    expect(r.runtime.broadcast).not.toHaveBeenCalled();
  });
});
