import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { AppParamList } from '../../navigation/types';
import BackButton from '../../components/BackButton';
import { COLORS, SPACING, BORDER_RADIUS } from '../../constants/theme';
import { pvtAmount, bindHumanPrimaryAddress, readRecourseView, readRecourseHistory, submitHumanRestorationRequest, withdrawHumanRestoration, recoverHumanBoundAddress, type RecourseView } from '../../core/recourse/service';
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
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
    if (!transferAccount) return () => { active = false; };
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
  }, [transferAccount, historyPage, historyRefresh]);
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true); setError(false);
    try {
      const chain = await readRecourseView();
      if (sequence !== loadSequence.current) return;
      setState(chain); setLoading(false);
      const history = await readRecourseHistory(chain);
      if (sequence === loadSequence.current) { setState(history); setHistoryPage(1); setHistoryRefresh(value => value + 1); }
    } catch { if (sequence === loadSequence.current) setError(true); }
    finally { if (sequence === loadSequence.current) setLoading(false); }
  }, []);
  useFocusEffect(useCallback(() => { void load(); return () => { ++loadSequence.current; }; }, [load]));
  const button = (label: string, onPress: () => void) => <TouchableOpacity accessibilityRole="button"
    disabled={busy || loading} onPress={onPress} style={[styles.button, (busy || loading) && styles.disabled]}>
    <Text style={styles.buttonText}>{label}</Text></TouchableOpacity>;
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
      setSelectedTransfer(null); await load();
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
  return <SafeAreaView style={styles.screen}>
    <View style={styles.header}><BackButton onPress={() => navigation.goBack()} /><Text style={styles.title}>{t('recourse.title', 'Recourse')}</Text></View>
    <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={loading} onRefresh={() => { void load(); }} />}>
      <Text style={styles.lead}>{t('recourse.intro', 'Protect the PVT you hold. Bind your addresses to an ownership record that survives a change of key; choose membership for theft recourse.')}</Text>
      <Text style={styles.body}>{t('recourse.pvtOnly')}</Text>
      <View style={styles.card}>
        <Text style={styles.small}>{t('recourse.exitRule', 'Contributions are nonrefundable and burned PVT cannot be recovered. An allocated restoration remains yours after you leave and can be withdrawn directly on-chain without the relay.')}</Text>
        <TextInput accessibilityLabel={t('recourse.allocationRequest', 'Restoration request ID')} placeholder={t('recourse.allocationRequest', 'Restoration request ID')}
          value={allocationRequest} onChangeText={setAllocationRequest} autoCapitalize="none" autoCorrect={false} editable={!busy}
          style={styles.input} placeholderTextColor={COLORS.textSecondary} />
        <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={() => { void withdraw(allocationRequest); }}
          style={[styles.button, busy && styles.disabled]}><Text style={styles.buttonText}>{t('recourse.withdrawAllocation', 'Withdraw allocated restoration')}</Text></TouchableOpacity>
      </View>
      {loading && !state ? <ActivityIndicator color={COLORS.primary} /> : null}
      {error ? <View style={styles.card}><Text style={styles.body}>{t('recourse.error', 'We could not confirm the latest state or complete that action. Refresh to check the chain before trying again.')}</Text>
        {button(t('recourse.refresh', 'Refresh'), () => { void load(); })}</View> : null}
      {state ? <>
        {state.historyState === 'unavailable' ? <Text style={styles.small}>{t('recourse.historyUnavailable', 'Address and request history is temporarily unavailable. Pool reserves and allocated restoration withdrawals remain available directly on-chain.')}</Text> : null}
        <View style={styles.card}>
          <Text style={styles.section}>{t('recourse.membership', 'Recourse Pool membership')}</Text>
          <Text style={styles.status}>{state.membershipState === 'unavailable' ? t('recourse.membershipUnavailable', 'Private membership status is temporarily unavailable. Refresh after pending actions finish.') : state.grace ? t('recourse.grace', 'Protected — in grace') : state.enrolled ? t('recourse.active', 'Protected') : t('recourse.inactive', 'Not enrolled')}</Text>
          <Text style={styles.body}>{t('recourse.monthly', 'Every month: burn {{burn}} PVT. Separately contribute {{percent}}% of gross earnings, or {{reserve}} PVT from PVT holdings in a month with no earnings.', {
            burn: pvtAmount(state.participationBurnAtomic), percent: state.earningsBps / 100, reserve: pvtAmount(state.noEarningsContributionAtomic),
          })}</Text>
          <Text style={styles.body}>{t('recourse.graceRule', 'A missed month has one calendar month of grace. Catch up within grace and nothing lapses. Afterward membership ends; rejoining protects from that day forward, never for a loss while lapsed. Rejoining first requires settling both unpaid protected months, with credit for amounts already paid; lapsed months are never charged.')}</Text>
          {state.membershipState === 'available' && state.unpaidAtomic !== '0' ? <Text style={styles.body}>{t('recourse.outstanding', 'Outstanding burn and contribution: {{amount}} PVT', { amount: pvtAmount(state.unpaidAtomic) })}</Text> : null}
          <Text style={styles.small}>{t('recourse.standing.consent', 'Approve once when joining. Monthly burns and contributions happen automatically within the amounts you approved, without opening the app, signing again or holding ETH. Leaving stops future debits. Higher amounts need fresh approval. Restoration is discretionary, with no contractual right to payment. Determinations are final. Provian Technologies is not a party, contributes nothing, holds nothing and promises nothing.')}</Text>
          {state.membershipState === 'available' ? state.enrolled ? <>
            {button(t('recourse.standing.payments', 'Automatic payments'), () => navigation.navigate('RecourseMonthly'))}
            {button(t('recourse.leave', 'Leave Recourse Pool'), () => { void leave(); })}
          </> : button(t('recourse.join', 'Join Recourse Pool'), () => navigation.navigate('RecourseMembership', { kind: 'join' })) : button(t('recourse.flow.resume', 'Continue unfinished action'), () => navigation.navigate('RecourseMembership', { kind: 'resume' }))}
        </View>
        <View style={styles.card}>
          <Text style={styles.section}>{t('recourse.addresses', 'Your bound addresses')}</Text>
          <Text style={styles.body}>{t('recourse.bindingInfo', 'One membership includes all bound PVT holdings, earned and received alike. Binding is your choice. The relay knows which wallets are yours and the public does not, the same as a bank. A recovery or restoration may publicly link an old address to its replacement. Links to your other addresses and your total holdings remain private. Cryptographic-break restoration is free for every bound owner, including nonmembers.')}</Text>
          {state.addresses.map(row => <View key={row.address}><Text selectable style={styles.address}>{row.address}</Text>
            {!row.confirmed ? <Text style={styles.small}>{t('recourse.bindingPending', 'Registration submitted; awaiting chain confirmation.')}</Text> : null}
            {row.confirmed && row.identity !== state.primaryIdentity
              ? <>{button(t('recourse.recoverAddress', 'Recover this wallet'), () => { void recoverAddress(row.identity); })}
                {button(t('recourse.transfer.open'), () => { void sendFromAddress(row.identity); })}</> : null}</View>)}
          {state.primaryIdentity === null ? button(t('recourse.bindPrimary'), () => { void bindPrimary(); }) : null}
          {button(t('recourse.bind', 'Bind an address you hold'), () => navigation.navigate('RecourseBind'))}
        </View>
        <View style={styles.card}>
          <Text style={styles.section}>{t('recourse.resources', 'Member-funded reserves')}</Text>
          <Text style={styles.body}>{t('recourse.available', 'Available for restoration: {{amount}} PVT', { amount: pvtAmount(state.reserveAtomic) })}</Text>
        </View>
        <View style={styles.card}>
          <Text style={styles.section}>{t('recourse.requests', 'Restoration requests')}</Text>
          <Text style={styles.body}>{t('recourse.rule', 'Reversal comes first, with both restoration authority and your independent recovery proof. PVT received in a witnessed exchange stays with its recipient. The pool restores the remainder, pro rata when underfunded. Every determination and outcome enters your own chain.')}</Text>
          <Text style={styles.small}>{t('recourse.transferPicker.explanation', 'Choose the transfer you did not make. The app supplies its transaction details and prepares recovery to a new wallet address. Review the transfer before authorizing your restoration request.')}</Text>
          <Text style={styles.body}>{t('recourse.selectRestorationWallet', 'Select the wallet that lost PVT')}</Text>
          {state.addresses.filter(row => row.confirmed).map(row => <TouchableOpacity key={row.address}
            accessibilityRole="radio" accessibilityState={{ checked: transferAccount === row.address }}
            disabled={busy || loading} onPress={() => setSelectedHistoryAddress(row.address)} style={styles.button}>
            <Text style={styles.buttonText}>{transferAccount === row.address ? '● ' : '○ '}{row.address}</Text>
          </TouchableOpacity>)}
          {transfersLoading ? <ActivityIndicator accessibilityLabel={t('recourse.transferPicker.loading', 'Loading your transfers')} color={COLORS.primary} /> : null}
          {transfersError ? <Text style={styles.body}>{t('recourse.transferPicker.unavailable', 'We could not load your transfers. Refresh and try again.')}</Text> : null}
          {!transfersLoading && !transfersError && transfers.length === 0 ? <Text style={styles.body}>{t('recourse.transferPicker.empty', 'No outgoing PVT transfers appear in this part of your history.')}</Text> : null}
          {transfers.map(transfer => <TouchableOpacity key={`${transfer.transactionHash}:${transfer.to}`} accessibilityRole="radio"
            accessibilityState={{ checked: selectedTransfer === transfer }} disabled={busy} onPress={() => setSelectedTransfer(transfer)}
            style={[styles.transfer, selectedTransfer === transfer && styles.selectedTransfer]}>
            <Text style={styles.body}>{transfer.amount} PVT</Text>
            <Text style={styles.small}>{new Date(transfer.timestamp).toLocaleString()}</Text>
            <Text style={styles.address}>{t('recourse.transferPicker.to', 'To {{address}}', { address: transfer.to })}</Text>
          </TouchableOpacity>)}
          {historyMore ? button(t('recourse.transferPicker.older', 'Show older transfers'), () => { if (!transfersLoading) setHistoryPage(page => page + 1); }) : null}
          {selectedTransfer ? <View style={styles.request}>
            <Text style={styles.section}>{t('recourse.transferPicker.review', 'Report this transfer')}</Text>
            <Text style={styles.body}>{t('recourse.transferPicker.confirm', 'I did not authorize this transfer of {{amount}} PVT.', { amount: selectedTransfer.amount })}</Text>
            <Text style={styles.small}>{t('recourse.transferPicker.recovery', 'Your recovery proof moves control to a replacement address. Reversal is attempted first; the pool determines restoration of any remaining loss.')}</Text>
            {button(t('recourse.submitRequest', 'Submit restoration request'), () => { void requestRestoration(); })}
          </View> : null}
          {state.requests.map(row => <View key={row.requestId} style={styles.request}><Text selectable style={styles.address}>{row.transactionHash}</Text>
            <Text style={styles.body}>{t(`recourse.requestStatus.${row.status}`, row.status.replace(/_/g, ' '))}</Text>
            <Text selectable style={styles.address}>{t('recourse.allocationRequest', 'Restoration request ID')}: {row.requestId}</Text>
            {button(t('recourse.withdrawAllocation', 'Withdraw allocated restoration'), () => { void withdraw(row.requestId, row.identity); })}</View>)}
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
  transfer: { padding: SPACING.m, borderRadius: BORDER_RADIUS.m, borderWidth: 1, borderColor: COLORS.textSecondary, gap: SPACING.s },
  selectedTransfer: { borderColor: COLORS.primary, borderWidth: 2 },
  disabled: { opacity: 0.5 }, request: { gap: SPACING.s, paddingVertical: SPACING.s },
});
