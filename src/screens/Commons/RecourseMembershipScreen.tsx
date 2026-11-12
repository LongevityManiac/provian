import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { SessionTypes } from '@walletconnect/types';
import QRCode from 'react-native-qrcode-svg';
import { hexlify } from 'ethers';
import BackButton from '../../components/BackButton';
import { COLORS, SPACING, BORDER_RADIUS } from '../../constants/theme';
import type { AppParamList } from '../../navigation/types';
import { useWalletStore } from '../../store/walletStore';
import { beginHumanMembership, readHumanMembershipTransition, authorizeHumanMembershipConsent,
  authorizeExternalMembershipConsent, leaveHumanMembership } from '../../core/recourse/human-membership';
import { pvtAmount } from '../../core/recourse/service';
import type { MembershipConsentChallenge, MembershipTransitionView } from '../../core/recourse/membership-client';
import { externalWalletProofClient, accountFromSession, EXTERNAL_WALLET_APPS,
  isExternalWalletConnectConfigured, type ExternalWalletApp } from '../../core/walletconnect/ExternalWalletProofClient';

export default function RecourseMembershipScreen({ navigation, route }: NativeStackScreenProps<AppParamList, 'RecourseMembership'>): React.JSX.Element {
  const { t } = useTranslation();
  const account = useWalletStore(s => s.address)?.toLowerCase();
  const [view, setView] = useState<MembershipTransitionView | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const [selected, setSelected] = useState<MembershipConsentChallenge | null>(null);
  const [uri, setUri] = useState('');
  const active = useRef(true), operationId = useRef<string | undefined>(undefined), session = useRef<SessionTypes.Struct | null>(null);
  const walletApp = useRef<ExternalWalletApp | null>(null), sequence = useRef(0);
  const load = useCallback(async () => {
    const run = ++sequence.current;
    setLoading(true); setError(false);
    try {
      let current = await readHumanMembershipTransition(operationId.current);
      if (route.params.kind === 'leave' && current && current.kind !== 'leave') current = await beginHumanMembership('leave');
      if (!current && route.params.kind !== 'resume') current = await beginHumanMembership(route.params.kind);
      if (!active.current || run !== sequence.current) return;
      operationId.current = current?.id; setView(current); setSelected(null);
    } catch { if (active.current && run === sequence.current) setError(true); }
    finally { if (active.current && run === sequence.current) setLoading(false); }
  }, [route.params.kind]);
  useEffect(() => {
    active.current = true; void load();
    return () => { active.current = false; ++sequence.current; void externalWalletProofClient.disconnect(session.current); };
  }, [load]);
  useEffect(() => {
    if (!view || busy || (!view.pending.length && view.status !== 'preparing')) return;
    const timer=setTimeout(()=>{void load();},3000);return()=>clearTimeout(timer);
  },[view,busy,load]);
  const run = async (work: () => Promise<unknown>) => {
    if (busy || loading) return;
    setBusy(true); setError(false);
    try { await work(); if (active.current) await load(); }
    catch { if (active.current) setError(true); }
    finally { if (active.current) { setBusy(false); setUri(''); } }
  };
  const button = (label: string, press: () => void, disabled = busy || loading) => <TouchableOpacity accessibilityRole="button"
    onPress={press} disabled={disabled} style={[styles.button, disabled && styles.disabled]}><Text style={styles.buttonText}>{label}</Text></TouchableOpacity>;
  const connect = async () => {
    if (!view || !selected) return;
    const challenge = selected, transition = view;
    const connection = await externalWalletProofClient.connect();
    if (!active.current) return;
    setUri(connection.uri);
    const approved = await connection.approval(); session.current = approved;
    try {
      if (!active.current) return;
      const external = accountFromSession(approved.namespaces);
      if (!external || external.address !== challenge.consent.account) throw Error('recourse_membership_wrong_wallet');
      await authorizeExternalMembershipConsent(transition, challenge, async bytes => {
        const pending = externalWalletProofClient.requestPersonalSignBytes(approved, external, hexlify(bytes));
        // Observe rejection immediately while returning to the external signer.
        void pending.catch(() => undefined);
        if (walletApp.current) await Linking.openURL(walletApp.current.open);
        return pending;
      });
    } finally { await externalWalletProofClient.disconnect(approved); session.current = null; }
  };
  return <SafeAreaView style={styles.screen}>
    <View style={styles.header}><BackButton onPress={() => navigation.goBack()} /><Text style={styles.title}>{t('recourse.flow.title', 'Your membership')}</Text></View>
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.body}>{t('recourse.standing.explain', 'Approve membership once. Monthly payments then happen automatically, even while the app is closed. You need no ETH to join, pay or leave. Higher amounts require your fresh approval.')}</Text>
      {loading || busy ? <ActivityIndicator color={COLORS.primary} /> : null}
      {error ? <Text style={styles.body}>{t('recourse.error')}</Text> : null}
      {view ? <>
        <Text style={styles.title}>{view.kind === 'renew' ? t('recourse.standing.review','Review new amounts') : view.kind === 'join' ? t('recourse.join') : t('recourse.leave')}</Text>
        <Text style={styles.body}>{t(`recourse.flow.${view.status}`, view.status)}</Text>
        {view.pending.map(pending => <View style={styles.card} key={pending.operation.id}>
          <Text selectable style={styles.address}>{pending.account}</Text>
          <Text style={styles.body}>{t('recourse.flow.pending', 'Authorization submitted. Refresh to check its confirmation.')}</Text>
          {pending.operation.transactionHash ? <Text selectable style={styles.address}>{pending.operation.transactionHash}</Text> : null}
        </View>)}
        {view.kind === 'leave' && view.status !== 'complete' && view.status !== 'superseded' ? button(t('recourse.leave', 'Leave Recourse Pool'), () => { void run(() => leaveHumanMembership(view)); }) : null}
        {view.kind !== 'leave' ? view.challenges.map(challenge => <View key={challenge.consent.binding} style={styles.card}>
          <Text selectable style={styles.address}>{challenge.consent.account}</Text>
          <Text style={styles.body}>{challenge.consent.joined ? t('recourse.flow.enable', 'Include this wallet') : t('recourse.flow.disable', 'End this wallet’s participation')}</Text>
          <Text style={styles.body}>{t('recourse.standing.limits', 'Maximum each month: {{burn}} PVT burned and {{reserve}} PVT contributed from this wallet’s holdings. Earnings contribution: {{percent}}%.', {burn:pvtAmount(challenge.burnLimit),reserve:pvtAmount(challenge.reserveLimit),percent:challenge.earningsBpsLimit/100})}</Text>
          {button(t('recourse.authorize'), () => { void run(() => authorizeHumanMembershipConsent(view, challenge)); })}
          {challenge.consent.account !== account ? button(t('recourse.flow.external', 'Authorize in this wallet'), () => { setSelected(challenge); setError(false); }) : null}
        </View>) : null}
        {view.status === 'complete' ? button(t('recourse.flow.done', 'Return to Recourse'), () => navigation.goBack()) : null}
        {view.status === 'superseded' && route.params.kind !== 'resume' ? button(t('recourse.flow.restart', 'Continue with the current contracts'), () => {
          operationId.current = undefined; void load();
        }) : null}
      </> : !loading ? <Text style={styles.body}>{t('recourse.flow.none', 'No unfinished membership action.')}</Text> : null}
      {selected ? <View style={styles.card}>
        <Text selectable style={styles.address}>{selected.consent.account}</Text>
        <Text style={styles.body}>{t('recourse.standing.external', 'Connect this wallet to approve its membership once. Later payments and leaving require no further wallet prompts.')}</Text>
        {isExternalWalletConnectConfigured() ? button(t('recourse.flow.connect', 'Connect the external wallet'), () => { void run(connect); }) : null}
        {uri ? <>
          <View style={styles.qr}><QRCode value={uri} size={200} /></View>
          {EXTERNAL_WALLET_APPS.map(app => <React.Fragment key={app.id}>{button(app.label, () => {
            walletApp.current = app; void Linking.openURL(app.connect(uri)).catch(() => setError(true));
          }, false)}</React.Fragment>)}
        </> : null}
      </View> : null}
      {button(t('recourse.refresh'), () => { void load(); })}
    </ScrollView>
  </SafeAreaView>;
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background }, header: { flexDirection: 'row', alignItems: 'center', gap: SPACING.m, padding: SPACING.m },
  content: { padding: SPACING.m, paddingBottom: SPACING.xxxl, gap: SPACING.l }, title: { color: COLORS.text, fontSize: 22, fontWeight: '600' },
  body: { color: COLORS.textSecondary, fontSize: 15, lineHeight: 23 }, address: { color: COLORS.text, fontSize: 12, lineHeight: 20 },
  card: { padding: SPACING.l, backgroundColor: COLORS.surface, borderRadius: BORDER_RADIUS.l, gap: SPACING.m },
  button: { padding: SPACING.m, backgroundColor: COLORS.primary, borderRadius: BORDER_RADIUS.m, alignItems: 'center' },
  buttonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' }, disabled: { opacity: 0.5 },
  input: { color: COLORS.text, borderWidth: 1, borderColor: COLORS.textSecondary, borderRadius: BORDER_RADIUS.m, padding: SPACING.m },
  qr: { padding: SPACING.m, backgroundColor: '#FFFFFF', alignSelf: 'center' },
});
