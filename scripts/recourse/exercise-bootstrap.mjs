#!/usr/bin/env node
import { readCompiledArtifact } from './compiled-artifact.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Contract, Interface, Wallet, getCreateAddress, hexlify, keccak256, sha256, toUtf8Bytes, toQuantity } from 'ethers';
import { isolatedExercisePort } from './exercise-port.mjs';
import { exerciseRead, exerciseReceipt } from './exercise-read.mjs';
import { exerciseJournal } from './exercise-journal.mjs';
import { buildSuccessionSnapshot } from './snapshot.mjs';
import { verifyInstitutionRuntime } from './institution-snapshot.mjs';
import { snapshotRpcPort } from './snapshot-cli.mjs';
import { recoverySigningRoot, signRecoveryIntent } from '../../provian-agent-sdk/dist/recourse-hash-authorization.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const artifacts = new Map();
const artifact = name => {
  if (artifacts.has(name)) return artifacts.get(name);
  const compiled = readCompiledArtifact(root,name);
  for (const [path, source] of Object.entries(compiled.metadata.sources)) {
    if (keccak256(readFileSync(resolve(root, 'contracts', path))) !== source.keccak256) throw Error(`exercise_stale_compilation:${name}`);
  }
  artifacts.set(name, compiled); return compiled;
};
const zero = `0x${'0'.repeat(40)}`, zeroHash = `0x${'0'.repeat(64)}`;
// Public, reproducible simulator material. Never use these roots on a live chain.
export const exerciseSeed = label => new Uint8Array(Buffer.from(sha256(toUtf8Bytes(`EXERCISE ONLY: ${label}`)).slice(2), 'hex'));
export const exerciseWallet = (instanceId, role) => new Wallet(hexlify(exerciseSeed(`fixture wallet ${instanceId} ${role}`)));

/** A local-fork rehearsal, never a production deployment command. Output and
 * receipts go to an explicit local directory; no public configuration is edited. */
