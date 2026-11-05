import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  loadAgentCredentialsFile,
  loadBoundAgentCredentialsFile,
  persistAgentCredentialsFile,
} from './agent-credentials-file';

let dir: string;
let credsPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-agent-creds-'));
  credsPath = path.join(dir, 'agent-credentials.json');
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('retry-safe agent credential persistence', () => {
  it('atomically replaces only credentials for the same recovered wallet', () => {
    persistAgentCredentialsFile({
      api_key: `pvn_live_${'a'.repeat(32)}`,
      api_secret: `pvns_${'b'.repeat(64)}`,
      wallet_id: 'wallet_aw_same',
      address: `0x${'1'.repeat(40)}`,
    }, credsPath);
    persistAgentCredentialsFile({
      api_key: `pvn_live_${'c'.repeat(32)}`,
      api_secret: `pvns_${'d'.repeat(64)}`,
      wallet_id: 'wallet_aw_same',
      address: `0x${'1'.repeat(40)}`,
    }, credsPath);
    expect(loadAgentCredentialsFile(credsPath)).toMatchObject({
      api_key: `pvn_live_${'c'.repeat(32)}`,
      wallet_id: 'wallet_aw_same',
    });
    expect(() => persistAgentCredentialsFile({
      api_key: `pvn_live_${'e'.repeat(32)}`,
      api_secret: `pvns_${'f'.repeat(64)}`,
      wallet_id: 'wallet_aw_other',
      address: `0x${'2'.repeat(40)}`,
    }, credsPath)).toThrow('different wallet');
  });

  it('refuses legacy unbound and address-mismatched replacement byte-for-byte', () => {
    const replacement = {
      api_key: `pvn_live_${'c'.repeat(32)}`,
      api_secret: `pvns_${'d'.repeat(64)}`,
      wallet_id: 'wallet_aw_same',
      address: `0x${'1'.repeat(40)}`,
    };
    const rejectedExisting = [
      {
        api_key: `pvn_live_${'a'.repeat(32)}`,
        api_secret: `pvns_${'b'.repeat(64)}`,
      },
      {
        api_key: `pvn_live_${'a'.repeat(32)}`,
        api_secret: `pvns_${'b'.repeat(64)}`,
        wallet_id: 'wallet_aw_same',
      },
      {
        api_key: `pvn_live_${'a'.repeat(32)}`,
        api_secret: `pvns_${'b'.repeat(64)}`,
        address: `0x${'1'.repeat(40)}`,
      },
      {
        api_key: `pvn_live_${'a'.repeat(32)}`,
        api_secret: `pvns_${'b'.repeat(64)}`,
        wallet_id: 'wallet_aw_same',
        address: `0x${'2'.repeat(40)}`,
      },
      {
        api_key: `pvn_live_${'a'.repeat(32)}`,
        api_secret: `pvns_${'b'.repeat(64)}`,
        wallet_id: 'wallet_aw_same',
        address: `0x${'1'.repeat(40)}`,
        unknown: true,
      },
      {
        api_key: 'pvn_live_short',
        api_secret: `pvns_${'b'.repeat(64)}`,
        wallet_id: 'wallet_aw_same',
        address: `0x${'1'.repeat(40)}`,
      },
      {
        api_key: `pvn_live_${'a'.repeat(32)}`,
        api_secret: 'pvns_short',
        wallet_id: 'wallet_aw_same',
        address: `0x${'1'.repeat(40)}`,
      },
      {
        api_key: `pvn_live_${'a'.repeat(32)}`,
        api_secret: `pvns_${'b'.repeat(64)}`,
        wallet_id: 'malformed-wallet',
        address: `0x${'1'.repeat(40)}`,
      },
    ];
    for (const existing of rejectedExisting) {
      const before = `${JSON.stringify(existing, null, 2)}\n`;
      fs.writeFileSync(credsPath, before, { mode: 0o600 });
      expect(() => persistAgentCredentialsFile(replacement, credsPath)).toThrow();
      expect(fs.readFileSync(credsPath, 'utf8')).toBe(before);
    }
  });

  it('refuses malformed replacement credentials and preserves valid existing bytes', () => {
    const existing = {
      api_key: `pvn_live_${'a'.repeat(32)}`,
      api_secret: `pvns_${'b'.repeat(64)}`,
      wallet_id: 'wallet_aw_same',
      address: `0x${'1'.repeat(40)}`,
    };
    const before = `${JSON.stringify(existing, null, 2)}\n`;
    fs.writeFileSync(credsPath, before, { mode: 0o600 });
    const malformedReplacement = {
      api_key: `pvn_live_${'c'.repeat(32)}`,
      api_secret: `pvns_${'d'.repeat(64)}`,
      wallet_id: 'wallet_aw_same',
      address: `0x${'1'.repeat(40)}`,
      unknown: 'must-not-be-persisted',
    };

    expect(() => persistAgentCredentialsFile(malformedReplacement, credsPath)).toThrow(/malformed/);
    expect(fs.readFileSync(credsPath, 'utf8')).toBe(before);
  });

  it('does not let malformed bound credentials prove a completed wallet', () => {
    const malformedCurrentFiles = [
      {
        api_key: 'pvn_live_short',
        api_secret: `pvns_${'b'.repeat(64)}`,
        wallet_id: 'wallet_aw_same',
        address: `0x${'1'.repeat(40)}`,
      },
      {
        api_key: `pvn_live_${'a'.repeat(32)}`,
        api_secret: `pvns_${'b'.repeat(64)}`,
        wallet_id: 'wallet_aw_same',
        address: `0x${'1'.repeat(40)}`,
        unknown: 'not-part-of-the-authenticated-shape',
      },
    ];

    for (const malformed of malformedCurrentFiles) {
      fs.writeFileSync(credsPath, `${JSON.stringify(malformed, null, 2)}\n`, { mode: 0o600 });
      expect(loadBoundAgentCredentialsFile(credsPath)).toBeNull();
    }

    const exact = {
      api_key: `pvn_live_${'a'.repeat(32)}`,
      api_secret: `pvns_${'b'.repeat(64)}`,
      wallet_id: 'wallet_aw_same',
      address: `0x${'1'.repeat(40)}`,
    };
    fs.writeFileSync(credsPath, `${JSON.stringify(exact, null, 2)}\n`, { mode: 0o600 });
    expect(loadBoundAgentCredentialsFile(credsPath)).toEqual(exact);
  });

  it('treats EVM address casing as the same bound identity', () => {
    const address = `0x${'aBcD'.repeat(10)}`;
    persistAgentCredentialsFile({
      api_key: `pvn_live_${'a'.repeat(32)}`,
      api_secret: `pvns_${'b'.repeat(64)}`,
      wallet_id: 'wallet_aw_case',
      address,
    }, credsPath);
    expect(() => persistAgentCredentialsFile({
      api_key: `pvn_live_${'c'.repeat(32)}`,
      api_secret: `pvns_${'d'.repeat(64)}`,
      wallet_id: 'wallet_aw_case',
      address: address.toLowerCase(),
    }, credsPath)).not.toThrow();
  });

  it('refuses a symlinked credentials path and preserves its target byte-for-byte', () => {
    if (os.platform() === 'win32') return;
    const targetPath = path.join(dir, 'target.json');
    const before = `${JSON.stringify({
      api_key: `pvn_live_${'a'.repeat(32)}`,
      api_secret: `pvns_${'b'.repeat(64)}`,
      wallet_id: 'wallet_aw_same',
      address: `0x${'1'.repeat(40)}`,
    }, null, 2)}\n`;
    fs.writeFileSync(targetPath, before, { mode: 0o600 });
    fs.symlinkSync(targetPath, credsPath);

    expect(() => persistAgentCredentialsFile({
      api_key: `pvn_live_${'c'.repeat(32)}`,
      api_secret: `pvns_${'d'.repeat(64)}`,
      wallet_id: 'wallet_aw_same',
      address: `0x${'1'.repeat(40)}`,
    }, credsPath)).toThrow(/unsafe credentials file/);
    expect(fs.lstatSync(credsPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(targetPath, 'utf8')).toBe(before);
  });
});
