/**
 * The relay must never send an access token past the expiry the metadata server reported.
 *
 * The fake below behaves like google-auth-library's client: it caches its token against the
 * reported expiry and fetches a new one within five minutes of it. The metadata server hands out
 * its own cached token, so a token can arrive with only minutes left; here it has ten.
 */
let clockMs = 0;
let issued = 0;
const metadataTokenLifetimeMs = 10 * 60_000;

class FakeComputeClient {
  private token: { value: string; expiresAtMs: number } | null = null;
  async getAccessToken(): Promise<{ token: string }> {
    if (!this.token || this.token.expiresAtMs - 5 * 60_000 <= clockMs) {
      issued += 1;
      this.token = { value: `token-${issued}`, expiresAtMs: clockMs + metadataTokenLifetimeMs };
    }
    return { token: this.token.value };
  }
  validAt(value: string, atMs: number): boolean {
    return this.token?.value === value && atMs < this.token.expiresAtMs;
  }
}
const client = new FakeComputeClient();

jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({ getClient: async () => client })),
}));

import { getGcpAccessToken, __resetGcpRestForTest } from './google-rest';

beforeEach(() => {
  __resetGcpRestForTest();
  clockMs = Date.parse('2026-11-06T04:04:53Z');
  issued = 0;
});

it('a short-lived metadata token is refreshed before it expires, never reused after it', async () => {
  const first = await getGcpAccessToken(undefined, clockMs);
  expect(first).toBe('token-1');
  expect(client.validAt(first!, clockMs)).toBe(true);

  // Thirty-six minutes later, the moment the receipt hand-offs began failing in production.
  clockMs += 36 * 60_000;
  const later = await getGcpAccessToken(undefined, clockMs);
  expect(later).not.toBeNull();
  expect(client.validAt(later!, clockMs)).toBe(true);
  expect(later).not.toBe(first);
});

it('every token handed out over an hour is valid when it is handed out', async () => {
  const handed: Array<{ token: string; atMs: number; valid: boolean }> = [];
  for (let minute = 0; minute <= 60; minute += 1) {
    const token = await getGcpAccessToken(undefined, clockMs);
    handed.push({ token: token!, atMs: clockMs, valid: client.validAt(token!, clockMs) });
    clockMs += 60_000;
  }
  expect(handed).toHaveLength(61);
  expect(handed.filter(h => !h.valid)).toEqual([]);
  expect(issued).toBeGreaterThan(1);
});
