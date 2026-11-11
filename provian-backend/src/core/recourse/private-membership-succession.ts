import { randomBytes } from 'crypto';
import { AbiCoder, Interface, keccak256 } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { getAgreedBaseLogs } from '../onchain/economic-discovery';
import { rpcChainFactsEqual } from '../onchain/rpc-chain-facts';
import { resolveHistoricalProtocolDeployment, type PointerRpc } from '../protocol/pointer';
import { PROTOCOL_POINTER_PIN } from '../protocol/pointer-pin.generated';
import { createRecourseChainPort } from './chain-ledger';
import { PRIVATE_MEMBERSHIP_COLLECTIONS as C, type PrivateMembershipAccount, type PrivateMembershipReservation } from './private-membership-reservation';
import { PRIVATE_MEMBERSHIP_TRANSITIONS as T, type PrivateMembershipTransition } from './private-membership-transition';
import { RECOURSE_COLLECTIONS as R } from './ownership';
import { RECOURSE_POOL_ABI } from './pool-abi';
import { readPrivateCalendarRules } from './private-calendar-rules';
import { assessPrivateMembership, unadmittedPrivateMembership } from './private-membership-calendar';
import { readPrivateMembershipScan, type PrivateMembershipScan } from './private-membership-scan';
import { membershipReceiptMatchesReservation } from './private-membership-reconcile';
import { utcCalendarMonth } from './calendar-month';
import { activeMembershipJournal, beforeMembershipPosition, checkMembershipJournalEntry, membershipJournalHash as hash,
  PRIVATE_MEMBERSHIP_JOURNAL as J, readMembershipJournal, type MembershipJournalEntry, type MembershipJournalPosition } from './private-membership-journal';

const abi = new Interface(['function ownerAuthorization() view returns(address)', 'function predecessor() view returns(address)',
  'function lastGoodBlock() view returns(uint256)', 'function cryptographicBreak() view returns(bool)',
  'function kernel() view returns(address)', 'function retired(address) view returns(bool)',
  'function getBatchRecord(bytes32) view returns((bool settled,uint8 lane,uint64 epoch,uint256 finalizedCursorStart,uint256 finalizedCursorEnd,bytes32 policyHash,bytes32 claimsHash,bytes32 settlementDigest,uint256 grossInput,uint256 totalMinted,uint256 contributorTotal,uint256 provianTotal,uint256 foundationTotal,uint256 recipientCount,uint256 claimCount))']);
const publicationAbi = new Interface(['event DeploymentChanged(uint256 indexed revision,bytes32 indexed manifestHash,address[10] components,bytes32[10] runtimeHashes)']);
const verified = new WeakSet<object>();
const fail = (reason: string): never => { throw Error(`recourse_membership_succession_${reason}`); };
const number = (v: unknown): number => { const n = typeof v === 'bigint' || typeof v === 'string' ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : fail('number'); };
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value;
}
export interface VerifiedMembershipSuccession {
  readonly ownerIdentity: string; readonly hadAccount: boolean; readonly beforeAccountHash: string; readonly beforeOwnerHash: string;
  readonly portfolioHash: string; readonly entry: MembershipJournalEntry;
  readonly observed: { readonly pool: string; readonly block: number; readonly blockHash: string };
  readonly cutoffEffects: readonly { readonly id: string; readonly hash: string }[];
  readonly pending: { readonly id: string; readonly hash: string } | null;
  readonly transition: { readonly id: string; readonly hash: string } | null;
}

/** The chain selects the cutoff, never an HTTP request or operator-supplied
 * calendar. The already-reconciled old checkpoint must cover that cutoff.
 * This reads encrypted owner links locally and scans whole-pool public logs. */
