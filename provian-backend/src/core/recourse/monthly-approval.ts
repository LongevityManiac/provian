import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import type { ProtocolDeployment } from '../protocol/pointer';
import { currentProtocolDeployment } from '../protocol/runtime';
import { readRecoursePoolState, type RecoursePoolState } from './pool-state';
import { readStandingMembershipState } from './standing-state';

export interface RecourseMonthlyApproval {
  readonly status: 'approved' | 'approval_required';
  readonly burnLimit: string;
  readonly reserveLimit: string;
  readonly earningsBpsLimit: number;
}

/** Both contributions from holdings are collected from the owner's designated
 * payer. The caller must verify ownership of that binding before reading it. */
export async function readRecourseMonthlyApproval(binding: string, displayedBinding: string,
  pool: RecoursePoolState, deployment: ProtocolDeployment): Promise<RecourseMonthlyApproval> {
  const legs = getOperatorBoundRpcLegs('base');
  if (!legs[0].operatorId || !legs[1].operatorId || legs[0].operatorId === legs[1].operatorId) {
    throw Error('recourse_rpc_operators_not_independent');
  }
  let first = true;
  const [payer, { mandate }] = await Promise.all([
    binding === displayedBinding ? pool : readRecoursePoolState(binding, deployment),
    readStandingMembershipState(binding, {
      rpcs: [
        { request: (method, params) => legs[0].provider.send(method, [...params]) },
        { request: (method, params) => legs[1].provider.send(method, [...params]) },
      ],
      deployment: async () => {
        if (!first) return currentProtocolDeployment({ fresh: true });
        first = false;
        return deployment;
      },
    }),
  ]);
  if (payer.blockHash !== deployment.blockHash || pool.blockHash !== deployment.blockHash
    || payer.pool !== pool.pool || payer.kernel !== pool.kernel || !payer.addressConsent
    || mandate.consentNonce !== payer.consentNonce || mandate.earningsBpsLimit > 10_000) {
    throw Error('recourse_monthly_approval_unverified');
  }
  const covered = mandate.active && BigInt(mandate.startMonth) <= BigInt(pool.month)
    && BigInt(mandate.burnLimit) >= BigInt(pool.participationBurnAtomic)
    && BigInt(mandate.reserveLimit) >= BigInt(pool.noEarningsContributionAtomic)
    && mandate.earningsBpsLimit >= pool.earningsBps;
  return {
    status: covered ? 'approved' : 'approval_required',
    burnLimit: mandate.burnLimit,
    reserveLimit: mandate.reserveLimit,
    earningsBpsLimit: mandate.earningsBpsLimit,
  };
}
