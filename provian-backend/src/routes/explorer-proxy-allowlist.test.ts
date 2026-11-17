/**
 * The explorer proxy forwards only allowlisted `module:action` pairs, and the
 * route checks the allowlist before its rate limiter and before any upstream work.
 */
import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { EXPLORER_ALLOWED_ACTIONS, explorerActionKey, explorerQueryAllowed } from './explorer-proxy-allowlist';

describe('explorer proxy allowlist', () => {
  const sample: ReadonlySet<string> = new Set(['account:txlist']);

  it('RED: with a non-empty allowlist, only the listed pair passes (the check can fail and can pass)', () => {
    expect(explorerQueryAllowed({ module: 'account', action: 'txlist', address: '0xabc' }, sample)).toBe(true);
    expect(explorerQueryAllowed({ module: 'account', action: 'tokentx' }, sample)).toBe(false);
    expect(explorerQueryAllowed({ module: 'contract', action: 'txlist' }, sample)).toBe(false);
  });

  it('RED: a missing, repeated or non-string module/action is refused even when a listed value is among them', () => {
    expect(explorerQueryAllowed({ action: 'txlist' }, sample)).toBe(false);
    expect(explorerQueryAllowed({ module: 'account' }, sample)).toBe(false);
    expect(explorerQueryAllowed({ module: ['account', 'contract'], action: 'txlist' }, sample)).toBe(false);
    expect(explorerQueryAllowed({ module: 'account', action: ['txlist', 'getsourcecode'] }, sample)).toBe(false);
    expect(explorerQueryAllowed({ module: { a: 'account' }, action: 'txlist' }, sample)).toBe(false);
    expect(explorerActionKey({ module: '', action: 'txlist' })).toBeNull();
  });

  it('no client calls the explorer proxy, so the shipped allowlist refuses every action', () => {
    expect(EXPLORER_ALLOWED_ACTIONS.size).toBe(0);
    for (const query of [
      { module: 'account', action: 'txlist' },
      { module: 'account', action: 'tokentx' },
      { module: 'contract', action: 'getsourcecode' },
      { module: 'proxy', action: 'eth_sendRawTransaction' },
      {},
    ]) {
      expect(explorerQueryAllowed(query)).toBe(false);
    }
  });

  it('RED: the route refuses a non-allowlisted query before the rate limiter, the key lookup and the upstream fetch', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.ts'), 'utf8');
    const start = server.indexOf("app.get('/api/proxy/explorer/:network'");
    expect(start).toBeGreaterThan(-1);
    const route = server.slice(start, server.indexOf('\n});', start));
    const guard = route.indexOf('explorerQueryAllowed(req.query');
    expect(guard).toBeGreaterThan(-1);
    for (const later of ["checkProxyRateLimit(user_id, 'explorer'", 'PROXY_CONFIG.explorer.apiKeys[network]', 'fetchWithTimeout(']) {
      const at = route.indexOf(later);
      expect(at).toBeGreaterThan(-1);
      expect(guard).toBeLessThan(at);
    }
    expect(route.slice(guard, route.indexOf("checkProxyRateLimit(user_id, 'explorer'"))).toMatch(/status\(403\)[\s\S]*EXPLORER_ACTION_NOT_ALLOWED/);
  });
});
