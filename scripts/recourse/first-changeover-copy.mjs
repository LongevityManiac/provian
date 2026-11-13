#!/usr/bin/env -S tsx
import { readFileSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_TRANSACTION_GAS_LIMIT, boundedGasEstimate, assertBaseTransactionGasLimit } from './transaction-gas-limit.mjs';
import { Wallet, sha256, toUtf8Bytes, toQuantity } from 'ethers';
import { createFakeFirestore } from '../../provian-backend/src/core/pvt/__test-helpers__/fake-firestore.ts';
import { openHashAuthorityOperationStore } from '../../provian-backend/src/core/recourse/hash-authority-operation-store.ts';
import { recoverySigningRoot } from '../../provian-agent-sdk/dist/recourse-hash-authorization.js';
import { isolatedCopyPort } from './copy-port.mjs';
import { snapshotRpcPort } from './snapshot-cli.mjs';
import { readSuccessorArtifacts } from './successor-preflight.mjs';
import { permanentPointerPlan } from './permanent-pointer-plan.mjs';
import { openChangeoverArtifacts } from './changeover-artifacts.mjs';
import { advanceFirstChangeover } from './first-changeover.mjs';
import { runPublicationDelivery } from './publication-runtime.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const ensure = (value, reason) => { if (!value) throw Error('changeover_copy_' + reason); };
const hash = value => sha256(toUtf8Bytes(JSON.stringify(value)));
const seed = value => new Uint8Array(Buffer.from(sha256(toUtf8Bytes('PUBLIC SIMULATOR ONLY: ' + value)).slice(2), 'hex'));

/** Full production planners/verifiers and publication engine, with two explicit
 * simulation boundaries: locally impersonated admin transactions (no real
 * wallet signature) and two adapters to ONE instant-finality Anvil copy. This
 * proves execution/state behavior, never independent-provider consensus or a
 * real-wallet signing exercise. Historical cache originated from two operators. */
