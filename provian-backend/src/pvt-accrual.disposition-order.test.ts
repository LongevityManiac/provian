/**
 * the disposition PRECEDENCE ORDER.
 *
 * the negative control: was that this ordering had no test whatsoever — moving
 * the `sameOwnerUnresolvable` branch back to its original position left
 * the ENTIRE backend suite green, so the defect it fixes could be reintroduced
 * silently. Every assertion below pins one precedence relation, and each would
 * fail if the corresponding branch moved.
 */

import { resolveOperationalDisposition } from './pvt-accrual';

const BASE = {
  durableEconomicPath: true,
  policyRecordOnly: false,
  terminallyIneligible: false,
  sameOwnerUnresolvable: false,
  mintClaimUnverifiable: false,
  cacheUnavailable: false,
  receiveUnsolicited: false,
  receiveAuthorshipUnresolvable: false,
  provianServiceFee: false,
};

describe('operational disposition precedence', () => {
  it('a non-durable path is record_only regardless of everything else', () => {
    expect(resolveOperationalDisposition({
      ...BASE, durableEconomicPath: false, terminallyIneligible: true, cacheUnavailable: true,
    })?.mintDisposition).toBe('record_only');
  });

  it('policyRecordOnly suppresses every operational override', () => {
    expect(resolveOperationalDisposition({
      ...BASE, policyRecordOnly: true, terminallyIneligible: true, sameOwnerUnresolvable: true,
    })).toBeNull();
  });

  it('no flags set produces no override', () => {
    expect(resolveOperationalDisposition(BASE)).toBeNull();
  });

  //. ineligible_terminal has NO exits; every hold below reaches eligible.
  it('RED CONTROL: terminal BEATS sameOwnerUnresolvable — a blip must not downgrade a denial', () => {
    expect(resolveOperationalDisposition({
      ...BASE, terminallyIneligible: true, sameOwnerUnresolvable: true,
    })?.mintDisposition).toBe('ineligible_terminal');
  });

  it('terminal beats the cache hold too', () => {
    expect(resolveOperationalDisposition({
      ...BASE, terminallyIneligible: true, cacheUnavailable: true,
    })?.mintDisposition).toBe('ineligible_terminal');
  });

  //. pending_cache is the ONE bucket the backfill auto-promotes to
  // eligible, and it never re-runs the ownership check.
  it('RED CONTROL: sameOwnerUnresolvable BEATS cacheUnavailable — never auto-promotable', () => {
    const got = resolveOperationalDisposition({
      ...BASE, sameOwnerUnresolvable: true, cacheUnavailable: true,
    });
    expect(got?.mintDisposition).toBe('pending_review');
    expect(got?.mintDisposition).not.toBe('pending_cache');
  });

  it('an unresolved ownership check never suppresses record points', () => {
    expect(resolveOperationalDisposition({ ...BASE, sameOwnerUnresolvable: true })
      ?.suppressRecordPoints).toBe(false);
  });

  it('a terminal denial DOES suppress record points', () => {
    expect(resolveOperationalDisposition({ ...BASE, terminallyIneligible: true })
      ?.suppressRecordPoints).toBe(true);
  });

  it('cacheUnavailable alone still yields pending_cache', () => {
    expect(resolveOperationalDisposition({ ...BASE, cacheUnavailable: true })?.mintDisposition)
      .toBe('pending_cache');
  });

  it('mintClaimUnverifiable alone still yields pending_review', () => {
    expect(resolveOperationalDisposition({ ...BASE, mintClaimUnverifiable: true })?.mintDisposition)
      .toBe('pending_review');
  });

  // unsolicited-inbound-transfer gating. `receiveUnsolicited` means the
  // authorship check RAN and definitively found no recipient-authored
  // relationship - a resolved, permanent verdict, not an unresolved one.
  it('receiveUnsolicited alone yields record_only with its own reason code', () => {
    const got = resolveOperationalDisposition({ ...BASE, receiveUnsolicited: true });
    expect(got?.mintDisposition).toBe('record_only');
    expect(got?.mintReasonCode).toBe('unsolicited_receive_record_only');
    expect(got?.suppressRecordPoints).toBe(false);
  });

  // terminallyIneligible's reasons (device/user rate limit, no observable
  // output, unverified x402) are unrelated compliance signals that must win
  // outright when both are true.
  it('RED CONTROL: terminal BEATS receiveUnsolicited', () => {
    expect(resolveOperationalDisposition({
      ...BASE, terminallyIneligible: true, receiveUnsolicited: true,
    })?.mintDisposition).toBe('ineligible_terminal');
  });

  // The same bypass applies here: record_only is ALSO terminal (no
  // exit), so it must not be shadowed by an unrelated, still-pending
  // same-owner check or cache outage on their way to a RECOVERABLE hold that
  // could later resolve without ever re-running the authorship check.
  it('RED CONTROL: receiveUnsolicited BEATS sameOwnerUnresolvable — a resolved verdict is not a pending one', () => {
    const got = resolveOperationalDisposition({
      ...BASE, receiveUnsolicited: true, sameOwnerUnresolvable: true,
    });
    expect(got?.mintDisposition).toBe('record_only');
    expect(got?.mintDisposition).not.toBe('pending_review');
  });

  it('RED CONTROL: receiveUnsolicited BEATS cacheUnavailable — never auto-promotable', () => {
    const got = resolveOperationalDisposition({
      ...BASE, receiveUnsolicited: true, cacheUnavailable: true,
    });
    expect(got?.mintDisposition).toBe('record_only');
    expect(got?.mintDisposition).not.toBe('pending_cache');
  });

  // receiveAuthorshipUnresolvable means the CHECK ITSELF failed (a query
  // threw) - distinct from receiveUnsolicited, which means the check
  // succeeded and found nothing. This must route to the SAME recoverable
  // hold as sameOwnerUnresolvable, never straight to a permanent seal - a
  // transient Firestore error must never permanently strip a genuinely
  // authored relationship's mint eligibility.
  it('receiveAuthorshipUnresolvable alone yields pending_review with its GRANULAR reason', () => {
    const got = resolveOperationalDisposition({ ...BASE, receiveAuthorshipUnresolvable: true });
    expect(got?.mintDisposition).toBe('pending_review');
    // ops-dashboard build: the three recoverable-hold causes now seal a GRANULAR reason instead
    // of collapsing to 'awaiting_review', so the console can split a parked row by cause.
    expect(got?.mintReasonCode).toBe('receive_authorship_unresolvable');
  });

  it('ops-dashboard: each recoverable-hold cause seals its own granular reason, in priority order', () => {
    // Each cause alone → its own code.
    expect(resolveOperationalDisposition({ ...BASE, sameOwnerUnresolvable: true })?.mintReasonCode)
      .toBe('same_owner_unresolvable');
    expect(resolveOperationalDisposition({ ...BASE, mintClaimUnverifiable: true })?.mintReasonCode)
      .toBe('mint_claim_unverifiable');
    expect(resolveOperationalDisposition({ ...BASE, receiveAuthorshipUnresolvable: true })?.mintReasonCode)
      .toBe('receive_authorship_unresolvable');
    // Priority is deterministic (owner → mint-claim → receive-authorship) so a multi-flag row
    // seals one stable reason. RED control: the umbrella 'awaiting_review' is never emitted here.
    const multi = resolveOperationalDisposition({
      ...BASE, sameOwnerUnresolvable: true, mintClaimUnverifiable: true, receiveAuthorshipUnresolvable: true,
    });
    expect(multi?.mintDisposition).toBe('pending_review');
    expect(multi?.mintReasonCode).toBe('same_owner_unresolvable');
    expect(multi?.mintReasonCode).not.toBe('awaiting_review');
  });

  it('RED CONTROL: terminal still beats receiveAuthorshipUnresolvable too', () => {
    expect(resolveOperationalDisposition({
      ...BASE, terminallyIneligible: true, receiveAuthorshipUnresolvable: true,
    })?.mintDisposition).toBe('ineligible_terminal');
  });
});

