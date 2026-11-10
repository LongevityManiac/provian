import { inheritedMonetaryHistory } from './snapshot-history.mjs';
import { AbiCoder, Interface, ZeroAddress, concat, getAddress, keccak256, sha256 } from 'ethers';

const abi = AbiCoder.defaultAbiCoder();
const zero = ZeroAddress.toLowerCase();
export const balanceLeaf = (predecessor, block, previousOwner, destination, amount) => sha256(abi.encode(
  ['string', 'address', 'uint256', 'address', 'address', 'uint256'],
  ['Provian balance succession', predecessor, block, previousOwner, destination, amount]));
export const historyLeaf = (predecessor, block, kind, key, value) => sha256(abi.encode(
  ['string', 'address', 'uint256', 'uint8', 'bytes32', 'uint256'],
  ['Provian monetary history', predecessor, block, kind, key, value]));
export const batchLeaf = (predecessor, block, key, encoded) => sha256(abi.encode(
  ['string', 'address', 'uint256', 'bytes32', 'bytes32'],
  ['Provian settlement history', predecessor, block, key, sha256(encoded)]));

/** Sorted pairs; promote an unpaired node unchanged. Every leaf has one proof. */
export function merkle(leaves) {
  if (new Set(leaves).size !== leaves.length) throw Error('snapshot_duplicate_leaf');
  if (!leaves.length) return { root: sha256(Buffer.from('Provian empty succession')), proofs: [] };
  const proofs = leaves.map(() => []);
  let level = leaves.map((hash, index) => ({ hash, indices: [index] }));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i], b = level[i + 1];
      if (!b) { next.push(a); continue; }
      for (const index of a.indices) proofs[index].push(b.hash);
      for (const index of b.indices) proofs[index].push(a.hash);
      next.push({ hash: sha256(concat([a.hash, b.hash].sort())), indices: [...a.indices, ...b.indices] });
    }
    level = next;
  }
  return { root: level[0].hash, proofs };
}
export function verifyProof(leaf, proof, root) {
  return proof.reduce((hash, sibling) => sha256(concat([hash, sibling].sort())), leaf) === root;
}
function normalize(result) {
  if (typeof result === 'bigint') return result.toString();
  if (result && typeof result.toObject === 'function') return Object.fromEntries(Object.entries(result.toObject()).map(([k, v]) => [k, normalize(v)]));
  if (Array.isArray(result)) return result.map(normalize);
  return result;
}
function ensure(condition, code) { if (!condition) throw Error(code); }

/** Pure orchestration over an independently verified, block-pinned chain port.
 * No signer or transaction broadcast exists in the snapshot path. */
