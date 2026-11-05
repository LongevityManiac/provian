/**
 * the cross-source dedup invariant that native send/swap parity rests on.
 *
 * When the outbound-USDC watcher was allowed to earn a native agent's `send` /
 * `swap` (not just `x402_payment`), the exactly-once guarantee against the agent's
 * OWN self-report of the same on-chain act — `POST /:wallet_id/transfer/record`
 * (`agent_token_transfer` / `agent_native_transfer`) and `/swap/record`
 * (`agent_token_swap`) — rests on ONE mechanism: those routes fire BEST-EFFORT
 * (they call `generatePEAtomic` WITHOUT `awaitAccrual` / `durableViaOrdinaryIntake`),
 * so `durableEconomicPath` is false and `resolveOperationalDisposition` forces the
 * PE to `record_only` regardless of the matrix disposition (`agent_token_transfer`
 * etc. are `eligible` in the matrix). Only the watcher's DURABLE, chain-verified
 * emit prices. Unlike x402, send/swap have NO second guard (no `(payer,txHash)`
 * cross-source mint-once claim), so this best-effort → record_only rule is the
 * WHOLE fence — hence this control.
 *
 * If `/transfer/record` or `/swap/record` were ever promoted to a durable inlet
 * (set `awaitAccrual` / a `durableReplaySource`), `durableEconomicPath` would be
 * true, this override would vanish — and as of B11 the promotion would
 * then COLLIDE on the cross-source `(address,txHash)` financial-settlement
 * mint-once claim (`financial-settlement-mint-claim.ts`) instead of silently
 * double-minting: the residual is CLOSED, and this best-effort fence is
 * now the first of two layers rather than the whole guarantee. The RED control
 * below still pins the first layer.
 */
import { describe, it, expect } from '@jest/globals';
import { resolveOperationalDisposition } from './pvt-accrual';

// The non-same-owner, non-terminal baseline: a genuine third-party financial
// settlement whose ONLY variable under test is the durable-path flag.
const base = {
  policyRecordOnly: false,
  terminallyIneligible: false,
  sameOwnerUnresolvable: false,
  mintClaimUnverifiable: false,
  cacheUnavailable: false,
};

describe('first-party financial self-report is record_only-in-practice (the dedup fence)', () => {
  it('GREEN: a BEST-EFFORT financial PE (durableEconomicPath=false — the /transfer|swap/record shape) seals record_only', () => {
    const override = resolveOperationalDisposition({ ...base, durableEconomicPath: false });
    expect(override).not.toBeNull();
    expect(override?.mintDisposition).toBe('record_only');
    expect(override?.mintReasonCode).toBe('policy_record_only');
  });

  it('RED CONTROL: the IDENTICAL inputs on the DURABLE path (durableEconomicPath=true) do NOT force record_only — so a durable self-report WOULD mint (the double-mint this fence prevents)', () => {
    const override = resolveOperationalDisposition({ ...base, durableEconomicPath: true });
    // null override = the matrix disposition (eligible) survives → mints. This is
    // the exact regression to guard: if the self-report routes went durable, the
    // watcher's send/swap and the self-report would BOTH mint the same act. The
    // assertion is `not record_only` — if this ever flips green (record_only), the
    // best-effort assumption above has changed and this file must be revisited.
    expect(override).toBeNull();
  });
});