export async function readPrivateMembershipSuccession(db: Firestore, ownerIdentity: string,
  observation?: { readonly block: number; readonly blockHash: string }): Promise<VerifiedMembershipSuccession> {
  if (!/^0x[0-9a-f]{64}$/.test(ownerIdentity)) return fail('owner');
  const [row, owner, addresses] = await Promise.all([db.collection(C.owners).doc(ownerIdentity).get(),
    db.collection(R.owners).doc(ownerIdentity).get(), db.collection(R.addresses).where('ownerIdentity', '==', ownerIdentity).get()]);
  if (!owner.exists || addresses.empty) return fail('missing_account');
  const account = row.exists ? row.data() as PrivateMembershipAccount : null;
  if (account && (account.ownerIdentity !== ownerIdentity || !Number.isSafeInteger(account.version) || account.version < 0)) return fail('account');
  const initialTransitionId: unknown = owner.get('membershipTransition');
  const initialTransition = typeof initialTransitionId === 'string' ? await db.collection(T).doc(initialTransitionId).get() : null;
  const unadmitted = !account && initialTransition?.exists ? initialTransition.data() as PrivateMembershipTransition : null;
  if (!account && (!unadmitted || unadmitted.ownerIdentity !== ownerIdentity || unadmitted.kind !== 'join'
    || !['preparing','consenting'].includes(unadmitted.status) || unadmitted.bindings.length === 0)) return fail('missing_account');
  const portfolio = addresses.docs.map(r => r.data()).sort((a,b) => String(a.address).localeCompare(String(b.address)));
  const bindings = new Set<string>(), wallets = new Set<string>();
  for (const a of portfolio) {
    if (!/^0x[0-9a-f]{64}$/.test(a.identity) || !/^0x[0-9a-f]{40}$/.test(a.address)) return fail('portfolio');
    bindings.add(String(a.identity)); wallets.add(String(a.address));
  }
  const audit = account ? await readMembershipJournal(db, account) : [], active = activeMembershipJournal(audit), previous = audit.at(-1);
  const source = previous?.position ?? { ...unadmitted!.checkpoint, kernel: unadmitted!.kernel, pool: unadmitted!.pool };
  if (unadmitted && (new Set(unadmitted.bindings.map(b => b.binding)).size !== bindings.size
    || unadmitted.bindings.some(b => !bindings.has(b.binding)))) return fail('portfolio');
  const legs = getOperatorBoundRpcLegs('base');
  if (!legs[0].operatorId || !legs[1].operatorId || legs[0].operatorId === legs[1].operatorId) return fail('operators');
  const rpcs: readonly [PointerRpc, PointerRpc] = [{ request: (m,p) => legs[0].provider.send(m, [...p]) }, { request: (m,p) => legs[1].provider.send(m, [...p]) }];
  const agree = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    const [a,b] = await Promise.all(rpcs.map(r => r.request(method, params)));
    if (!rpcChainFactsEqual(a,b)) return fail('disagreement'); return a;
  };
  const pointer = PROTOCOL_POINTER_PIN.address, pin = PROTOCOL_POINTER_PIN.runtimeHash;
  if (!pointer || !pin) return fail('pointer');
  const chain = createRecourseChainPort(), finalized = await chain.finalizedBlock(), block = observation?.block ?? finalized;
  if (!Number.isSafeInteger(block) || block < 0 || block > finalized) return fail('observation');
  const blockHash = await chain.blockHash(block);
  if (observation && blockHash !== observation.blockHash) return fail('reorg');
  if (!blockHash) return fail('block_unavailable');
  const next = await resolveHistoricalProtocolDeployment(rpcs, pointer, pin, block, blockHash);
  const pool = next.addresses.recoursePool.toLowerCase(), kernel = next.addresses.kernel.toLowerCase();
  if (pool === source.pool || kernel === source.kernel) return fail('not_successor');
  const tag = { blockHash, requireCanonical: true };
  const call = async (to: string, contract: Interface, method: string, args: readonly unknown[] = [], at = tag) => {
    const raw = await agree('eth_call', [{ to, data: contract.encodeFunctionData(method, args) }, at]);
    if (typeof raw !== 'string') return fail('reply'); return contract.decodeFunctionResult(method, raw);
  };
  const snapshot = await call(pool, RECOURSE_POOL_ABI, 'poolSnapshot'), cutoffBlock = number(snapshot[1]);
  if (String(snapshot[0]).toLowerCase() !== source.pool || (account && source.pool !== account.checkpoint.pool)
    || cutoffBlock >= block || number(snapshot[3]) === 0 || (await call(pool, RECOURSE_POOL_ABI, 'poolHistoryReady'))[0] !== true
    || String((await call(pool, RECOURSE_POOL_ABI, 'token'))[0]).toLowerCase() !== kernel) return fail('snapshot');
  const afterBreak = snapshot[4] === true, cutoffHash = await chain.blockHash(cutoffBlock);
  if (!cutoffHash) return fail('block_unavailable');
  const before = await resolveHistoricalProtocolDeployment(rpcs, pointer, pin, cutoffBlock, cutoffHash);
  if (before.addresses.kernel.toLowerCase() !== source.kernel || before.addresses.recoursePool.toLowerCase() !== source.pool) return fail('predecessor');
  const executor = String((await call(kernel, abi, 'ownerAuthorization'))[0]).toLowerCase();
  if (String((await call(executor, abi, 'kernel'))[0]).toLowerCase() !== kernel
    || String((await call(executor, abi, 'predecessor'))[0]).toLowerCase() !== source.kernel
    || number((await call(executor, abi, 'lastGoodBlock'))[0]) !== cutoffBlock
    || (await call(executor, abi, 'cryptographicBreak'))[0] !== afterBreak) return fail('kernel_cutoff');
  for (const old of [source.pool, source.kernel]) {
    if ((await call(pointer, abi, 'retired', [old]))[0] !== true) return fail('not_retired');
  }
  const timestamp = async (height: number, expected: string): Promise<number> => {
    const header = await agree('eth_getBlockByNumber', [`0x${height.toString(16)}`, false]);
    if (!header || typeof header !== 'object' || !('hash' in header) || header.hash !== expected || !('timestamp' in header)) return fail('reorg');
    return number(header.timestamp);
  };
  for (const entry of active) {
    if (await timestamp(entry.position.block, entry.position.blockHash) !== entry.position.timestamp) return fail('journal_reorg');
  }
  const cutoff: MembershipJournalPosition = { chainId: '8453', kernel: source.kernel, pool: source.pool,
    block: cutoffBlock, blockHash: cutoffHash, logIndex: Number.MAX_SAFE_INTEGER, timestamp: await timestamp(cutoffBlock, cutoffHash) };
  if (account && await chain.blockHash(account.checkpoint.block) !== account.checkpoint.blockHash) return fail('reconciliation_pending');
  let cutoffScan: PrivateMembershipScan | null = null;
  const cutoffEffects: { id: string; hash: string }[] = [];
  if (account && account.checkpoint.block < cutoffBlock) {
    cutoffScan = await readPrivateMembershipScan(db,ownerIdentity,cutoff);
    if (cutoffScan.accountVersion !== account.version || cutoffScan.fromBlock !== account.checkpoint.block
      || cutoffScan.fromBlockHash !== account.checkpoint.blockHash) return fail('concurrent');
    for (const effect of cutoffScan.requiredEffects) {
      const id = hash([effect.kernel,cutoff.pool,effect.transactionHash,effect.logIndex]);
      const row = await db.collection(C.effects).doc(id).get();
      if (!row.exists || row.get('ownerIdentity') !== ownerIdentity) return fail('reconciliation_pending');
      cutoffEffects.push({ id, hash: hash(row.data()) });
    }
  }
  const retained = active.filter(e => beforeMembershipPosition(e.position, cutoff)
    || (e.position.block === cutoff.block && e.position.logIndex === cutoff.logIndex)), ancestor = retained[retained.length - 1];
  if (!afterBreak && ancestor?.id !== previous?.id) return fail('ordinary_rollback');
  const rules = await readPrivateCalendarRules(db, { pool: cutoff.pool, block: cutoff.block, blockHash: cutoff.blockHash });
  const month = utcCalendarMonth(cutoff.timestamp), episode = ancestor
    ? assessPrivateMembership(ancestor.episode, month, rules) : unadmittedPrivateMembership(month);

  // Pending old-domain work cannot be silently cleared if it could have executed
  // before the cutoff. A reservation starts strictly after its scan checkpoint.
  let pending: VerifiedMembershipSuccession['pending'] = null;
  if (account && account.pendingReservation !== null) {
    const p = await db.collection(C.reservations).doc(account.pendingReservation).get(), r = p.get('reservation') as PrivateMembershipReservation;
    if (!p.exists || p.get('status') !== 'pending' || !r || r.id !== account.pendingReservation || r.ownerIdentity !== ownerIdentity
      || r.domain.pointer !== pointer.toLowerCase() || r.domain.pool !== cutoff.pool || r.domain.kernel !== cutoff.kernel
      || (r.checkpoint.block < cutoff.block && (!cutoffScan || cutoffScan.receipts.some(receipt => membershipReceiptMatchesReservation(receipt,r))))) return fail('pending_reconciliation');
    if (r.kind === 'issuance' && r.checkpoint.block < cutoff.block) {
      const at = { blockHash: cutoff.blockHash, requireCanonical: true };
      const batch = (await call(cutoff.kernel,abi,'getBatchRecord',[r.context.batchId],at))[0];
      const cancelled = (await call(cutoff.pool,RECOURSE_POOL_ABI,'cancelledIssuanceBatch',[r.context.batchId],at))[0];
      // Issuance has no per-owner endpoint counter. Absent logs cannot erase a
      // settled batch; its authentic receipt must first credit the calendar.
      if (batch[0] !== false || cancelled !== false) return fail('pending_reconciliation');
    }
    pending = { id: account.pendingReservation, hash: hash(p.data()) };
  }
  let transition: VerifiedMembershipSuccession['transition'] = null;
  const transitionId: unknown = owner.get('membershipTransition');
  if (transitionId !== null && transitionId !== undefined) {
    if (typeof transitionId !== 'string') return fail('transition');
    const t = await db.collection(T).doc(transitionId).get();
    if (!t.exists || t.get('ownerIdentity') !== ownerIdentity || t.get('pool') !== cutoff.pool || t.get('kernel') !== cutoff.kernel
      || !['preparing','consenting'].includes(String(t.get('status')))) return fail('transition');
    transition = { id: transitionId, hash: hash(t.data()) };
  }

  // Importing the snapshot does not authorize skipping successor-side changes.
  // New money signatures require this bridge first. Any observed money/consent
  // effect therefore needs investigation rather than silently gaining credit.
  const counters = new Map<string, { nonce: bigint; generation: bigint; joined: boolean; debit: bigint }>();
  for (const id of bindings) {
    const c = await call(cutoff.pool, RECOURSE_POOL_ABI, 'addressConsent', [id], { blockHash: cutoff.blockHash, requireCanonical: true });
    const d = await call(cutoff.pool, RECOURSE_POOL_ABI, 'debitNonce', [id], { blockHash: cutoff.blockHash, requireCanonical: true });
    counters.set(id, { nonce: c[0], generation: c[1], joined: c[2], debit: d[0] });
  }
  if (unadmitted && unadmitted.bindings.every(b => {
    const c = counters.get(b.binding)!;
    return c.joined && c.generation === BigInt(b.generation) + 1n && c.nonce === BigInt(b.nonce) + (b.initiallyJoined ? 2n : 1n);
  })) return fail('first_join_reconciliation_pending');
  const topics = ['AddressConsentChanged','MembershipDebitExecuted','MembershipDebitCancelled','IssuanceTicketConsumed','PoolHistoryActivated'].map(n => RECOURSE_POOL_ABI.getEvent(n)!.topicHash);
  let lastBlock = cutoff.block, lastIndex = -1;
  let activation: { block: number; blockHash: string; logIndex: number } | null = null;
  for (let start = cutoff.block + 1; start <= block; start += 500) {
    const end = Math.min(start + 499, block);
    for (const log of await getAgreedBaseLogs({ address: pool, topics: [topics], fromBlock: start, toBlock: end })) {
      if (log.removed || log.address !== pool || log.blockNumber < start || log.blockNumber > end || log.blockNumber < lastBlock
        || !Number.isSafeInteger(log.logIndex) || (log.blockNumber === lastBlock && log.logIndex <= lastIndex)
        || await chain.blockHash(log.blockNumber) !== log.blockHash) return fail('log');
      lastBlock = log.blockNumber; lastIndex = log.logIndex;
      const event = RECOURSE_POOL_ABI.parseLog({ topics: [...log.topics], data: log.data });
      if (!event) return fail('log');
      if (event.name === 'PoolHistoryActivated') {
        if (activation || event.args.root !== snapshot[2] || event.args[1] !== snapshot[3]) return fail('activation');
        activation = { block: log.blockNumber, blockHash: log.blockHash, logIndex: log.logIndex }; continue;
      }
      if (event.name === 'IssuanceTicketConsumed') { if (wallets.has(String(event.args.account).toLowerCase())) return fail('successor_effect'); continue; }
      const c = counters.get(String(event.args.binding)); if (!c) continue;
      if (event.name !== 'MembershipDebitCancelled') return fail('successor_effect');
      if (event.args.nonce !== c.debit) return fail('counter_gap'); c.debit++;
    }
  }
  for (const [id, c] of counters) {
    const final = await call(pool, RECOURSE_POOL_ABI, 'addressConsent', [id]), debit = await call(pool, RECOURSE_POOL_ABI, 'debitNonce', [id]);
    if (final[0] !== c.nonce || final[1] !== c.generation || final[2] !== c.joined || debit[0] !== c.debit) return fail('counter_gap');
  }
  // Continuity begins at the chain activation, not when this relay catches up.
  // Complete pointer revision replay refuses an omitted publication event.
  let revision = before.revision, lastManifest = before.manifestHash, publication: { block: number; blockHash: string; logIndex: number } | null = null;
  lastBlock = cutoff.block; lastIndex = -1;
  for (let start = cutoff.block + 1; start <= block; start += 500) {
    const end = Math.min(start + 499, block);
    for (const log of await getAgreedBaseLogs({ address: pointer.toLowerCase(), topics: [publicationAbi.getEvent('DeploymentChanged')!.topicHash], fromBlock: start, toBlock: end })) {
      if (log.removed || log.address !== pointer.toLowerCase() || log.blockNumber < start || log.blockNumber > end
        || log.blockNumber < lastBlock || !Number.isSafeInteger(log.logIndex) || (log.blockNumber === lastBlock && log.logIndex <= lastIndex)
        || await chain.blockHash(log.blockNumber) !== log.blockHash) return fail('publication');
      lastBlock = log.blockNumber; lastIndex = log.logIndex;
      const changed = publicationAbi.parseLog({ topics: [...log.topics], data: log.data });
      if (!changed || changed.args.revision !== ++revision || keccak256(AbiCoder.defaultAbiCoder().encode(
        ['uint256','address','uint256','address[10]','bytes32[10]'], [8453,pointer,revision,changed.args.components,changed.args.runtimeHashes])) !== changed.args.manifestHash) return fail('publication');
      lastManifest = String(changed.args.manifestHash);
      if (String(changed.args.components[8]).toLowerCase() === pool
        && String(changed.args.components[0]).toLowerCase() === kernel) {
        publication ??= { block: log.blockNumber, blockHash: log.blockHash, logIndex: log.logIndex };
      }
    }
  }
  if (!activation || !publication || revision !== next.revision || lastManifest !== next.manifestHash) return fail('activation_missing');
  // Publishing before complete pool import would expose a partially usable
  // deployment. Refuse that changeover instead of redefining membership start.
  if (!beforeMembershipPosition(activation, publication)) return fail('premature_publication');
  const effective = publication;
  const body = { ownerIdentity, previousId: previous?.id ?? null, salt: `0x${randomBytes(32).toString('hex')}`, kind: 'succession' as const,
    beforeEpisodeHash: hash(account?.episode ?? null), episode, position: { chainId: '8453' as const, kernel, pool, ...effective, timestamp: await timestamp(effective.block, effective.blockHash) },
    evidenceId: hash({ next: next.manifestHash, before: before.manifestHash, snapshot: [...snapshot].map(v => typeof v === 'bigint' ? String(v) : v), cutoff }),
    succession: { cutoff, ancestorId: ancestor?.id ?? null, afterBreak, manifestHash: next.manifestHash, previousManifestHash: before.manifestHash } };
  const entry: MembershipJournalEntry = { id: hash(body), ...body };
  checkMembershipJournalEntry(entry); activeMembershipJournal([...audit, entry]);
  if (!beforeMembershipPosition(source, entry.position)) return fail('order');
  if (await chain.blockHash(cutoff.block) !== cutoff.blockHash || await chain.blockHash(block) !== blockHash) return fail('reorg');
  const result = deepFreeze({ ownerIdentity, hadAccount: row.exists, beforeAccountHash: hash(row.exists ? row.data() : null), beforeOwnerHash: hash(owner.data()), portfolioHash: hash(portfolio), observed: { pool, block, blockHash }, cutoffEffects, entry, pending, transition });
  verified.add(result); return result;
}

