/**
 * cutover reconciliation — direct-site census for the durable ordinary-accrual intake.
 *
 * `atomicCoWrite` is an OPTIONAL property of `advanceChainTipWithProvisionalPE`, so a direct
 * advance site that fires best-effort accrual without co-committing the intake compiles and leaves
 * every behavioural suite green — while its PEs commit with NO durable replay source. This file
 * used to pin each such site (relay work-product, relay action via `action-pe-recorder.ts`, the
 * Coinbase onramp verifier, mobile submit, device submit) and which of them claimed the intake as
 * their durable replay source.
 *
 * PE METER : every one of those sites is gone. The four single-PE recorders are
 * retired (410, routes/meter-retired-recorders.ts) and their handlers deleted; the onramp verifier
 * records through the meter's relay-act intake (`advanceRelayAct`). What remains is the census:
 * the only direct advance left in these files is `device_revoke` (record_only by policy,, no
 * intake), and no direct site claims the durable-replay marker. A new direct advance site fails the
 * count until someone decides whether it co-commits the intake.
 *
 * The generatePE (pe-utils) path is the relay-act intake and is covered by its own suites.
 */
import fs from 'fs';
import path from 'path';

const ADVANCE = 'advanceChainTipWithProvisionalPE({';
const CO_WRITE = 'atomicCoWrite: (txn, ctx) => createOrdinaryAccrualIntakeInTransaction(';
const MARKER = 'durableReplaySource: ORDINARY_ACCRUAL_REPLAY_SOURCE';

function read(relative: string): string {
  const source = fs.readFileSync(path.resolve(__dirname, relative), 'utf8');
  // Not an empty-population pass: the file was really read.
  expect(source.length).toBeGreaterThan(1000);
  return source;
}

function count(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

describe('cutover reconciliation ordinary-accrual intake — direct-site census after the PE meter', () => {
  it('server.ts has no direct advance site and no intake co-write', () => {
    const server = read('../../../server.ts');
    expect(count(server, ADVANCE)).toBe(0);
    expect(count(server, CO_WRITE)).toBe(0);
    expect(count(server, MARKER)).toBe(0);
  });

  it('devices.ts has no direct advance site: register and revoke are relay acts (PE meter)', () => {
    const devices = read('../../../routes/devices.ts');
    expect(count(devices, ADVANCE)).toBe(0);
    expect(count(devices, CO_WRITE)).toBe(0);
    expect(count(devices, MARKER)).toBe(0);
    expect(devices).toContain('advanceRelayAct(db, {');
  });

  it('provisional.ts has no advance site ', () => {
    const provisional = read('../../../routes/provisional.ts');
    expect(count(provisional, ADVANCE)).toBe(0);
    expect(count(provisional, CO_WRITE)).toBe(0);
  });

  it('RED control: the census counts a planted direct site', () => {
    const planted = `${ADVANCE} userId, atomicCoWrite: (txn, ctx) => createOrdinaryAccrualIntakeInTransaction(txn) })`;
    expect(count(planted, ADVANCE)).toBe(1);
    expect(count(planted, CO_WRITE)).toBe(1);
  });
});
