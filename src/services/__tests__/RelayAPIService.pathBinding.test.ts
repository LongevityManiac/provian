/**
 * Wallet auth token path binding (regression).
 *
 * v2 wallet tokens bind to the request path via `pth`. The server
 * canonicalizes the request path with the query string stripped
 * (provian-backend wallet-auth.ts: `(req.originalUrl).split('?')[0]`), then
 * rejects the token with 401 "Token path mismatch" if `pth` differs.
 *
 * Regression: callers pass the full endpoint including `?limit=...` to the
 * token builder. Without stripping the query client-side, every query-string
 * GET (pvt/history, pvt/mint-history, provenance-envelopes, witness poll)
 * 401'd while query-less endpoints (pvt/accrual) passed - which surfaced on
 * the Abundance screen as "No provenance envelopes yet" despite a non-zero
 * PE count. This test pins the client `pth` to the server's canonical form.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as SecureStore from 'expo-secure-store';

// NotificationService pulls in expo-notifications/expo-constants, which load
// the Expo winter runtime and fail under the node test env. RelayAPIService
// only references it for push registration, irrelevant to token signing.
vi.mock('../NotificationService', () => ({ default: {} }));

import RelayAPIService from '../RelayAPIService';

const AUTH_SECRET_KEY = 'provian_relay_auth_secret';
const USER_ID_KEY = 'provian_relay_user_id';

function decodePth(token: string): string {
  const payloadB64 = token.slice(0, token.lastIndexOf('.'));
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString());
  return payload.pth;
}

describe('RelayAPIService wallet token path binding', () => {
  beforeEach(async () => {
    await SecureStore.setItemAsync(AUTH_SECRET_KEY, 'test-secret');
    await SecureStore.setItemAsync(USER_ID_KEY, 'user_test');
  });

  it('strips the query string from pth so it matches the server canonical path', async () => {
    const token = await RelayAPIService.getSignedAuthToken(
      'GET',
      '/v1/pvt/history?limit=10&offset=0&showHidden=false',
    );
    expect(token).toBeTruthy();
    expect(decodePth(token!)).toBe('/v1/pvt/history');
  });

  it('leaves a query-less path unchanged', async () => {
    const token = await RelayAPIService.getSignedAuthToken('GET', '/v1/pvt/accrual');
    expect(token).toBeTruthy();
    expect(decodePth(token!)).toBe('/v1/pvt/accrual');
  });

  it('strips multi-param queries (provenance-envelopes list)', async () => {
    const token = await RelayAPIService.getSignedAuthToken(
      'GET',
      '/v1/provenance-envelopes?limit=20&offset=40',
    );
    expect(decodePth(token!)).toBe('/v1/provenance-envelopes');
  });
});
