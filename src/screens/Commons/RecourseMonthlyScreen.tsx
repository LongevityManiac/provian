import React, { useCallback, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import type { AppParamList } from '../../navigation/types';
import BackButton from '../../components/BackButton';
import { COLORS, SPACING, BORDER_RADIUS } from '../../constants/theme';
import { pvtAmount, readRecourseView, type RecourseView } from '../../core/recourse/service';
import { readStandingMembershipState } from '../../core/recourse/standing-state';
import { ownerChainNetwork } from '../../core/protocol/runtime';
import type { StandingMembershipMandate } from '../../core/recourse/membership-authorization';

export default function RecourseMonthlyScreen({navigation}:NativeStackScreenProps<AppParamList,'RecourseMonthly'>):React.JSX.Element{
  const {t}=useTranslation();
  const [view,setView]=useState<RecourseView|null>(null),[mandate,setMandate]=useState<StandingMembershipMandate|null>(null);
  const [loading,setLoading]=useState(true),[error,setError]=useState(false);
  const load=useCallback(async()=>{
    setLoading(true);setError(false);setView(null);setMandate(null);
    try{const next=await readRecourseView();const standing=await readStandingMembershipState(next.primaryIdentity??next.identity,ownerChainNetwork());
      setView(next);setMandate(standing.mandate);
    }catch{setError(true);}finally{setLoading(false);}
  },[]);
  useFocusEffect(useCallback(()=>{void load();},[load]));
  const changed=view&&mandate&&(!mandate.active||BigInt(view.participationBurnAtomic)>BigInt(mandate.burnLimit)
    ||BigInt(view.noEarningsContributionAtomic)>BigInt(mandate.reserveLimit)||view.earningsBps>mandate.earningsBpsLimit);
  return <SafeAreaView style={styles.screen}>
    <View style={styles.header}><BackButton onPress={()=>navigation.goBack()}/><Text style={styles.title}>{t('recourse.standing.payments','Automatic payments')}</Text></View>
    <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={loading} onRefresh={()=>{void load();}}/>}>
      <Text style={styles.body}>{t('recourse.pvtOnly')}</Text>
      {loading?<ActivityIndicator color={COLORS.primary}/>:null}
      {error?<Text style={styles.body}>{t('recourse.error')}</Text>:null}
      {view&&mandate?<>
        <View style={styles.card}>
          <Text style={styles.title}>{view.membershipState!=='available'?t('recourse.membershipUnavailable'):!view.enrolled?t('recourse.inactive'):changed?t('recourse.standing.approvalNeeded','Approval needed'):t('recourse.standing.enabled','Automatic payments approved')}</Text>
          <Text style={styles.body}>{view.membershipState==='available'&&!view.enrolled&&view.unpaidAtomic!=='0'?t('recourse.rejoin.explain'):t('recourse.standing.background','The relay pays the network fee. Your monthly burn and contribution from PVT holdings do not need you to open the app, sign again or keep ETH.')}</Text>
          <Text style={styles.body}>{t('recourse.standing.limits','Maximum each month: {{burn}} PVT burned and {{reserve}} PVT contributed from this wallet’s PVT holdings. Earnings contribution: {{percent}}%.',{
            burn:pvtAmount(mandate.burnLimit),reserve:pvtAmount(mandate.reserveLimit),percent:mandate.earningsBpsLimit/100})}</Text>
          <Text style={styles.body}>{t('recourse.standing.noEarnings','The contribution from PVT holdings applies only to a completed month with no issuance. The earnings contribution is taken automatically at settlement.')}</Text>
          {view.membershipState==='available'?<Text style={styles.body}>{view.unpaidAtomic==='0'?t('recourse.standing.current','Your recorded obligations are up to date.'):
            !view.enrolled?t('recourse.outstanding',{amount:pvtAmount(view.unpaidAtomic)}):t('recourse.standing.pendingAmount','{{amount}} PVT is awaiting automatic collection. Keep enough PVT in your payment wallet.',{amount:pvtAmount(view.unpaidAtomic)})}</Text>:null}
          <Text style={styles.body}>{t('recourse.graceRule')}</Text>
        </View>
        {view.membershipState==='available'&&!view.enrolled?<TouchableOpacity accessibilityRole="button" style={styles.button} onPress={()=>navigation.navigate('RecourseMembership',{kind:'join'})}>
          <Text style={styles.buttonText}>{t('recourse.join')}</Text>
        </TouchableOpacity>:null}
        {view.membershipState==='available'&&view.enrolled&&changed?<View style={styles.card}>
          <Text style={styles.body}>{t('recourse.standing.increase','The current rule requires a new approval. No higher amount can be debited under your previous approval.')}</Text>
          <TouchableOpacity accessibilityRole="button" style={styles.button} onPress={()=>navigation.navigate('RecourseMembership',{kind:'renew'})}>
            <Text style={styles.buttonText}>{t('recourse.standing.review','Review new amounts')}</Text>
          </TouchableOpacity>
        </View>:null}
        <Text style={styles.body}>{t('recourse.standing.leave','Leaving ends future debits. Contributions already paid are nonrefundable; allocated restorations remain withdrawable.')}</Text>
      </>:null}
    </ScrollView>
  </SafeAreaView>;
}
const styles=StyleSheet.create({screen:{flex:1,backgroundColor:COLORS.background},header:{flexDirection:'row',alignItems:'center',gap:SPACING.m,padding:SPACING.m},
  content:{padding:SPACING.m,gap:SPACING.l},title:{fontSize:22,fontWeight:'600',color:COLORS.text},body:{fontSize:15,lineHeight:23,color:COLORS.textSecondary},
  card:{padding:SPACING.l,borderRadius:BORDER_RADIUS.l,backgroundColor:COLORS.surface,gap:SPACING.m},button:{padding:SPACING.m,borderRadius:BORDER_RADIUS.m,backgroundColor:COLORS.primary},
  buttonText:{color:'#FFFFFF',fontSize:15,fontWeight:'600',textAlign:'center'}});
