import { Interface, keccak256, sha256, toUtf8Bytes, ZeroAddress } from 'ethers';

export const LEGACY_INSTITUTIONS = Object.freeze({ escrowV4:'ProvianEscrowV4', promiseV3:'ProvianPromiseV3',
  poolV3:'ProvianPoolV3', bondPool:'ProvianBondPool', courtV2:'ProvianCourtV2' });
const normalize = value => typeof value==='bigint'?value.toString():Array.isArray(value)?value.map(normalize):value;
const ensure=(condition,message)=>{if(!condition)throw Error(`institution_snapshot_${message}`);};
const tokenAbi=new Interface(['function balanceOf(address) view returns(uint256)']);
const lower=value=>String(value).toLowerCase();
export function verifyInstitutionRuntime(compiled,runtime){
  let masked=runtime;
  ensure(/^0x[0-9a-f]+$/i.test(runtime)&&runtime.length===compiled.deployedBytecode.object.length,'runtime_mismatch');
  for(const entries of Object.values(compiled.deployedBytecode.immutableReferences??{}))for(const {start,length}of entries){
    const offset=2+start*2;
    ensure(Number.isSafeInteger(start)&&start>=0&&length===32&&offset+64<=runtime.length,'immutable_layout');
    ensure(compiled.deployedBytecode.object.slice(offset,offset+64)==='0'.repeat(64),'immutable_layout');
    masked=masked.slice(0,offset)+'0'.repeat(64)+masked.slice(offset+64);
  }
  // Hardhat and Forge use different source-unit paths in their IPFS metadata.
  // Accept only the known 53-byte CBOR layout and mask its 32-byte IPFS digest;
  // retain every preceding byte, the exact compiler version and every instruction.
  const metadata=/a2646970667358221220([0-9a-f]{64})64736f6c6343([0-9a-f]{6})0033$/i;
  const canonical=value=>value.replace(metadata,(_all,_digest,version)=>
    'a2646970667358221220'+'0'.repeat(64)+'64736f6c6343'+version+'0033');
  ensure(canonical(masked).toLowerCase()===canonical(compiled.deployedBytecode.object).toLowerCase(),'runtime_mismatch');
  return keccak256(runtime);
}

/** First-changeover inventory. Every read is pinned to the same independently
 * verified block. Unsupported obligations are an explicit refusal, never a
 * zero/default seed. This exporter cannot freeze a contract or move funds. */
