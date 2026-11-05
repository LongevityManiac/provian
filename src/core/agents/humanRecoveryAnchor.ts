import { withBiometricAction, assertBiometricAction, isBiometricActionValid, type BiometricAction } from '../security/biometricAction';
/**
 * humanRecoveryAnchor — the human's ONE agent-recovery key (item 11,).
 *
 * "The fleet code carries the public half of the human's recovery key; the agent seals its
 * escrow to it at install; the relay stores only the public half." No per-agent tap: the phone
 * publishes the public half once, and every agent any of the human's linked agents onboards — plus every
 * already-installed agent with no escrow — seals a recovery copy of its own key to it. Only this
 * wallet's seed opens those copies.
 *
 * The anchor is DERIVED from the wallet seed (HKDF, domain-separated), not minted at random:
 * every phone holding the seed derives the same key, a restored wallet re-derives it, and there
 * is no second secret to back up. The seed already guards the wallet's funds and already wraps
 * every stored invite anchor (agentAnchorStore.anchorWrapKey), so this adds no new exposure.
 *
 * The publish carries an EIP-191 signature by the wallet key over the public key, so the relay
 * accepts it only from this wallet. The message names Provian, so WalletConnect refuses to sign
 * it for any dApp (walletconnect/provianReserved.ts).
 */

import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { ethers } from 'ethers';
import SeedManager from '../wallet/SeedManager';
import { toB64u } from '../security/agentKeyRecovery';
import RelayAPIService from '../../services/RelayAPIService';
import { translate } from '../../i18n/translate';

const SALT = new TextEncoder().encode('provian-human-recovery-anchor-v1');
const INFO = new TextEncoder().encode('x25519-secret');

export interface HumanRecoveryAnchor {
    secretKey: Uint8Array;
    publicKey: Uint8Array;
    publicKeyB64u: string;
}

/** Pure: the anchor a mnemonic derives. */
export function deriveHumanRecoveryAnchor(mnemonic: string): HumanRecoveryAnchor {
    const secretKey = hkdf(sha256, new TextEncoder().encode(mnemonic), SALT, INFO, 32);
    const publicKey = x25519.getPublicKey(secretKey);
    return { secretKey, publicKey, publicKeyB64u: toB64u(publicKey) };
}

/** The exact text the wallet signs. Must equal the relay's `humanRecoveryAnchorMessage`. */
export function humanRecoveryAnchorMessage(pubkeyB64u: string): string {
    return `Provian human recovery anchor v1\n${pubkeyB64u}`;
}

/** Pure: sign the publish with a provided key (tests drive it with a throwaway wallet). */
export async function signHumanRecoveryAnchor(privateKey: string, pubkeyB64u: string): Promise<string> {
    return new ethers.Wallet(privateKey).signMessage(humanRecoveryAnchorMessage(pubkeyB64u));
}

export type PublishOutcome = 'published' | 'already_published' | 'no_session' | 'failed';

export interface PublishDeps {
    sessionValid: () => boolean;
    requireSession: (reason: string) => Promise<void>;
    getMnemonic: () => Promise<string | null>;
    readPublished: () => Promise<string | null | undefined>;
    publish: (pubkeyB64u: string, signature: string) => Promise<boolean>;
}

const defaultDeps = (action?: BiometricAction): PublishDeps => ({
    sessionValid: () => isBiometricActionValid(action),
    requireSession: async () => { assertBiometricAction(action); },
    getMnemonic: () => SeedManager.getMnemonic(action),
    readPublished: () => RelayAPIService.getHumanRecoveryAnchor(action),
    publish: (pub, sig) => RelayAPIService.putHumanRecoveryAnchor(pub, sig, action),
});

/**
 * Publish this wallet's anchor if the relay does not already hold it. Never throws.
 *
 * Every seed read is its own OS prompt (the keychain ACL), so the relay is asked FIRST: an anchor
 * already there can only have been signed by this wallet's key, so it is this wallet's and nothing
 * is read. Only an unpublished anchor reads the seed — ONCE: the anchor and the signing key both
 * derive from that one read (the wallet key is the standard m/44'/60'/0'/0/0, as SeedManager).
 * `prompt: false` never opens a biometric session; `prompt: true` is the attention center's one
 * confirmation.
 */
export async function publishHumanRecoveryAnchor(
  opts: { prompt: boolean },
  providedDeps?: PublishDeps,
  action?: BiometricAction,
): Promise<PublishOutcome> {
  if (!providedDeps && opts.prompt && !action) {
    try { return await withBiometricAction(translate('biometricPrompts.keepAgentsRecoverable', 'Keep your agents recoverable'), granted => publishHumanRecoveryAnchor(opts, undefined, granted)); } catch { return 'failed'; }
  }
  const deps = providedDeps ?? defaultDeps(action);
  try {
    const published = await deps.readPublished();
    if (typeof published === 'string') return 'already_published';
    if (published === undefined) return 'failed'; // unreadable relay: never publish blind
    if (!opts.prompt && !deps.sessionValid()) return 'no_session';
    if (opts.prompt) await deps.requireSession(translate('biometricPrompts.keepAgentsRecoverable', 'Keep your agents recoverable'));
    const mnemonic = await deps.getMnemonic();
    if (!mnemonic) return 'failed';
    const anchor = deriveHumanRecoveryAnchor(mnemonic);
    const signature = await ethers.HDNodeWallet.fromPhrase(mnemonic).signMessage(humanRecoveryAnchorMessage(anchor.publicKeyB64u));
    return (await deps.publish(anchor.publicKeyB64u, signature)) ? 'published' : 'failed';
  } catch {
    return 'failed';
  }
}

/**
 * Recovery: the anchor secret for an escrow sealed to the human's derived anchor. Returns null
 * when `anchorPubkeyB64u` is not this seed's anchor (a per-invite anchor lives in the store).
 */
export async function derivedAnchorSecretFor(
  anchorPubkeyB64u: string,
  providedDeps?: Pick<PublishDeps, 'requireSession' | 'getMnemonic'>,
  action?: BiometricAction,
): Promise<Uint8Array | null> {
  if (!providedDeps && !action) return await withBiometricAction(translate('biometricPrompts.recoverAgent', 'Recover your agent'), granted => derivedAnchorSecretFor(anchorPubkeyB64u, undefined, granted));
  const deps = providedDeps ?? defaultDeps(action);
  await deps.requireSession(translate('biometricPrompts.recoverAgent', 'Recover your agent'));
  const mnemonic = await deps.getMnemonic();
  if (!mnemonic) return null;
  const anchor = deriveHumanRecoveryAnchor(mnemonic);
  return anchor.publicKeyB64u === anchorPubkeyB64u ? anchor.secretKey : null;
}
