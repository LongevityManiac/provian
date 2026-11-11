import { addressRecoveryBinding } from './address-binding';
import { PROTOCOL_POINTER_PIN } from '../protocol/pointer-pin.generated';
import { beforeEach, expect, it, vi } from 'vitest';
import { sha256 } from 'ethers';
import { assertHumanBackupSelection, deriveHumanAccount, installHumanHashAccountSelection, installHumanAccountSelection, readHumanAccountSelection } from './human-account';
import { humanBreakKey, humanRecoverySecret } from './human-secret';
import type { BiometricAction } from '../security/biometricAction';
import type { OwnerChainNetwork } from './owner-chain';
const memory = vi.hoisted(() => new Map<string, string>());
const state = vi.hoisted(() => ({ nonce: '3', recoveryNonce: 2, badSpend: false, badRecovery: false,
  badDestination: false, changed: false, calls: 0 }));
const phrase = 'test test test test test test test test test test test junk';
const identity = `0x${'11'.repeat(32)}`, breakOrigin = `0x${'22'.repeat(20)}`, account = `0x${'33'.repeat(20)}`;
const context = { identity, breakOrigin, chainId: '8453' as const };
const action = 'approved' as unknown as BiometricAction;
const network = {} as OwnerChainNetwork;
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only',
  getItemAsync: async (key: string) => memory.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { memory.set(key, value); } }));
vi.mock('../security/biometricAction', () => ({ assertBiometricAction: (value: unknown) => {
  if (value !== 'approved') throw Error('biometric_required');
} }));
vi.mock('./hash-authorization', () => ({ recoverySigningRoot: async (seed: Uint8Array) => sha256(seed),
  recoveryCommitment: (secret: Uint8Array) => sha256(secret) }));
vi.mock('./break-recovery', () => ({ readBreakRecoveryContext: async () => breakOrigin }));
vi.mock('./hash-account-deployment', () => ({ discoverHashAccount: async (root: string) => {
  expect(root).toBe(sha256(humanBreakKey(phrase, context, 'spending', '0')));
  ++state.calls;
  return { deployed: true, account, factory: `0x${'44'.repeat(20)}`, nonce: state.nonce,
    currentRoot: state.badSpend ? `0x${'00'.repeat(32)}` : sha256(humanBreakKey(phrase, context, 'spending', state.nonce)),
    manifestHash: state.changed && state.calls > 1 ? 'changed' : 'manifest' };
} }));
vi.mock('./owner-chain', () => ({ readOwnerChainState: async () => ({ nonce: state.recoveryNonce,
  destination: state.badDestination ? `0x${'55'.repeat(20)}` : account, deployment: { manifestHash: 'manifest' },
  signingRoot: sha256(humanBreakKey(phrase, context, 'recovery-signing', String(state.recoveryNonce))),
  commitment: state.badRecovery ? `0x${'00'.repeat(32)}` : sha256(humanBreakKey(phrase, context, 'recovery-secret', String(state.recoveryNonce))) }) }));
beforeEach(() => { memory.clear(); Object.assign(state, { nonce: '3', recoveryNonce: 2, badSpend: false,
  badRecovery: false, badDestination: false, changed: false, calls: 0 }); });
it('installs a spent hash account from the original seed while preserving its original backup and Solana identity', async () => {
  const root = await deriveHumanAccount(phrase, 0);
  const selected = await installHumanHashAccountSelection(phrase, identity, `0x${'66'.repeat(32)}`, action, network);
  expect(selected).toMatchObject({ rootAddress: root.evm, evm: account, sol: root.sol, kind: 'hash',
    hashAccount: { nonce: '3', identity, breakOrigin }, recoveryGeneration: 2 });
  expect(await readHumanAccountSelection(root.evm)).toEqual(selected);
  expect(JSON.stringify([...memory])).not.toContain(phrase);
  await expect(installHumanAccountSelection(phrase, selected, action)).rejects.toThrow('verification_required');
  state.nonce = '2';
  await expect(installHumanHashAccountSelection(phrase, identity, selected.requestId, action, network)).rejects.toThrow('rollback');
});
it('fails before installing on foreign spending/recovery keys, wrong destination, changed chain state or missing biometric', async () => {
  for (const field of ['badSpend', 'badRecovery', 'badDestination', 'changed'] as const) {
    state[field] = true; state.calls = 0;
    await expect(installHumanHashAccountSelection(phrase, identity, `0x${'66'.repeat(32)}`, action, network)).rejects.toThrow();
    expect(memory.size).toBe(0); state[field] = false;
  }
  await expect(installHumanHashAccountSelection(phrase, identity, `0x${'66'.repeat(32)}`, undefined as unknown as BiometricAction, network)).rejects.toThrow('biometric_required');
});
it('preserves an independently selected Solana generation when PVT changes to a hash account', async () => {
  const root = await deriveHumanAccount(phrase, 0), legacy = await deriveHumanAccount(phrase, 4);
  const requestId = `0x${'66'.repeat(32)}`;
  await installHumanAccountSelection(phrase, { rootAddress: root.evm, generation: 4, ...legacy,
    recoveryCommitment: sha256(humanRecoverySecret(phrase, 4, addressRecoveryBinding({ chainId: '8453', pointer: PROTOCOL_POINTER_PIN.address!, origin: root.evm }))), requestId }, action);
  const selected = await installHumanHashAccountSelection(phrase, identity, requestId, action, network);
  expect(selected).toMatchObject({ generation: 4, sol: legacy.sol, evm: account, recoveryGeneration: 2, kind: 'hash' });
  expect(selected.sol).not.toBe(root.sol);
  memory.clear(); state.calls = 0;
  expect(await installHumanHashAccountSelection(phrase, identity, requestId, action, network, 4)).toMatchObject({ generation: 4, sol: legacy.sol });
});
it('cloud recovery refuses spending rollback independently of recovery nonce, within the same break only', async () => {
  const current = await installHumanHashAccountSelection(phrase, identity, `0x${'66'.repeat(32)}`, action, network);
  const later = { ...current, hashAccount: { ...current.hashAccount!, nonce: '4' } };
  expect(() => assertHumanBackupSelection(later, current)).toThrow('chain_rollback');
  expect(() => assertHumanBackupSelection(current, later)).not.toThrow();
  expect(() => assertHumanBackupSelection({ ...current, recoveryGeneration: 3 }, current)).toThrow('chain_rollback');
  const nextBreak = { ...current, hashAccount: { ...current.hashAccount!, breakOrigin: `0x${'77'.repeat(20)}`, nonce: '0' } };
  expect(() => assertHumanBackupSelection(later, nextBreak)).not.toThrow();
  expect(() => assertHumanBackupSelection(current, null)).toThrow('chain_rollback');
  expect(() => assertHumanBackupSelection(current, { ...current, kind: 'curve', hashAccount: undefined })).toThrow('chain_rollback');
});
