import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import { actionStyles, DestinationRow } from '../../components/ScreenActions';
import TokenIcon from '../../components/TokenIcon';
import { COLORS, SPACING } from '../../constants/theme';
import { isTestnet } from '../../core/shared/environment';
import { homeAssets, individualAssetKey } from '../../core/wallet/homeAssets';
import { cachedPvtAsset } from '../../core/wallet/pvtBalanceDisplay';
import type { AppParamList } from '../../navigation/types';
import { useWalletStore } from '../../store/walletStore';
import { displayBalance } from '../../utils/displayBalance';
import { assetUsdValue, formatUsd, priceAgeLabel } from '../../utils/fiatDisplay';

export default function AssetDetailScreen({ navigation, route }: NativeStackScreenProps<AppParamList, 'AssetDetail'>) {
    const { t } = useTranslation();
    const assets = useWalletStore(state => state.assets);
    const address = useWalletStore(state => state.address);
    const lastPvt = useWalletStore(state => state.lastConfirmedPvt);
    const pvtStatus = useWalletStore(state => state.pvtBalanceStatus);
    const mainnet = !isTestnet();
    const asset = homeAssets(assets, cachedPvtAsset(lastPvt, address, mainnet), mainnet)
        .find(row => row.key === route.params.assetKey);
    const holdings = asset?.holdings ?? assets.filter(holding => individualAssetKey(holding) === route.params.assetKey);
    const symbol = asset?.symbol ?? route.params.symbol;
    const name = holdings[0]?.name;

    return <SafeAreaView style={styles.screen}>
        <ScrollView contentContainerStyle={styles.content}>
            <View style={styles.header}>
                <BackButton onPress={() => navigation.goBack()} />
                <Text accessibilityRole="header" style={actionStyles.sectionTitle}>{symbol}</Text>
            </View>
            <View style={styles.asset}>
                <TokenIcon symbol={symbol} size={44} />
                {name && name !== symbol && <Text style={actionStyles.body}>{name}</Text>}
            </View>
            {holdings.length ? holdings.map(holding => {
                const detail = holding.isPVT
                    ? pvtStatus === 'outdated' ? t('dashboard.balanceOutdated') : undefined
                    : [formatUsd(assetUsdValue(holding)), priceAgeLabel(holding, t)].filter(Boolean).join(' · ');
                return <DestinationRow key={individualAssetKey(holding)}
                    label={holding.chain} detail={detail}
                    end={<Text style={[styles.balance, actionStyles.money]}>{displayBalance(holding.balance)} {symbol}</Text>} />;
            }) : <Text style={actionStyles.body}>{t('overhaul.assetBalanceUnavailable')}</Text>}
        </ScrollView>
    </SafeAreaView>;
}

const styles = StyleSheet.create({
    screen: { flex: 1, backgroundColor: COLORS.background },
    content: { padding: SPACING.l, gap: SPACING.m },
    header: { flexDirection: 'row', alignItems: 'center', gap: SPACING.s },
    asset: { flexDirection: 'row', alignItems: 'center', gap: SPACING.s, marginVertical: SPACING.s },
    balance: { color: COLORS.text, fontSize: 16, fontWeight: '600', maxWidth: '62%', textAlign: 'right' },
});