export async function bootstrapExercise(outputDirectory) {
  const port = isolatedExercisePort(), provider = port.provider;
  await port.verify();
  const metadata = await provider.send('anvil_metadata', []);
  if (!metadata.forkedNetwork?.forkBlockHash) throw Error('exercise_base_fork_required');
  const forkBlock = metadata.forkedNetwork.forkBlockNumber;
  const historical = snapshotRpcPort([process.env.BASE_RPC_URL ?? 'https://mainnet.base.org',
    process.env.BASE_RPC_URL_SECONDARY ?? 'https://base.drpc.org'], {
    onLogRange(progress) { save('progress.json', { stage: 'historical-logs', ...progress }); },
  });
  if (await historical.blockHash(forkBlock) !== metadata.forkedNetwork.forkBlockHash) throw Error('exercise_fork_block_mismatch');
  const output = resolve(outputDirectory); mkdirSync(output, { recursive: true, mode: 0o700 });
  const manifestPath = resolve(output, 'exercise.json');
  if (existsSync(manifestPath)) throw Error('exercise_already_initialized');
  const journalPath = resolve(output, 'transactions.json');
  const transactionLog = exerciseJournal(resolve(output, 'transactions.jsonl'),
    existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')) : []);
  const journal = transactionLog.rows;
  if (journal.some(row => row.label.startsWith('deploy:'))) throw Error('exercise_partial_deployment_requires_new_fork');
  function save(name, value) { writeFileSync(resolve(output, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); }
  const current = JSON.parse(readFileSync(resolve(root, 'contracts/deployments/base-pvt9-institutions.json'), 'utf8'));
  const admin = current.wiring.admin, oldKernel = current.wiring.pvt;
  const deployer = exerciseWallet(metadata.instanceId, 'deployer').address;
  const attestor = exerciseWallet(metadata.instanceId, 'attestor').address;
  // Widely published Anvil keys may already have delegated code on the forked
  // chain. Instance-specific public test material avoids inheriting that code.
  if (await provider.getCode(deployer) !== '0x' || await provider.getCode(attestor) !== '0x'
    || attestor.toLowerCase() === admin.toLowerCase()) throw Error('exercise_accounts_not_fresh');
  await port.mutate('anvil_impersonateAccount', [deployer]);
  await port.mutate('anvil_setBalance', [deployer, toQuantity(100n * 10n ** 18n)]);
  await port.mutate('anvil_impersonateAccount', [admin]);
  await port.mutate('anvil_setBalance', [admin, toQuantity(100n * 10n ** 18n)]);
  async function send(from, to, data, label) {
    const tx = { from, data, gas: toQuantity(29_000_000) }; if (to) tx.to = to;
    const hash = await port.mutate('eth_sendTransaction', [tx]);
    transactionLog.submitted(label, hash);
    const receipt = await exerciseReceipt(provider, hash);
    if (receipt) transactionLog.receipt(hash, receipt);
    save('progress.json', { stage: 'transaction', label, hash, transactions: journal.length });
    if (!receipt || BigInt(receipt.status) !== 1n) throw Error(`exercise_transaction_failed:${label}`);
    return receipt;
  }
  async function call(from, address, name, method, args = []) {
    return send(from, address, new Interface(artifact(name).abi).encodeFunctionData(method, args), method);
  }
  // These calls address only the local, independently named fork.
  const oldToken = new Contract(oldKernel, artifact('ProvianPVT9').abi, provider);
  if (!await oldToken.administrativeHold()) await call(admin, oldKernel, 'ProvianPVT9', 'placeAdministrativeHold');
  if (await oldToken.operationalMinter() !== zero) await call(admin, oldKernel, 'ProvianPVT9', 'revokeOperationalMinter');
  const oldPolicy = await oldToken.getEpochPolicy(await oldToken.lastOpenedEpoch());
  const oldVerifier = oldPolicy.eligibilityVerifier.verifier;
  const oldVerifierContract = new Contract(oldVerifier, artifact('ProvianPVT9EligibilityVerifier').abi, provider);
  if (!await oldVerifierContract.administrativeHold()) await call(admin, oldVerifier, 'ProvianPVT9EligibilityVerifier', 'placeAdministrativeHold');
  if (await oldVerifierContract.batchApprover() !== zero) await call(admin, oldVerifier, 'ProvianPVT9EligibilityVerifier', 'revokeBatchApprover');
  const cutoff = await provider.send('eth_getBlockByNumber', ['latest', false]);
  const nonce = Number(BigInt(await provider.send('eth_getTransactionCount', [deployer, 'latest'])));
  const names = ['ProvianHashAccount', 'ProvianProtocolPointer', 'ProvianOwnershipRegistry', 'ProvianRecoveryHistory',
    'ProvianRestorationAuthorization', 'ProvianRecourseKernel', 'ProvianRecourseEligibilityVerifier', 'ProvianEscrowV4',
    'ProvianPromiseV3', 'ProvianPoolV3', 'ProvianBondPool', 'ProvianCourtV2', 'ProvianMemberRecoursePool'];
  // Historical ABIs remain available for the predecessor inventory. Successor
  // deployments use new sources; byte-frozen deployed artifacts are untouched.
  const successorArtifacts = { ProvianEscrowV4: 'ProvianRecourseEscrow', ProvianPoolV3: 'ProvianRecourseProjectPool',
    ProvianBondPool: 'ProvianRecourseBondPool', ProvianCourtV2: 'ProvianRecourseCourt' };
  const addresses = Object.fromEntries(names.map((name, index) => [name, getCreateAddress({ from: deployer, nonce: nonce + index })]));
  const custodyKeys = ['escrowV4', 'promiseV3', 'poolV3', 'bondPool', 'courtV2'];
  const custodyNames = ['ProvianEscrowV4', 'ProvianPromiseV3', 'ProvianPoolV3', 'ProvianBondPool', 'ProvianCourtV2'];
  const institutions = custodyKeys.map(key => current.contracts[key].address);
  const destinations = Object.fromEntries(institutions.map((address, index) => [address.toLowerCase(), addresses[custodyNames[index]]]));
  const blockHash = cutoff.hash, block = Number(BigInt(cutoff.number));
  let snapshotReads = 0;
  const pinnedCall = async (to, data, hash) => {
    const context = { target: to, selector: data.slice(0, 10), blockHash: hash, read: ++snapshotReads };
    save('progress.json', { stage: 'snapshot-read', ...context });
    try { return await exerciseRead(() => provider.send('eth_call', [{ to, data }, { blockHash: hash, requireCanonical: true }]), {
      onRetry: retry => save('progress.json', { stage: 'snapshot-rate-limit-retry', ...context, retry }),
    }); }
    catch (error) {
      throw Object.assign(Error('exercise_pinned_call_failed'), { exerciseCall: { ...context, code: error.code,
        rpcCode: error.info?.error?.code,
        rpcMessage: typeof error.info?.error?.message === 'string'
          ? error.info.error.message.replace(/https?:\S+/g, '[RPC]').slice(0, 400) : undefined } });
    }
  };
  // The same historical range serves the kernel and every custody inventory.
  // Fetch it once from both operators rather than scanning six times. This is
  // in-memory rehearsal data; every new invocation verifies both operators again.
  let historicalLogs;
  const firstDeployment = Math.min(current.successorKernel.pvt9Kernel.block,
    ...custodyKeys.map(key => current.contracts[key].block));
  const historicalCachePath = resolve(output, 'historical-logs.json');
  async function readHistoricalLogs() {
    if (existsSync(historicalCachePath)) {
      const cached = JSON.parse(readFileSync(historicalCachePath, 'utf8'));
      if (cached.forkHash !== metadata.forkedNetwork.forkBlockHash || cached.from !== firstDeployment
        || cached.to !== forkBlock || JSON.stringify(cached.addresses) !== JSON.stringify([oldKernel, ...institutions])
        || sha256(toUtf8Bytes(JSON.stringify(cached.logs))) !== cached.digest) throw Error('exercise_history_cache_mismatch');
      return cached.logs;
    }
    const collected = await historical.logs([oldKernel, ...institutions], firstDeployment, forkBlock);
    // Private rehearsal checkpoint, after both independent operators agree.
    // The canonical fork hash is rechecked by both on every invocation.
    save('historical-logs.json', { forkHash: metadata.forkedNetwork.forkBlockHash,
      from: firstDeployment, to: forkBlock, addresses: [oldKernel, ...institutions], logs: collected,
      digest: sha256(toUtf8Bytes(JSON.stringify(collected))) });
    return collected;
  }
  async function logs(address, from, to) {
    const values = [];
    if (from <= forkBlock) {
      historicalLogs ??= readHistoricalLogs();
      values.push(...(await historicalLogs).filter(log => log.address.toLowerCase() === address.toLowerCase()
        && BigInt(log.blockNumber) >= BigInt(from) && BigInt(log.blockNumber) <= BigInt(Math.min(to, forkBlock))));
    }
    from = Math.max(from, forkBlock + 1);
    async function range(start, end) {
      try { values.push(...await provider.send('eth_getLogs', [{ address, fromBlock: toQuantity(start), toBlock: toQuantity(end) }])); }
      catch (error) {
        if (start === end || /429|request limit|rate limit/i.test(error.message ?? '')
          || !/range|too many (?:results|logs)|response size/i.test(error.message ?? '')) throw error;
        const middle = Math.floor((start + end) / 2); await range(start, middle); await range(middle + 1, end);
      }
    }
    for (let start = from; start <= to; start += 10_000) await range(start, Math.min(to, start + 9_999));
    return values.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex)));
  }
  const chain = { call: pinnedCall, logs,
    code: (to, hash) => provider.send('eth_getCode', [to, { blockHash: hash, requireCanonical: true }]),
    blockHash: async number => (await provider.send('eth_getBlockByNumber', [toQuantity(number), false])).hash,
    transaction: hash => provider.send('eth_getTransactionByHash', [hash]),
  };
  const snapshot = await buildSuccessionSnapshot({ port: chain, kernelAbi: artifact('ProvianPVT9').abi,
    predecessor: oldKernel, deploymentBlock: current.successorKernel.pvt9Kernel.block, block, blockHash,
    expectedRuntimeHash: verifyInstitutionRuntime(artifact('ProvianPVT9'), await chain.code(oldKernel, blockHash)), institutions, destinations });
  save('snapshot.json', { ...snapshot, rehearsalChainId: 31337, fork: metadata.forkedNetwork });
  save('progress.json', { stage: 'snapshot-reconciled', holders: snapshot.balances.length, history: snapshot.history.length });
  const seedEscrows = [], seedBonds = [], seedBps = [];
  for (let index = 0; index < institutions.length; ++index) {
    const name = custodyNames[index], address = institutions[index], iface = new Interface(artifact(name).abi);
    const contract = new Contract(address, iface, provider);
    const deployed = current.contracts[custodyKeys[index]].block;
    if (!Number.isSafeInteger(deployed)) throw Error('exercise_institution_deployment_boundary_missing');
    const history = (await logs(address, deployed, block)).map(log => iface.parseLog(log)).filter(Boolean);
    const balance = await oldToken.balanceOf(address);
    const usdc = new Contract(current.wiring.usdc, ['function balanceOf(address) view returns(uint256)'], provider);
    if (await usdc.balanceOf(address) !== 0n) throw Error('exercise_usdc_liability_requires_migration');
    if (name === 'ProvianEscrowV4') {
      const ids = [...new Set(history.filter(e => ['EscrowCreated', 'EscrowCreatedPVT', 'EscrowCarried'].includes(e.name)).map(e => e.args.escrowId))];
      if (balance !== 0n) throw Error('exercise_funded_escrow_import_required');
      for (const id of ids) {
        const e = await contract.escrows(id);
        if (await contract.pendingWithdrawal(id) !== 0n) throw Error('exercise_escrow_credit_import_required');
        if (e.status === 0n) seedEscrows.push({ escrowId: id, depositor: e.depositor, recipient: e.recipient,
          amount: e.amount, fee: e.fee, autoReleaseAt: e.autoReleaseAt, currency: e.currency });
        else if (![2n, 4n, 5n].includes(e.status)) throw Error('exercise_escrow_state_import_required');
      }
    } else if (name === 'ProvianBondPool') {
      const owners = [...new Set(history.filter(e => ['BondPosted', 'BondCarried'].includes(e.name)).map(e => e.args.agent))];
      let backing = 0n;
      for (const agent of owners) {
        const b = await contract.bonds(agent);
        if (b.pendingClaims !== 0n) throw Error('exercise_bond_dispute_import_required');
        if (b.amount === 0n) continue;
        if (b.status !== 1n) throw Error('exercise_bond_state_import_required');
        backing += b.amount;
        seedBonds.push({ agent, amount: b.amount, autonomyLevel: b.autonomyLevel, createdAt: b.createdAt,
          lastRenewalAt: b.lastRenewalAt, renewalDeadline: b.renewalDeadline, requiredAtPost: await contract.requiredAtPost(agent) });
      }
      if (backing !== balance) throw Error('exercise_bond_backing_mismatch');
      for (const [param, method] of ['activeDepositBurnBps', 'activeDepositFeeBps', 'activeRenewalBurnBps', 'activeRenewalFeeBps'].entries()) {
        const value = await contract[method](); if (value[0]) seedBps.push({ param, bps: value[1] });
      }
    } else if (balance !== 0n || history.some(e => !['BondPoolSet', 'ExecutorWired'].includes(e.name))) {
      throw Error(`exercise_institution_state_import_required:${name}`);
    }
  }
  const state = snapshot.state, a = addresses, kernel = a.ProvianRecourseKernel;
  const rootCommitment = await recoverySigningRoot(exerciseSeed('pointer root 0'));
  const params = {
    ProvianHashAccount: [rootCommitment], ProvianProtocolPointer: [a.ProvianHashAccount],
    ProvianOwnershipRegistry: [a.ProvianProtocolPointer, attestor, false],
    ProvianRecoveryHistory: [oldKernel, block, snapshot.historyRoot, snapshot.historyCount, state],
    ProvianRestorationAuthorization: [kernel, snapshot.balanceRoot, oldKernel, block, false, keccak256(artifact('ProvianHashAccount').deployedBytecode.object), 0],
    ProvianRecourseKernel: [{ authority: admin, root: snapshot.balanceRoot, previousKernel: oldKernel, snapshotBlock: block,
      snapshotTotal: snapshot.supply, history: a.ProvianRecoveryHistory, pointer: a.ProvianProtocolPointer,
      registry: a.ProvianOwnershipRegistry, afterCryptographicBreak: false, authorization: a.ProvianRestorationAuthorization }],
    ProvianRecourseEligibilityVerifier: [kernel, state.eligibilityVerifier.configurationId, state.eligibilityVerifier.version],
    ProvianEscrowV4: [admin, current.wiring.feeWallet, current.wiring.usdc, kernel, kernel, kernel, seedEscrows],
    ProvianPromiseV3: [admin, current.wiring.feeWallet, current.wiring.usdc, kernel, kernel],
    ProvianPoolV3: [admin, current.wiring.feeWallet, current.wiring.usdc, kernel, kernel],
    ProvianBondPool: [admin, current.wiring.provianTechWallet, kernel, kernel, kernel, seedBonds, seedBps],
    ProvianCourtV2: [admin, a.ProvianEscrowV4, kernel, kernel, kernel],
    ProvianMemberRecoursePool: [kernel, a.ProvianOwnershipRegistry, deployer, a.ProvianProtocolPointer,
      [0, 100n * 10n ** 18n, 100n * 10n ** 18n, 100, sha256(toUtf8Bytes('EXERCISE ONLY: membership rule'))], [zero, 0, zeroHash, 0, false]],
  };
  for (const name of names) {
    const compiled = artifact(successorArtifacts[name] ?? name), iface = new Interface(compiled.abi);
    const receipt = await send(deployer, null, compiled.bytecode.object + iface.encodeDeploy(params[name]).slice(2), `deploy:${name}`);
    if (receipt.contractAddress.toLowerCase() !== a[name].toLowerCase()) throw Error('exercise_deployment_nonce_changed');
  }
  for (const row of snapshot.history) await call(deployer, a.ProvianRecoveryHistory, 'ProvianRecoveryHistory',
    row.type === 'batch' ? 'importBatch' : 'importEntry', row.type === 'batch' ? [row.key, row.record, row.proof] : [row.kind, row.key, row.value, row.proof]);
  for (const row of snapshot.balances) await call(deployer, a.ProvianRestorationAuthorization, 'ProvianRestorationAuthorization',
    'importBalance', [row.previousOwner, row.destination, row.amount, row.proof]);
  const pool = new Contract(a.ProvianMemberRecoursePool, artifact('ProvianMemberRecoursePool').abi, provider);
  const settlement = await pool.settlement();
  const components = [kernel, a.ProvianRecourseEligibilityVerifier, state.beneficiaryVerifier.verifier, a.ProvianEscrowV4,
    a.ProvianPromiseV3, a.ProvianPoolV3, a.ProvianBondPool, a.ProvianCourtV2, a.ProvianMemberRecoursePool, settlement];
  const hashes = await Promise.all(components.map(async address => address === zero ? zeroHash : keccak256(await provider.getCode(address))));
  const pointer = new Interface(artifact('ProvianProtocolPointer').abi);
  const account = new Contract(a.ProvianHashAccount, artifact('ProvianHashAccount').abi, provider);
  let pointerRootGeneration = 0;
  async function pointerCall(method, args) {
    const data = pointer.encodeFunctionData(method, args);
    const next = await recoverySigningRoot(exerciseSeed(`pointer root ${pointerRootGeneration + 1}`));
    const digest = await account.intentDigest(a.ProvianProtocolPointer, 0, 2_000_000, data, next);
    const proof = await signRecoveryIntent(exerciseSeed(`pointer root ${pointerRootGeneration}`), digest, { async reserve() {} });
    await call(deployer, a.ProvianHashAccount, 'ProvianHashAccount', 'execute',
      [a.ProvianProtocolPointer, 0, 2_000_000, data, next, proof.publicKey, proof.signature]);
    if (await account.keyCommitment() !== next) throw Error('exercise_pointer_root_mismatch');
    ++pointerRootGeneration;
  }
  const legacy = [...new Set([oldKernel, oldVerifier, ...institutions].map(address => address.toLowerCase()))];
  await pointerCall('registerLegacyRetirements', [legacy,
    await Promise.all(legacy.map(async address => keccak256(await provider.getCode(address))))]);
  await pointerCall('publish', [0, components, hashes]);
  const discovery = new Contract(a.ProvianProtocolPointer, artifact('ProvianProtocolPointer').abi, provider);
  for (const address of legacy) if (!await discovery.retired(address)) throw Error('exercise_legacy_retirement_missing');
  for (let index = 0; index < components.length; ++index) {
    if ((await discovery.component(index)).toLowerCase() !== components[index].toLowerCase()) throw Error('exercise_pointer_component_mismatch');
  }
  await call(admin, a.ProvianEscrowV4, 'ProvianEscrowV4', 'setCourtContract', [a.ProvianCourtV2]);
  await call(admin, a.ProvianBondPool, 'ProvianBondPool', 'setCourtContract', [a.ProvianCourtV2]);
  await call(admin, a.ProvianBondPool, 'ProvianBondPool', 'setExecutor', [admin]);
  await call(admin, a.ProvianCourtV2, 'ProvianCourtV2', 'setBondPool', [a.ProvianBondPool]);
  await call(admin, a.ProvianRecourseEligibilityVerifier, 'ProvianRecourseEligibilityVerifier', 'appointBatchApprover', [deployer]);
  await call(admin, kernel, 'ProvianRecourseKernel', 'appointOperationalMinter', [settlement]);
  await call(admin, kernel, 'ProvianRecourseKernel', 'armEpochZero', [{
    epochZeroStartsAt: state.epochZeroStartsAt, genesisStartsAt: state.genesisStartsAt, genesisEndsAt: state.genesisEndsAt,
    initialMintRate: state.mintRate, provianTreasury: state.provianTreasury, foundationTreasury: state.foundationTreasury,
    eligibilityVerifier: { ...state.eligibilityVerifier, verifier: a.ProvianRecourseEligibilityVerifier },
    initialFinalizedCursor: state.nextCursor, combinedCapMode: 1, genesisCap: state.genesisCap, fixedCombinedCap: state.combinedCap,
  }]);
  await call(admin, kernel, 'ProvianRecourseKernel', 'resumeFromAdministrativeHold');
  const token = new Contract(kernel, artifact('ProvianRecourseKernel').abi, provider);
  if (await token.totalSupply() !== BigInt(snapshot.supply)) throw Error('exercise_supply_carry_mismatch');
  const carried = new Map();
  for (const row of snapshot.balances) {
    const address = row.destination.toLowerCase();
    carried.set(address, (carried.get(address) ?? 0n) + BigInt(row.amount));
  }
  for (const [address, balance] of carried) if (await token.balanceOf(address) !== balance) throw Error('exercise_holder_carry_mismatch');
  const manifest = { schema: 'provian.isolated-recourse-exercise.v1', chainId: 31337, rpc: 'http://127.0.0.1:18545',
    instanceId: metadata.instanceId, fork: metadata.forkedNetwork, cutoff: { number: block, hash: blockHash },
    addresses, successorArtifacts, settlement, admin, deployer, attestor, components, hashes, pointerRootGeneration,
    holdersVerified: snapshot.balances.length, historyImported: snapshot.history.length, productionChanged: false };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  save('transactions.json', journal);
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw Error('usage: exercise-bootstrap.mjs OUTPUT_DIRECTORY');
  bootstrapExercise(process.argv[2]).then(manifest => console.log(JSON.stringify({ chainId: manifest.chainId,
    pointer: manifest.addresses.ProvianProtocolPointer, holdersVerified: manifest.holdersVerified,
    historyImported: manifest.historyImported, productionChanged: false }))).catch(error => {
      console.error(error.message?.startsWith('exercise_') || error.message?.startsWith('snapshot_') ? error.message : 'exercise_bootstrap_failed');
      if (error.snapshotRpcDiagnostic) console.error(JSON.stringify(error.snapshotRpcDiagnostic));
      if (error.exerciseCall) console.error(JSON.stringify(error.exerciseCall));
      console.error(JSON.stringify({ name: error.name, code: error.code,
        stage: typeof error.shortMessage === 'string' ? error.shortMessage.split('(')[0].replace(/https?:\S+/g, '[RPC]') : undefined,
        frames: String(error.stack ?? '').split('\n').filter(line => /^\s+at /.test(line) && line.includes('/scripts/recourse/')) }));
      process.exitCode = 1;
    });
}
