/**
 * applyCloudRecovery - overwrite-confirmation guard (B-1 audit 2026-05-11)
 * + same-wallet no-op short-circuit (UX-1, 2026-06-13).
 *
 * B-1: importMnemonic must NOT be called when a DIFFERENT seed already
 * exists locally and the caller has not satisfied the overwrite-confirmation
 * gate (typed phrase + biometric). Without this guard, a returning user with
 * a funded wallet who reaches CloudRecoveryScreen via deep link / back-stack
 * silently loses their wallet.
 *
 * UX-1: when the incoming seed derives the SAME wallet already on the
 * device (the common app-rebuild case), the gate is pointless friction.
 * applyCloudRecovery short-circuits to a benign already-present result with
 * no import and no confirmation. The short-circuit relies on seedMatches
 * failing safe (false on any uncertainty) so it can never skip the gate
 * when the seeds actually differ.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  applyCloudRecovery,
  OverwriteConfirmationRequired,
  REQUIRED_CONFIRMATION_PHRASE,
} from '../applyCloudRecovery';

const MNEMONIC = 'test ' + 'word '.repeat(11);

describe('applyCloudRecovery - fresh device (no existing seed)', () => {
  it('imports the mnemonic and reports no overwrite', async () => {
    const importMnemonic = vi.fn().mockResolvedValue(undefined);
    const seedMatches = vi.fn().mockResolvedValue(false);
    const result = await applyCloudRecovery(MNEMONIC, {
      hasSeed: vi.fn().mockResolvedValue(false),
      seedMatches,
      importMnemonic,
    });
    // On a fresh device the force flag is unset - SeedManager passes
    // through unconditionally.
    expect(importMnemonic).toHaveBeenCalledWith(MNEMONIC, undefined);
    expect(importMnemonic).toHaveBeenCalledTimes(1);
    expect(result.overwroteExistingWallet).toBe(false);
    expect(result.alreadyPresent).toBe(false);
    // No seed present - the match check is never reached.
    expect(seedMatches).not.toHaveBeenCalled();
  });
});

describe('applyCloudRecovery - same wallet already on device (UX-1)', () => {
  it('short-circuits to a no-op when the seed already matches', async () => {
    const importMnemonic = vi.fn().mockResolvedValue(undefined);
    const result = await applyCloudRecovery(MNEMONIC, {
      hasSeed: vi.fn().mockResolvedValue(true),
      seedMatches: vi.fn().mockResolvedValue(true),
      importMnemonic,
    });
    expect(result.alreadyPresent).toBe(true);
    expect(result.overwroteExistingWallet).toBe(false);
    // The whole point: no destructive write, no confirmation friction.
    expect(importMnemonic).not.toHaveBeenCalled();
  });

  it('does NOT require a confirmation when the seed already matches', async () => {
    const importMnemonic = vi.fn().mockResolvedValue(undefined);
    // No overwriteConfirmation argument passed, yet it must not throw.
    await expect(
      applyCloudRecovery(MNEMONIC, {
        hasSeed: vi.fn().mockResolvedValue(true),
        seedMatches: vi.fn().mockResolvedValue(true),
        importMnemonic,
      }),
    ).resolves.toMatchObject({ alreadyPresent: true });
    expect(importMnemonic).not.toHaveBeenCalled();
  });
});

describe('applyCloudRecovery - existing DIFFERENT seed (B-1 guard)', () => {
  it('throws OverwriteConfirmationRequired when no confirmation is passed', async () => {
    const importMnemonic = vi.fn().mockResolvedValue(undefined);
    await expect(
      applyCloudRecovery(MNEMONIC, {
        hasSeed: vi.fn().mockResolvedValue(true),
        seedMatches: vi.fn().mockResolvedValue(false),
        importMnemonic,
      }),
    ).rejects.toBeInstanceOf(OverwriteConfirmationRequired);
    expect(importMnemonic).not.toHaveBeenCalled();
  });

  it('throws OverwriteConfirmationFailed when typed phrase is wrong', async () => {
    const importMnemonic = vi.fn().mockResolvedValue(undefined);
    await expect(
      applyCloudRecovery(
        MNEMONIC,
        {
          hasSeed: vi.fn().mockResolvedValue(true),
          seedMatches: vi.fn().mockResolvedValue(false),
          importMnemonic,
        },
        {
          typedPhrase: 'i understand', // wrong case
          biometricSuccess: true,
        },
      ),
    ).rejects.toMatchObject({
      name: 'OverwriteConfirmationFailed',
      message: expect.stringContaining('phrase_mismatch'),
    });
    expect(importMnemonic).not.toHaveBeenCalled();
  });

  it('throws OverwriteConfirmationFailed when biometric was denied', async () => {
    const importMnemonic = vi.fn().mockResolvedValue(undefined);
    await expect(
      applyCloudRecovery(
        MNEMONIC,
        {
          hasSeed: vi.fn().mockResolvedValue(true),
          seedMatches: vi.fn().mockResolvedValue(false),
          importMnemonic,
        },
        {
          typedPhrase: REQUIRED_CONFIRMATION_PHRASE,
          biometricSuccess: false,
          biometricReason: 'denied',
        },
      ),
    ).rejects.toMatchObject({
      name: 'OverwriteConfirmationFailed',
      message: expect.stringContaining('biometric_denied'),
    });
    expect(importMnemonic).not.toHaveBeenCalled();
  });

  it('imports when the caller passes a fully-satisfied confirmation', async () => {
    const importMnemonic = vi.fn().mockResolvedValue(undefined);
    const result = await applyCloudRecovery(
      MNEMONIC,
      {
        hasSeed: vi.fn().mockResolvedValue(true),
        seedMatches: vi.fn().mockResolvedValue(false),
        importMnemonic,
      },
      {
        typedPhrase: REQUIRED_CONFIRMATION_PHRASE,
        biometricSuccess: true,
      },
    );
    // B-1 sibling fix (2026-05-12): once the helper has validated the
    // typed-phrase + biometric gate, it must pass { force: true } so
    // SeedManager's own overwrite guard lets the write through.
    expect(importMnemonic).toHaveBeenCalledWith(MNEMONIC, { force: true });
    expect(result.overwroteExistingWallet).toBe(true);
    expect(result.alreadyPresent).toBe(false);
  });
});
