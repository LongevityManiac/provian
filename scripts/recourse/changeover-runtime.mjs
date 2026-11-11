import { Transaction, sha256, toUtf8Bytes } from 'ethers';
import { openChangeoverJournal } from '../../provian-backend/src/core/recourse/changeover-journal.ts';
import { openChangeoverFeeBudget } from '../../provian-backend/src/core/recourse/changeover-fees.ts';
import { advanceChangeoverStage } from './changeover-stage.mjs';
import { changeoverRpcPort } from './changeover-rpc.mjs';
const ensure = (value, code) => { if (!value) throw Error('changeover_runtime_' + code); };

/** Execute one already-authorized and independently validated stage. Keys are
 * requested lazily only after plan validation, signer reservation, simulation
 * and durable fee reservation. A terminal restart verifies receipts without
 * loading keys or taking a lease from later settlements. The caller owns the
 * explicit execution decision. assertPlan must compare the supplied exact
 * steps/stageDigest to its independently derived authorized stage, as well as
 * rechecking source state. A plan digest alone cannot authorize arbitrary steps. */
export async function runChangeoverStage({ db, steps, planDigest, readers, loadSigner, assertPlan,
  approvedStageBudgetWei, maxFeePerGas, maxPriorityFeePerGas, maxGas, workerId }) {
  steps = structuredClone(steps);
  ensure(typeof approvedStageBudgetWei === 'string' && /^[1-9][0-9]*$/.test(approvedStageBudgetWei)
    && [maxFeePerGas, maxPriorityFeePerGas, maxGas].every(value => typeof value === 'bigint' && value > 0n)
    && maxFeePerGas >= maxPriorityFeePerGas, 'fee_configuration');
  ensure(typeof assertPlan === 'function' && typeof loadSigner === 'function', 'callbacks');
  const stageDigest = sha256(toUtf8Bytes(JSON.stringify({ planDigest, steps })));
  const checkedPlan = async digest => {
    ensure(digest === planDigest, 'plan_changed');
    await assertPlan({ planDigest, stageDigest, steps: structuredClone(steps) });
  };
  ensure(readers.length === 2 && readers.every(reader => typeof reader.operatorId === 'string' && reader.operatorId
    && typeof reader.request === 'function')
    && readers[0].operatorId !== readers[1].operatorId, 'independent_operators');
  await checkedPlan(planDigest);
  const store = await openChangeoverJournal(db, { planDigest, steps, workerId });
  try {
    const completed = store.read().completed;
    ensure(store.stageDigest === stageDigest, 'stage_changed');
    const checkedLease = async () => { await store.assertLease(); await checkedPlan(planDigest); await store.assertLease(); };
    const budget = completed ? null : await openChangeoverFeeBudget(db, { stageDigest: store.stageDigest,
      approvedBudgetWei: approvedStageBudgetWei, readers, assertLease: checkedLease });
    const signers = new Map(), ports = new Map();
    for (const from of new Set(steps.map(step => step.from))) {
      const signer = {
        getAddress: async () => from,
        signTransaction: async transaction => {
          ensure(!completed, 'terminal_read_only');
          await checkedLease();
          if (!signers.has(from)) {
            const loaded = await loadSigner(from);
            ensure(String(await loaded.getAddress()).toLowerCase() === from, 'signer_mismatch');
            signers.set(from, loaded);
          }
          const unsigned = Transaction.from(transaction).unsignedSerialized;
          await checkedLease();
          const raw = await signers.get(from).signTransaction({ ...transaction });
          ensure(Transaction.from(raw).unsignedSerialized === unsigned, 'signer_mutated_request');
          return raw;
        },
      };
      ports.set(from, changeoverRpcPort({ rpcs: readers, signer, assertLease: checkedLease,
        maxFeePerGas, maxPriorityFeePerGas, maxGas,
        approveFee: async ({ transaction, blockHash }) => {
          ensure(budget, 'terminal_read_only');
          const matches = Object.entries(store.read().attempts).filter(([, attempt]) =>
            attempt.from === from && attempt.nonce === transaction.nonce);
          ensure(matches.length === 1, 'attempt_missing_or_ambiguous');
          await budget.reserve(Number(matches[0][0]), from, transaction, blockHash);
        },
      }));
    }
    const forSigner = from => { const value = ports.get(from); ensure(value, 'signer_unknown'); return value; };
    const portForRaw = raw => forSigner(Transaction.from(raw).from?.toLowerCase());
    const finalized = raw => portForRaw(raw).finalized(raw);
    const result = await advanceChangeoverStage({ steps, planDigest, journal: store.read(),
      port: { assertPlan: checkedPlan, assertLease: checkedLease, forSigner,
        included: raw => portForRaw(raw).included(raw) },
      persist: next => next.completed ? store.complete(finalized) : store.persist(next) });
    return { status: result.status, step: result.step, stageDigest: store.stageDigest,
      attempts: Object.keys(store.read().attempts).length };
  } finally { await store.release(); }
}
