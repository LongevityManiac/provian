import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AbiCoder, Interface, ZeroAddress, ZeroHash, keccak256, sha256 } from 'ethers';
import { buildSuccessionSnapshot, merkle, verifyProof } from './snapshot.mjs';
const kernelAbi = JSON.parse(readFileSync(new URL('../../contracts/out/ProvianPVT9.sol/ProvianPVT9.json', import.meta.url), 'utf8')).abi;
const iface = new Interface(kernelAbi), coder = AbiCoder.defaultAbiCoder();
const address = digit => `0x${digit.repeat(40)}`;
const kernel = address('1'), owner = address('2'), other = address('3'), company = address('4'), foundation = address('5');
const hash = text => sha256(Buffer.from(text));
const blockHash = hash('snapshot block TEST ONLY'), transactionHash = hash('settlement transaction TEST ONLY');
const id = hash('batch TEST ONLY'), claimId = hash('claim TEST ONLY'), wallet = hash('wallet TEST ONLY');
const anchor = hash('anchor TEST ONLY'), anchorKey = hash('anchor key TEST ONLY'), policyHash = hash('policy TEST ONLY');
const claimsHash = hash('claims TEST ONLY'), digest = hash('settlement digest TEST ONLY');
const unit = 10n ** 18n;

function fixture(claimCount = 1) {
  const verifier = { verifier: address('6'), configurationId: hash('verifier TEST ONLY'), version: 1n };
  const noVerifier = { verifier: ZeroAddress, configurationId: ZeroHash, version: 0n };
  const policy = { opened: true, epoch: 0n, startsAt: 1n, combinedCapMode: 1n, mintRate: unit,
    genesisCap: 7_500_000n * unit, combinedCap: 10_000_000n * unit, provianTreasury: company,
    foundationTreasury: foundation, agentFoundationBps: 50n, beneficiaryVerifier: noVerifier, eligibilityVerifier: verifier, policyHash };
  const record = { settled: true, lane: 1n, epoch: 0n, finalizedCursorStart: 0n, finalizedCursorEnd: 1n,
    policyHash, claimsHash, settlementDigest: digest, grossInput: 75n * unit, totalMinted: 75n * unit,
    contributorTotal: 7425n * unit / 100n, provianTotal: 375n * unit / 1000n, foundationTotal: 375n * unit / 1000n,
    recipientCount: 1n, claimCount: BigInt(claimCount) };
  const recipients = [{ contributor: owner, claimCount: BigInt(claimCount) }];
  const claims = Array.from({length:claimCount},(_,index)=>({ claimId:index===0?claimId:hash(`claim ${index} TEST ONLY`),
    walletId:wallet,oneTimeAnchor:index===0?anchor:hash(`anchor ${index} TEST ONLY`),grantType:0n,qualifiedAt:2n,reservedGrossAtomic:75n*unit/BigInt(claimCount) }));
  const input = iface.encodeFunctionData('settleGenesisPEBatch', [id, 0, policyHash, 0, 1, recipients, claims]);
  const logs = [];
  function event(name, args) {
    logs.push({ ...iface.encodeEventLog(iface.getEvent(name), args), address: kernel, blockNumber: '0xa', blockHash,
      transactionHash, transactionIndex: '0x0', logIndex: `0x${logs.length.toString(16)}`, removed: false });
  }
  event('SettlementBatchBound', [id, 1, 0, policyHash, 0, 1, claimsHash, digest]);
  event('Transfer', [ZeroAddress, owner, record.contributorTotal]);
  event('Transfer', [ZeroAddress, company, record.provianTotal]);
  event('Transfer', [ZeroAddress, foundation, record.foundationTotal]);
  event('Transfer', [owner, other, 7n * unit]);
  event('Transfer', [owner, ZeroAddress, 5n * unit]);
  const balances = new Map([[owner, record.contributorTotal - 12n * unit], [other, 7n * unit],
    [company, record.provianTotal], [foundation, record.foundationTotal]]);
  const values = { totalSupply: 70n * unit, lastOpenedEpoch: 0n, getEpochPolicy: policy,
    operationalMinter: ZeroAddress,
    epochZeroStartsAt: 1n, genesisStartsAt: 1n, genesisEndsAt: 100n, genesisAdmissionClosed: false,
    genesisAdmissionCutoff: 0n, nextFinalizedCursor: 1n, administrativeHold: true,
    epochGenesisIssued: 75n * unit, epochTotalIssued: 75n * unit, getBatchRecord: record,
    claimSettled: true, genesisAnchorKey: anchorKey, genesisAnchorUsed: true,
    genesisWalletGrossIssued: 75n * unit, hashGenesisClaims: claimsHash };
  const tx = { hash: transactionHash, blockHash, to: kernel, input };
  const port = {
    async call(to, data, pin) {
      assert.equal(pin, blockHash);
      if (to.toLowerCase() !== kernel) {
        const external = new Interface(['function administrativeHold() view returns(bool)', 'function batchApprover() view returns(address)', 'function pvt() view returns(address)']);
        const name = external.parseTransaction({ data }).name;
        return external.encodeFunctionResult(name, [name === 'pvt' ? kernel : name === 'batchApprover' ? ZeroAddress : true]);
      }
      const f = iface.parseTransaction({ data });
      const value = f.name === 'balanceOf' ? balances.get(f.args[0].toLowerCase()) ?? 0n
        : f.name==='genesisAnchorKey'&&claimCount>1?hash(String(f.args[1])):values[f.name];
      assert.notEqual(value, undefined, f.name);
      return iface.encodeFunctionResult(f.name, [value]);
    },
    async logs() { return logs; }, async transaction() { return tx; }, async blockHash(n) { return n === 0 ? ZeroHash : blockHash; },
    async code(to, pin) { return pin === ZeroHash ? '0x' : '0x6000'; },
  };
  return { input: { port, kernelAbi, predecessor: kernel, deploymentBlock: 1, block: 10, blockHash,
    expectedRuntimeHash: keccak256('0x6000'), institutions: ['7','8','9','a','b'].map(address) }, values, tx, logs, balances };
}
test('all nonempty holder, claim, anchor, wallet and batch populations reconcile and prove', async () => {
  const f = fixture(), snapshot = await buildSuccessionSnapshot(f.input);
  assert.deepEqual(snapshot.counts, { logs: 6, holders: 4, batches: 1, claims: 1, anchors: 1, wallets: 1, epochs: 1 });
  assert.equal(snapshot.supply, String(70n * unit));
  assert.equal(snapshot.state.epochTotalIssued, String(75n * unit));
  for (const entry of snapshot.history) assert.ok(verifyProof(entry.leaf, entry.proof, snapshot.historyRoot));
  for (const entry of snapshot.balances) assert.ok(verifyProof(entry.leaf, entry.proof, snapshot.balanceRoot));
  const batch = snapshot.history.find(e => e.type === 'batch');
  assert.equal(batch.record.settlementDigest, digest);
  assert.equal(coder.encode([iface.getFunction('getBatchRecord').outputs[0]], [batch.record]),
    coder.encode([iface.getFunction('getBatchRecord').outputs[0]], [f.values.getBatchRecord]));
});

