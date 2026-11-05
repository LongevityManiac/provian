import { withBiometricAction, assertBiometricAction, type BiometricAction } from '../../security/biometricAction';
/**
 * PrivateKeyExportService - On-demand EVM key derivation for export.
 *
 * Derives the EVM private key from the BIP-39 seed via SeedManager.getEVMKey(),
 * which requires a live action capability inside SeedManager itself. Each
 * standalone export authenticates once and that approval ends with the export.
 */

import SeedManager, { DERIVATION_PATHS } from '../SeedManager';

export type ExportableChain = 'evm';

export interface PrivateKeyExportResult {
    privateKeyHex: string;
    chain: ExportableChain;
    address: string;
    path: string;
}

export const PrivateKeyExportService = {
    /**
     * Derive and return the EVM private key from the BIP-39 seed.
     *
     * Requires biometric authentication. The derived key is returned as a hex
     * string. The caller MUST display it ephemerally and discard it immediately.
     * Never log or persist the return value.
     */
    async exportPrivateKey(chain: ExportableChain, biometricAction?: BiometricAction): Promise<PrivateKeyExportResult> {
        // Each standalone export owns a fresh action; an explicitly nested read shares it.

        return await withBiometricAction('Authenticate to export private key', async (biometricAction) => {
            assertBiometricAction(biometricAction);

            const hasSeed = await SeedManager.hasSeed();
            if (!hasSeed) {
                throw new Error('No wallet seed found. Cannot export private key.');
            }

            const derived = await SeedManager.getEVMKey(biometricAction);
            const result: PrivateKeyExportResult = {
                privateKeyHex: derived.privateKeyHex,
                chain,
                address: derived.address,
                path: DERIVATION_PATHS.EVM,
            };

            derived.privateKey.fill(0);

            return result;

        }, biometricAction);
    },
};
