import { withBiometricAction, assertBiometricAction, type BiometricAction } from '../../security/biometricAction';
import SeedManager from '../SeedManager';
import { setItemHmac } from '../../security/hmacAsyncStorage';
import { translate } from '../../../i18n/translate';

const SEED_EXPORTED_KEY = '@provian_seed_phrase_exported';

export interface MnemonicExportResult {
    mnemonic: string;
}

export const MnemonicExportService = {
    /**
     * Check whether this wallet has an exportable mnemonic, without
     * actually returning the secret. Use this in UI mount paths to decide
     * whether to show the export option - calling exportMnemonic() before
     * biometric auth would pull the plaintext mnemonic into memory.
     *
     * [Audit C-4] Uses SeedManager.hasSeed() - the canonical mnemonic
     * storage. KeyManager.getMnemonic() reads from a legacy migration
     * key that is never populated during standard wallet creation.
     */
    async hasMnemonic(): Promise<boolean> {
        return SeedManager.hasSeed();
    },

    /**
     * Retrieves the mnemonic from secure storage.
     *
     * [Audit C-4] Reads from SeedManager (key: provian_bip39_mnemonic),
     * not KeyManager (key: provian_migrated_mnemonic). The latter is only
     * populated for legacy wallet migrations and is null for all wallets
     * created via the standard SeedManager.generate() path.
     *
     * The final Reveal owns one authentication; explicitly nested exports reuse
     * their parent action. The seed read uses that same native approval.
     */
    async exportMnemonic(biometricAction?: BiometricAction): Promise<MnemonicExportResult> {
        return await withBiometricAction(translate('biometricPrompts.exportSeedPhrase', 'Authenticate to export seed phrase'), async (biometricAction) => {
            assertBiometricAction(biometricAction);

            const mnemonic = await SeedManager.getMnemonic(biometricAction);
            if (!mnemonic) {
                throw new Error('No mnemonic found. This wallet may have been created without storing a seed phrase, or it is a legacy wallet.');
            }
            // Local-device flag for the Settings status indicator. Written only
            // after the mnemonic has been retrieved successfully. The flag is not
            // synced; on a fresh device after recovery the screen correctly shows
            // "No" until the user exports again.
            // [Group 8 / chunk-i] HMAC-protected so a filesystem-access attacker
            // cannot flip the flag to mislead the user that they have exported
            // an offline copy when they have not.
            await setItemHmac(SEED_EXPORTED_KEY, true);
            assertBiometricAction(biometricAction);
            return { mnemonic };

        }, biometricAction);
    },
};
