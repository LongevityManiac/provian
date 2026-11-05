import { ActionWallet } from '../core/security/ActionWallet';
import { withBiometricAction } from '../core/security/biometricAction';
/**
 * Buying PE Archive space, start to finish (PE Archive human-path run, 2026-10-07).
 *
 * The sheet a person sees after tapping "Turn on" or "Buy another 1 GB". It always shows, in order:
 * what they are buying and from which balance (checked BEFORE Face ID — the operator’s first purchase died
 * because his wallet held $0.945 and nothing told him), that the purchase is permanent and
 * non-refundable, progress while the relay charges and Base confirms, and one unmistakable ending:
 * what they bought, their space and the transaction with a link — or "Not charged" and why. A
 * purchase whose answer was lost is followed up by its request id until the relay reports it or the
 * signed authorization has expired, and survives the app closing (`archivePurchase.ts`).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTranslation } from 'react-i18next';
import { BORDER_RADIUS, COLORS, SPACING } from '../constants/theme';
import relayService, { type ArchivePaymentView, type ArchiveQuote, type ArchiveView } from '../services/RelayAPIService';
import { signArchivePayment } from '../core/meter/archivePayment';
import {
    archiveFailureText,
    baseTxUrl,
    biometricFailureCode,
    clearPendingPurchase,
    followUpVerdict,
    readPendingPurchase,
    savePendingPurchase,
    shortHash,
    signedArchivePaymentOf,
    usdcDollars,
    type PendingArchivePurchase,
} from '../core/meter/archivePurchase';

type Quote = Extract<ArchiveQuote, { available: true }>;

type Step =
    | { kind: 'checking' }
    | { kind: 'confirm'; quote: Quote }
    | { kind: 'insufficient'; balance: string }
    | { kind: 'gas' }
    | { kind: 'paying'; startedAtMs: number; signed: boolean }
    | { kind: 'success'; payment: ArchivePaymentView; archive: ArchiveView | null }
    | { kind: 'confirming'; payment: ArchivePaymentView; pending: PendingArchivePurchase }
    | { kind: 'unknown'; pending: PendingArchivePurchase }
    | { kind: 'failed'; key: string; params?: Record<string, string> };

const GB = 1_000_000_000;
const POLL_MS = 4000;

function gb(bytes: number): string {
    const v = bytes / GB;
    return v >= 10 ? v.toFixed(0) : v.toFixed(v >= 1 ? 1 : 2);
}

export interface ArchivePurchaseSheetProps {
    readonly visible: boolean;
    readonly onClose: (changed: boolean) => void;
    readonly onSwap: () => void;
}

/**
 * Every way into a purchase (opening the sheet, "Try again") goes through `start`, which first looks
 * for this wallet's purchase still pending — one whose answer was lost, or whose charge is still
 * confirming — and follows it up instead of quoting a new one. A second $5 can never be signed while
 * the first is unresolved.
 */
