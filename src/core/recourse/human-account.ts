import * as SecureStore from 'expo-secure-store';
import { HDKey } from '@scure/bip32';
import { secp256k1 } from '@noble/curves/secp256k1';
import { ed25519 } from '@noble/curves/ed25519';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import bs58 from 'bs58';
import { mnemonicToSeedPaced } from '../wallet/pacedSeed';
import { slip10DeriveEd25519Seed } from '../chains/solana/slip10';
import { assertBiometricAction, type BiometricAction } from '../security/biometricAction';
import { humanRecoverySecret, humanRecoverySigningSeed } from './human-secret';
import { recoveryCommitment, recoverySigningRoot } from './hash-authorization';
import { addressRecoveryBinding } from './address-binding';
import { PROTOCOL_POINTER_PIN } from '../protocol/pointer-pin.generated';

export interface HumanAccountSelection {
  readonly rootAddress: string; readonly generation: number; readonly evm: string; readonly sol: string;
  readonly recoveryCommitment: string; readonly requestId: string;
  /** Hash authorization advances on every restoration proof; the spending
   * account advances only when a new wallet key is installed. */
  readonly recoveryGeneration?: number;
  readonly kind?: 'curve' | 'hash';
  readonly hashAccount?: {
    readonly identity: string; readonly breakOrigin: string; readonly factory: string;
    readonly chainId: '8453'; readonly nonce: string;
  };
}
export function humanAccountPaths(generation: number): { evm: string; sol: string } {
  // This is the BIP-32 hardened account-index domain, not a program request cap.
  if (!Number.isSafeInteger(generation) || generation < 0 || generation >= 0x80000000) throw new Error('recourse_account_index_invalid');
  return { evm: `m/44'/60'/${generation}'/0/0`, sol: `m/44'/501'/${generation}'/0'` };
}
export async function deriveHumanAccount(mnemonic: string, generation: number): Promise<{ evm: string; sol: string }> {
  const paths = humanAccountPaths(generation);
  const seed = await mnemonicToSeedPaced(mnemonic);
  const root = HDKey.fromMasterSeed(seed);
  const child = root.derive(paths.evm);
  const solSeed = slip10DeriveEd25519Seed(seed, paths.sol);
  try {
    if (!child.privateKey) throw new Error('recourse_account_derivation_failed');
    const publicKey = secp256k1.getPublicKey(child.privateKey, false);
    return { evm: `0x${bytesToHex(keccak_256(publicKey.subarray(1)).subarray(12))}`,
      sol: bs58.encode(ed25519.getPublicKey(solSeed)) };
  } finally { seed.fill(0); solSeed.fill(0); child.wipePrivateData(); root.wipePrivateData(); }
}
const keyFor = (root: string) => `provian_recourse_account_${root.toLowerCase().replace(/^0x/, '')}`;
function validate(value: HumanAccountSelection, rootAddress: string): void {
  humanAccountPaths(value.generation);
  humanAccountPaths(value.recoveryGeneration ?? value.generation);
  if (value.kind !== 'hash' && (value.recoveryGeneration ?? value.generation) < value.generation) throw new Error('recourse_account_state_invalid');
  if (value.rootAddress !== rootAddress.toLowerCase() || !/^0x[0-9a-f]{40}$/.test(value.evm)
    || typeof value.sol !== 'string' || bs58.decode(value.sol).length !== 32
    || !/^0x[0-9a-f]{64}$/.test(value.recoveryCommitment) || !/^0x[0-9a-f]{64}$/.test(value.requestId)) throw new Error('recourse_account_state_invalid');
  if (value.kind !== undefined && value.kind !== 'curve' && value.kind !== 'hash') throw Error('recourse_account_state_invalid');
  if (value.kind === 'hash') {
    const h = value.hashAccount;
    if (!h || !/^0x[0-9a-f]{64}$/.test(h.identity) || /^0x0+$/.test(h.identity)
      || !/^0x[0-9a-f]{40}$/.test(h.breakOrigin) || /^0x0+$/.test(h.breakOrigin)
      || !/^0x[0-9a-f]{40}$/.test(h.factory) || /^0x0+$/.test(h.factory) || h.chainId !== '8453'
      || !/^(0|[1-9][0-9]*)$/.test(h.nonce) || BigInt(h.nonce) >= 2n ** 256n) throw Error('recourse_account_state_invalid');
  } else if (value.hashAccount !== undefined) throw Error('recourse_account_state_invalid');
}
/** The signer selector is protected by the OS keystore, never selected by an
 * AsyncStorage/public address cache. A malformed selector fails closed. */
