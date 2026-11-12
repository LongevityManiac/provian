#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Contract, Interface, concat, getAddress, hexlify, keccak256, sha256, toQuantity, toUtf8Bytes } from 'ethers';
import { isolatedExercisePort } from './exercise-port.mjs';
import { exerciseReceipt } from './exercise-read.mjs';
import { exerciseSeed, exerciseWallet } from './exercise-bootstrap.mjs';
import { exerciseSequence } from './exercise-sequence.mjs';
import { exerciseMutationLock } from './exercise-lock.mjs';
import { prepareExerciseMembership, verifyExerciseMembershipSubmission } from './exercise-membership.mjs';
import { exerciseSignatureQueue } from './exercise-signature-queue.mjs';
import { recoverySigningRoot } from '../../provian-agent-sdk/dist/recourse-hash-authorization.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const origin = 'http://127.0.0.1:18546';
const artifactAbi = name => JSON.parse(readFileSync(resolve(root, `contracts/out/${name}.sol/${name}.json`), 'utf8')).abi;
const page = readFileSync(new URL('./exercise-workbench.html', import.meta.url), 'utf8');
const client = readFileSync(new URL('./exercise-workbench-client.mjs', import.meta.url), 'utf8');

export async function startExerciseWorkbench(directory, copiedFundingAddress) {
  const manifest = JSON.parse(readFileSync(resolve(directory, 'exercise.json'), 'utf8'));
  const port = isolatedExercisePort(), provider = port.provider;
  const a = manifest.addresses;
  const registryAbi = artifactAbi('ProvianOwnershipRegistry'), tokenAbi = artifactAbi('ProvianRecourseKernel'), poolAbi = artifactAbi('ProvianMemberRecoursePool');
  const registry = new Contract(a.ProvianOwnershipRegistry, registryAbi, provider);
  const pool = new Contract(a.ProvianMemberRecoursePool, poolAbi, provider);
  const token = new Contract(a.ProvianRecourseKernel, tokenAbi, provider);
  const copiedFunder = copiedFundingAddress ? getAddress(copiedFundingAddress).toLowerCase() : null;
  const mutationLock = exerciseMutationLock();
  const signatures = exerciseSignatureQueue(), jobs = new Map();
  const attestor = exerciseWallet(manifest.instanceId, 'attestor');
  if (attestor.address.toLowerCase() !== manifest.attestor.toLowerCase()) throw Error('exercise_attestor_changed');
  async function verify() {
    await port.verify();
    if (manifest.chainId !== 31337 || (await provider.send('anvil_metadata', [])).instanceId !== manifest.instanceId) throw Error('exercise_instance_changed');
    for (const index of [0, 8]) if (keccak256(await provider.getCode(manifest.components[index])) !== manifest.hashes[index]) throw Error('exercise_runtime_changed');
  }
  await verify();
  const server = createServer(async (req, res) => {
    const reply = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
    try {
      if (req.headers.host !== '127.0.0.1:18546' || (req.headers.origin && req.headers.origin !== origin)) return reply(403, {error:'exercise_origin_refused'});
      if (req.method === 'GET' && ['/', '/client.js', '/ethers.js'].includes(req.url)) {
        res.writeHead(200, {'content-type':req.url==='/'?'text/html':'text/javascript','cache-control':'no-store',
          'content-security-policy':"default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self' http://127.0.0.1:18545; frame-ancestors 'none'"});
        res.end(req.url==='/'?page:req.url==='/client.js'?client:readFileSync(resolve(root,'node_modules/ethers/dist/ethers.min.js')));return;
      }
      await verify();
      if (req.method === 'GET' && req.url === '/manifest') return reply(200, {chainId:31337,kernel:a.ProvianRecourseKernel,
        registry:a.ProvianOwnershipRegistry,pool:a.ProvianMemberRecoursePool,copiedFunder,registryAbi,tokenAbi,poolAbi});
      if (req.method !== 'POST' || !['/state','/binding','/submit-binding','/fund','/exercise','/membership','/submit-membership','/exercise-status','/exercise-signature'].includes(req.url) || req.headers['content-type'] !== 'application/json'
        || req.headers.origin !== origin) return reply(403,{error:'exercise_request_refused'});
      let body='';for await(const chunk of req){body+=chunk.toString();if(Buffer.byteLength(body)>4096)throw Error('exercise_request_too_large');}
      const input=JSON.parse(body);
      const address=getAddress(req.url==='/submit-binding'?input.binding?.account:req.url==='/submit-membership'?input.challenge?.account:input.address).toLowerCase();
      const identity=await registry.addressBinding(address);
      const sequencePath=resolve(directory,`sequence-${address}.json`);
      if(req.url==='/exercise-status') return reply(200,{...(jobs.get(address)??{state:'idle'}),pending:signatures.read(address)});
      if(req.url==='/exercise-signature'){
        signatures.submit(address,input.id,input.signature);return reply(200,{accepted:true,productionChanged:false});
      }
      if(req.url==='/membership'){
        if(mutationLock.busy||!['join','burn'].includes(input.kind))throw Error('exercise_membership_unavailable');
        return reply(200,await prepareExerciseMembership({manifest,provider,registry,pool,account:address,kind:input.kind,attestor}));
      }
      if(req.url==='/submit-membership'){
        return await mutationLock.run(async()=>{
          const signed=verifyExerciseMembershipSubmission(input,{chainId:'31337',pointer:a.ProvianProtocolPointer.toLowerCase(),
            kernel:a.ProvianRecourseKernel.toLowerCase(),pool:a.ProvianMemberRecoursePool.toLowerCase()},attestor.address);
          const data=pool.interface.encodeFunctionData(signed.challenge.method,[signed.challenge.authorization,signed.ownerSignature,signed.attestorSignature]);
          const transactionHash=await port.mutate('eth_sendTransaction',[{from:manifest.deployer,to:a.ProvianMemberRecoursePool,data,gas:toQuantity(2_000_000)}]);
          const receipt=await exerciseReceipt(provider,transactionHash);
          if(!receipt||BigInt(receipt.status)!==1n)throw Error('exercise_membership_not_confirmed');
          return reply(200,{transactionHash,productionChanged:false});
        });
      }
      if(req.url==='/exercise'){
        if(mutationLock.busy||jobs.has(address)||existsSync(sequencePath))throw Error('exercise_already_started');
        if(await registry.ownerOf(address)!==identity||!(await pool.addressConsent(identity)).joined)throw Error('exercise_bound_member_required');
        if(mutationLock.busy)throw Error('exercise_already_started');
        jobs.set(address,{state:'running'});
        void mutationLock.run(()=>exerciseSequence(directory,address,address,challenge=>signatures.request(challenge)))
          .then(result=>jobs.set(address,{state:'completed',result}))
          .catch(error=>{signatures.close();jobs.set(address,{state:'failed',error:error.message?.startsWith('exercise_')?error.message:'exercise_sequence_failed'});});
        return reply(202,{state:'running',productionChanged:false});
      }
      if(req.url==='/fund'){
        return await mutationLock.run(async()=>{
        if(!copiedFunder)throw Error('exercise_funding_unavailable');
        const balance=await token.balanceOf(address),desired=500n*10n**18n;
        if(balance>=desired)return reply(200,{copiedPVTTransferred:'0',productionChanged:false});
        const amount=desired-balance;
        if(address===copiedFunder||await token.balanceOf(copiedFunder)<amount)throw Error('exercise_funding_unavailable');
        await port.mutate('anvil_impersonateAccount',[copiedFunder]);
        await port.mutate('anvil_setBalance',[copiedFunder,toQuantity(100n*10n**18n)]);
        const transactionHash=await port.mutate('eth_sendTransaction',[{from:copiedFunder,to:a.ProvianRecourseKernel,
          data:token.interface.encodeFunctionData('transfer',[address,amount]),gas:toQuantity(200_000)}]);
        const receipt=await exerciseReceipt(provider,transactionHash);
        if(!receipt||BigInt(receipt.status)!==1n)throw Error('exercise_funding_not_confirmed');
        return reply(200,{transactionHash,copiedPVTTransferred:amount.toString(),productionChanged:false});
        });
      }
      if(req.url==='/submit-binding'){
        const b=input.binding;
        if(input.revision!=='1'||b.identity!==identity||b.kernel!==a.ProvianRecourseKernel.toLowerCase()
          ||!/^0x[0-9a-fA-F]{130}$/.test(input.ownerSignature))throw Error('exercise_binding_invalid');
        const signingRoot=await recoverySigningRoot(exerciseSeed('wallet signing '+address));
        if(b.signingRoot!==signingRoot||b.recoveryCommitment!==sha256(concat([exerciseSeed('wallet secret '+address),signingRoot])))throw Error('exercise_binding_material_changed');
        const digest=await registry.bindingDigest(b);
        const data=registry.interface.encodeFunctionData('bind',[b,input.ownerSignature,attestor.signingKey.sign(digest).serialized,1]);
        const transactionHash=await port.mutate('eth_sendTransaction',[{from:manifest.deployer,to:a.ProvianOwnershipRegistry,data,gas:toQuantity(2_000_000)}]);
        return reply(200,{transactionHash,productionChanged:false});
      }
      if(req.url==='/state'){
        const bound=await registry.ownerOf(address),membership=await pool.addressConsent(identity);
        const head=await provider.send('eth_getBlockByNumber',['latest',false]);
        const month=await pool.calendarMonth(BigInt(head.timestamp));
        const period=membership.joined?await pool.consentPeriods(identity,membership.generation):null;
        const debits=period?await provider.send('eth_getLogs',[{address:a.ProvianMemberRecoursePool,
          fromBlock:toQuantity(period.startBlock),toBlock:'latest',
          topics:[pool.interface.getEvent('MembershipDebitExecuted').topicHash,null,identity]}]):[];
        const initialBurnPaid=debits.some(log=>{const event=pool.interface.parseLog(log);
          return event.args.month===month&&event.args.burn===100n*10n**18n;});
        return reply(200,{address,identity,bound:bound===identity,member:membership.joined,
          initialBurnPaid,allowance:(await token.allowance(address,a.ProvianMemberRecoursePool)).toString(),balance:(await token.balanceOf(address)).toString(),
          sequenceStarted:existsSync(sequencePath),sequence:existsSync(sequencePath)?JSON.parse(readFileSync(sequencePath,'utf8')):null,exerciseBusy:mutationLock.busy,productionChanged:false});
      }
      const signingRoot=await recoverySigningRoot(exerciseSeed('wallet signing '+address));
      const recoveryCommitment=sha256(concat([exerciseSeed('wallet secret '+address),signingRoot]));
      const latest=await provider.send('eth_getBlockByNumber',['latest',false]);
      const binding={identity,account:address,recoveryCommitment,signingRoot,kernel:a.ProvianRecourseKernel.toLowerCase(),
        nonce:sha256(toUtf8Bytes('EXERCISE ONLY: bind '+address+' '+latest.hash)),expiresAtMs:((BigInt(latest.timestamp)+240n)*1000n).toString()};
      const message=['Provian ownership binding','chain:31337','kernel:'+binding.kernel,'identity:'+identity,'address:'+address,
        'recovery:'+recoveryCommitment,'hash-authority:'+signingRoot,'nonce:'+binding.nonce,'expires:'+binding.expiresAtMs].join('\n');
      const digest=await registry.bindingDigest(binding);
      await port.mutate('anvil_setBalance',[address,toQuantity(100n*10n**18n)]);
      return reply(200,{binding,pointer:a.ProvianProtocolPointer.toLowerCase(),messageHex:hexlify(toUtf8Bytes(message)),attestorSignature:attestor.signingKey.sign(digest).serialized,revision:'1'});
    } catch(error){reply(400,{error:error.message?.startsWith('exercise_')?error.message:'exercise_request_failed'});}
  });
  server.once('close',()=>signatures.close());
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(18546,'127.0.0.1',resolve);});
  return server;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  startExerciseWorkbench(process.argv[2],process.argv[3]).then(()=>console.log('Isolated exercise: '+origin)).catch(error=>{
    console.error(error.message?.startsWith('exercise_')?error.message:'exercise_workbench_failed');process.exitCode=1;
  });
}