export function ArchivePurchaseSheet({ visible, onClose, onSwap }: ArchivePurchaseSheetProps): React.ReactElement {
    const { t } = useTranslation();
    const [step, setStep] = useState<Step>({ kind: 'checking' });
    const [now, setNow] = useState(Date.now());
    const changed = useRef(false);
    const alive = useRef(true);

    useEffect(() => () => { alive.current = false; }, []);

    const fail = useCallback((code: string): void => {
        const text = archiveFailureText(code);
        setStep({ kind: 'failed', key: text.key, ...(text.params ? { params: text.params } : {}) });
    }, []);

    const finishCredited = useCallback(async (payment: ArchivePaymentView): Promise<void> => {
        await clearPendingPurchase(AsyncStorage).catch(() => undefined);
        changed.current = true;
        const archive = payment.archive ?? await relayService.archiveStatus().catch(() => null);
        if (alive.current) setStep({ kind: 'success', payment, archive });
        // The meter uploads (and later drops) on its own schedule; run it now so the change shows.
        void import('../core/meter/phoneMeterRuntime').then(async (m) => {
            const meter = m.getPhoneMeter();
            await meter.start();
            await meter.archive?.run();
        }).catch(() => undefined);
    }, []);

    const start = useCallback(async (): Promise<void> => {
        setStep({ kind: 'checking' });
        let walletAddress: string;
        try {
            walletAddress = await (await import('../core/wallet/SeedManager')).default.getEVMAddress();
        } catch (error) {
            fail(`sign:${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        const pending = await readPendingPurchase(AsyncStorage, walletAddress);
        if (pending !== null) {
            if (alive.current) setStep({ kind: 'unknown', pending });
            return;
        }
        let q: ArchiveQuote;
        try {
            q = await relayService.archiveQuote();
        } catch (error) {
            fail(`quote:${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        if (!q.available) {
            fail(q.reason === 'archive_space_available' || q.reason === 'waits_for_gas' ? q.reason : `quote:${q.reason}`);
            return;
        }
        if (q.gasCovered === false) {
            setStep({ kind: 'gas' });
            return;
        }
        if (q.payer?.sufficient === false && q.payer.balanceAtomic !== null) {
            setStep({ kind: 'insufficient', balance: usdcDollars(q.payer.balanceAtomic) });
            return;
        }
        setStep({ kind: 'confirm', quote: q });
    }, [fail]);

    useEffect(() => {
        if (!visible) return;
        changed.current = false;
        void start();
    }, [visible, start]);

    const pay = async (quote: Quote): Promise<void> => {
        setStep({ kind: 'paying', startedAtMs: Date.now(), signed: false });
        let SeedManager: typeof import('../core/wallet/SeedManager').default;
        try {
            SeedManager = (await import('../core/wallet/SeedManager')).default;
        } catch (error) {
            fail(`sign:${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        try {
            return await withBiometricAction(t('peArchive.biometricReason'), async (biometricAction) => {

                let payment: string;
                let pending: PendingArchivePurchase;
                try {
                    const { ethers } = await import('ethers');
                    const signer = new ActionWallet(await SeedManager.getEVMPrivateKey(biometricAction), biometricAction);
                    payment = await signArchivePayment(signer, quote.requirement);
                    const signed = signedArchivePaymentOf(payment);
                    pending = { requestId: signed.requestId, from: signed.from.toLowerCase(), validBefore: signed.validBefore, startedAtMs: Date.now() };
                } catch (error) {
                    // Nothing has left the phone yet.
                    fail(error instanceof Error && error.message.startsWith('archive_quote_refused') ? error.message : `sign:${error instanceof Error ? error.message : String(error)}`);
                    return;
                }
                // The pending record is what stops a second purchase while this one is unresolved: if the
                // phone can't keep it, the signed payment is not sent (nothing has left the phone).
                try {
                    await savePendingPurchase(AsyncStorage, pending);
                } catch (error) {
                    fail(`record:${error instanceof Error ? error.message : String(error)}`);
                    return;
                }
                setStep({ kind: 'paying', startedAtMs: Date.now(), signed: true });
                const outcome = await relayService.buyArchiveGb(payment, biometricAction);
                if (!alive.current) return;
                if (outcome.kind === 'paid') {
                    if (outcome.view.credited) await finishCredited(outcome.view);
                    else setStep({ kind: 'confirming', payment: outcome.view, pending });
                    return;
                }
                if (outcome.kind === 'refused') {
                    await clearPendingPurchase(AsyncStorage).catch(() => undefined);
                    fail(outcome.code);
                    return;
                }
                setStep({ kind: 'unknown', pending });

            }, undefined);
        } catch (error) {
            fail(biometricFailureCode(error));
            return;
        }
};

    // Follow up a purchase still confirming, or one whose answer was lost. Keyed on the request id so
    // a status update does not re-arm the poll.
    const following = step.kind === 'confirming' || step.kind === 'unknown' ? step.pending : null;
    const followId = following?.requestId ?? null;
    const followRef = useRef<PendingArchivePurchase | null>(null);
    followRef.current = following;
    useEffect(() => {
        if (followId === null) return;
        let stop = false;
        const tick = async (): Promise<void> => {
            const pending = followRef.current;
            if (pending === null) return;
            let payment: ArchivePaymentView | null = null;
            try {
                payment = await relayService.archivePayment(pending.requestId);
            } catch (error) {
                const msg = error instanceof Error ? error.message : '';
                if (msg !== 'archive_http_404') return; // unreachable now: ask again next tick
            }
            if (stop || !alive.current) return;
            const verdict = followUpVerdict(payment, pending, Date.now());
            if (verdict.kind === 'credited' && payment) await finishCredited(payment);
            else if (verdict.kind === 'confirming' && payment) {
                const p = payment;
                setStep((cur) => (cur.kind === 'confirming' && cur.payment.chargeTxHash === p.chargeTxHash ? cur : { kind: 'confirming', payment: p, pending }));
            } else if (verdict.kind === 'not_charged') {
                await clearPendingPurchase(AsyncStorage).catch(() => undefined);
                fail(verdict.code);
            }
        };
        void tick();
        const id = setInterval(() => { void tick(); }, POLL_MS);
        return () => { stop = true; clearInterval(id); };
    }, [followId, fail, finishCredited]);

    useEffect(() => {
        if (step.kind !== 'paying') return;
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, [step.kind]);

    const close = (): void => onClose(changed.current);
    const busy = step.kind === 'checking' || step.kind === 'paying';

    const txLink = (hash: string | null): React.ReactElement | null => hash === null ? null : (
        <TouchableOpacity onPress={() => { void Linking.openURL(baseTxUrl(hash)); }} accessibilityRole="link" style={styles.txRow}>
            <Text style={styles.rowLabel}>{t('peArchive.txLabel')}</Text>
            <Text style={styles.link}>{shortHash(hash)} · {t('peArchive.viewTx')} ↗</Text>
        </TouchableOpacity>
    );

    const body = (): React.ReactElement => {
        switch (step.kind) {
            case 'checking':
                return (
                    <View style={styles.center}>
                        <ActivityIndicator color={COLORS.platinum} />
                        <Text style={styles.muted}>{t('peArchive.checkingTitle')}</Text>
                    </View>
                );
            case 'confirm': {
                const a = step.quote.archive;
                const more = a.paidBytes > 0;
                const balance = step.quote.payer?.balanceAtomic ?? null;
                return (
                    <>
                        <Text style={styles.title}>{more ? t('peArchive.confirmTitleMore') : t('peArchive.confirmTitleFirst')}</Text>
                        <Row label={t('peArchive.rowBuy')} value={t('peArchive.rowBuyValue')} />
                        <Row label={t('peArchive.rowPay')} value={t('peArchive.rowPayValue')} />
                        <Row label={t('peArchive.rowBalance')} value={balance === null ? t('peArchive.rowBalanceUnknown') : usdcDollars(balance)} />
                        {more && <Row label={t('peArchive.rowHave')} value={t('peArchive.rowHaveValue', { paid: gb(a.paidBytes), used: gb(a.usedBytes) })} />}
                        {more && <Row label={t('peArchive.rowAfter')} value={t('peArchive.rowAfterValue', { paid: gb(a.paidBytes + GB) })} />}
                        <Text style={styles.muted}>{t('peArchive.lineMinimum')}</Text>
                        <View style={styles.notice}><Text style={styles.noticeText}>{t('peArchive.finalNotice')}</Text></View>
                        <Button primary label={t('peArchive.payButton')} onPress={() => { void pay(step.quote); }} />
                        <Button label={t('peArchive.cancel')} onPress={close} />
                    </>
                );
            }
            case 'insufficient':
                return (
                    <>
                        <Text style={styles.title}>{t('peArchive.insufficientTitle')}</Text>
                        <Text style={styles.bodyText}>{t('peArchive.insufficientBody', { balance: step.balance })}</Text>
                        <Button primary label={t('peArchive.swapForUsdc')} onPress={() => { onClose(false); onSwap(); }} />
                        <Button label={t('peArchive.cancel')} onPress={close} />
                    </>
                );
            case 'gas':
                return (
                    <>
                        <Text style={styles.title}>{t('peArchive.gasTitle')}</Text>
                        <Text style={styles.bodyText}>{t('peArchive.gasBody')}</Text>
                        <Button primary label={t('peArchive.tryAgain')} onPress={() => { void start(); }} />
                        <Button label={t('peArchive.cancel')} onPress={close} />
                    </>
                );
            case 'paying':
                return (
                    <>
                        <Stage done label={t('peArchive.stepApproved')} />
                        <Stage done={step.signed} label={t('peArchive.stepSigned')} />
                        {step.signed && <Stage label={t('peArchive.stepCharging', { seconds: String(Math.max(0, Math.floor((now - step.startedAtMs) / 1000))) })} />}
                        <Text style={styles.muted}>{t('peArchive.stepChargingHint')}</Text>
                    </>
                );
            case 'success': {
                const a = step.archive;
                return (
                    <>
                        <Text style={styles.bigCheck}>✓</Text>
                        <Text style={styles.title}>{t('peArchive.successTitle')}</Text>
                        <Text style={styles.bodyText}>{t('peArchive.successBought')}</Text>
                        {a && <Text style={styles.bodyText}>{t('peArchive.successSpace', { used: gb(a.usedBytes), paid: gb(a.paidBytes) })}</Text>}
                        {txLink(step.payment.chargeTxHash)}
                        <Text style={styles.muted}>{t('peArchive.successOn')}</Text>
                        <Button primary label={t('peArchive.done')} onPress={close} />
                    </>
                );
            }
            case 'confirming':
                return (
                    <>
                        <ActivityIndicator color={COLORS.platinum} style={styles.spinner} />
                        <Text style={styles.title}>{t('peArchive.confirmingTitle')}</Text>
                        <Text style={styles.bodyText}>{t('peArchive.confirmingBody')}</Text>
                        {txLink(step.payment.chargeTxHash)}
                        <Button label={t('peArchive.done')} onPress={close} />
                    </>
                );
            case 'unknown':
                return (
                    <>
                        <ActivityIndicator color={COLORS.platinum} style={styles.spinner} />
                        <Text style={styles.title}>{t('peArchive.unknownTitle')}</Text>
                        <Text style={styles.bodyText}>{t('peArchive.unknownBody', { time: new Date(step.pending.validBefore * 1000).toLocaleTimeString() })}</Text>
                        <Button label={t('peArchive.done')} onPress={close} />
                    </>
                );
            case 'failed':
                return (
                    <>
                        <Text style={[styles.title, styles.failTitle]}>{t('peArchive.failedTitle')}</Text>
                        <Text style={styles.bodyText}>{t(step.key, step.params ?? {})}</Text>
                        <Button primary label={t('peArchive.tryAgain')} onPress={() => { void start(); }} />
                        <Button label={t('peArchive.cancel')} onPress={close} />
                    </>
                );
        }
    };

    return (
        <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => { if (!busy) close(); }}>
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

function Stage({ label, done = false }: { label: string; done?: boolean }): React.ReactElement {
    return (
        <View style={styles.stage}>
            {done ? <Text style={styles.stageDone}>✓</Text> : <ActivityIndicator color={COLORS.platinum} />}
            <Text style={styles.stageText}>{label}</Text>
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
    failTitle: { color: COLORS.accent },
    bodyText: { fontSize: 15, color: COLORS.text, lineHeight: 22, marginBottom: SPACING.s },
    muted: { fontSize: 13, color: COLORS.textSecondary, lineHeight: 18, marginTop: SPACING.s },
    row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: SPACING.s, borderBottomWidth: 1, borderBottomColor: COLORS.border },
    rowLabel: { fontSize: 14, color: COLORS.textSecondary, flex: 1 },
    rowValue: { fontSize: 14, color: COLORS.text, fontWeight: '600', flex: 1.4, textAlign: 'right' },
    notice: { marginTop: SPACING.m, padding: SPACING.m, borderRadius: BORDER_RADIUS.m, backgroundColor: COLORS.secondaryMuted, borderWidth: 1, borderColor: COLORS.secondary },
    noticeText: { fontSize: 14, color: COLORS.text, fontWeight: '600', lineHeight: 20 },
    stage: { flexDirection: 'row', alignItems: 'center', paddingVertical: SPACING.s },
    stageDone: { color: COLORS.success, fontSize: 18, width: 20, textAlign: 'center' },
    stageText: { fontSize: 15, color: COLORS.text, marginLeft: SPACING.m, flex: 1 },
    bigCheck: { fontSize: 48, color: COLORS.success, textAlign: 'center', marginBottom: SPACING.s },
    spinner: { marginBottom: SPACING.m },
    txRow: { paddingVertical: SPACING.s },
    link: { fontSize: 14, color: COLORS.primaryLight, marginTop: 2 },
    button: { marginTop: SPACING.m, paddingVertical: SPACING.m, borderRadius: BORDER_RADIUS.m, alignItems: 'center' },
    buttonPrimary: { backgroundColor: COLORS.primary },
    buttonSecondary: { borderWidth: 1, borderColor: COLORS.borderLight },
    buttonText: { fontSize: 15, fontWeight: '600', color: COLORS.text },
    buttonTextPrimary: { color: COLORS.white },
});

export default ArchivePurchaseSheet;
