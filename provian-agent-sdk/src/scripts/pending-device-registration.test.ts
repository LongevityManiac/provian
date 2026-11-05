import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearPendingDeviceRegistration,
  loadPendingDeviceRegistrationForContext,
  loadOrCreatePendingDeviceRegistration,
  reconcileInstalledDeviceRegistration,
  type PendingDeviceRegistrationContext,
} from './pending-device-registration';

let dir: string;
let pendingPath: string;

const context: PendingDeviceRegistrationContext = {
  relay_url: 'https://relay.test',
  authorization_sha256: 'a'.repeat(64),
  owner_type: 'human',
  device_name: 'Atlas workstation',
  platform: 'darwin',
  attestation_capability: 'software',
  hardware_signing_required: false,
  signing_method: 'bearer',
  signing_public_key: null,
  signing_key_alias: null,
};

function exactInstalled(pending: ReturnType<typeof loadOrCreatePendingDeviceRegistration>) {
  return {
    registrationId: pending.registration_id,
    deviceKey: pending.device_key,
    deviceSecret: pending.device_secret,
    relayUrl: pending.context.relay_url,
    deviceId: `dev_${'d'.repeat(64)}`,
    ownerType: pending.context.owner_type,
    signingMethod: pending.context.signing_method,
  } as const;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-pending-device-'));
  pendingPath = path.join(dir, 'pending.json');
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('durable SDK device registration identity', () => {
  it('persists before networking and reloads one exact identity', () => {
    const first = loadOrCreatePendingDeviceRegistration(context, pendingPath);
    const replay = loadOrCreatePendingDeviceRegistration(context, pendingPath);
    expect(replay).toEqual(first);
    expect(first.schema_version).toBe('provian-device-registration/v2');
    expect(first.registration_id).toMatch(/^device-registration-/);
    expect(first.device_key).toMatch(/^pdk_[a-f0-9]{32}$/);
    expect(first.device_secret).toMatch(/^pds_[a-f0-9]{64}$/);
    if (os.platform() !== 'win32') {
      expect(fs.statSync(pendingPath).mode & 0o777).toBe(0o600);
    }
  });

  it('reopens the exact Secure Enclave identity before generating another key', () => {
    const secureContext: PendingDeviceRegistrationContext = {
      ...context,
      attestation_capability: 'hardware_tpm',
      hardware_signing_required: true,
      signing_method: 'secure_enclave_p256',
      signing_public_key: `04${'b'.repeat(128)}`,
      signing_key_alias: 'provian-device-fixed-alias',
    };
    const first = loadOrCreatePendingDeviceRegistration(secureContext, pendingPath);
    const reopened = loadPendingDeviceRegistrationForContext({
      relay_url: secureContext.relay_url,
      authorization_sha256: secureContext.authorization_sha256,
      owner_type: secureContext.owner_type,
      device_name: secureContext.device_name,
      platform: secureContext.platform,
      attestation_capability: secureContext.attestation_capability,
      hardware_signing_required: secureContext.hardware_signing_required,
    }, pendingPath);

    expect(reopened).toEqual(first);
    expect(reopened?.context.signing_public_key).toBe(secureContext.signing_public_key);
    expect(reopened?.context.signing_key_alias).toBe(secureContext.signing_key_alias);
  });

  it('preserves contradictory or unknown pending bytes without replacement', () => {
    loadOrCreatePendingDeviceRegistration(context, pendingPath);
    const parsed = JSON.parse(fs.readFileSync(pendingPath, 'utf8')) as Record<string, unknown>;
    parsed.unknown = 'must-fail-closed';
    const before = `${JSON.stringify(parsed, null, 2)}\n`;
    fs.writeFileSync(pendingPath, before, { mode: 0o600 });

    expect(() => loadOrCreatePendingDeviceRegistration(context, pendingPath))
      .toThrow(/contradictory/);
    expect(fs.readFileSync(pendingPath, 'utf8')).toBe(before);
    expect(() => loadOrCreatePendingDeviceRegistration({
      ...context,
      device_name: 'Different device',
    }, pendingPath)).toThrow(/contradictory/);
    expect(fs.readFileSync(pendingPath, 'utf8')).toBe(before);
  });

  it('deletes pending only after exact installed credentials are cross-bound', () => {
    const pending = loadOrCreatePendingDeviceRegistration(context, pendingPath);
    expect(() => clearPendingDeviceRegistration(pending.registration_id, {
      ...exactInstalled(pending),
      deviceKey: `pdk_${'f'.repeat(32)}`,
    }, pendingPath)).toThrow(/do not match/);
    expect(fs.existsSync(pendingPath)).toBe(true);

    clearPendingDeviceRegistration(
      pending.registration_id,
      exactInstalled(pending),
      pendingPath,
    );
    expect(fs.existsSync(pendingPath)).toBe(false);
  });

  it('finishes a completed local registration without requiring another relay attempt', () => {
    const pending = loadOrCreatePendingDeviceRegistration(context, pendingPath);
    expect(reconcileInstalledDeviceRegistration(exactInstalled(pending), pendingPath)).toBe(true);
    expect(fs.existsSync(pendingPath)).toBe(false);

    const source = fs.readFileSync(path.join(__dirname, 'register-device.ts'), 'utf8');
    const reconcileIndex = source.indexOf('if (reconcileInstalledDeviceRegistration(startupCredentials))');
    const parseArgsIndex = source.indexOf('const args = parseArgs(process.argv.slice(2))');
    const registrationFetchIndex = source.indexOf(
      'await fetch(`${relayUrl}/v1/devices/register`',
    );
    expect(reconcileIndex).toBeGreaterThan(0);
    expect(reconcileIndex).toBeLessThan(parseArgsIndex);
    expect(reconcileIndex).toBeLessThan(registrationFetchIndex);
    expect(source.slice(reconcileIndex, parseArgsIndex)).toContain('return;');
  });

  it('does not misread older credentials as completion of a different pending identity', () => {
    const pending = loadOrCreatePendingDeviceRegistration(context, pendingPath);
    expect(reconcileInstalledDeviceRegistration({
      ...exactInstalled(pending),
      registrationId: 'device-registration-older-identity',
    }, pendingPath)).toBe(false);
    expect(fs.existsSync(pendingPath)).toBe(true);
  });

  it('refuses a symlinked pending path and preserves its target', () => {
    if (os.platform() === 'win32') return;
    const targetPath = path.join(dir, 'target.json');
    loadOrCreatePendingDeviceRegistration(context, targetPath);
    const before = fs.readFileSync(targetPath, 'utf8');
    fs.symlinkSync(targetPath, pendingPath);

    expect(() => loadOrCreatePendingDeviceRegistration(context, pendingPath))
      .toThrow(/private regular file/);
    expect(fs.lstatSync(pendingPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(targetPath, 'utf8')).toBe(before);
  });
});
