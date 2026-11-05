/**
 * Buying PE Archive space in a store build (App Store / Google Play).
 *
 * The same thing the USDC sheet sells — one more GB of Archive space — bought through the store.
 * The sheet shows what is being bought and the store's own price, the store's purchase sheet takes
 * the payment, and the relay confirms the purchase with the store before the GB is added. Every
 * ending says plainly what happened; a purchase the relay has not yet confirmed stays on the phone
 * and is sent again (`core/store/storePurchase.ts`).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { BORDER_RADIUS, COLORS, SPACING } from '../constants/theme';
import relayService, { type ArchiveView } from '../services/RelayAPIService';
import { storeOfThisBuild } from '../config/distribution';
import { storeNameOf } from '../core/store/paidCopy';
import { buyWithStore, priceOf, STORE_PRODUCT_IDS, type StoreBuyOutcome } from '../core/store/storePurchase';
import { storeNative, storeRelay } from '../core/store/storeRuntime';

type Step =
    | { kind: 'checking' }
    | { kind: 'confirm'; archive: ArchiveView | null; price: string | null }
    | { kind: 'buying' }
    | { kind: 'success'; archive: ArchiveView | null }
    | { kind: 'ended'; text: string };

const GB = 1_000_000_000;
function gb(bytes: number): string {
    const v = bytes / GB;
    return v >= 10 ? v.toFixed(0) : v.toFixed(v >= 1 ? 1 : 2);
}

export interface ArchiveStorePurchaseSheetProps {
    readonly visible: boolean;
    readonly onClose: (changed: boolean) => void;
}

export function ArchiveStorePurchaseSheet({ visible, onClose }: ArchiveStorePurchaseSheetProps): React.ReactElement {
    const { t } = useTranslation();
    const store = storeOfThisBuild();
    const storeName = storeNameOf(t, store);
    const [step, setStep] = useState<Step>({ kind: 'checking' });
    const changed = useRef(false);

    const endText = useCallback((outcome: StoreBuyOutcome): string => {
        switch (outcome.kind) {
            case 'held': return t('storeBuy.confirming');
            case 'cancelled': return t('storeBuy.cancelled');
            case 'pending': return t('storeBuy.pending');
            case 'unavailable': return t('storeBuy.unavailable');
            case 'denied': return t('storeBuy.denied', { store: storeName });
            case 'error': return outcome.code === 'relay_unreachable' ? t('storeBuy.unreachable') : t('storeBuy.failed', { code: outcome.code });
            default: return t('storeBuy.archiveSuccess');
        }
    }, [t, storeName]);

    const start = useCallback(async (): Promise<void> => {
        setStep({ kind: 'checking' });
        const native = storeNative();
        if (store === null || native === null) {
            setStep({ kind: 'ended', text: t('storeBuy.unavailable') });
            return;
        }
        const [archive, products] = await Promise.all([
            relayService.archiveStatus().catch(() => null),
            native.products([STORE_PRODUCT_IDS.archiveGb]).catch(() => []),
        ]);
        setStep({ kind: 'confirm', archive, price: priceOf(products, STORE_PRODUCT_IDS.archiveGb) });
    }, [store, t]);

    useEffect(() => {
        if (!visible) return;
        changed.current = false;
        void start();
    }, [visible, start]);

    const buy = async (): Promise<void> => {
        const native = storeNative();
        if (store === null || native === null) return;
        setStep({ kind: 'buying' });
        const outcome = await buyWithStore(native, storeRelay, store, STORE_PRODUCT_IDS.archiveGb);
        if (outcome.kind === 'credited') {
            changed.current = true;
            setStep({ kind: 'success', archive: await relayService.archiveStatus().catch(() => null) });
            return;
        }
        setStep({ kind: 'ended', text: endText(outcome) });
    };

    const close = (): void => onClose(changed.current);

    const body = (): React.ReactElement => {
        switch (step.kind) {
            case 'checking':
            case 'buying':
                return (
                    <View style={styles.center}>
                        <ActivityIndicator color={COLORS.platinum} />
                        <Text style={styles.muted}>{step.kind === 'buying' ? t('storeBuy.confirming') : t('peArchive.checkingTitle')}</Text>
                    </View>
                );
            case 'confirm': {
                const a = step.archive;
                const more = a !== null && a.paidBytes > 0;
                return (
                    <>
                        <Text style={styles.title}>{more ? t('peArchive.confirmTitleMore') : t('peArchive.confirmTitleFirst')}</Text>
                        <Row label={t('peArchive.rowBuy')} value={t('peArchive.rowBuyValue')} />
                        <Row
                            label={t('peArchive.rowPay')}
                            value={step.price === null ? t('storeBuy.priceFromStore', { store: storeName }) : t('storeBuy.rowPayValue', { price: step.price, store: storeName })}
                        />
                        {more && a !== null && <Row label={t('peArchive.rowHave')} value={t('peArchive.rowHaveValue', { paid: gb(a.paidBytes), used: gb(a.usedBytes) })} />}
                        {more && a !== null && <Row label={t('peArchive.rowAfter')} value={t('peArchive.rowAfterValue', { paid: gb(a.paidBytes + GB) })} />}
                        <Text style={styles.muted}>{t('peArchive.lineMinimum')}</Text>
                        <View style={styles.notice}><Text style={styles.noticeText}>{t('storeBuy.archiveFinalNotice', { store: storeName })}</Text></View>
                        <Button
                            primary
                            label={step.price === null ? t('storeBuy.buyNoPrice') : t('storeBuy.buyWithPrice', { price: step.price })}
                            onPress={() => { void buy(); }}
                        />
                        <Button label={t('peArchive.cancel')} onPress={close} />
                    </>
                );
            }
            case 'success': {
                const a = step.archive;
                return (
                    <>
                        <Text style={styles.bigCheck}>✓</Text>
                        <Text style={styles.title}>{t('peArchive.successTitle')}</Text>
                        <Text style={styles.bodyText}>{t('storeBuy.archiveSuccess')}</Text>
                        {a && <Text style={styles.bodyText}>{t('peArchive.successSpace', { used: gb(a.usedBytes), paid: gb(a.paidBytes) })}</Text>}
                        <Text style={styles.muted}>{t('peArchive.successOn')}</Text>
                        <Button primary label={t('peArchive.done')} onPress={close} />
                    </>
                );
            }
            case 'ended':
                return (
                    <>
                        <Text style={styles.bodyText}>{step.text}</Text>
                        <Button primary label={t('peArchive.tryAgain')} onPress={() => { void start(); }} />
                        <Button label={t('peArchive.done')} onPress={close} />
                    </>
                );
        }
    };

    return (
        <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => { if (step.kind !== 'buying') close(); }}>
            <ScrollView style={styles.sheet} contentContainerStyle={styles.sheetContent}>{body()}</ScrollView>
        </Modal>
    );
}

function Row({ label, value }: { label: string; value: string }): React.ReactElement {
    return (
        <View style={styles.row}>
            <Text style={styles.rowLabel}>{label}</Text>
            <Text style={styles.rowValue}>{value}</Text>
        </View>
    );
}

function Button({ label, onPress, primary = false }: { label: string; onPress: () => void; primary?: boolean }): React.ReactElement {
    return (
        <TouchableOpacity style={[styles.button, primary ? styles.buttonPrimary : styles.buttonSecondary]} onPress={onPress} accessibilityRole="button">
            <Text style={[styles.buttonText, primary ? styles.buttonTextPrimary : null]}>{label}</Text>
        </TouchableOpacity>
    );
}

const styles = StyleSheet.create({
    sheet: { flex: 1, backgroundColor: COLORS.background },
    sheetContent: { padding: SPACING.l, paddingTop: SPACING.xl },
    center: { alignItems: 'center', paddingVertical: SPACING.xl },
    title: { fontSize: 20, fontWeight: '700', color: COLORS.text, marginBottom: SPACING.m },
    bodyText: { fontSize: 15, color: COLORS.text, lineHeight: 22, marginBottom: SPACING.s },
    muted: { fontSize: 13, color: COLORS.textSecondary, lineHeight: 18, marginTop: SPACING.s },
    row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: SPACING.s, borderBottomWidth: 1, borderBottomColor: COLORS.border },
    rowLabel: { fontSize: 14, color: COLORS.textSecondary, flex: 1 },
    rowValue: { fontSize: 14, color: COLORS.text, fontWeight: '600', flex: 1.4, textAlign: 'right' },
    notice: { marginTop: SPACING.m, padding: SPACING.m, borderRadius: BORDER_RADIUS.m, backgroundColor: COLORS.secondaryMuted, borderWidth: 1, borderColor: COLORS.secondary },
    noticeText: { fontSize: 14, color: COLORS.text, fontWeight: '600', lineHeight: 20 },
    bigCheck: { fontSize: 48, color: COLORS.success, textAlign: 'center', marginBottom: SPACING.s },
    button: { marginTop: SPACING.m, paddingVertical: SPACING.m, borderRadius: BORDER_RADIUS.m, alignItems: 'center' },
    buttonPrimary: { backgroundColor: COLORS.primary },
    buttonSecondary: { borderWidth: 1, borderColor: COLORS.borderLight },
    buttonText: { fontSize: 15, fontWeight: '600', color: COLORS.text },
    buttonTextPrimary: { color: COLORS.white },
});

export default ArchiveStorePurchaseSheet;
