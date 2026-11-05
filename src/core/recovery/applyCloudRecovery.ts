/**
 * Apply a decrypted cloud-backup payload to local SecureStore.
 *
 * Extracted from CloudRecoveryScreen so the "do we need to confirm
 * overwrite?" decision is testable in isolation.
 *
 * B-1 (audit 2026-05-11). The previous flow called SeedManager.importMnemonic
 * unconditionally - a returning user with a funded wallet who navigated to
 * CloudRecovery (deep link, RecoveryStartScreen, back-stack) silently lost
 * their wallet to whichever account was signed into iCloud / Drive. The
 * guard below blocks that path: if a seed already exists, the caller MUST
 * pass a confirmCallback that proves the user has typed "I UNDERSTAND" AND
 * passed a biometric prompt before importMnemonic is called.
 *
 * Failing the confirmation throws OverwriteConfirmationRequired without
 * touching SecureStore. The caller (CloudRecoveryScreen) renders the
 * confirmation UI on this throw and re-invokes with confirmCallback wired
 * to the now-completed gate.
 */

// B-1 (audit 2026-05-11) Pass 2 (2026-05-12): the destructive-write guard
// moved into SeedManager.importMnemonic so every caller - not just cloud
// recovery - inherits it. Re-exported here so CloudRecoveryScreen's
// existing `import { OverwriteConfirmationRequired } from
// '../../core/recovery/applyCloudRecovery'` keeps working and `instanceof`
// remains consistent across both call sites.
import { OverwriteConfirmationRequired } from '../wallet/SeedManager';
export { OverwriteConfirmationRequired };

export const REQUIRED_CONFIRMATION_PHRASE = 'I UNDERSTAND';

export class OverwriteConfirmationFailed extends Error {
  constructor(reason: 'phrase_mismatch' | 'biometric_denied' | 'biometric_unavailable') {
    super(`Overwrite confirmation failed: ${reason}`);
    this.name = 'OverwriteConfirmationFailed';
  }
}

export interface OverwriteConfirmation {
  /** Exact text the user typed into the confirmation field. */
  typedPhrase: string;
  /** Result of the OS biometric prompt. */
  biometricSuccess: boolean;
  /** When biometricSuccess is false: why. */
  biometricReason?: 'denied' | 'unavailable';
}

export interface CloudRecoveryDeps {
  hasSeed: () => Promise<boolean>;
  /**
   * Returns true if the mnemonic being restored derives the same wallet
   * already on this device. Used to detect a no-op restore (UX-1). Must
   * fail safe (return false on any uncertainty) - see SeedManager.seedMatches.
   */
  seedMatches: (mnemonic: string) => Promise<boolean>;
  importMnemonic: (mnemonic: string, options?: { force?: boolean }) => Promise<void>;
  /**
   * [] An ACTUAL read of the stored seed (the OS prompts). 'unreadable'
   * is definitive: no stored copy derives the wallet (key invalidated, item
   * gone). A same-wallet restore then RE-WRITES the seed rather than no-op, or
   * the restore flow could never repair it. A dismissed prompt rejects (the
   * restore is retried). Omitted = treated as readable (previous behaviour).
   */
  verifySeedReadable?: () => Promise<'readable' | 'unreadable' | 'no_wallet'>;
}

export interface ApplyCloudRecoveryResult {
  overwroteExistingWallet: boolean;
  /**
   * True when the restored seed already matched the wallet on this device.
   * No import was performed and no overwrite confirmation was required -
   * the restore was a benign no-op. Lets the caller render a calm success
   * state instead of the destructive overwrite warning.
   */
  alreadyPresent: boolean;
}

/**
 * Apply a decrypted cloud backup to SecureStore. If a seed already exists
 * locally, throws OverwriteConfirmationRequired unless the caller has
 * passed an `overwriteConfirmation` that proves the user typed the
 * required phrase AND passed biometric.
 */
export async function applyCloudRecovery(
  mnemonic: string,
  deps: CloudRecoveryDeps,
  overwriteConfirmation?: OverwriteConfirmation,
): Promise<ApplyCloudRecoveryResult> {
  const seedAlreadyPresent = await deps.hasSeed();

  if (seedAlreadyPresent) {
    // UX-1 (2026-06-13): if the incoming seed derives the SAME wallet that
    // already lives on this device, restoring is a no-op - there is nothing
    // to lose by "overwriting" a wallet with itself. Skip the destructive
    // confirmation gate entirely and report a benign already-present
    // restore. This is the common case after an app rebuild/reinstall,
    // where the seed survives in the Keychain and the user "restores" the
    // same wallet. seedMatches fails safe (false on any error), so an
    // ambiguous result falls through to the gate below.
    if (await deps.seedMatches(mnemonic)) {
      // [] seedMatches compares against the stored wallet's PUBLIC
      // address, so it is true even when the seed itself cannot be read on this
      // device. Read it for real: if no stored copy is readable, write the same
      // wallet back (identical identity — nothing to lose, no overwrite gate
      // needed); the write is staged, read back and verified before it commits.
      if (deps.verifySeedReadable && (await deps.verifySeedReadable()) !== 'readable') {
        await deps.importMnemonic(mnemonic, { force: true });
      }
      return { overwroteExistingWallet: false, alreadyPresent: true };
    }

    if (!overwriteConfirmation) {
      // Surface the same error SeedManager would throw, so callers can
      // catch a single error type regardless of which layer rejected.
      throw new OverwriteConfirmationRequired();
    }
    if (overwriteConfirmation.typedPhrase !== REQUIRED_CONFIRMATION_PHRASE) {
      throw new OverwriteConfirmationFailed('phrase_mismatch');
    }
    if (!overwriteConfirmation.biometricSuccess) {
      throw new OverwriteConfirmationFailed(
        overwriteConfirmation.biometricReason === 'unavailable'
          ? 'biometric_unavailable'
          : 'biometric_denied',
      );
    }
  }

  // Pass { force: true } when a seed already exists so SeedManager's own
  // guard (added 2026-05-12) lets the validated overwrite through. On a
  // fresh device the flag is unset and SeedManager passes through
  // unconditionally.
  await deps.importMnemonic(
    mnemonic,
    seedAlreadyPresent ? { force: true } : undefined,
  );
  return { overwroteExistingWallet: seedAlreadyPresent, alreadyPresent: false };
}
