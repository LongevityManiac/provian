import React, { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { AppParamList } from '../../navigation/types';
import BackButton from '../../components/BackButton';
import { COLORS, SPACING, BORDER_RADIUS } from '../../constants/theme';
import { changeRecourseMembership, pvtAmount, readRecourseView, readRecourseHistory, submitHumanRestorationRequest, type RecourseView } from '../../core/recourse/service';
import { ExternalWalletProofFlow } from '../Agent/LinkExternalWalletScreen';

export function RecourseBindScreen(): React.JSX.Element {
  return <ExternalWalletProofFlow mode={{ kind: 'recourse' }} />;
}

export default function RecourseScreen({ navigation }: NativeStackScreenProps<AppParamList, 'Recourse'>): React.JSX.Element {
  const { t } = useTranslation();
  const loadSequence = useRef(0);
  const [state, setState] = useState<RecourseView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [lossTransaction, setLossTransaction] = useState('');
  const [lossBlock, setLossBlock] = useState('');
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true); setError(false);
    try {
      const chain = await readRecourseView();
      if (sequence !== loadSequence.current) return;
      setState(chain); setLoading(false);
      const history = await readRecourseHistory(chain);
      if (sequence === loadSequence.current) setState(history);
    } catch { if (sequence === loadSequence.current) setError(true); }
    finally { if (sequence === loadSequence.current) setLoading(false); }
  }, []);
  useFocusEffect(useCallback(() => { void load(); return () => { ++loadSequence.current; }; }, [load]));
  const act = async (operation: 'enroll' | 'leave' | 'settleMonth' | 'redeem') => {
    if (!state || busy) return;
    setBusy(true); setError(false);
    try { await changeRecourseMembership(operation, state.identity); await load(); }
    catch { setError(true); }
    finally { setBusy(false); }
  };
  const button = (label: string, onPress: () => void) => <TouchableOpacity accessibilityRole="button"
    disabled={busy || loading} onPress={onPress} style={[styles.button, (busy || loading) && styles.disabled]}>
    <Text style={styles.buttonText}>{label}</Text></TouchableOpacity>;
  const requestRestoration = async () => {
    if (busy) return;
    setBusy(true); setError(false);
    try {
      if (!/^[0-9]+$/.test(lossBlock.trim())) throw new Error('recourse_loss_block_invalid');
      await submitHumanRestorationRequest(lossTransaction.trim().toLowerCase(), Number(lossBlock));
      setLossTransaction(''); setLossBlock(''); await load();
    } catch { setError(true); }
    finally { setBusy(false); }
  };
  return <SafeAreaView style={styles.screen}>
    <View style={styles.header}><BackButton onPress={() => navigation.goBack()} /><Text style={styles.title}>{t('recourse.title', 'Recourse')}</Text></View>
    <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={loading} onRefresh={() => { void load(); }} />}>
      <Text style={styles.lead}>{t('recourse.intro', 'Protect the PVT you hold. Bind your addresses to an ownership record that survives a change of key; choose membership for theft recourse.')}</Text>
      {loading && !state ? <ActivityIndicator color={COLORS.primary} /> : null}
      {error ? <View style={styles.card}><Text style={styles.body}>{t('recourse.error', 'We could not confirm the latest state or complete that action. Refresh to check the chain before trying again.')}</Text>
        {button(t('recourse.refresh', 'Refresh'), () => { void load(); })}</View> : null}
      {state ? <>
        {state.historyState === 'unavailable' ? <Text style={styles.small}>{t('recourse.historyUnavailable', 'Address and request history is temporarily unavailable. Membership and reserve amounts are verified directly on-chain; you can still leave and redeem.')}</Text> : null}
        <View style={styles.card}>
          <Text style={styles.section}>{t('recourse.membership', 'Recourse Pool membership')}</Text>
          <Text style={styles.status}>{state.grace ? t('recourse.grace', 'Protected — in grace') : state.enrolled ? t('recourse.active', 'Protected') : t('recourse.inactive', 'Not enrolled')}</Text>
          <Text style={styles.body}>{t('recourse.monthly', 'Every month: burn {{burn}} PVT. Separately contribute {{percent}}% of gross earnings, or {{reserve}} PVT from holdings in a month with no earnings.', {
            burn: pvtAmount(state.participationBurnAtomic), percent: state.earningsBps / 100, reserve: pvtAmount(state.noEarningsContributionAtomic),
          })}</Text>
          <Text style={styles.body}>{t('recourse.graceRule', 'A missed month has one calendar month of grace. Catch up within grace and nothing lapses. Afterward membership ends; rejoining protects from that day forward, never for a loss while lapsed.')}</Text>
          {state.unpaidAtomic !== '0' ? <Text style={styles.body}>{t('recourse.outstanding', 'Outstanding burn and contribution: {{amount}} PVT', { amount: pvtAmount(state.unpaidAtomic) })}</Text> : null}
          <Text style={styles.small}>{t('recourse.consent', 'Membership authorizes the pool to collect its monthly obligations. All three amounts can change prospectively under the published signed rule. Restoration is discretionary, with no contractual right to payment. Determinations are final. Provian Technologies is not a party, contributes nothing, holds nothing and promises nothing.')}</Text>
          {state.enrolled ? <>
            {button(t('recourse.catchUp', 'Complete monthly obligations'), () => { void act('settleMonth'); })}
            {button(t('recourse.leave', 'Leave Recourse Pool'), () => { void act('leave'); })}
          </> : button(t('recourse.join', 'Join Recourse Pool'), () => { void act('enroll'); })}
        </View>
        <View style={styles.card}>
          <Text style={styles.section}>{t('recourse.addresses', 'Your bound addresses')}</Text>
          <Text style={styles.body}>{t('recourse.bindingInfo', 'One membership includes all bound holdings, earned and received alike. Binding is your choice and can reveal associations between public addresses. Cryptographic-break restoration is free for every bound owner, including nonmembers.')}</Text>
          {state.addresses.map(row => <View key={row.address}><Text selectable style={styles.address}>{row.address}</Text>
            {!row.confirmed ? <Text style={styles.small}>{t('recourse.bindingPending', 'Registration submitted; awaiting chain confirmation.')}</Text> : null}</View>)}
          {button(t('recourse.bind', 'Bind an address you hold'), () => navigation.navigate('RecourseBind'))}
        </View>
        <View style={styles.card}>
          <Text style={styles.section}>{t('recourse.resources', 'Member-funded reserves')}</Text>
          <Text style={styles.body}>{t('recourse.available', 'Available for restoration: {{amount}} PVT', { amount: pvtAmount(state.reserveAtomic) })}</Text>
          <Text style={styles.body}>{t('recourse.interest', 'Your remaining reserve interest: {{amount}} PVT', { amount: pvtAmount(state.redeemableAtomic) })}</Text>
          <Text style={styles.small}>{t('recourse.exitRule', 'Redemption ends this membership episode and returns your remaining proportionate reserve interest. Amounts already allocated to restoration stay allocated. Burned PVT cannot be redeemed. This exit works directly on-chain without the relay.')}</Text>
          {state.reserveShares !== '0' ? button(t('recourse.redeem', 'Leave and redeem reserve interest'), () => { void act('redeem'); }) : null}
        </View>
        <View style={styles.card}>
          <Text style={styles.section}>{t('recourse.requests', 'Restoration requests')}</Text>
          <Text style={styles.body}>{t('recourse.rule', 'Reversal comes first, with both restoration authority and your independent recovery proof. PVT received in a witnessed exchange stays with its recipient. The pool restores the remainder, pro rata when underfunded. Every determination and outcome enters your own chain.')}</Text>
          <Text style={styles.small}>{t('recourse.requestExplanation', 'Name the transaction that took your PVT and its Base block. Your recovery proof establishes a new wallet key; the relay checks the transaction and the witnessed exchange record before making a determination. Your original seed backup still restores your wallet.')}</Text>
          <TextInput accessibilityLabel={t('recourse.lossTransaction', 'Transaction hash')} placeholder={t('recourse.lossTransaction', 'Transaction hash')}
            value={lossTransaction} onChangeText={setLossTransaction} autoCapitalize="none" autoCorrect={false} editable={!busy}
            style={styles.input} placeholderTextColor={COLORS.textSecondary} />
          <TextInput accessibilityLabel={t('recourse.lossBlock', 'Base block number')} placeholder={t('recourse.lossBlock', 'Base block number')}
            value={lossBlock} onChangeText={setLossBlock} keyboardType="number-pad" editable={!busy}
            style={styles.input} placeholderTextColor={COLORS.textSecondary} />
          {button(t('recourse.submitRequest', 'Submit restoration request'), () => { void requestRestoration(); })}
          {state.requests.map(row => <View key={row.requestId} style={styles.request}><Text selectable style={styles.address}>{row.transactionHash}</Text>
            <Text style={styles.body}>{t(`recourse.requestStatus.${row.status}`, row.status.replace(/_/g, ' '))}</Text></View>)}
        </View>
      </> : null}
      {busy ? <ActivityIndicator color={COLORS.primary} /> : null}
    </ScrollView>
  </SafeAreaView>;
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background },
  header: { flexDirection: 'row', alignItems: 'center', padding: SPACING.m, gap: SPACING.m },
  title: { color: COLORS.text, fontSize: 26, fontWeight: '700' },
  content: { padding: SPACING.m, paddingBottom: SPACING.xxxl, gap: SPACING.l },
  lead: { color: COLORS.text, fontSize: 18, lineHeight: 27 },
  card: { padding: SPACING.l, borderRadius: BORDER_RADIUS.l, backgroundColor: COLORS.surface, gap: SPACING.m },
  section: { color: COLORS.text, fontSize: 20, fontWeight: '600' },
  status: { color: COLORS.primary, fontSize: 17, fontWeight: '600' },
  body: { color: COLORS.textSecondary, fontSize: 15, lineHeight: 23 },
  small: { color: COLORS.textSecondary, fontSize: 13, lineHeight: 20 },
  address: { color: COLORS.text, fontSize: 12, lineHeight: 20 },
  input: { color: COLORS.text, borderColor: COLORS.textSecondary, borderWidth: 1, borderRadius: BORDER_RADIUS.m, padding: SPACING.m },
  button: { backgroundColor: COLORS.primary, padding: SPACING.m, borderRadius: BORDER_RADIUS.m, alignItems: 'center' },
  buttonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
  disabled: { opacity: 0.5 }, request: { gap: SPACING.s, paddingVertical: SPACING.s },
});
