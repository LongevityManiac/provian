/**
 * SDK_VERSION drift guard.
 *
 * The runtime constant MUST equal package.json's version — it is what the SDK
 * reports to the relay and compares against the advertised "latest". This test
 * is its own RED negative control: bump package.json without bumping
 * src/version.ts (or vice versa) and it fails immediately, so the two cannot
 * silently skew.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { SDK_VERSION } from './version';

describe('SDK_VERSION', () => {
  it('matches package.json version exactly', () => {
    // __dirname (CommonJS) resolves under both tsc's node16/CJS typecheck and
    // vitest — unlike import.meta, which tsc rejects (TS1470) for CJS output.
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
    expect(pkg.name).toBe('@provian/agent-sdk');
    expect(SDK_VERSION).toBe(pkg.version);
  });

  it('is a well-formed semver string', () => {
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