test('concurrent claim reads remain bounded and preserve proof order; duplicates fail before reads',async()=>{
  const normal=fixture(16),expected=await buildSuccessionSnapshot(normal.input);
  const delayed=fixture(16),original=delayed.input.port.call;
  let active=0,maximum=0,reads=0;
  delayed.input.port.call=async(to,data,pin)=>{
    if(to===kernel&&iface.parseTransaction({data})?.name==='claimSettled'){
      ++reads;++active;maximum=Math.max(maximum,active);
      await new Promise(resolve=>setTimeout(resolve,reads%2?5:0));
      --active;
    }
    return original(to,data,pin);
  };
  const actual=await buildSuccessionSnapshot(delayed.input);
  assert.equal(reads,16);assert.ok(maximum>1&&maximum<=8);
  assert.deepEqual(actual.history,expected.history);assert.equal(actual.historyRoot,expected.historyRoot);
  const duplicate=fixture(16),parsed=iface.parseTransaction({data:duplicate.tx.input});
  const args=parsed.args.toArray(true);args[6][1][0]=args[6][0][0];
  duplicate.tx.input=iface.encodeFunctionData(parsed.name,args);
  const delegate=duplicate.input.port.call;let attempted=0;
  duplicate.input.port.call=async(to,data,pin)=>{
    if(to===kernel&&iface.parseTransaction({data})?.name==='claimSettled')++attempted;
    return delegate(to,data,pin);
  };
  await assert.rejects(buildSuccessionSnapshot(duplicate.input),/snapshot_claim_replay_or_missing/);
  assert.equal(attempted,0);
});
test('transfer omission, balance substitution, supply drift and duplicate logs are refused', async () => {
  for (const change of [
    f => f.logs.splice(1, 1),
    f => f.balances.set(owner, 0n),
    f => { f.values.totalSupply += 1n; },
    f => f.logs.push(f.logs.at(-1)),
    f => { f.logs.length = 0; },
  ]) { const f = fixture(); change(f); await assert.rejects(buildSuccessionSnapshot(f.input), /snapshot_/); }
});
test('settlement input, consumed anchor and canonical-block substitutions are refused', async () => {
  for (const change of [
    f => { f.tx.to = other; }, f => { f.tx.blockHash = ZeroHash; },
    f => { f.values.hashGenesisClaims = ZeroHash; }, f => { f.values.claimSettled = false; },
    f => { f.values.genesisAnchorUsed = false; }, f => { f.values.epochTotalIssued += 1n; },
    f => { f.input.port.blockHash = async () => ZeroHash; },
  ]) { const f = fixture(); change(f); await assert.rejects(buildSuccessionSnapshot(f.input), /snapshot_/); }
});
test('custody cannot silently mint the successor backing into the retired institution', async () => {
  const f = fixture(); f.input.institutions[0] = owner;
  await assert.rejects(buildSuccessionSnapshot(f.input), /snapshot_custody_destination_required/);
  f.input.destinations = { [owner]: address('7') };
  const result = await buildSuccessionSnapshot(f.input);
  assert.equal(result.balances.find(b => b.previousOwner === owner).destination, address('7'));
  f.input.destinations = { [owner]: owner };
  await assert.rejects(buildSuccessionSnapshot(f.input), /snapshot_invalid_custody_mapping/);
  f.input.destinations = { [other]: address('7') };
  await assert.rejects(buildSuccessionSnapshot(f.input), /snapshot_invalid_custody_mapping/);
});
test('an incomplete inventory, late deployment boundary, live minter or wrong runtime cannot define a snapshot', async () => {
  for (const change of [
    f => { f.input.institutions = []; }, f => { f.input.institutions = undefined; },
    f => { f.input.deploymentBlock = 2; }, f => { f.input.expectedRuntimeHash = ZeroHash; },
    f => { f.values.administrativeHold = false; }, f => { f.values.operationalMinter = owner; },
  ]) { const f = fixture(); change(f); await assert.rejects(buildSuccessionSnapshot(f.input), /snapshot_/); }
});
test('odd Merkle populations and substituted leaves have independent negative controls', () => {
  const leaves = ['a', 'b', 'c', 'd', 'e'].map(hash), tree = merkle(leaves);
  leaves.forEach((leaf, i) => { assert.ok(verifyProof(leaf, tree.proofs[i], tree.root));
    assert.equal(verifyProof(ZeroHash, tree.proofs[i], tree.root), false); });
  assert.throws(() => merkle([leaves[0], leaves[0]]), /duplicate/);
});

