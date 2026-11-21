import type { Firestore } from 'firebase-admin/firestore';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { resolveHistoricalProtocolDeployment, type PointerRpc } from '../protocol/pointer';
import { PROTOCOL_POINTER_PIN } from '../protocol/pointer-pin.generated';
import { RECOURSE_POOL_ABI } from './pool-abi';
import { readPublishedRecourseRule, assertRecourseRuleTuple } from './membership-rule';
import type { PrivateCalendarRules, PrivateCalendarRule } from './private-membership-calendar';

/** The private calendar consumes only signed rules actually present in the
 * authenticated pool's schedule at the specified canonical checkpoint. */
export async function readPrivateCalendarSchedule(db: Firestore,
  checkpoint: { readonly pool: string; readonly block: number; readonly blockHash: string }): Promise<readonly PrivateCalendarRule[]> {
  const configured = getOperatorBoundRpcLegs('base');
  if (!configured[0].operatorId || !configured[1].operatorId || configured[0].operatorId === configured[1].operatorId) throw Error('recourse_rule_operators');
  const pointer = PROTOCOL_POINTER_PIN.address, pinHash = PROTOCOL_POINTER_PIN.runtimeHash;
  if (!pointer || !pinHash) throw Error('recourse_rule_pointer');
  const rpcs: readonly [PointerRpc, PointerRpc] = [{ request: (m, p) => configured[0].provider.send(m, [...p]) },
    { request: (m, p) => configured[1].provider.send(m, [...p]) }];
  const deployment = await resolveHistoricalProtocolDeployment(rpcs, pointer, pinHash, checkpoint.block, checkpoint.blockHash);
  if (deployment.addresses.recoursePool.toLowerCase() !== checkpoint.pool) throw Error('recourse_rule_pool');
  const call = async (method: string, args: readonly unknown[] = []) => {
    const values = await Promise.all(rpcs.map(rpc => rpc.request('eth_call', [{ to: checkpoint.pool,
      data: RECOURSE_POOL_ABI.encodeFunctionData(method, args) }, { blockHash: checkpoint.blockHash, requireCanonical: true }])));
    if (typeof values[0] !== 'string' || values[0] !== values[1]) throw Error('recourse_rule_disagreement');
    return RECOURSE_POOL_ABI.decodeFunctionResult(method, values[0]);
  };
  const count = Number((await call('monthlyRuleCount'))[0]);
  if (!Number.isSafeInteger(count) || count < 1) throw Error('recourse_rule_schedule');
  const rules: PrivateCalendarRule[] = [];
  for (let i = 0; i < count; i++) {
    const tuple = (await call('monthlyRuleAt', [i]))[0];
    const signed = await readPublishedRecourseRule(db, String(tuple[4]), pointer);
    assertRecourseRuleTuple(signed, { firstMonth: tuple[0], participationBurn: tuple[1], noEarningsContribution: tuple[2],
      earningsBps: tuple[3], signedRuleHash: tuple[4] });
    if (i > 0 && signed.rule.firstMonth <= rules[i - 1].rule.firstMonth) throw Error('recourse_rule_schedule');
    rules.push(Object.freeze({ rule: signed.rule, ruleHash: signed.ruleHash }));
  }
  return Object.freeze(rules);
}

export function privateCalendarRulesFromSchedule(schedule: readonly PrivateCalendarRule[]): PrivateCalendarRules {
  return month => {
    if (!Number.isSafeInteger(month) || month < 0) throw Error('recourse_rule_month');
    for (let i = schedule.length - 1; i >= 0; --i) if (schedule[i].rule.firstMonth <= month) return schedule[i];
    throw Error('recourse_rule_missing');
  };
}

export async function readPrivateCalendarRules(db: Firestore,
  checkpoint: { readonly pool: string; readonly block: number; readonly blockHash: string }): Promise<PrivateCalendarRules> {
  return privateCalendarRulesFromSchedule(await readPrivateCalendarSchedule(db, checkpoint));
}
