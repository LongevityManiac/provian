import { AbiCoder, Interface, ZeroAddress, ZeroHash, getAddress, keccak256, sha256 } from 'ethers';
import { merkle } from './snapshot.mjs';
const coder = AbiCoder.defaultAbiCoder();
const kernelAbi = new Interface(['function protocolPointer() view returns(address)', 'function registryOperator() view returns(address)', 'function ownerAuthorization() view returns(address)',
  'function balanceOf(address) view returns(uint256)', 'function totalSupply() view returns(uint256)']);
const registryAbi = new Interface(['function previousRegistry() view returns(address)', 'function pointer() view returns(address)', 'function ownerOf(address) view returns(bytes32)', 'function boundBlock(address) view returns(uint256)',
  'event OwnershipBound(bytes32 indexed identity,address indexed account,address indexed kernel,bytes32 recoveryCommitment,bytes32 signingRoot,bytes32 digest)',
  'event RecoveredAddressBound(bytes32 indexed identity,address indexed account,address indexed kernel)']);
const ownerAbi = new Interface(['function ownerRecoveryCommitment(bytes32) view returns(bytes32)', 'function ownerSigningRoot(bytes32) view returns(bytes32)',
  'function previousAuthorization() view returns(address)', 'function kernel() view returns(address)',
  'function reversalEvidence(bytes32) view returns(tuple(bytes32 identity,uint256 shortfall,bytes32 evidenceHash))',
  'function reversalExecuted(bytes32) view returns(bool)',
  'function restorationIntent(bytes32) view returns(tuple(bytes32 request,bytes32 identity,address destination,bytes32 lossHash,uint256 maximumLoss))',
  'event RestorationIntentAuthorized(bytes32 indexed request,bytes32 indexed identity,address indexed destination,bytes32 lossHash,uint256 maximumLoss,bytes32 intentHash)',
  'event RestorationIntentImported(bytes32 indexed request,bytes32 indexed identity,address indexed destination,bytes32 lossHash,uint256 maximumLoss)',
  'event TheftReversed(bytes32 indexed request,bytes32 indexed identity,address indexed destination,uint256 amount,bytes32 evidenceHash)',
  'event ReversalHistoryImported(bytes32 indexed request,bytes32 indexed identity,uint256 shortfall,bytes32 evidenceHash)']);
const pointerAbi = new Interface(['function current() view returns(uint256,bytes32,address[10],bytes32[10])']);
const pvtAbi = new Interface(['function pvt() view returns(address)']);
const hash = /^0x[0-9a-f]{64}$/;
function ensure(ok, reason) { if (!ok) throw Error(reason); }
export const breakOwnerLeaf = (predecessor, block, identity, amount, commitment) => sha256(coder.encode(
  ['string','address','uint256','bytes32','uint256','bytes32'], ['Provian restoration',predecessor,block,identity,amount,commitment]));
export const breakInstitutionLeaf = (predecessor, block, previousInstitution, destination, amount, runtimeHash) => sha256(coder.encode(
  ['string','address','uint256','address','address','uint256','bytes32'],
  ['Provian institution restoration',predecessor,block,previousInstitution,destination,amount,runtimeHash]));
/** A last-good block is explicitly selected by the hash-authorized successor
 * publisher. It need not contain a shutdown transaction made after the break.
 * No curve signature, relay database flag or claimant list supplies ownership.
 * Institution destinations are deployment-plan inputs committed by the root;
 * their runtime hashes and liability reconciliation must precede publication. */
