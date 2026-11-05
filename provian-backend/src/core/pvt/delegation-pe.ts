/**
 * Delegation — which linked-agent acts credit the human beneficiary as their director
 * (F-A6-1; decision, confirmed 2026-09-04).
 *
 * PE METER (, item 8): delegation is a running total on the human
 * (`human_delegation_totals_v1`), applied once per fresh qualifying act in the batch commit
 * (`core/meter/meter-commit.ts`). The separate record_only `agent_work_delegated` PE this module
 * once wrote into the human's chain is retired; the economic event was always the 80/20
 * beneficiary split, never the delegation record.
 */

import { getActionTypeTier } from './pe-weight-framework';

const DELEGATION_QUALIFYING_MIN_TIER = 3;

const DELEGATION_QUALIFYING_TYPES = new Set([
  'agent_work_product_code',
  'agent_work_product_research',
  'agent_work_product_analysis',
  'agent_work_product_document',
  'agent_work_product_design',
  'agent_work_product_data',
  'agent_work_product_other',
  'agent_work_product',
  'agent_commit',
  'agent_communicate',
  'agent_public_post',
  'agent_share_data',
  'agent_authorization',
]);

/** Whether a linked agent's act of this type credits its human beneficiary as director. */
export function isDelegationQualifying(actionType: string): boolean {
  if (DELEGATION_QUALIFYING_TYPES.has(actionType)) return true;
  const tier = getActionTypeTier(actionType);
  return tier >= DELEGATION_QUALIFYING_MIN_TIER;
}
