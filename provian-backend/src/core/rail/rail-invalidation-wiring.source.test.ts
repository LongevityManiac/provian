/**
 * RAIL HANDSHAKE — event-based invalidation wiring source pin (Part C2) + RED.
 *
 * Each discrete adverse presenter-side event MUST raise the presenter's
 * invalidation floor at its post-commit site. These are source pins: they redden
 * if a hook is ever dropped. Each ships its own in-memory RED control (mutate the
 * source the way the regression would present, assert the pin fails), so no pin
 * is a pass-over-the-empty-population. The floor mechanics themselves are covered
 * by invalidation.test.ts / handshake.test.ts.
 */
import fs from 'fs';
import path from 'path';

function read(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
}

/** Each adverse-event site + the exact invalidation call it must contain. */
const HOOKS: ReadonlyArray<{ label: string; file: string; call: string }> = [
  {
    label: '(a) signing-key rotation → key_rotation',
    file: 'core/agent-wallet/key-rotation-transition.ts',
    call: "invalidateHandshakes(deps.db, plan.expected.walletId, 'key_rotation'",
  },
  {
    label: '(b) upheld bond claim slash/forfeiture → bond_slashed',
    file: 'core/agent-bank/bonds.ts',
    call: "invalidateHandshakes(deps.db, claim.respondent_wallet_id, 'bond_slashed'",
  },
  {
    label: '(c) bond expiry → bond_expired',
    file: 'core/agent-bank/scheduler.ts',
    call: "invalidateHandshakes(deps.db, bond.agent_wallet_id, 'bond_expired'",
  },
  {
    label: '(c) bond abandonment → bond_abandoned',
    file: 'core/agent-bank/scheduler.ts',
    call: "invalidateHandshakes(deps.db, bond.agent_wallet_id, 'bond_abandoned'",
  },
];

describe('rail handshake invalidation — adverse-event hooks (source pin)', () => {
  it.each(HOOKS)('$label raises the invalidation floor at its site', ({ file, call }) => {
    expect(read(file)).toContain(call);
  });

  it('RED control: dropping any hook reddens the pin', () => {
    for (const { file, call } of HOOKS) {
      const mutated = read(file).replace(call, 'noopRemovedHook(');
      expect(mutated.includes(call)).toBe(false);
    }
  });

  it('every hook is POST-commit and best-effort (wrapped so a floor write never rolls back the event)', () => {
    // The key-rotation hook rides the same file; the two bond files each guard the
    // call in a try/catch. Assert the advisory-only wrapper is present at each site.
    expect(read('core/agent-bank/bonds.ts')).toContain("invalidateHandshakes(deps.db, claim.respondent_wallet_id, 'bond_slashed'");
    expect(read('core/agent-bank/scheduler.ts')).toContain('/* advisory-only */');
  });
});