/** Keep audit history and all global receipt/effect fences. Only the private
 * selected head changes; a discarded branch can never requalify membership. */
export async function commitPrivateMembershipSuccession(db: Firestore, proof: VerifiedMembershipSuccession): Promise<void> {
  if (!verified.has(proof)) return fail('unverified');
  await db.runTransaction(async tx => {
    const ref = db.collection(C.owners).doc(proof.ownerIdentity), ownerRef = db.collection(R.owners).doc(proof.ownerIdentity);
    const [row, owner, addresses] = await Promise.all([tx.get(ref), tx.get(ownerRef),
      tx.get(db.collection(R.addresses).where('ownerIdentity', '==', proof.ownerIdentity))]);
    const portfolio = addresses.docs.map(r => r.data()).sort((a,b) => String(a?.address).localeCompare(String(b?.address)));
    if (row.exists !== proof.hadAccount || !owner.exists || hash(row.exists ? row.data() : null) !== proof.beforeAccountHash || hash(owner.data()) !== proof.beforeOwnerHash
      || hash(portfolio) !== proof.portfolioHash) return fail('concurrent');
    const pending = proof.pending ? await tx.get(db.collection(C.reservations).doc(proof.pending.id)) : null;
    const transition = proof.transition ? await tx.get(db.collection(T).doc(proof.transition.id)) : null;
    if (proof.pending && (!pending?.exists || hash(pending.data()) !== proof.pending.hash)) return fail('concurrent');
    if (proof.transition && (!transition?.exists || hash(transition.data()) !== proof.transition.hash)) return fail('concurrent');
    for (const effect of proof.cutoffEffects) {
      const row = await tx.get(db.collection(C.effects).doc(effect.id));
      if (!row.exists || hash(row.data()) !== effect.hash) return fail('concurrent');
    }
    const account = row.exists ? row.data() as PrivateMembershipAccount : null, entry = proof.entry;
    const version = (account?.version ?? -1) + 1;
    if (!Number.isSafeInteger(version)) return fail('version');
    tx.create(db.collection(J).doc(entry.id), entry);
    const next = { ownerIdentity: proof.ownerIdentity, journalHead: entry.id, episode: entry.episode, version, pendingReservation: null,
      needsScan: false, checkpoint: proof.observed, admission: null, closure: null };
    if (row.exists) tx.update(ref, next); else tx.create(ref, next);
    tx.update(ownerRef, { membershipTransition: null });
    if (proof.pending) tx.update(db.collection(C.reservations).doc(proof.pending.id), { status: 'superseded', successionHead: entry.id });
    if (proof.transition) tx.update(db.collection(T).doc(proof.transition.id), { status: 'superseded', successionHead: entry.id });
  });
}
