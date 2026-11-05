import { describe, it, expect, vi } from 'vitest';
import {
  ensurePushRegistration,
  type PushRegistrationDeps,
  type PushPermissionStatus,
} from './pushRegistration';

const TOKEN = 'ExponentPushToken[abcdefghijklmnopqrstuv]';

function makeDeps(overrides: Partial<PushRegistrationDeps> & { status?: PushPermissionStatus; promptResult?: PushPermissionStatus } = {}) {
  const status = overrides.status ?? 'granted';
  const promptResult = overrides.promptResult ?? status;
  const getPermissionStatus = vi.fn(async () => status);
  const requestPermission = vi.fn(async () => promptResult);
  const mintToken = vi.fn(async () => TOKEN as string | null);
  const register = vi.fn(async () => {});
  const deps: PushRegistrationDeps = {
    isDevice: overrides.isDevice ?? true,
    getPermissionStatus: overrides.getPermissionStatus ?? getPermissionStatus,
    requestPermission: overrides.requestPermission ?? requestPermission,
    mintToken: overrides.mintToken ?? mintToken,
    register: overrides.register ?? register,
  };
  return { deps, getPermissionStatus, requestPermission, mintToken, register };
}

describe('ensurePushRegistration', () => {
  it('returns unavailable and does nothing on a non-device (simulator)', async () => {
    const { deps, getPermissionStatus, mintToken, register } = makeDeps({ isDevice: false });
    const outcome = await ensurePushRegistration(deps, { prompt: true });
    expect(outcome).toBe('unavailable');
    expect(getPermissionStatus).not.toHaveBeenCalled();
    expect(mintToken).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it('registers when already granted, WITHOUT prompting (prompt: false)', async () => {
    const { deps, requestPermission, mintToken, register } = makeDeps({ status: 'granted' });
    const outcome = await ensurePushRegistration(deps, { prompt: false });
    expect(outcome).toBe('registered');
    expect(requestPermission).not.toHaveBeenCalled();
    expect(mintToken).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(TOKEN);
  });

  it('registers when already granted and does NOT prompt even if prompt: true', async () => {
    const { deps, requestPermission, register } = makeDeps({ status: 'granted' });
    const outcome = await ensurePushRegistration(deps, { prompt: true });
    expect(outcome).toBe('registered');
    expect(requestPermission).not.toHaveBeenCalled();
    expect(register).toHaveBeenCalledWith(TOKEN);
  });

  it('prompts in context when undetermined + prompt:true, then registers on grant', async () => {
    const { deps, requestPermission, mintToken, register } = makeDeps({
      status: 'undetermined',
      promptResult: 'granted',
    });
    const outcome = await ensurePushRegistration(deps, { prompt: true });
    expect(outcome).toBe('registered');
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(mintToken).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(TOKEN);
  });

  it('returns permission_denied (no register) when the in-context prompt is declined', async () => {
    const { deps, requestPermission, mintToken, register } = makeDeps({
      status: 'undetermined',
      promptResult: 'denied',
    });
    const outcome = await ensurePushRegistration(deps, { prompt: true });
    expect(outcome).toBe('permission_denied');
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(mintToken).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it('does NOT prompt when undetermined + prompt:false (silent app-start/foreground path)', async () => {
    const { deps, requestPermission, mintToken } = makeDeps({ status: 'undetermined' });
    const outcome = await ensurePushRegistration(deps, { prompt: false });
    expect(outcome).toBe('permission_undetermined');
    expect(requestPermission).not.toHaveBeenCalled();
    expect(mintToken).not.toHaveBeenCalled();
  });

  it('NEVER re-prompts on a prior denial, even with prompt:true (no nag loop)', async () => {
    const { deps, requestPermission, mintToken, register } = makeDeps({ status: 'denied' });
    const outcome = await ensurePushRegistration(deps, { prompt: true });
    expect(outcome).toBe('permission_denied');
    expect(requestPermission).not.toHaveBeenCalled();
    expect(mintToken).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it('self-heals: a user who enabled notifications in system settings registers on the next silent check', async () => {
    // First call: denied -> nothing. Second call (after enabling in Settings):
    // granted -> registers, no prompt.
    const register = vi.fn(async () => {});
    const mintToken = vi.fn(async () => TOKEN as string | null);
    let status: PushPermissionStatus = 'denied';
    const deps: PushRegistrationDeps = {
      isDevice: true,
      getPermissionStatus: async () => status,
      requestPermission: async () => status,
      mintToken,
      register,
    };
    expect(await ensurePushRegistration(deps, { prompt: false })).toBe('permission_denied');
    expect(register).not.toHaveBeenCalled();

    status = 'granted'; // user flips it on in system settings
    expect(await ensurePushRegistration(deps, { prompt: false })).toBe('registered');
    expect(register).toHaveBeenCalledWith(TOKEN);
  });

  it('returns no_token when granted but the token cannot be minted', async () => {
    const { deps, register } = makeDeps({ status: 'granted', mintToken: vi.fn(async () => null) });
    const outcome = await ensurePushRegistration(deps, { prompt: true });
    expect(outcome).toBe('no_token');
    expect(register).not.toHaveBeenCalled();
  });

  it('swallows a registrar failure and returns error (never throws / crashes the app)', async () => {
    const { deps } = makeDeps({
      status: 'granted',
      register: vi.fn(async () => { throw new Error('backend down'); }),
    });
    await expect(ensurePushRegistration(deps, { prompt: true })).resolves.toBe('error');
  });

  it('swallows a permission-check failure and returns error', async () => {
    const { deps } = makeDeps({
      getPermissionStatus: vi.fn(async () => { throw new Error('native module missing'); }),
    });
    await expect(ensurePushRegistration(deps)).resolves.toBe('error');
  });

  it('defaults to prompt:false when no options are passed', async () => {
    const { deps, requestPermission } = makeDeps({ status: 'undetermined' });
    const outcome = await ensurePushRegistration(deps);
    expect(outcome).toBe('permission_undetermined');
    expect(requestPermission).not.toHaveBeenCalled();
  });
});
