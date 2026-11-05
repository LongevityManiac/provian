/**
 * Beneficiary-pending queue hygiene (C1).
 *
 * A PE whose human beneficiary address cannot be resolved is parked in
 * `mint_status: 'beneficiary_pending'` (so it leaves the eligible window) and is
 * restored once the beneficiary resolves. The human's share is NEVER rerouted to
 * the agent.
 *
 * The source-wiring assertions this file used to make were against the retired
 * PVTv8 mint engine (`minting-engine.ts`, deleted with the PE meter migration).
 * The live recovery is `held-act-recovery.ts` (`recoverBeneficiaryPendingHeldActs`,
 * wired in server.ts registry-hold-resolve) and is covered by
 * `held-act-sweeps.test.ts`. What remains here pins the status vocabulary.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from '@jest/globals';

describe('C1: beneficiary-pending queue hygiene', () => {
  const peHistory = readFileSync(join(__dirname, '..', '..', 'pe-history.ts'), 'utf8');

  it("'beneficiary_pending' is a recognized (non-terminal) mint_status", () => {
    expect(peHistory).toMatch(/\|\s*['"]beneficiary_pending['"]/);
  });
});
