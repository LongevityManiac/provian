/**
 * First-PE hardware-key-not-ready guard - H-8 (audit 2026-05-11).
 *
 * Verifies that the HardwareKeyNotReadyError type exists and that the
 * ProvenanceEnvelopeManager source contains the retry-then-defer logic:
 *   1. Lazy init retries up to N times (Secure Enclave / StrongBox is
 *      typically only momentarily unavailable on cold start).
 *   2. If still unavailable AND device is hardware-capable AND no PE
 *      history yet, throws HardwareKeyNotReadyError instead of silently
 *      downgrading the first PE to software-tier.
 *
 * Without this guard, the first wallet_created PE on a hardware-capable
 * device could anchor at software-tier permanently - wallet_created is
 * rate-limited per device, so the downgrade locks in.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Source-level assertions only - importing the manager class pulls in
// expo native modules that aren't available in the vitest environment.
// The pe-history test in the backend covers the runtime behavior; this
// test pins the structural guarantees in source.

describe('H-8: first-PE hardware-key-not-ready guard', () => {
  const source = readFileSync(
    join(__dirname, '..', 'ProvenanceEnvelopeManager.ts'),
    'utf8',
  );

  it('exports HardwareKeyNotReadyError as a typed error class', () => {
    expect(source).toMatch(/export class HardwareKeyNotReadyError extends Error/);
    expect(source).toMatch(/this\.name = 'HardwareKeyNotReadyError'/);
  });

  it('retries lazy init up to MAX_LAZY_INIT_RETRIES before falling back', () => {
    expect(source).toMatch(/MAX_LAZY_INIT_RETRIES\s*=\s*3/);
    expect(source).toMatch(/LAZY_INIT_RETRY_DELAY_MS\s*=\s*500/);
  });

  it('throws HardwareKeyNotReadyError when device is hardware-capable AND first PE', () => {
    expect(source).toMatch(/isHardwareCapable\s*&&\s*isFirstPE/);
    expect(source).toMatch(/throw new HardwareKeyNotReadyError/);
  });

  it('still allows wallet-store fallback for non-hardware-capable devices', () => {
    // The fallback to walletStore is preserved for non-hardware-capable
    // devices (which legitimately can only do software-tier anyway).
    expect(source).toMatch(/Falling back to wallet store address/);
  });
});
