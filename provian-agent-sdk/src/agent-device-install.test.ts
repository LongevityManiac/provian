import { describe, expect, it, vi } from 'vitest';
import {
  agentDeviceRegistrationId,
  isAgentDeviceToken,
  renderAgentDeviceOutcome,
  resolveAgentDeviceName,
  runAgentDeviceInstall,
} from './agent-device-install';

const TOKEN = 'a'.repeat(64);

describe('agent-device install ', () => {
  it('accepts only a 64-hex setup token (RED: a connection code or short hex is refused)', () => {
    expect(isAgentDeviceToken(TOKEN)).toBe(true);
    expect(isAgentDeviceToken('PROV-ABCD-EFGH')).toBe(false);
    expect(isAgentDeviceToken('a'.repeat(63))).toBe(false);
    expect(isAgentDeviceToken('A'.repeat(64))).toBe(false);
  });

  it('derives a stable registration id that never contains the token', () => {
    const id = agentDeviceRegistrationId(TOKEN);
    expect(id).toBe(agentDeviceRegistrationId(TOKEN));
    expect(id).not.toContain(TOKEN.slice(0, 16));
    expect(id).toMatch(/^agent-device-[0-9a-f]{32}$/);
    expect(agentDeviceRegistrationId('b'.repeat(64))).not.toBe(id);
  });

  it('registers with the token as the Bearer credential, then starts the observer', async () => {
    const registerDevice = vi.fn(async () => ({ agentWalletId: 'wallet_aw_1', deviceName: 'mini' }));
    const startObserver = vi.fn(async () => ({ supervision: 'launchd' }));
    const result = await runAgentDeviceInstall(
      { relayUrl: 'https://api.provian.ai', token: TOKEN, deviceName: 'mini' },
      { registerDevice, startObserver },
    );
    expect(registerDevice).toHaveBeenCalledWith({
      relayUrl: 'https://api.provian.ai',
      authorization: `Bearer ${TOKEN}`,
      registrationId: agentDeviceRegistrationId(TOKEN),
      deviceName: 'mini',
    });
    expect(startObserver).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      registered: true, agentWalletId: 'wallet_aw_1', deviceName: 'mini', observerRunning: true, supervision: 'launchd',
    });
    const view = renderAgentDeviceOutcome(result);
    expect(view.exitCode).toBe(0);
    expect(view.stdout.join('\n')).toContain("agent's wallet (wallet_aw_1)");
  });

  it('RED: a refused registration never starts the observer and exits non-zero', async () => {
    const startObserver = vi.fn();
    const result = await runAgentDeviceInstall(
      { relayUrl: 'https://api.provian.ai', token: TOKEN, deviceName: 'mini' },
      { registerDevice: async () => { throw new Error('device registration failed (401)'); }, startObserver },
    );
    expect(startObserver).not.toHaveBeenCalled();
    expect(result).toEqual({ registered: false, observerRunning: false, failure: 'registration' });
    const view = renderAgentDeviceOutcome(result);
    expect(view.exitCode).toBe(1);
    expect(view.stdout).toEqual([]);
  });

  it('RED: a dead observer is reported as not witnessing (exit 1), never as all set', async () => {
    const result = await runAgentDeviceInstall(
      { relayUrl: 'https://api.provian.ai', token: TOKEN, deviceName: 'mini' },
      {
        registerDevice: async () => ({ agentWalletId: 'wallet_aw_1' }),
        startObserver: async () => { throw new Error('no service manager'); },
      },
    );
    expect(result.observerRunning).toBe(false);
    const view = renderAgentDeviceOutcome(result);
    expect(view.exitCode).toBe(1);
    expect(view.stderr.join('\n')).toContain('did not start');
    expect(view.stdout.join('\n')).not.toContain('observer is running');
  });

  it('names the device from the email, else the hostname, stripped to safe characters', () => {
    expect(resolveAgentDeviceName({ PROVIAN_DEVICE_NAME: "Bob's Mac mini" }, 'host')).toBe('Bobs Mac mini');
    expect(resolveAgentDeviceName({}, 'build-box.local')).toBe('build-box.local');
    expect(resolveAgentDeviceName({ PROVIAN_DEVICE_NAME: '$(rm -rf /)' }, '')).toBe('rm -rf');
  });
});
