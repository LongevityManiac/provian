import { createHash } from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { getAgreedBaseLogs } from '../onchain/economic-discovery';
import { rpcChainFactsEqual } from '../onchain/rpc-chain-facts';
import { resolveHistoricalProtocolDeployment, type PointerRpc } from '../protocol/pointer';
import { PROTOCOL_POINTER_PIN } from '../protocol/pointer-pin.generated';
import { createRecourseChainPort } from './chain-ledger';
import { MEMBERSHIP_AUTHORIZATION_ABI } from './membership-authorization';
import { MEMBERSHIP_RECEIPT_ABI, readMembershipReceipt, type VerifiedMembershipReceipt } from './membership-receipt';
import { PRIVATE_MEMBERSHIP_COLLECTIONS as C, type PrivateMembershipAccount } from './private-membership-reservation';
import { RECOURSE_COLLECTIONS } from './ownership';

interface Binding { readonly identity: string; readonly address: string; readonly recoveryGeneration: number }
interface Counters { nonce: bigint; generation: bigint; joined: boolean; debit: bigint }
export interface PrivateMembershipScan {
  readonly ownerIdentity: string; readonly accountVersion: number; readonly bindingHash: string;
  readonly fromBlock: number; readonly fromBlockHash: string; readonly pool: string;
  readonly block: number; readonly blockHash: string; readonly timestamp: number;
  readonly receipts: readonly VerifiedMembershipReceipt[];
  readonly requiredEffects: readonly { readonly kernel: string; readonly transactionHash: string; readonly logIndex: number }[];
}
const authentic = new WeakSet<object>();
const fail = (reason: string): never => { throw Error(`recourse_private_scan_${reason}`); };
const hash = (value: unknown): string => `0x${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
function bindings(rows: readonly { data(): FirebaseFirestore.DocumentData | undefined }[]): Binding[] {
  return rows.map(row => {
    const r = row.data();
    if (!r || !/^0x[0-9a-f]{64}$/.test(r.identity) || !/^0x[0-9a-f]{40}$/.test(r.address)
      || !Number.isSafeInteger(r.recoveryGeneration) || r.recoveryGeneration < 0) return fail('binding');
    return { identity: String(r.identity), address: String(r.address), recoveryGeneration: Number(r.recoveryGeneration) };
  }).sort((a, b) => a.address.localeCompare(b.address));
}
function quantity(value: unknown): number {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value)) return fail('reply');
  const n = Number(BigInt(value)); return Number.isSafeInteger(n) ? n : fail('reply');
}

/** Scans a whole pool range, never publishing a private portfolio query. Every
 * debit/cancellation/consent counter must reconcile with canonical endpoint
 * state. Issuance is additionally fenced by the private pending reservation:
 * it cannot be cleared by scanning or by an absent log. */
export async function readPrivateMembershipScan(db: Firestore, ownerIdentity: string): Promise<PrivateMembershipScan> {
  if (!/^0x[0-9a-f]{64}$/.test(ownerIdentity)) return fail('owner');
  const accountRow = await db.collection(C.owners).doc(ownerIdentity).get();
  if (!accountRow.exists) return fail('missing_account');
  const account = accountRow.data() as PrivateMembershipAccount;
  const rows = await db.collection(RECOURSE_COLLECTIONS.addresses).where('ownerIdentity', '==', ownerIdentity).get();
  const portfolio = bindings(rows.docs);
  if (portfolio.length === 0 || account.ownerIdentity !== ownerIdentity) return fail('binding');
  const ids = [...new Set(portfolio.map(row => row.identity))], addresses = new Set(portfolio.map(row => row.address));
  const configured = getOperatorBoundRpcLegs('base');
  if (!configured[0].operatorId || !configured[1].operatorId || configured[0].operatorId === configured[1].operatorId) return fail('operators');
  const rpcs: readonly [PointerRpc, PointerRpc] = [{ request: (m, p) => configured[0].provider.send(m, [...p]) },
    { request: (m, p) => configured[1].provider.send(m, [...p]) }];
  const agreed = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    const [a, b] = await Promise.all(rpcs.map(r => r.request(method, params)));
    if (!rpcChainFactsEqual(a, b)) return fail('disagreement'); return a;
  };
  const pointer = PROTOCOL_POINTER_PIN.address, runtimeHash = PROTOCOL_POINTER_PIN.runtimeHash;
  if (!pointer || !runtimeHash) return fail('pointer');
  const from = account.checkpoint, chain = createRecourseChainPort();
  const block = await chain.finalizedBlock(), blockHash = await chain.blockHash(block);
  if (block < from.block || !blockHash) return fail('checkpoint');
  const [before, after] = await Promise.all([
    resolveHistoricalProtocolDeployment(rpcs, pointer, runtimeHash, from.block, from.blockHash),
    resolveHistoricalProtocolDeployment(rpcs, pointer, runtimeHash, block, blockHash),
  ]);
  if (before.manifestHash !== after.manifestHash || before.addresses.recoursePool.toLowerCase() !== from.pool) return fail('succession_required');
  const raw = await agreed('eth_getBlockByNumber', [`0x${block.toString(16)}`, false]);
  if (!raw || typeof raw !== 'object' || !('hash' in raw) || raw.hash !== blockHash || !('timestamp' in raw)) return fail('reorg');
  const timestamp = quantity(raw.timestamp);
  const counters = async (id: string, at: string): Promise<Counters> => {
    const call = async (method: string) => {
      const result = await agreed('eth_call', [{ to: from.pool, data: MEMBERSHIP_AUTHORIZATION_ABI.encodeFunctionData(method, [id]) },
        { blockHash: at, requireCanonical: true }]);
      if (typeof result !== 'string') return fail('reply');
      return MEMBERSHIP_AUTHORIZATION_ABI.decodeFunctionResult(method, result);
    };
    const [consent, debit] = await Promise.all([call('addressConsent'), call('debitNonce')]);
    return { nonce: BigInt(consent[0]), generation: BigInt(consent[1]), joined: Boolean(consent[2]), debit: BigInt(debit[0]) };
  };
  const states = new Map<string, Counters>();
  for (const id of ids) states.set(id, await counters(id, from.blockHash));
  const topics = ['AddressConsentChanged', 'MembershipDebitExecuted', 'MembershipDebitCancelled', 'IssuanceTicketConsumed', 'IssuanceBatchCancelled']
    .map(name => MEMBERSHIP_RECEIPT_ABI.getEvent(name)!.topicHash);
  const transactions = new Set<string>(), effects: { kernel: string; transactionHash: string; logIndex: number }[] = [];
  let lastBlock = from.block, lastLog = -1;
  for (let start = from.block + 1; start <= block; start += 500) {
    const end = Math.min(start + 499, block);
    const logs = await getAgreedBaseLogs({ address: from.pool, topics: [topics], fromBlock: start, toBlock: end });
    for (const l of logs) {
      if (l.removed || l.address !== from.pool || l.blockNumber < start || l.blockNumber > end
        || l.blockNumber < lastBlock || (l.blockNumber === lastBlock && l.logIndex <= lastLog)) return fail('log_order');
      lastBlock = l.blockNumber; lastLog = l.logIndex;
      const event = MEMBERSHIP_RECEIPT_ABI.parseLog({ topics: [...l.topics], data: l.data });
      if (!event) return fail('event');
      const state = ['AddressConsentChanged', 'MembershipDebitExecuted', 'MembershipDebitCancelled'].includes(event.name)
        ? states.get(String(event.args.binding)) : undefined;
      const issuance = event.name === 'IssuanceTicketConsumed' && addresses.has(String(event.args.account).toLowerCase());
      if (!state && !issuance) continue;
      if (state) {
        if (event.name === 'AddressConsentChanged') {
          const joined = Boolean(event.args.joined);
          if (joined === state.joined || BigInt(event.args.nonce) !== state.nonce
            || BigInt(event.args.generation) !== state.generation + (joined ? 1n : 0n)) return fail('history_gap');
          state.nonce++; state.joined = joined;
          if (joined) state.generation++; else state.debit++;
        } else {
          if (BigInt(event.args.nonce) !== state.debit) return fail('history_gap');
          state.debit++;
        }
      }
      transactions.add(l.transactionHash);
      if (issuance || event.name === 'MembershipDebitExecuted' || event.name === 'AddressConsentChanged') effects.push({ kernel: before.addresses.kernel.toLowerCase(),
        transactionHash: l.transactionHash, logIndex: l.logIndex });
    }
  }
  for (const id of ids) {
    const state = states.get(id)!, end = await counters(id, blockHash);
    if (state.nonce !== end.nonce || state.generation !== end.generation || state.joined !== end.joined || state.debit !== end.debit) return fail('history_gap');
  }
  const receipts: VerifiedMembershipReceipt[] = [];
  for (const tx of transactions) receipts.push(await readMembershipReceipt(tx, from.pool));
  receipts.sort((a, b) => a.block - b.block || a.events[0].logIndex - b.events[0].logIndex);
  if (await chain.blockHash(from.block) !== from.blockHash || await chain.blockHash(block) !== blockHash) return fail('reorg');
  const result = Object.freeze({ ownerIdentity, accountVersion: account.version, bindingHash: hash(portfolio),
    fromBlock: from.block, fromBlockHash: from.blockHash, pool: from.pool, block, blockHash, timestamp,
    receipts: Object.freeze(receipts), requiredEffects: Object.freeze(effects.map(e => Object.freeze(e))) });
  authentic.add(result); return result;
}

/** Advance only after each observed value or consent effect has its durable private transition.
 * A pending issuance remains locked even when an RPC range reports no events. */
export async function commitPrivateMembershipScan(db: Firestore, proof: PrivateMembershipScan): Promise<void> {
  if (!authentic.has(proof)) return fail('unverified');
  await db.runTransaction(async tx => {
    const ref = db.collection(C.owners).doc(proof.ownerIdentity), row = await tx.get(ref);
    if (!row.exists) return fail('missing_account');
    const state = row.data() as PrivateMembershipAccount;
    const portfolio = await tx.get(db.collection(RECOURSE_COLLECTIONS.addresses).where('ownerIdentity', '==', proof.ownerIdentity));
    const effectRows = await Promise.all(proof.requiredEffects.map(e => tx.get(db.collection(C.effects)
      .doc(hash([e.kernel, proof.pool, e.transactionHash, e.logIndex])))));
    if (state.version !== proof.accountVersion || state.pendingReservation !== null || state.checkpoint.pool !== proof.pool
      || state.checkpoint.block !== proof.fromBlock || state.checkpoint.blockHash !== proof.fromBlockHash
      || hash(bindings(portfolio.docs)) !== proof.bindingHash) return fail('concurrent');
    if (effectRows.some(row => !row.exists || row.get('ownerIdentity') !== proof.ownerIdentity)) return fail('uncredited_effect');
    if (!Number.isSafeInteger(state.version + 1)) return fail('version');
    tx.update(ref, { checkpoint: { pool: proof.pool, block: proof.block, blockHash: proof.blockHash },
      needsScan: false, version: state.version + 1 });
  });
}
