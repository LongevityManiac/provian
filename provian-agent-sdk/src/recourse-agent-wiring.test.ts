/**
 * The default Recourse deps wire the owner's bound addresses into the review and the reviewed amount into
 * submission. RED controls: an unreadable ownership record refuses; an unconfirmed binding is not counted;
 * submission carries the reviewed loss in atomic units.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerifiedTheftTransfer } from './recourse-theft-transfers';

const recourse = vi.hoisted(() => ({
  readRecourseOwnership: vi.fn(),
  submitAgentRestorationRequest: vi.fn(),
}));
const transfers = vi.hoisted(() => ({ resolveTheftTransfer: vi.fn() }));
vi.mock('./recourse', async (importOriginal) => ({ ...(await importOriginal<typeof import('./recourse')>()), ...recourse }));
vi.mock('./recourse-theft-transfers', async (importOriginal) => ({ ...(await importOriginal<typeof import('./recourse-theft-transfers')>()), ...transfers }));
vi.mock('./protocol-runtime', async (importOriginal) => ({ ...(await importOriginal<typeof import('./protocol-runtime')>()), ownerChainNetwork: () => ({}) }));

import { defaultAgentRecourseDeps, ownedAddresses, type AgentRecourseIdentity } from './recourse-agent';

const ME = '0x1111111111111111111111111111111111111111';
const OLD = '0x3333333333333333333333333333333333333333';
const PENDING = '0x5555555555555555555555555555555555555555';
const THIEF = '0x2222222222222222222222222222222222222222';
const h = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;
const config = { relayUrl: 'https://relay.test', apiKey: 'k', apiSecret: 's', walletId: 'wallet_aw_test' };
const identity: AgentRecourseIdentity = { directory: '/tmp/provian-test', walletId: 'wallet_aw_test', address: ME, config,
  keystore: { wallet_id: 'wallet_aw_test', address: ME } as AgentRecourseIdentity['keystore'], passphrase: 'pw' };

beforeEach(() => { vi.clearAllMocks(); });

describe('ownedAddresses', () => {
  it('counts the agent and every confirmed binding, lowercased', async () => {
    recourse.readRecourseOwnership.mockResolvedValue({ addresses: [
      { address: OLD.toUpperCase().replace('0X', '0x'), chainBindingStatus: 'confirmed' },
      { address: PENDING, chainBindingStatus: 'pending' },
    ] });
    expect(await ownedAddresses(config, ME)).toEqual([ME, OLD]);
  });
  it('RED: an unreadable ownership record refuses rather than reviewing with a partial set', async () => {
    recourse.readRecourseOwnership.mockRejectedValue(Error('recourse_request_refused:503'));
    await expect(ownedAddresses(config, ME)).rejects.toThrow(/refused/);
    recourse.readRecourseOwnership.mockResolvedValue({ addresses: 'nope' });
    await expect(ownedAddresses(config, ME)).rejects.toThrow(/recourse_reply_invalid/);
  });
});

describe('defaultAgentRecourseDeps', () => {
  it('reviews over the owned set and submits the reviewed loss in atomic units', async () => {
    recourse.readRecourseOwnership.mockResolvedValue({ addresses: [{ address: OLD, chainBindingStatus: 'confirmed' }] });
    const verified: VerifiedTheftTransfer = { transactionHash: h(1), from: ME, to: THIEF, amount: '42.5', timestamp: 0, block: 7,
      blockHash: h(2), recipients: [{ to: THIEF, amount: '42.5' }] };
    transfers.resolveTheftTransfer.mockResolvedValue(verified);
    recourse.submitAgentRestorationRequest.mockResolvedValue({ walletId: 'wallet_aw_test', destination: ME, generation: 1, restorationRequestId: h(3) });
    const deps = defaultAgentRecourseDeps(identity, (sub) => sub);
    await deps.resolveTransfer(h(1));
    expect(transfers.resolveTheftTransfer).toHaveBeenCalledWith(h(1), ME, expect.anything(), [ME, OLD]);
    await deps.submitRestoration(verified);
    expect(recourse.submitAgentRestorationRequest).toHaveBeenCalledWith(config, expect.objectContaining({
      transactionHash: h(1), block: 7, expectedMaximumLoss: '42500000000000000000' }));
  });
});