export async function rehearseFirstChangeover(config) {
  const output = resolve(config.outputDirectory); mkdirSync(output, { recursive: true, mode: 0o700 });
  const local = isolatedCopyPort(config), metadata = await local.verify();
  const historical = snapshotRpcPort(['https://base-rpc.publicnode.com', 'https://base.drpc.org']);
  ensure(await historical.blockHash(metadata.forkedNetwork.forkBlockNumber) === config.forkHash, 'fork_not_canonical');
  const save = (name, value) => {
    const path = resolve(output, name), temp = path + '.tmp';
    const fd = openSync(temp, 'w', 0o600);
    try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path); const directory = openSync(output, 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
  };
  const deployment = read(resolve(root, 'contracts/deployments/base-pvt9-institutions.json'));
  const cache = read(resolve(config.historyCache));
  const legacy = [deployment.wiring.pvt, ...['escrowV4', 'promiseV3', 'poolV3', 'bondPool', 'courtV2'].map(key => deployment.contracts[key].address)];
  ensure(cache.forkHash === config.forkHash && cache.to === metadata.forkedNetwork.forkBlockNumber
    && cache.digest === hash(cache.logs) && JSON.stringify(cache.addresses) === JSON.stringify(legacy), 'history_cache_changed');
  const request = async (method, params) => {
    for (let attempt = 0; ; attempt++) {
      try { return await local.request(method, method === 'eth_getBlockByNumber' && params[0] === 'finalized' ? ['latest', false] : params); }
      catch (error) {
        // Historical transaction reads are rate limited too, not just eth_call.
        // Never replay a write here: its durable execution journal owns retries.
        const readOnly = /^(eth_get|eth_call$|eth_estimateGas$|eth_blockNumber$|eth_chainId$|eth_gasPrice$)/.test(method);
        if (!readOnly || error.message !== 'copy_port_rate_limit' || attempt === 7) throw error;
        save('progress.json', { phase: 'rpc-read-retry', attempt, method });
        await new Promise(resolve => setTimeout(resolve, Math.min(30000, 2000 * 2 ** attempt)));
      }
    }
  };
  const immutableReads = new Map();
  let readCount = 0;
  const immutable = async (method, params) => {
    const key = JSON.stringify([method, params]); if (!immutableReads.has(key)) {
      for (let attempt = 0; ; attempt++) {
        try { const value = await request(method, params); immutableReads.set(key, value); break; }
        catch (error) {
          if (error.message !== 'copy_port_rate_limit' || attempt === 7) throw error;
          save('progress.json', { phase: 'snapshot-read-retry', reads: readCount, attempt, method });
          await new Promise(resolve => setTimeout(resolve, Math.min(30000, 2000 * 2 ** attempt)));
        }
      }
      if (++readCount % 100 === 0) save('progress.json', { phase: 'pinned-read', reads: readCount, method });
    } return structuredClone(immutableReads.get(key));
  };
  const port = {
    // Deliberately distinct adapter labels, NOT independent chain operators.
    rpcs: ['copy-adapter-one', 'copy-adapter-two'].map(operatorId => ({ operatorId, request })),
    finalizedBlock: async () => { await local.verify(); const block = await request('eth_getBlockByNumber', ['latest', false]);
      return { number: Number(BigInt(block.number)), hash: block.hash }; },
    blockHash: async n => (await request('eth_getBlockByNumber', [toQuantity(n), false])).hash,
    call: (to, data, blockHash) => immutable('eth_call', [{ to, data }, { blockHash, requireCanonical: true }]),
    code: (to, blockHash) => immutable('eth_getCode', [to, { blockHash, requireCanonical: true }]),
    transaction: id => request('eth_getTransactionByHash', [id]),
    logs: async (addresses, from, to, topics) => {
      const targets = (Array.isArray(addresses) ? addresses : [addresses]).map(address => address.toLowerCase());
      const result = [];
      if (from <= cache.to) {
        ensure(from >= cache.from && targets.every(address => cache.addresses.some(row => row.toLowerCase() === address)), 'uncached_historical_range');
        result.push(...cache.logs.filter(log => targets.includes(log.address.toLowerCase()) && Number(BigInt(log.blockNumber)) >= from
          && Number(BigInt(log.blockNumber)) <= Math.min(to, cache.to)
          && (!topics || topics.every((topic, i) => topic === null || (Array.isArray(topic) ? topic.includes(log.topics[i]) : topic === log.topics[i])))));
      }
      if (to > cache.to) result.push(...await request('eth_getLogs', [{ address: addresses, fromBlock: toQuantity(Math.max(from, cache.to + 1)), toBlock: toQuantity(to), ...(topics ? { topics } : {}) }]));
      return result.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex)));
    },
  };
  const wallet = role => new Wallet(Buffer.from(seed(config.instanceId + role)).toString('hex'));
  const deployer = wallet('deployer'), gas = wallet('gas');
  const initialSeed = seed(config.instanceId + 'authority'), initialRoot = await recoverySigningRoot(initialSeed);
  const pointerPlan = permanentPointerPlan(initialRoot), ruleBody = { ...read(resolve(root, 'config/recourse-membership-rule.json')), pointer: pointerPlan.pointer };
  const rule = { rule: ruleBody, ruleHash: sha256(toUtf8Bytes('Provian Recourse Pool membership rule\n' + JSON.stringify(ruleBody) + '\n')) };
  const inputs = { deployment, artifacts: readSuccessorArtifacts(root), pointerPlan,
    pin: { chainId: 8453, address: pointerPlan.pointer, runtimeHash: pointerPlan.pointerRuntimeHash }, rule,
    legacyTokens: read(resolve(root, 'config/pvt9-base.json')).validation.forbidden_pvt_addresses,
    deployer: deployer.address.toLowerCase(), identityAttestor: wallet('attestor').address.toLowerCase(),
    batchApprover: wallet('approver').address.toLowerCase(), submitter: wallet('submitter').address.toLowerCase(),
    importBatchSize: config.importBatchSize ?? 32, callGas: config.callGas ?? '4000000', port };
  const artifactsState = openChangeoverArtifacts(resolve(output, 'phases'));
  const timingPath = resolve(output, 'phase-timings.json');
  const timings = existsSync(timingPath) ? read(timingPath) : { startedAt: new Date().toISOString(), phases: {} };
  let activePhase;
  const beginPhase = phase => {
    const now = Date.now();
    if (activePhase && activePhase !== phase && !timings.phases[activePhase].endedAt) {
      const prior = timings.phases[activePhase]; prior.endedAt = new Date(now).toISOString();
      prior.wallClockMs = now - Date.parse(prior.startedAt);
    }
    if (phase && !timings.phases[phase]) timings.phases[phase] = { startedAt: new Date(now).toISOString() };
    activePhase = phase; save('phase-timings.json', timings);
  };
  const nextPhase = { 'retirement-complete': 'pointer', 'pointer-complete': 'successor',
    'successor-complete': 'publication', 'publication-complete': 'activation' };
  const state = { read: name => artifactsState.read(name), create: async (name, value) => {
    const result = await artifactsState.create(name, value);
    if (nextPhase[name]) beginPhase(nextPhase[name]);
    return result;
  } };
  beginPhase('retirement');
  const journalPath = resolve(output, 'impersonated-transactions.json');
  const journal = existsSync(journalPath) ? read(journalPath) : {};
  const runtime = async (stage, options) => {
    const stageDigest = hash({ planDigest: stage.planDigest, steps: stage.steps });
    await stage.assertPlan({ planDigest: stage.planDigest, stageDigest, steps: stage.steps });
    if (options.requireCompleted) ensure(journal[options.phase]?.completed, 'terminal_journal_missing');
    const entry = journal[options.phase] ??= { stageDigest, transactions: [], completed: false };
    ensure(entry.stageDigest === stageDigest, 'stage_changed');
    for (let index = 0; index < stage.steps.length; index++) {
      const step = stage.steps[index]; let txHash = entry.transactions[index];
      if (!txHash) {
        ensure(!options.requireCompleted, 'terminal_transaction_missing');
        await local.request('anvil_impersonateAccount', [step.from]);
        await local.request('anvil_setBalance', [step.from, toQuantity(100n * 10n ** 18n)]);
        const nonce = Number(BigInt(await request('eth_getTransactionCount', [step.from, 'pending'])));
        ensure(step.nonce === undefined || step.nonce === nonce, 'nonce_changed');
        const transaction={from:step.from,...(step.to?{to:step.to}:{}),data:step.data,value:'0x0',nonce:toQuantity(nonce)};
        const gas=boundedGasEstimate(BigInt(await request('eth_estimateGas',[transaction])));
        txHash=await local.request('eth_sendTransaction',[{...transaction,gas:toQuantity(gas)}]);
        entry.transactions[index] = txHash; save('impersonated-transactions.json', journal);
      }
      let receipt;
      for (let poll = 0; poll < 100; poll++) {
        receipt = await request('eth_getTransactionReceipt', [txHash]); if (receipt) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const tx = await request('eth_getTransactionByHash', [txHash]);
      ensure(receipt && receipt.status === '0x1' && receipt.blockHash === await port.blockHash(Number(BigInt(receipt.blockNumber)))
        && tx.from.toLowerCase() === step.from && (tx.to?.toLowerCase() ?? null) === (step.to ?? null)
        && tx.input === step.data && BigInt(tx.value) === 0n
        && (step.to || !step.address || receipt.contractAddress?.toLowerCase() === step.address), 'transaction_not_proven');
      assertBaseTransactionGasLimit(BigInt(tx.gas));
      entry.gas ??= []; entry.gas[index]={label:step.label,transactionHash:txHash,gasLimit:String(BigInt(tx.gas)),gasUsed:String(BigInt(receipt.gasUsed))};
      save('impersonated-transactions.json',journal);
      save('progress.json', { phase: options.phase, step: index + 1, total: stage.steps.length, label: step.label });
    }
    await stage.assertPlan({ planDigest: stage.planDigest, stageDigest, steps: stage.steps });
    entry.completed = true; save('impersonated-transactions.json', journal); return { status: 'confirmed' };
  };
  const db = createFakeFirestore({ strictTransactionOrder: true }), dbPath = resolve(output, 'copy-database.json');
  if (existsSync(dbPath)) for (const [key, value] of read(dbPath)) db.store.set(key, value);
  const transaction = db.runTransaction;
  db.runTransaction = async action => { const result = await transaction(action); save('copy-database.json', [...db.store]); return result; };
  const authorityStore = openHashAuthorityOperationStore(db), vaultPath = resolve(output, 'PUBLIC-TEST-ONLY-authority-vault.json');
  const records = existsSync(vaultPath) ? read(vaultPath) : [{ id: 'fixture-initial', record: { schema: 'provian.hash-authority.v1', root: initialRoot,
    seed: Buffer.from(initialSeed).toString('hex'), parent: null, intent: null } }];
  save('PUBLIC-TEST-ONLY-authority-vault.json', records); initialSeed.fill(0);
  const vault = { create: async record => { const id = 'fixture-' + records.length; records.push({ id, record }); save('PUBLIC-TEST-ONLY-authority-vault.json', records); return id; },
    read: async id => structuredClone(records.find(row => row.id === id)), byRoot: async root => structuredClone(records.find(row => row.record.root === root)) };
  await local.request('anvil_setBalance', [gas.address, toQuantity(100n * 10n ** 18n)]);
  const publish = (publication, options) => runPublicationDelivery({ inputs: publication, db, from: gas.address.toLowerCase(),
    store: authorityStore, vault, requireCompleted: options.requireCompleted, approvedBudgetWei: '10000000000000000000',
    maxFeePerGas: 10000000000n, maxPriorityFeePerGas: 1000000n, maxGas: BASE_TRANSACTION_GAS_LIMIT,
    loadSigner: async address => { ensure(address === gas.address.toLowerCase(), 'gas_signer_changed'); return gas; } });
  save('copy-description.json', { instanceId: config.instanceId, forkHash: config.forkHash, pointer: pointerPlan.pointer,
    boundary: 'Local impersonated admin; public fixture hash keys; one simulator with instant finality; no live transaction or real wallet signature.' });
  for (;;) {
    const result = await advanceFirstChangeover({ inputs, state, execute: true, runtime, publish, authorityStore });
    save('progress.json', result); console.log(JSON.stringify(result));
    if (result.status === 'confirmed') {
      const restarted = await advanceFirstChangeover({ inputs, state, execute: false, runtime, publish, authorityStore });
      ensure(restarted.status === 'confirmed', 'terminal_restart_failed');
      beginPhase(null);
      save('result.json', { result, restarted, transactions: Object.values(journal).reduce((n, row) => n + row.transactions.length, 0),
        publicationDocuments: db.store.size });
      const phases={};
      for(const [phase,entry]of Object.entries(journal))phases[phase]=entry.gas;
      const publication=[];
      for(const [,doc]of db.store){const raw=doc.variant?.raw;if(typeof raw!=='string')continue;
        const {Transaction}=await import('ethers');const tx=Transaction.from(raw);
        const receipt=await request('eth_getTransactionReceipt',[tx.hash]);
        if(receipt){assertBaseTransactionGasLimit(tx.gasLimit);publication.push({transactionHash:tx.hash,gasLimit:String(tx.gasLimit),gasUsed:String(BigInt(receipt.gasUsed))});}}
      phases.publication=publication;
      save('gas-report.json',{limit:String(BASE_TRANSACTION_GAS_LIMIT),phases:Object.fromEntries(Object.entries(phases).map(([phase,rows])=>[phase,{transactions:rows,maxGasLimit:rows.reduce((a,r)=>BigInt(r.gasLimit)>BigInt(a)?r.gasLimit:a,'0'),maxGasUsed:rows.reduce((a,r)=>BigInt(r.gasUsed)>BigInt(a)?r.gasUsed:a,'0')}]))}); return;
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  rehearseFirstChangeover(read(resolve(process.argv[2]))).catch(error => { console.error(error.stack); process.exitCode = 1; });
}
