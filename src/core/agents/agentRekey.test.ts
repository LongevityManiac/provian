import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock every collaborator so the real (heavy) chain never loads and each branch is
// controllable. The unit under test is rekeyAgent's ORCHESTRATION: recover the old
// key from escrow (when present), swap identity, sweep, and never leak the old key.
vi.mock('../../services/RelayAPIService', () => ({
  default: {
    getRecoveryEscrow: vi.fn(),
    recoveryRekey: vi.fn(),
  },
}));
vi.mock('./agentRecovery', () => ({
  mintAndPersistRecoveryAnchor: vi.fn(),
  recoverAgentKeyHex: vi.fn(),
}));
vi.mock('./agentRekeyCrypto', () => ({
  generateAgentKeyPair: vi.fn(),
  signRecoveryRekeyPoP: vi.fn(),
  recoveryRekeyMessage: vi.fn(),
  buildAgentRekeyCommand: vi.fn(),
}));
vi.mock('./agentBalanceSweep', () => ({
  sweepAgentPvt: vi.fn(),
}));
vi.mock('../security/agentKeyRecovery', () => ({
  sealToAnchor: vi.fn(),
  fromB64u: vi.fn(),
  toB64u: vi.fn(),
}));

import { rekeyAgent } from './agentRekey';
import RelayAPIService from '../../services/RelayAPIService';
import { mintAndPersistRecoveryAnchor, recoverAgentKeyHex } from './agentRecovery';
import { generateAgentKeyPair, signRecoveryRekeyPoP, recoveryRekeyMessage, buildAgentRekeyCommand } from './agentRekeyCrypto';
import { sealToAnchor, fromB64u, toB64u } from '../security/agentKeyRecovery';
import { sweepAgentPvt } from './agentBalanceSweep';

const OLD_KEY = 'a'.repeat(64);
const NEW_ADDR = '0x2222222222222222222222222222222222222222';

beforeEach(() => {
  // Reset EVERYTHING to a clean slate, then re-establish every default. vi.mock
  // factory fns are not reliably reset by restoreMocks between tests, so an
  // implementation set in one test would leak; resetAllMocks + full re-setup makes
  // each test deterministic. Tests override only the escrow/recovery/sweep branch.
  vi.resetAllMocks();
  vi.mocked(recoveryRekeyMessage).mockReturnValue('msg');
  vi.mocked(buildAgentRekeyCommand).mockReturnValue({ command: 'CMD', payload: 'PAYLOAD' } as never);
  vi.mocked(sealToAnchor).mockReturnValue(new Uint8Array([1, 2, 3]));
  vi.mocked(fromB64u).mockReturnValue(new Uint8Array([9]));
  vi.mocked(toB64u).mockReturnValue('sealed_b64u');
  vi.mocked(mintAndPersistRecoveryAnchor).mockResolvedValue({ recoveryEnabled: true, recoveryAnchorPubkeyB64u: 'anchorpub' });
  vi.mocked(generateAgentKeyPair).mockResolvedValue({
    privateKeyHex: 'b'.repeat(64), publicKeyHex: 'c'.repeat(128), address: NEW_ADDR,
  } as never);
  vi.mocked(signRecoveryRekeyPoP).mockResolvedValue('proof' as never);
  vi.mocked(RelayAPIService.recoveryRekey).mockResolvedValue({
    ok: true, new_address: NEW_ADDR, old_address: '0x1111111111111111111111111111111111111111',
    api_key: 'pvn_live_x', api_secret: 'pvns_y',
  } as never);
  // Default: no escrow, no old key, no sweep — the true lost-key case.
  vi.mocked(RelayAPIService.getRecoveryEscrow).mockResolvedValue({ ok: false, code: 'no_recovery_escrow' } as never);
  vi.mocked(recoverAgentKeyHex).mockResolvedValue(undefined as never);
  vi.mocked(sweepAgentPvt).mockResolvedValue({ status: 'no_old_key' });
});

describe('rekeyAgent — sweep integration', () => {
  it('escrow present → recovers the old key, sweeps old→new, and NEVER returns the old key', async () => {
    vi.mocked(RelayAPIService.getRecoveryEscrow).mockResolvedValue({
      ok: true, escrow: { sealed_key_blob: 'blob', recovery_anchor_pubkey: 'pub', wallet_id: 'w', blob_version: 1, created_at: 0, updated_at: 0 },
    } as never);
    vi.mocked(recoverAgentKeyHex).mockResolvedValue(OLD_KEY);
    vi.mocked(sweepAgentPvt).mockResolvedValue({
      status: 'swept', oldAddress: '0x1111111111111111111111111111111111111111', newAddress: NEW_ADDR,
      amountAtomic: '5', amountDisplay: '5.0', txHash: '0xabc', explorerUrl: 'u',
    });
    const confirmGasPrefund = vi.fn();

    const res = await rekeyAgent({ walletId: 'wallet_aw_abc', relayUrl: 'https://relay', confirmGasPrefund });

    expect(recoverAgentKeyHex).toHaveBeenCalledWith(expect.objectContaining({
      sealedKeyBlobB64u: 'blob', recoveryAnchorPubkeyB64u: 'pub',
    }), expect.toSatisfy((value: unknown) => value === undefined || (typeof value === 'object' && value !== null && 'nativeId' in value)));
    // The sweep is invoked with the recovered old key → the NEW address, and the
    // human's gas-confirm gate is threaded through.
    expect(sweepAgentPvt).toHaveBeenCalledWith({ oldKeyHex: OLD_KEY, newAddress: NEW_ADDR, confirmGasPrefund }, undefined);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.sweep.status).toBe('swept');

    // RED CONTROL: the recovered old key must never ride out of rekeyAgent. Its only
    // exits are the sweep call and the on-machine restore PAYLOAD (the NEW key). The
    // returned result must contain no old-key field and not the old key's bytes.
    expect(JSON.stringify(res)).not.toContain(OLD_KEY);
    expect(res).not.toHaveProperty('oldKeyHex');
  });

  it('no escrow → skips recovery + sweep, reports no_old_key', async () => {
    vi.mocked(RelayAPIService.getRecoveryEscrow).mockResolvedValue({ ok: false, code: 'no_recovery_escrow' } as never);

    const res = await rekeyAgent({ walletId: 'wallet_aw_abc', relayUrl: 'https://relay' });

    expect(recoverAgentKeyHex).not.toHaveBeenCalled();
    expect(sweepAgentPvt).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.sweep.status).toBe('no_old_key');
  });

  it('escrow present but recovery throws (wrong phone / tampered) → skips sweep, no_old_key', async () => {
    vi.mocked(RelayAPIService.getRecoveryEscrow).mockResolvedValue({
      ok: true, escrow: { sealed_key_blob: 'blob', recovery_anchor_pubkey: 'pub', wallet_id: 'w', blob_version: 1, created_at: 0, updated_at: 0 },
    } as never);
    vi.mocked(recoverAgentKeyHex).mockRejectedValue(new Error('anchor_secret_not_found'));

    const res = await rekeyAgent({ walletId: 'wallet_aw_abc', relayUrl: 'https://relay' });

    expect(sweepAgentPvt).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.sweep.status).toBe('no_old_key');
  });
});
