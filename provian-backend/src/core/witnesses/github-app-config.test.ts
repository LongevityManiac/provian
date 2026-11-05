/**
 * github-app-config env-loading tests.
 *
 * Mirrors the existing per-domain config loader testing style (see
 * core/foundation-membership/client.shortCircuit.test.ts for the pattern).
 */

import { loadGitHubAppConfig } from './github-app-config';

describe('loadGitHubAppConfig', () => {
  const originalEnv = process.env.GITHUB_APP_WEBHOOK_SECRET;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.GITHUB_APP_WEBHOOK_SECRET;
    } else {
      process.env.GITHUB_APP_WEBHOOK_SECRET = originalEnv;
    }
  });

  it('returns disabled when GITHUB_APP_WEBHOOK_SECRET is unset', () => {
    delete process.env.GITHUB_APP_WEBHOOK_SECRET;
    const cfg = loadGitHubAppConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.webhookSecret).toBeNull();
  });

  it('returns disabled when GITHUB_APP_WEBHOOK_SECRET is empty string', () => {
    process.env.GITHUB_APP_WEBHOOK_SECRET = '';
    const cfg = loadGitHubAppConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.webhookSecret).toBeNull();
  });

  it('returns enabled with the secret when GITHUB_APP_WEBHOOK_SECRET is a valid 32-char hex string', () => {
    process.env.GITHUB_APP_WEBHOOK_SECRET = 'a'.repeat(32);
    const cfg = loadGitHubAppConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.webhookSecret).toBe('a'.repeat(32));
  });

  it('returns enabled with the secret when GITHUB_APP_WEBHOOK_SECRET is a valid 64-char hex string', () => {
    process.env.GITHUB_APP_WEBHOOK_SECRET = '0123456789abcdef'.repeat(4);
    const cfg = loadGitHubAppConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.webhookSecret).toBe('0123456789abcdef'.repeat(4));
  });

  it('accepts base64-style characters (- _ + / =)', () => {
    const secret = 'aB3-_+/=' + 'x'.repeat(30); // 38 chars, mixed alphabet
    process.env.GITHUB_APP_WEBHOOK_SECRET = secret;
    const cfg = loadGitHubAppConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.webhookSecret).toBe(secret);
  });

  it('throws fail-loud when secret is set but shorter than 32 chars', () => {
    process.env.GITHUB_APP_WEBHOOK_SECRET = 'short';
    expect(() => loadGitHubAppConfig()).toThrow(/too short/i);
  });

  it('throws fail-loud when secret contains whitespace', () => {
    process.env.GITHUB_APP_WEBHOOK_SECRET = 'a'.repeat(20) + ' ' + 'a'.repeat(20);
    expect(() => loadGitHubAppConfig()).toThrow(/standard.*alphabet/i);
  });

  it('throws fail-loud when secret contains a placeholder marker like <set me>', () => {
    process.env.GITHUB_APP_WEBHOOK_SECRET = '<set-me-in-secret-manager-please-and-thank-you>';
    expect(() => loadGitHubAppConfig()).toThrow(/standard.*alphabet/i);
  });
});
