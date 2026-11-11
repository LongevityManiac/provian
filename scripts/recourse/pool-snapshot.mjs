import { AbiCoder, Interface, ZeroHash, ZeroAddress, keccak256, sha256 } from 'ethers';
import { merkle } from './snapshot.mjs';
const coder=AbiCoder.defaultAbiCoder();
const enrollment='tuple(bool joined,uint256 startMonth,uint256 lastAssessedMonth,uint256 firstUnpaidMonth,uint256 endMonthExclusive,uint256 generation)';
const invoice='tuple(bool initialized,bool earnings,uint256 burnDue,uint256 reserveDue,uint256 burnPaid,uint256 reservePaid,uint256 noEarningsAmount,uint16 earningsBps,uint256 earningsRemainder)';
const period='tuple(uint256 startBlock,uint256 endBlock,uint256 startMonth)';
const allocation='tuple(bytes32 identity,uint256 amount,bool withdrawn)';
const rule='tuple(uint256 firstMonth,uint256 participationBurn,uint256 noEarningsContribution,uint16 earningsBps,bytes32 signedRuleHash)';
export const poolRecordTypes=[['uint256','uint256'],['uint256',rule],['bytes32',enrollment,'address','uint256','uint256','bool'],
 ['bytes32','uint256','uint256',invoice],['bytes32','uint256',period],['bytes32',allocation],null,['address','bytes32'],['bytes32','bytes32','bytes32']];
export const poolSnapshotAbi=new Interface([
 'function pvt() view returns(address)','function poolHistoryReady() view returns(bool)',
 ...['allocatedRestorations','accountedBacking','monthlyRuleCount'].map(n=>`function ${n}() view returns(uint256)`),
 `function monthlyRuleAt(uint256) view returns(${rule})`,`function enrollment(bytes32) view returns(${enrollment})`,
 `function obligations(bytes32,uint256,uint256) view returns(${invoice})`,`function membershipPeriods(bytes32,uint256) view returns(${period})`,
 `function restorationAllocations(bytes32) view returns(${allocation})`,
 'function requiresSnapshotRecovery(bytes32) view returns(bool)','function primaryAddress(bytes32) view returns(address)','function recoveryNonce(bytes32) view returns(uint256)',
 'function outcomeRevision(bytes32) view returns(uint256)',
 'function ownerOf(address) view returns(bytes32)','function determined(bytes32) view returns(bool)',
 'function occurrenceDetermined(bytes32,bytes32) view returns(bool)',
 'event AddressBound(bytes32 indexed identity,address indexed account)',
 'event MembershipChanged(bytes32 indexed identity,bool joined,uint256 generation,uint256 month)',
 'event MonthlyObligationRecorded(bytes32 indexed identity,uint256 indexed generation,uint256 indexed month,uint256 burn,uint256 contribution)',
 'event ReserveContributed(bytes32 indexed identity,uint256 amount)',
 'event RestorationAllocated(bytes32 indexed request,bytes32 indexed identity,uint256 requested,uint256 assigned)',
 'event RestorationDetermined(bytes32 indexed request,bytes32 indexed identity,bytes32 indexed occurrence,bool accepted,uint256 shortfall,bytes32 evidenceHash,uint256 revision)',
 'event PoolStateImported(uint8 indexed kind,bytes32 indexed slot,bytes32 leaf,bytes data)',
]);
export const poolStateLeaf=(pool,block,kind,data)=>sha256(coder.encode(['string','address','uint256','uint8','bytes32'],['Provian pool succession',pool,block,kind,sha256(data)]));
function ensure(ok,error){if(!ok)throw Error(error);}
/** Enumerate keys from complete immutable event history, then read every value
 * at the same canonical block as the token custody snapshot. Imported histories
 * emit their encoded records, so a later succession needs no private database. */
