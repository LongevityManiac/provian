import { readRestorationLineage, readMigrationMint, type RestorationLineage, type RestorationMigration, type MigrationBalance } from './restoration-lineage';
import { createHash } from 'crypto';
import { Interface } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { resolveAddressOwnership } from '../pvt/policy/same-owner-detection';
import { identityHash, RECOURSE_COLLECTIONS } from './ownership';
import { currentProtocolDeployment } from '../protocol/runtime';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { rpcChainFactsEqual } from '../onchain/rpc-chain-facts';
import { verifyBaseTransactionEvidence, type BaseTransactionEvidence } from '../onchain/economic-discovery';
import { classifyWalletExchange, BASE_EXCHANGE_PROFILE, wellFormedTransfers } from '../pvt/wallet-exchange';
import { createRecourseChainPort, type RecourseChainPort } from './chain-ledger';
import type { LossSnapshot } from './loss-snapshot';
import type { TransferEvent } from './ownership';
import { traceRestoration, type TraceCheckpoint, type TracedTransfer, type RestorationTrace } from './restoration-trace';

const ZERO = `0x${'0'.repeat(40)}`;
const abi = new Interface(['function registryOperator() view returns(address)', 'function ownerOf(address) view returns(bytes32)',
  'function outgoingSequence(address) view returns(uint256)', 'function transfer(address,uint256)', 'function transferCurrent(address,uint256,uint256)']);
