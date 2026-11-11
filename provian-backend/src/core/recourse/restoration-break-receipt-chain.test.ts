import type { Firestore } from 'firebase-admin/firestore';
import { historicalBreakReceiptPort } from './restoration-break-receipt';
import { readRestorationSuccessionLineage } from './restoration-lineage';
import { authenticateRestorationExecutor } from './restoration-executor-runtime';
import { currentProtocolDeployment } from '../protocol/runtime';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
jest.mock('./restoration-lineage', () => ({ readRestorationSuccessionLineage: jest.fn() }));
jest.mock('./restoration-executor-runtime', () => ({ authenticateRestorationExecutor: jest.fn() }));
jest.mock('../protocol/runtime', () => ({ currentProtocolDeployment: jest.fn() }));
jest.mock('../onchain/rpc-provider', () => ({ getOperatorBoundRpcLegs: jest.fn() }));
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`, h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
beforeEach(() => { jest.resetAllMocks(); (getOperatorBoundRpcLegs as jest.Mock).mockReturnValue([0, 1].map(n => ({ operatorId: `rpc-${n}`, provider: { send: jest.fn() } }))); });
test('runtime verification and final caller fence retain the original lineage checkpoint across a same-manifest resolver replacement', async () => {
  const lineage = { kernel: a(1), executor: a(2), manifestHash: h(3), block: 150, blockHash: h(150),
    migrations: [{ kernel: a(1), executor: a(2), predecessor: a(10), cutoff: 100, cutoffHash: h(100), root: h(9), kind: 'cryptographic_break' }] };
  (readRestorationSuccessionLineage as jest.Mock).mockResolvedValue(lineage);
  (currentProtocolDeployment as jest.Mock).mockResolvedValue({ manifestHash: h(3), blockHash: h(999) });
  const result = await historicalBreakReceiptPort({} as Firestore).lineage(a(10));
  expect(result).toBe(lineage);
  expect(authenticateRestorationExecutor).toHaveBeenCalledWith(a(2), a(1), h(150), expect.any(Object));
  expect(currentProtocolDeployment).not.toHaveBeenCalled();
});
test('provider identity collision refuses before a runtime or historical read', () => {
  (getOperatorBoundRpcLegs as jest.Mock).mockReturnValue([0, 1].map(() => ({ operatorId: 'same' })));
  expect(() => historicalBreakReceiptPort({} as Firestore)).toThrow(/not_independent/);
});
