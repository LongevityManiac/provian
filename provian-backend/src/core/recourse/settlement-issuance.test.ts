import { Interface } from 'ethers';
import { KERNEL_SETTLEMENT_ABI } from '../pvt/wp4/settlement-cycle-runner';
import { SETTLEMENT_BATCH_SCHEMA, type SettlementBatchDoc } from '../pvt/wp4/durable-settlement-store';
import { planSettlementIssuance, type SettlementIssuancePolicy } from './settlement-issuance';
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const abi = new Interface(KERNEL_SETTLEMENT_ABI);
const policy: SettlementIssuancePolicy = { kernel: a(1), epoch: '2', policyHash: h(3), mintRateAtomic: '1500000000000000000', agentFoundationBps: '50' };
function batch(genesis = false): SettlementBatchDoc {
  const recipients = genesis ? [[a(1), 2], [a(2), 1]] : [[a(1), 1, 2], [a(2), 2, 1]];
  const claims = genesis ? [[h(10), h(30), h(40), 0, 100, 101], [h(11), h(31), h(41), 0, 100, 101], [h(12), h(32), h(42), 0, 100, 101]]
    : [[h(10), 101], [h(11), 101], [h(12), 101]];
  return { schema_version: SETTLEMENT_BATCH_SCHEMA, batch_id: h(4), cycle_id: 'cycle', lane: genesis ? 'genesis' : 'standard', epoch: 2,
    policy_hash: h(3), cursor_start: '5', cursor_end: '8', recipient_count: 2, claim_count: 3,
    total_minted_atomic: genesis ? '300' : '451', reserved_nonce: 0,
    calldata: abi.encodeFunctionData(genesis ? 'settleGenesisPEBatch' : 'settleStandardPEBatch', [h(4), 2, h(3), 5, 8, recipients, claims]),
    members: [10, 11, 12].map(n => ({ pe_id: String(n), leg: 'sole', claim_id: h(n) })), status: 'reserved', dead_reason: null,
    attempts: [], confirmed_tx_hash: null, confirmed_fee_wei: null, applied: false, writebacks_complete: false, created_at: 0, updated_at: 0 };
}
test('standard sums claims before rate rounding, preserves ordinary recipient order and excludes treasury allocations', () => {
  const result = planSettlementIssuance(batch(), policy);
  expect(result.recipients).toEqual([
    expect.objectContaining({ ordinal: 0, account: a(1), grossAtomic: '303', contributorAtomic: '299' }),
    expect.objectContaining({ ordinal: 1, account: a(2), grossAtomic: '151', contributorAtomic: '149' }),
  ]);
  expect(new Set(result.recipients.map(r => r.occurrence)).size).toBe(2);
  expect(result.settlementDigest).toMatch(/^0x[0-9a-f]{64}$/);
});
test('Genesis uses reserved gross unchanged by the standard rate', () => {
  expect(planSettlementIssuance(batch(true), policy).recipients.map(r => [r.grossAtomic, r.contributorAtomic]))
    .toEqual([['202', '199'], ['101', '99']]);
});
test('differential epoch split preserves the human floor and applies the exact autonomous-agent rate', () => {
  const b = { ...batch(), total_minted_atomic: '452' };
  expect(planSettlementIssuance(b, { ...policy, agentFoundationBps: '9950' }).recipients.map(r => r.contributorAtomic))
    .toEqual(['299', '0']);
  expect(() => planSettlementIssuance(b, { ...policy, agentFoundationBps: '9951' })).toThrow('invalid');
});
test('durable header, member set, amount or frozen-policy disagreement refuses before ticket signing', () => {
  const b = batch();
  for (const patch of [{ batch_id: h(999) }, { cursor_end: '9' }, { policy_hash: h(99) }, { total_minted_atomic: '452' },
    { members: b.members.slice(1) }, { members: [b.members[0], b.members[0], b.members[2]] }, { lane: 'genesis' as const }]) {
    expect(() => planSettlementIssuance({ ...b, ...patch }, policy)).toThrow('invalid');
  }
  expect(() => planSettlementIssuance(b, { ...policy, epoch: '3' })).toThrow('invalid');
  expect(() => planSettlementIssuance(b, { ...policy, mintRateAtomic: '0' })).toThrow('invalid');
});
test('duplicate recipients and incomplete claim partition are rejected', () => {
  const b = batch();
  for (const recipients of [[[a(1), 1, 2], [a(1), 2, 1]], [[a(1), 1, 1], [a(2), 2, 1]], [[a(1), 1, 4], [a(2), 2, 1]]]) {
    const calldata = abi.encodeFunctionData('settleStandardPEBatch', [h(4), 2, h(3), 5, 8, recipients, [[h(10), 101], [h(11), 101], [h(12), 101]]]);
    expect(() => planSettlementIssuance({ ...b, calldata }, policy)).toThrow('invalid');
  }
});
