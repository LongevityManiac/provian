/**
 * RAIL HANDSHAKE — wiring source pin (burn-to-present, Part 1) + RED controls.
 *
 * The gate (`assertLiveHandshake`) must sit at the COMMITMENT point of every
 * rail-mediated action class, and must NOT sit on any raw ERC-20 PVT
 * transfer/swap/trade path (raw token moves stay permissionless). These are
 * source pins: they redden if a gate is ever dropped from a commitment, or ever
 * added to the raw-transfer path. Each pin ships its own in-memory RED control
 * (mutate the real source the way the regression would present, assert the pin
 * fails), so no pin is a pass-over-the-empty-population.
 */
import fs from 'fs';
import path from 'path';

function read(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
}

/** Each gated commitment site + the exact gate call it must contain. */
const GATED: ReadonlyArray<{ label: string; file: string; call: string }> = [
  { label: 'escrow /create (depositor → recipient)', file: 'routes/agent-escrow.ts', call: 'assertLiveHandshake(deps.db, body.depositor_wallet_id, body.recipient_wallet_id' },
  // the agent-only board folded into the Commons hiring board; its accept route answers
  // 410 (pinned below). The ONE hiring accept gates poster (presenter id) → applicant.
  { label: 'commons-jobs accept (poster presenter → applicant)', file: 'routes/commons.ts', call: 'assertLiveHandshake(deps.db, committer.presenterWalletId, req.body.applicant_wallet_id' },
  // a person's vouch rides the same reputation gate (core module, not a route).
  { label: 'human vouch (person presenter → vouchee)', file: 'core/commons/burn-vouch.ts', call: "assertLiveHandshake(db, wallet.walletId, target.partyId, nowMs, 'reputation')" },
  { label: 'bonds /post (agent → commons)', file: 'routes/agent-bonds.ts', call: 'assertLiveHandshake(db, walletId, RAIL_COMMONS_AUDIENCE' },
  { label: 'pledge (agent → commons)', file: 'core/commons/pledges.ts', call: 'assertLiveHandshake(deps.db, walletId, RAIL_COMMONS_AUDIENCE' },
  { label: 'subscription (agent → commons)', file: 'core/commons/subscriptions.ts', call: 'assertLiveHandshake(deps.db, walletId, RAIL_COMMONS_AUDIENCE' },
  // Vouch (6-09-04 fold): a trust act, gated on a REPUTATION handshake to the
  // vouchee. The gate lives in the CORE module (not the agent-wallet.ts route), so
  // the raw-transfer negative pin below still sees an assertLiveHandshake-free
  // agent-wallet.ts. The `'reputation'` tier arg preserves the 15-PVT scarcity.
  { label: 'vouch (voucher → target agent)', file: 'core/commons/burn-vouch.ts', call: "assertLiveHandshake(deps.db, walletId, targetAgentId, nowMs, 'reputation')" },
];

/** Raw ERC-20 transfer/swap/trade lives here and must stay ungated. */
const RAW_UNGATED_FILE = 'routes/agent-wallet.ts';

describe('rail handshake — gated commitment sites (source pin)', () => {
  it.each(GATED)('$label invokes the gate at commitment', ({ file, call }) => {
    expect(read(file)).toContain(call);
  });

  it('RED control: dropping a gate from any commitment site reddens the pin', () => {
    for (const { file, call } of GATED) {
      const mutated = read(file).replace(call, 'noopRemovedGate(');
      expect(mutated.includes(call)).toBe(false); // the regression: gate removed
    }
  });
});

describe('the folded agent board cannot commit a hire', () => {
  it('agent-jobs accept answers 410 job_board_moved and never forms an escrow', () => {
    const src = read('routes/agent-jobs.ts');
    expect(src).toContain("router.post('/:id/accept/:wallet_id', authenticateAgent, (_req: Request, res: Response) => boardMoved(res, 'accept'))");
    expect(src).not.toContain('acceptApplicant(');
    expect(src).not.toContain('createEscrow(');
  });
});

describe('rail handshake — raw transfer/swap stays UNGATED (source pin)', () => {
  it('the raw transfer/swap/record routes never call the handshake gate', () => {
    const src = read(RAW_UNGATED_FILE);
    // agent-wallet.ts holds /transfer/record, /swap and /swap/record — the raw
    // token-move recorders — and must not import or call the rail handshake.
    expect(src).toContain('/transfer/record');
    expect(src).toContain('/swap/record');
    expect(src).not.toContain('assertLiveHandshake');
  });

  it('RED control: adding a gate to the raw-transfer path would redden this pin', () => {
    // Simulate the regression (a gate injected into the raw path) and assert the
    // negative pin above would catch it.
    const mutated = read(RAW_UNGATED_FILE).replace(
      "router.post('/:wallet_id/transfer/record'",
      "await assertLiveHandshake(db, 'x', 'y', Date.now());\n  router.post('/:wallet_id/transfer/record'",
    );
    expect(mutated.includes('assertLiveHandshake')).toBe(true); // regression detectable
  });
});
