import * as providers from '../onchain/rpc-provider';
import type { ProtocolDeployment } from '../protocol/pointer';
import { readRecourseMonthlyApproval } from './monthly-approval';
import type { RecoursePoolState } from './pool-state';
import * as standing from './standing-state';

const binding = `0x${'ab'.repeat(32)}`;
const blockHash = `0x${'01'.repeat(32)}`;
const pool = { blockHash, addressConsent: true, consentNonce: '1', month: '12',
  participationBurnAtomic: '100', noEarningsContributionAtomic: '200', earningsBps: 100 } as RecoursePoolState;
const deployment = { blockHash } as ProtocolDeployment;
const mandate = { active: true, consentNonce: '1', startMonth: '12', closedMonth: '0',
  burnLimit: '100', reserveLimit: '200', earningsBpsLimit: 100, exitSalt: binding, exitCommitment: binding };

test('monthly approval requires the verified payer nonce and covers the current amounts', async () => {
  const legs = [{ operatorId: 'first', provider: {} }, { operatorId: 'second', provider: {} }] as unknown as ReturnType<typeof providers.getOperatorBoundRpcLegs>;
  const readProviders = jest.spyOn(providers, 'getOperatorBoundRpcLegs').mockReturnValue(legs);
  const state = jest.spyOn(standing, 'readStandingMembershipState').mockResolvedValue({ controller: '', mandate });
  try {
    const approved = await readRecourseMonthlyApproval(binding, binding, pool, deployment);
    expect(approved).toEqual({ status: 'approved', burnLimit: '100', reserveLimit: '200', earningsBpsLimit: 100 });
    await expect(readRecourseMonthlyApproval(binding, binding, { ...pool, participationBurnAtomic: '101' }, deployment))
      .resolves.toMatchObject({ status: 'approval_required' });
    await expect(readRecourseMonthlyApproval(binding, binding, { ...pool, consentNonce: '2' }, deployment))
      .rejects.toThrow('recourse_monthly_approval_unverified');
    await expect(readRecourseMonthlyApproval(binding, binding, { ...pool, addressConsent: false }, deployment))
      .rejects.toThrow('recourse_monthly_approval_unverified');
  } finally {
    readProviders.mockRestore();
    state.mockRestore();
  }
});
