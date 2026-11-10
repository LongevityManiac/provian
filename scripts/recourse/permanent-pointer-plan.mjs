import { readFileSync } from 'node:fs';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Interface,getCreate2Address,keccak256,sha256,toUtf8Bytes,zeroPadValue } from 'ethers';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export const POINTER_CREATE2_FACTORY='0x4e59b44847b379578588920cA78FbF26c0B4956C';
// Exact deployed factory instructions: copy calldata after its first32 bytes,
// CREATE2 with that salt and forwarded value, revert on failure, return address.
export const POINTER_CREATE2_FACTORY_CODE='0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3';
export const POINTER_CREATE2_FACTORY_HASH=keccak256(POINTER_CREATE2_FACTORY_CODE);
function artifact(name){
  const value=JSON.parse(readFileSync(resolve(root,`contracts/out/${name}.sol/${name}.json`),'utf8'));
  for(const [path,source]of Object.entries(value.metadata.sources)){
    if(keccak256(readFileSync(resolve(root,'contracts',path)))!==source.keccak256)throw Error(`pointer_plan_stale_artifact:${name}`);
  }
  if(Object.keys(value.bytecode.linkReferences??{}).length||Object.keys(value.deployedBytecode.linkReferences??{}).length)throw Error('pointer_plan_unlinked_artifact');
  return value;
}
/** Immutable substitution is compiler-indexed. Never search/replace coincidental
 * zero words or assume an offset copied from a previous compilation. */
export function pointerRuntime(compiled,authority){
  const entries=Object.values(compiled.deployedBytecode.immutableReferences??{});
  if(entries.length!==1||entries[0].length===0)throw Error('pointer_plan_immutable_layout_changed');
  let runtime=compiled.deployedBytecode.object;
  const replacement=zeroPadValue(authority,32).slice(2).toLowerCase(),seen=new Set();
  for(const entry of entries[0]){
    const {start,length}=entry;
    if(!Number.isSafeInteger(start)||start<0||length!==32||2+(start+length)*2>runtime.length||seen.has(start))throw Error('pointer_plan_immutable_layout_changed');
    seen.add(start);const offset=2+start*2;
    if(runtime.slice(offset,offset+64)!=='0'.repeat(64))throw Error('pointer_plan_immutable_not_placeholder');
    runtime=runtime.slice(0,offset)+replacement+runtime.slice(offset+64);
  }
  return runtime;
}
/** This is a deployment specification only. Its CREATE2 addresses are fixed by
 * source, compiler bytes, salt and the public root, independent of gas-payer
 * nonces. Publishing a pin does not make an undeployed manifest usable. */
export function permanentPointerPlan(initialRoot){
  if(!/^0x[0-9a-f]{64}$/.test(initialRoot)||/^0x0+$/.test(initialRoot))throw Error('pointer_plan_root_invalid');
  const account=artifact('ProvianHashAccount'),pointer=artifact('ProvianProtocolPointer');
  const accountSalt=sha256(toUtf8Bytes('Provian permanent protocol pointer authority'));
  const accountInit=account.bytecode.object+new Interface(account.abi).encodeDeploy([initialRoot]).slice(2);
  const authority=getCreate2Address(POINTER_CREATE2_FACTORY,accountSalt,keccak256(accountInit)).toLowerCase();
  const pointerSalt=sha256(toUtf8Bytes('Provian permanent protocol pointer'));
  const pointerInit=pointer.bytecode.object+new Interface(pointer.abi).encodeDeploy([authority]).slice(2);
  const address=getCreate2Address(POINTER_CREATE2_FACTORY,pointerSalt,keccak256(pointerInit)).toLowerCase();
  const runtime=pointerRuntime(pointer,authority);
  return {schema:'provian.permanent-pointer-plan.v1',chainId:8453,factory:POINTER_CREATE2_FACTORY.toLowerCase(),factoryRuntimeHash:POINTER_CREATE2_FACTORY_HASH,
    initialRoot,authority,pointer:address,pointerRuntimeHash:keccak256(runtime),
    transactions:[{label:'pointer-authority',to:POINTER_CREATE2_FACTORY.toLowerCase(),value:'0',data:accountSalt+accountInit.slice(2),
      address:authority,runtimeHash:keccak256(account.deployedBytecode.object)},
    {label:'permanent-pointer',to:POINTER_CREATE2_FACTORY.toLowerCase(),value:'0',data:pointerSalt+pointerInit.slice(2),address,runtimeHash:keccak256(runtime)}]};
}
/** Both operator-bound providers must agree at a canonical finalized block. */
export async function verifyPermanentPointerPlan(plan,port){
  if(JSON.stringify(plan)!==JSON.stringify(permanentPointerPlan(plan.initialRoot)))throw Error('pointer_plan_changed');
  const block=await port.finalizedBlock();
  if(await port.code(plan.factory,block.hash)!==POINTER_CREATE2_FACTORY_CODE)throw Error('pointer_plan_factory_mismatch');
  const states=[];
  for(const transaction of plan.transactions){
    const code=await port.code(transaction.address,block.hash);
    if(code!=='0x'&&keccak256(code)!==transaction.runtimeHash)throw Error('pointer_plan_address_occupied');
    states.push(code==='0x'?'undeployed':'deployed');
  }
  if(states[0]==='undeployed'&&states[1]==='deployed')throw Error('pointer_plan_deployment_order');
  if(states[0]==='deployed'){
    const abi=new Interface(['function keyCommitment() view returns(bytes32)','function nonce() view returns(uint256)']);
    const key=abi.decodeFunctionResult('keyCommitment',await port.call(plan.authority,abi.encodeFunctionData('keyCommitment'),block.hash))[0];
    const nonce=abi.decodeFunctionResult('nonce',await port.call(plan.authority,abi.encodeFunctionData('nonce'),block.hash))[0];
    if(key!==plan.initialRoot||nonce!==0n)throw Error('pointer_plan_authority_already_used');
  }
  if(states[1]==='deployed'){
    const abi=new Interface(['function authority() view returns(address)','function revision() view returns(uint256)']);
    if(String(abi.decodeFunctionResult('authority',await port.call(plan.pointer,abi.encodeFunctionData('authority'),block.hash))[0]).toLowerCase()!==plan.authority
      ||abi.decodeFunctionResult('revision',await port.call(plan.pointer,abi.encodeFunctionData('revision'),block.hash))[0]!==0n)throw Error('pointer_plan_already_published');
  }
  if(await port.blockHash(block.number)!==block.hash)throw Error('pointer_plan_reorg');
  return {block,states};
}