export async function buildInstitutionSnapshot({port, deployment, artifacts, block, blockHash}) {
  if(typeof port.withHistoricalSnapshot==='function')return port.withHistoricalSnapshot({block,blockHash},scoped=>
    buildInstitutionSnapshot({port:scoped,deployment,artifacts,block,blockHash}));
  ensure(Number.isSafeInteger(block)&&block>0&&/^0x[0-9a-f]{64}$/.test(blockHash),'block_invalid');
  const inventory=[],seedEscrows=[],seedBonds=[],seedBps=[];
  const sources=Object.keys(LEGACY_INSTITUTIONS).map(key=>deployment.contracts[key]);
  ensure(sources.every(s=>s&&Number.isSafeInteger(s.block)&&s.block>0&&s.block<=block),'deployment_missing');
  const sourceAddresses=sources.map(s=>lower(s.address));
  ensure(new Set(sourceAddresses).size===5,'duplicate_institution');
  // One shared scan avoids requesting the same historical block range five
  // times. Provider agreement remains on the entire returned log population.
  const allRows=await port.logs(sourceAddresses,Math.min(...sources.map(s=>s.block)),block);
  ensure(allRows.every(row=>sourceAddresses.includes(lower(row.address))),'event_domain');
  const tokenBalance=async(token,address)=>tokenAbi.decodeFunctionResult('balanceOf',await port.call(token,
    tokenAbi.encodeFunctionData('balanceOf',[address]),blockHash))[0];
  for(const [key,name]of Object.entries(LEGACY_INSTITUTIONS)){
    const source=deployment.contracts[key],compiled=artifacts[name];
    ensure(source&&Number.isSafeInteger(source.block)&&source.block<=block&&compiled,'deployment_missing');
    const address=lower(source.address),iface=new Interface(compiled.abi),runtime=await port.code(address,blockHash);
    // Compare every compiler instruction; authenticate each immutable address
    // through its getter below instead of comparing zeroed placeholders.
    const expected=verifyInstitutionRuntime(compiled,runtime);
    ensure(await port.code(address,await port.blockHash(source.block-1))==='0x'
      &&keccak256(await port.code(address,await port.blockHash(source.block)))===expected,'deployment_boundary');
    const read=async(method,args=[])=>iface.decodeFunctionResult(method,
      await port.call(address,iface.encodeFunctionData(method,args),blockHash));
    ensure(lower((await read('pvt'))[0])===lower(deployment.wiring.pvt),'kernel_mismatch');
    for(const method of ['epochClock','issuanceIndex'])if(iface.hasFunction(method)){
      ensure(lower((await read(method))[0])===lower(deployment.wiring.pvt),'immutable_wiring');
    }
    ensure(lower((await read('admin'))[0])===lower(deployment.wiring.admin),'admin_changed');
    const pvtBalance=await tokenBalance(deployment.wiring.pvt,address);
    const usdcBalance=await tokenBalance(deployment.wiring.usdc,address);
    ensure(usdcBalance===0n,'usdc_obligation_requires_import');
    const rows=allRows.filter(row=>lower(row.address)===address),events=[];
    let position=-1n;
    for(const row of rows){
      const next=BigInt(row.blockNumber)*(1n<<64n)+BigInt(row.logIndex);
      ensure(!row.removed&&lower(row.address)===address&&BigInt(row.blockNumber)>=BigInt(source.block)
        &&BigInt(row.blockNumber)<=BigInt(block)&&next>position,'event_domain');position=next;
      const event=iface.parseLog(row);ensure(event,'unknown_event');events.push(event);
    }
    // Capture every public zero-argument policy getter, including both active
    // overrides and fallback literals. The deployment verifier compares them
    // after wiring, while address-valued wiring is checked separately.
    const policy=[],wiring=[];
    const expectedWiring={...deployment.wiring,
      courtContract:deployment.contracts.courtV2.address,bondPool:deployment.contracts.bondPool.address,
      escrowContract:deployment.contracts.escrowV4.address};
    for(const fn of iface.fragments.filter(f=>f.type==='function'&&f.stateMutability==='view'&&f.inputs.length===0)){
      const result=await read(fn.name);
      if(fn.outputs.some(o=>o.type==='address')){
        ensure(fn.outputs.length===1&&typeof expectedWiring[fn.name]==='string'
          &&lower(result[0])===lower(expectedWiring[fn.name]),`wiring_mismatch:${fn.name}`);
        wiring.push({method:fn.name,address:lower(result[0])});continue;
      }
      policy.push({method:fn.name,values:normalize(result.toArray())});
    }
    const schedules=[];
    for(const event of events.filter(e=>e.name.endsWith('Scheduled'))){
      const stem=event.name.slice(0,-'Scheduled'.length),method='scheduled'+stem,epoch=event.args.effectiveEpoch;
      ensure(iface.hasFunction(method),'unknown_schedule');
      const value=await read(method,[epoch]);
      ensure(value[0]===true,'schedule_missing');
      schedules.push({method,epoch:epoch.toString(),values:normalize(value.toArray())});
      // The first successor seed format carries only active bond fee/burn
      // overrides. A future schedule cannot silently disappear at cutover.
      const earliest=(await read('earliestSchedulableEpoch'))[0];
      ensure(name==='ProvianBondPool'&&['DepositBurnBps','DepositFeeBps','RenewalBurnBps','RenewalFeeBps'].includes(stem)
        &&epoch<earliest,'schedule_requires_import');
    }
    const allowed=new Set(['CourtContractSet','BondPoolSet','ExecutorWired']);
    for(const event of events)if(event.name.endsWith('Scheduled'))allowed.add(event.name);
    if(name==='ProvianEscrowV4'){
      for(const n of ['EscrowCreated','EscrowCreatedPVT','EscrowCarried'])allowed.add(n);
      ensure(pvtBalance===0n,'funded_escrow_requires_import');
      const ids=new Set(events.filter(e=>e.args.escrowId!==undefined).map(e=>e.args.escrowId));
      for(const id of ids){
        const e=await read('escrows',[id]);
        ensure(e.status===0n&&(await read('pendingWithdrawal',[id]))[0]===0n
          &&lower((await read('pendingBeneficiary',[id]))[0])===lower(ZeroAddress),'escrow_state_requires_import');
        seedEscrows.push({escrowId:id,depositor:e.depositor,recipient:e.recipient,amount:e.amount.toString(),
          fee:e.fee.toString(),autoReleaseAt:e.autoReleaseAt.toString(),currency:Number(e.currency)});
      }
    }else if(name==='ProvianBondPool'){
      for(const n of ['BondPosted','BondCarried','BondRenewed','BondToppedUp','AutonomyDowngrade'])allowed.add(n);
      const owners=new Set(events.filter(e=>e.args.agent!==undefined).map(e=>lower(e.args.agent)));
      let backing=0n;
      for(const agent of owners){
        const b=await read('bonds',[agent]);
        ensure(b.pendingClaims===0n&&b.status===1n&&b.amount>0n,'bond_state_requires_import');
        backing+=b.amount;
        seedBonds.push({agent,amount:b.amount.toString(),autonomyLevel:Number(b.autonomyLevel),createdAt:b.createdAt.toString(),
          lastRenewalAt:b.lastRenewalAt.toString(),renewalDeadline:b.renewalDeadline.toString(),requiredAtPost:(await read('requiredAtPost',[agent]))[0].toString()});
      }
      ensure(backing===pvtBalance,'bond_backing_mismatch');
      for(const[param,method]of ['activeDepositBurnBps','activeDepositFeeBps','activeRenewalBurnBps','activeRenewalFeeBps'].entries()){
        const value=await read(method);if(value[0])seedBps.push({param,bps:value[1].toString()});
      }
    }else ensure(pvtBalance===0n,'custody_requires_import');
    for(const event of events)ensure(allowed.has(event.name),`state_requires_import:${name}:${event.name}`);
    inventory.push({name,key,address,deploymentBlock:source.block,runtimeHash:expected,pvtBalance:pvtBalance.toString(),
      usdcBalance:usdcBalance.toString(),events:events.map(e=>({name:e.name,args:normalize(e.args.toArray())})),wiring,policy,schedules});
  }
  ensure(await port.blockHash(block)===blockHash,'reorg');
  const data={schema:'provian.institution-snapshot.v1',block,blockHash,inventory,seedEscrows,seedBonds,seedBps};
  return {...data,digest:sha256(toUtf8Bytes(JSON.stringify(data)))};
}
