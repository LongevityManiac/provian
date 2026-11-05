/**
 * the escrow acts a job party signs (release / dispute / claim the refund). Every guard has a
 * RED control: a violating input must throw (or skip) with ZERO transactions sent.
 */
import { describe, it, expect, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  buildEscrowActionCall,
  checkEscrowActionPreconditions,
  executeEscrowAction,
  EscrowActionError,
  ONCHAIN_ESCROW_STATUS,
  type EscrowActionTarget,
  type OnchainEscrowState,
} from './HumanJobEscrowActions';
import type { OwnKeySigner } from './HumanJobEscrowFunder';

const ESCROW = '0x96560fDF49e563eFCdc2d502934676DC074732d0';
const DEPOSITOR = '0x1111111111111111111111111111111111111111';
const STRANGER = '0x2222222222222222222222222222222222222222';
const ONCHAIN_ID = '0x' + 'cd'.repeat(32);
const NOW_MS = 1_800_000_000_000;
const NOW_SEC = NOW_MS / 1000;

const target: EscrowActionTarget = { contract_address: ESCROW, onchain_escrow_id: ONCHAIN_ID, chain: 'base', depositor_address: DEPOSITOR };
const iface = new ethers.Interface([
  'function releaseEscrow(bytes32 escrowId)',
  'function disputeEscrow(bytes32 escrowId)',
  'function claimDisputeTimeout(bytes32 escrowId)',
]);

function state(status: number, autoReleaseAtSec = NOW_SEC + 86_400): OnchainEscrowState {
  return { depositor: DEPOSITOR, status, autoReleaseAt: BigInt(autoReleaseAtSec) };
}

function fakeSigner(address: string) {
  const sent: { to: string; data: string }[] = [];
  const signer: OwnKeySigner = {
    address,
    sendTransaction: vi.fn(async (tx: { to: string; data: string }) => {
      sent.push(tx);
      return { hash: '0x' + 'ee'.repeat(32), wait: async () => ({ status: 1 }) };
    }),
  };
  return { signer, sent };
}

describe('buildEscrowActionCall', () => {
  it('encodes each act against the on-chain escrow id', () => {
    const r = buildEscrowActionCall('release', target);
    expect(r.to).toBe(ESCROW);
    expect(r.chainId).toBe(8453);
    expect(iface.decodeFunctionData('releaseEscrow', r.data)[0].toLowerCase()).toBe(ONCHAIN_ID);
    expect(iface.decodeFunctionData('disputeEscrow', buildEscrowActionCall('dispute', target).data)[0].toLowerCase()).toBe(ONCHAIN_ID);
    expect(iface.decodeFunctionData('claimDisputeTimeout', buildEscrowActionCall('claim_refund', target).data)[0].toLowerCase()).toBe(ONCHAIN_ID);
  });

  it("RED: a relay-named foreign escrow contract is refused ", () => {
    expect(() => buildEscrowActionCall('release', { ...target, contract_address: '0x9999999999999999999999999999999999999999' })).toThrow(EscrowActionError);
    expect(() => buildEscrowActionCall('claim_refund', { ...target, contract_address: '0x9999999999999999999999999999999999999999' })).toThrow(/only acts on the escrow/);
  });

  it('RED: an unfunded escrow (no on-chain id) cannot be acted on', () => {
    expect(() => buildEscrowActionCall('release', { ...target, onchain_escrow_id: null })).toThrow(EscrowActionError);
  });
});

describe('release (the helper behind "Release payment")', () => {
  it('sends releaseEscrow from the payer while Funded', async () => {
    const { signer, sent } = fakeSigner(DEPOSITOR);
    const out = await executeEscrowAction('release', target, signer, async () => state(ONCHAIN_ESCROW_STATUS.Funded), NOW_MS);
    expect(out.alreadyDone).toBe(false);
    expect(sent).toHaveLength(1);
    expect(iface.decodeFunctionData('releaseEscrow', sent[0].data)[0].toLowerCase()).toBe(ONCHAIN_ID);
  });

  it('a release already on-chain is reported done and NOT sent twice', async () => {
    const { signer, sent } = fakeSigner(DEPOSITOR);
    const out = await executeEscrowAction('release', target, signer, async () => state(ONCHAIN_ESCROW_STATUS.Completed), NOW_MS);
    expect(out).toMatchObject({ alreadyDone: true, txHash: null });
    expect(sent).toHaveLength(0);
  });

  it('RED: a non-payer before auto-release is refused with zero sends', async () => {
    const { signer, sent } = fakeSigner(STRANGER);
    await expect(executeEscrowAction('release', target, signer, async () => state(ONCHAIN_ESCROW_STATUS.Funded), NOW_MS))
      .rejects.toMatchObject({ code: 'not_depositor' });
    expect(sent).toHaveLength(0);
  });

  it('RED: a disputed escrow cannot be released', () => {
    expect(() => checkEscrowActionPreconditions('release', DEPOSITOR, state(ONCHAIN_ESCROW_STATUS.Disputed), NOW_SEC))
      .toThrow(/not funded/);
  });
});

describe('dispute (the helper behind "Dispute")', () => {
  it('sends disputeEscrow from the payer while Funded and before auto-release', async () => {
    const { signer, sent } = fakeSigner(DEPOSITOR);
    await executeEscrowAction('dispute', target, signer, async () => state(ONCHAIN_ESCROW_STATUS.Funded), NOW_MS);
    expect(sent).toHaveLength(1);
    expect(iface.decodeFunctionData('disputeEscrow', sent[0].data)[0].toLowerCase()).toBe(ONCHAIN_ID);
  });

  it('RED: the hired party (not the depositor) is refused before any chain read or send', async () => {
    const { signer, sent } = fakeSigner(STRANGER);
    const read = vi.fn(async () => state(ONCHAIN_ESCROW_STATUS.Funded));
    await expect(executeEscrowAction('dispute', target, signer, read, NOW_MS)).rejects.toMatchObject({ code: 'not_depositor' });
    expect(read).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('RED: past auto-release a dispute is refused with zero sends', async () => {
    const { signer, sent } = fakeSigner(DEPOSITOR);
    await expect(executeEscrowAction('dispute', target, signer, async () => state(ONCHAIN_ESCROW_STATUS.Funded, NOW_SEC - 1), NOW_MS))
      .rejects.toMatchObject({ code: 'auto_release_passed' });
    expect(sent).toHaveLength(0);
  });
});

describe('claim_refund (permissionless timeout refund)', () => {
  it('sends claimDisputeTimeout on a Disputed escrow', async () => {
    const { signer, sent } = fakeSigner(STRANGER); // permissionless: anyone may send it
    await executeEscrowAction('claim_refund', target, signer, async () => state(ONCHAIN_ESCROW_STATUS.Disputed), NOW_MS);
    expect(sent).toHaveLength(1);
  });

  it('RED: an escrow that is not in dispute is refused with zero sends', async () => {
    const { signer, sent } = fakeSigner(DEPOSITOR);
    await expect(executeEscrowAction('claim_refund', target, signer, async () => state(ONCHAIN_ESCROW_STATUS.Funded), NOW_MS))
      .rejects.toMatchObject({ code: 'not_disputed' });
    expect(sent).toHaveLength(0);
  });
});
