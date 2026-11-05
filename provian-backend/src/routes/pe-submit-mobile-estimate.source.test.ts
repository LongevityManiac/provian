import fs from 'fs';
import path from 'path';
import { computeSubmitTimeEstimate } from '../core/pvt/estimate';

/**
 * Finding 18 / the submit-time estimate.
 *
 * The single-PE submit routes whose responses quoted it (`/v1/pe/submit`,
 * `/v1/pe/submit/mobile`) are retired (PE meter, 2026-10-03), and with them the
 * seal-read estimate those responses carried. What stays pinned: the zero-I/O
 * `computeSubmitTimeEstimate` is never put back on a relay recording route
 *, and the estimate it computes is derived, not a constant.
 */
describe('submit-time estimate (finding 18 /)', () => {
  it('no relay recording route quotes the zero-I/O submit-time estimate', () => {
    for (const file of ['../server.ts', './devices.ts', './meter.ts']) {
      const source = fs.readFileSync(path.resolve(__dirname, file), 'utf8');
      expect(source.length).toBeGreaterThan(1000);
      expect(source).not.toContain('computeSubmitTimeEstimate(');
      // The retired over-quote stays gone.
      expect(source).not.toContain('calculateEstimatedPVT(');
    }
    // RED control: the same probe catches a planted call.
    expect(`${'route();'}\n  computeSubmitTimeEstimate('x', {});`).toContain('computeSubmitTimeEstimate(');
  });

  it('the source it now uses returns 0 / record_only for a best-effort ordinary type', () => {
    const est = computeSubmitTimeEstimate('agent_work_product_code', { durableSubmissionPath: false });
    expect(est.estimated_pvt).toBe(0);
    expect(est.mint_disposition).toBe('record_only');
  });

  it('RED paired control: it is not a constant — the disposition reacts to the path', () => {
    // wallet_created is best-effort record_only, but on the DURABLE path it hits
    // Security Invariant #9's device gate (no anchor) and seals ineligible_terminal.
    // The disposition MOVES with the input, proving the estimate is derived — not
    // the old hard-coded/doubled answer that ignored the path entirely.
    const best = computeSubmitTimeEstimate('wallet_created', { durableSubmissionPath: false });
    const durable = computeSubmitTimeEstimate('wallet_created', { durableSubmissionPath: true });
    expect(best.mint_disposition).toBe('record_only');
    expect(durable.mint_disposition).toBe('ineligible_terminal');
  });
});
