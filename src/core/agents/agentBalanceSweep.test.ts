import { describe, it, expect } from 'vitest';
import { runAgentPvtSweep, type AgentSweepDeps } from './agentBalanceSweep';

const OLD_ADDR = '0x1111111111111111111111111111111111111111';
const NEW_ADDR = '0x2222222222222222222222222222222222222222';
const OLD_KEY = 'a'.repeat(64);
const PVT = (n: bigint): bigint => n * 10n ** 18n;

interface Rec {
  broadcast: Array<{ oldKeyHex: string; newAddress: string; amount: bigint }>;
  prefund: Array<{ oldAddress: string; amountWei: bigint }>;
}

function makeDeps(over: Partial<AgentSweepDeps> & {
  balance?: bigint;
  native?: bigint | (() => bigint);
  gasCostWei?: bigint;
} = {}): { deps: AgentSweepDeps; rec: Rec } {
  const rec: Rec = { broadcast: [], prefund: [] };
  let nativeReads = 0;
  const deps: AgentSweepDeps = {
    deriveAddress: over.deriveAddress ?? (() => OLD_ADDR),
    readPvtBalanceAtomic: over.readPvtBalanceAtomic ?? (async () => over.balance ?? PVT(5n)),
    readNativeWei: over.readNativeWei ?? (async () => {
      nativeReads += 1;
      const n = over.native ?? 0n;
      return typeof n === 'function' ? n() : n;
    }),
    estimateGasCostWei: over.estimateGasCostWei ?? (async () => over.gasCostWei ?? 10n ** 14n /* 0.0001 ETH */),
    prefundGasFromHuman: over.prefundGasFromHuman ?? (async (oldAddress, amountWei) => { rec.prefund.push({ oldAddress, amountWei }); }),
    broadcastSweep: over.broadcastSweep ?? (async (oldKeyHex, newAddress, amount) => {
      rec.broadcast.push({ oldKeyHex, newAddress, amount });
      return { txHash: '0xdead', explorerUrl: 'https://basescan.org/tx/0xdead' };
    }),
  };
  return { deps, rec };
}

describe('agentBalanceSweep — happy path', () => {
  it('sweeps the FULL balance to the new address when there is gas', async () => {
    const { deps, rec } = makeDeps({ balance: PVT(5n), native: PVT(1n) /* has ETH */ });
    const res = await runAgentPvtSweep({ oldKeyHex: OLD_KEY, newAddress: NEW_ADDR }, deps);
    expect(res.status).toBe('swept');
    if (res.status === 'swept') {
      expect(res.amountAtomic).toBe(PVT(5n).toString());
      expect(res.newAddress).toBe(NEW_ADDR);
      expect(res.txHash).toBe('0xdead');
    }
    expect(rec.broadcast).toHaveLength(1);
    expect(rec.broadcast[0]).toMatchObject({ oldKeyHex: OLD_KEY, newAddress: NEW_ADDR, amount: PVT(5n) });
    expect(rec.prefund).toHaveLength(0); // had gas, no funding needed
  });

  it('returns nothing_to_sweep on a zero balance and never broadcasts', async () => {
    const { deps, rec } = makeDeps({ balance: 0n });
    const res = await runAgentPvtSweep({ oldKeyHex: OLD_KEY, newAddress: NEW_ADDR }, deps);
    expect(res.status).toBe('nothing_to_sweep');
    expect(rec.broadcast).toHaveLength(0);
  });
});

