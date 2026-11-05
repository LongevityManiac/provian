import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadOrCreateLocalKeystoreSecret, readLocalKeystoreSecret } from './local-keystore-secret';

let dir: string;
let secretPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-lks-'));
  secretPath = path.join(dir, 'nested', 'agent-keystore.secret');
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('local-keystore-secret (no-passphrase at-rest key)', () => {
  it('generates a 64-hex secret written 0600, creating the dir', () => {
    const secret = loadOrCreateLocalKeystoreSecret(secretPath);
    expect(secret).toMatch(/^[a-f0-9]{64}$/);
    const mode = fs.statSync(secretPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('is idempotent — a second call returns the SAME secret (keystore stays decryptable)', () => {
    const a = loadOrCreateLocalKeystoreSecret(secretPath);
    const b = loadOrCreateLocalKeystoreSecret(secretPath);
    expect(b).toBe(a);
    expect(readLocalKeystoreSecret(secretPath)).toBe(a);
  });

  it('readLocalKeystoreSecret returns null when absent or malformed (never throws)', () => {
    expect(readLocalKeystoreSecret(secretPath)).toBeNull();
    fs.mkdirSync(path.dirname(secretPath), { recursive: true });
    fs.writeFileSync(secretPath, 'not-a-valid-secret');
    expect(readLocalKeystoreSecret(secretPath)).toBeNull();
  });

  it('fix run 2026-10-24: an existing malformed secret is an error and is never overwritten (the keystore stays decryptable from it)', () => {
    fs.mkdirSync(path.dirname(secretPath), { recursive: true });
    const keystorePath = path.join(path.dirname(secretPath), 'agent-keystore.json');
    fs.writeFileSync(keystorePath, '{"crypto":"encrypted under the original secret bytes"}', { mode: 0o600 });
    // Recoverable but not the canonical shape: uppercase hex, a quoted value, an extra line.
    for (const malformed of [`${'AB'.repeat(32)}\n`, `"${'ab'.repeat(32)}"`, `${'ab'.repeat(32)}\nextra\n`, '']) {
      fs.writeFileSync(secretPath, malformed, { mode: 0o600 });
      expect(() => loadOrCreateLocalKeystoreSecret(secretPath)).toThrow(/left untouched/);
      expect(fs.readFileSync(secretPath, 'utf8')).toBe(malformed);
    }
    expect(fs.readFileSync(keystorePath, 'utf8')).toContain('original secret bytes');
    // A directory (or any non-file) in its place is likewise refused, not replaced.
    fs.rmSync(secretPath);
    fs.mkdirSync(secretPath);
    expect(() => loadOrCreateLocalKeystoreSecret(secretPath)).toThrow(/left untouched/);
    expect(fs.statSync(secretPath).isDirectory()).toBe(true);
  });

  it('RED control: with no file at all a secret is still created', () => {
    expect(fs.existsSync(secretPath)).toBe(false);
    expect(loadOrCreateLocalKeystoreSecret(secretPath)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('leaves no .tmp file behind', () => {
    loadOrCreateLocalKeystoreSecret(secretPath);
    expect(fs.existsSync(`${secretPath}.tmp`)).toBe(false);
  });
});
