import { isDeepStrictEqual } from 'node:util';
import { Transaction } from 'ethers';
import { openPublicationJournal } from '../../provian-backend/src/core/recourse/publication-journal.ts';
import { changeoverRpcPort } from './changeover-rpc.mjs';
import { inspectPublicationGasClosure } from './publication-gas-closure.mjs';
import { readPublicationProgress, readPublicationHistory } from './publication-recovery.mjs';
import { preparePointerPublication } from './pointer-publication.mjs';
import { prepareDurableHashAuthority } from './hash-authority-durable.mjs';

const ensure = (value, reason) => { if (!value) throw Error('publication_runtime_' + reason); };
// Firestore maps are unordered; values, field sets and array order remain binding.
const equal = isDeepStrictEqual;
const callOf = record => ({ to: record.transaction.to, data: record.transaction.data });

/** Advance one authorized first-publication lifecycle. The immutable journal
 * budget spans legacy retirement, publication, gas cancellation, outer reverts
 * and retries. Authority proofs are durable before RPC simulation; sponsor
 * bytes are durable before broadcast. A semantic win never closes a gas nonce.
 * The caller owns the explicit execution decision and private-store DB wiring.
 * Reinvoke after waiting for chain progress; terminal restarts are read-only. */
export async function runPublicationDelivery({ inputs, db, from, store, vault, loadSigner,
  approvedBudgetWei, maxFeePerGas, maxPriorityFeePerGas, maxGas, workerId, cancelGas = false, requireCompleted = false, onProgress = () => {} }) {
  const { port, ...facts } = inputs; inputs = { ...structuredClone(facts), port };
  ensure(/^0x[0-9a-f]{40}$/.test(from) && typeof approvedBudgetWei === 'string' && /^[1-9][0-9]*$/.test(approvedBudgetWei)
    && [maxFeePerGas, maxPriorityFeePerGas, maxGas].every(value => typeof value === 'bigint' && value > 0n)
    && maxFeePerGas >= maxPriorityFeePerGas && typeof loadSigner === 'function' && typeof cancelGas === 'boolean'
    && typeof requireCompleted === 'boolean' && typeof onProgress === 'function', 'configuration');
  const readers = port.rpcs;
  ensure(Array.isArray(readers) && readers.length === 2 && readers.every(reader => typeof reader.operatorId === 'string'
    && reader.operatorId && typeof reader.request === 'function') && readers[0].operatorId !== readers[1].operatorId, 'independent_operators');
  const history = await readPublicationHistory(inputs, store);
  let progress = history ? null : await readPublicationProgress(inputs, store);
  const goal = history?.goal ?? progress.outcome.goal;
  const journal = await openPublicationJournal(db, { goal, from, approvedBudgetWei, readers, workerId, requireCompleted });
  const closure = (attempt, checkpoint) => inspectPublicationGasClosure(attempt, port, checkpoint);
  let signer;
  try {
    const state = journal.read(), known = (history?.records ?? progress.records).flatMap(row => [row.record, ...(row.cancellation ? [row.cancellation] : [])]);
    for (const attempt of state.attempts) {
      ensure(known.some(record => equal(callOf(record), attempt.authorityTransaction)), 'unknown_retained_operation');
      if (attempt.closed && attempt.variants.length) {
        const checked = await closure({ from, ...attempt }, attempt.closure.checkpoint);
        ensure(checked.status === 'consumed', 'prior_nonce_reopened');
      }
    }
    const verifyGoal = async actual => {
      ensure(equal(actual, goal), 'goal_changed');
      const fresh = await readPublicationProgress(inputs, store);
      return fresh.outcome.status === 'achieved' && fresh.outcome.revision === '1'
        && fresh.outcome.publication !== null && equal(fresh.outcome.goal, goal);
    };
    if (state.completed) {
      await journal.complete(closure, verifyGoal);
      return { status: 'confirmed', lifecycleDigest: journal.lifecycleDigest, attempts: state.attempts.length };
    }
    let exposure = null;
    let validations = 0;
    const assertLease = () => journal.assertLease();
    // Ownership renewal is cheap. Full authority checks belong immediately
    // before executable proof exposure, signing and broadcast, including replay.
    const assertAuthority = async boundary => {
      await journal.assertLease();
      if (exposure?.kind === 'call') {
        const sequence = ++validations, started = Date.now();
        onProgress({ event: 'source_validation_started', lifecycleDigest: journal.lifecycleDigest, sequence, boundary });
        const fresh = await readPublicationProgress(inputs, store);
        ensure(equal(fresh.outcome.goal, goal), 'goal_changed');
        const saved = fresh.records.flatMap(row => [row.record, ...(row.cancellation ? [row.cancellation] : [])]);
        ensure(saved.some(record => equal(callOf(record), exposure.call)), 'operation_changed');
        await journal.assertLease();
        onProgress({ event: 'source_validation_verified', lifecycleDigest: journal.lifecycleDigest, sequence, boundary, elapsedMs: Date.now() - started });
      }
    };
    const rpc = changeoverRpcPort({ rpcs: readers, maxFeePerGas, maxPriorityFeePerGas, maxGas, assertLease,
      assertExposure: assertAuthority, assertBroadcast: () => assertAuthority('broadcast'),
      signer: { getAddress: async () => from, signTransaction: async transaction => {
        await assertLease();
        if (!signer) { signer = await loadSigner(from); ensure(String(await signer.getAddress()).toLowerCase() === from, 'signer_changed'); }
        await assertAuthority('sign');
        const raw = await signer.signTransaction({ ...transaction });
        onProgress({ event: 'transaction_signed', lifecycleDigest: journal.lifecycleDigest, from, nonce: transaction.nonce, hash: Transaction.from(raw).hash });
        return raw;
      } },
      approveFee: async ({ transaction, blockHash }) => journal.reserveFee(cancelGas ? 'cancel' : 'call', transaction, blockHash),
    });
    const persistAndBroadcast = async (step, kind) => {
      exposure = { kind, call: { to: step.to, data: step.data } };
      const raw = await rpc.prepare(step), transaction = Transaction.from(raw);
      await journal.append({ kind, raw, hash: transaction.hash });
      const saved = journal.read().attempts.at(-1)?.variants.at(-1);
      ensure(saved?.raw === raw && saved.hash === transaction.hash && saved.kind === kind, 'write_unconfirmed');
      await rpc.broadcast(saved.raw);
      return { status: 'submitted', lifecycleDigest: journal.lifecycleDigest, hash: transaction.hash, kind };
    };
    const active = state.attempts.at(-1);
    if (active && !active.closed) {
      if (active.variants.length) {
        const checked = await closure({ from, ...active });
        if (checked.status === 'consumed') {
          await journal.close(closure);
          return { status: 'advance', lifecycleDigest: journal.lifecycleDigest };
        }
        const latest = active.variants.at(-1), included = await rpc.included(latest.raw);
        if (included) return { status: 'awaiting_finality', lifecycleDigest: journal.lifecycleDigest, hash: latest.hash };
        if (cancelGas && latest.kind !== 'cancel') {
          const previous = Transaction.from(latest.raw);
          ensure(maxFeePerGas * 100n >= previous.maxFeePerGas * 110n
            && maxPriorityFeePerGas * 100n >= previous.maxPriorityFeePerGas * 110n, 'cancellation_fee_bump_required');
          return await persistAndBroadcast({ from, to: from, data: '0x', nonce: active.nonce }, 'cancel');
        }
        // Exact saved bytes are safe to rebroadcast after a lost response. They
        // may now revert because another sponsor consumed the authority nonce;
        // final account-nonce consumption, not that target outcome, closes them.
        exposure = { kind: latest.kind, call: active.authorityTransaction };
        await rpc.broadcast(latest.raw);
        return { status: 'submitted', lifecycleDigest: journal.lifecycleDigest, hash: latest.hash, kind: latest.kind };
      }
      if (cancelGas) { await journal.close(closure); return { status: 'advance', lifecycleDigest: journal.lifecycleDigest }; }
      progress = await readPublicationProgress(inputs, store);
      ensure(equal(progress.outcome.goal, goal), 'goal_changed');
      const retained = known.find(record => equal(callOf(record), active.authorityTransaction));
      if (BigInt(retained.operation.nonce) < BigInt(progress.nonce) || progress.outcome.publication !== null) {
        await journal.close(closure); return { status: 'advance', lifecycleDigest: journal.lifecycleDigest };
      }
      return await persistAndBroadcast({ from, ...active.authorityTransaction, nonce: active.nonce }, 'call');
    }
    ensure(!cancelGas, 'no_gas_attempt_to_cancel');
    progress = await readPublicationProgress(inputs, store);
    ensure(equal(progress.outcome.goal, goal), 'goal_changed');
    if (progress.outcome.publication !== null) {
      await journal.complete(closure, verifyGoal);
      return { status: 'confirmed', lifecycleDigest: journal.lifecycleDigest, attempts: state.attempts.length };
    }
    let current = progress.current;
    if (!current) {
      await assertLease();
      let plan = await preparePointerPublication({ ...inputs, stage: 'retire', callGas: inputs.callGas });
      if (plan.complete) plan = await preparePointerPublication({ ...inputs, stage: 'publish', callGas: inputs.callGas });
      ensure(plan.hashAuthorityPlan.nonce === progress.nonce && plan.hashAuthorityPlan.currentRoot === progress.root
        && equal(plan.components, progress.baseline.components) && equal(plan.componentHashes, progress.baseline.componentHashes), 'preparation_changed');
      await assertLease();
      const record = await prepareDurableHashAuthority({ plan: plan.hashAuthorityPlan,
        accountRuntimeHash: progress.runtimeHash, port, vault, store });
      await assertLease(); current = { plan, record };
    }
    const nonces = await rpc.nonces(from);
    ensure(nonces.latest === nonces.pending, 'unreserved_pending_nonce');
    await assertLease();
    await journal.reserve(nonces.pending, callOf(current.record));
    return await persistAndBroadcast({ from, ...callOf(current.record), nonce: nonces.pending }, 'call');
  } finally { await journal.release(); }
}
