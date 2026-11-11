import { joinPrivateMembership } from '../private-membership-calendar';
import { planPrivateIssuance, type PrivateMembershipAccount } from '../private-membership-reservation';
import { seedMembershipJournal } from './membership-journal-fixture';
import { Interface } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../../pvt/__test-helpers__/fake-firestore';
import { KERNEL_SETTLEMENT_ABI } from '../../pvt/wp4/settlement-cycle-runner';
import { SETTLEMENT_BATCHES_COLLECTION, SETTLEMENT_BATCH_SCHEMA, type SettlementBatchDoc } from '../../pvt/wp4/durable-settlement-store';
import { fixture, a, h, old, pointer } from './membership-receipt-fixture';
import { planSettlementIssuance } from '../settlement-issuance';
import { privateIssuanceBatchId, reservePrivateIssuanceBatch, retainPrivateIssuanceSignature,
  commitPrivateIssuanceBatch, type PrivateIssuanceBatch } from '../private-issuance-batch';
import { PRIVATE_ISSUANCE_ADDRESSES, PRIVATE_ISSUANCE_BATCHES } from '../issuance-lock';
import { RECOURSE_COLLECTIONS as R } from '../ownership';
import { PRIVATE_MEMBERSHIP_COLLECTIONS as C } from '../private-membership-reservation';
import { membershipJournalHash } from '../private-membership-journal';
import { MEMBERSHIP_RECEIPT_ABI } from '../membership-receipt';
import { MEMBER_SETTLEMENT_ABI } from '../issuance-ticket';
import { utcCalendarMonth } from '../calendar-month';
export function issuanceBatchFixture() {
  const fake = createFakeFirestore({ strictTransactionOrder: true, rejectUndefinedValues: true }), db = fake as unknown as Firestore;
  const calldata = new Interface(KERNEL_SETTLEMENT_ABI).encodeFunctionData('settleStandardPEBatch', [h(600), 1, h(601), 0, 2,
    [[a(3), 1, 1], [a(4), 1, 1]], [[h(700), 100], [h(701), 100]]]);
  const parent: SettlementBatchDoc = { schema_version: SETTLEMENT_BATCH_SCHEMA, batch_id: h(600), cycle_id: 'cycle', lane: 'standard', epoch: 1,
    policy_hash: h(601), cursor_start: '0', cursor_end: '2', recipient_count: 2, claim_count: 2, total_minted_atomic: '199', reserved_nonce: 0, calldata,
    members: [700, 701].map(n => ({ pe_id: String(n), leg: 'sole', claim_id: h(n) })), status: 'reserved', dead_reason: null,
    attempts: [], confirmed_tx_hash: null, confirmed_fee_wei: null, applied: false, writebacks_complete: false, created_at: 0, updated_at: 0 };
  fake.store.set(`${SETTLEMENT_BATCHES_COLLECTION}/${h(600)}`, { ...parent });
  const policy = { kernel: old[0], epoch: '1', policyHash: h(601), mintRateAtomic: '1000000000000000000', agentFoundationBps: '50' };
  const plan = planSettlementIssuance(parent, policy), record = { ownerIdentity: h(500), address: a(3), identity: h(3), kernel: old[0], chainBindingStatus: 'confirmed', recoveryGeneration: 0 };
  fake.store.set(`${R.addresses}/${a(3)}`, record); fake.store.set(`${R.owners}/${h(500)}`, { ownerIdentity: h(500) });
  const batch: PrivateIssuanceBatch = { id: privateIssuanceBatchId(old[0], h(600)), domain: { chainId: '8453', pointer, kernel: old[0], pool: old[8] },
    context: { batchId: h(600), lane: 0, epoch: '1', policyHash: h(601), settlementDigest: plan.settlementDigest,
      revision: '1', month: String(utcCalendarMonth(1700000000)), membershipRuleHash: h(9) }, policy, kernelCall: calldata, target: old[9],
    checkpoint: { block: 99, blockHash: h(99) }, tickets: plan.recipients.map(r => ({ account: r.account, gross: r.grossAtomic,
      contributor: r.contributorAtomic, contribution: '0', consentNonce: '0', protectedMember: false })), reservations: [],
    unadmitted: [{ ordinal: 0, ownerIdentity: h(500), addressRecordHash: membershipJournalHash(record) }, { ordinal: 1, ownerIdentity: null, addressRecordHash: null }] };
  const f = fixture(); f.state.batchDigest = plan.settlementDigest;
  const issuance = () => { f.state.effects = batch.tickets.map((t, i) => ({ logIndex: `0x${(i + 5).toString(16)}`,
    ...MEMBERSHIP_RECEIPT_ABI.encodeEventLog(MEMBERSHIP_RECEIPT_ABI.getEvent('IssuanceTicketConsumed')!, [h(600), i, t.account, t.gross, t.contribution, h(9)]) })); };
  const rules = () => { throw Error('unadmitted recipients must not create an invoice'); };
  return { fake, db, batch, parent, f, issuance, rules };
}
