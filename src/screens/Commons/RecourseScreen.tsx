import { ActionTouchable } from '../../components/ScreenActions';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView, initialWindowMetrics } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { AppParamList } from '../../navigation/types';
import { RecourseMembershipSummary } from './RecourseMembershipSummary';
import BackButton from '../../components/BackButton';
import { COLORS, SPACING, BORDER_RADIUS } from '../../constants/theme';
import { pvtAmount, bindHumanPrimaryAddress, readRecourseOverview, readRecourseView, readRecourseHistory, submitHumanRestorationRequest, withdrawHumanRestoration, recoverHumanBoundAddress, type RecourseView } from '../../core/recourse/service';
import { beginHumanMembership, leaveHumanMembership } from '../../core/recourse/human-membership';
import { withBiometricAction } from '../../core/security/biometricAction';
import SeedManager from '../../core/wallet/SeedManager';
import TransactionHistoryService from '../../core/history/TransactionHistoryService';
import { theftTransferChoices, verifyTheftTransfer, type TheftTransfer } from '../../core/recourse/theft-transfer-history';
import { ownerChainNetwork } from '../../core/protocol/runtime';
import { discoverBoundHumanSpendingAccount } from '../../core/recourse/human-bound-spending';
import { ExternalWalletProofFlow } from '../Agent/LinkExternalWalletScreen';

export function RecourseBindScreen(): React.JSX.Element {
  return <ExternalWalletProofFlow mode={{ kind: 'recourse' }} />;
}

