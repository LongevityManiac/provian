import {readGenesisActivation} from './genesis-activation-store';
/**
 * Retention backfill (H2). Scans the durable Genesis retention collection —
 * where an in-window qualifying act lands when its persist gate refused
 * (activation absent, invalid, or killed) — re-runs the FULL persist gate
 * against the CURRENT activation, and promotes each record that now admits into
 * the mint-readable outbox, preserving its ORIGINAL qualifying timestamp so a
 * later settlement is indistinguishable from one that persisted on the first try.
 *
 * Fail-closed by construction: a retained record alone is never a grant. The gate
 * is re-run per record, so a record whose activation is still absent/invalid/killed
 * (or whose original act was out of window) is NEVER promoted. Idempotent: the
 * outbox-existence check is the authoritative dedupe, so a second run promotes
 * nothing. Dry-run classifies without writing.
 *
 * Scheduled by the `provian-genesis-retention-backfill` cron (F-A1-2,
 * `/v1/internal/scheduler/genesis-retention-backfill`) so a row retained after a
 * transient activation-read failure is promoted and minted without a human run;
 * the operator script (scripts/wp12-genesis-retention-backfill.ts) remains for
 * manual invocation.
 */
import type { DocumentReference, Firestore, Transaction } from 'firebase-admin/firestore';

import {
  GENESIS_ACTIVATION_COLLECTION,
  GENESIS_ACTIVATION_DOCUMENT,
  GENESIS_QUALIFICATION_RETENTION_COLLECTION,
  genesisQualificationRef,
  isRetainedGenesisQualification,
  shouldPersistGenesisQualification,
  writeGenesisQualification,
  type RetainedGenesisQualification,
} from './genesis-award-state-machine';
import {
  verifyGenesisCampaignActivationApproval,
  type GenesisActivationApprovalVerifier,
} from './policy/genesis-policy-engine';

export type RetentionBackfillOutcome =
  | 'promoted'
  | 'already_present'
  | 'still_refused'
  | 'invalid';

export interface RetentionBackfillReport {
  readonly dry_run: boolean;
  readonly scanned: number;
  /** Qualification ids newly written to the outbox this run. */
  readonly promoted: readonly string[];
  /** Outbox row already existed (idempotent no-op). */
  readonly already_present: readonly string[];
  /** Gate still refuses — activation absent/invalid/killed, or act out of window. */
  readonly still_refused: readonly string[];
  /** Retention doc failed structural validation. */
  readonly invalid: readonly string[];
}

export interface RetentionBackfillDeps {
  readonly db: Firestore;
  /** Test seam. Production verifies the configured SSHSIG. */
  readonly verifyGenesisActivationApproval?: GenesisActivationApprovalVerifier;
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

/** Decide an outcome for a valid retained record without writing. */
function classifyAdmissible(
  retained: RetainedGenesisQualification,
  outboxExists: boolean,
  activationValue: unknown,
  verifier: GenesisActivationApprovalVerifier,
): Exclude<RetentionBackfillOutcome, 'invalid'> {
  if (outboxExists) return 'already_present';
  const qual = retained.qualification;
  // Re-run the FULL persist gate against the current activation, using the
  // ORIGINAL qualifying timestamp so the window check is applied as of the act.
  const admits = shouldPersistGenesisQualification(
    qual.action_type,
    qual.qualifying_act_evidence.qualifying_act_at_ms,
    activationValue,
    verifier,
  );
  return admits ? 'promoted' : 'still_refused';
}

export async function backfillRetainedGenesisQualifications(
  deps: RetentionBackfillDeps,
  options: { dryRun?: boolean; limit?: number; now?: number } = {},
): Promise<RetentionBackfillReport> {
  const { db } = deps;
  const verifier = deps.verifyGenesisActivationApproval
    ?? verifyGenesisCampaignActivationApproval;
  const dryRun = options.dryRun ?? false;
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error('backfill now is not a non-negative safe integer');
  }

  const activationRef = db.collection(GENESIS_ACTIVATION_COLLECTION)
    .doc(GENESIS_ACTIVATION_DOCUMENT);
  const scan = await db.collection(GENESIS_QUALIFICATION_RETENTION_COLLECTION)
    .limit(limit)
    .get();

  const promoted: string[] = [];
  const alreadyPresent: string[] = [];
  const stillRefused: string[] = [];
  const invalid: string[] = [];

  const record = (id: string, outcome: RetentionBackfillOutcome): void => {
    if (outcome === 'promoted') promoted.push(id);
    else if (outcome === 'already_present') alreadyPresent.push(id);
    else if (outcome === 'still_refused') stillRefused.push(id);
    else invalid.push(id);
  };

  for (const docSnap of scan.docs) {
    const id = docSnap.id;
    const raw: unknown = docSnap.data();
    if (!isRetainedGenesisQualification(raw)) {
      invalid.push(id);
      continue;
    }
    const outboxRef = genesisQualificationRef(
      db,
      raw.qualification.action_type,
      raw.qualification.immutable_anchor.anchor_id,
    );

    if (dryRun) {
      const [outboxSnap, activationSnap] = await Promise.all([
        outboxRef.get(),
        readGenesisActivation(db),
      ]);
      record(id, classifyAdmissible(
        raw,
        outboxSnap.exists,
        activationSnap.exists ? activationSnap.data() : undefined,
        verifier,
      ));
      continue;
    }

    const retainedRef = docSnap.ref as DocumentReference;
    try {
      const outcome = await db.runTransaction(async (txn: Transaction) => {
        const [retainedSnap, outboxSnap, activationSnap] = await Promise.all([
          txn.get(retainedRef),
          txn.get(outboxRef),
          readGenesisActivation(db, txn),
        ]);
        const current: unknown = retainedSnap.data();
        if (!retainedSnap.exists || !isRetainedGenesisQualification(current)) {
          return 'invalid' as RetentionBackfillOutcome;
        }
        const cls = classifyAdmissible(
          current,
          outboxSnap.exists,
          activationSnap.exists ? activationSnap.data() : undefined,
          verifier,
        );
        if (cls === 'promoted') {
          // Byte-identical to a first-try persist: the original frozen document.
          writeGenesisQualification(txn, db, current.qualification);
          txn.update(retainedRef, { promoted_at_ms: now });
        } else if (cls === 'already_present' && current.promoted_at_ms === null) {
          txn.update(retainedRef, { promoted_at_ms: now });
        }
        return cls;
      });
      record(id, outcome);
    } catch {
      // A single malformed record must not abort the batch. Fail-closed: not promoted.
      invalid.push(id);
    }
  }

  return {
    dry_run: dryRun,
    scanned: scan.docs.length,
    promoted,
    already_present: alreadyPresent,
    still_refused: stillRefused,
    invalid,
  };
}
