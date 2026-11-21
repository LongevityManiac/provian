import type { Firestore } from 'firebase-admin/firestore';
import { currentProtocolDeployment } from '../protocol/runtime';
import { privateCalendarRulesFromSchedule, readPrivateCalendarSchedule } from './private-calendar-rules';
import type { PrivateCalendarRule } from './private-membership-calendar';
import { parseRecourseMembershipRule, recourseMembershipRuleHash } from './membership-rule';
import { RECOURSE_RATIO_COLLECTION } from './pool-ratio';
import { readRecoursePoolState } from './pool-state';

export const UNBOUND_RECOURSE_IDENTITY = `0x${'00'.repeat(32)}`;
const displayDoc = (db: Firestore) => db.collection(RECOURSE_RATIO_COLLECTION).doc('display');

export interface RecourseDisplayPool {
  readonly pool: string;
  readonly kernel: string;
  readonly revision: string;
  readonly block: number;
  readonly blockHash: string;
  readonly timestamp: number;
  readonly month: string;
  readonly reserveAtomic: string;
  readonly participationBurnAtomic: string;
  readonly noEarningsContributionAtomic: string;
  readonly earningsBps: number;
  readonly signedRuleHash: string;
  readonly observedAtMs: number;
  readonly schedule: readonly PrivateCalendarRule[];
}

/** The existing scheduler publishes a display checkpoint from the two Base
 * providers. Authorization paths continue to use their own fresh chain ports. */
export async function refreshRecoursePoolDisplay(db: Firestore): Promise<void> {
  const deployment = await currentProtocolDeployment();
  const state = await readRecoursePoolState(UNBOUND_RECOURSE_IDENTITY, deployment);
  const schedule = await readPrivateCalendarSchedule(db, state);
  const row: RecourseDisplayPool = {
    pool: state.pool, kernel: state.kernel, revision: deployment.revision.toString(),
    block: state.block, blockHash: state.blockHash, timestamp: state.timestamp,
    month: state.month, reserveAtomic: state.reserveAtomic, observedAtMs: Date.now(),
    participationBurnAtomic: state.participationBurnAtomic, noEarningsContributionAtomic: state.noEarningsContributionAtomic,
    earningsBps: state.earningsBps, signedRuleHash: state.signedRuleHash, schedule,
  };
  validateDisplayPool(row);
  const ref = displayDoc(db);
  await db.runTransaction(async tx => {
    const previous = (await tx.get(ref)).data() as RecourseDisplayPool | undefined;
    if (previous && (BigInt(previous.revision) > BigInt(row.revision) || previous.block > row.block)) return;
    if (previous && previous.block === row.block && previous.blockHash !== row.blockHash) throw Error('recourse_display_checkpoint_changed');
    tx.set(ref, row);
  });
}

function validateDisplayPool(row: RecourseDisplayPool): RecourseDisplayPool {
  const address = /^0x[0-9a-f]{40}$/, hash = /^0x[0-9a-f]{64}$/, uint = /^(0|[1-9][0-9]*)$/;
  if (!address.test(row.pool) || !address.test(row.kernel) || !hash.test(row.blockHash)
    || !Number.isSafeInteger(row.block) || row.block <= 0 || !Number.isSafeInteger(row.timestamp) || row.timestamp <= 0
    || !Number.isSafeInteger(row.observedAtMs) || !uint.test(row.revision) || !uint.test(row.reserveAtomic)
    || !uint.test(row.month) || !Array.isArray(row.schedule)) throw Error('recourse_display_invalid');
  const schedule = row.schedule.map(({ rule, ruleHash }, i) => {
    const parsed = parseRecourseMembershipRule(rule);
    if (recourseMembershipRuleHash(parsed) !== ruleHash
      || (i > 0 && parsed.firstMonth <= row.schedule[i - 1].rule.firstMonth)) throw Error('recourse_display_invalid');
    return { rule: parsed, ruleHash };
  });
  const active = privateCalendarRulesFromSchedule(schedule)(Number(row.month));
  if (active.ruleHash !== row.signedRuleHash || active.rule.earningsBps !== row.earningsBps
    || active.rule.participationBurnAtomic !== row.participationBurnAtomic
    || active.rule.noEarningsContributionAtomic !== row.noEarningsContributionAtomic) throw Error('recourse_display_rule_changed');
  return { ...row, schedule };
}

export async function readRecoursePoolDisplay(db: Firestore): Promise<RecourseDisplayPool> {
  const row = (await displayDoc(db).get()).data() as RecourseDisplayPool | undefined;
  if (!row) throw Error('recourse_display_unavailable');
  return validateDisplayPool(row);
}