export default function RecourseScreen({ navigation }: NativeStackScreenProps<AppParamList, 'Recourse'>): React.JSX.Element {
  const { t } = useTranslation();
  const loadSequence = useRef(0);
  const [state, setState] = useState<RecourseView | null>(null);
  const [loading, setLoading] = useState(true);
  const [membershipUnavailable, setMembershipUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportSubmitted, setReportSubmitted] = useState(false);
  const [transfers, setTransfers] = useState<readonly TheftTransfer[]>([]);
  const [selectedTransfer, setSelectedTransfer] = useState<TheftTransfer | null>(null);
  const [transfersLoading, setTransfersLoading] = useState(false);
  const [transfersError, setTransfersError] = useState(false);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyMore, setHistoryMore] = useState(false);
  const [allocationRequest, setAllocationRequest] = useState('');
  const [selectedHistoryAddress, setSelectedHistoryAddress] = useState<string | undefined>();
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const historyWallet = state?.addresses.find(row => row.confirmed && row.address === selectedHistoryAddress)
    ?? state?.addresses.find(row => row.confirmed && row.identity === state.identity);
  const transferAccount = historyWallet?.address;
  useEffect(() => { setHistoryPage(1); setSelectedTransfer(null); setTransfers([]); }, [transferAccount]);
  useEffect(() => {
    let active = true;
    if (!reportOpen || !transferAccount) return () => { active = false; };
    setTransfersLoading(true); setTransfersError(false);
    void (async () => {
      try {
        const deployment = await ownerChainNetwork().deployment();
        const page = await TransactionHistoryService.getTransactions(transferAccount, { chains: ['Base'], page: historyPage, limit: 50 });
        const rows = theftTransferChoices(page.items, transferAccount, deployment.addresses.kernel);
        if (active) { setTransfers(previous => historyPage === 1 ? rows : [...previous, ...rows]); setHistoryMore(page.hasMore); }
      } catch { if (active) setTransfersError(true); }
      finally { if (active) setTransfersLoading(false); }
    })();
    return () => { active = false; };
  }, [reportOpen, transferAccount, historyPage, historyRefresh]);
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true); setError(false); setMembershipUnavailable(false);
    const overview = await readRecourseOverview().catch(() => null);
    if (sequence !== loadSequence.current) return;
    setState(overview); setLoading(false); setMembershipUnavailable(overview === null);
    // Chain data remains useful during an outage, but it cannot answer the
    // membership question. Keep the retry visible while this read runs.
    const display = overview ?? await readRecourseView(undefined, true).catch(() => null);
    if (display && sequence === loadSequence.current) {
      setState(display);
      const history = await readRecourseHistory(display);
      if (sequence !== loadSequence.current) return;
      setState(history); setHistoryPage(1); setHistoryRefresh(value => value + 1);
    }
  }, []);
  useFocusEffect(useCallback(() => { void load(); return () => { ++loadSequence.current; }; }, [load]));
  const button = (label: string, onPress: () => void) => <ActionTouchable accessibilityRole="button"
    disabled={busy || loading} onPress={onPress} style={[styles.button, (busy || loading) && styles.disabled]}>
    <Text style={styles.buttonText}>{label}</Text></ActionTouchable>;
  const bindPrimary = async () => {
    if (busy || loading) return;
    setBusy(true); setError(false);
    try { await bindHumanPrimaryAddress(); await load(); }
    catch { setError(true); }
    finally { setBusy(false); }
  };
  const leave = async () => {
    if (busy || loading) return;
    setBusy(true); setError(false);
    try {
      const view = await beginHumanMembership('leave');
      await leaveHumanMembership(view);
      navigation.navigate('RecourseMembership', { kind: 'resume' });
    } catch { setError(true); }
    finally { setBusy(false); }
  };
  const requestRestoration = async () => {
    if (busy) return;
    setBusy(true); setError(false);
    try {
      if (!selectedTransfer || !transferAccount) throw Error('recourse_select_transfer');
      const verified = await verifyTheftTransfer(selectedTransfer, transferAccount, ownerChainNetwork());
      await submitHumanRestorationRequest(verified.transactionHash, verified.block, historyWallet?.identity);
      setSelectedTransfer(null); setReportOpen(false); setReportSubmitted(true); await load();
    } catch { setError(true); }
    finally { setBusy(false); }
  };
  const withdraw = async (request: string, identity?: string) => {
    if (busy) return;
    setBusy(true); setError(false);
    try { await withdrawHumanRestoration(identity, request.trim().toLowerCase()); setAllocationRequest(''); await load(); }
    catch { setError(true); }
    finally { setBusy(false); }
  };
  const recoverAddress = async (identity: string) => {
    if (busy) return;
    setBusy(true); setError(false);
    try { await recoverHumanBoundAddress(identity); await load(); }
    catch { setError(true); }
    finally { setBusy(false); }
  };
  const sendFromAddress = async (identity: string) => {
    if (busy) return;
    setBusy(true); setError(false);
    try {
      const bound = await withBiometricAction(t('recourse.transfer.authorize'), async action => {
        const mnemonic = await SeedManager.getMnemonic(action);
        if (!mnemonic) throw Error('recourse_seed_unavailable');
        return discoverBoundHumanSpendingAccount(mnemonic, identity, ownerChainNetwork());
      });
      navigation.navigate('RecoveredTransfer', { account: bound.account, auxiliaryBinding: identity, kind: bound.kind });
    } catch { setError(true); }
    finally { setBusy(false); }
  };
  const requestStatus = (row: RecourseView['requests'][number]): string => {
    const status = row.allocation ? row.allocation.amountAtomic === '0' ? 'zero_allocation' : row.allocation.withdrawn ? 'delivered' : 'allocated' : row.status;
    return t(`recourse.requestStatus.${status}`, { defaultValue: t('recourse.requestStatus.unknown') });
  };
  return <SafeAreaView style={styles.screen}>
    <View style={styles.header}><BackButton onPress={() => navigation.goBack()} /><Text style={styles.title}>{t('recourse.title')}</Text></View>
    <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={loading} onRefresh={() => { void load(); }} />}>
      <Text style={styles.lead}>{t('recourse.intro')}</Text>
      <Text style={styles.small}>{t('recourse.pvtOnly')}</Text>
      {loading && !state ? <ActivityIndicator color={COLORS.primary} /> : null}
      {membershipUnavailable && !state ? <View style={styles.card}>
        <Text accessibilityRole="alert" style={styles.body}>{t('recourse.membershipUnavailable')}</Text>
        {button(t('recourse.refresh'), () => { void load(); })}</View> : null}
      {error ? <View style={styles.card}><Text style={styles.body}>{t('recourse.error')}</Text>
        {button(t('recourse.refresh'), () => { void load(); })}</View> : null}
      {state ? <>
        {!loading && state.historyState === 'unavailable'
          ? <Text accessibilityRole="alert" style={styles.body}>{t('recourse.historyUnavailable')}</Text> : null}
        <View style={styles.card}>
          <RecourseMembershipSummary view={state} pending={loading} />
          {state.membershipState === 'available' ? state.enrolled ? <>
            {button(t('recourse.standing.payments'), () => navigation.navigate('RecourseMonthly'))}
            {button(t('recourse.leave'), () => { void leave(); })}
          </> : /^0x0+$/.test(state.identity)
            ? button(t('recourse.bindPrimary'), () => { void bindPrimary(); })
            : button(state.membershipDetails?.status === 'lapsed' ? t('recourse.rejoin.amount', { amount: pvtAmount(state.unpaidAtomic) }) : t('recourse.join'), () => navigation.navigate('RecourseMembership', { kind: 'join' }))
            : button(t('recourse.refresh'), () => { void load(); })}
          <Text style={styles.small}>{t('recourse.graceSummary')}</Text>
          {state.membershipState === 'unavailable' ? button(t('recourse.flow.resume'), () => navigation.navigate('RecourseMembership', { kind: 'resume' })) : null}
        </View>
        {button(t('recourse.reportTheft'), () => { setHistoryPage(1); setSelectedTransfer(null); setTransfers([]); setHistoryMore(false); setReportOpen(true); setReportSubmitted(false); })}
        {reportSubmitted ? <Text accessibilityRole="alert" style={styles.body}>{t('recourse.afterReport')}</Text> : null}
        <View style={styles.card}>
          <Text style={styles.section}>{t('recourse.addresses')}</Text>
          <Text style={styles.body}>{t('recourse.bindingInfo')}</Text>
          {state.addresses.length === 0 && state.historyState === 'available' ? <Text style={styles.body}>{t('recourse.emptyWallets')}</Text> : null}
          {state.historyState !== 'available' && state.primaryIdentity && state.currentAddress
            ? <Text selectable style={styles.address}>{state.currentAddress}</Text> : null}
          {state.addresses.map(row => <View key={row.address}><Text selectable style={styles.address}>{row.address}</Text>
            {!row.confirmed ? <Text style={styles.small}>{t('recourse.bindingPending')}</Text> : null}
            {row.confirmed && row.identity !== state.primaryIdentity
              ? <>{button(t('recourse.recoverAddress'), () => { void recoverAddress(row.identity); })}
                {button(t('recourse.transfer.open'), () => { void sendFromAddress(row.identity); })}</> : null}</View>)}
          {state.primaryIdentity === null && (state.membershipState !== 'available' || !/^0x0+$/.test(state.identity))
            ? button(t('recourse.bindPrimary'), () => { void bindPrimary(); }) : null}
          {button(t('recourse.bind'), () => navigation.navigate('RecourseBind'))}
        </View>
        <View style={styles.card}>
          <Text style={styles.section}>{t('recourse.resources')}</Text>
          <Text style={styles.body}>{t('recourse.available', { amount: pvtAmount(state.reserveAtomic) })}</Text>
        </View>
        <View style={styles.card}>
          <Text style={styles.section}>{t('recourse.requests')}</Text>
          {state.historyState === 'available' && state.requests.length === 0 ? <Text style={styles.body}>{t('recourse.emptyRequests')}</Text> : null}
          {state.requests.map(row => <View key={row.requestId} style={styles.request}>
            <Text style={styles.body}>{requestStatus(row)}</Text>
            {row.breakdown ? <>
              <Text style={styles.body}>{t('recourse.breakdown.reversed', { amount: pvtAmount(row.breakdown.reversedAtomic) })}</Text>
              <Text style={styles.body}>{t('recourse.breakdown.pool', { amount: pvtAmount(row.breakdown.poolAtomic) })}</Text>
              <Text style={styles.body}>{t('recourse.breakdown.total', { amount: pvtAmount(row.breakdown.totalAtomic) })}</Text>
            </> : row.allocation || row.status === 'restored' ? <Text style={styles.body}>{t('recourse.breakdown.unavailable')}</Text> : null}
            {row.allocation && !row.allocation.withdrawn && BigInt(row.allocation.amountAtomic) > 0n
              ? button(t('recourse.withdrawAllocation'), () => { void withdraw(row.requestId, row.identity); }) : null}
          </View>)}
        </View>
      </> : null}
      <View style={styles.card}>
        <Text style={styles.section}>{t('recourse.finePrint')}</Text>
        <Text style={styles.small}>{t('recourse.restorationLegal')}</Text>
        <Text style={styles.small}>{t('recourse.standing.approvalTerms')}</Text>
        <Text style={styles.small}>{t('recourse.rule')}</Text>
        <Text style={styles.small}>{t('recourse.bindingDetails')}</Text>
        <Text style={styles.small}>{t('recourse.exitRule')}</Text>
        {state?.requests.map(row => <Text key={row.requestId} selectable style={styles.address}>{t('recourse.allocationRequest')}: {row.requestId}</Text>)}
      </View>
      <View style={styles.card}>
        <Text style={styles.small}>{t('recourse.fallback')}</Text>
        <TextInput accessibilityLabel={t('recourse.allocationRequest')} placeholder={t('recourse.allocationRequest')}
          value={allocationRequest} onChangeText={setAllocationRequest} autoCapitalize="none" autoCorrect={false} editable={!busy}
          style={styles.input} placeholderTextColor={COLORS.textSecondary} />
        <ActionTouchable accessibilityRole="button" disabled={busy} onPress={() => { void withdraw(allocationRequest); }}
          style={[styles.button, busy && styles.disabled]}><Text style={styles.buttonText}>{t('recourse.withdrawAllocation')}</Text></ActionTouchable>
      </View>
      {busy ? <ActivityIndicator color={COLORS.primary} /> : null}
    </ScrollView>
    <Modal visible={reportOpen} animationType="slide" onRequestClose={() => { if (!busy) setReportOpen(false); }}>
      <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <SafeAreaView style={styles.screen}>
        <View style={styles.header}><Text style={styles.title}>{t('recourse.reportTheft')}</Text></View>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.small}>{t('recourse.pvtOnly')}</Text>
          {state ? <>
          <Text style={styles.small}>{t('recourse.transferPicker.explanation', 'Choose the transfer you did not make. The app supplies its transaction details and prepares recovery to a new wallet address. Review the transfer before authorizing your restoration request.')}</Text>
          <Text style={styles.body}>{t('recourse.selectRestorationWallet', 'Select the wallet that lost PVT')}</Text>
          {state.addresses.filter(row => row.confirmed).map(row => <ActionTouchable key={row.address}
            accessibilityRole="radio" accessibilityState={{ checked: transferAccount === row.address }}
            disabled={busy || loading} onPress={() => setSelectedHistoryAddress(row.address)} style={styles.button}>
            <Text style={styles.buttonText}>{transferAccount === row.address ? '● ' : '○ '}{row.address}</Text>
          </ActionTouchable>)}
          {transfersLoading ? <ActivityIndicator accessibilityLabel={t('recourse.transferPicker.loading', 'Loading your transfers')} color={COLORS.primary} /> : null}
          {transfersError ? <Text style={styles.body}>{t('recourse.transferPicker.unavailable', 'We could not load your transfers. Refresh and try again.')}</Text> : null}
          {!transfersLoading && !transfersError && transfers.length === 0 ? <Text style={styles.body}>{t('recourse.transferPicker.empty', 'No outgoing PVT transfers appear in this part of your history.')}</Text> : null}
          {transfers.map(transfer => <ActionTouchable key={`${transfer.transactionHash}:${transfer.to}`} accessibilityRole="radio"
            accessibilityState={{ checked: selectedTransfer === transfer }} disabled={busy} onPress={() => setSelectedTransfer(transfer)}
            style={[styles.transfer, selectedTransfer === transfer && styles.selectedTransfer]}>
            <Text style={styles.body}>{transfer.amount} PVT</Text>
            <Text style={styles.small}>{new Date(transfer.timestamp).toLocaleString()}</Text>
            <Text style={styles.address}>{t('recourse.transferPicker.to', 'To {{address}}', { address: transfer.to })}</Text>
          </ActionTouchable>)}
          {historyMore ? button(t('recourse.transferPicker.older', 'Show older transfers'), () => { if (!transfersLoading) setHistoryPage(page => page + 1); }) : null}
          {selectedTransfer ? <View style={styles.request}>
            <Text style={styles.section}>{t('recourse.transferPicker.review', 'Report this transfer')}</Text>
            <Text style={styles.body}>{t('recourse.transferPicker.confirm', 'I did not authorize this transfer of {{amount}} PVT.', { amount: selectedTransfer.amount })}</Text>
            <Text style={styles.small}>{t('recourse.transferPicker.recovery', 'Your recovery proof moves control to a replacement address. Reversal is attempted first; the pool determines restoration of any remaining loss.')}</Text>
            {button(t('recourse.submitRequest', 'Submit restoration request'), () => { void requestRestoration(); })}
          </View> : null}
          </> : null}
          {error ? <Text style={styles.body}>{t('recourse.error')}</Text> : null}
          {busy ? <ActivityIndicator color={COLORS.primary} /> : null}
          {button(t('recourse.closeReport'), () => setReportOpen(false))}
        </ScrollView>
      </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
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
  buttonText: { color: COLORS.onPrimary, fontSize: 15, fontWeight: '600' },
  transfer: { padding: SPACING.m, borderRadius: BORDER_RADIUS.m, borderWidth: 1, borderColor: COLORS.textSecondary, gap: SPACING.s },
  selectedTransfer: { borderColor: COLORS.primary, borderWidth: 2 },
  disabled: { opacity: 0.5 }, request: { gap: SPACING.s, paddingVertical: SPACING.s },
});
