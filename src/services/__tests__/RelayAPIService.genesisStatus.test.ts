/**
 * Regression (Capability-Truthfulness Audit Pass-2 #28):
 *
 * getGenesisWalletStatus (backend) + the mounted /v1/{agent/}genesis/status
 * routes had NO client consumer, so a funded wallet got no in-app feedback that
 * the genesis ladder detected funding or what the next milestone is. This pins
 * the new client read-back: RelayAPIService.getGenesisStatus() resolves the
 * caller's relay wallet id and GETs the per-wallet genesis status, returning the
 * parsed body on 2xx and failing soft (null) otherwise — never throwing into the
 * Abundance dashboard.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// NotificationService pulls in expo-notifications/expo-constants, which fail
// under the node test env and are irrelevant to this read.
vi.mock('../NotificationService', () => ({ default: {} }));

import RelayAPIService, { type GenesisWalletStatus } from '../RelayAPIService';

type AuthFetch = (endpoint: string, options?: RequestInit, retryOnAuth?: boolean) => Promise<Response>;
const svc = RelayAPIService as unknown as {
  makeAuthenticatedRequest: AuthFetch;
  getRelayWalletId: () => Promise<string | null>;
};

function fakeResponse(init: { ok: boolean; status: number; body: unknown }): Response {
  return {
    ok: init.ok,
    status: init.status,
    json: async () => init.body,
  } as unknown as Response;
}

// cutover reconciliation: the backend v3 legacy-record projection — the retired ladder/pool/
// next fields are deleted server-side.
const STATUS: GenesisWalletStatus = {
  wallet_id: 'wallet_abc',
  schema: 'genesis-wallet-status/v3-legacy-record',
  legacy_record_only: true,
  genesis_pvt_earned_record: 0,
  pvt9: { genesis_armed: false, genesis_window_approved: false },
};

describe('getGenesisStatus — client read-back (#28)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('reads back the genesis status for the resolved wallet id', async () => {
    vi.spyOn(svc, 'getRelayWalletId').mockResolvedValue('wallet_abc');
    const reqSpy = vi
      .spyOn(svc, 'makeAuthenticatedRequest')
      .mockResolvedValue(fakeResponse({ ok: true, status: 200, body: STATUS }));

    const result = await RelayAPIService.getGenesisStatus();

    expect(result).toEqual(STATUS);
    // Hits the per-wallet, ownership-gated route with the resolved id.
    expect(reqSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^\/v1\/genesis\/status\/wallet_abc\?_=/),
      expect.objectContaining({ cache: 'no-store' }), undefined, undefined,
    );
  });

  it('url-encodes the wallet id in the path', async () => {
    vi.spyOn(svc, 'getRelayWalletId').mockResolvedValue('wallet/abc');
    const reqSpy = vi
      .spyOn(svc, 'makeAuthenticatedRequest')
      .mockResolvedValue(fakeResponse({ ok: true, status: 200, body: STATUS }));

    await RelayAPIService.getGenesisStatus();
    expect(reqSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^\/v1\/genesis\/status\/wallet%2Fabc\?_=/),
      expect.objectContaining({ cache: 'no-store' }), undefined, undefined,
    );
  });

  it('returns null on a non-2xx (e.g. ownership 403) without throwing', async () => {
    vi.spyOn(svc, 'getRelayWalletId').mockResolvedValue('wallet_abc');
    vi.spyOn(svc, 'makeAuthenticatedRequest').mockResolvedValue(
      fakeResponse({ ok: false, status: 403, body: { error: 'Access denied' } }),
    );

    await expect(RelayAPIService.getGenesisStatus()).resolves.toBeNull();
  });

  it('returns null and makes NO request when no wallet id is resolvable (pre-wallet)', async () => {
    vi.spyOn(svc, 'getRelayWalletId').mockResolvedValue(null);
    const reqSpy = vi.spyOn(svc, 'makeAuthenticatedRequest');

    await expect(RelayAPIService.getGenesisStatus()).resolves.toBeNull();
    expect(reqSpy).not.toHaveBeenCalled();
  });

  it('returns null (not a throw) if the request itself rejects', async () => {
    vi.spyOn(svc, 'getRelayWalletId').mockResolvedValue('wallet_abc');
    vi.spyOn(svc, 'makeAuthenticatedRequest').mockRejectedValue(new Error('network down'));

    await expect(RelayAPIService.getGenesisStatus()).resolves.toBeNull();
  });
});
