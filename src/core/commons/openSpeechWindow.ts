import { ethers } from 'ethers';
import { getRandomBytes } from 'expo-crypto';
import { bytesToHex } from '@noble/hashes/utils';
import type { BiometricAction } from '../security/biometricAction';
import { assertBiometricAction } from '../security/biometricAction';
import SeedManager from '../wallet/SeedManager';
import TransactionService from '../wallet/TransactionService';
import { getPhoneMeter } from '../meter/phoneMeterRuntime';
import { buildHumanPresentationRequest, burnIdForTx, validateRequesterBinding } from '../presentation/humanPresentation';
import {
    findPendingBurn, isBurnConsumedError, isRevokedBurnError, isRevertedBurnError, isUnusableBurnError,
    markBurnConsumed, obtainBroadcastBurn, rememberRecordedBurn,
} from '../presentation/pendingBurns';
import RelayAPIService, { PresentationRefusedError } from '../../services/RelayAPIService';
import { noteTalkingPassUsed } from './talkingPassBus';
import { PRESENTATION_FLOOR_PVT } from './speechGate';
import { ActionWallet } from '../security/ActionWallet';

export async function currentSpeechWindowPrice(): Promise<number> {
    const floor = await RelayAPIService.getPresentationFloor();
    return Math.max(PRESENTATION_FLOOR_PVT, floor?.reputation ?? PRESENTATION_FLOOR_PVT);
}

/** The phone presents to the audience the relay names in its write refusal. */
export async function openApprovedSpeechWindow(
    address: string, audience: string, quotedPrice: number, biometricAction: BiometricAction,
): Promise<void> {
    assertBiometricAction(biometricAction);
    const fee = await currentSpeechWindowPrice();
    if (fee !== quotedPrice) throw new Error('commons_speech_price_changed');
    const challenge = bytesToHex(getRandomBytes(32));
    if (!validateRequesterBinding({ audience, challenge }).ok) throw new Error('commons_speech_audience_invalid');
    const amountAtomic = ethers.parseUnits(String(fee), 18).toString();
    const sign = async (message: string) => {
        const key = await SeedManager.getEVMPrivateKey(biometricAction);
        return new ActionWallet(key, biometricAction).signMessage(message);
    };
    const presentation = { tier: 'reputation' as const, audience, challenge,
        disclosure: { redact: [], predicates: [], share: [] } };
    await getPhoneMeter().preflightPresentation([]);
    await RelayAPIService.preflightPresentation(
        (await buildHumanPresentationRequest({ ...presentation, burnId: '0'.repeat(64) }, address.toLowerCase(), sign)).body,
        biometricAction,
    );
    let broadcast: Awaited<ReturnType<typeof obtainBroadcastBurn>> | undefined;
    try {
        broadcast = await obtainBroadcastBurn({ address, amountPvt: String(fee), amountAtomic }, {
            burn: (amount, operationId) => TransactionService.burnPVT({ amount, operationId }, biometricAction),
            txStatus: txHash => TransactionService.burnTxStatus(txHash),
        });
        const burnId = broadcast.burnId ?? burnIdForTx('base', broadcast.txHash);
        const { body } = await buildHumanPresentationRequest({
            ...presentation, burnId,
            ...(!broadcast.burnId ? { burnTx: { txHash: broadcast.txHash, amountAtomic: broadcast.amountAtomic, chain: 'base' } } : {}),
        }, address.toLowerCase(), sign);
        await RelayAPIService.produceHumanPresentation(
            body as unknown as Parameters<typeof RelayAPIService.produceHumanPresentation>[0], biometricAction);
        await markBurnConsumed(address, { burnId });
        if (audience === 'provian:commons') noteTalkingPassUsed();
    } catch (error) {
        if (broadcast && error instanceof PresentationRefusedError && error.burnId) {
            await rememberRecordedBurn(address, broadcast.txHash, error.burnId).catch(() => undefined);
        }
        if (isBurnConsumedError(error) || isUnusableBurnError(error)
            || isRevokedBurnError(error) || isRevertedBurnError(error)) {
            const saved = broadcast ?? await findPendingBurn(address, amountAtomic).catch(() => null);
            if (saved) await markBurnConsumed(address, { txHash: saved.txHash }).catch(() => undefined);
        }
        throw error;
    }
}
