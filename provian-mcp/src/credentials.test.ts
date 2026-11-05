import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAgentCredentialsFile, persistAgentCredentials, resolveLocalAuth } from './credentials';
import {
  clearPendingDeviceRegistration,
  loadOrCreatePendingDeviceRegistration,
  persistDeviceCredentialsFile,
  reconcileInstalledDeviceRegistration,
  resolveLocalDeviceAuth,
} from './device-credentials';

let dir: string;

const apiKey = (hex: string): string => `pvn_live_${hex.repeat(32)}`;
const apiSecret = (hex: string): string => `pvns_${hex.repeat(64)}`;
const deviceKey = (hex: string): string => `pdk_${hex.repeat(32)}`;
const deviceSecret = (hex: string): string => `pds_${hex.repeat(64)}`;
const deviceId = (hex: string): string => `dev_${hex.repeat(64)}`;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-mcp-test-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('resolveLocalAuth', () => {
  it('prefers env vars over the file', () => {
    const credsPath = path.join(dir, 'agent-credentials.json');
    fs.writeFileSync(credsPath, JSON.stringify({ api_key: 'pvn_live_file', api_secret: 'pvns_file' }), { mode: 0o600 });
    const auth = resolveLocalAuth(
      { PROVIAN_API_KEY: 'pvn_live_env', PROVIAN_API_SECRET: 'pvns_env' } as NodeJS.ProcessEnv,
      credsPath,
    );
    expect(auth).toEqual({ apiKey: 'pvn_live_env', apiSecret: 'pvns_env' });
  });

  it('falls back to the 0600 file', () => {
    const credsPath = path.join(dir, 'agent-credentials.json');
    fs.writeFileSync(credsPath, JSON.stringify({ api_key: 'pvn_live_f', api_secret: 'pvns_f' }), { mode: 0o600 });
    expect(resolveLocalAuth({} as NodeJS.ProcessEnv, credsPath)).toEqual({ apiKey: 'pvn_live_f', apiSecret: 'pvns_f' });
  });

  it('returns null when nothing is configured', () => {
    expect(resolveLocalAuth({} as NodeJS.ProcessEnv, path.join(dir, 'missing.json'))).toBeNull();
  });
});

describe('loadAgentCredentialsFile', () => {
  it('refuses a file more permissive than 0600 (POSIX)', () => {
    if (os.platform() === 'win32') return;
    const credsPath = path.join(dir, 'agent-credentials.json');
    fs.writeFileSync(credsPath, JSON.stringify({ api_key: 'pvn_live_x', api_secret: 'pvns_y' }), { mode: 0o644 });
    expect(loadAgentCredentialsFile(credsPath)).toBeNull();
  });

  it('rejects malformed prefixes', () => {
    const credsPath = path.join(dir, 'agent-credentials.json');
    fs.writeFileSync(credsPath, JSON.stringify({ api_key: 'wrong_prefix', api_secret: 'pvns_y' }), { mode: 0o600 });
    expect(loadAgentCredentialsFile(credsPath)).toBeNull();
  });
});

