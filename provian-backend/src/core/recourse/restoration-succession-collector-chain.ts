import type { Firestore } from 'firebase-admin/firestore';
import type { RestorationEvidencePort } from './restoration-evidence';
import type { SuccessionCollectionPort } from './restoration-succession-collector';
import { historicalBreakReceiptPort, readHistoricalBreakRestoration } from './restoration-break-receipt';
import { balanceImportPort, readHistoricalBalanceImport } from './restoration-balance-import';
import { breakPartitionChainPort } from './restoration-break-partition-chain';
import { reconstructBreakPartition } from './restoration-break-partition';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { rpcChainFactsEqual } from '../onchain/rpc-chain-facts';
/** Read-only composition. These adapters authenticate immutable ancestry,
 * full committed artifacts, actual cutoff partitions and canonical receipts.
 * No signer, transaction submission or private portfolio publication lives here. */
export function successionCollectionPort(db: Firestore, evidence: RestorationEvidencePort): SuccessionCollectionPort {
  const receipt = historicalBreakReceiptPort(db), imports = balanceImportPort(db), partitions = breakPartitionChainPort(db);
  const legs = getOperatorBoundRpcLegs('base');
  if (legs[0].operatorId === legs[1].operatorId) throw Error('recourse_rpc_operators_not_independent');
  return {
    evidence, lineage: receipt.lineage, artifact: receipt.artifact, manifest: receipt.manifest,
    partition: (origin, identity) => reconstructBreakPartition(origin, identity, partitions),
    balanceImport: (predecessor, account, through) => readHistoricalBalanceImport(predecessor, account, through, imports),
    restoration: (kernel, identity, through) => readHistoricalBreakRestoration(kernel, identity, through, receipt),
    async origin(kernel, pin) {
      const executor = await receipt.call(kernel, 'ownerAuthorization', [], pin);
      if (typeof executor !== 'string' || !/^0x[0-9a-f]{40}$/.test(executor)) throw Error('recourse_collection_executor_invalid');
      const origin = await receipt.call(executor, 'breakOrigin', [], pin);
      if (typeof origin !== 'string' || !/^0x[0-9a-f]{40}$/.test(origin)) throw Error('recourse_collection_origin_invalid');
      return origin;
    },
    async openingBalance(kernel, account, pin) {
      const codes: unknown[] = await Promise.all(legs.map(leg => leg.provider.send('eth_getCode', [kernel, { blockHash: pin, requireCanonical: true }])));
      if (typeof codes[0] !== 'string' || !/^0x(?:[0-9a-f]{2})*$/.test(codes[0]) || !rpcChainFactsEqual(codes[0], codes[1])) throw Error('recourse_collection_opening_code_invalid');
      return codes[0] === '0x' ? 0n : evidence.chain.balance(kernel, account, pin);
    },
  };
}
