import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { getRandomBytesAsync } from 'expo-crypto';
import { hexlify } from 'ethers';
import type { AppParamList } from '../../navigation/types';
import BackButton from '../../components/BackButton';
import { COLORS, SPACING, BORDER_RADIUS } from '../../constants/theme';
import { ownerChainNetwork } from '../../core/protocol/runtime';
import { TOKEN_ADDRESSES } from '../../core/chains/evm/config';
import { withBiometricAction, type BiometricAction } from '../../core/security/biometricAction';
import SeedManager from '../../core/wallet/SeedManager';
import { executeHumanHashTransfer, readHumanHashTransfer, type HumanHashTransfer } from '../../core/recourse/human-hash-transfer';
import { executeHumanCurveTransfer, readHumanCurveTransfer, type HumanCurveTransfer } from '../../core/recourse/human-curve-transfer';
import { describeHumanTransfer, prepareHumanTransferReview, type HumanTransferReview } from '../../core/recourse/human-transfer-review';
import ProvenanceEnvelopeManager from '../../core/provenance/ProvenanceEnvelopeManager';
import TransactionHistoryService from '../../core/history/TransactionHistoryService';

export default function RecoveredTransferScreen({ navigation, route }: NativeStackScreenProps<AppParamList, 'RecoveredTransfer'>): React.JSX.Element {
  const { t } = useTranslation(), { account, auxiliaryBinding } = route.params;
  const curve = route.params.kind === 'curve';
  const readTransfer = useCallback(() => curve ? readHumanCurveTransfer(account) : readHumanHashTransfer(account), [account, curve]);
  const [tokens, setTokens] = useState<readonly { symbol: string; address: string | null }[]>([]);
  const [token, setToken] = useState(route.params.symbol ?? 'PVT'), [recipient, setRecipient] = useState(route.params.recipient ?? ''), [amount, setAmount] = useState(route.params.amount ?? '');
  const [review, setReview] = useState<HumanTransferReview | null>(null), [held, setHeld] = useState<HumanHashTransfer | HumanCurveTransfer | null>(null);
  const [gasPayer, setGasPayer] = useState<string | null>(null), [busy, setBusy] = useState(true), [error, setError] = useState(false);
  const [recorded, setRecorded] = useState(false);
  const lock = useRef(false), alive = useRef(true);
  const load = useCallback(async () => {
    const network = ownerChainNetwork();
    // Unfinished sends are loaded before discovery so a network failure cannot
    // make an existing authorization look like an empty form.
    const saved = await readTransfer();
    if (saved && saved.intent.auxiliaryBinding !== auxiliaryBinding) throw Error('recourse_transfer_wrong_account');
    if (alive.current) setHeld(saved);
    if (saved) {
      const prior = await describeHumanTransfer(saved.intent, network);
      if (alive.current) setReview(prior);
    }
    const deployment = await network.deployment(), payer = curve ? account : await SeedManager.getBackupIdentityAddress();
    if (alive.current) {
      setGasPayer(payer); setTokens([{ symbol: 'ETH', address: null }, { symbol: 'PVT', address: deployment.addresses.kernel.toLowerCase() },
        ...Object.entries(TOKEN_ADDRESSES[8453]).map(([symbol, address]) => ({ symbol, address: address.toLowerCase() }))]);
    }
  }, [account, auxiliaryBinding, curve, readTransfer]);
  useEffect(() => { alive.current = true; lock.current = true; setBusy(true);
    void load().catch(() => { if (alive.current) setError(true); }).finally(() => { lock.current = false; if (alive.current) setBusy(false); });
    return () => { alive.current = false; };
  }, [load]);
  const run = async (fn: () => Promise<void>) => {
    if (lock.current) return; lock.current = true; setBusy(true); setError(false);
    try { await fn(); } catch { if (alive.current) setError(true); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  const record = async (current: HumanHashTransfer | HumanCurveTransfer, shown: HumanTransferReview, action: BiometricAction) => {
    if (current.result?.status !== 'complete' || current.result.outcome !== 'succeeded') return;
    const txHash = current.result.transactionHash;
    await ProvenanceEnvelopeManager.createConfirmedTransferEnvelope({ txHash, chainId: 8453, actorAddress: account,
      counterparty: shown.recipient, contract: shown.token ?? undefined, assetSymbol: shown.symbol, amount: shown.amount }, action);
    await TransactionHistoryService.addLocalTransaction({ hash: txHash, type: 'sent', status: 'confirmed', chain: 'Base',
      from: account, to: shown.recipient, amount: shown.amount, symbol: shown.symbol, timestamp: Date.now(), usdValue: 0 }, account);
    if (alive.current) setRecorded(true);
  };
  const deliver = async (cancel: boolean) => {
    if (!review) return;
    const shown = review;
    await withBiometricAction(t('recourse.transfer.authorize'), async action => {
      try {
        if (curve) { if (cancel) throw Error('recourse_transfer_invalid'); await executeHumanCurveTransfer(shown.intent, action); }
        else await executeHumanHashTransfer(shown.intent, action, cancel);
      }
      finally {
        const retained = await readTransfer();
        if (alive.current && retained?.intent.id === shown.intent.id) setHeld(retained);
      }
      const saved = await readTransfer();
      if (!saved || saved.intent.id !== shown.intent.id) throw Error('recourse_transfer_intent_changed');
      if (alive.current) setHeld(saved);
      await record(saved, shown, action);
    });
  };
  const button = (label: string, fn: () => Promise<void>) => <TouchableOpacity accessibilityRole="button" disabled={busy}
    onPress={() => { void run(fn); }} style={[styles.button, busy && styles.disabled]}><Text style={styles.buttonText}>{label}</Text></TouchableOpacity>;
  const complete = held?.result?.status === 'complete', succeeded = complete && held.result?.status === 'complete' && held.result.outcome === 'succeeded';
  return <SafeAreaView style={styles.screen}>
    <View style={styles.header}><BackButton onPress={() => navigation.goBack()} /><Text style={styles.title}>{t('recourse.transfer.title')}</Text></View>
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.body}>{t('recourse.transfer.network')}</Text><Text selectable style={styles.address}>{account}</Text>
      <Text style={styles.body}>{t(curve ? 'recourse.transfer.curveGas' : 'recourse.transfer.gas')}</Text><Text selectable style={styles.address}>{gasPayer}</Text>
      {busy ? <ActivityIndicator color={COLORS.primary} /> : null}
      {error ? <View><Text style={styles.body}>{t('recourse.error')}</Text>{button(t('recourse.refresh'), load)}</View> : null}
      {review ? <View style={styles.card}>
        <Text style={styles.title}>{review.amount} {review.symbol}</Text>
        <Text style={styles.body}>{t('recourse.transfer.to')}</Text><Text selectable style={styles.address}>{review.recipient}</Text>
        {review.token ? <><Text style={styles.body}>{t('recourse.transfer.token')}</Text><Text selectable style={styles.address}>{review.token}</Text></> : null}
        <Text style={styles.small}>{t('recourse.transfer.balance', { amount: review.balance, symbol: review.symbol })}</Text>
        {held?.result ? <><Text style={styles.body}>{t(`recourse.debit.${held.result.status === 'complete' ? held.result.outcome : held.result.status}`)}</Text>
          <Text selectable style={styles.address}>{held.result.transactionHash}</Text></> : null}
        {held?.cancelling && !complete ? <Text style={styles.body}>{t('recourse.transfer.cancelling')}</Text> : null}
        {!complete ? <>
          {button(t(held ? 'recourse.transfer.resume' : 'recourse.transfer.confirm'), () => deliver(false))}
          {held ? (curve ? null : button(t('recourse.transfer.cancel'), () => deliver(true))) : button(t('recourse.transfer.edit'), async () => { setReview(null); })}
        </> : <>
          {succeeded && !recorded ? <><Text style={styles.body}>{t('recourse.transfer.recordPending')}</Text>
            {button(t('recourse.transfer.record'), () => deliver(false))}</> : null}
          {(!succeeded || recorded) ? button(t('recourse.transfer.new'), async () => { setReview(null); setHeld(null); setRecorded(false); setAmount(''); setRecipient(''); }) : null}
        </>}
      </View> : !held && tokens.length ? <View style={styles.card}>
        <View style={styles.choices}>{tokens.map(item => <TouchableOpacity accessibilityRole="button" accessibilityState={{ selected: item.symbol === token }}
          disabled={busy} key={item.symbol} onPress={() => setToken(item.symbol)} style={[styles.choice, item.symbol === token && styles.selected]}>
          <Text style={styles.body}>{item.symbol}</Text></TouchableOpacity>)}</View>
        <TextInput style={styles.input} value={recipient} onChangeText={setRecipient} editable={!busy} autoCapitalize="none" autoCorrect={false}
          placeholder={t('recourse.transfer.to')} placeholderTextColor={COLORS.textSecondary} accessibilityLabel={t('recourse.transfer.to')} />
        <TextInput style={styles.input} value={amount} onChangeText={setAmount} editable={!busy} keyboardType="decimal-pad"
          placeholder={t('recourse.transfer.amount')} placeholderTextColor={COLORS.textSecondary} accessibilityLabel={t('recourse.transfer.amount')} />
        {button(t('recourse.transfer.review'), async () => {
          const chosen = tokens.find(item => item.symbol === token); if (!chosen) throw Error('recourse_transfer_token_missing');
          const form = { id: hexlify(await getRandomBytesAsync(32)), account, auxiliaryBinding, recipient: recipient.trim(), token: chosen.address, amount: amount.trim() };
          const prepared = await prepareHumanTransferReview(form, ownerChainNetwork());
          if (alive.current) { setReview(prepared); setRecorded(false); }
        })}
      </View> : null}
    </ScrollView>
  </SafeAreaView>;
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background }, header: { flexDirection: 'row', alignItems: 'center', gap: SPACING.m, padding: SPACING.m },
  content: { padding: SPACING.m, paddingBottom: SPACING.xxxl, gap: SPACING.l }, title: { color: COLORS.text, fontSize: 21, fontWeight: '600' },
  body: { color: COLORS.textSecondary, fontSize: 15, lineHeight: 23 }, small: { color: COLORS.textSecondary, fontSize: 13, lineHeight: 20 },
  address: { color: COLORS.text, fontSize: 12, lineHeight: 20 }, card: { padding: SPACING.l, backgroundColor: COLORS.surface, borderRadius: BORDER_RADIUS.l, gap: SPACING.m },
  button: { padding: SPACING.m, backgroundColor: COLORS.primary, borderRadius: BORDER_RADIUS.m, alignItems: 'center' },
  buttonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' }, disabled: { opacity: 0.5 },
  input: { color: COLORS.text, padding: SPACING.m, borderWidth: 1, borderColor: COLORS.border, borderRadius: BORDER_RADIUS.m },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.s }, choice: { padding: SPACING.s, borderWidth: 1, borderColor: COLORS.border, borderRadius: BORDER_RADIUS.m },
  selected: { borderColor: COLORS.primary },
});
