import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const commonsService = vi.hoisted(() => ({ updateCommonsProfile: vi.fn() }));
vi.mock('../core/commons/CommonsService', () => commonsService);

import useCommonsStore from './commonsStore';

beforeEach(() => {
  commonsService.updateCommonsProfile.mockReset();
  useCommonsStore.setState({ profile: null, error: null, isLoading: false });
});

describe('commonsStore.updateProfile', () => {
  it('a refused save rejects, so the screen cannot report "Profile saved"', async () => {
    commonsService.updateCommonsProfile.mockRejectedValueOnce(new Error('display_name_taken'));
    await expect(useCommonsStore.getState().updateProfile({ display_name: 'x' })).rejects.toThrow('display_name_taken');
    expect(useCommonsStore.getState().error).toBe('display_name_taken');
    expect(useCommonsStore.getState().isLoading).toBe(false);
    expect(useCommonsStore.getState().profile).toBeNull();
  });

  it('a successful save resolves and stores the saved profile', async () => {
    const saved = { wallet_id: 'w', display_name: 'New name' };
    commonsService.updateCommonsProfile.mockResolvedValueOnce(saved);
    await expect(useCommonsStore.getState().updateProfile({ display_name: 'New name' })).resolves.toBeUndefined();
    expect(useCommonsStore.getState().profile).toEqual(saved);
    expect(useCommonsStore.getState().error).toBeNull();
  });

  it('the profile screen shows the saved alert only after the awaited save, and an error alert when it throws', () => {
    const src = readFileSync(resolve(__dirname, '../screens/Commons/CommonsProfile.tsx'), 'utf8');
    const start = src.indexOf('const handleSave = async');
    expect(start).toBeGreaterThanOrEqual(0);
    const body = src.slice(start, src.indexOf('\n  };', start));
    const save = body.indexOf('await updateStoreProfile(');
    const savedAlert = body.indexOf("t('commons.profileSaved')");
    const failure = body.indexOf('} catch (err) {');
    expect(save).toBeGreaterThanOrEqual(0);
    expect(savedAlert).toBeGreaterThan(save);
    expect(failure).toBeGreaterThan(savedAlert);
    expect(body.slice(failure)).toContain("Alert.alert(t('common.errorTitle')");
  });
});
