#!/usr/bin/env node
/* Simulator-only transport adapters around the actual relay routes and workers.
 * Public test wallets, an in-memory Firestore implementation and two views of
 * ONE local chain do not establish production identity/provider independence. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../../..');
require(path.join(root,'provian-backend/node_modules/ts-node')).register({transpileOnly:true,project:path.join(root,'provian-backend/tsconfig.json')});
const {Wallet,Interface,JsonRpcProvider,sha256,toUtf8Bytes,toQuantity,formatUnits}=require(path.join(root,'node_modules/ethers'));
const express=require(path.join(root,'provian-backend/node_modules/express'));
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const moduleAt=p=>require(path.join(root,'provian-backend/src',p));
async function main(){
 const input=read(process.argv[2]),out=path.resolve(input.outputDirectory);
 const localUrl=new URL(input.url);
 if(localUrl.protocol!=='http:'||localUrl.hostname!=='127.0.0.1'||!localUrl.port)throw Error('isolated_local_url_required');
 const allowed=new Set([localUrl.origin,'http://127.0.0.1:18551']);
 const originalFetch=globalThis.fetch;
 globalThis.fetch=(value,options)=>{const url=new URL(typeof value==='string'?value:value instanceof URL?value.href:value.url);
   if(!allowed.has(url.origin))throw Error('isolated_relay_external_network_refused');return originalFetch(value,options);};
 for(const module of ['node:http','node:https']){
   const transport=require(module),original=transport.request;
   transport.request=function(value,...args){
     const url=typeof value==='string'||value instanceof URL?new URL(value):new URL(`${value.protocol??(module==='node:http'?'http:':'https:')}//${value.hostname??value.host}:${value.port??(module==='node:http'?80:443)}`);
     if(!allowed.has(url.origin))throw Error('isolated_relay_external_network_refused');return original.call(this,value,...args);
   };
 }

 const result=read(path.join(out,'result.json'));if(result.result?.status!=='confirmed')throw Error('completed_copy_required');
 const configuration=read(path.join(out,'phases/configuration.json')).payload;
 const bundle=read(path.join(out,'phases/successor-bundle.json')).payload;
 const {isolatedCopyPort}=await import('../copy-port.mjs');const local=isolatedCopyPort(input);await local.verify();
 const rawRequest=(method,params)=>local.request(method,method==='eth_getBlockByNumber'&&params[0]==='finalized'?['latest',false]:params);
 const provider=new JsonRpcProvider(input.url,8453,{staticNetwork:true});provider.send=rawRequest;
 const rpcModule=moduleAt('core/onchain/rpc-provider.ts');
 rpcModule.getOperatorBoundRpcLegs=chain=>{if(chain!=='base')throw Error('isolated_chain_required');return ['local-copy-view-one','local-copy-view-two'].map(operatorId=>({operatorId,provider}));};
 moduleAt('core/protocol/pointer-pin.generated.ts').PROTOCOL_POINTER_PIN=Object.freeze(configuration.pin);
 const fixtureSeed=role=>sha256(toUtf8Bytes('PUBLIC SIMULATOR ONLY: '+input.instanceId+role));
 const attestor=new Wallet(fixtureSeed('attestor')),submitter=new Wallet(fixtureSeed('submitter'));
 if(attestor.address.toLowerCase()!==configuration.identityAttestor||submitter.address.toLowerCase()!==configuration.submitter)throw Error('isolated_operator_mismatch');
 process.env.PVT9_SETTLEMENT_APPROVER_KEY=attestor.privateKey;process.env.PVT9_SETTLEMENT_MINTER_KEY=submitter.privateKey;
 delete process.env.RECOURSE_IDENTITY_HASH_ACCOUNT;delete process.env.RECOURSE_IDENTITY_HASH_SIGNING_SEED;
 await local.request('anvil_setBalance',[submitter.address,toQuantity(100n*10n**18n)]);
 const fixtureDirectory=path.join(out,'native-fixture');fs.mkdirSync(fixtureDirectory,{recursive:true,mode:0o700});
 const sshKey=path.join(fixtureDirectory,'PUBLIC-TEST-ONLY-policy-key');
 if(!fs.existsSync(sshKey))execFileSync('ssh-keygen',['-q','-t','ed25519','-N','','-C','PUBLIC TEST ONLY','-f',sshKey]);
 const publicKey=fs.readFileSync(sshKey+'.pub','utf8').trim(),keyHash=crypto.createHash('sha256').update(Buffer.from(publicKey.split(' ')[1],'base64')).digest('hex');
 process.env.FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY=publicKey;process.env.FRANK_PVT_APPROVAL_SSH_KEY_SHA256=keyHash;
 const ruleModule=moduleAt('core/recourse/membership-rule.ts'),ruleBytes=ruleModule.recourseMembershipSigningBytes(configuration.rule.rule);
 if(sha256(ruleBytes)!==configuration.rule.ruleHash)throw Error('isolated_policy_bytes_changed');
 const rulePath=path.join(fixtureDirectory,'rule.bytes');fs.writeFileSync(rulePath,ruleBytes,{mode:0o600});
 if(fs.existsSync(rulePath+'.sig'))fs.unlinkSync(rulePath+'.sig');
 execFileSync('ssh-keygen',['-Y','sign','-f',sshKey,'-n','provian-pvt-policy',rulePath],{stdio:'ignore'});
 const signedRule={...configuration.rule,signature:{scheme:'sshsig-ed25519',signer_identity:'frank',namespace:'provian-pvt-policy',public_key_sha256:keyHash,armored_signature:fs.readFileSync(rulePath+'.sig','utf8')}};
 ruleModule.verifyRecourseMembershipRule(signedRule,configuration.pin.address);
 const {createFakeFirestore}=moduleAt('core/pvt/__test-helpers__/fake-firestore.ts');
 const db=createFakeFirestore({strictTransactionOrder:true,rejectUndefinedValues:true}),dbPath=path.join(fixtureDirectory,'database.json');
 if(fs.existsSync(dbPath))for(const [key,value]of read(dbPath))db.store.set(key,value);
 db.store.set(`${ruleModule.RECOURSE_MEMBERSHIP_RULES}/${configuration.rule.ruleHash}`,signedRule);
 // This is the well-known public development mnemonic, never a real wallet.
 const wallet=Wallet.fromPhrase('test test test test test test test test test test test junk');
 const userId='isolated-recourse-native-member',walletId='isolated-recourse-native-wallet';
 if(!db.store.has(`wallets/${walletId}`))db.store.set(`wallets/${walletId}`,{id:walletId,type:'human',user_id:userId,address:wallet.address.toLowerCase(),status:'active'});
 const token=sha256(toUtf8Bytes('PUBLIC NATIVE FIXTURE TOKEN '+input.instanceId));
 const nativeConfig={relay:'http://127.0.0.1:18551',userId,fixtureToken:token,instanceId:input.instanceId,
   pointer:configuration.pin.address,pointerRuntimeHash:configuration.pin.runtimeHash};
 fs.writeFileSync(path.join(__dirname,'config.generated.json'),JSON.stringify(nativeConfig,null,2)+'\n');
 const save=()=>{const tmp=dbPath+'.tmp';fs.writeFileSync(tmp,JSON.stringify([...db.store]),{mode:0o600});fs.renameSync(tmp,dbPath);};
 const app=express();app.use(express.json({limit:'2mb'}));
 app.post('/rpc/:leg',async(req,res)=>{try{
   if(!['one','two'].includes(req.params.leg))throw Error('isolated_rpc_leg');
   const {method,params,id}=req.body;
   if(typeof method!=='string'||!Array.isArray(params)||!method.startsWith('eth_'))throw Error('isolated_rpc_method');
   res.json({jsonrpc:'2.0',id,result:await rawRequest(method,params)});
 }catch{res.status(400).json({jsonrpc:'2.0',id:req.body?.id,error:{code:-32000,message:'isolated_rpc_refused'}});}});
 const {createRecourseRouter}=require(path.join(root,'provian-backend/src/routes/recourse.ts'));
 const auth=(req,res,next)=>{if(req.get('authorization')!==`Bearer ${token}`)return res.status(401).json({error:'isolated_owner_required'});
   req.user={id:userId};return next();};
 app.use('/v1/recourse',createRecourseRouter({db},auth));
 app.get('/exercise/history',async(req,res)=>{try{
  const account=String(req.query.address).toLowerCase(),page=Number(req.query.page??1),limit=Number(req.query.limit??50);
  if(!/^0x[0-9a-f]{40}$/.test(account)||!Number.isSafeInteger(page)||page<1||limit!==50)throw Error('isolated_history_input');
  const deployment=await moduleAt('core/protocol/runtime.ts').currentProtocolDeployment(),abi=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
  const logs=await rawRequest('eth_getLogs',[{address:deployment.addresses.kernel,fromBlock:toQuantity(bundle.plan.snapshotBlock??configuration.deployment.successorKernel.pvt9Kernel.block),toBlock:'latest',topics:[abi.getEvent('Transfer').topicHash]}]);
  const items=[];for(const log of logs){const event=abi.parseLog(log),from=event.args.from.toLowerCase(),to=event.args.to.toLowerCase();if(from!==account&&to!==account)continue;
    const block=await rawRequest('eth_getBlockByNumber',[log.blockNumber,false]);
    items.push({id:log.transactionHash+':'+log.logIndex,hash:log.transactionHash,type:from===account?'send':'receive',status:'confirmed',chain:'Base',from,to,
      amount:formatUnits(event.args.value,18),symbol:'PVT',timestamp:Number(BigInt(block.timestamp))*1000,blockNumber:Number(BigInt(log.blockNumber)),contractAddress:deployment.addresses.kernel,isVerifiedToken:true});}
  items.reverse();res.json({items:items.slice((page-1)*limit,page*limit),hasMore:items.length>page*limit,page,total:items.length});
 }catch{res.status(503).json({error:'isolated_history_unavailable'});}});
 app.get('/exercise/status',(_req,res)=>res.json({isolated:true,instanceId:input.instanceId,wallet:wallet.address,documents:db.store.size}));
 app.listen(18551,'127.0.0.1',()=>console.log('Isolated native relay listening on127.0.0.1:18551'));
 const workers=[()=>moduleAt('core/recourse/binding-runtime.ts').runBindingWorker(db),()=>moduleAt('core/recourse/owner-operation-runtime.ts').runOwnerOperationWorker(db),
  ()=>moduleAt('core/recourse/membership-runtime.ts').runMembershipConsentWorker(db),()=>moduleAt('core/recourse/automatic-membership.ts').runAutomaticMembershipSweep(db),
  ()=>moduleAt('core/recourse/membership-runtime.ts').runMembershipDebitWorker(db)];
 let busy=false;setInterval(async()=>{if(busy)return;busy=true;try{for(const work of workers){try{await work();}catch(error){console.error('isolated_worker',error.message);}}save();}finally{busy=false;}},2000);
 process.on('SIGINT',()=>{save();process.exit(0);});process.on('SIGTERM',()=>{save();process.exit(0);});
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
