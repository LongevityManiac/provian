import { reconcilePrivateMembershipDomain } from './private-membership-domain';
import type { Firestore } from 'firebase-admin/firestore';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { getAgreedBaseLogs, readAgreedBaseBlockHash } from '../onchain/economic-discovery';
import { rpcChainFactsEqual } from '../onchain/rpc-chain-facts';
import { RECOURSE_POOL_ABI, readHistoricalRecoursePoolState } from './pool-state';
import { privateMembershipAtLoss, type LossAddressConsent, type LossMembershipEvidence } from './membership-at-loss';
import type { LossSnapshot } from './loss-snapshot';
import { PRIVATE_MEMBERSHIP_COLLECTIONS as C, type PrivateMembershipAccount } from './private-membership-reservation';
import { RECOURSE_COLLECTIONS as R } from './ownership';
import { readMembershipJournal, membershipJournalHash } from './private-membership-journal';
import { readPrivateCalendarRules } from './private-calendar-rules';

/** Historical owner calendar is private. The public chain proves this address's
 * consent period and exact loss position, never a portfolio-wide membership. */
export async function readLossMembership(db: Firestore, snapshot: LossSnapshot): Promise<LossMembershipEvidence & { readonly lossTimestamp: number }> {
  const owner = await db.collection(R.identities).doc(snapshot.identity).get(), ownerIdentity: unknown = owner.get('ownerIdentity');
  if (!owner.exists || typeof ownerIdentity !== 'string' || !/^0x[0-9a-f]{64}$/.test(ownerIdentity)) throw Error('recourse_membership_owner_unknown');
  await reconcilePrivateMembershipDomain(db,ownerIdentity);
  const ref = db.collection(C.owners).doc(ownerIdentity), row = await ref.get();
  const account = row.exists ? row.data() as PrivateMembershipAccount : null;
  if (account && (account.ownerIdentity !== ownerIdentity || account.needsScan || account.pendingReservation !== null
    || account.checkpoint.block < snapshot.block)) throw Error('recourse_membership_reconciliation_pending');
  const pool = await readHistoricalRecoursePoolState(snapshot.identity, { block: snapshot.block, blockHash: snapshot.blockHash });
  if (pool.kernel !== snapshot.kernel) throw Error('recourse_membership_kernel');
  const legs = getOperatorBoundRpcLegs('base');
  if (!legs[0].operatorId || !legs[1].operatorId || legs[0].operatorId === legs[1].operatorId) throw Error('recourse_rpc_operators_not_independent');
  const agreed = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    const [a,b] = await Promise.all(legs.map(l => l.provider.send(method, [...params])));
    if (!rpcChainFactsEqual(a,b)) throw Error('recourse_membership_rpc_disagreement'); return a;
  };
  const journal = account ? await readMembershipJournal(db, account) : [];
  for (const entry of journal) {
    const p = entry.position, header = await agreed('eth_getBlockByNumber', [`0x${p.block.toString(16)}`, false]);
    if (!header || typeof header !== 'object' || !('hash' in header) || header.hash !== p.blockHash || !('timestamp' in header)
      || typeof header.timestamp !== 'string' || Number(BigInt(header.timestamp)) !== p.timestamp) throw Error('recourse_membership_journal_reorg');
  }
  const events = await getAgreedBaseLogs({ address: pool.pool,
    topics: [RECOURSE_POOL_ABI.getEvent('AddressConsentChanged')!.topicHash, snapshot.identity], fromBlock: snapshot.block, toBlock: snapshot.block });
  const positions = new Map<string, number>(); let prior = -1;
  for (const log of events) {
    const parsed = RECOURSE_POOL_ABI.parseLog({ topics: [...log.topics], data: log.data });
    if (!parsed || parsed.name !== 'AddressConsentChanged' || parsed.args.binding !== snapshot.identity
      || log.removed || log.address !== pool.pool || log.blockNumber !== snapshot.block || log.blockHash !== snapshot.blockHash
      || !Number.isSafeInteger(log.logIndex) || log.logIndex <= prior) throw Error('recourse_membership_log_invalid');
    prior = log.logIndex;
    const key = `${parsed.args.generation}:${parsed.args.joined}`;
    if (positions.has(key)) throw Error('recourse_membership_log_invalid'); positions.set(key, log.logIndex);
  }
  let consent: LossAddressConsent = { generation: 0, active: false, admissionLogIndex: 0, closureLogIndex: 0 };
  const count = Number(pool.consentGeneration);
  if (!Number.isSafeInteger(count) || count < 0) throw Error('recourse_membership_period_invalid');
  for (let generation = count; generation > 0; --generation) {
    const encoded = await agreed('eth_call', [{ to: pool.pool, data: RECOURSE_POOL_ABI.encodeFunctionData('consentPeriods', [snapshot.identity, generation]) },
      { blockHash: snapshot.blockHash, requireCanonical: true }]);
    if (typeof encoded !== 'string') throw Error('recourse_membership_period_invalid');
    const period = RECOURSE_POOL_ABI.decodeFunctionResult('consentPeriods', encoded), start = Number(period[0]), end = Number(period[1]);
    if (!Number.isSafeInteger(start) || start <= 0 || !Number.isSafeInteger(end) || end < 0 || (end !== 0 && end < start)) throw Error('recourse_membership_period_invalid');
    const admission = start === snapshot.block ? positions.get(`${generation}:true`) : 0;
    const closure = end === snapshot.block ? positions.get(`${generation}:false`) : 0;
    if (admission === undefined || closure === undefined) throw Error('recourse_membership_history_incomplete');
    if (start > snapshot.block || (start === snapshot.block && admission >= snapshot.firstOutflowLogIndex)
      || (end !== 0 && (end < snapshot.block || (end === snapshot.block && closure <= snapshot.firstOutflowLogIndex)))) continue;
    consent = { generation, active: true, admissionLogIndex: admission, closureLogIndex: closure }; break;
  }
  const rules = await readPrivateCalendarRules(db, { pool: pool.pool, block: snapshot.block, blockHash: snapshot.blockHash });
  const result = privateMembershipAtLoss(snapshot.identity, journal, { chainId: '8453', pool: pool.pool, kernel: snapshot.kernel,
    block: snapshot.block, blockHash: snapshot.blockHash, logIndex: snapshot.firstOutflowLogIndex, timestamp: pool.timestamp }, consent, rules);
  const current = await ref.get();
  if (current.exists !== row.exists || (account && membershipJournalHash(current.data()) !== membershipJournalHash(row.data()))
    || await readAgreedBaseBlockHash(snapshot.block) !== snapshot.blockHash) throw Error('recourse_membership_checkpoint_changed');
  return { ...result, lossTimestamp: pool.timestamp };
}
