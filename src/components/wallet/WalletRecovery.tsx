import { errorDisplayCopy } from '../../i18n/displayCopy';
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ethers } from 'ethers';
import TransactionService from '../../core/wallet/TransactionService';
import WalletConnectService from '../../core/walletconnect/WalletConnectService';
import { decodeTransactionCall } from '../../core/walletconnect/decodeCalldata';
import type { RecoverableWalletTransaction } from '../../core/security/ActionWallet';
import { useWalletStore } from '../../store/walletStore';
import { COLORS, SPACING } from '../../constants/theme';

/** Recovery is a separate review of saved bytes; another send never triggers it. */
export default function WalletRecovery({ openConnectedAppReview }: { openConnectedAppReview: () => void }): React.JSX.Element | null {
    const { t } = useTranslation();
    const address = useWalletStore(state => state.address);
    const [rows, setRows] = useState<RecoverableWalletTransaction[]>([]);
    const [failed, setFailed] = useState(false);
    const [busy, setBusy] = useState(false);
    const refresh = useCallback(async () => {
        if (!address) return;
        try { setRows(await TransactionService.listRecoveryTransactions(address)); setFailed(false); }
        catch { setFailed(true); }
    }, [address]);
    useEffect(() => { void refresh(); }, [refresh]);
    const recover = (saved: RecoverableWalletTransaction): void => {
        const decoded = decodeTransactionCall(saved.to, saved.data, saved.chainId);
        const detail = `${decoded.amountFormatted ?? ''} ${decoded.tokenSymbol ?? ''} ${decoded.counterparty ?? ''}`.trim();
        Alert.alert(t('walletRecovery.title'), t('walletRecovery.review', {
            chain: saved.chainId, to: saved.to, amount: ethers.formatEther(saved.value),
            fee: ethers.formatEther(saved.maxFeeWei), hash: saved.hash,
            data: `${detail}\n${saved.data.length <= 2000 ? saved.data : `${saved.data.slice(0, 2000)}…\n${ethers.keccak256(saved.data)}`}`,
        }), [
            { text: t('common.cancel'), style: 'cancel' },
            { text: t('walletRecovery.recover'), onPress: () => {
                if (saved.operationId.startsWith('wc_')) {
                    WalletConnectService.queueTransactionRecovery(saved);
                    openConnectedAppReview();
                    return;
                }
                setBusy(true);
                void TransactionService.recoverTransaction(saved)
                    .then(() => refresh())
                    .catch(error => Alert.alert(t('common.errorTitle'), errorDisplayCopy(error instanceof Error ? error.message : t('common.error'))))
                    .finally(() => setBusy(false));
            } },
        ]);
    };
    if (!rows.length && !failed) return null;
    return <View style={{ padding: SPACING.m }}>
        <Text style={{ color: COLORS.warning }}>{t('walletRecovery.title')}</Text>
        {failed && <TouchableOpacity onPress={() => void refresh()}><Text style={{ color: COLORS.warning }}>{t('walletRecovery.unavailable')}</Text></TouchableOpacity>}
        {rows.map(saved => <TouchableOpacity key={saved.operationId} disabled={busy} onPress={() => recover(saved)} style={{ paddingVertical: SPACING.s }}>
            <Text style={{ color: COLORS.primary }}>{t('walletRecovery.recover')} · {saved.hash.slice(0, 12)}…</Text>
        </TouchableOpacity>)}
    </View>;
}
