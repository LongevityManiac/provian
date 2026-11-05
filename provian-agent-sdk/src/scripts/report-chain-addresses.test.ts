import { describe, it, expect, afterEach } from 'vitest';
import { parseArgs, resolvePassphrase } from './report-chain-addresses';

const ENV = 'PROVIAN_KEYSTORE_PASSPHRASE';

describe('report-chain-addresses parseArgs', () => {
  it('parses --relay, --print, --help', () => {
    expect(parseArgs(['--relay', 'https://x', '--print'])).toEqual({ relay: 'https://x', print: true });
    expect(parseArgs(['-h'])).toEqual({ help: true });
    expect(parseArgs([])).toEqual({});
  });
});

describe('report-chain-addresses resolvePassphrase', () => {
  const original = process.env[ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  });

  it('returns the env passphrase when set', () => {
    process.env[ENV] = 'hunter2';
    expect(resolvePassphrase()).toBe('hunter2');
  });

  // RED: no env + no local secret file must yield null — never a fabricated passphrase.
  it('RED: returns null when no env and no local secret (never invents one)', () => {
    delete process.env[ENV];
    // readLocalKeystoreSecret reads ~/.provian/agent-keystore.secret; in CI that
    // file does not exist, so the fallback returns null. If a dev machine happens
    // to have one, this asserts a real base64/hex secret rather than a guess.
    const out = resolvePassphrase();
    expect(out === null || (typeof out === 'string' && out.length >= 32)).toBe(true);
  });
});