export async function buildSuccessionSnapshot({ port, kernelAbi, predecessor, deploymentBlock, block,
  blockHash, expectedRuntimeHash, destinations = {}, verifierDestinations = {}, institutions, priorSnapshot, mode = 'ordinary' }) {
  predecessor = getAddress(predecessor);
  ensure(['ordinary','cryptographic-break'].includes(mode),'snapshot_mode_invalid');
  const iface = new Interface(kernelAbi);
  const successor = iface.hasFunction('predecessorHistory');
  ensure(Array.isArray(institutions) && institutions.length === (successor ? 6 : 5) && new Set(institutions.map(a => getAddress(a).toLowerCase())).size === institutions.length,
    'snapshot_complete_institution_inventory_required');
  const custody = new Set(institutions.map(a => getAddress(a).toLowerCase()));
  ensure(new Set(Object.values(destinations).map(a => getAddress(a).toLowerCase())).size === Object.keys(destinations).length,
    'snapshot_duplicate_custody_destination');
  for (const [source, target] of Object.entries(destinations)) ensure(custody.has(source) && target.toLowerCase() !== source
    && target.toLowerCase() !== zero && !custody.has(target.toLowerCase()), 'snapshot_invalid_custody_mapping');
  const call = async (method, args = []) => iface.decodeFunctionResult(method,
    await port.call(predecessor, iface.encodeFunctionData(method, args), blockHash));
  const read = async (method, args = []) => (await call(method, args))[0];
  ensure(/^0x[0-9a-f]{64}$/.test(expectedRuntimeHash), 'snapshot_runtime_pin_required');
  ensure(await port.code(predecessor, await port.blockHash(deploymentBlock - 1)) === '0x', 'snapshot_deployment_boundary');
  ensure(keccak256(await port.code(predecessor, await port.blockHash(deploymentBlock))) === expectedRuntimeHash
    && keccak256(await port.code(predecessor, blockHash)) === expectedRuntimeHash, 'snapshot_runtime_mismatch');
  if (mode === 'ordinary') ensure(await read('administrativeHold') && await read('operationalMinter') === ZeroAddress, 'snapshot_predecessor_not_retired');
  const headEpoch = await read('lastOpenedEpoch'), headPolicy = await read('getEpochPolicy', [headEpoch]);
  const verifierAbi = new Interface(['function administrativeHold() view returns(bool)', 'function batchApprover() view returns(address)']);
  const verifierRead = async method => verifierAbi.decodeFunctionResult(method, await port.call(
    headPolicy.eligibilityVerifier.verifier, verifierAbi.encodeFunctionData(method), blockHash))[0];
  if (mode === 'ordinary') ensure(await verifierRead('administrativeHold') && await verifierRead('batchApprover') === ZeroAddress, 'snapshot_verifier_not_retired');
  const institutionAbi = new Interface(['function pvt() view returns(address)']);
  for (const institution of custody) ensure(institutionAbi.decodeFunctionResult('pvt', await port.call(institution,
    institutionAbi.encodeFunctionData('pvt'), blockHash))[0].toLowerCase() === predecessor.toLowerCase(), 'snapshot_institution_kernel_mismatch');
  const logs = await port.logs(predecessor, deploymentBlock, block);
  ensure(logs.length > 0, 'snapshot_empty_log_population');
  const balances = new Map(), claims = new Set(), anchors = new Set(), wallets = new Set(), batches = new Set(), scheduleEpochs = new Set();
  const entries = [];
  let inheritedMinted = 0n, restored = 0n, reversed = 0n;
  if (successor) {
    const inherited = await inheritedMonetaryHistory({ prior: priorSnapshot,
      historyAddress: await read('predecessorHistory'), port, blockHash, iface, read, predecessor, block });
    entries.push(...inherited.entries);
    for (const [target, source] of [[claims,inherited.claims],[anchors,inherited.anchors],[wallets,inherited.wallets],[batches,inherited.batches]])
      for (const key of source) target.add(key);
    for (const epoch of inherited.scheduleEpochs) scheduleEpochs.add(epoch);
    inheritedMinted = inherited.minted;
    restored = await read('restoredBalance');
    const auth = await read('ownerAuthorization');
    const reversalAbi = new Interface(['event TheftReversed(bytes32 indexed request,bytes32 indexed identity,address indexed destination,uint256 amount,bytes32 evidenceHash)']);
    const seen = new Set();
    for (const log of await port.logs(auth,deploymentBlock,block)) {
      ensure(!log.removed && log.address.toLowerCase()===auth.toLowerCase()
        && BigInt(log.blockNumber)>=BigInt(deploymentBlock)&&BigInt(log.blockNumber)<=BigInt(block),'snapshot_reversal_log_domain');
      const event = reversalAbi.parseLog(log); if (!event) continue;
      const position=`${log.blockNumber}:${log.logIndex}`;
      ensure(!seen.has(position),'snapshot_duplicate_reversal');seen.add(position);
      reversed += event.args.amount;
    }
  }
  const transactionCache = new Map();
  let lastPosition = -1n;
  let totalBatchMinted = inheritedMinted, nativeBatchMinted = 0n, burned = 0n;
  for (const log of logs) {
    ensure(!log.removed && log.address.toLowerCase() === predecessor.toLowerCase()
      && BigInt(log.blockNumber) >= BigInt(deploymentBlock) && BigInt(log.blockNumber) <= BigInt(block), 'snapshot_log_domain');
    const position = BigInt(log.blockNumber) * (1n << 64n) + BigInt(log.logIndex);
    ensure(position > lastPosition, 'snapshot_duplicate_or_unordered_log'); lastPosition = position;
    const event = iface.parseLog(log);
    if (!event) throw Error('snapshot_unknown_kernel_event');
    if (event.name === 'Transfer') {
      const from = event.args.from.toLowerCase(), to = event.args.to.toLowerCase(), value = event.args.value;
      if (from !== zero) {
        const next = (balances.get(from) ?? 0n) - value;
        ensure(next >= 0n, 'snapshot_transfer_history_incomplete'); balances.set(from, next);
      }
      if (to !== zero) balances.set(to, (balances.get(to) ?? 0n) + value);
      else burned += value;
    }
    if (event.name.endsWith('Scheduled')) scheduleEpochs.add(event.args.effectiveEpoch.toString());
    if (event.name !== 'SettlementBatchBound') continue;
    const id = event.args.batchId;
    ensure(!batches.has(id), 'snapshot_duplicate_batch'); batches.add(id);
    let tx = transactionCache.get(log.transactionHash);
    if (!tx) { tx = await port.transaction(log.transactionHash); transactionCache.set(log.transactionHash, tx); }
    ensure(tx && tx.hash.toLowerCase() === log.transactionHash.toLowerCase()
      && tx.blockHash.toLowerCase() === log.blockHash.toLowerCase()
      && tx.to, 'snapshot_unresolved_settlement_call');
    let target = tx.to, settlementData = tx.input;
    if (successor && !iface.parseTransaction({data:settlementData})) {
      const accountAbi = new Interface(['function execute(address,uint256,uint256,bytes,bytes32,bytes,bytes) returns(bool)']);
      const authAbi = new Interface(['function hashAccountCodeHash() view returns(bytes32)']);
      const auth = await read('ownerAuthorization');
      const expectedAccountHash = authAbi.decodeFunctionResult('hashAccountCodeHash',await port.call(auth,
        authAbi.encodeFunctionData('hashAccountCodeHash'),blockHash))[0];
      const seen = new Set();
      while (!iface.parseTransaction({data:settlementData})) {
        ensure(!seen.has(target.toLowerCase()),'snapshot_circular_settlement_wrapper');seen.add(target.toLowerCase());
        const wrapped=accountAbi.parseTransaction({data:settlementData});
        ensure(wrapped?.name==='execute' && wrapped.args[1]===0n
          &&keccak256(await port.code(target,log.blockHash))===expectedAccountHash,'snapshot_unresolved_settlement_call');
        target=wrapped.args[0];settlementData=wrapped.args[3];
      }
    }
    if (target.toLowerCase() !== predecessor.toLowerCase()) {
      ensure(successor, 'snapshot_unresolved_settlement_call');
      const adapterAbi = new Interface(['function kernel() view returns(address)', 'function pool() view returns(address)']);
      const tag = log.blockHash;
      const adapterKernel = adapterAbi.decodeFunctionResult('kernel', await port.call(target,adapterAbi.encodeFunctionData('kernel'),tag))[0];
      const pool = adapterAbi.decodeFunctionResult('pool', await port.call(target,adapterAbi.encodeFunctionData('pool'),tag))[0];
      const poolAbi = new Interface(['function settlement() view returns(address)']);
      const adapter = poolAbi.decodeFunctionResult('settlement', await port.call(pool,poolAbi.encodeFunctionData('settlement'),tag))[0];
      ensure(adapterKernel.toLowerCase()===predecessor.toLowerCase()&&adapter.toLowerCase()===target.toLowerCase()
        &&custody.has(pool.toLowerCase()), 'snapshot_unresolved_settlement_call');
    }
    const parsed = iface.parseTransaction({ data: settlementData });
    ensure(parsed && ['settleStandardPEBatch', 'settleGenesisPEBatch'].includes(parsed.name), 'snapshot_settlement_input');
    const input = parsed.args;
    ensure(input[0] === id && input[1] === event.args.epoch && input[2] === event.args.policyHash
      && input[3] === event.args.finalizedCursorStart && input[4] === event.args.finalizedCursorEnd, 'snapshot_settlement_binding');
    const genesis = parsed.name === 'settleGenesisPEBatch';
    ensure(event.args.lane === (genesis ? 1n : 0n), 'snapshot_settlement_lane');
    ensure(await read(genesis ? 'hashGenesisClaims' : 'hashStandardClaims', [input[5], input[6]]) === event.args.claimsHash, 'snapshot_claims_hash');
    const record = await read('getBatchRecord', [id]);
    ensure(record.settled && record.claimsHash === event.args.claimsHash && record.settlementDigest === event.args.settlementDigest
      && record.claimCount === BigInt(input[6].length), 'snapshot_batch_record');
    totalBatchMinted += record.totalMinted; nativeBatchMinted += record.totalMinted;
    const encoded = abi.encode([iface.getFunction('getBatchRecord').outputs[0]], [record]);
    entries.push({ type: 'batch', key: id, record: normalize(record), leaf: batchLeaf(predecessor, block, id, encoded) });
    // Bounded concurrent reads against the same pinned block. Append in input
    // order and check uniqueness before issuing reads, preserving exact roots
    // while avoiding a network round trip per individual settled act.
    for (const claim of input[6]) {
      ensure(!claims.has(claim.claimId), 'snapshot_claim_replay_or_missing');
      claims.add(claim.claimId);
    }
    for (let start = 0; start < input[6].length; start += 8) {
      const group = input[6].slice(start, start + 8);
      const checked = await Promise.all(group.map(async claim => {
        ensure(await read('claimSettled', [claim.claimId]), 'snapshot_claim_replay_or_missing');
        if (!genesis) return null;
        const anchor = await read('genesisAnchorKey', [claim.grantType, claim.oneTimeAnchor]);
        ensure(await read('genesisAnchorUsed', [anchor]), 'snapshot_anchor_replay_or_missing');
        return anchor;
      }));
      for (const [index, claim] of group.entries()) {
        entries.push({ type: 'entry', kind: 0, key: claim.claimId, value: '1', leaf: historyLeaf(predecessor, block, 0, claim.claimId, 1) });
        if (genesis) {
          const anchor = checked[index];
          ensure(!anchors.has(anchor), 'snapshot_anchor_replay_or_missing');
          anchors.add(anchor); wallets.add(claim.walletId);
          entries.push({ type: 'entry', kind: 1, key: anchor, value: '1', leaf: historyLeaf(predecessor, block, 1, anchor, 1) });
        }
      }
    }
  }
  const supply = await read('totalSupply');
  const total = [...balances.values()].reduce((a, b) => a + b, 0n);
  ensure(total === supply && restored + nativeBatchMinted + reversed - burned === supply, 'snapshot_supply_reconciliation');
  const balanceEntries = [];
  for (const [owner, amount] of [...balances].sort(([a], [b]) => a.localeCompare(b))) {
    ensure(await read('balanceOf', [owner]) === amount, 'snapshot_balance_reconciliation');
    if (!amount) continue;
    const destination = getAddress(destinations[owner] ?? owner);
    ensure(!custody.has(owner) || destinations[owner], 'snapshot_custody_destination_required');
    balanceEntries.push({ previousOwner: owner, destination, amount: amount.toString(),
      leaf: balanceLeaf(predecessor, block, owner, destination, amount) });
  }
  for (const wallet of [...wallets].sort()) {
    const value = await read('genesisWalletGrossIssued', [wallet]);
    entries.push({ type: 'entry', kind: 2, key: wallet, value: value.toString(), leaf: historyLeaf(predecessor, block, 2, wallet, value) });
  }
  const lastOpenedEpoch = await read('lastOpenedEpoch'), active = await read('getEpochPolicy', [lastOpenedEpoch]);
  ensure(active.opened && active.combinedCapMode === 1n, 'snapshot_current_fixed_epoch_required');
  const state = { lastOpenedEpoch: lastOpenedEpoch.toString(), mintRate: active.mintRate.toString(), agentFoundationBps: active.agentFoundationBps.toString(),
    genesisCap: active.genesisCap.toString(), combinedCap: active.combinedCap.toString(), provianTreasury: active.provianTreasury,
    foundationTreasury: active.foundationTreasury, beneficiaryVerifier: normalize(active.beneficiaryVerifier), eligibilityVerifier: normalize(active.eligibilityVerifier),
    schedules: [], epochs: [] };
  for (const [field, getter] of Object.entries({ epochZeroStartsAt: 'epochZeroStartsAt', genesisStartsAt: 'genesisStartsAt', genesisEndsAt: 'genesisEndsAt',
    genesisClosed: 'genesisAdmissionClosed', genesisCutoff: 'genesisAdmissionCutoff', nextCursor: 'nextFinalizedCursor', administrativeHold: 'administrativeHold' })) state[field] = normalize(await read(getter));
  state.epochGenesisIssued = normalize(await read('epochGenesisIssued', [lastOpenedEpoch]));
  state.epochTotalIssued = normalize(await read('epochTotalIssued', [lastOpenedEpoch]));
  let allIssuance = BigInt(state.epochTotalIssued);
  for (let epoch = 0n; epoch < lastOpenedEpoch; ++epoch) {
    const policy = await read('getEpochPolicy', [epoch]), genesisIssued = await read('epochGenesisIssued', [epoch]), totalIssued = await read('epochTotalIssued', [epoch]);
    ensure(policy.opened && policy.epoch === epoch, 'snapshot_historical_epoch_missing'); allIssuance += totalIssued;
    state.epochs.push({ policy: normalize(policy), genesisIssued: genesisIssued.toString(), totalIssued: totalIssued.toString() });
  }
  ensure(allIssuance === totalBatchMinted, 'snapshot_epoch_issuance_reconciliation');
  function mappedVerifier(config) {
    if (config.verifier.toLowerCase() === zero) return normalize(config);
    const replacement = verifierDestinations[config.verifier.toLowerCase()];
    ensure(replacement, 'snapshot_scheduled_verifier_successor_required');
    return { ...normalize(config), verifier: getAddress(replacement) };
  }
  for (const epoch of [...scheduleEpochs].map(BigInt).sort((a, b) => a < b ? -1 : 1)) {
    if (epoch <= lastOpenedEpoch) continue;
    const rate = await call('scheduledMintRates', [epoch]), foundation = await call('scheduledAgentFoundationRates', [epoch]);
    const caps = await call('scheduledCapPolicies', [epoch]), treasuries = await call('scheduledTreasuries', [epoch]);
    const beneficiary = await read('getScheduledBeneficiaryVerifier', [epoch]), eligibility = await read('getScheduledEligibilityVerifier', [epoch]);
    ensure(!caps[0] || caps[1] === 1n, 'snapshot_future_fixed_cap_required');
    state.schedules.push({ epoch: epoch.toString(), mintRateSet: rate[0], mintRate: rate[1].toString(), foundationRateSet: foundation[0], foundationRate: foundation[1].toString(),
      capsSet: caps[0], genesisCap: caps[2].toString(), combinedCap: caps[3].toString(), treasuriesSet: treasuries[0], provianTreasury: treasuries[1], foundationTreasury: treasuries[2],
      beneficiaryVerifierSet: beneficiary.exists, beneficiaryVerifier: beneficiary.exists ? mappedVerifier(beneficiary.config) : normalize(beneficiary.config),
      eligibilityVerifierSet: eligibility.exists, eligibilityVerifier: eligibility.exists ? mappedVerifier(eligibility.config) : normalize(eligibility.config) });
  }
  const balanceTree = merkle(balanceEntries.map(e => e.leaf)), historyTree = merkle(entries.map(e => e.leaf));
  ensure(await port.blockHash(block) === blockHash, 'snapshot_reorg');
  return { format: 'provian-succession-snapshot', mode, chainId: 8453, predecessor, block, blockHash, supply: supply.toString(),
    balanceRoot: balanceTree.root, historyRoot: historyTree.root, historyCount: entries.length, state,
    balances: balanceEntries.map((e, i) => ({ ...e, proof: balanceTree.proofs[i] })),
    history: entries.map((e, i) => ({ ...e, proof: historyTree.proofs[i] })),
    counts: { logs: logs.length, holders: balanceEntries.length, batches: batches.size, claims: claims.size, anchors: anchors.size, wallets: wallets.size, epochs: Number(lastOpenedEpoch) + 1 } };
}
