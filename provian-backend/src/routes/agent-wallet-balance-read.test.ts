/**
 * / audit §6 — PVT9 balance read on GET /:wallet_id/balances.
 *
 * The defect this closes: the balances endpoint hardcoded `pvt9.balance:null`
 * with reason `PVT9_UNCONFIGURED` against the LIVE successor kernel that holds
 * real supply (1,185+ PVT). It reported "unconfigured" for a configured token, so
 * an agent could never read its own PVT here. `readPvt9Balance` now reads the
 * chain and, on any RPC failure, reports the FAIL-VISIBLE `PVT9_READ_FAILED` * never the false "unconfigured", never a silent zero.
 *
 * The RED control is in-suite: the same helper that surfaces a real balance
 * on a successful read reports `PVT9_READ_FAILED` on a throwing read, so a green
 * cannot mean the value is a hardcoded sentinel.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { readPvt9Balance } from './agent-wallet';

const WALLET = '0x1111111111111111111111111111111111111111';

describe('readPvt9Balance (/ §6 balance read)', () => {
  it('formats a real on-chain balance at 18 decimals and marks it available', async () => {
    // 1185.58 PVT expressed in atomic (18-dp) units — the audit's live figure class.
    const atomic = 1_185_580_000_000_000_000_000n;
    const read = await readPvt9Balance(async () => atomic, WALLET);
    expect(read).toEqual({ balance: '1185.58', available: true });
    expect(read.reason).toBeUndefined();
  });

  it('reads a zero balance as a real "0.0", available — NOT null/unconfigured', async () => {
    // A configured token an agent simply has none of still reads live and available.
    const read = await readPvt9Balance(async () => 0n, WALLET);
    expect(read).toEqual({ balance: '0.0', available: true });
  });

  it('passes the wallet address through to balanceOf (reads THIS wallet, not a fixed one)', async () => {
    let seen: string | null = null;
    await readPvt9Balance(async (owner) => { seen = owner; return 5n; }, WALLET);
    expect(seen).toBe(WALLET);
  });

  it('RED control — an RPC read failure is FAIL-VISIBLE (PVT9_READ_FAILED, never UNCONFIGURED, never 0)', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const read = await readPvt9Balance(async () => { throw new Error('base RPC unavailable'); }, WALLET);
      expect(read).toEqual({ balance: null, available: false, reason: 'PVT9_READ_FAILED' });
      // The precise regression: the reason is the read-failure signal, not the old
      // false "unconfigured", and the balance is null — not a silent zero that would
      // read as "this agent holds 0 PVT".
      expect(read.reason).not.toBe('PVT9_UNCONFIGURED');
      expect(read.balance).not.toBe('0');
      expect(read.balance).not.toBe('0.0');
    } finally {
      spy.mockRestore();
    }
  });
});
