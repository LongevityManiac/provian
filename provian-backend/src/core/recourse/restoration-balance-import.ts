import { Interface, keccak256 } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { rpcChainFactsEqual } from '../onchain/rpc-chain-facts';
import { getAgreedBaseLogs, type CanonicalEconomicLog } from '../onchain/economic-discovery';
import { createRecourseChainPort } from './chain-ledger';
import { historicalBreakReceiptPort, type HistoricalBreakReceiptPort } from './restoration-break-receipt';
import type { RestorationBalanceBridge } from './restoration-bridge-ledger';
const abi = new Interface(['event BalanceMigrated(address indexed previousOwner,address indexed destination,uint256 amount)',
  'event Transfer(address indexed from,address indexed to,uint256 amount)', 'function pvt() view returns(address)']);
const zero = `0x${'0'.repeat(40)}`;
export interface BalanceImportPort extends Omit<HistoricalBreakReceiptPort, 'logs'> {
  balance(kernel: string, account: string, pin: string): Promise<bigint>;
  code(account: string, pin: string): Promise<string>;
  token(account: string, pin: string): Promise<string>;
  imports(executor: string, account: string, from: number, through: number): Promise<readonly CanonicalEconomicLog[]>;
}
export interface HistoricalBalanceImport {
  readonly bridge: RestorationBalanceBridge;
  readonly block: number; readonly blockHash: string; readonly transactionHash: string; readonly logIndex: number;
  readonly mintId: string; readonly evidenceHash: string;
}
/** Authenticate an ordinary balance import or a cryptographic-break institution
 * import. Successful execution of the independently checked immutable executor
 * proves the snapshot leaf; the full artifact additionally pins a break's exact
 * institutional destination/runtime. This never treats an owner entitlement as
 * an ordinary mint, and never trusts a caller-supplied successor address. */
