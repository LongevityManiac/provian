/** This state belongs only in encrypted relay records. Never put its totals or
 * remainder in a public ticket, event, endpoint, snapshot leaf or commitment. */
export interface PrivateMonthlyEarnings {
  readonly grossAtomic: string;
  readonly dueAtomic: string;
  readonly paidAtomic: string;
  readonly remainder: number;
  readonly earningsBps: number;
}
export interface PrivateIssuanceRecipient {
  readonly occurrence: string;
  readonly account: string;
  readonly grossAtomic: string;
  readonly contributorAtomic: string;
}
export interface AddressIssuanceContribution extends PrivateIssuanceRecipient {
  readonly contributionAtomic: string;
}
const MAX = (1n << 256n) - 1n;
function atomic(value: string, onChain = false): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || (onChain && (value.length > 78 || BigInt(value) > MAX))) throw Error('recourse_private_earnings_invalid');
  return BigInt(value);
}
function bps(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 10000) throw Error('recourse_private_earnings_invalid');
}
export function emptyPrivateMonthlyEarnings(earningsBps: number): PrivateMonthlyEarnings {
  bps(earningsBps);
  return { grossAtomic: '0', dueAtomic: '0', paidAtomic: '0', remainder: 0, earningsBps };
}
/** Plan consecutive eligible issuance occurrences for ONE private owner-month.
 * The caller reserves the prior state transactionally; only verified settlement
 * receipts commit the returned state. Rejected or merely signed batches commit
 * nothing. The monthly rule and carried remainder survive same-month rejoining.
 *
 * The kernel still checks actual gross and contributor issuance. The attestor
 * chooses the floor/ceil result from this private owner-level remainder; public
 * chain checks cannot reconstruct the deliberately hidden portfolio. */
export function planPrivateMonthlyEarnings(prior: PrivateMonthlyEarnings,
  recipients: readonly PrivateIssuanceRecipient[]): {
    readonly next: PrivateMonthlyEarnings; readonly contributions: readonly AddressIssuanceContribution[];
  } {
  bps(prior.earningsBps);
  let gross = atomic(prior.grossAtomic), due = atomic(prior.dueAtomic), paid = atomic(prior.paidAtomic);
  const rate = BigInt(prior.earningsBps);
  if (!Number.isInteger(prior.remainder) || prior.remainder < 0 || prior.remainder >= 10000
    || due !== gross * rate / 10000n || BigInt(prior.remainder) !== gross * rate % 10000n || paid > due
    || recipients.length === 0) throw Error('recourse_private_earnings_invalid');
  let remainder = BigInt(prior.remainder);
  const seen = new Set<string>();
  const contributions = recipients.map(row => {
    if (!/^0x[0-9a-f]{64}$/.test(row.occurrence) || /^0x0+$/.test(row.occurrence)
      || !/^0x[0-9a-f]{40}$/.test(row.account) || /^0x0+$/.test(row.account)
      || seen.has(row.occurrence)) throw Error('recourse_private_earnings_invalid');
    seen.add(row.occurrence);
    const issued = atomic(row.grossAtomic, true), contributor = atomic(row.contributorAtomic, true);
    if (contributor > issued) throw Error('recourse_private_earnings_invalid');
    const fraction = (issued % 10000n) * rate + remainder;
    const obligation = (issued / 10000n) * rate + fraction / 10000n;
    remainder = fraction % 10000n;
    const diverted = obligation < contributor ? obligation : contributor;
    gross += issued; due += obligation; paid += diverted;
    return { occurrence: row.occurrence, account: row.account, grossAtomic: row.grossAtomic,
      contributorAtomic: row.contributorAtomic, contributionAtomic: String(diverted) };
  });
  return { next: { grossAtomic: String(gross), dueAtomic: String(due), paidAtomic: String(paid),
    remainder: Number(remainder), earningsBps: prior.earningsBps }, contributions };
}