// a payment to a Provian service wallet is a service fee, never a price for PVT.
// The verdict is an exact address match (no registry read) — definitive and terminal.
describe('the Provian service-fee seal', () => {
  it('provianServiceFee alone yields record_only with its own reason, points kept for audit', () => {
    const got = resolveOperationalDisposition({ ...BASE, provianServiceFee: true });
    expect(got?.mintDisposition).toBe('record_only');
    expect(got?.mintReasonCode).toBe('provian_service_fee');
    expect(got?.suppressRecordPoints).toBe(false);
  });

  it('RED CONTROL: without the flag the same input produces no override (mintable)', () => {
    expect(resolveOperationalDisposition({ ...BASE, provianServiceFee: false })).toBeNull();
  });

  it('RED CONTROL: the fee BEATS every recoverable hold — never parked where a sweep could promote it', () => {
    for (const hold of ['sameOwnerUnresolvable', 'mintClaimUnverifiable', 'receiveAuthorshipUnresolvable', 'cacheUnavailable'] as const) {
      const got = resolveOperationalDisposition({ ...BASE, provianServiceFee: true, [hold]: true });
      expect(got?.mintDisposition).toBe('record_only');
      expect(got?.mintReasonCode).toBe('provian_service_fee');
    }
  });

  it('a terminal compliance denial still wins outright', () => {
    expect(resolveOperationalDisposition({
      ...BASE, provianServiceFee: true, terminallyIneligible: true,
    })?.mintDisposition).toBe('ineligible_terminal');
  });

  it('a non-durable path keeps its own policy_record_only reason; a policy record_only row keeps its own', () => {
    expect(resolveOperationalDisposition({
      ...BASE, durableEconomicPath: false, provianServiceFee: true,
    })?.mintReasonCode).toBe('policy_record_only');
    expect(resolveOperationalDisposition({ ...BASE, policyRecordOnly: true, provianServiceFee: true })).toBeNull();
  });
});
