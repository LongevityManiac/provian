import { errorDisplayCopy } from '../../i18n/displayCopy';
import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Switch, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, SHADOWS, BORDER_RADIUS, GRADIENTS } from '../../constants/theme';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useWalletStore } from '../../store/walletStore';
import ProvenanceEnvelopeManager from '../../core/provenance/ProvenanceEnvelopeManager';
import KeyManager from '../../core/security/KeyManager';
import BackButton, { BACK_BUTTON_SIZE } from '../../components/BackButton';

const LockdownScreen = ({ navigation }: any) => {
    const { t } = useTranslation();
    const { isLockdownActive, setLockdown } = useWalletStore();
    const [processing, setProcessing] = useState(false);

    const toggleLockdown = async () => {
        setProcessing(true);
        try {
            const newState = !isLockdownActive;

            // Generate PE for this security event
            await ProvenanceEnvelopeManager.createEnvelope({
                actionType: 'recovery_action', // Using recovery type for security events
                intentText: newState ? 'ACTIVATE EMERGENCY LOCKDOWN' : 'DEACTIVATE EMERGENCY LOCKDOWN',
                assetSymbol: 'N/A',
                amount: '0',
                chainId: 0,
                riskScore: 0,
                riskCategory: 'low',
                policyDecision: 'allow',
            });

            setLockdown(newState);

            Alert.alert(
                newState ? t('lockdown.protectedTitle') : t('lockdown.liftedTitle'),
                newState
                    ? t('lockdown.protectedMsg')
                    : t('lockdown.liftedMsg')
            );

        } catch (error: any) {
            Alert.alert(t('common.errorTitle'), errorDisplayCopy(error.message));
        } finally {
            setProcessing(false);
        }
    };

    return (
        <SafeAreaView style={styles.container}>
            <LinearGradient
                colors={GRADIENTS.backgroundDiagonal}
                style={StyleSheet.absoluteFill}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
            />
            <View style={styles.header}>
                <BackButton onPress={() => navigation.goBack()} />
                <Text style={styles.headerTitle}>{t('lockdown.title')}</Text>
                <View style={{ width: BACK_BUTTON_SIZE }} />
            </View>

            <View style={styles.content}>
                <View style={[styles.statusCard, isLockdownActive ? styles.activeCard : styles.inactiveCard]}>
                    <Ionicons
                        name={isLockdownActive ? "lock-closed" : "shield-checkmark"}
                        size={64}
                        color={isLockdownActive ? COLORS.error : COLORS.success}
                    />
                    <Text style={[styles.statusTitle, { color: isLockdownActive ? COLORS.error : COLORS.success }]}>
                        {isLockdownActive ? t('lockdown.statusActive') : t('lockdown.statusInactive')}
                    </Text>
                    <Text style={styles.statusDesc}>{t('lockdown.description')}</Text>
                </View>

                <View style={styles.actionContainer}>
                    <Text style={styles.warningText}>{t('lockdown.warning')}</Text>

                    <TouchableOpacity
                        style={[styles.toggleButton, { backgroundColor: isLockdownActive ? COLORS.success : COLORS.error }]}
                        onPress={toggleLockdown}
                        disabled={processing}
                    >
                        <Text style={styles.buttonText}>
                            {isLockdownActive ? t('lockdown.deactivate') : t('lockdown.activate')}
                        </Text>
                    </TouchableOpacity>
                </View>
            </View>
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#0B0E14',
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: SPACING.m,
    },
    headerTitle: {
        fontSize: 22,
        fontWeight: 'bold',
        color: COLORS.chromeMuted,
        letterSpacing: 0.5,
    },
    content: {
        flex: 1,
        padding: SPACING.l,
        justifyContent: 'space-between',
    },
    statusCard: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        borderRadius: 22,
        borderWidth: 2,
        marginBottom: SPACING.xl,
        padding: SPACING.l,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.45,
        shadowRadius: 20,
        elevation: 12,
    },
    activeCard: {
        backgroundColor: 'rgba(242,85,90,0.10)',
        borderColor: '#F2555A',
        shadowColor: '#F2555A',
        shadowOpacity: 0.4,
        shadowRadius: 24,
    },
    inactiveCard: {
        backgroundColor: 'rgba(0,230,118,0.08)',
        borderColor: 'rgba(0,230,118,0.3)',
    },
    statusTitle: {
        fontSize: 24,
        fontWeight: 'bold',
        marginTop: SPACING.m,
        marginBottom: SPACING.s,
        textTransform: 'uppercase',
        letterSpacing: 2,
        textShadowColor: 'rgba(242,85,90,0.5)',
        textShadowOffset: { width: 0, height: 0 },
        textShadowRadius: 12,
    },
    statusDesc: {
        fontSize: 16,
        color: '#8B929E',
        textAlign: 'center',
        lineHeight: 24,
    },
    actionContainer: {
        marginBottom: SPACING.xl,
    },
    warningText: {
        color: '#8B929E',
        textAlign: 'center',
        marginBottom: SPACING.l,
        fontStyle: 'italic',
    },
    toggleButton: {
        paddingVertical: SPACING.l,
        borderRadius: 20,
        alignItems: 'center',
        shadowColor: '#F2555A',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.4,
        shadowRadius: 16,
        elevation: 10,
    },
    buttonText: {
        color: '#FFFFFF',
        fontSize: 18,
        fontWeight: 'bold',
        letterSpacing: 1,
        textShadowColor: 'rgba(0,0,0,0.4)',
        textShadowOffset: { width: 0, height: 1 },
        textShadowRadius: 4,
    },
});

export default LockdownScreen;
