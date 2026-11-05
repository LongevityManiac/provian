import { withBiometricAction, type BiometricAction } from '../security/biometricAction';
/**
 * burnForBenefit — the phone's "burn PVT once, spend it on one benefit" for the burn
 * products (a challenge stake, a featured-placement bid). Biometric-gated by the burn itself
 * (TransactionService.burnPVT); the relay re-verifies the on-chain burn before it can buy
 * anything (`recordFirstPartyBurn`). One burn = one benefit, system-wide.
 *
 * The burn is saved on the phone the moment it is broadcast and recorded once it is mined on Base
 * (pendingBurns); the relay checks finality afterwards and revokes the benefit of a burn that fails it. It is forgotten only when the benefit succeeds — if the benefit call fails the
 * burn stays saved and the next attempt for the same amount uses it instead of burning again.
 */
import { ethers } from 'ethers';
import TransactionService from '../wallet/TransactionService';
import RelayAPIService from '../../services/RelayAPIService';
import { useWalletStore } from '../../store/walletStore';
import { obtainRecordedBurn, markBurnConsumed, isBurnConsumedError, isRevokedBurnError, type BurnStage } from '../presentation/pendingBurns';
import { translate } from '../../i18n/translate';

export async function spendBurn<T>(amountPvt: string, use: (burnId: string, action: BiometricAction) => Promise<T>, onStage?: (s: BurnStage) => void, biometricAction?: BiometricAction): Promise<T> {
    const address = useWalletStore.getState().address;
    if (!address) throw new Error('No wallet on this phone');
    const amountAtomic = ethers.parseUnits(amountPvt, 18).toString(); // same conversion burnPVT broadcasts
    return withBiometricAction(translate('biometricPrompts.approveBurnPvt', `Approve burn of ${amountPvt} PVT`, { amount: amountPvt }), async action => {
    const got = await obtainRecordedBurn(
        { address, amountPvt, amountAtomic, onStage },
        {
            burn: (amount, operationId) => TransactionService.burnPVT({ amount, operationId }, action),
            record: (p) => RelayAPIService.recordFirstPartyBurn(p, action),
            txStatus: (h) => TransactionService.burnTxStatus(h),
        },
    );
    try {
        const out = await use(got.burnId, action);
        await markBurnConsumed(address, { burnId: got.burnId });
        return out;
    } catch (err) {
        if (isBurnConsumedError(err)) await markBurnConsumed(address, { burnId: got.burnId });
        // the relay revoked this saved burn (it never reached Base finality) — it can
        // never buy anything, so forget it; the next attempt burns afresh.
        if (isRevokedBurnError(err)) await markBurnConsumed(address, { burnId: got.burnId });
        throw err;
    }
    }, biometricAction);
}
