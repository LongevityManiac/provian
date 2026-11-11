import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { readPrivateCalendarRules } from './private-calendar-rules';
import { readPublishedRecourseRule } from './membership-rule';
import { RECOURSE_POOL_ABI } from './pool-abi';
import { fixture, configure, h, old, pointer } from './__test-helpers__/membership-receipt-fixture';
jest.mock('../onchain/rpc-provider', () => ({ getOperatorBoundRpcLegs: jest.fn() }));
jest.mock('../protocol/pointer-pin.generated', () => ({ PROTOCOL_POINTER_PIN: {
  address: '0x0000000000000000000000000000000000000001', runtimeHash: require('ethers').keccak256('0x6000'),
} }));
jest.mock('./membership-rule', () => ({ ...jest.requireActual('./membership-rule'), readPublishedRecourseRule: jest.fn() }));
function setup() {
  const f = fixture(); f.state.priorRevision = 1; f.state.publications = [];
  const state = { burn: 100, reserve: 100, bps: 100, first: 0, hash: h(9), disagree: false };
  configure(f.legs.map((leg, i) => ({ ...leg, send: async (m, p) => {
    if (m === 'eth_call') {
      const call = p[0] as { data: string; to: string };
      if (call.to === old[8] && call.data.startsWith(RECOURSE_POOL_ABI.getFunction('monthlyRuleCount')!.selector))
        return RECOURSE_POOL_ABI.encodeFunctionResult('monthlyRuleCount', [1]);
      if (call.to === old[8] && call.data.startsWith(RECOURSE_POOL_ABI.getFunction('monthlyRuleAt')!.selector))
        return RECOURSE_POOL_ABI.encodeFunctionResult('monthlyRuleAt', [[state.first, state.burn + (state.disagree && i === 1 ? 1 : 0), state.reserve, state.bps, state.hash]]);
    }
    return leg.send(m, p);
  } })));
  (readPublishedRecourseRule as jest.Mock).mockResolvedValue({ ruleHash: h(9), rule: {
    schema: 'provian-recourse-membership/v1', chainId: 8453, pointer, firstMonth: 0,
    participationBurnAtomic: '100', noEarningsContributionAtomic: '100', earningsBps: 100,
  } });
  return { state, read: () => readPrivateCalendarRules(createFakeFirestore() as unknown as Firestore,
    { pool: old[8], block: 100, blockHash: h(100) }) };
}
test('the canonical schedule supplies the signed private calendar amounts', async () => {
  const s = setup(), rules = await s.read();
  expect(rules(24286)).toMatchObject({ ruleHash: h(9), rule: { participationBurnAtomic: '100', noEarningsContributionAtomic: '100', earningsBps: 100 } });
  expect(() => rules(-1)).toThrow('month');
});
test('changed burn, reserve, rate, effective month, hash, disagreement and unverified signature each refuse', async () => {
  for (const field of ['burn', 'reserve', 'bps', 'first'] as const) {
    const s = setup(); s.state[field]++;
    await expect(s.read()).rejects.toThrow('chain_mismatch');
  }
  const s = setup(); s.state.hash = h(10);
  await expect(s.read()).rejects.toThrow('chain_mismatch');
  s.state.hash = h(9); s.state.disagree = true;
  await expect(s.read()).rejects.toThrow('disagreement');
  s.state.disagree = false; (readPublishedRecourseRule as jest.Mock).mockRejectedValue(Error('recourse_rule_unverified'));
  await expect(s.read()).rejects.toThrow('unverified');
});
