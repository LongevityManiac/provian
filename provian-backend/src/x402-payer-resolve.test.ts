/**
 * Capability-Truthfulness audit Pass-2 #19.
 *
 * Device-mode x402 payments must credit the SOVEREIGN agent wallet
 * (x402_payment_count / x402_pioneer / leaderboard), exactly like the
 * /v1/relay/action path. The bug: only server.ts computed the on-chain payer
 * from metadata.payer; the device /v1/pe/submit handler (devices.ts) called
 * recordPEAccrual WITHOUT x402PayerAddress, so device-mode payments were never
 * credited.
 *
 * The fix extracts a single resolver (resolveX402PayerAddress) used by BOTH
 * ingestion paths, so neither can silently drop the payer. These tests pin the
 * resolver's behavior (adversarial inputs) and assert both call sites are wired
 * to it.
 */

import fs from 'fs';
import path from 'path';
import { resolveX402PayerAddress } from './pvt-accrual';

const PAYER = '0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1';

describe('resolveX402PayerAddress (audit Pass-2 #19)', () => {
  it('returns the payer for an x402_payment PE carrying metadata.payer', () => {
    expect(resolveX402PayerAddress('x402_payment', { payer: PAYER })).toBe(PAYER);
  });

  it('returns undefined for an x402_payment PE with no payer in metadata', () => {
    expect(resolveX402PayerAddress('x402_payment', { network: 'eip155:8453' })).toBeUndefined();
  });

  it('returns undefined when metadata is null/undefined (no crash)', () => {
    expect(resolveX402PayerAddress('x402_payment', null)).toBeUndefined();
    expect(resolveX402PayerAddress('x402_payment', undefined)).toBeUndefined();
  });

  it('returns undefined when metadata is not an object', () => {
    expect(resolveX402PayerAddress('x402_payment', 'not-an-object')).toBeUndefined();
    expect(resolveX402PayerAddress('x402_payment', 42 as unknown)).toBeUndefined();
  });

  it('returns undefined when metadata.payer is present but not a string (no spoofed credit)', () => {
    expect(resolveX402PayerAddress('x402_payment', { payer: 123 })).toBeUndefined();
    expect(resolveX402PayerAddress('x402_payment', { payer: { from: PAYER } })).toBeUndefined();
    expect(resolveX402PayerAddress('x402_payment', { payer: null })).toBeUndefined();
  });

  it('does NOT credit a non-x402 action even when metadata carries a payer (no farming)', () => {
    // A coding_session/agent_work_product/etc. that smuggles a `payer` field
    // must never increment x402_payment_count.
    expect(resolveX402PayerAddress('coding_session', { payer: PAYER })).toBeUndefined();
    expect(resolveX402PayerAddress('agent_work_product_code', { payer: PAYER })).toBeUndefined();
    expect(resolveX402PayerAddress('', { payer: PAYER })).toBeUndefined();
  });
});

describe('x402 payer wiring: every live ingestion path uses the shared resolver', () => {
  // PE METER (2026-10-03): the single-PE recorders this used to pin (the shared action-PE sealer
  // behind /v1/relay/action, and devices.ts /v1/pe/submit) are retired and deleted. The live paths
  // that can carry a caller's x402 metadata are the device batch's act admission and the
  // relay-composed generatePE; both must credit through the shared resolver.
  it('the device batch act passes x402PayerAddress: resolveX402PayerAddress(...)', () => {
    const src = fs.readFileSync(path.join(__dirname, 'core', 'meter', 'device-act.ts'), 'utf8');
    expect(src).toContain('x402PayerAddress: resolveX402PayerAddress(actionType, metadata)');
  });

  it('the relay-composed generatePE passes x402PayerAddress: resolveX402PayerAddress(...)', () => {
    const src = fs.readFileSync(path.join(__dirname, 'core', 'agent-bank', 'pe-utils.ts'), 'utf8');
    expect(src).toMatch(/x402PayerAddress: resolveX402PayerAddress\(/);
  });

  it('server.ts carries no inline copy of the resolver wiring, and the retired sealer is gone', () => {
    const src = fs.readFileSync(path.join(__dirname, 'server.ts'), 'utf8');
    expect(src.length).toBeGreaterThan(1000);
    expect(src).not.toContain('x402PayerAddress: resolveX402PayerAddress(');
    expect(fs.existsSync(path.join(__dirname, 'core', 'pe', 'action-pe-recorder.ts'))).toBe(false);
  });
});