export async function readHumanAccountSelection(rootAddress: string): Promise<HumanAccountSelection | null> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(rootAddress)) throw new Error('recourse_account_root_invalid');
  const raw = await SecureStore.getItemAsync(keyFor(rootAddress));
  if (raw === null) return null;
  const value = JSON.parse(raw) as HumanAccountSelection;
  validate(value, rootAddress);
  return value;
}
/** A cloud copy is a lower bound only within its own authorization domain.
 * Spending and recovery have independent counters; neither may roll backward. */
export function assertHumanBackupSelection(prior: HumanAccountSelection,
  current: HumanAccountSelection | null | undefined): void {
  validate(prior, prior.rootAddress);
  if (!current) throw Error('recourse_backup_chain_rollback');
  validate(current, prior.rootAddress);
  if (prior.kind === 'hash' && current.kind !== 'hash') throw Error('recourse_backup_chain_rollback');
  const sameDomain = current.kind === 'hash' && prior.kind === 'hash'
    ? current.hashAccount!.breakOrigin === prior.hashAccount!.breakOrigin
    : current.kind !== 'hash' && prior.kind !== 'hash';
  if (sameDomain && ((current.recoveryGeneration ?? current.generation) < (prior.recoveryGeneration ?? prior.generation)
    || (current.kind === 'hash' && BigInt(current.hashAccount!.nonce) < BigInt(prior.hashAccount!.nonce)))) {
    throw Error('recourse_backup_chain_rollback');
  }
}
/** Caller has already confirmed the matching relay transition. Verify both
 * derived accounts locally before installing the monotonic signing selector. */
