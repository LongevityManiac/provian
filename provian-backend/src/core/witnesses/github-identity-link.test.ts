import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { GITHUB_WALLET_LINKS, pollGitHubIdentity, startGitHubIdentity } from './github-identity-link';
import type { githubPrRequest } from './github-pr-api';

describe('GitHub device identity proof', () => {
  function setup() {
    const fake = createFakeFirestore(); let now = 1793655000000;
    const request: jest.MockedFunction<typeof githubPrRequest> = jest.fn<ReturnType<typeof githubPrRequest>, Parameters<typeof githubPrRequest>>(async (_method, path, _token) => {
      if (path === '/login/device/code') return { device_code: 'secret-device-code', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 };
      if (path === '/login/oauth/access_token') return { access_token: 'secret-access-token', refresh_token: 'secret-refresh-token' };
      if (path === '/user') return { id: 123, login: 'proven-account' };
      throw new Error('unexpected');
    });
    return { fake, deps: { db: fake as unknown as Firestore, env: { TOKEN_SIGNING_SECRET: 'x'.repeat(64) }, request, now: () => now }, advance: () => { now += 6000; } };
  }
  it('binds only GitHub GET /user identity to the authenticated wallet, with encrypted session and no persisted access token', async () => {
    const { deps, fake, advance } = setup();
    const start = await startGitHubIdentity(deps, 'wallet-agent');
    expect(JSON.stringify(start)).not.toContain('secret-device-code');
    expect(JSON.stringify([...fake.store.values()])).not.toContain('secret-device-code');
    expect(await pollGitHubIdentity(deps, 'wallet-agent', String(start.state))).toEqual({ status: 'pending' });
    advance();
    expect(await pollGitHubIdentity(deps, 'wallet-agent', String(start.state))).toMatchObject({ status: 'completed', github_id: '123' });
    expect(fake.store.get(`${GITHUB_WALLET_LINKS}/123_wallet-agent`)).toMatchObject({ wallet_id: 'wallet-agent', verified_by: 'github_user_oauth' });
    const stored = JSON.stringify([...fake.store.values()]);
    expect(stored).not.toContain('secret-access-token'); expect(stored).not.toContain('secret-refresh-token');
    expect(stored).not.toContain('secret-device-code');
  });
  it('RED: another wallet cannot poll or steal the authorization session', async () => {
    const { deps, advance, fake } = setup(); const start = await startGitHubIdentity(deps, 'victim'); advance();
    await expect(pollGitHubIdentity(deps, 'attacker', String(start.state))).rejects.toThrow('not_found');
    expect([...fake.store.keys()].some((k) => k.startsWith(GITHUB_WALLET_LINKS))).toBe(false);
    expect(deps.request).toHaveBeenCalledTimes(1);
  });
  it('RED: client-provided identity is never accepted when GitHub refuses the device grant', async () => {
    const { deps, advance, fake } = setup(); const start = await startGitHubIdentity(deps, 'victim'); advance();
    deps.request.mockResolvedValueOnce({ error: 'access_denied', id: 123 });
    await expect(pollGitHubIdentity(deps, 'victim', String(start.state))).rejects.toThrow('authorization_refused');
    expect([...fake.store.keys()].some((k) => k.startsWith(GITHUB_WALLET_LINKS))).toBe(false);
  });
});