describe('agentBalanceSweep — gas', () => {
  it('reports insufficient_gas (exact stranded amount) with no confirm callback and NEVER broadcasts', async () => {
    const { deps, rec } = makeDeps({ balance: PVT(3n), native: 0n /* no ETH */, gasCostWei: 10n ** 14n });
    const res = await runAgentPvtSweep({ oldKeyHex: OLD_KEY, newAddress: NEW_ADDR }, deps);
    expect(res.status).toBe('insufficient_gas');
    if (res.status === 'insufficient_gas') {
      expect(res.strandedAtomic).toBe(PVT(3n).toString());
      expect(res.oldAddress).toBe(OLD_ADDR);
    }
    // RED CONTROL: removing the `nativeWei < gasCostWei` short-circuit would let the
    // broadcast fire against a no-ETH address. It must stay at zero here.
    expect(rec.broadcast).toHaveLength(0);
    expect(rec.prefund).toHaveLength(0);
  });

  it('confirm=true → funds gas from the human wallet, then sweeps', async () => {
    // Native is empty on the first read, funded on the second (after the prefund).
    let reads = 0;
    const { deps, rec } = makeDeps({
      balance: PVT(2n),
      gasCostWei: 10n ** 14n,
      readNativeWei: async () => { reads += 1; return reads === 1 ? 0n : PVT(1n); },
    });
    const res = await runAgentPvtSweep(
      { oldKeyHex: OLD_KEY, newAddress: NEW_ADDR, confirmGasPrefund: async () => true },
      deps,
    );
    expect(res.status).toBe('swept');
    expect(rec.prefund).toHaveLength(1);
    expect(rec.prefund[0].oldAddress).toBe(OLD_ADDR);
    expect(rec.prefund[0].amountWei).toBe(2n * 10n ** 14n); // 2× buffer
    expect(rec.broadcast).toHaveLength(1);
  });

  it('confirm=false → insufficient_gas, no prefund, no broadcast', async () => {
    const { deps, rec } = makeDeps({ balance: PVT(2n), native: 0n });
    const res = await runAgentPvtSweep(
      { oldKeyHex: OLD_KEY, newAddress: NEW_ADDR, confirmGasPrefund: async () => false },
      deps,
    );
    expect(res.status).toBe('insufficient_gas');
    expect(rec.prefund).toHaveLength(0);
    expect(rec.broadcast).toHaveLength(0);
  });

  it('a prefund that throws (declined biometric / no ETH) → sweep_failed, never a false swept', async () => {
    const { deps, rec } = makeDeps({
      balance: PVT(2n), native: 0n,
      prefundGasFromHuman: async () => { throw new Error('user declined'); },
    });
    const res = await runAgentPvtSweep(
      { oldKeyHex: OLD_KEY, newAddress: NEW_ADDR, confirmGasPrefund: async () => true },
      deps,
    );
    expect(res.status).toBe('sweep_failed');
    expect(rec.broadcast).toHaveLength(0);
  });
});

describe('agentBalanceSweep — fail-closed', () => {
  it('a failed balance read is sweep_failed/unknown, NEVER nothing_to_sweep', async () => {
    const { deps } = makeDeps({ readPvtBalanceAtomic: async () => { throw new Error('rpc down'); } });
    const res = await runAgentPvtSweep({ oldKeyHex: OLD_KEY, newAddress: NEW_ADDR }, deps);
    expect(res.status).toBe('sweep_failed');
    if (res.status === 'sweep_failed') expect(res.strandedAtomic).toBe('unknown');
  });

  it('a generic broadcast failure → sweep_failed (keeps the stranded amount)', async () => {
    const { deps } = makeDeps({
      balance: PVT(4n), native: PVT(1n),
      broadcastSweep: async () => { throw new Error('nonce too low'); },
    });
    const res = await runAgentPvtSweep({ oldKeyHex: OLD_KEY, newAddress: NEW_ADDR }, deps);
    expect(res.status).toBe('sweep_failed');
    if (res.status === 'sweep_failed') expect(res.strandedAtomic).toBe(PVT(4n).toString());
  });

  it('a late insufficient-funds broadcast error is reclassified as insufficient_gas', async () => {
    const { deps } = makeDeps({
      balance: PVT(4n), native: 1n, gasCostWei: 0n, // squeaks past the pre-check, fails at broadcast
      broadcastSweep: async () => { throw new Error('insufficient funds for gas * price + value'); },
    });
    const res = await runAgentPvtSweep({ oldKeyHex: OLD_KEY, newAddress: NEW_ADDR }, deps);
    expect(res.status).toBe('insufficient_gas');
  });

  it('an invalid old key → sweep_failed, never throws', async () => {
    const { deps } = makeDeps({ deriveAddress: () => { throw new Error('bad key'); } });
    const res = await runAgentPvtSweep({ oldKeyHex: 'nope', newAddress: NEW_ADDR }, deps);
    expect(res.status).toBe('sweep_failed');
  });
});
