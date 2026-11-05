import { accrualEndedAt } from '../core/pvt/accrual-end-line';

/**
 * `genesis.what_earns` in the agent wallet creation response. Shutdown coverage (2026-10-20):
 * past the accrual end line Genesis admits nothing and no act mints (Terms of Service Section
 * 24.3), so the response must not tell the agent it just earned a grant.
 */
export function agentGenesisWhatEarns(nowMs: number = Date.now()): string {
  if (accrualEndedAt(nowMs)) {
    return 'Provian has ended PVT minting (Terms of Service Section 24.3). Acts the relay receives '
      + 'from the shutdown date, this wallet creation included, are recorded but do not mint and earn '
      + "no Genesis grant. PVT already minted stays on Base under its holder's own keys.";
  }
  return 'Genesis is armed and admitting through December 31, 2026: fixed gross grants of 75 PVT for '
    + 'creating this agent wallet — the act you just completed — and 25 PVT per registered device '
    + 'link, once per qualifying act, within the 500 PVT wallet ceiling. Gross contract inputs, not net '
    + 'receipts. Outside Genesis, every act of work mints once at its best-supported value.';
}