const digest = (value: unknown): string => `0x${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
export interface RestorationEvidencePort {
  readonly chain: RecourseChainPort;
  transaction(hash: string): Promise<BaseTransactionEvidence>;
  call(target: string, method: 'registryOperator' | 'ownerOf' | 'outgoingSequence', args: readonly unknown[], blockHash: string): Promise<string>;
  currentKernel(): Promise<string>;
  lineage?(lossKernel:string): Promise<RestorationLineage>;
  migrationMint?(migration:RestorationMigration,account:string,through:number): Promise<MigrationBalance|null>;
  encumberedBalance?(account:string,kernel:string,blockHash:string): Promise<string>;
  /** Private owner of one public recovery binding; never included in calldata. */
  privateOwner(binding: string): Promise<string | null>;
  /** `identity` here is the relay's private owner key, not a public binding. */
  verifiedIdentity(account: string): Promise<{ readonly identity: string; readonly evidenceHash: string } | null>;
}
export function restorationEvidencePort(db: Firestore): RestorationEvidencePort {
  const legs = getOperatorBoundRpcLegs('base');
  if (legs[0].operatorId === legs[1].operatorId) throw new Error('recourse_rpc_operators_not_independent');
  const chain=createRecourseChainPort();
  return { chain, lineage:readRestorationLineage, migrationMint:(migration,account,through)=>readMigrationMint(migration,account,through,chain), transaction: hash => verifyBaseTransactionEvidence({ transactionHash: hash }),
    currentKernel: async () => (await currentProtocolDeployment()).addresses.kernel.toLowerCase(),
    async privateOwner(binding) {
      const row = await db.collection(RECOURSE_COLLECTIONS.identities).doc(binding).get();
      if (!row.exists) return null;
      const kind: unknown = row.get('ownerType'), id: unknown = row.get('ownerId');
      if (row.get('identity') !== binding || (kind !== 'human' && kind !== 'agent') || typeof id !== 'string'
        || row.get('ownerIdentity') !== identityHash(kind, id)) throw Error('recourse_evidence_owner_unusable');
      return identityHash(kind, id);
    },
    async encumberedBalance(account, kernel, blockHash) {
      const deployment = await currentProtocolDeployment();
      if (deployment.addresses.kernel.toLowerCase() !== kernel) throw new Error('recourse_evidence_kernel_retired');
      const isPool = account === deployment.addresses.recoursePool.toLowerCase();
      const isCustody = ['escrow', 'projectPool', 'bonds', 'court'].some(key =>
        deployment.addresses[key as 'escrow' | 'projectPool' | 'bonds' | 'court'].toLowerCase() === account);
      if (!isPool && !isCustody) return '0';
      const reserveAbi = new Interface(['function accountedBacking() view returns(uint256)',
        'function allocatedRestorations() view returns(uint256)', 'function encumberedPVT() view returns(uint256)']);
      let total = 0n;
      for (const method of isPool ? ['accountedBacking', 'allocatedRestorations'] : ['encumberedPVT']) {
        const replies: unknown[] = await Promise.all(legs.map(leg => leg.provider.send('eth_call', [{ to: account,
          data: reserveAbi.encodeFunctionData(method) }, { blockHash, requireCanonical: true }])));
        if (typeof replies[0] !== 'string' || !rpcChainFactsEqual(replies[0], replies[1])) throw new Error('recourse_evidence_rpc_disagreement');
        total += BigInt(reserveAbi.decodeFunctionResult(method, replies[0])[0]);
      }
      return total.toString();
    },
    async verifiedIdentity(account) {
      const owner = await resolveAddressOwnership(db, account);
      if (!owner) return null;
      if (!owner.ownerType || !owner.ownerId || !owner.walletId) throw new Error('recourse_evidence_owner_unusable');
      // Exact owning identity only. Beneficiary links do not transfer an agent's
      // own PVT to its linked human and never count as restitution.
      return { identity: identityHash(owner.ownerType, owner.ownerId), evidenceHash: digest({ account, owner }) };
    },
    async call(target, method, args, blockHash) {
      const results: unknown[] = await Promise.all(legs.map(leg => leg.provider.send('eth_call', [{ to: target,
        data: abi.encodeFunctionData(method, args) }, { blockHash, requireCanonical: true }])));
      if (typeof results[0] !== 'string' || !rpcChainFactsEqual(results[0], results[1])) throw new Error('recourse_evidence_rpc_disagreement');
      return String(abi.decodeFunctionResult(method, results[0])[0]).toLowerCase();
    } };
}
/** A positively identified exchange carrier is protected. A direct transfer's
 * shape alone does not establish the absence of a separately witnessed invoice
 * or exchange. Such evidence must be merged by the determination before any
 * recipient can become a reversal source. This classifies chain facts only. */
export function classifyRestorationReceipt(kernel: string, event: TransferEvent, transaction: BaseTransactionEvidence): TracedTransfer['receipt'] {
  if (transaction.transactionHash !== event.transactionHash || transaction.blockNumber !== event.block
    || transaction.blockHash !== event.blockHash || transaction.chainId !== 8453) throw new Error('recourse_evidence_transaction_mismatch');
  const transfers = wellFormedTransfers(transaction);
  const target = transfers.find(log => log.address === kernel && log.logIndex === event.logIndex);
  if (!target || `0x${target.topics[1].slice(26)}` !== event.from || `0x${target.topics[2].slice(26)}` !== event.to
    || BigInt(target.data) !== BigInt(event.amountAtomic)) throw new Error('recourse_evidence_transfer_missing');
  const exchange = classifyWalletExchange(transaction, transaction.fromAddress, { ...BASE_EXCHANGE_PROFILE,
    isKnownAsset: token => token === kernel || BASE_EXCHANGE_PROFILE.isKnownAsset(token) });
  if (exchange.exchange && exchange.carrier.kind === 'erc20'
    && exchange.carrier.log.address === kernel && exchange.carrier.log.logIndex === event.logIndex) return 'witnessed_exchange';
  return 'unresolved';
}
export interface CheckedRestorationEvidence { readonly executionKernel:string; readonly checkpoint: TraceCheckpoint; readonly trace: RestorationTrace; }
const checked = new WeakSet<CheckedRestorationEvidence>();
export function assertRestorationEvidence(value: CheckedRestorationEvidence): void {
  if (!checked.has(value)) throw new Error('recourse_evidence_unverified');
}
/** Follow every reached destination without a member amount/depth
 * cap. Each reached account has its complete history and both balance endpoints
 * independently reconciled. No request-supplied source, amount or classification
 * is used. Canonical duplicate observations must agree byte for byte. */
export async function collectRestorationEvidence(snapshot: LossSnapshot, port: RestorationEvidencePort, throughBlock?:number): Promise<CheckedRestorationEvidence> {
  const executionKernel=await port.currentKernel();
  const lineage=port.lineage ? await port.lineage(snapshot.kernel) : null;
  if ((lineage && lineage.kernel!==executionKernel) || (!lineage && snapshot.kernel!==executionKernel)) throw new Error('recourse_evidence_kernel_retired');
  const finalized=await port.chain.finalizedBlock(),block=throughBlock??finalized;
  if(!Number.isSafeInteger(block)||block>finalized)throw Error('recourse_evidence_checkpoint_invalid');
  const blockHash = await port.chain.blockHash(block);
  const openingHash = await port.chain.blockHash(snapshot.block - 1);
  if (block < snapshot.block || !blockHash || !openingHash || await port.chain.blockHash(snapshot.block) !== snapshot.blockHash) throw new Error('recourse_evidence_checkpoint_invalid');
  const registry = await port.call(executionKernel, 'registryOperator', [], blockHash);
  const privateOwner = await port.privateOwner(snapshot.identity);
  if (privateOwner === null) throw Error('recourse_evidence_owner_unusable');
  const migrations=lineage?.migrations ?? [];
  const segments=[{kernel:snapshot.kernel,from:snapshot.block,through:migrations[0]?.cutoff??block},
    ...migrations.map((migration,index)=>({kernel:migration.kernel,from:migration.cutoff+1,through:migrations[index+1]?.cutoff??block}))];
  if(segments.some(segment=>segment.from>segment.through))throw Error('recourse_evidence_checkpoint_invalid');
  const pending = snapshot.addresses.map(row => row.address), visited = new Set<string>();
  const events = new Map<string, TracedTransfer>();
  const imports = new Set<string>();
  const transactions = new Map<string, BaseTransactionEvidence>();
  const accounts: TraceCheckpoint['accounts'][number][] = [], ownerAliases: TraceCheckpoint['ownerAliases'][number][] = [];
  for (let index = 0; index < pending.length; index++) {
    const account = pending[index];
    if (visited.has(account) || account === ZERO) continue;
    visited.add(account);
    const identity = await port.call(registry, 'ownerOf', [account], blockHash);
    const verified = await port.verifiedIdentity(account);
    const boundOwner = identity === `0x${'0'.repeat(64)}` ? null : await port.privateOwner(identity);
    if (identity !== `0x${'0'.repeat(64)}` && boundOwner === null) throw Error('recourse_evidence_owner_unusable');
    if (verified && boundOwner !== null && verified.identity !== boundOwner) throw new Error('recourse_evidence_owner_conflict');
    if (identity === snapshot.identity || boundOwner === privateOwner || verified?.identity === privateOwner) ownerAliases.push({ address: account,
      evidenceHash: digest({ registry, account, identity, blockHash, verified }) });
    const [opening, closing, sequence] = await Promise.all([
      port.chain.balance(snapshot.kernel, account, openingHash), port.chain.balance(executionKernel, account, blockHash),
      port.call(executionKernel, 'outgoingSequence', [account], blockHash),
    ]);
    const encumberedAtomic = port.encumberedBalance ? await port.encumberedBalance(account, executionKernel, blockHash) : '0';
    accounts.push({ address: account, openingAtomic: opening.toString(), closingAtomic: closing.toString(), outgoingSequence: sequence, encumberedAtomic });
    for(let m=0;m<migrations.length;++m){
      if(!port.migrationMint)throw Error('recourse_migration_verifier_missing');
      const mint=await port.migrationMint(migrations[m],account,segments[m+1].through);
      if(mint){
        imports.add(mint.mintId);
        if(mint.succession){
          const bridge=mint.succession,key=`${bridge.block}:${bridge.logIndex}`,prior=events.get(key);
          if(prior&&JSON.stringify(prior)!==JSON.stringify(bridge))throw Error('recourse_evidence_log_conflict');
          events.set(key,bridge);
          if(!visited.has(bridge.to))pending.push(bridge.to);
        }
      }
    }
    for (const segment of segments) for (const event of await port.chain.transfers(segment.kernel,account,segment.from,segment.through)) {
      if(imports.has(`${event.transactionHash}:${event.logIndex}`))continue;
      let transaction = transactions.get(event.transactionHash);
      if (!transaction) { transaction = await port.transaction(event.transactionHash); transactions.set(event.transactionHash, transaction); }
      const receipt = classifyRestorationReceipt(segment.kernel, event, transaction);
      const observed = { ...event, receipt, witnessHash: transaction.evidenceHash };
      const key = `${event.block}:${event.logIndex}`, prior = events.get(key);
      if (prior && JSON.stringify(prior) !== JSON.stringify(observed)) throw new Error('recourse_evidence_log_conflict');
      events.set(key, observed);
      if (event.from === account && event.to !== ZERO && !visited.has(event.to)) pending.push(event.to);
    }
  }
  const checkpoint: TraceCheckpoint = { block, blockHash, accounts, ownerAliases,
    transfers: [...events.values()].filter(event=>!imports.has(`${event.transactionHash}:${event.logIndex}`))
      .sort((a, b) => a.block - b.block || a.logIndex - b.logIndex) };
  const trace = traceRestoration(snapshot, checkpoint);
  if (await port.chain.blockHash(block) !== blockHash || await port.chain.blockHash(snapshot.block) !== snapshot.blockHash
    || await port.chain.blockHash(snapshot.block - 1) !== openingHash || executionKernel !== await port.currentKernel()) throw new Error('recourse_evidence_checkpoint_changed');
  if(lineage && port.lineage && (await port.lineage(snapshot.kernel)).manifestHash!==lineage.manifestHash)throw Error('recourse_evidence_checkpoint_changed');
  const result = { executionKernel, checkpoint, trace }; checked.add(result); return result;
}