describe('persistAgentCredentials', () => {
  it('writes 0600 and never overwrites', () => {
    const credsPath = path.join(dir, 'agent-credentials.json');
    const written = persistAgentCredentials(
      {
        api_key: apiKey('1'),
        api_secret: apiSecret('1'),
        wallet_id: 'wallet_aw_1',
        address: `0x${'1'.repeat(40)}`,
      },
      credsPath,
    );
    expect(written).toBe(credsPath);
    if (os.platform() !== 'win32') {
      expect(fs.statSync(credsPath).mode & 0o777).toBe(0o600);
    }
    const second = persistAgentCredentials(
      {
        api_key: apiKey('2'),
        api_secret: apiSecret('2'),
        wallet_id: 'wallet_aw_2',
        address: `0x${'2'.repeat(40)}`,
      },
      credsPath,
    );
    expect(second).toBeNull();
    expect(JSON.parse(fs.readFileSync(credsPath, 'utf-8')).api_key).toBe(apiKey('1'));
  });

  it('refuses legacy unbound and address-mismatched replacement byte-for-byte', () => {
    const credsPath = path.join(dir, 'agent-credentials.json');
    const replacement = {
      api_key: apiKey('c'),
      api_secret: apiSecret('d'),
      wallet_id: 'wallet_aw_same',
      address: `0x${'1'.repeat(40)}`,
    };
    const rejectedExisting = [
      { api_key: apiKey('a'), api_secret: apiSecret('b') },
      { api_key: apiKey('a'), api_secret: apiSecret('b'), wallet_id: 'wallet_aw_same' },
      { api_key: apiKey('a'), api_secret: apiSecret('b'), address: `0x${'1'.repeat(40)}` },
      {
        api_key: apiKey('a'),
        api_secret: apiSecret('b'),
        wallet_id: 'wallet_aw_same',
        address: `0x${'2'.repeat(40)}`,
      },
      {
        api_key: apiKey('a'),
        api_secret: apiSecret('b'),
        wallet_id: 'wallet_aw_same',
        address: `0x${'1'.repeat(40)}`,
        unknown: true,
      },
      {
        api_key: 'pvn_live_short',
        api_secret: apiSecret('b'),
        wallet_id: 'wallet_aw_same',
        address: `0x${'1'.repeat(40)}`,
      },
      {
        api_key: apiKey('a'),
        api_secret: 'pvns_short',
        wallet_id: 'wallet_aw_same',
        address: `0x${'1'.repeat(40)}`,
      },
      {
        api_key: apiKey('a'),
        api_secret: apiSecret('b'),
        wallet_id: 'malformed-wallet',
        address: `0x${'1'.repeat(40)}`,
      },
    ];
    for (const existing of rejectedExisting) {
      const before = `${JSON.stringify(existing, null, 2)}\n`;
      fs.writeFileSync(credsPath, before, { mode: 0o600 });
      expect(persistAgentCredentials(replacement, credsPath)).toBeNull();
      expect(fs.readFileSync(credsPath, 'utf8')).toBe(before);
    }
  });

  it('replaces only the exact wallet/address identity', () => {
    const credsPath = path.join(dir, 'agent-credentials.json');
    const address = `0x${'aBcD'.repeat(10)}`;
    expect(persistAgentCredentials({
      api_key: apiKey('a'),
      api_secret: apiSecret('b'),
      wallet_id: 'wallet_aw_same',
      address,
    }, credsPath)).toBe(credsPath);
    expect(persistAgentCredentials({
      api_key: apiKey('c'),
      api_secret: apiSecret('d'),
      wallet_id: 'wallet_aw_same',
      address: address.toLowerCase(),
    }, credsPath)).toBe(credsPath);
  });

  it('refuses malformed replacement credentials and preserves valid existing bytes', () => {
    const credsPath = path.join(dir, 'agent-credentials.json');
    const existing = {
      api_key: apiKey('a'),
      api_secret: apiSecret('b'),
      wallet_id: 'wallet_aw_same',
      address: `0x${'1'.repeat(40)}`,
    };
    const before = `${JSON.stringify(existing, null, 2)}\n`;
    fs.writeFileSync(credsPath, before, { mode: 0o600 });
    const malformedReplacement = {
      api_key: apiKey('c'),
      api_secret: apiSecret('d'),
      wallet_id: 'wallet_aw_same',
      address: `0x${'1'.repeat(40)}`,
      unknown: 'must-not-be-persisted',
    };

    expect(persistAgentCredentials(malformedReplacement, credsPath)).toBeNull();
    expect(fs.readFileSync(credsPath, 'utf8')).toBe(before);
  });

  it('refuses a symlinked credentials path and preserves its target byte-for-byte', () => {
    if (os.platform() === 'win32') return;
    const targetPath = path.join(dir, 'target.json');
    const credsPath = path.join(dir, 'agent-credentials.json');
    const before = `${JSON.stringify({
      api_key: apiKey('a'),
      api_secret: apiSecret('b'),
      wallet_id: 'wallet_aw_same',
      address: `0x${'1'.repeat(40)}`,
    }, null, 2)}\n`;
    fs.writeFileSync(targetPath, before, { mode: 0o600 });
    fs.symlinkSync(targetPath, credsPath);

    expect(persistAgentCredentials({
      api_key: apiKey('c'),
      api_secret: apiSecret('d'),
      wallet_id: 'wallet_aw_same',
      address: `0x${'1'.repeat(40)}`,
    }, credsPath)).toBeNull();
    expect(fs.lstatSync(credsPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(targetPath, 'utf8')).toBe(before);
  });
});

describe('device credentials', () => {
  it('env wins and needs no file', () => {
    const auth = resolveLocalDeviceAuth(
      { PROVIAN_DEVICE_KEY: 'pdk_env', PROVIAN_DEVICE_SECRET: 'pds_env' } as NodeJS.ProcessEnv,
      path.join(dir, 'missing'),
    );
    expect(auth).toEqual({ deviceKey: 'pdk_env', deviceSecret: 'pds_env' });
  });

  it('only reuses agent-owned device files', () => {
    const credsPath = path.join(dir, 'credentials');
    fs.writeFileSync(
      credsPath,
      `PROVIAN_DEVICE_KEY=${deviceKey('a')}\nPROVIAN_DEVICE_SECRET=${deviceSecret('b')}\nPROVIAN_OWNER_TYPE=human\n`,
      { mode: 0o600 },
    );
    expect(resolveLocalDeviceAuth({} as NodeJS.ProcessEnv, credsPath)).toBeNull();

    fs.writeFileSync(
      credsPath,
      `PROVIAN_DEVICE_KEY=${deviceKey('a')}\nPROVIAN_DEVICE_SECRET=${deviceSecret('b')}\nPROVIAN_OWNER_TYPE=agent\n`,
      { mode: 0o600 },
    );
    expect(resolveLocalDeviceAuth({} as NodeJS.ProcessEnv, credsPath)).toEqual({
      deviceKey: deviceKey('a'),
      deviceSecret: deviceSecret('b'),
    });
  });

  it('persists in the SDK env-format, 0600, never overwriting', () => {
    const credsPath = path.join(dir, 'credentials');
    const written = persistDeviceCredentialsFile(
      {
        device_key: deviceKey('1'),
        device_secret: deviceSecret('2'),
        device_id: deviceId('3'),
        device_name: 'provian-mcp',
        wallet_id: 'wallet_aw_1',
        registration_id: 'mcp-device-registration-fixture',
      },
      credsPath,
    );
    expect(written).toBe(credsPath);
    const content = fs.readFileSync(credsPath, 'utf-8');
    expect(content).toContain(`PROVIAN_DEVICE_KEY=${deviceKey('1')}`);
    expect(content).toContain('PROVIAN_OWNER_TYPE=agent');
    expect(content).toContain('PROVIAN_AGENT_WALLET_ID=wallet_aw_1');
    expect(content).toContain('PROVIAN_DEVICE_REGISTRATION_ID=mcp-device-registration-fixture');
    if (os.platform() !== 'win32') {
      expect(fs.statSync(credsPath).mode & 0o777).toBe(0o600);
    }
    expect(
      persistDeviceCredentialsFile({
        device_key: deviceKey('4'),
        device_secret: deviceSecret('5'),
        device_id: deviceId('6'),
        wallet_id: 'wallet_aw_2',
        registration_id: 'mcp-device-registration-other-fixture',
      }, credsPath),
    ).toBeNull();
    // Round-trip through the reader
    expect(resolveLocalDeviceAuth({} as NodeJS.ProcessEnv, credsPath)).toEqual({
      deviceKey: deviceKey('1'),
      deviceSecret: deviceSecret('2'),
    });
  });

  it('persists and reuses one pending registration before any network request', () => {
    const pendingPath = path.join(dir, 'pending-mcp-registration.json');
    const context = {
      owner_key: 'pvn_live_owner_a',
      device_name: 'provian-mcp',
      platform: 'mcp',
    };
    const first = loadOrCreatePendingDeviceRegistration(context, pendingPath);
    const replay = loadOrCreatePendingDeviceRegistration(context, pendingPath);
    expect(replay).toEqual(first);
    expect(first.registrationId).toMatch(/^mcp-device-registration-/);
    expect(first.deviceKey).toMatch(/^pdk_[a-f0-9]{32}$/);
    expect(first.deviceSecret).toMatch(/^pds_[a-f0-9]{64}$/);
    if (os.platform() !== 'win32') {
      expect(fs.statSync(pendingPath).mode & 0o777).toBe(0o600);
    }
  });

  it('fails closed on a context mismatch and clears only the acknowledged identity', () => {
    const pendingPath = path.join(dir, 'pending-mcp-registration.json');
    const credsPath = path.join(dir, 'credentials');
    const context = {
      owner_key: 'pvn_live_owner_a',
      device_name: 'provian-mcp',
      platform: 'mcp',
    };
    const pending = loadOrCreatePendingDeviceRegistration(context, pendingPath);
    expect(() => loadOrCreatePendingDeviceRegistration(
      { ...context, owner_key: 'pvn_live_owner_b' },
      pendingPath,
    )).toThrow(/refusing to create a second ambiguous identity/);
    expect(() => clearPendingDeviceRegistration('different-registration-id', pendingPath, credsPath))
      .toThrow(/changed before acknowledgement/);
    expect(fs.existsSync(pendingPath)).toBe(true);
    expect(persistDeviceCredentialsFile({
      device_key: pending.deviceKey,
      device_secret: pending.deviceSecret,
      device_id: deviceId('7'),
      wallet_id: 'wallet_aw_pending_owner',
      registration_id: pending.registrationId,
    }, credsPath)).toBe(credsPath);
    clearPendingDeviceRegistration(pending.registrationId, pendingPath, credsPath);
    expect(fs.existsSync(pendingPath)).toBe(false);
  });

  it('recovers a crash after credential fsync without creating a second pending identity', () => {
    const pendingPath = path.join(dir, 'pending-mcp-registration.json');
    const credsPath = path.join(dir, 'credentials');
    const context = {
      owner_key: 'pvn_live_owner_a',
      device_name: 'provian-mcp',
      platform: 'mcp',
    };
    const pending = loadOrCreatePendingDeviceRegistration(context, pendingPath);
    expect(persistDeviceCredentialsFile({
      device_key: pending.deviceKey,
      device_secret: pending.deviceSecret,
      device_id: deviceId('8'),
      wallet_id: 'wallet_aw_crash_owner',
      registration_id: pending.registrationId,
    }, credsPath)).toBe(credsPath);
    expect(fs.existsSync(pendingPath)).toBe(true);

    reconcileInstalledDeviceRegistration(pendingPath, credsPath);
    expect(fs.existsSync(pendingPath)).toBe(false);
    expect(resolveLocalDeviceAuth({} as NodeJS.ProcessEnv, credsPath)).toEqual({
      deviceKey: pending.deviceKey,
      deviceSecret: pending.deviceSecret,
    });
  });

  it('rejects unknown pending fields and unsafe device credential paths byte-for-byte', () => {
    const pendingPath = path.join(dir, 'pending-mcp-registration.json');
    const context = {
      owner_key: 'pvn_live_owner_a',
      device_name: 'provian-mcp',
      platform: 'mcp',
    };
    loadOrCreatePendingDeviceRegistration(context, pendingPath);
    const unknown = JSON.parse(fs.readFileSync(pendingPath, 'utf8')) as Record<string, unknown>;
    unknown.unrecognized = true;
    const unknownBytes = `${JSON.stringify(unknown, null, 2)}\n`;
    fs.writeFileSync(pendingPath, unknownBytes, { mode: 0o600 });
    expect(() => loadOrCreatePendingDeviceRegistration(context, pendingPath))
      .toThrow(/second ambiguous identity/);
    expect(fs.readFileSync(pendingPath, 'utf8')).toBe(unknownBytes);

    if (os.platform() !== 'win32') {
      const targetPath = path.join(dir, 'device-target');
      const credsPath = path.join(dir, 'device-symlink');
      const targetBytes = [
        `PROVIAN_DEVICE_KEY=${deviceKey('a')}`,
        `PROVIAN_DEVICE_SECRET=${deviceSecret('b')}`,
        'PROVIAN_OWNER_TYPE=agent',
        '',
      ].join('\n');
      fs.writeFileSync(targetPath, targetBytes, { mode: 0o600 });
      fs.symlinkSync(targetPath, credsPath);
      expect(resolveLocalDeviceAuth({} as NodeJS.ProcessEnv, credsPath)).toBeNull();
      expect(persistDeviceCredentialsFile({
        device_key: deviceKey('c'),
        device_secret: deviceSecret('d'),
        device_id: deviceId('e'),
        wallet_id: 'wallet_aw_symlink',
        registration_id: 'mcp-device-registration-symlink-fixture',
      }, credsPath)).toBeNull();
      expect(fs.lstatSync(credsPath).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(targetPath, 'utf8')).toBe(targetBytes);
    }
  });
});
