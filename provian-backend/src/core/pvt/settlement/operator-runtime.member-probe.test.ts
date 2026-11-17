/**
 * The member batch's dry run and the per-run payee hold. A recipient withheld while its owner
 * changes membership must answer as "this batch does not settle" (which the runner isolates to
 * that recipient's claims) — never as a thrown, inconclusive probe, which stops the run for every
 * payee in the batch. Any other failure of the probe stays inconclusive.
 */
import { memoizedPayeeHold, probeMemberBatch } from './operator-runtime';
import { IssuanceRecipientWithheld, MEMBERSHIP_TRANSITION_PENDING } from '../../recourse/settlement-issuance-runtime';

describe('probeMemberBatch', () => {
  it('RED: a withheld recipient is a batch that does not settle, and nothing is simulated', async () => {
    const simulate = jest.fn(async () => ({ ok: true, revertReason: null }));
    const result = await probeMemberBatch(async () => { throw new IssuanceRecipientWithheld(MEMBERSHIP_TRANSITION_PENDING); }, simulate);
    expect(result).toEqual({ ok: false, revertReason: MEMBERSHIP_TRANSITION_PENDING });
    expect(simulate).not.toHaveBeenCalled();
  });
  it('control: any other preparation failure still throws (inconclusive, blames no claim)', async () => {
    await expect(probeMemberBatch(async () => { throw new Error('recourse_settlement_execution_binding'); }, async () => ({ ok: true, revertReason: null })))
      .rejects.toThrow('recourse_settlement_execution_binding');
  });
  it('control: a prepared probe is simulated and its verdict returned unchanged', async () => {
    expect(await probeMemberBatch(async () => 'probe', async (probe) => ({ ok: probe === 'probe', revertReason: null }))).toEqual({ ok: true, revertReason: null });
    expect(await probeMemberBatch(async () => 'probe', async () => ({ ok: false, revertReason: '0xdead' }))).toEqual({ ok: false, revertReason: '0xdead' });
  });
});

describe('memoizedPayeeHold', () => {
  it('reads each payee once per run, whatever the address case', async () => {
    const read = jest.fn(async (address: string) => (address.endsWith('a1') ? MEMBERSHIP_TRANSITION_PENDING : null));
    const hold = memoizedPayeeHold(read);
    const held = `0x${'0'.repeat(38)}a1`;
    const free = `0x${'0'.repeat(38)}b2`;
    expect(await hold(held)).toBe(MEMBERSHIP_TRANSITION_PENDING);
    expect(await hold(held.toUpperCase().replace('0X', '0x'))).toBe(MEMBERSHIP_TRANSITION_PENDING);
    expect(await hold(free)).toBeNull();
    expect(await hold(free)).toBeNull();
    expect(read.mock.calls.map((c) => c[0])).toEqual([held, free]);
  });
});
