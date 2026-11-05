import { ActionWallet } from '../core/security/ActionWallet';
import { withBiometricAction, assertBiometricAction } from '../core/security/biometricAction';
/**
 * SettleNowCard — the person's on-demand payout .
 *
 * Standard earnings settle on a schedule Provian sets, currently every 30 days for free. This card lets the person settle theirs now for a
 * flat $1 USDC service fee paid from this wallet — never a price for PVT, the same fee whatever
 * they are owed. Nothing is charged when nothing is ready or network fees are above $1; the
 * relay says so and the card shows it. The money terms are pinned on the device
 * (`core/payout/payoutPayment.ts`): a quote naming any other amount, token, chain or recipient is
 * refused before the key is touched. Record points are never shown as earnings — the card counts
 * ready earnings, it does not price them.
 */

import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS } from '../constants/theme';
import relayService, { type PayoutQuote, type PayoutRequestView } from '../services/RelayAPIService';
import { signPayoutPayment } from '../core/payout/payoutPayment';
import { checkPayoutAgain } from '../core/payout/settleNowCheck';
import { storeOfThisBuild } from '../config/distribution';
import { buyWithStore, priceOf, STORE_PRODUCT_IDS, type StoreBuyOutcome } from '../core/store/storePurchase';
import { resumeStorePurchases, storeNative, storeRelay } from '../core/store/storeRuntime';

type Phase =
    | { kind: 'idle' }
    | { kind: 'busy' }
    | { kind: 'quoted'; quote: Extract<PayoutQuote, { available: true }> }
    | { kind: 'storeQuoted'; readyClaims: number | null; price: string | null; savedSettleNow: number }
    | { kind: 'message'; text: string }
    | { kind: 'request'; request: PayoutRequestView };

