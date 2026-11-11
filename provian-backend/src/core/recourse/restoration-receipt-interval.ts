import { createHash } from 'crypto';
import { Interface } from 'ethers';
import type { BaseTransactionEvidence, CanonicalEconomicLog } from '../onchain/economic-discovery';
import type { BreakEntitlement } from './break-entitlement';
import type { RestorationBalanceBridge } from './restoration-bridge-ledger';

export const RESTORATION_RECEIPT_EVENTS = new Interface([
  'event IdentityRestored(bytes32 indexed identity,address indexed destination,uint256 amount)',
  'event OwnerAuthorizationConsumed(bytes32 indexed identity,uint256 nonce,bytes32 indexed intent,bytes32 nextCommitment,bytes32 nextSigningRoot)',
  'event Transfer(address indexed from,address indexed to,uint256 amount)',
]);
export interface HistoricalRestorationInterval {
  readonly bridge: RestorationBalanceBridge;
  readonly block: number;
  readonly blockHash: string;
  readonly transactionHash: string;
  readonly logIndex: number;
  /** Only this exact mint is omitted from ordinary issuance accounting. */
  readonly mintId: string | null;
  readonly evidenceHash: string;
}
const zero = `0x${'0'.repeat(40)}`, hash = /^0x[0-9a-f]{64}$/, address = /^0x[0-9a-f]{40}$/;
function event(log: CanonicalEconomicLog, name: string) {
  if (log.topics[0] !== RESTORATION_RECEIPT_EVENTS.getEvent(name)!.topicHash) return null;
  const decoded = RESTORATION_RECEIPT_EVENTS.parseLog({ topics: [...log.topics], data: log.data });
  if (!decoded || decoded.name !== name) throw Error('recourse_restoration_event_invalid');
  // ABI decoders permit excess words. Evidence must use the actual event form.
  const encoded = RESTORATION_RECEIPT_EVENTS.encodeEventLog(RESTORATION_RECEIPT_EVENTS.getEvent(name)!, decoded.args);
  if (encoded.data !== log.data || JSON.stringify(encoded.topics) !== JSON.stringify(log.topics)) throw Error('recourse_restoration_event_invalid');
  return decoded;
}
/** Verify one execution interval in an independently authenticated finalized
 * receipt. The caller authenticates the immutable executor/runtime, kernel,
 * effective break origin and complete snapshot artifact. Successful execution
 * of that executor establishes the independent owner proof; today's rotated
 * spending key and owner nonce are deliberately not inputs. This pure helper
 * alone does not establish chain inclusion, finality or snapshot authority. */
export function verifyHistoricalRestorationInterval(input: {
  readonly kernel: string; readonly executor: string; readonly origin: string;
  readonly owner: BreakEntitlement; readonly transaction: BaseTransactionEvidence; readonly logIndex: number;
}): HistoricalRestorationInterval {
  const { kernel, executor, origin, owner, transaction: tx, logIndex } = input;
  if (![kernel, executor, origin].every(value => address.test(value) && value !== zero)
    || !hash.test(owner.identity) || /^0x0+$/.test(owner.identity) || !hash.test(owner.commitment) || /^0x0+$/.test(owner.commitment)
    || !/^(0|[1-9][0-9]*)$/.test(owner.amount) || BigInt(owner.amount) >= (1n << 256n)
    || tx.chainId !== 8453 || !hash.test(tx.transactionHash) || !hash.test(tx.blockHash)
    || !Number.isSafeInteger(tx.blockNumber) || tx.blockNumber < 1
    || !Number.isSafeInteger(logIndex) || logIndex < 0) throw Error('recourse_restoration_interval_invalid');
  let previousIndex = -1;
  for (const log of tx.logs) {
    if (log.removed || !Number.isSafeInteger(log.logIndex) || log.logIndex <= previousIndex
      || log.transactionHash !== tx.transactionHash || log.blockNumber !== tx.blockNumber || log.blockHash !== tx.blockHash) {
      throw Error('recourse_restoration_receipt_invalid');
    }
    previousIndex = log.logIndex;
  }
  const restoredLog = tx.logs.find(log => log.logIndex === logIndex);
  const restored = restoredLog?.address === executor ? event(restoredLog, 'IdentityRestored') : null;
  if (!restored || restored.args.identity !== owner.identity || restored.args.amount !== BigInt(owner.amount)) throw Error('recourse_restoration_outcome_missing');
  const destination = String(restored.args.destination).toLowerCase();
  if (!address.test(destination) || destination === zero) throw Error('recourse_restoration_outcome_missing');
  // Reentrant execution is forbidden by the immutable executor. An interval
  // starts at its nearest consumption event, not at the transaction boundary.
  const starts = tx.logs.filter(log => log.address === executor && log.logIndex < logIndex)
    .map(log => ({ log, consumed: event(log, 'OwnerAuthorizationConsumed') })).filter(row => row.consumed !== null);
  const start = starts.at(-1);
  if (!start?.consumed || start.consumed.args.identity !== owner.identity
    || ['intent', 'nextCommitment', 'nextSigningRoot'].some(key => /^0x0+$/.test(String(start.consumed!.args[key])))) {
    throw Error('recourse_restoration_authorization_missing');
  }
  const interval = tx.logs.filter(log => log.logIndex > start.log.logIndex && log.logIndex < logIndex);
  if (interval.some(log => log.address === executor && event(log, 'IdentityRestored') !== null)) throw Error('recourse_restoration_interval_ambiguous');
  const mints = interval.filter(log => log.address === kernel).map(log => ({ log, transfer: event(log, 'Transfer') }))
    .filter(row => row.transfer?.args.from === zero && String(row.transfer.args.to).toLowerCase() === destination);
  if (owner.amount === '0' ? mints.length !== 0 : mints.length !== 1 || mints[0].transfer!.args.amount !== BigInt(owner.amount)) {
    throw Error('recourse_restoration_mint_mismatch');
  }
  const bridge: RestorationBalanceBridge = { kind: 'restoration', kernel, origin,
    sources: [{ ref: { kind: 'entitlement', origin, identity: owner.identity }, amount: BigInt(owner.amount) }],
    destination: { kind: 'account', kernel, address: destination } };
  return { bridge, block: tx.blockNumber, blockHash: tx.blockHash, transactionHash: tx.transactionHash, logIndex,
    mintId: mints.length ? `${kernel}:${tx.transactionHash}:${mints[0].log.logIndex}` : null,
    evidenceHash: `0x${createHash('sha256').update(JSON.stringify({ kernel, executor, origin, owner, receipt: tx.evidenceHash,
      start: start.log.logIndex, logIndex, destination })).digest('hex')}` };
}
