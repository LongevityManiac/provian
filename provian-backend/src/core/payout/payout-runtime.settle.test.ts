/**
 * The one-payee settlement a payout runs. A payee whose owner has a membership change open cannot
 * be paid until it completes: the paid request WAITS with that reason and no settlement run is
 * started — it never completes around the payee and closes with nothing settled.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';

const runSettlement = jest.fn<(options: unknown) => Promise<unknown>>();
const issuancePayeeHold = jest.fn<(db: unknown, address: string) => Promise<string | null>>();
jest.mock('../pvt/settlement/operator-runtime', () => ({
  OperatorRefusal: class OperatorRefusal extends Error { constructor(readonly reason: string) { super(reason); } },
  runSettlement: (options: unknown) => runSettlement(options),
}));
jest.mock('../recourse/settlement-issuance-runtime', () => ({
  issuancePayeeHold: (db: unknown, address: string) => issuancePayeeHold(db, address),
}));
jest.mock('../payments/usdc-charge-runtime', () => ({ createUsdcChargeRuntime: jest.fn(), USDC_CHARGE_PRICE_MAX_AGE_MS: 1 }));

import { settleOnePayee } from './payout-runtime';

const PAYEE = `0x${'ab'.repeat(20)}`;
const db = {} as Firestore;
const finished = { settlement: { cycleId: 'c', outcome: 'completed', stopReason: null, claimsSettled: 2, batchesConfirmed: 1, feeWeiSpent: 3n } };

beforeEach(() => { runSettlement.mockReset(); issuancePayeeHold.mockReset(); });

describe('settleOnePayee', () => {
  it('RED: a withheld payee waits with the reason and no settlement run starts', async () => {
    issuancePayeeHold.mockResolvedValue('recourse_membership_transition_pending');
    runSettlement.mockResolvedValue(finished);
    expect(await settleOnePayee(db, PAYEE, 'po_request_1', () => {})).toEqual({ kind: 'wait', reason: 'recourse_membership_transition_pending' });
    expect(issuancePayeeHold).toHaveBeenCalledWith(db, PAYEE);
    expect(runSettlement).not.toHaveBeenCalled();
  });
  it('control: a payee that is not withheld is settled, scoped to it alone', async () => {
    issuancePayeeHold.mockResolvedValue(null);
    runSettlement.mockResolvedValue(finished);
    expect(await settleOnePayee(db, PAYEE.toUpperCase().replace('0X', '0x'), 'po_request_1', () => {}))
      .toEqual({ kind: 'settled', cycleId: 'c', claimsSettled: 2, batchesConfirmed: 1, feeWeiSpent: '3' });
    expect(runSettlement).toHaveBeenCalledTimes(1);
    expect(runSettlement.mock.calls[0][0]).toMatchObject({ dryRun: false, payee: { address: PAYEE, requestId: 'po_request_1' } });
  });
});
