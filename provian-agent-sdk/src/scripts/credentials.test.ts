import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readCredentialsFile, writeCredentialsFile } from './credentials';

describe('credentials owner_type round-trip', () => {
  let tmpFile: string;
  const deviceKey = `pdk_${'a'.repeat(32)}`;
  const deviceSecret = `pds_${'b'.repeat(64)}`;
  const deviceId = `dev_${'c'.repeat(64)}`;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `provian-creds-${Date.now()}-${Math.random()}.txt`);
  });

  afterEach(() => {
    try { fs.unlinkSync(tmpFile); } catch { /* ok */ }
  });

  it('persists owner_type=agent and agent_wallet_id', () => {
    writeCredentialsFile({
      deviceKey,
      deviceSecret,
      relayUrl: 'https://api.provian.ai',
      deviceId,
      registrationId: 'device-registration-agent-fixture',
      deviceName: 'Atlas Mac Mini',
      ownerType: 'agent',
      agentWalletId: 'wallet_aw_atlas',
    }, tmpFile);

    const contents = fs.readFileSync(tmpFile, 'utf-8');
    expect(contents).toContain('PROVIAN_OWNER_TYPE=agent');
    expect(contents).toContain('PROVIAN_AGENT_WALLET_ID=wallet_aw_atlas');

    const parsed = readCredentialsFile(tmpFile);
    expect(parsed?.ownerType).toBe('agent');
    expect(parsed?.agentWalletId).toBe('wallet_aw_atlas');
    expect(parsed?.registrationId).toBe('device-registration-agent-fixture');
  });

  it('omits agent fields for human devices', () => {
    writeCredentialsFile({
      deviceKey,
      deviceSecret,
      relayUrl: 'https://api.provian.ai',
      deviceId,
      deviceName: 'Frank MBP',
      ownerType: 'human',
    }, tmpFile);

    const contents = fs.readFileSync(tmpFile, 'utf-8');
    expect(contents).toContain('PROVIAN_OWNER_TYPE=human');
    expect(contents).not.toContain('PROVIAN_AGENT_WALLET_ID');

    const parsed = readCredentialsFile(tmpFile);
    expect(parsed?.ownerType).toBe('human');
    expect(parsed?.agentWalletId).toBeUndefined();
  });

  it('treats missing owner_type as undefined (caller defaults to human)', () => {
    fs.writeFileSync(tmpFile,
      `PROVIAN_DEVICE_KEY=${deviceKey}\n` +
      `PROVIAN_DEVICE_SECRET=${deviceSecret}\n` +
      'PROVIAN_RELAY_URL=https://api.provian.ai\n',
      { mode: 0o600 });
    const parsed = readCredentialsFile(tmpFile);
    expect(parsed?.deviceKey).toBe(deviceKey);
    expect(parsed?.ownerType).toBeUndefined();
  });

  it('ignores unrecognized owner_type values', () => {
    fs.writeFileSync(tmpFile,
      `PROVIAN_DEVICE_KEY=${deviceKey}\n` +
      `PROVIAN_DEVICE_SECRET=${deviceSecret}\n` +
      'PROVIAN_OWNER_TYPE=robot\n',
      { mode: 0o600 });
    const parsed = readCredentialsFile(tmpFile);
    expect(parsed?.ownerType).toBeUndefined();
  });

  it('refuses unsafe credential paths and preserves symlink targets', () => {
    if (os.platform() === 'win32') return;
    const target = `${tmpFile}.target`;
    const before = `PROVIAN_DEVICE_KEY=${deviceKey}\nPROVIAN_DEVICE_SECRET=${deviceSecret}\n`;
    fs.writeFileSync(target, before, { mode: 0o600 });
    fs.symlinkSync(target, tmpFile);
    expect(readCredentialsFile(tmpFile)).toBeNull();
    writeCredentialsFile({
      deviceKey,
      deviceSecret,
      relayUrl: 'https://api.provian.ai',
      deviceId,
    }, tmpFile);
    expect(fs.lstatSync(tmpFile).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe(before);
    fs.unlinkSync(target);
  });
});
