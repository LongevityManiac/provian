/**
 * Shutdown coverage : the accrual end line. Unset is the shipped state and
 * changes nothing; a set line makes an act received at or after it seal record_only; a malformed
 * value blocks (Unknown = Block). The relay-authored lane is checked here at the exact inputs its
 * pricing call receives; the device/mobile lanes are pinned end-to-end in
 * `pvt-accrual.mobileActorClaim.acceptance.test.ts` and `meter-ingest.emulator.test.ts`.
 */
import { describe, it, expect } from '@jest/globals';
import {
  ACCRUAL_END_ENV, ACCRUAL_ENDED_REASON, accrualEndMs, accrualEndedAt, accrualEndedFor, isGenesisReservationSeal,
} from './accrual-end-line';
import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import type { RecordPEAccrualParams } from '../../pvt-accrual';
import { buildRelayActIntake, priceRelayAct, relayPeOf } from '../meter/meter-relay-authored';

const NOW = 1_790_000_000_000;
/** The shape the Genesis state machine seals a reservation with (marker + reservation snapshot). */
const GENESIS_SEAL = {
  isGenesisGrant: true,
  economicSnapshot: { recordTimeFactors: { fixedGrantSource: 'genesis_campaign_reservation' } },
} as unknown as Partial<RecordPEAccrualParams>;

describe('accrualEndMs', () => {
  it('unset or empty → no end line', () => {
    expect(accrualEndMs({})).toBeNull();
    expect(accrualEndMs({ [ACCRUAL_END_ENV]: '' })).toBeNull();
    expect(accrualEndMs({ [ACCRUAL_END_ENV]: '   ' })).toBeNull();
  });
  it('a positive integer is the end instant', () => {
    expect(accrualEndMs({ [ACCRUAL_END_ENV]: String(NOW) })).toBe(NOW);
    expect(accrualEndMs({ [ACCRUAL_END_ENV]: ` ${NOW} ` })).toBe(NOW);
  });
  it('RED: anything else is Unknown = Block (end line at 0)', () => {
    for (const bad of ['0', '-5', '1.5', '1e12', 'tomorrow', '0x10', '99999999999999999999']) {
      expect(accrualEndMs({ [ACCRUAL_END_ENV]: bad })).toBe(0);
    }
  });
});

describe('accrualEndedAt', () => {
  it('no end line never ends', () => {
    expect(accrualEndedAt(NOW, null)).toBe(false);
    expect(accrualEndedAt(Number.NaN, null)).toBe(false);
  });
  it('the end instant itself is ended; one ms before is not', () => {
    expect(accrualEndedAt(NOW, NOW)).toBe(true);
    expect(accrualEndedAt(NOW - 1, NOW)).toBe(false);
  });
  it('an unknown instant under a configured line is ended', () => {
    expect(accrualEndedAt(Number.NaN, NOW)).toBe(true);
  });
});

function intake(extra: Partial<RecordPEAccrualParams> = {}) {
  const pe = relayPeOf({
    peId: 'pe_end_line', actorId: 'agent_x', prevHash: 'genesis', timestamp: NOW - 60_000,
    actionType: 'send', content: { wallet_id: 'wallet_aw_x', metadata: { tx_hash: '0xabc' } },
  });
  return buildRelayActIntake({
    pe, actorId: 'agent_x',
    accrual: {
      peId: pe.pe_id, userId: 'agent_x', actionType: 'send', integrationSource: 'agent_bank_generate_pe',
      attestationDepth: 'software', peHash: '', timestamp: NOW - 60_000, ...extra,
    },
    sealed: [], nowMs: NOW,
  });
}

async function priced(endMs: string | undefined, extra: Partial<RecordPEAccrualParams> = {}): Promise<RecordPEAccrualParams> {
  const saved = process.env[ACCRUAL_END_ENV];
  if (endMs === undefined) delete process.env[ACCRUAL_END_ENV];
  else process.env[ACCRUAL_END_ENV] = endMs;
  try {
    const calls: RecordPEAccrualParams[] = [];
    await priceRelayAct(createFakeFirestore() as never, intake(extra), { nowMs: NOW, record: async (p) => { calls.push(p); } });
    expect(calls).toHaveLength(1);
    return calls[0];
  } finally {
    if (saved === undefined) delete process.env[ACCRUAL_END_ENV];
    else process.env[ACCRUAL_END_ENV] = saved;
  }
}

