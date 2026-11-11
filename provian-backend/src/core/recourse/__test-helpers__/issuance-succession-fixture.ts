import { Interface } from 'ethers';
import { a,h,old,next,pointer,manifest,runtimeHash } from './membership-receipt-fixture';
import { getOperatorBoundRpcLegs } from '../../onchain/rpc-provider';
import { getAgreedBaseLogs } from '../../onchain/economic-discovery';
import { resolveHistoricalProtocolDeployment } from '../../protocol/pointer';
import { createRecourseChainPort } from '../chain-ledger';
import { findMembershipSuccessionCheckpoint } from '../membership-succession-checkpoint';
import { RECOURSE_POOL_ABI } from '../pool-abi';
const abi = new Interface(['function retired(address) view returns(bool)', 'function ownerAuthorization() view returns(address)',
  'function kernel() view returns(address)', 'function predecessor() view returns(address)', 'function lastGoodBlock() view returns(uint256)',
  'function cryptographicBreak() view returns(bool)',
  'function getBatchRecord(bytes32) view returns((bool settled,uint8 lane,uint64 epoch,uint256 finalizedCursorStart,uint256 finalizedCursorEnd,bytes32 policyHash,bytes32 claimsHash,bytes32 settlementDigest,uint256 grossInput,uint256 totalMinted,uint256 contributorTotal,uint256 provianTotal,uint256 foundationTotal,uint256 recipientCount,uint256 claimCount))']);
const publicationAbi = new Interface(['event DeploymentChanged(uint256 indexed revision,bytes32 indexed manifestHash,address[10] components,bytes32[10] runtimeHashes)']);
export function issuanceSuccessionFixture() {
  const state = { retired:true, settled:false, cancelled:false, lateSettlement:false, afterBreak:true, current:false, reorg:false,
    publication:true, activation:true, premature:false, disagreement:false, cutoff:100, final:120,
    oldLogs:[] as { address:string;blockNumber:number;blockHash:string;transactionHash:string;logIndex:number;removed:boolean;data:string;topics:readonly string[] }[],
    beforeFinalRead: null as (() => void) | null };
  (findMembershipSuccessionCheckpoint as jest.Mock).mockImplementation(async () => state.current ? null : ({
    cutoff:{ kernel:old[0],pool:old[8],block:state.cutoff,blockHash:h(state.cutoff) },successor:{ kernel:next[0],pool:next[8],block:120,blockHash:h(120) } }));
  (createRecourseChainPort as jest.Mock).mockReturnValue({ finalizedBlock:async () => state.final,blockHash:async (n:number) => state.reorg && n===120 ? h(121) : h(n) });
  (resolveHistoricalProtocolDeployment as jest.Mock).mockImplementation(async (_r,_p,_h,n:number) => {
    const targets = n === 120 ? next : old, revision = n === 120 ? 2 : 1;
    return { pointer,revision:BigInt(revision),manifestHash:manifest(revision,targets),addresses:{ kernel:targets[0],recoursePool:targets[8] } };
  });
  (getAgreedBaseLogs as jest.Mock).mockImplementation(async ({ address,fromBlock,toBlock }) => {
    if (address === old[8]) return state.oldLogs;
    const publication = { address:pointer,blockNumber:110,blockHash:h(110),logIndex:4,transactionHash:h(800),removed:false,
      ...publicationAbi.encodeEventLog(publicationAbi.getEvent('DeploymentChanged')!,[2,manifest(2,next),next,next.map(()=>runtimeHash)]) };
    const activation = { address:next[8],blockNumber:110,blockHash:h(110),logIndex:state.premature ? 5 : 3,transactionHash:h(800),removed:false,
      ...RECOURSE_POOL_ABI.encodeEventLog(RECOURSE_POOL_ABI.getEvent('PoolHistoryActivated')!,[h(7),4]) };
    return (address === pointer ? state.publication ? [publication] : [] : state.activation ? [activation] : [])
      .filter(l => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
  });
  (getOperatorBoundRpcLegs as jest.Mock).mockReturnValue([0,1].map(index => ({ operatorId:`operator-${index}`,provider:{
    send:async (method:string,params:readonly unknown[]) => {
      if (method !== 'eth_call') throw Error('unexpected RPC');
      const call = params[0] as { to:string;data:string }, contract = [old[8],next[8]].includes(call.to) ? RECOURSE_POOL_ABI : abi;
      const name = contract.parseTransaction({ data:call.data })!.name;
      let values:readonly unknown[];
      if (name === 'retired') values = [state.retired && !(index===1 && state.disagreement)];
      else if (name === 'poolSnapshot') values = [old[8],state.cutoff,h(7),4,state.afterBreak];
      else if (name === 'poolHistoryReady') values = [true];
      else if (name === 'token' || name === 'kernel') values = [next[0]];
      else if (name === 'ownerAuthorization') values = [a(999)];
      else if (name === 'predecessor') values = [old[0]];
      else if (name === 'lastGoodBlock') values = [state.cutoff];
      else if (name === 'cryptographicBreak') values = [state.afterBreak];
      else if (name === 'getBatchRecord') values = [[state.settled || (state.lateSettlement && (params[1] as {blockHash:string}).blockHash===h(120)),0,1,0,2,h(601),h(604),h(602),200,199,198,1,0,2,2]];
      else if (name === 'cancelledIssuanceBatch') { values = [state.cancelled];if(index===1)state.beforeFinalRead?.(); }
      else throw Error(name);
      return contract.encodeFunctionResult(name,values);
    },
  } })));
  return state;
}
