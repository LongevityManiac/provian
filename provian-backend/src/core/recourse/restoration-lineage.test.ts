import { Interface } from 'ethers';
import { readRestorationLineage, readMigrationMint } from './restoration-lineage';
import { currentProtocolDeployment } from '../protocol/runtime';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { getAgreedBaseLogs, readAgreedBaseBlockHash, verifyBaseTransactionEvidence } from '../onchain/economic-discovery';
import { fixture,address,hash,token,recipient } from './__test-helpers__/restoration-evidence-fixture';
jest.mock('../protocol/runtime',()=>({currentProtocolDeployment:jest.fn()}));
jest.mock('../onchain/rpc-provider',()=>({getOperatorBoundRpcLegs:jest.fn()}));
jest.mock('../onchain/economic-discovery',()=>({getAgreedBaseLogs:jest.fn(),readAgreedBaseBlockHash:jest.fn(),verifyBaseTransactionEvidence:jest.fn()}));
const kernel=address(77),executor=address(78),previousExecutor=address(79);
const abi=new Interface(['function ownerAuthorization() view returns(address)','function kernel() view returns(address)','function predecessor() view returns(address)',
 'function previousAuthorization() view returns(address)','function lastGoodBlock() view returns(uint256)','function cryptographicBreak() view returns(bool)',
 'function successionReady() view returns(bool)','event BalanceMigrated(address indexed previousOwner,address indexed destination,uint256 amount)',
 'event Transfer(address indexed from,address indexed to,uint256 amount)']);
let wrong=false,broken=false,disagree=false;
beforeEach(()=>{
 jest.resetAllMocks();wrong=false;broken=false;disagree=false;
 (currentProtocolDeployment as jest.Mock).mockResolvedValue({addresses:{kernel},blockHash:hash(150),manifestHash:hash(151)});
 (getOperatorBoundRpcLegs as jest.Mock).mockReturnValue([0,1].map(index=>({operatorId:`rpc-${index}`,provider:{send:async(_method:string,params:readonly unknown[])=>{
  const call=params[0] as {to:string;data:string}; const parsed=abi.parseTransaction({data:call.data})!;
  const values:Record<string,unknown>={ownerAuthorization:call.to===kernel?executor:previousExecutor,kernel,predecessor:token,
    previousAuthorization:wrong?address(99):previousExecutor,lastGoodBlock:disagree&&index===1?106:105,cryptographicBreak:broken,successionReady:true};
  return abi.encodeFunctionResult(parsed.name,[values[parsed.name]]);
 }}})));
 (readAgreedBaseBlockHash as jest.Mock).mockImplementation(async n=>hash(n));
});
test('current pointer authenticates ordinary executor ancestry and refuses independent disagreements or substituted ancestors',async()=>{
 expect(await readRestorationLineage(token)).toMatchObject({kernel,executor,migrations:[{kernel,executor,predecessor:token,cutoff:105}]});
 wrong=true;await expect(readRestorationLineage(token)).rejects.toThrow('lineage_invalid');
 wrong=false;broken=true;await expect(readRestorationLineage(token)).rejects.toThrow('lineage_invalid');
 broken=false;disagree=true;await expect(readRestorationLineage(token)).rejects.toThrow('rpc_disagreement');
});
test('a balance bridge requires the exact canonical migration and matching adjacent mint, including destination and amount',async()=>{
 const f=fixture(),migration={kernel,executor,predecessor:token,cutoff:105};
 const migrationEvent=abi.encodeEventLog(abi.getEvent('BalanceMigrated')!,[recipient,recipient,100]);
 const transfer=abi.encodeEventLog(abi.getEvent('Transfer')!,[address(0),recipient,100]);
 const log={...migrationEvent,address:executor,blockNumber:111,blockHash:hash(111),transactionHash:hash(1111),logIndex:5,removed:false};
 (getAgreedBaseLogs as jest.Mock).mockResolvedValue([log]);
 (verifyBaseTransactionEvidence as jest.Mock).mockResolvedValue({blockHash:hash(111),evidenceHash:hash(555),logs:[{...log,...transfer,address:kernel,logIndex:4}]});
 expect(await readMigrationMint(migration,recipient,120,f.port.chain)).toEqual({mintId:`${hash(1111)}:4`,succession:null});
 (getAgreedBaseLogs as jest.Mock).mockResolvedValue([{...log,...abi.encodeEventLog(abi.getEvent('BalanceMigrated')!,[recipient,address(99),100])}]);
 await expect(readMigrationMint(migration,recipient,120,f.port.chain)).rejects.toThrow('mint_mismatch');
 (verifyBaseTransactionEvidence as jest.Mock).mockResolvedValue({blockHash:hash(111),evidenceHash:hash(555),logs:[{
   ...log,...abi.encodeEventLog(abi.getEvent('Transfer')!,[address(0),address(99),100]),address:kernel,logIndex:4}]});
 expect(await readMigrationMint(migration,recipient,120,f.port.chain)).toEqual({mintId:`${hash(1111)}:4`,succession:{
   block:111,blockHash:hash(111),transactionHash:hash(1111),logIndex:5,from:recipient,to:address(99),amountAtomic:'100',receipt:'custody_succession',witnessHash:hash(555)}});
 (getAgreedBaseLogs as jest.Mock).mockResolvedValue([log]);
 (verifyBaseTransactionEvidence as jest.Mock).mockResolvedValue({blockHash:hash(111),logs:[{...log,...abi.encodeEventLog(abi.getEvent('Transfer')!,[address(0),recipient,101]),address:kernel,logIndex:4}]});
 await expect(readMigrationMint(migration,recipient,120,f.port.chain)).rejects.toThrow('mint_mismatch');
});