describe('relay-authored acts and the end line', () => {
  it('CONTROL: no end line → priced normally', async () => {
    expect((await priced(undefined)).meterRecordOnly).toBeUndefined();
  });
  it('an end line still ahead → priced normally', async () => {
    expect((await priced(String(NOW + 1))).meterRecordOnly).toBeUndefined();
  });
  it('RED: received at or after the end line → counted, never minted', async () => {
    expect((await priced(String(NOW))).meterRecordOnly).toBe(ACCRUAL_ENDED_REASON);
  });
  it('the sealing of an existing Genesis reservation is exempt', async () => {
    expect((await priced(String(NOW - 1), GENESIS_SEAL)).meterRecordOnly).toBeUndefined();
  });
  it('RED: the Genesis marker alone (no reservation snapshot) is not exempt', async () => {
    expect((await priced(String(NOW - 1), { isGenesisGrant: true })).meterRecordOnly).toBe(ACCRUAL_ENDED_REASON);
  });
  it('a replay after the end line of an act whose intake committed before it still prices', async () => {
    // The intake committed at NOW; its pricing died; the replay sweep runs an hour later, after a
    // line set between the two. Received before the line, so it settles (Terms 24.3).
    const saved = process.env[ACCRUAL_END_ENV];
    process.env[ACCRUAL_END_ENV] = String(NOW + 1);
    try {
      const calls: RecordPEAccrualParams[] = [];
      await priceRelayAct(createFakeFirestore() as never, intake(), {
        nowMs: NOW + 3_600_000, record: async (p) => { calls.push(p); },
      });
      expect(calls[0].meterRecordOnly).toBeUndefined();
      expect(calls[0].accrualReceivedAtMs).toBe(NOW);
      // RED: the same replay of an intake committed at the line is ended.
      process.env[ACCRUAL_END_ENV] = String(NOW);
      const late: RecordPEAccrualParams[] = [];
      await priceRelayAct(createFakeFirestore() as never, intake(), {
        nowMs: NOW + 3_600_000, record: async (p) => { late.push(p); },
      });
      expect(late[0].meterRecordOnly).toBe(ACCRUAL_ENDED_REASON);
    } finally {
      if (saved === undefined) delete process.env[ACCRUAL_END_ENV];
      else process.env[ACCRUAL_END_ENV] = saved;
    }
  });
});

describe('the central accrual decision (accrualEndedFor, read by recordPEAccrual)', () => {
  const LINE = NOW;
  const AFTER = NOW + 3_600_000;
  it('CONTROL: no end line never ends', () => {
    expect(accrualEndedFor({ timestamp: NOW - 1 }, AFTER, null)).toBe(false);
  });
  it('RED: a live accrual sealed after the line is ended', () => {
    expect(accrualEndedFor({ timestamp: NOW - 1 }, AFTER, LINE)).toBe(true);
  });
  it('the sealing of an existing Genesis reservation is exempt; the bare marker is not', () => {
    expect(isGenesisReservationSeal(GENESIS_SEAL)).toBe(true);
    expect(accrualEndedFor({ ...GENESIS_SEAL, timestamp: NOW - 1 }, AFTER, LINE)).toBe(false);
    expect(isGenesisReservationSeal({ isGenesisGrant: true })).toBe(false);
    expect(accrualEndedFor({ isGenesisGrant: true, timestamp: NOW - 1 }, AFTER, LINE)).toBe(true);
    expect(isGenesisReservationSeal({ economicSnapshot: GENESIS_SEAL.economicSnapshot })).toBe(false);
  });
  it('a committed receipt before the line settles even when sealed after it', () => {
    expect(accrualEndedFor({ timestamp: NOW - 1, accrualReceivedAtMs: LINE - 1, meter: {} }, AFTER, LINE)).toBe(false);
    expect(accrualEndedFor({ timestamp: NOW - 1, accrualReceivedAtMs: LINE, meter: {} }, AFTER, LINE)).toBe(true);
  });
  it('a staged ordinary-intake replay is judged by the timestamp its intake binds', () => {
    const replay = { durableReplaySource: 'ordinary_accrual_intake_v1' };
    expect(accrualEndedFor({ ...replay, timestamp: LINE - 1 }, AFTER, LINE)).toBe(false);
    expect(accrualEndedFor({ ...replay, timestamp: LINE }, AFTER, LINE)).toBe(true);
  });
  it('RED: a device act\'s own timestamp is never its receipt (meter context present)', () => {
    expect(accrualEndedFor({ durableReplaySource: 'x', meter: {}, timestamp: LINE - 1 }, AFTER, LINE)).toBe(true);
  });
});
