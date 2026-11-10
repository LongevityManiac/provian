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
import { recoverySigningRoot } from '../../provian-agent-sdk/dist/recourse-hash-authorization.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const origin = 'http://127.0.0.1:18546';
const artifactAbi = name => JSON.parse(readFileSync(resolve(root, `contracts/out/${name}.sol/${name}.json`), 'utf8')).abi;
const page = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Isolated Recourse exercise</title><style>body{font:17px system-ui;max-width:780px;margin:48px auto;padding:20px;background:#11151c;color:#edf0f5}button{font:inherit;margin:8px;padding:12px;border-radius:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere}small{color:#bdc7d5}</style>
<h1>Isolated Recourse exercise</h1><p>This is a private copy of Base on chain 31337. Balances and transactions here do not change Base. Recovery material on this exercise is public test material.</p>
<p>Connect your wallet or your agent's wallet to exercise its copied balance. The wallet signs a binding explicitly scoped to chain 31337.</p>
<button id="connect">Connect wallet</button><button id="fund" disabled>Top up copied PVT</button><button id="bind" disabled>Bind this address</button><button id="join" disabled>Join Recourse Pool</button><button id="exercise" disabled>Exercise reversal and pool restoration</button><button id="refresh" disabled>Refresh</button><pre id="status">Connect a browser wallet to begin.</pre>
<p>The top-up transfers only copied PVT from the exercise funding address. The restoration exercise advances this local chain by a month, uses local impersonation to simulate a loss, then returns 60 PVT by reversal and 40 PVT from the pool to a public test destination. Exchange evidence is synthetic. Your actual wallet signature is used for binding and joining.</p>
<small>No seed or private key is requested. The permanent production pointer and all public services remain unchanged.</small>
<script type="module" src="/client.js"></script></html>`;
const client = `import { Interface, formatEther } from '/ethers.js';
const status=document.querySelector('#status');let account,config,identity;
const show=value=>status.textContent=typeof value==='string'?value:JSON.stringify(value,null,2);
async function api(path,body){const r=await fetch(path,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});const v=await r.json();if(!r.ok)throw Error(v.error);return v;}
async function chain(){if(await ethereum.request({method:'eth_chainId'})!=='0x7a69')throw Error('Switch to Isolated Recourse (31337) before signing.');}
async function send(to,data){await chain();const current=await ethereum.request({method:'eth_accounts'});if(current[0]?.toLowerCase()!==account.toLowerCase())throw Error('Wallet changed; connect again.');const hash=await ethereum.request({method:'eth_sendTransaction',params:[{from:account,to,data}]});show({transaction:hash});for(let i=0;i<120;i++){let r;try{r=await ethereum.request({method:'eth_getTransactionReceipt',params:[hash]});}catch{}if(r){if(BigInt(r.status)!==1n)throw Error('Exercise transaction reverted.');return hash;}await new Promise(r=>setTimeout(r,500));}throw Error('Receipt still pending. Refresh before retrying.');}
async function refresh(){const v=await api('/state',{address:account});identity=v.identity;show({...v,balancePVT:formatEther(v.balance)});document.querySelector('#bind').disabled=v.bound;document.querySelector('#join').disabled=!v.bound||v.member;document.querySelector('#fund').disabled=!config.copiedFunder;document.querySelector('#exercise').disabled=!v.bound||!v.member||v.sequenceStarted||v.exerciseBusy;}
function action(id,fn){document.querySelector(id).onclick=async()=>{try{await fn();}catch(e){show(e.message);}};}
action('#connect',async()=>{if(!window.ethereum)throw Error('A browser wallet is required.');config=await api('/manifest');[account]=await ethereum.request({method:'eth_requestAccounts'});await ethereum.request({method:'wallet_addEthereumChain',params:[{chainId:'0x7a69',chainName:'Isolated Recourse',rpcUrls:['http://127.0.0.1:18545'],nativeCurrency:{name:'Exercise ETH',symbol:'ETH',decimals:18}}]});await ethereum.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x7a69'}]});await chain();document.querySelector('#refresh').disabled=false;await refresh();});
action('#bind',async()=>{await chain();const b=await api('/binding',{address:account});const signature=await ethereum.request({method:'personal_sign',params:[b.messageHex,account]});const data=new Interface(config.registryAbi).encodeFunctionData('bind',[b.binding,signature,b.attestorSignature,b.revision]);await send(config.registry,data);await refresh();});
action('#join',async()=>{const token=new Interface(config.tokenAbi),pool=new Interface(config.poolAbi);await send(config.kernel,token.encodeFunctionData('approve',[config.pool,200n*10n**18n]));await send(config.pool,pool.encodeFunctionData('enroll',[identity]));await refresh();});
action('#fund',async()=>{show(await api('/fund',{address:account}));await refresh();});
action('#exercise',async()=>{document.querySelector('#exercise').disabled=true;show('Running the isolated loss, reversal and pool restoration. This uses only local copied balances.');show(await api('/exercise',{address:account}));});
action('#refresh',refresh);`;

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
      if (req.method !== 'POST' || !['/state','/binding','/submit-binding','/fund','/exercise'].includes(req.url) || req.headers['content-type'] !== 'application/json'
        || req.headers.origin !== origin) return reply(403,{error:'exercise_request_refused'});
      let body='';for await(const chunk of req){body+=chunk.toString();if(Buffer.byteLength(body)>4096)throw Error('exercise_request_too_large');}
      const input=JSON.parse(body);
      const address=getAddress(req.url==='/submit-binding'?input.binding?.account:input.address).toLowerCase();
      const identity=sha256(toUtf8Bytes('EXERCISE ONLY: wallet identity '+address));
      const sequencePath=resolve(directory,`sequence-${address}.json`);
      if(req.url==='/exercise'){
        return await mutationLock.run(async()=>{
          if(await registry.ownerOf(address)!==identity||!(await pool.membershipState(identity)).protectedNow)throw Error('exercise_bound_member_required');
          return reply(200,await exerciseSequence(directory,address,address));
        });
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
        const bound=await registry.ownerOf(address),membership=await pool.membershipState(identity);
        return reply(200,{address,identity,bound:bound===identity,member:membership.protectedNow,balance:(await token.balanceOf(address)).toString(),
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
      return reply(200,{binding,messageHex:hexlify(toUtf8Bytes(message)),attestorSignature:attestor.signingKey.sign(digest).serialized,revision:'1'});
    } catch(error){reply(400,{error:error.message?.startsWith('exercise_')?error.message:'exercise_request_failed'});}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(18546,'127.0.0.1',resolve);});
  return server;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  startExerciseWorkbench(process.argv[2],process.argv[3]).then(()=>console.log('Isolated exercise: '+origin)).catch(error=>{
    console.error(error.message?.startsWith('exercise_')?error.message:'exercise_workbench_failed');process.exitCode=1;
  });
}
