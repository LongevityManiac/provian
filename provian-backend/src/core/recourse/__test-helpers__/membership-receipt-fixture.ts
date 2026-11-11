import { AbiCoder, Interface, keccak256 } from 'ethers';
import { MEMBERSHIP_RECEIPT_ABI, readMembershipReceipt } from '../membership-receipt';
import { getOperatorBoundRpcLegs } from '../../onchain/rpc-provider';
import type { EconomicStateRpcLeg } from '../../onchain/economic-state';
export function configure(legs: readonly EconomicStateRpcLeg[]): void {
  (getOperatorBoundRpcLegs as jest.Mock).mockReturnValue(legs.map(l => ({ operatorId: l.operatorId, provider: { send: l.send } })));
}
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const pointer = a(1), code = '0x6000', runtimeHash = keccak256(code), tx = h(10), blockHash = h(100);
const old = Array.from({ length: 10 }, (_, i) => a(100 + i)), next = Array.from({ length: 10 }, (_, i) => a(200 + i));
const hashes = old.map(() => runtimeHash);
const p = new Interface(['function revision() view returns(uint256)', 'function current() view returns(uint256,bytes32,address[10],bytes32[10])',
  'event DeploymentChanged(uint256 indexed revision,bytes32 indexed manifestHash,address[10] components,bytes32[10] runtimeHashes)']);
const manifest = (revision: number, targets: string[]) => keccak256(AbiCoder.defaultAbiCoder().encode(
  ['uint256', 'address', 'uint256', 'address[10]', 'bytes32[10]'], [8453, pointer, revision, targets, hashes]));
export function fixture() {
  const meta = { blockNumber: '0x64', blockHash, removed: false, transactionHash: tx };
  const publication = (index: number, revision: number, targets: string[]) => ({ ...meta, address: pointer,
    logIndex: `0x${index.toString(16)}`, ...p.encodeEventLog(p.getEvent('DeploymentChanged')!, [revision, manifest(revision, targets), targets, hashes]) });
  const debit = MEMBERSHIP_RECEIPT_ABI.encodeEventLog(MEMBERSHIP_RECEIPT_ABI.getEvent('MembershipDebitExecuted')!, [h(1), h(2), a(3), 24322, 100, 0, 7]);
  const state = {
    publications: [publication(1, 1, old)], pool: old[8], status: '0x1', final: '0x64', chain: '0x2105', badCode: false,
    effects: [{ logIndex: '0x5', ...debit }], wrongBinding: false, reorg: false, reads: 0, receiptTx: tx, priorRevision: 0, endRevision: 1, endTargets: old,
    debitNonceBefore: 7, debitNonceAfter: 7,
  };
  const send: EconomicStateRpcLeg['send'] = async (method, params) => {
    if (method === 'eth_chainId') return state.chain;
    if (method === 'eth_getTransactionReceipt') return { transactionHash: state.receiptTx, blockNumber: '0x64', blockHash, status: state.status,
      logs: state.effects.map(effect => ({ ...meta, address: state.pool, ...effect })) };
    if (method === 'eth_getLogs') return state.publications;
    if (method === 'eth_getBlockByNumber') {
      if (params[0] === 'finalized') return { number: state.final };
      const prior = params[0] === '0x63';
      return { number: prior ? '0x63' : '0x64', hash: prior ? h(99) : state.reorg && state.reads++ >= 2 ? h(101) : blockHash,
        timestamp: '0x6553f100', parentHash: prior ? h(98) : h(99), transactions: [tx] };
    }
    if (method === 'eth_getCode') return state.badCode && params[0] !== pointer ? '0x6001' : code;
    if (method === 'eth_call') {
      const call = params[0] as { to: string; data: string };
      const batch = new Interface(['function getBatchRecord(bytes32) view returns((bool settled,uint8 lane,uint64 epoch,uint256 finalizedCursorStart,uint256 finalizedCursorEnd,bytes32 policyHash,bytes32 claimsHash,bytes32 settlementDigest,uint256 grossInput,uint256 totalMinted,uint256 contributorTotal,uint256 provianTotal,uint256 foundationTotal,uint256 recipientCount,uint256 claimCount))']);
      if (call.data.startsWith(batch.getFunction('getBatchRecord')!.selector)) return batch.encodeFunctionResult('getBatchRecord', [
        [true,0,1,0,3,h(601),h(604),h(602),300,300,297,1,2,3,3],
      ]);
      const prior = (params[1] as { blockHash?: string }).blockHash === h(99);
      const debitCounter = new Interface(['function debitNonce(bytes32) view returns(uint256)']);
      if (call.data.startsWith(debitCounter.getFunction('debitNonce')!.selector)) return debitCounter.encodeFunctionResult('debitNonce',
        [prior ? state.debitNonceBefore : state.debitNonceAfter]);
      if (call.data === p.encodeFunctionData('revision')) return p.encodeFunctionResult('revision', [prior ? state.priorRevision : state.endRevision]);
      if (call.data === p.encodeFunctionData('current')) {
        const revision = prior ? state.priorRevision : state.endRevision, targets = prior ? old : state.endTargets;
        return p.encodeFunctionResult('current', [revision, manifest(revision, targets), targets, hashes]);
      }
      for (const getter of ['protocolPointer', 'pointer', 'token', 'pvt', 'epochClock', 'KERNEL', 'kernel', 'settlement', 'pool']) {
        const abi = new Interface([`function ${getter}() view returns(address)`]);
        if (call.data !== abi.encodeFunctionData(getter)) continue;
        const targets = next.includes(call.to.toLowerCase()) ? next : old;
        const target = state.wrongBinding ? a(999) : getter === 'pointer' || getter === 'protocolPointer' ? pointer
          : getter === 'settlement' ? targets[9] : getter === 'pool' ? targets[8] : targets[0];
        return abi.encodeFunctionResult(getter, [target]);
      }
      return '0x';
    }
    throw Error(method);
  };
  const legs: readonly [EconomicStateRpcLeg, EconomicStateRpcLeg] = [{ operatorId: 'one', send }, { operatorId: 'two', send }];
  configure(legs);
  return { state, publication, legs, read: () => readMembershipReceipt(tx, state.pool) };
}
export { a, h, pointer, code, runtimeHash, tx, blockHash, old, next, manifest };