export async function readHistoricalBalanceImport(predecessor: string, account: string, through: number,
  port: BalanceImportPort): Promise<HistoricalBalanceImport | null> {
  if (![predecessor, account].every(value => /^0x[0-9a-f]{40}$/.test(value) && value !== zero)
    || !Number.isSafeInteger(through) || through < 1 || through > await port.chain.finalizedBlock()) throw Error('recourse_import_input_invalid');
  const lineage = await port.lineage(predecessor), migration = lineage.migrations[0], following = lineage.migrations[1];
  if (!migration || migration.predecessor !== predecessor || through <= migration.cutoff
    || following && (following.predecessor !== migration.kernel || through > following.cutoff)) throw Error('recourse_import_generation_invalid');
  const pin = await port.chain.blockHash(through);
  if (!pin || await port.chain.blockHash(migration.cutoff) !== migration.cutoffHash) throw Error('recourse_import_checkpoint_invalid');
  await port.authenticateExecutor(migration.executor, migration.kernel, pin);
  const balance = await port.balance(predecessor, account, migration.cutoffHash);
  if (balance < 0n || balance >= (1n << 256n)) throw Error('recourse_import_balance_invalid');
  let institution: { readonly destination: string; readonly amount: string; readonly runtimeHash: string } | undefined;
  if (migration.kind === 'cryptographic_break') {
    const artifact = await port.artifact(migration.executor);
    if (artifact.domain.predecessor !== predecessor || artifact.domain.block !== migration.cutoff || artifact.domain.root !== migration.root) throw Error('recourse_import_artifact_invalid');
    institution = artifact.institutions.find(row => row.source === account);
    if (!institution || BigInt(institution.amount) !== balance) throw Error('recourse_import_institution_missing');
  }
  const logs = await port.imports(migration.executor, account, migration.cutoff + 1, through);
  if (logs.length !== (balance === 0n ? 0 : 1)) throw Error('recourse_import_history_incomplete');
  let result: HistoricalBalanceImport | null = null;
  if (balance !== 0n) {
    const log = logs[0], event = abi.parseLog({ topics: [...log.topics], data: log.data });
    const destination = event ? String(event.args.destination).toLowerCase() : zero;
    if (log.removed || log.address !== migration.executor || log.blockNumber <= migration.cutoff || log.blockNumber > through
      || !Number.isSafeInteger(log.blockNumber) || !Number.isSafeInteger(log.logIndex) || log.logIndex < 1
      || !event || event.name !== 'BalanceMigrated' || String(event.args.previousOwner).toLowerCase() !== account
      || event.args.amount !== balance || destination === zero || institution && destination !== institution.destination
      || await port.chain.blockHash(log.blockNumber) !== log.blockHash) throw Error('recourse_import_event_invalid');
    const tx = await port.transaction(log.transactionHash), included = tx.logs.find(row => row.logIndex === log.logIndex);
    if (tx.chainId !== 8453 || tx.transactionHash !== log.transactionHash || tx.blockNumber !== log.blockNumber || tx.blockHash !== log.blockHash
      || !included || JSON.stringify(included) !== JSON.stringify(log)) throw Error('recourse_import_inclusion_invalid');
    const mints = tx.logs.filter(row => row.address === migration.kernel && row.logIndex === log.logIndex - 1);
    if (mints.length !== 1) throw Error('recourse_import_mint_missing');
    const mint = mints[0], transfer = abi.parseLog({ topics: [...mint.topics], data: mint.data });
    if (mint.removed || mint.blockHash !== log.blockHash || mint.blockNumber !== log.blockNumber || mint.transactionHash !== log.transactionHash
      || !transfer || transfer.name !== 'Transfer' || String(transfer.args.from).toLowerCase() !== zero
      || String(transfer.args.to).toLowerCase() !== destination || transfer.args.amount !== balance) throw Error('recourse_import_mint_mismatch');
    if (institution && (keccak256(await port.code(destination, log.blockHash)) !== institution.runtimeHash
      || (await port.token(destination, log.blockHash)).toLowerCase() !== migration.kernel)) throw Error('recourse_import_institution_runtime_invalid');
    result = { bridge: { kind: 'succession', kernel: predecessor, origin: migration.executor,
      sources: [{ ref: { kind: 'account', kernel: predecessor, address: account }, amount: balance }],
      destination: { kind: 'account', kernel: migration.kernel, address: destination } },
      block: log.blockNumber, blockHash: log.blockHash, transactionHash: log.transactionHash, logIndex: mint.logIndex,
      mintId: `${migration.kernel}:${mint.transactionHash}:${mint.logIndex}`, evidenceHash: tx.evidenceHash };
  }
  if (await port.manifest() !== lineage.manifestHash) throw Error('recourse_import_protocol_changed');
  if (result && await port.chain.blockHash(result.block) !== result.blockHash
    || await port.chain.blockHash(migration.cutoff) !== migration.cutoffHash
    || await port.chain.blockHash(through) !== pin || await port.chain.blockHash(lineage.block) !== lineage.blockHash) throw Error('recourse_import_reorg');
  return result;
}
export function balanceImportPort(db: Firestore): BalanceImportPort {
  const base = historicalBreakReceiptPort(db), chain = createRecourseChainPort(), legs = getOperatorBoundRpcLegs('base');
  if (legs[0].operatorId === legs[1].operatorId) throw Error('recourse_rpc_operators_not_independent');
  const agree = async (method: string, params: readonly unknown[]): Promise<string> => {
    const values: unknown[] = await Promise.all(legs.map(leg => leg.provider.send(method, [...params])));
    if (typeof values[0] !== 'string' || !rpcChainFactsEqual(values[0], values[1])) throw Error('recourse_import_rpc_disagreement');
    return values[0];
  };
  return { ...base, balance: chain.balance,
    code: (account, pin) => agree('eth_getCode', [account, { blockHash: pin, requireCanonical: true }]),
    token: async (account, pin) => String(abi.decodeFunctionResult('pvt', await agree('eth_call', [{ to: account,
      data: abi.encodeFunctionData('pvt') }, { blockHash: pin, requireCanonical: true }]))[0]).toLowerCase(),
    imports: (executor, account, from, through) => getAgreedBaseLogs({ address: executor,
      topics: [abi.getEvent('BalanceMigrated')!.topicHash, `0x${account.slice(2).padStart(64, '0')}`], fromBlock: from, toBlock: through }),
  };
}
