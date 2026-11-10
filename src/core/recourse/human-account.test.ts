import { beforeEach, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { mnemonicToSeedSync } from '@scure/bip39';
import { HDKey } from '@scure/bip32';
import { deriveHumanAccount, humanAccountPaths, installHumanAccountSelection, readHumanAccountSelection } from './human-account';
import { humanRecoverySecret, humanRecoverySigningSeed } from './human-secret';
import { recoveryCommitment, recoverySigningRoot } from './hash-authorization';
import type { BiometricAction } from '../security/biometricAction';
const memory = vi.hoisted(() => new Map<string, string>());
const fault = vi.hoisted(() => ({ unreadable: false }));
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only',
  getItemAsync: async (key: string) => { if (fault.unreadable) throw new Error('keystore_unavailable'); return memory.get(key) ?? null; },
  setItemAsync: async (key: string, value: string) => { memory.set(key, value); },
}));
vi.mock('../security/biometricAction', () => ({ assertBiometricAction: (action: unknown) => { if (action !== 'approved') throw new Error('biometric_required'); } }));
const mnemonic = 'test test test test test test test test test test test junk';
const action = 'approved' as unknown as BiometricAction;
const commitment = async (generation: number) => recoveryCommitment(humanRecoverySecret(mnemonic, generation), await recoverySigningRoot(humanRecoverySigningSeed(mnemonic, generation)));
beforeEach(() => { memory.clear(); fault.unreadable = false; });
it('preserves the canonical generation-zero account and derives distinct hardened successors', async () => {
  const root = await deriveHumanAccount(mnemonic, 0);
  expect(root.evm).toBe('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
  const next = await deriveHumanAccount(mnemonic, 1);
  expect(next.evm).not.toBe(root.evm); expect(next.sol).not.toBe(root.sol);
  expect(humanAccountPaths(1)).toEqual({ evm: "m/44'/60'/1'/0/0", sol: "m/44'/501'/1'/0'" });
  const curve = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic)).derive(humanAccountPaths(0).evm);
  expect(bytesToHex(humanRecoverySecret(mnemonic))).not.toBe(bytesToHex(curve.privateKey!));
  expect(await commitment(1)).not.toBe(await commitment(0));
  expect(() => humanAccountPaths(-1)).toThrow(); expect(() => humanAccountPaths(0x80000000)).toThrow();
});
it('installs only derived accounts and commitments, preserves the seed, and rejects rollback', async () => {
  const root = await deriveHumanAccount(mnemonic, 0), next = await deriveHumanAccount(mnemonic, 1);
  const selection = { rootAddress: root.evm, generation: 1, ...next, recoveryCommitment: await commitment(1), requestId: `0x${'11'.repeat(32)}` };
  await expect(installHumanAccountSelection(mnemonic, { ...selection, evm: root.evm }, action)).rejects.toThrow('binding_mismatch');
  await expect(installHumanAccountSelection(mnemonic, { ...selection, recoveryCommitment: await commitment(0) }, action)).rejects.toThrow('binding_mismatch');
  await installHumanAccountSelection(mnemonic, selection, action);
  expect(await readHumanAccountSelection(root.evm)).toEqual(selection);
  expect(JSON.stringify([...memory])).not.toContain(mnemonic);
  await expect(installHumanAccountSelection(mnemonic, { ...selection, generation: 0, ...root, recoveryCommitment: await commitment(0) }, action)).rejects.toThrow('rollback');
  await expect(installHumanAccountSelection(mnemonic, selection, undefined as unknown as BiometricAction)).rejects.toThrow('biometric_required');
});
it('malformed protected selector fails closed instead of silently using the retired account', async () => {
  const root = await deriveHumanAccount(mnemonic, 0);
  memory.set(`provian_recourse_account_${root.evm.slice(2)}`, JSON.stringify({ generation: -1 }));
  await expect(readHumanAccountSelection(root.evm)).rejects.toThrow();
});

it('an unreadable protected selector never falls back to the retired account', async () => {
  const root = await deriveHumanAccount(mnemonic, 0);
  fault.unreadable = true;
  await expect(readHumanAccountSelection(root.evm)).rejects.toThrow('keystore_unavailable');
});
it('restoration proof rotation can advance independently of the active spending account and cannot roll back', async () => {
  const root = await deriveHumanAccount(mnemonic, 0), next = await deriveHumanAccount(mnemonic, 1);
  const initial = { rootAddress: root.evm, generation: 1, ...next, recoveryCommitment: await commitment(1), requestId: `0x${'11'.repeat(32)}` };
  await installHumanAccountSelection(mnemonic, initial, action);
  const restored = { ...initial, recoveryGeneration: 2, recoveryCommitment: await commitment(2), requestId: `0x${'22'.repeat(32)}` };
  await installHumanAccountSelection(mnemonic, restored, action);
  expect(await readHumanAccountSelection(root.evm)).toEqual(restored);
  await expect(installHumanAccountSelection(mnemonic, initial, action)).rejects.toThrow('rollback');
  await expect(installHumanAccountSelection(mnemonic, { ...restored, recoveryGeneration: 0 }, action)).rejects.toThrow('state_invalid');
});
