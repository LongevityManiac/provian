#!/usr/bin/env node
/* Simulator-only transport adapters around the actual relay routes and workers.
 * Public test wallets, an in-memory Firestore implementation and two views of
 * ONE local chain do not establish production identity/provider independence. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../../..');
require(path.join(root,'provian-backend/node_modules/ts-node')).register({transpileOnly:true,project:path.join(root,'provian-backend/tsconfig.json')});
const {Wallet,Mnemonic,Interface,JsonRpcProvider,sha256,toUtf8Bytes,toQuantity,formatUnits}=require(path.join(root,'node_modules/ethers'));
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
 if(process.env.NODE_ENV==='test')throw Error('isolated_production_policy_path_required');
 const rawRequest=(method,params)=>local.request(method,method==='eth_getBlockByNumber'&&params[0]==='finalized'?['latest',false]:params);
 const provider=new JsonRpcProvider(input.url,8453,{staticNetwork:true});provider.send=rawRequest;
 const rpcModule=moduleAt('core/onchain/rpc-provider.ts');
 rpcModule.getOperatorBoundRpcLegs=chain=>{if(chain!=='base')throw Error('isolated_chain_required');return ['local-copy-view-one','local-copy-view-two'].map(operatorId=>({operatorId,provider}));};
 moduleAt('core/protocol/pointer-pin.generated.ts').PROTOCOL_POINTER_PIN=Object.freeze(configuration.pin);
 const fixtureSeed=role=>sha256(toUtf8Bytes('PUBLIC SIMULATOR ONLY: '+input.instanceId+role));
 process.env.RELAY_SIGNING_KEY=fixtureSeed('relay-retention');
 const attestor=new Wallet(fixtureSeed('attestor')),submitter=new Wallet(fixtureSeed('submitter'));
 if(attestor.address.toLowerCase()!==configuration.identityAttestor||submitter.address.toLowerCase()!==configuration.submitter)throw Error('isolated_operator_mismatch');
 process.env.PVT9_SETTLEMENT_APPROVER_KEY=attestor.privateKey;process.env.PVT9_SETTLEMENT_MINTER_KEY=submitter.privateKey;
 delete process.env.RECOURSE_IDENTITY_HASH_ACCOUNT;delete process.env.RECOURSE_IDENTITY_HASH_SIGNING_SEED;
 await local.request('anvil_setBalance',[submitter.address,toQuantity(100n*10n**18n)]);
 const fixtureDirectory=path.join(out,'native-fixture-eoa');fs.mkdirSync(fixtureDirectory,{recursive:true,mode:0o700});
 const sshKey=path.join(fixtureDirectory,'PUBLIC-TEST-ONLY-policy-key');
 if(!fs.existsSync(sshKey))execFileSync('ssh-keygen',['-q','-t','ed25519','-N','','-C','PUBLIC TEST ONLY','-f',sshKey]);
 const publicKey=fs.readFileSync(sshKey+'.pub','utf8').trim(),keyHash='sha256:'+crypto.createHash('sha256').update(Buffer.from(publicKey.split(' ')[1],'base64')).digest('hex');
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
 db.settings(require(path.join(root,'provian-backend/src/firestore-settings.ts')).RELAY_FIRESTORE_SETTINGS);
 // Public-fixture storage is plaintext, as are the other FakeFirestore rows.
 // Adapt only this storage boundary; never select test monetary/auth policy.
 const retention=moduleAt('core/provenance/private-retention.ts');
 retention.privateRetentionCollection=(candidate,collection)=>{
  // Real pricing creates memoized read proxies over this same backing store.
  if(candidate?.store!==db.store||!retention.PRIVATE_RETENTION_COLLECTIONS.has(collection))throw Error('isolated_retention_store_required');
  return candidate.collection(collection);
 };
 if(fs.existsSync(dbPath))for(const [key,value]of read(dbPath))db.store.set(key,value);
 // Every real pricing/recovery dependency uses this same isolated database.
 require(path.join(root,'provian-backend/src/firestore-db.ts')).relayDb=()=>db;
 const authCache=new Map();
 const deps={db,cache:{async setUserAuthSecret(id,value){authCache.set(id,value);}},
   recordPEAccrual:require(path.join(root,'provian-backend/src/pvt-accrual.ts')).recordPEAccrual};
 db.store.set(`${ruleModule.RECOURSE_MEMBERSHIP_RULES}/${configuration.rule.ruleHash}`,signedRule);
 // A public, instance-derived fixture avoids delegated code on widely reused test addresses.
 const wallet=Wallet.fromPhrase(Mnemonic.fromEntropy(fixtureSeed('native-member-eoa').slice(0,34)).phrase);
 if(await rawRequest('eth_getCode',[wallet.address,'latest'])!=='0x')throw Error('isolated_fixture_eoa_required');
 const userId='isolated-recourse-native-member-eoa',walletId='isolated-recourse-native-wallet-eoa';
 if(!db.store.has(`wallets/${walletId}`))db.store.set(`wallets/${walletId}`,{id:walletId,type:'human',user_id:userId,address:wallet.address.toLowerCase(),status:'active'});
 // The pre-registered fixture carries the same canonical native index as a registered human wallet.
 const nativeIndex=moduleAt('core/pvt/native-wallet-registration.ts');
 const currentAddress=db.store.get(`wallets/${walletId}`).address;
 if(typeof currentAddress!=='string'||!/^0x[0-9a-f]{40}$/.test(currentAddress))throw Error('isolated_fixture_address_invalid');
 const indexId=nativeIndex.nativeWalletAddressIndexId(currentAddress),indexPath=`${nativeIndex.NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${indexId}`;
 if(!db.store.has(indexPath)){
  if(currentAddress!==wallet.address.toLowerCase()||db.store.has(`${nativeIndex.AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION}/${currentAddress}`))
   throw Error('isolated_recovered_index_missing');
  db.store.set(indexPath,{schema_version:nativeIndex.CANONICAL_NATIVE_ADDRESS_INDEX_SCHEMA,
   chain_id:8453,address:currentAddress,wallet_id:walletId,owner_type:'human',owner_id:userId,created_at_ms:Date.now()});
 }
 nativeIndex.parseCanonicalNativeAddressIndex(db.store.get(indexPath),indexId);
 // Publish the public half of the same human mailbox key the fixture seed
 // derives on-device. This keeps the real sealed outcome path functional.
 const messageSeed=Buffer.from(crypto.hkdfSync('sha256',Buffer.from(wallet.mnemonic.phrase),
   Buffer.from('provian-thread-msgkey-v1'),Buffer.from('provian.thread.msgkey.v1.human'),32));
 try{
  const privateKey=crypto.createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b656e04220420','hex'),messageSeed]),format:'der',type:'pkcs8'});
  const publicKey=crypto.createPublicKey(privateKey).export({format:'der',type:'spki'}).subarray(-32).toString('base64url');
  await moduleAt('core/commons/message-keys.ts').publishMessageKey(db,{id:walletId,kind:'human'},publicKey);
 }finally{messageSeed.fill(0);}
 // Complete the pre-registered public fixture's birth metadata using a real
 // sealed relay PE. This is fixture setup, not evidence of native onboarding.
 const birthModule=moduleAt('core/pvt/genesis-ingress.ts');
 const birthPath=`${birthModule.HUMAN_WALLET_REGISTRATION_INDEX_COLLECTION}/${birthModule.humanWalletRegistrationIndexId(userId)}`;
 if(!db.store.has(birthPath)){
  const address=wallet.address.toLowerCase(),now=Date.now();
  if(!db.store.has(`users/${userId}`))db.store.set(`users/${userId}`,{id:userId,devices:[],network_class:'fixture',wallet_address:address});
  const existing=db.store.get(`wallets/${walletId}`);
  if(existing.address!==address)throw Error('isolated_fixture_birth_after_recovery');
  db.store.set(`wallets/${walletId}`,{...existing,public_key:address,birth_public_key:address,network_class:'fixture'});
  const birth=await moduleAt('core/agent-bank/pe-utils.ts').generatePE(deps,{walletId,agentId:userId,actorAddress:address,
   walletAddress:address,ownerType:'human',actionType:'wallet_created',peIdOverride:'pe_isolated_recourse_fixture_birth',
   timestampOverride:now,metadata:{fixture:'public_simulator_setup'}});
  db.store.set(birthPath,{schema_version:'human-wallet-registration/v2',user_id:userId,wallet_id:walletId,address,
   request_fingerprint:birthModule.humanWalletRegistrationRequestFingerprint(userId,address,address),
   pe_id:birth.peId,pe_hash:birth.peHash,prev_hash:birth.prevHash,public_key_sha256:crypto.createHash('sha256').update(address).digest('hex'),
   economic_device_id:null,created_at_ms:now,genesis_qualification_id:null,standard_accrual_status:'pending',standard_accrual_acknowledged_at_ms:null});
 }
 const relayActs=moduleAt('core/meter/meter-relay-authored.ts');
 const pendingBirth=await relayActs.readRelayActIntake(db,'pe_isolated_recourse_fixture_birth');
 if(pendingBirth)await relayActs.priceRelayAct(db,pendingBirth);
 const birthMarker=db.store.get(birthPath),birthAct=await retention.privateRetentionCollection(db,'meter_act_keys_v1').doc(birthMarker.pe_id).get();
 if(birthAct.exists&&birthAct.get('pe_hash')===birthMarker.pe_hash){
  await birthModule.acknowledgeHumanWalletStandardAccrual({db,userId,peId:birthMarker.pe_id,peHash:birthMarker.pe_hash,acknowledgedAtMs:Date.now()});
 }
 // Resume genuine recovery/outcome intakes after a fixture transport restart.
 const pendingActs=await db.collection(relayActs.METER_RELAY_ACTS_COLLECTION).get();
 for(const row of pendingActs.docs)await relayActs.priceRelayAct(db,row.data());
 const token=sha256(toUtf8Bytes('PUBLIC NATIVE FIXTURE TOKEN '+input.instanceId));
 const nativeConfig={relay:'http://127.0.0.1:18551',userId,fixtureToken:token,instanceId:input.instanceId,
   pointer:configuration.pin.address,pointerRuntimeHash:configuration.pin.runtimeHash};
 const configPath=path.join(__dirname,'config.generated.json'),configBytes=JSON.stringify(nativeConfig,null,2)+'\n';
 if(!fs.existsSync(configPath)||fs.readFileSync(configPath,'utf8')!==configBytes)fs.writeFileSync(configPath,configBytes);
 const save=()=>{const tmp=dbPath+'.tmp';fs.writeFileSync(tmp,JSON.stringify([...db.store]),{mode:0o600});fs.renameSync(tmp,dbPath);};
 const controls=await require('./controls.cjs')({local,rawRequest,moduleAt,db,configuration,bundle,wallet,attestor,submitter,fixtureSeed,fixtureDirectory,save});
 const app=express();app.use(express.json({limit:'2mb'}));
 app.use((req,res,next)=>{const route=req.path;res.on('finish',()=>{if(route.startsWith('/v1/'))console.log('isolated_route',req.method,route,res.statusCode);});next();});
 app.post('/rpc/:leg',async(req,res)=>{try{
   if(!['one','two'].includes(req.params.leg))throw Error('isolated_rpc_leg');
   const {method,params,id}=req.body;
   if(typeof method!=='string'||!Array.isArray(params)||!method.startsWith('eth_'))throw Error('isolated_rpc_method');
   res.json({jsonrpc:'2.0',id,result:await rawRequest(method,params)});
 }catch{res.status(400).json({jsonrpc:'2.0',id:req.body?.id,error:{code:-32000,message:'isolated_rpc_refused'}});}});
 const {createRecourseRouter}=require(path.join(root,'provian-backend/src/routes/recourse.ts'));
 const auth=(req,res,next)=>{if(req.get('authorization')!==`Bearer ${token}`)return res.status(401).json({error:'isolated_owner_required'});
   req.user={id:userId};return next();};
 let controlBusy=false,busy=false,privateOffline=false,workersPaused=false;
 app.post('/exercise/control',auth,async(req,res)=>{
  if(controlBusy||busy)return res.status(409).json({error:'isolated_control_busy'});
  controlBusy=true;
  try{
   if(!req.body||Object.keys(req.body).join(',')!=='action'||typeof req.body.action!=='string')throw Error('isolated_control_input');
   const action=req.body.action;
   if(action==='private-offline'||action==='private-online'){privateOffline=action==='private-offline';return res.json({privateOffline});}
   if(action==='pause-workers'||action==='resume-workers'){workersPaused=action==='pause-workers';return res.json({workersPaused});}
   res.json(await controls.run(action));
  }catch(error){console.error('isolated_control',error.message,error.copyDiagnostic??'');res.status(400).json({error:error.message});}
  finally{controlBusy=false;}
 });
 // This adapter only confirms the existing public fixture; it never registers a supplied address.
 app.post('/v1/wallet/human/register',auth,(req,res)=>{
  const registered=db.store.get(`wallets/${walletId}`).address;
  if(req.body?.address!==registered||req.body?.publicKey!==registered)
   return res.status(403).json({error:'isolated_fixture_wallet_required'});
  return res.json({walletId});
 });
 // Exercise private transport failure while independent chain reads stay available.
 app.use('/v1/recourse',(_req,res,next)=>privateOffline?res.status(503).json({error:'isolated_private_offline'}):next(),createRecourseRouter(deps,auth));
 // Same owner-scoped mailbox operations as the mobile relay routes; only
 // authentication and storage are the isolated public-fixture adapters.
 const mailbox=moduleAt('core/meter/pe-mailbox.ts');
 app.get('/v1/meter/mobile/mailbox',auth,async(req,res)=>{
  const limit=Number(req.query.limit??100),after=typeof req.query.after==='string'?req.query.after:null;
  res.json(await mailbox.listMailbox(db,`human:${userId}`,{limit:Number.isFinite(limit)?limit:100,afterId:after}));
 });
 app.post('/v1/meter/mobile/mailbox/ack',auth,async(req,res)=>{
  const ids=Array.isArray(req.body?.ids)?req.body.ids.filter(value=>typeof value==='string'):[];
  res.json({dropped:await mailbox.ackMailbox(db,`human:${userId}`,ids)});save();
 });
 app.post('/v1/meter/mobile/batch-proofs',auth,async(req,res)=>{
  const result=await moduleAt('core/meter/batch-proofs.ts').readBatchProofsRequest(db,req.body);
  if(!result.ok)return res.status(400).json({error:result.error});
  return res.json(result.value);
 });
 app.get('/exercise/history',async(req,res)=>{try{
  const account=String(req.query.address).toLowerCase(),page=Number(req.query.page??1),limit=Number(req.query.limit??50);
  if(!/^0x[0-9a-f]{40}$/.test(account)||!Number.isSafeInteger(page)||page<1||limit!==50)throw Error('isolated_history_input');
  const deployment=await moduleAt('core/protocol/runtime.ts').currentProtocolDeployment(),abi=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
  const logs=await rawRequest('eth_getLogs',[{address:deployment.addresses.kernel,fromBlock:toQuantity(bundle.plan.snapshot.block),toBlock:'latest',topics:[abi.getEvent('Transfer').topicHash]}]);
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
 setInterval(async()=>{if(busy||controlBusy||workersPaused)return;busy=true;try{for(const work of workers){try{await work();}catch(error){console.error('isolated_worker',error.message,error.copyDiagnostic??'');}}save();}finally{busy=false;}},2000);
 process.on('SIGINT',()=>{save();process.exit(0);});process.on('SIGTERM',()=>{save();process.exit(0);});
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