export async function buildBreakOwnershipSnapshot({ port, predecessor, block, blockHash, expectedKernelRuntimeHash,
  registryDeploymentBlock, expectedRegistryRuntimeHash, institutions, pendingBreak = null }) {
  predecessor = getAddress(predecessor);
  ensure(Number.isSafeInteger(block) && block > 0 && hash.test(blockHash), 'break_snapshot_block_invalid');
  ensure(Number.isSafeInteger(registryDeploymentBlock) && registryDeploymentBlock > 0 && registryDeploymentBlock <= block,
    'break_snapshot_registry_boundary_invalid');
  ensure(hash.test(expectedKernelRuntimeHash) && hash.test(expectedRegistryRuntimeHash), 'break_snapshot_runtime_pin_required');
  const call = async (target, abi, method, args=[]) => abi.decodeFunctionResult(method,
    await port.call(target,abi.encodeFunctionData(method,args),blockHash))[0];
  ensure(keccak256(await port.code(predecessor,blockHash)) === expectedKernelRuntimeHash, 'break_snapshot_kernel_mismatch');
  const registry = getAddress(await call(predecessor,kernelAbi,'registryOperator'));
  const authorization = getAddress(await call(predecessor,kernelAbi,'ownerAuthorization'));
  ensure(registry !== ZeroAddress && authorization !== ZeroAddress, 'break_snapshot_missing_registry');
  ensure(await port.code(registry,await port.blockHash(registryDeploymentBlock-1)) === '0x'
    && keccak256(await port.code(registry,await port.blockHash(registryDeploymentBlock))) === expectedRegistryRuntimeHash
    && keccak256(await port.code(registry,blockHash)) === expectedRegistryRuntimeHash,'break_snapshot_registry_mismatch');
  const pointer = getAddress(await call(predecessor,kernelAbi,'protocolPointer'));
  const current = pointerAbi.decodeFunctionResult('current',await port.call(pointer,pointerAbi.encodeFunctionData('current'),blockHash));
  ensure(String(current[2][0]).toLowerCase()===predecessor.toLowerCase(),'break_snapshot_not_current_at_cutoff');
  const required = new Set(current[2].slice(3,9).map(a=>String(a).toLowerCase()));
  ensure(required.size===6&&!required.has(ZeroAddress),'break_snapshot_institution_manifest_invalid');
  const custody = new Map(); const destinations = new Set();
  ensure(Array.isArray(institutions) && institutions.length === required.size,'break_snapshot_institutions_required');
  for (const item of institutions) {
    const source=getAddress(item.source).toLowerCase(),destination=getAddress(item.destination).toLowerCase();
    ensure(source !== destination && source !== ZeroAddress && destination !== ZeroAddress && hash.test(item.runtimeHash)
      && required.has(source) && !custody.has(source) && !destinations.has(destination),'break_snapshot_institution_invalid');
    ensure(String(await call(source,pvtAbi,'pvt')).toLowerCase() === predecessor.toLowerCase(),'break_snapshot_institution_token');
    custody.set(source,{destination,runtimeHash:item.runtimeHash});destinations.add(destination);
  }
  ensure([...destinations].every(a=>!custody.has(a)),'break_snapshot_retired_destination');
  const accounts = new Map(); let bindingEvents=0;
  const registries=new Set();let currentRegistry=registry;
  while(currentRegistry!==ZeroAddress){
   ensure(!registries.has(currentRegistry.toLowerCase()),'break_snapshot_registry_cycle');registries.add(currentRegistry.toLowerCase());
   ensure(String(await call(currentRegistry,registryAbi,'pointer')).toLowerCase()===pointer.toLowerCase(),'break_snapshot_registry_pointer');
   let last=-1n;
   const from=currentRegistry.toLowerCase()===registry.toLowerCase()?registryDeploymentBlock:0;
   for (const log of await port.logs(currentRegistry,from,block)) {
    ensure(!log.removed && log.address.toLowerCase() === currentRegistry.toLowerCase()
      && BigInt(log.blockNumber)>=BigInt(from) && BigInt(log.blockNumber)<=BigInt(block),'break_snapshot_log_domain');
    const position=BigInt(log.blockNumber)*(1n<<64n)+BigInt(log.logIndex);
    ensure(position>last,'break_snapshot_log_order');last=position;
    const event=registryAbi.parseLog(log);
    // Other registry events do not create ownership.
    if (!event || !['OwnershipBound','RecoveredAddressBound'].includes(event.name)) continue;
    ++bindingEvents;
    const account=event.args.account.toLowerCase(),identity=event.args.identity;
    ensure(identity!==ZeroHash && account!==ZeroAddress && !custody.has(account),'break_snapshot_owner_invalid');
    ensure(!accounts.has(account)||accounts.get(account)===identity,'break_snapshot_owner_conflict');
    accounts.set(account,identity);
   }
   currentRegistry=await call(currentRegistry,registryAbi,'previousRegistry');
  }
  ensure((bindingEvents>0 && accounts.size>0)||pendingBreak?.owners?.length>0,'break_snapshot_empty_ownership');
  const owners=new Map();
  for (const [account,identity] of [...accounts].sort(([a],[b])=>a.localeCompare(b))) {
    ensure(await call(registry,registryAbi,'ownerOf',[account])===identity,'break_snapshot_owner_state_mismatch');
    const bound=await call(registry,registryAbi,'boundBlock',[account]);
    ensure(bound>0n&&bound<=BigInt(block),'break_snapshot_binding_future');
    const amount=await call(predecessor,kernelAbi,'balanceOf',[account]);
    const owner=owners.get(identity)??{identity,amount:0n,accounts:[]};owner.amount+=amount;owner.accounts.push({account,amount:amount.toString()});owners.set(identity,owner);
  }
  const carried=new Map((pendingBreak?.owners??[]).map(e=>[e.identity,e]));
  for(const e of carried.values())if(!owners.has(e.identity))owners.set(e.identity,{identity:e.identity,amount:0n,accounts:[]});
  const entries=[];let boundTotal=0n,institutionTotal=0n,carriedTotal=0n;
  for (const owner of [...owners.values()].sort((a,b)=>a.identity.localeCompare(b.identity))) {
    const pending=carried.get(owner.identity);
    let commitment=await call(authorization,ownerAbi,'ownerRecoveryCommitment',[owner.identity]);
    let signingRoot=await call(authorization,ownerAbi,'ownerSigningRoot',[owner.identity]);
    if(pending){
      ensure(commitment===ZeroHash||commitment===pending.commitment,'break_snapshot_pending_commitment_mismatch');
      commitment=pending.commitment;signingRoot=pending.signingRoot;
      const amount=BigInt(pending.amount);owner.amount+=amount;carriedTotal+=amount;
    }
    ensure(hash.test(commitment)&&commitment!==ZeroHash&&hash.test(signingRoot)&&signingRoot!==ZeroHash,'break_snapshot_commitment_missing');
    boundTotal+=owner.amount;
    entries.push({kind:'owner',...owner,amount:owner.amount.toString(),commitment,signingRoot,
      leaf:breakOwnerLeaf(predecessor,block,owner.identity,owner.amount,commitment)});
  }
  for (const [source,item] of custody) {
    const amount=await call(predecessor,kernelAbi,'balanceOf',[source]);institutionTotal+=amount;
    if(amount===0n)continue;
    entries.push({kind:'institution',source,...item,amount:amount.toString(),
      leaf:breakInstitutionLeaf(predecessor,block,source,item.destination,amount,item.runtimeHash)});
  }
  const institutionCount=entries.filter(e=>e.kind==='institution').length;
  entries.push({kind:'institution-count',count:institutionCount,amount:institutionTotal.toString(),
    leaf:sha256(coder.encode(['string','address','uint256','uint256','uint256'],
      ['Provian institution restoration count',predecessor,block,institutionCount,institutionTotal]))});
  const requests=new Set(), intents=new Set(), executors=new Set();
  let historicalAuthorization=authorization;
  while(historicalAuthorization!==ZeroAddress){
    const key=historicalAuthorization.toLowerCase();
    ensure(!executors.has(key),'break_snapshot_executor_cycle');executors.add(key);
    const sourceKernel=await call(historicalAuthorization,ownerAbi,'kernel');
    ensure(String(await call(sourceKernel,kernelAbi,'ownerAuthorization')).toLowerCase()===key,'break_snapshot_executor_domain');
    let priorPosition=-1n;
    // Read the complete executor history, including inherited break imports.
    for(const log of await port.logs(historicalAuthorization,0,block)){
      const position=BigInt(log.blockNumber)*(1n<<64n)+BigInt(log.logIndex);
      ensure(!log.removed&&log.address.toLowerCase()===key&&BigInt(log.blockNumber)<=BigInt(block)
        &&position>priorPosition,'break_snapshot_reversal_log_domain');priorPosition=position;
      const event=ownerAbi.parseLog(log);if(!event)continue;
      if(event.name==='RestorationIntentAuthorized'||event.name==='RestorationIntentImported')intents.add(event.args.request);
      else requests.add(event.args.request);
    }
    historicalAuthorization=await call(historicalAuthorization,ownerAbi,'previousAuthorization');
  }
  for(const request of [...requests].sort()){
    const e=await call(authorization,ownerAbi,'reversalEvidence',[request]);
    ensure(request!==ZeroHash&&owners.has(e.identity)&&e.evidenceHash!==ZeroHash
      &&await call(authorization,ownerAbi,'reversalExecuted',[request]),'break_snapshot_reversal_missing');
    const leaf=sha256(coder.encode(['string','address','uint256','bytes32','bytes32','uint256','bytes32'],
      ['Provian reversal history',predecessor,block,request,e.identity,e.shortfall,e.evidenceHash]));
    entries.push({kind:'reversal',request,identity:e.identity,shortfall:e.shortfall.toString(),evidenceHash:e.evidenceHash,leaf});
  }
  let pendingIntents=0;
  for(const request of [...intents].sort()){
    if(requests.has(request))continue;
    const intent=await call(authorization,ownerAbi,'restorationIntent',[request]);
    ensure(intent.request===request&&request!==ZeroHash&&owners.has(intent.identity)&&intent.destination!==ZeroAddress
      &&intent.lossHash!==ZeroHash&&intent.maximumLoss>0n&&!await call(authorization,ownerAbi,'reversalExecuted',[request]),
      'break_snapshot_intent_missing');
    const tuple=[request,intent.identity,intent.destination,intent.lossHash,intent.maximumLoss];
    const leaf=sha256(coder.encode(['string','address','uint256','tuple(bytes32,bytes32,address,bytes32,uint256)'],
      ['Provian pending restoration intent',predecessor,block,tuple]));
    entries.push({kind:'intent',request,identity:intent.identity,destination:intent.destination,lossHash:intent.lossHash,
      maximumLoss:intent.maximumLoss.toString(),leaf});++pendingIntents;
  }
  const historyCount=requests.size+pendingIntents;
  entries.push({kind:'reversal-count',count:historyCount,leaf:sha256(coder.encode(['string','address','uint256','uint256'],
    ['Provian reversal history count',predecessor,block,historyCount]))});
  const supply=await call(predecessor,kernelAbi,'totalSupply');
  ensure(boundTotal+institutionTotal-carriedTotal<=supply,'break_snapshot_excess_restoration');
  const tree=merkle(entries.map(e=>e.leaf));
  ensure(await port.blockHash(block)===blockHash,'break_snapshot_reorg');
  return {format:'provian-break-ownership-snapshot',chainId:8453,predecessor,block,blockHash,registry,authorization,
    root:tree.root,snapshotBalance:(boundTotal+institutionTotal).toString(),boundBalance:boundTotal.toString(),
    institutionalBalance:institutionTotal.toString(),unboundBalance:(supply-boundTotal-institutionTotal+carriedTotal).toString(),carriedBalance:carriedTotal.toString(),
    entries:entries.map((e,i)=>({...e,proof:tree.proofs[i]})),counts:{bindingEvents,accounts:accounts.size,owners:owners.size,institutions:custody.size,reversals:requests.size,pendingIntents}};
}
