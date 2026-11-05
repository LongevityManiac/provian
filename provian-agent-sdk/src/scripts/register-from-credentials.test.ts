/**
 * `node <bundle> register-device --from-credentials <file>`.
 *
 * An agent that created its wallet over MCP registers this machine
 * as its device from the credential file it names, through the install path's
 * OWN registerDevice step (real code, stubbed fetch, temp credentials path).
 *
 * In-suite RED controls: a group/world-readable file, a symlink, and a file
 * with an extra field are each refused before any network call; the install
 * path (no platform given) still registers with process.platform.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultBootstrapDeps } from '../bootstrap-flow';
import { readCredentialsFile } from './credentials';
import { BOOTSTRAP_VERBS, resolveBootstrapVerb } from './bootstrap';
import {
  parseRegisterFromCredentialsArgs,
  registerDeviceFromCredentials,
} from './register-from-credentials';
import { buildCaptureHealthReport, describeCaptureHealth } from '../observer/capture-health';

const CREDS = {
  api_key: `pvn_live_${'a'.repeat(32)}`,
  api_secret: `pvns_${'b'.repeat(64)}`,
  wallet_id: 'wallet_aw_cloud01',
  address: `0x${'1'.repeat(40)}`,
};

let dir: string;
let agentCredsPath: string;
let deviceCredsPath: string;
let calls: Array<{ url: string; auth: string | null; idem: string | null; body: Record<string, unknown> }>;

function relayStub(): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(url),
      auth: headers.get('Authorization'),
      idem: headers.get('Idempotency-Key'),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({
      device_id: `dev_${'c'.repeat(64)}`,
      device_key: `pdk_${'d'.repeat(32)}`,
      device_secret: `pds_${'e'.repeat(64)}`,
      device_name: 'cloud-cell',
      owner_wallet_id: CREDS.wallet_id,
    }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

function writeAgentCreds(value: unknown, mode = 0o600): void {
  fs.writeFileSync(agentCredsPath, JSON.stringify(value), { mode });
  fs.chmodSync(agentCredsPath, mode);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-from-creds-'));
  agentCredsPath = path.join(dir, 'agent-credentials.json');
  deviceCredsPath = path.join(dir, 'credentials');
  calls = [];
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('register-device --from-credentials ', () => {
  it('is a bundle verb chosen only from the verb position', () => {
    expect(BOOTSTRAP_VERBS).toContain('register-device');
    expect(resolveBootstrapVerb(['node', 'agent.js', 'register-device', '--from-credentials', 'x'])).toBe('register-device');
    expect(resolveBootstrapVerb(['node', 'agent.js', 'report-pe', '--branch', 'register-device'])).toBe('report-pe');
  });

  it('parses the explicit file, platform and name; refuses anything else', () => {
    expect(parseRegisterFromCredentialsArgs(['--from-credentials', '/c.json', '--platform', 'cloud-vm', '--name', 'cloud-cell']))
      .toEqual({ ok: true, args: { credentialsPath: '/c.json', platform: 'cloud-vm', deviceName: 'cloud-cell' } });
    expect(parseRegisterFromCredentialsArgs([]).ok).toBe(false);
    expect(parseRegisterFromCredentialsArgs(['--api-secret', CREDS.api_secret]).ok).toBe(false);
    expect(parseRegisterFromCredentialsArgs(['--from-credentials', '/c.json', '--platform', 'Cloud/../x']).ok).toBe(false);
  });

  it('registers an agent device from the named 0600 file with the platform it names', async () => {
    writeAgentCreds(CREDS);
    const outcome = await registerDeviceFromCredentials(
      { credentialsPath: agentCredsPath, platform: 'cloud-vm', deviceName: 'cloud-cell' },
      { registerDevice: defaultBootstrapDeps(relayStub(), { credsPath: deviceCredsPath }).registerDevice, relayUrl: 'https://relay.test' },
    );
    expect(outcome).toEqual({ ok: true, walletId: CREDS.wallet_id });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://relay.test/v1/devices/register');
    expect(calls[0].auth).toBe(`Bearer ${CREDS.api_key}:${CREDS.api_secret}`);
    expect(calls[0].idem).toBe(`bootstrap-device-${CREDS.wallet_id}`);
    expect(calls[0].body).toMatchObject({ platform: 'cloud-vm', device_name: 'cloud-cell', registration_id: `bootstrap-device-${CREDS.wallet_id}` });

    const device = readCredentialsFile(deviceCredsPath);
    expect(device?.ownerType).toBe('agent');
    expect(device?.agentWalletId).toBe(CREDS.wallet_id);
    // The device-credentials file never carries the agent API secret.
    expect(fs.readFileSync(deviceCredsPath, 'utf8')).not.toContain(CREDS.api_secret);
  });

  it('RED control: a group/world-readable file is refused before any network call', async () => {
    writeAgentCreds(CREDS, 0o644);
    const outcome = await registerDeviceFromCredentials(
      { credentialsPath: agentCredsPath, platform: 'cloud-vm', deviceName: null },
      { registerDevice: defaultBootstrapDeps(relayStub(), { credsPath: deviceCredsPath }).registerDevice, relayUrl: 'https://relay.test' },
    );
    expect(outcome.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('RED control: a symlink and an extra field are refused before any network call', async () => {
    const real = path.join(dir, 'real.json');
    fs.writeFileSync(real, JSON.stringify(CREDS), { mode: 0o600 });
    fs.symlinkSync(real, agentCredsPath);
    const deps = { registerDevice: defaultBootstrapDeps(relayStub(), { credsPath: deviceCredsPath }).registerDevice, relayUrl: 'https://relay.test' };
    expect((await registerDeviceFromCredentials({ credentialsPath: agentCredsPath, platform: 'cloud-vm', deviceName: null }, deps)).ok).toBe(false);
    fs.unlinkSync(agentCredsPath);
    writeAgentCreds({ ...CREDS, private_key: 'never' });
    expect((await registerDeviceFromCredentials({ credentialsPath: agentCredsPath, platform: 'cloud-vm', deviceName: null }, deps)).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('the install path is unchanged: no platform → process.platform', async () => {
    await defaultBootstrapDeps(relayStub(), { credsPath: deviceCredsPath }).registerDevice({
      relayUrl: 'https://relay.test', walletId: CREDS.wallet_id, apiKey: CREDS.api_key, apiSecret: CREDS.api_secret,
    });
    expect(calls[0].body).toMatchObject({ platform: process.platform, device_name: 'agent-machine' });
    expect(fs.readFileSync(deviceCredsPath, 'utf8')).not.toContain('PROVIAN_HOST_PLATFORM');
  });
});

describe('a device credentials file written by an earlier build reads through the generic path', () => {
  // Earlier builds wrote a retired PROVIAN_HOST_PLATFORM line for devices that
  // registered under the retired hosted-platform label. Such files exist on
  // installed machines; they must still load, and the daemon must report like
  // on any other machine: no host fields, nothing of the retired label.
  const LEGACY = 'muse';
  const base = { harnesses: [], cursorTotal: 0, lastVerdictAtMs: null, lastVerdict: 'idle' as const, lastCaptureAtMs: null, sqliteReadable: true, nowMs: 1 };

  it('loads the credentials and ignores the retired line', () => {
    fs.writeFileSync(deviceCredsPath, [
      `PROVIAN_DEVICE_KEY=pdk_${'d'.repeat(32)}`,
      `PROVIAN_DEVICE_SECRET=pds_${'e'.repeat(64)}`,
      'PROVIAN_RELAY_URL=https://relay.test',
      'PROVIAN_OWNER_TYPE=agent',
      `PROVIAN_AGENT_WALLET_ID=${CREDS.wallet_id}`,
      `PROVIAN_HOST_PLATFORM=${LEGACY}`,
      '',
    ].join('\n'), { mode: 0o600 });
    const device = readCredentialsFile(deviceCredsPath);
    expect(device?.deviceKey).toBe(`pdk_${'d'.repeat(32)}`);
    expect(device?.ownerType).toBe('agent');
    expect(device?.agentWalletId).toBe(CREDS.wallet_id);
    expect(JSON.stringify(device).toLowerCase()).not.toContain(LEGACY);
  });

  it('the capture-health report carries no host fields', () => {
    const report = buildCaptureHealthReport(base);
    expect(report).not.toHaveProperty('host_platform');
    expect(report).not.toHaveProperty('host_lane_truth');
    expect(describeCaptureHealth(report)).toBe('no agent harness installed on this device');
  });
});