test('successor exporter carries imported history and restored balances without counting imports as new work', async () => {
  const f=fixture(),prior=await buildSuccessionSnapshot(f.input);
  const nextAbi=JSON.parse(readFileSync(new URL('../../contracts/out/ProvianRecourseKernel.sol/ProvianRecourseKernel.json',import.meta.url))).abi;
  const next=new Interface(nextAbi),historyAddress=address('c'),authAddress=address('e');
  const hAbi=new Interface(JSON.parse(readFileSync(new URL('../../contracts/out/ProvianRecoveryHistory.sol/ProvianRecoveryHistory.json',import.meta.url))).abi);
  const originalCall=f.input.port.call;
  f.input.kernelAbi=nextAbi;f.input.priorSnapshot=prior;f.input.institutions.push(address('d'));
  f.logs.length=0;
  for(const [account,amount] of f.balances)f.logs.push({...next.encodeEventLog(next.getEvent('Transfer'),[ZeroAddress,account,amount]),
    address:kernel,blockNumber:'0xa',blockHash,transactionHash,transactionIndex:'0x0',logIndex:`0x${f.logs.length.toString(16)}`,removed:false});
  f.input.port.logs=async target=>target.toLowerCase()===authAddress?[]:f.logs;
  f.input.port.call=async(to,data,pin)=>{
    if(to.toLowerCase()===historyAddress){const q=hAbi.parseTransaction({data});return hAbi.encodeFunctionResult(q.name,[{
      root:prior.historyRoot,entryCount:prior.historyCount,predecessor:prior.predecessor,lastGoodBlock:prior.block,complete:true,state:prior.state}[q.name]]);}
    if(to.toLowerCase()===kernel){const q=next.parseTransaction({data});
      if(['predecessorHistory','restoredBalance','ownerAuthorization'].includes(q.name))return next.encodeFunctionResult(q.name,[{
        predecessorHistory:historyAddress,restoredBalance:70n*unit,ownerAuthorization:authAddress}[q.name]]);}
    return originalCall(to,data,pin);
  };
  const result=await buildSuccessionSnapshot(f.input);
  assert.equal(result.supply,prior.supply);assert.equal(result.history.length,prior.history.length);
  assert.equal(result.counts.batches,1);assert.equal(result.counts.claims,1);assert.equal(result.counts.anchors,1);
  assert.equal(result.state.epochTotalIssued,prior.state.epochTotalIssued);
  f.input.priorSnapshot={...prior,history:prior.history.slice(1)};
  await assert.rejects(buildSuccessionSnapshot(f.input),/snapshot_prior_artifact_required/);
});

test('explicit break mode can snapshot the last-good block before shutdown; ordinary mode still refuses',async()=>{
 const f=fixture();f.values.administrativeHold=false;f.values.operationalMinter=owner;
 await assert.rejects(buildSuccessionSnapshot(f.input),/snapshot_predecessor_not_retired/);
 const snapshot=await buildSuccessionSnapshot({...f.input,mode:'cryptographic-break'});
 assert.equal(snapshot.mode,'cryptographic-break');assert.equal(snapshot.supply,'70000000000000000000');
 assert.equal(snapshot.state.administrativeHold,false);
});
