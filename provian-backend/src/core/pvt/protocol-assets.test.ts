jest.mock('../protocol/predecessor-burns', () => ({ predecessorBurnAcceptances: jest.fn(async () => []) }));
jest.mock('../protocol/runtime', () => ({ currentProtocolDeployment: jest.fn() }));
import { currentProtocolDeployment } from '../protocol/runtime';
import { protocolDeploymentFixture } from '../../__test-helpers__/protocol-fixture';
import { currentBaseAssets, baseAssetsForKernel } from './wallet-exchange';
import { currentChainRecordProfileFor, deriveChainRecordAct } from './chain-record-watcher';
import { parseFacilitatorSettlementBody } from './x402-facilitator-settlement';
import { transactionEvidence, transferLog } from './__test-helpers__/base-transaction-evidence';

const kernel = `0x${'12'.repeat(20)}`, retired = protocolDeploymentFixture.addresses.kernel.toLowerCase();
const owner = `0x${'23'.repeat(20)}`, recipient = `0x${'34'.repeat(20)}`, tx = `0x${'45'.repeat(32)}`;
const resolve = jest.mocked(currentProtocolDeployment);
beforeEach(() => resolve.mockResolvedValue({ ...protocolDeploymentFixture,
  addresses: { ...protocolDeploymentFixture.addresses, kernel } }));
it('discovers successor PVT and refuses the retired token without a rebuilt constant', async () => {
  const assets = await currentBaseAssets();
  expect(assets[kernel]).toBe('PVT');
  expect(assets[retired]).toBeUndefined();
  const profile = await currentChainRecordProfileFor(8453);
  for (const [token, expected] of [[kernel, 'act'], [retired, 'no_act']] as const) {
    const evidence = transactionEvidence({ transactionHash: tx, fromAddress: owner, toAddress: token,
      valueWei: '0', inputEmpty: false, logs: [transferLog(tx, token, owner, recipient, 7n, 1)] });
    expect(deriveChainRecordAct(evidence, owner, null, profile).status).toBe(expected);
  }
  expect(profile.excludedCounterparties.has(kernel)).toBe(true);
  expect(profile.institutionTargets.has(kernel)).toBe(false);
  expect(profile.institutionTargets.has(protocolDeploymentFixture.addresses.recoursePool)).toBe(true);
});
it('does not authorize an asset when pointer resolution fails', async () => {
  resolve.mockRejectedValue(new Error('protocol_pointer_rpc_disagreement'));
  await expect(currentBaseAssets()).rejects.toThrow('protocol_pointer_rpc_disagreement');
  await expect(currentChainRecordProfileFor(8453)).rejects.toThrow('protocol_pointer_rpc_disagreement');
  expect(() => baseAssetsForKernel(`0x${'00'.repeat(20)}`)).toThrow('protocol_kernel_invalid');
});
it('facilitator parser requires the currently resolved asset; neither missing nor retired passes', () => {
  const body = { chain: 'base', tx_hash: tx, buyer: owner, seller: recipient, asset: kernel, amount: '7', fee: '1', scheme: 'permit2' };
  expect(parseFacilitatorSettlementBody(body, kernel).ok).toBe(true);
  expect(parseFacilitatorSettlementBody(body).ok).toBe(false);
  expect(parseFacilitatorSettlementBody({ ...body, asset: retired }, kernel)).toEqual({ ok: false, reason: 'asset_not_allowed' });
});
