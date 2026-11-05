/**
 * PE METER — the 30-day rule on relay-authored acts.
 *
 * A relay act whose occurrence is more than 30 days old is priced as record-only (counted, never
 * minted), exactly like a device act. That is what keeps 31-day mint-once keys safe: a duplicate
 * observed after its key expired is already past the window. A Genesis grant is exempt (its
 * reservation is its mint-once; forbids any time-based reduction).
 *
 * The accrual is stubbed (it never reports an outcome), so this pins exactly the inputs the
 * pricing call receives.
 */
import { describe, it, expect } from '@jest/globals';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import type { RecordPEAccrualParams } from '../../pvt-accrual';
import { buildRelayActIntake, priceRelayAct, relayPeOf } from './meter-relay-authored';
import { METER_MINT_WINDOW_MS } from './meter-wire';

const NOW = 1_790_000_000_000;
const DAY = 86_400_000;

function intakeAt(timestamp: number, extra: Partial<RecordPEAccrualParams> = {}) {
  const pe = relayPeOf({
    peId: `pe_test_${timestamp}`,
    actorId: 'agent_x',
    prevHash: 'genesis',
    timestamp,
    actionType: 'send',
    content: { wallet_id: 'wallet_aw_x', metadata: { tx_hash: '0xabc' } },
  });
  return buildRelayActIntake({
    pe,
    actorId: 'agent_x',
    accrual: {
      peId: pe.pe_id,
      userId: 'agent_x',
      actionType: 'send',
      integrationSource: 'agent_bank_generate_pe',
      attestationDepth: 'software',
      peHash: '',
      timestamp,
      ...extra,
    },
    sealed: [],
    nowMs: NOW,
  });
}

async function pricedWith(intake: ReturnType<typeof intakeAt>): Promise<RecordPEAccrualParams> {
  const calls: RecordPEAccrualParams[] = [];
  const db = createFakeFirestore();
  await priceRelayAct(db as never, intake, { nowMs: NOW, record: async (p) => { calls.push(p); } });
  expect(calls).toHaveLength(1);
  return calls[0];
}

describe('relay-authored acts: the 30-day mint window', () => {
  it('an act inside 30 days prices normally', async () => {
    const params = await pricedWith(intakeAt(NOW - 29 * DAY));
    expect(params.meterRecordOnly).toBeUndefined();
    expect(params.meter).toBeDefined();
  });

  it('RED: an act older than 30 days is counted but cannot mint', async () => {
    const params = await pricedWith(intakeAt(NOW - METER_MINT_WINDOW_MS - 1));
    expect(params.meterRecordOnly).toBe('meter_act_older_than_30_days');
  });

  it('a Genesis grant is exempt from the window (its reservation is its mint-once)', async () => {
    const params = await pricedWith(intakeAt(NOW - 90 * DAY, { isGenesisGrant: true }));
    expect(params.meterRecordOnly).toBeUndefined();
  });
});