let installTail: Promise<void> = Promise.resolve();
export async function installHumanAccountSelection(mnemonic: string, next: HumanAccountSelection,
  action: BiometricAction): Promise<void> {
  assertBiometricAction(action);
  const root = await deriveHumanAccount(mnemonic, 0);
  validate(next, root.evm);
  if (next.kind === 'hash') throw Error('recourse_hash_account_verification_required');
  const derived = await deriveHumanAccount(mnemonic, next.generation);
  if (derived.evm !== next.evm || derived.sol !== next.sol) throw new Error('recourse_account_binding_mismatch');
  const recoveryGeneration = next.recoveryGeneration ?? next.generation;
  if (!PROTOCOL_POINTER_PIN.address) throw Error('protocol_pointer_not_deployed');
  const binding = addressRecoveryBinding({ chainId: String(PROTOCOL_POINTER_PIN.chainId), pointer: PROTOCOL_POINTER_PIN.address, origin: root.evm });
  const secret = humanRecoverySecret(mnemonic, recoveryGeneration, binding);
  const signingSeed = humanRecoverySigningSeed(mnemonic, recoveryGeneration, binding);
  let commitment: string;
  try { commitment = recoveryCommitment(secret, await recoverySigningRoot(signingSeed)); }
  finally { secret.fill(0); signingSeed.fill(0); }
  if (commitment !== next.recoveryCommitment) throw new Error('recourse_account_binding_mismatch');
  const previousInstall = installTail;
  let release!: () => void;
  installTail = new Promise<void>(resolve => { release = resolve; });
  await previousInstall;
  try {
    const current = await readHumanAccountSelection(root.evm);
    if (current?.kind === 'hash') throw Error('recourse_curve_account_retired');
    const fields = ['rootAddress', 'generation', 'evm', 'sol', 'recoveryCommitment'] as const;
    const previousRecovery = current?.recoveryGeneration ?? current?.generation ?? 0;
    if (current && (next.generation < current.generation || recoveryGeneration < previousRecovery
      || (next.generation === current.generation && recoveryGeneration === previousRecovery
      && fields.some(field => next[field] !== current[field])))) throw new Error('recourse_account_rollback');
    assertBiometricAction(action);
    const serialized = JSON.stringify({ rootAddress: next.rootAddress, generation: next.generation,
      evm: next.evm, sol: next.sol, recoveryCommitment: next.recoveryCommitment, requestId: next.requestId,
      ...(next.recoveryGeneration === undefined ? {} : { recoveryGeneration: next.recoveryGeneration }) });
    await SecureStore.setItemAsync(keyFor(root.evm), serialized, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
    if (await SecureStore.getItemAsync(keyFor(root.evm)) !== serialized) throw new Error('recourse_account_write_unconfirmed');
  } finally { release(); }
}

/** Installation reconstructs the deterministic address and both independent key
 * domains from the existing mnemonic. A relay response or local selector alone
 * cannot choose the post-break signing account. */
export async function installHumanHashAccountSelection(mnemonic: string, identity: string, requestId: string,
  action: BiometricAction, network: import('./owner-chain').OwnerChainNetwork,
  discoveredLegacyGeneration?: number): Promise<HumanAccountSelection> {
  assertBiometricAction(action);
  const previousInstall = installTail;
  let release!: () => void;
  installTail = new Promise<void>(resolve => { release = resolve; });
  await previousInstall;
  try {
    const next = await discoverHumanHashAccountSelection(mnemonic, identity, requestId, network, discoveredLegacyGeneration);
    assertBiometricAction(action);
    const serialized = JSON.stringify(next);
    await SecureStore.setItemAsync(keyFor(next.rootAddress), serialized, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
    if (await SecureStore.getItemAsync(keyFor(next.rootAddress)) !== serialized) throw Error('recourse_account_write_unconfirmed');
    return next;
  } finally { release(); }
}

export async function discoverHumanHashAccountSelection(mnemonic: string, identity: string, requestId: string,
  network: import('./owner-chain').OwnerChainNetwork, discoveredLegacyGeneration?: number): Promise<HumanAccountSelection> {
  const [{ readBreakRecoveryContext }, { discoverHashAccount }, { readOwnerChainState }, { humanBreakKey }] = await Promise.all([
    import('./break-recovery'), import('./hash-account-deployment'), import('./owner-chain'), import('./human-secret'),
  ]);
  const breakOrigin = await readBreakRecoveryContext(network);
  const context = { identity, breakOrigin, chainId: '8453' as const };
  const initialSeed = humanBreakKey(mnemonic, context, 'spending', '0');
  let initialRoot: string;
  try { initialRoot = await recoverySigningRoot(initialSeed); } finally { initialSeed.fill(0); }
  const account = await discoverHashAccount(initialRoot, network, breakOrigin);
  if (!account.deployed || account.nonce === null) throw Error('recourse_hash_account_not_deployed');
  const spendingSeed = humanBreakKey(mnemonic, context, 'spending', account.nonce);
  try {
    if (await recoverySigningRoot(spendingSeed) !== account.currentRoot) throw Error('recourse_hash_account_key_mismatch');
  } finally { spendingSeed.fill(0); }
  const owner = await readOwnerChainState(identity, network);
  if (owner.destination !== account.account || owner.deployment.manifestHash !== account.manifestHash) throw Error('recourse_hash_account_owner_mismatch');
  const secret = humanBreakKey(mnemonic, context, 'recovery-secret', String(owner.nonce));
  const signingSeed = humanBreakKey(mnemonic, context, 'recovery-signing', String(owner.nonce));
  try {
    const signingRoot = await recoverySigningRoot(signingSeed);
    if (signingRoot !== owner.signingRoot || recoveryCommitment(secret, signingRoot) !== owner.commitment) throw Error('recourse_hash_account_recovery_mismatch');
  } finally { secret.fill(0); signingSeed.fill(0); }
  const root = await deriveHumanAccount(mnemonic, 0);
  const current = await readHumanAccountSelection(root.evm);
  // PVT's EVM migration does not change the independent Solana account. A
  // fresh backup supplies its historically discovered curve generation;
  // an existing device retains its protected selection.
  const legacyGeneration = current?.generation ?? discoveredLegacyGeneration ?? 0;
  const legacy = legacyGeneration === 0 ? root : await deriveHumanAccount(mnemonic, legacyGeneration);
  if (current && current.sol !== legacy.sol) throw Error('recourse_account_binding_mismatch');
  const next: HumanAccountSelection = { rootAddress: root.evm, generation: legacyGeneration, evm: account.account, sol: legacy.sol,
    recoveryGeneration: owner.nonce, recoveryCommitment: owner.commitment, requestId, kind: 'hash',
    hashAccount: { ...context, factory: account.factory, nonce: account.nonce } };
  validate(next, root.evm);
  if (current?.kind === 'hash' && current.hashAccount!.breakOrigin === breakOrigin
    && (BigInt(current.hashAccount!.nonce) > BigInt(account.nonce)
      || (current.recoveryGeneration ?? 0) > owner.nonce)) throw Error('recourse_account_rollback');
  const confirmed = await discoverHashAccount(initialRoot, network, breakOrigin);
  const latestOwner = await readOwnerChainState(identity, network);
  if (confirmed.manifestHash !== account.manifestHash || confirmed.currentRoot !== account.currentRoot || confirmed.nonce !== account.nonce
    || latestOwner.deployment.manifestHash !== owner.deployment.manifestHash || latestOwner.nonce !== owner.nonce
    || latestOwner.commitment !== owner.commitment || latestOwner.destination !== owner.destination) throw Error('recourse_hash_account_state_changed');
  return next;
}
