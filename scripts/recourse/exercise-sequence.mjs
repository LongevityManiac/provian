#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AbiCoder, Contract, MaxUint256, concat, getAddress, getBytes, keccak256, sha256, toQuantity, toUtf8Bytes } from 'ethers';
import { isolatedExercisePort } from './exercise-port.mjs';
import { exerciseReceipt } from './exercise-read.mjs';
import { exerciseSeed, exerciseWallet } from './exercise-bootstrap.mjs';
import { recoverySigningRoot, signRecoveryIntent } from '../../provian-agent-sdk/dist/recourse-hash-authorization.js';
import { prepareExerciseMembership, verifyExerciseMembershipSignature } from './exercise-membership.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const coder = AbiCoder.defaultAbiCoder(), unit = 10n ** 18n;
const labelHash = text => sha256(toUtf8Bytes(`EXERCISE ONLY: ${text}`));
const abi = name => JSON.parse(readFileSync(resolve(root, `contracts/out/${name}.sol/${name}.json`), 'utf8')).abi;

/** Repeatable fixture demonstration on a private simulator. The wallets and
 * recovery secrets here are public test material, never production identities.
 * An explicitly selected copied balance funds it only inside the local fork. */
export async function exerciseSequence(directory, copiedFunder, boundWallet, signOwner) {
  const selectedOwner = boundWallet === undefined ? null : getAddress(boundWallet).toLowerCase();
  if (selectedOwner && typeof signOwner !== 'function') throw Error('exercise_wallet_signature_required');
  const output = resolve(directory), path = resolve(output, selectedOwner ? `sequence-${selectedOwner}.json` : 'sequence.json');
  if (existsSync(path)) throw Error('exercise_sequence_already_started');
  const m = JSON.parse(readFileSync(resolve(output, 'exercise.json'), 'utf8'));
  const funder = getAddress(copiedFunder ?? m.admin);
  const port = isolatedExercisePort(), provider = port.provider;
  await port.verify();
  const meta = await provider.send('anvil_metadata', []);
  if (m.chainId !== 31337 || m.instanceId !== meta.instanceId) throw Error('exercise_instance_changed');
  for (let i = 0; i < m.components.length; ++i) {
    if (i === 2 && /^0x0{40}$/.test(m.components[i])) continue;
    if (keccak256(await provider.getCode(m.components[i])) !== m.hashes[i]) throw Error('exercise_runtime_changed');
  }
  const fixture = role => exerciseWallet(m.instanceId, role);
  const owner = selectedOwner ? { address: selectedOwner } : fixture('member');
  const thief = fixture(selectedOwner ? 'thief '+selectedOwner : 'thief'), destination = fixture(selectedOwner
    ? 'recovered destination '+selectedOwner : 'recovered destination');
  const exchange = fixture(selectedOwner ? 'exchange '+selectedOwner : 'exchange'), attestor = fixture('attestor');
  for (const account of [thief, destination, exchange, attestor, ...(selectedOwner ? [] : [owner])]) {
    if (await provider.getCode(account.address) !== '0x') throw Error('exercise_fixture_code_present');
  }
  if (attestor.address.toLowerCase() !== m.attestor.toLowerCase()) throw Error('exercise_attestor_changed');
  const a = m.addresses, kernel = new Contract(a.ProvianRecourseKernel, abi('ProvianRecourseKernel'), provider);
  const pool = new Contract(a.ProvianMemberRecoursePool, abi('ProvianMemberRecoursePool'), provider);
  const registry = new Contract(a.ProvianOwnershipRegistry, abi('ProvianOwnershipRegistry'), provider);
  const authorization = new Contract(a.ProvianRestorationAuthorization, abi('ProvianRestorationAuthorization'), provider);
  const pointer = new Contract(a.ProvianProtocolPointer, abi('ProvianProtocolPointer'), provider);
  const revision = await pointer.revision();
  if (revision !== 1n) throw Error('exercise_revision_changed');
  const identity = await registry.addressBinding(owner.address);
  const request = labelHash('restoration '+identity);
  const report = { schema: 'provian.isolated-recourse-sequence.v1', chainId: 31337, instanceId: m.instanceId,
    productionChanged: false, fixtureOnly: true, externallyBoundOwner: selectedOwner !== null,
    copiedFunder: funder, identity, owner: owner.address, destination: destination.address,
    transactions: [], checks: {} };
  const save = () => writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  async function send(from, contract, method, args) {
    await port.verify();
    if ((await provider.send('anvil_metadata', [])).instanceId !== m.instanceId) throw Error('exercise_instance_changed');
    const hash = await port.mutate('eth_sendTransaction', [{ from, to: await contract.getAddress(),
      data: contract.interface.encodeFunctionData(method, args), gas: toQuantity(29_000_000) }]);
    const row = { method, hash, receipt: null }; report.transactions.push(row); save();
    row.receipt = await exerciseReceipt(provider, hash);
    save();
    if (!row.receipt || BigInt(row.receipt.status) !== 1n) throw Error(`exercise_transaction_failed:${method}`);
    return row.receipt;
  }
  const requireEqual = (actual, expected, name) => {
    if (actual !== expected) throw Error(`exercise_check_failed:${name}`);
    report.checks[name] = true; save();
  };
  const initialSupply = await kernel.totalSupply();
  if (selectedOwner && await registry.ownerOf(selectedOwner) !== identity) throw Error('exercise_workbench_binding_required');
  const consentAtStart = await pool.addressConsent(identity), alreadyJoined = consentAtStart.joined;
  const startHeader = await provider.send('eth_getBlockByNumber', ['latest', false]);
  const startMonth = await pool.calendarMonth(BigInt(startHeader.timestamp));
  const priorDebits = await provider.send('eth_getLogs', [{ address: a.ProvianMemberRecoursePool,
    fromBlock: toQuantity(m.cutoff.number + 1), toBlock: 'latest',
    topics: [pool.interface.getEvent('MembershipDebitExecuted').topicHash, null, identity] }]);
  const period = alreadyJoined ? await pool.consentPeriods(identity, consentAtStart.generation) : { startBlock: 0n };
  const initialBurnPaid = alreadyJoined && priorDebits.some(log => {
    const event = pool.interface.parseLog(log);
    return BigInt(log.blockNumber) >= period.startBlock && event.args.month === startMonth && event.args.burn === 100n * unit;
  });
  if (!selectedOwner && await kernel.balanceOf(funder) < 500n * unit) throw Error('exercise_fixture_funding_unavailable');
  // Exactly the demonstrated burns, contribution and loss; a workbench member
  // has already burned its first month's participation amount.
  if (selectedOwner && await kernel.balanceOf(selectedOwner) < (initialBurnPaid ? 300n : 400n) * unit) throw Error('exercise_fixture_funding_unavailable');
  await port.mutate('anvil_impersonateAccount', [m.admin]);
  await port.mutate('anvil_impersonateAccount', [owner.address]);
  await port.mutate('anvil_impersonateAccount', [thief.address]);
  await port.mutate('anvil_setBalance', [thief.address, toQuantity(100n * unit)]);
  await port.mutate('anvil_setBalance', [owner.address, toQuantity(100n * unit)]);
  if (!selectedOwner) {
    await port.mutate('anvil_impersonateAccount', [funder]);
    await port.mutate('anvil_setBalance', [funder, toQuantity(100n * unit)]);
    await send(funder, kernel, 'transfer', [owner.address, 500n * unit]);
  }
  const secret = exerciseSeed(selectedOwner ? 'wallet secret '+selectedOwner : 'member secret 0');
  const seed = exerciseSeed(selectedOwner ? 'wallet signing '+selectedOwner : 'member signing 0');
  const signingRoot = await recoverySigningRoot(seed);
  const commitment = sha256(concat([secret, signingRoot]));
  const head = await provider.send('eth_getBlockByNumber', ['latest', false]);
  const binding = { identity, account: owner.address, recoveryCommitment: commitment, signingRoot,
    kernel: a.ProvianRecourseKernel, nonce: labelHash('fixture bind nonce'), expiresAtMs: (BigInt(head.timestamp) + 240n) * 1000n };
  const digest = await registry.bindingDigest(binding);
  const bound = selectedOwner ? {logs: await provider.send('eth_getLogs',[{address:a.ProvianOwnershipRegistry,
    fromBlock:toQuantity(m.cutoff.number+1),toBlock:'latest',topics:[registry.interface.getEvent('OwnershipBound').topicHash,identity]}])}
    : await send(m.deployer, registry, 'bind', [binding, owner.signingKey.sign(digest).serialized,
      attestor.signingKey.sign(digest).serialized, revision]);
  requireEqual(await registry.ownerOf(owner.address), identity, 'boundOwner');
  await send(owner.address, kernel, 'approve', [a.ProvianMemberRecoursePool, MaxUint256]);
  async function membership(kind) {
    const prepared = await prepareExerciseMembership({ manifest: m, provider, registry, pool, account: owner.address, kind, attestor });
    const signature = selectedOwner ? await signOwner(prepared.challenge) : await owner.signMessage(getBytes(prepared.challenge.messageHex));
    verifyExerciseMembershipSignature(prepared.challenge, signature);
    return send(m.deployer, pool, prepared.challenge.method, [prepared.challenge.authorization, signature, prepared.attestorSignature]);
  }
  if (!alreadyJoined) await membership('join');
  if (!initialBurnPaid) await membership('burn');
  requireEqual(await kernel.totalSupply(), initialSupply - (initialBurnPaid ? 0n : 100n * unit), 'participationIsTrueBurn');
  const now = Number(BigInt((await provider.send('eth_getBlockByNumber', ['latest', false])).timestamp));
  const date = new Date(now * 1000), nextMonth = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / 1000;
  await port.mutate('evm_increaseTime', [nextMonth - now + 1]); await port.mutate('evm_mine', []);
  const reserveOpening = await pool.accountedBacking();
  await membership('reserve');
  await membership('burn');
  const poolOpening = await pool.accountedBacking();
  requireEqual(poolOpening - reserveOpening, 100n * unit, 'noEarningsContribution');
  requireEqual(await kernel.totalSupply(), initialSupply - (initialBurnPaid ? 100n : 200n) * unit, 'secondMonthlyBurn');
  const exchangeOpening = await kernel.balanceOf(exchange.address);
  const loss = await send(owner.address, kernel, 'transfer', [thief.address, 100n * unit]);
  await send(thief.address, kernel, 'transfer', [exchange.address, 40n * unit]);
  const observations = [owner.address, thief.address, exchange.address].map(x => x.toLowerCase()).sort();
  const reversal = { request, identity, destination: destination.address, sources: [thief.address], amounts: [60n * unit],
    sourceSequences: [await kernel.outgoingSequence(thief.address)], observationAccounts: observations,
    observationSequences: await Promise.all(observations.map(x => kernel.outgoingSequence(x))),
    poolShortfall: 40n * unit, restorationRevision: await authorization.restorationRevision(), evidenceHash: labelHash('fixture witnessed exchange; synthetic exercise evidence') };
  const reversalType = authorization.interface.getFunction('executeRestorationIntent').inputs[0];
  const operation = sha256(coder.encode(['string', reversalType], ['Provian theft reversal', reversal]));
  const bindingLog = bound.logs.find(log => {
    try { return registry.interface.parseLog(log)?.name === 'OwnershipBound'; } catch { return false; }
  });
  const lossLog = loss.logs.find(log => {
    try { return kernel.interface.parseLog(log)?.name === 'Transfer'; } catch { return false; }
  });
  if (!bindingLog || !lossLog) throw Error('exercise_required_event_missing');
  const evidence = { kernel: a.ProvianRecourseKernel, operation, identity, lossAccount: owner.address,
    lossBlock: BigInt(loss.blockNumber), checkpointHash: loss.blockHash, membershipHash: labelHash('fixture membership checkpoint'),
    revision, bindingLogIndex: BigInt(bindingLog.logIndex), lossLogIndex: BigInt(lossLog.logIndex) };
  const evidenceDigest = await registry.evidenceDigest(evidence);
  await send(m.deployer, registry, 'admitTheftEvidence', [evidence, attestor.signingKey.sign(evidenceDigest).serialized]);
  const nextSigningRoot = await recoverySigningRoot(exerciseSeed('member signing 1'));
  const nextCommitment = sha256(concat([exerciseSeed('member secret 1'), nextSigningRoot]));
  const intent = await authorization.ownerAuthorizationDigest(identity, operation, nextCommitment, nextSigningRoot);
  const signed = await signRecoveryIntent(seed, intent, { async reserve() {} });
  const proof = { recoverySecret: secret, signingRoot, nextCommitment, nextSigningRoot, ...signed };
  const payload = coder.encode(['uint8', 'bytes'], [0, coder.encode([reversalType, 'uint256'], [reversal, revision])]);
  const beforeReversal = await kernel.totalSupply();
  await send(m.admin, authorization, 'execute', [identity, operation, proof, payload]);
  requireEqual(await kernel.totalSupply(), beforeReversal, 'reversalSupplyNeutral');
  requireEqual(await kernel.balanceOf(destination.address), 60n * unit, 'namedSourceReversal');
  requireEqual(await kernel.balanceOf(exchange.address), exchangeOpening + 40n * unit, 'witnessedExchangeRetained');
  const lossHeader = await provider.send('eth_getBlockByHash', [loss.blockHash, false]);
  const consent = await pool.addressConsent(identity);
  const determination = { request, identity, occurrence: loss.transactionHash,
    shortfall: 40n * unit, evidenceHash: reversal.evidenceHash, expectedRevision: await pool.outcomeRevision(identity),
    membershipGeneration: consent.generation, lossBlock: BigInt(loss.blockNumber),
    lossMonth: await pool.calendarMonth(BigInt(lossHeader.timestamp)) };
  const consentPeriod = await pool.consentPeriods(identity, consent.generation);
  const admissions = await provider.send('eth_getLogs', [{ address: a.ProvianMemberRecoursePool,
    fromBlock: toQuantity(consentPeriod.startBlock), toBlock: toQuantity(consentPeriod.startBlock),
    topics: [pool.interface.getEvent('AddressConsentChanged').topicHash, identity] }]);
  const admission = admissions.find(log => {
    const event = pool.interface.parseLog(log); return event.args.generation === consent.generation && event.args.joined;
  });
  if (!admission) throw Error('exercise_required_consent_missing');
  const eligibility = { determination, ruleHash: (await pool.monthlyRule(determination.lossMonth)).signedRuleHash,
    admissionLogIndex: BigInt(admission.logIndex), lossLogIndex: BigInt(lossLog.logIndex), closureLogIndex: 0n };
  await send(m.deployer, pool, 'admitLossEligibility', [eligibility,
    attestor.signingKey.sign(await pool.lossEligibilityDigest(eligibility)).serialized]);
  await send(m.admin, pool, 'determine', [[determination]]);
  await send(m.deployer, pool, 'deliverRestoration', [request, identity]);
  requireEqual(await kernel.balanceOf(destination.address), 100n * unit, 'poolRestoredRemainder');
  requireEqual(await kernel.totalSupply(), beforeReversal, 'poolTransferCreatesNothing');
  requireEqual(await kernel.balanceOf(a.ProvianMemberRecoursePool), poolOpening - 40n * unit, 'poolBackingReconciled');
  report.completed = true; save(); return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  exerciseSequence(process.argv[2], process.argv[3], process.argv[4]).then(report => console.log(JSON.stringify(report.checks))).catch(error => {
    console.error(error.message?.startsWith('exercise_') ? error.message : 'exercise_sequence_failed'); process.exitCode = 1;
  });
}