export function SettleNowCard(): React.ReactElement {
    const { t } = useTranslation();
    const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
    // The App Store and Play builds buy Settle now through the store; the website APK pays USDC.
    const store = storeOfThisBuild();
    const storeName = store === 'app_store' ? t('storeBuy.appStore') : t('storeBuy.googlePlay');

    useEffect(() => {
        if (store !== null) void resumeStorePurchases();
    }, [store]);

    const storeOutcomeText = (outcome: StoreBuyOutcome): string => {
        switch (outcome.kind) {
            case 'held': return outcome.reason === 'waits_for_gas' ? t('storeBuy.settleHeldGas') : t('storeBuy.settleHeld');
            case 'cancelled': return t('storeBuy.cancelled');
            case 'pending': return t('storeBuy.pending');
            case 'unavailable': return t('storeBuy.unavailable');
            case 'denied': return t('storeBuy.denied', { store: storeName });
            case 'error': return outcome.code === 'relay_unreachable' ? t('storeBuy.unreachable') : t('storeBuy.failed', { code: outcome.code });
            default: return t('settleNow.settling');
        }
    };

    const showStoreOutcome = (outcome: StoreBuyOutcome): void => {
        const request = outcome.kind === 'credited' ? outcome.payout as PayoutRequestView | null : null;
        if (request !== null && typeof request === 'object' && typeof request.request_id === 'string') setPhase({ kind: 'request', request });
        else setPhase({ kind: 'message', text: storeOutcomeText(outcome) });
    };

    const buyFromStore = async (): Promise<void> => {
        const native = storeNative();
        if (store === null || native === null) {
            setPhase({ kind: 'message', text: t('storeBuy.unavailable') });
            return;
        }
        setPhase({ kind: 'busy' });
        showStoreOutcome(await buyWithStore(native, storeRelay, store, STORE_PRODUCT_IDS.settleNow));
    };

    const spendSaved = async (): Promise<void> => {
        setPhase({ kind: 'busy' });
        try {
            const answer = await relayService.redeemHeldSettleNow();
            showStoreOutcome(answer.status === 'denied'
                ? { kind: 'denied', error: answer.error }
                : answer.status === 'credited' ? { kind: 'credited', payout: answer.payout } : { kind: 'held', reason: answer.heldReason });
        } catch {
            setPhase({ kind: 'message', text: t('storeBuy.unreachable') });
        }
    };

    const reasonText = (reason: string): string => {
        switch (reason) {
            case 'nothing_to_pay': return t('settleNow.nothingToPay');
            case 'waits_for_gas': return t('settleNow.waitsForGas');
            case 'payment_insufficient_funds': return t('settleNow.insufficient');
            default: return t('settleNow.failed');
        }
    };

    const check = async (): Promise<void> => {
        setPhase({ kind: 'busy' });
        try {
            const quote = await relayService.payoutQuote();
            if (!quote.available) setPhase({ kind: 'message', text: reasonText(quote.reason) });
            else if (store !== null) {
                const native = storeNative();
                const [account, products] = await Promise.all([
                    storeRelay.storeAccount().catch(() => null),
                    native === null ? Promise.resolve([]) : native.products([STORE_PRODUCT_IDS.settleNow]).catch(() => []),
                ]);
                setPhase({
                    kind: 'storeQuoted',
                    readyClaims: quote.readyClaims,
                    price: priceOf(products, STORE_PRODUCT_IDS.settleNow),
                    savedSettleNow: account?.settleNowHeld ?? 0,
                });
            } else setPhase({ kind: 'quoted', quote });
        } catch {
            setPhase({ kind: 'message', text: t('settleNow.failed') });
        }
    };

    const pay = async (quote: Extract<PayoutQuote, { available: true }>): Promise<void> => {
        setPhase({ kind: 'busy' });
        try {
            return await withBiometricAction(t('settleNow.biometricReason'), async (biometricAction) => {

                const { default: SeedManager } = await import('../core/wallet/SeedManager');
                const { ethers } = await import('ethers');
                assertBiometricAction(biometricAction);
                const signer = new ActionWallet(await SeedManager.getEVMPrivateKey(biometricAction), biometricAction);
                const payment = await signPayoutPayment(signer, quote.requirement);
                const request = await relayService.requestPayout(payment, undefined, biometricAction);
                setPhase({ kind: 'request', request });

            }, undefined);
        } catch (error) {
            const message = error instanceof Error ? error.message : '';
            setPhase({ kind: 'message', text: reasonText(message) });
        }
    };

    const advance = async (request: PayoutRequestView): Promise<void> => {
        setPhase({ kind: 'busy' });
        // a "check again" that runs long or fails leaves the charged request as it was.
        setPhase({ kind: 'request', request: await checkPayoutAgain(request, (id) => relayService.advancePayout(id)) });
    };

    return (
        <View style={styles.card}>
            <Text style={styles.title}>{t('settleNow.title')}</Text>
            <Text style={styles.body}>{store === null ? t('settleNow.body') : t('storeBuy.settleBody', { store: storeName })}</Text>

            {phase.kind === 'busy' && <ActivityIndicator color={COLORS.platinum} style={styles.spinner} />}

            {phase.kind === 'message' && <Text style={styles.status}>{phase.text}</Text>}

            {phase.kind === 'quoted' && (
                <>
                    {phase.quote.readyClaims !== null && (
                        <Text style={styles.status}>{t('settleNow.ready', { count: phase.quote.readyClaims })}</Text>
                    )}
                    <View style={styles.actions}>
                        <TouchableOpacity style={styles.button} onPress={() => { void pay(phase.quote); }} accessibilityRole="button">
                            <Text style={styles.buttonText}>{t('settleNow.confirm')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={[styles.button, styles.buttonSecondary]} onPress={() => setPhase({ kind: 'idle' })} accessibilityRole="button">
                            <Text style={styles.buttonText}>{t('settleNow.cancel')}</Text>
                        </TouchableOpacity>
                    </View>
                </>
            )}

            {phase.kind === 'storeQuoted' && (
                <>
                    {phase.readyClaims !== null && (
                        <Text style={styles.status}>{t('settleNow.ready', { count: phase.readyClaims })}</Text>
                    )}
                    {phase.savedSettleNow > 0 && <Text style={styles.status}>{t('storeBuy.settleSavedNote')}</Text>}
                    <View style={styles.actions}>
                        <TouchableOpacity
                            style={styles.button}
                            onPress={() => { void (phase.savedSettleNow > 0 ? spendSaved() : buyFromStore()); }}
                            accessibilityRole="button"
                        >
                            <Text style={styles.buttonText}>
                                {phase.savedSettleNow > 0
                                    ? t('storeBuy.settleUseSaved')
                                    : phase.price === null ? t('storeBuy.settleConfirmNoPrice') : t('storeBuy.settleConfirm', { price: phase.price })}
                            </Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={[styles.button, styles.buttonSecondary]} onPress={() => setPhase({ kind: 'idle' })} accessibilityRole="button">
                            <Text style={styles.buttonText}>{t('settleNow.cancel')}</Text>
                        </TouchableOpacity>
                    </View>
                </>
            )}

            {phase.kind === 'request' && (
                <>
                    <Text style={styles.status}>
                        {phase.request.state === 'settled'
                            ? t('settleNow.settled')
                            : phase.request.state === 'charge_failed'
                                ? t('settleNow.failed')
                                : t('settleNow.settling')}
                    </Text>
                    {phase.request.state !== 'settled' && phase.request.state !== 'charge_failed' && (
                        <View style={styles.actions}>
                            <TouchableOpacity style={[styles.button, styles.buttonSecondary]} onPress={() => { void advance(phase.request); }} accessibilityRole="button">
                                <Text style={styles.buttonText}>{t('settleNow.checkAgain')}</Text>
                            </TouchableOpacity>
                        </View>
                    )}
                </>
            )}

            {(phase.kind === 'idle' || phase.kind === 'message') && (
                <View style={styles.actions}>
                    <TouchableOpacity style={styles.button} onPress={() => { void check(); }} accessibilityRole="button">
                        <Text style={styles.buttonText}>{store === null ? t('settleNow.button') : t('storeBuy.settleButton')}</Text>
                    </TouchableOpacity>
                </View>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    card: {
        borderRadius: BORDER_RADIUS.l,
        padding: SPACING.m,
        marginBottom: SPACING.s,
        borderWidth: 1,
        backgroundColor: COLORS.surface,
        borderColor: COLORS.borderLight,
    },
    title: { fontSize: 15, fontWeight: '600', color: COLORS.text, marginBottom: SPACING.xs },
    body: { fontSize: 13, color: COLORS.textSecondary, lineHeight: 18 },
    status: { fontSize: 13, color: COLORS.textMuted, marginTop: SPACING.s, lineHeight: 18 },
    spinner: { marginTop: SPACING.s },
    actions: { flexDirection: 'row', marginTop: SPACING.m },
    button: {
        flex: 1,
        paddingVertical: SPACING.s,
        borderRadius: BORDER_RADIUS.m,
        backgroundColor: COLORS.surfaceHighlight,
        alignItems: 'center',
        marginRight: SPACING.s,
    },
    buttonSecondary: { marginRight: 0, backgroundColor: 'transparent', borderWidth: 1, borderColor: COLORS.borderLight },
    buttonText: { fontSize: 13, fontWeight: '600', color: COLORS.text },
});

export default SettleNowCard;
