/* Explicit local-simulator actions. Every chain write is authenticated by
 * isolatedCopyPort's instance/fork fence; no real operator keys are loaded. */
const fs=require('node:fs'),path=require('node:path');
const {Interface,Wallet,toQuantity,parseUnits}=require('ethers');
module.exports=async function createControls(ctx){
 const {local,rawRequest,moduleAt,db,configuration,bundle,wallet,attestor,submitter,fixtureSeed,fixtureDirectory,save}=ctx;
 const {boundedGasEstimate}=await import('../transaction-gas-limit.mjs');
 const file=path.join(fixtureDirectory,'controls.json'),journal=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):{};
 const persist=()=>{fs.writeFileSync(file,JSON.stringify(journal,null,2)+'\n',{mode:0o600});save();};
 const token=new Interface(['function transfer(address,uint256) returns(bool)','function burn(uint256)','function balanceOf(address) view returns(uint256)',
 'function restorationAuthority() view returns(address)','function appointRestorationAuthority(address)']);
 const kernel=bundle.plan.addresses.ProvianRecourseKernel;
 const balance=async address=>String(token.decodeFunctionResult('balanceOf',await rawRequest('eth_call',[{to:kernel,data:token.encodeFunctionData('balanceOf',[address])},'latest']))[0]);
 const send=async(from,method,args)=>{
  const data=token.encodeFunctionData(method,args),key=`${from.toLowerCase()}:${data}`;
  journal.transactions??={};
  let intent=journal.transactions[key];
  if(!intent){
   const block=await rawRequest('eth_getBlockByNumber',['latest',false]);
   intent={from:from.toLowerCase(),to:kernel,data,nonce:await rawRequest('eth_getTransactionCount',[from,'latest']),
    startBlock:block.number,startHash:block.hash};
   journal.transactions[key]=intent;persist();
  }
  if((await rawRequest('eth_getBlockByNumber',[intent.startBlock,false])).hash!==intent.startHash)throw Error('isolated_transaction_checkpoint_changed');
  const find=async()=>{
   const head=BigInt(await rawRequest('eth_blockNumber',[]));
   for(let n=BigInt(intent.startBlock)+1n;n<=head;n++){
    const block=await rawRequest('eth_getBlockByNumber',[toQuantity(n),true]);
    for(const tx of block.transactions)if(tx.from.toLowerCase()===intent.from&&BigInt(tx.nonce)===BigInt(intent.nonce)){
     if(tx.to?.toLowerCase()!==kernel.toLowerCase()||tx.input!==data||BigInt(tx.value)!==0n)throw Error('isolated_transaction_nonce_conflict');
     intent.transactionHash=tx.hash;persist();return;
    }
   }
  };
  if(!intent.transactionHash)await find();
  if(!intent.transactionHash){
   if(BigInt(await rawRequest('eth_getTransactionCount',[from,'pending']))!==BigInt(intent.nonce))throw Error('isolated_transaction_nonce_changed');
   await local.request('anvil_impersonateAccount',[from]);await local.request('anvil_setBalance',[from,toQuantity(100n*10n**18n)]);
   const tx={from,to:kernel,data,value:'0x0',nonce:intent.nonce};
   tx.gas=toQuantity(boundedGasEstimate(BigInt(await rawRequest('eth_estimateGas',[tx]))));
   try{intent.transactionHash=await local.request('eth_sendTransaction',[tx]);persist();}
   catch(error){await find();if(!intent.transactionHash)throw error;}
  }
  const receipt=await rawRequest('eth_getTransactionReceipt',[intent.transactionHash]);
  if(receipt?.status!=='0x1'||(await rawRequest('eth_getBlockByNumber',[receipt.blockNumber,false])).hash!==receipt.blockHash)
   throw Error('isolated_control_transaction_failed');
  intent.receipt={transactionHash:intent.transactionHash,block:Number(BigInt(receipt.blockNumber)),blockHash:receipt.blockHash,gasUsed:String(BigInt(receipt.gasUsed))};
  persist();return intent.receipt;
 };
 const authority=new Wallet(fixtureSeed('restoration-authority'));
 const workflow=moduleAt('core/recourse/determination-workflow.ts');
 const port=moduleAt('core/recourse/determination-runtime.ts').createDeterminationWorkflowPort(db,{authority,gas:submitter,attestor});
 const initAuthority=async()=>{
  const prior=token.decodeFunctionResult('restorationAuthority',await rawRequest('eth_call',[{to:kernel,data:token.encodeFunctionData('restorationAuthority')},'latest']))[0];
  if(prior.toLowerCase()===authority.address.toLowerCase()&&!journal.authority){
   const authorityKey=`${configuration.deployment.wiring.admin.toLowerCase()}:${token.encodeFunctionData('appointRestorationAuthority',[authority.address])}`;
   if(journal.transactions?.[authorityKey]){journal.authority=await send(configuration.deployment.wiring.admin,'appointRestorationAuthority',[authority.address]);persist();}
  }
  if(prior.toLowerCase()!==authority.address.toLowerCase()){
   if(prior.toLowerCase()!==configuration.deployment.wiring.admin.toLowerCase())throw Error('isolated_authority_changed');
   journal.authority=await send(prior,'appointRestorationAuthority',[authority.address]);persist();
  }
  await local.request('anvil_setBalance',[authority.address,toQuantity(100n*10n**18n)]);
 };
 const advanceMonth=async(key,months,explicitTimestamp)=>{
  if(journal[key]&&journal[key].complete!==false)throw Error('isolated_month_already_advanced');
  if(BigInt(await rawRequest('eth_getBalance',[wallet.address,'latest']))!==0n)throw Error('isolated_zero_member_eth_required');
  if(!journal[key]){
   const block=await rawRequest('eth_getBlockByNumber',['latest',false]),date=new Date(Number(BigInt(block.timestamp))*1000);
   const to=explicitTimestamp??Math.floor(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+months,1,0,1)/1000);
   journal[key]={before:await balance(wallet.address),from:Number(BigInt(block.timestamp)),fromBlock:block.number,fromHash:block.hash,to,complete:false};persist();
  }
  const intent=journal[key],original=await rawRequest('eth_getBlockByNumber',[intent.fromBlock,false]);
  if(original?.hash!==intent.fromHash)throw Error('isolated_month_checkpoint_changed');
  const latest=await rawRequest('eth_getBlockByNumber',['latest',false]);
  if(Number(BigInt(latest.timestamp))<intent.to){
   await local.request('evm_setNextBlockTimestamp',[intent.to]);await local.request('anvil_mine',['0x1']);
  }
  const done=await rawRequest('eth_getBlockByNumber',['latest',false]);
  if(Number(BigInt(done.timestamp))<intent.to||BigInt(done.number)<=BigInt(intent.fromBlock))throw Error('isolated_month_unconfirmed');
  journal[key]={...intent,complete:true,block:done.number,blockHash:done.hash};persist();
 };
 return {
  async run(action){
   await local.verify();
   if(action==='status')return {wallet:wallet.address,memberPvt:await balance(wallet.address),memberEth:String(BigInt(await rawRequest('eth_getBalance',[wallet.address,'latest']))),journal};
   if(action==='fund'){
    if(!journal.funding){
     const excluded=new Set(Object.values(bundle.plan.addresses).map(a=>a.toLowerCase()));
     const donor=[...bundle.plan.snapshot.balances].sort((a,b)=>BigInt(a.amount)>BigInt(b.amount)?-1:1)
      .find(row=>!excluded.has(row.destination.toLowerCase())&&BigInt(row.amount)>=parseUnits('1000',18));
     if(!donor)throw Error('isolated_existing_funds_required');
     const fundingKey=`${donor.destination.toLowerCase()}:${token.encodeFunctionData('transfer',[wallet.address,parseUnits('1000',18)])}`;
     if(!journal.transactions?.[fundingKey]&&BigInt(await balance(wallet.address))!==0n)throw Error('isolated_member_already_funded');
     journal.funding=await send(donor.destination,'transfer',[wallet.address,parseUnits('1000',18)]);persist();
    }
    await local.request('anvil_setBalance',[wallet.address,'0x0']);await initAuthority();
   }else if(action==='sync-clock'){
    await advanceMonth('clock',0,Math.floor(Date.now()/1000));
   }else if(action==='next-month'){
    await advanceMonth('month',1);
   }else if(action==='lapse'){
    if(!journal.month||journal.month.complete===false)throw Error('isolated_lapse_sequence');
    await advanceMonth('lapse',4);
   }else if(action==='theft'){
    if(journal.theftComplete)throw Error('isolated_theft_already_created');
    const thief=new Wallet(fixtureSeed('thief')).address;
    if(!journal.theft)journal.theft=await send(wallet.address,'transfer',[thief,parseUnits('100',18)]);persist();
    if(!journal.unreachable)journal.unreachable=await send(thief,'burn',[parseUnits('40',18)]);
    await local.request('anvil_setBalance',[wallet.address,'0x0']);journal.theftComplete=true;persist();
   }else if(action==='determine'){
    await initAuthority();
    if(!journal.theft)throw Error('isolated_theft_required');
    const {RESTORATION_REQUESTS}=moduleAt('core/recourse/restoration-request.ts');
    const rows=await db.collection(RESTORATION_REQUESTS).where('transactionHash','==',journal.theft.transactionHash).get();
    if(rows.size!==1)throw Error('isolated_native_request_required');
    const request=rows.docs[0].id,determination=moduleAt('core/recourse/determination.ts');
    if(rows.docs[0].get('status')==='awaiting_determination'){
     const packet=await determination.prepareDetermination(db,request);
     const losses=new Set(packet.snapshot.outflows.map(e=>`${e.transactionHash}:${e.logIndex}`));
     const receipts=packet.evidence.checkpoint.transfers.filter(e=>losses.has(`${e.transactionHash}:${e.logIndex}`)).map(e=>({
      transactionHash:e.transactionHash,logIndex:e.logIndex,conclusion:'theft_taker',evidenceHashes:[e.witnessHash],
      reasoning:'The isolated harness deliberately transferred the public fixture member funds without member consent.'}));
     const checked=determination.assessRestoration(packet,{packetHash:packet.packetHash,finding:'accepted_theft',
      reasoning:'Local simulated theft, with a subsequent canonical burn of40 PVT and60 PVT still traceable.',
      evidenceHashes:[packet.snapshot.evidenceHash,packet.membership.evidenceHash],receipts});
     await workflow.queueDetermination(db,checked);journal.determination={request,packetHash:packet.packetHash,trace:checked.trace};persist();
    }
    journal.determinationResult=await workflow.runDeterminationWorkflow(db,port);persist();
   }else throw Error('isolated_control_action_refused');
   return this.run('status');
  }
 };
};