export async function buildPoolSnapshot({port,pool,kernel,block,blockHash,deploymentBlock,expectedRuntimeHash}){
 ensure(Number.isSafeInteger(deploymentBlock)&&deploymentBlock>0&&deploymentBlock<=block,'pool_snapshot_boundary');
 ensure(/^0x[0-9a-f]{64}$/.test(expectedRuntimeHash),'pool_snapshot_runtime_pin');
 ensure(await port.code(pool,await port.blockHash(deploymentBlock-1))==='0x'
  &&keccak256(await port.code(pool,await port.blockHash(deploymentBlock)))===expectedRuntimeHash
  &&keccak256(await port.code(pool,blockHash))===expectedRuntimeHash,'pool_snapshot_runtime');
 const read=async(name,args=[])=>poolSnapshotAbi.decodeFunctionResult(name,await port.call(pool,poolSnapshotAbi.encodeFunctionData(name,args),blockHash))[0];
 ensure((await read('pvt')).toLowerCase()===kernel.toLowerCase()&&await read('poolHistoryReady'),'pool_snapshot_not_ready');
 const owners=new Set(),accounts=new Map(),invoices=new Map(),periods=new Map(),allocations=new Set(),fences=new Map();
 const key=(...xs)=>xs.join(':');
 function include(kind,v){
  if(kind===2)owners.add(v[0]);
  if(kind===3)invoices.set(key(...v.slice(0,3)),v.slice(0,3));
  if(kind===4)periods.set(key(v[0],v[1]),v.slice(0,2));
  if(kind===5)allocations.add(v[0]);
  if(kind===7){const a=v[0].toLowerCase();ensure(!accounts.has(a)||accounts.get(a)===v[1],'pool_snapshot_address_conflict');accounts.set(a,v[1]);owners.add(v[1]);}
  if(kind===8){ensure(!fences.has(v[0])||key(...fences.get(v[0]))===key(...v),'pool_snapshot_fence_conflict');fences.set(v[0],v);}
 }
 let previous=-1n,eventCount=0;
 for(const log of await port.logs(pool,deploymentBlock,block)){
  const position=BigInt(log.blockNumber)*(1n<<64n)+BigInt(log.logIndex);
  ensure(!log.removed&&log.address.toLowerCase()===pool.toLowerCase()&&BigInt(log.blockNumber)>=BigInt(deploymentBlock)
   &&BigInt(log.blockNumber)<=BigInt(block)&&position>previous,'pool_snapshot_log_domain');previous=position;
  const e=poolSnapshotAbi.parseLog(log);if(!e)continue;++eventCount;
  const a=e.args;
  if(e.name==='PoolStateImported'){
   const kind=Number(a.kind);ensure(kind<poolRecordTypes.length&&poolRecordTypes[kind]!==null,'pool_snapshot_import_kind');
   include(kind,Array.from(coder.decode(poolRecordTypes[kind],a.data)));
  }else if(e.name==='AddressBound')include(7,[a.account,a.identity]);
  else if(e.name==='MonthlyObligationRecorded')include(3,[a.identity,a.generation,a.month]);
  else if(e.name==='MembershipChanged'){include(4,[a.identity,a.generation]);if(a.joined)include(3,[a.identity,a.generation,a.month]);}
  else if(e.name==='RestorationAllocated')include(5,[a.request]);
  else if(e.name==='RestorationDetermined')include(8,[a.request,a.identity,a.occurrence]);
 }
 const entries=[];const append=(kind,v)=>{const data=coder.encode(poolRecordTypes[kind],v);entries.push({kind,data,leaf:poolStateLeaf(pool,block,kind,data)});};
 const globals=await Promise.all(['allocatedRestorations','accountedBacking'].map(n=>read(n)));append(0,globals);
 const ruleCount=await read('monthlyRuleCount');ensure(ruleCount>0n,'pool_snapshot_missing_rules');
 for(let i=0n;i<ruleCount;i++)append(1,[i,await read('monthlyRuleAt',[i])]);
 for(const id of [...owners].sort()){
  ensure(id!==ZeroHash,'pool_snapshot_zero_owner');
  const e=await read('enrollment',[id]);const primary=await read('primaryAddress',[id]);
  // An unrestored break owner intentionally has no primary yet; its lock carries
  // through the next break. Ordinary succession must preserve that lock too.
  ensure(primary===ZeroAddress||accounts.get(primary.toLowerCase())===id,'pool_snapshot_primary_missing');
  append(2,[id,e,primary,await read('recoveryNonce',[id]),await read('outcomeRevision',[id]),await read('requiresSnapshotRecovery',[id])]);
 }
 for(const args of [...invoices.values()].sort((a,b)=>key(...a).localeCompare(key(...b)))){
  ensure(owners.has(args[0]),'pool_snapshot_orphan');const o=await read('obligations',args);ensure(o.initialized,'pool_snapshot_invoice_missing');append(3,[...args,o]);
 }
 for(const args of [...periods.values()].sort((a,b)=>key(...a).localeCompare(key(...b)))){
  ensure(owners.has(args[0]),'pool_snapshot_orphan');append(4,[...args,await read('membershipPeriods',args)]);
 }
 let allocated=0n;
 for(const request of [...allocations].sort()){
  const a=await read('restorationAllocations',[request]);ensure(owners.has(a.identity),'pool_snapshot_orphan');
  if(!a.withdrawn)allocated+=a.amount;append(5,[request,a]);
 }
 for(const [account,id] of [...accounts].sort(([a],[b])=>a.localeCompare(b))){ensure(await read('ownerOf',[account])===id,'pool_snapshot_binding_mismatch');append(7,[account,id]);}
 for(const [request,id,occurrence] of [...fences.values()].sort((a,b)=>a[0].localeCompare(b[0]))){
  ensure(owners.has(id)&&await read('determined',[request])&&await read('occurrenceDetermined',[id,occurrence]),'pool_snapshot_fence_missing');append(8,[request,id,occurrence]);
 }
 ensure(allocated===globals[0],'pool_snapshot_liability_totals');
 const tokenAbi=new Interface(['function balanceOf(address) view returns(uint256)']);
 const balance=tokenAbi.decodeFunctionResult('balanceOf',await port.call(kernel,tokenAbi.encodeFunctionData('balanceOf',[pool]),blockHash))[0];
 ensure(balance>=globals[0]+globals[1],'pool_snapshot_backing_missing');
 ensure(await port.blockHash(block)===blockHash,'pool_snapshot_reorg');
 const tree=merkle(entries.map(e=>e.leaf));
 return {format:'provian-pool-snapshot',pool,kernel,block,blockHash,root:tree.root,balance:balance.toString(),
  entries:entries.map((e,i)=>({...e,proof:tree.proofs[i]})),counts:{events:eventCount,owners:owners.size,entries:entries.length}};
}
