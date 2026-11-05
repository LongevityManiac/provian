import { useTranslation } from 'react-i18next';
import i18next from 'i18next';
import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING } from '../constants/theme';
import { TransactionWarning } from '../core/protection/UserProtectionManager';
import { useWalletStore } from '../store/walletStore';

interface WarningScreenProps {
    warning: TransactionWarning;
    onGoBack: () => void;
    onProceed?: () => void;
    requiresCheckbox?: boolean; // For high/critical warnings
}

const WarningScreen: React.FC<WarningScreenProps> = ({ warning, onGoBack, onProceed, requiresCheckbox }) => {
    useTranslation();
    const [acknowledged, setAcknowledged] = useState(false);
    const needsCheckbox = requiresCheckbox || (warning.severity === 'high' || warning.severity === 'critical');
    const isHardBlock = !warning.canProceed;
    const incrementBlockCount = useWalletStore((s) => s.incrementBlockCount);

    // Track blocked actions
    useEffect(() => {
        if (isHardBlock) {
            incrementBlockCount();
        }
    }, [isHardBlock]);

    const getSeverityColor = () => {
        switch (warning.severity) {
            case 'critical': return COLORS.error;
            case 'high': return '#E8A838';
            case 'medium': return '#E8A838';
            case 'low': return '#4A8EE8';
        }
    };

    const getSeverityIcon = (): keyof typeof Ionicons.glyphMap => {
        switch (warning.severity) {
            case 'critical': return 'close-circle';
            case 'high': return 'warning';
            case 'medium': return 'alert-circle';
            case 'low': return 'information-circle';
        }
    };

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                {isHardBlock ? (
                    <>
                        <View style={[styles.iconContainer, { backgroundColor: 'rgba(0,230,118,0.14)' }]}>
                            <Ionicons name="shield-checkmark" size={56} color="#4CC38A" />
                        </View>
                        <Text style={[styles.title, { color: '#4CC38A' }]}>{i18next.t('ui.warning.protected')}</Text>
                        <Text style={styles.blockSubtitle}>{warning.title}</Text>
                    </>
                ) : (
                    <>
                        <View style={[styles.iconContainer, { backgroundColor: `${getSeverityColor()}18` }]}>
                            <Ionicons name={getSeverityIcon()} size={56} color={getSeverityColor()} />
                        </View>
                        <Text style={styles.title}>{warning.title}</Text>
                    </>
                )}
            </View>

            <ScrollView style={styles.content} contentContainerStyle={styles.contentContainer}>
                {/* Plain English Explanation */}
                <View style={styles.section}>
                    <View style={styles.sectionHeader}>
                        <Ionicons name="chatbubble-ellipses" size={20} color={COLORS.text} />
                        <Text style={styles.sectionTitle}>{i18next.t('ui.warning.explanation')}</Text>
                    </View>
                    <Text style={styles.bodyText}>{warning.plainEnglish}</Text>
                </View>

                {/* Consequences */}
                <View style={[styles.section, styles.dangerSection]}>
                    <View style={styles.sectionHeader}>
                        <Ionicons name="alert-circle" size={20} color={COLORS.error} />
                        <Text style={[styles.sectionTitle, { color: COLORS.error }]}>{i18next.t('ui.warning.consequences')}</Text>
                    </View>
                    <Text style={styles.bodyText}>{warning.consequences}</Text>
                </View>

                {/* Recommendation */}
                <View style={[styles.section, styles.recommendSection]}>
                    <View style={styles.sectionHeader}>
                        <Ionicons name="checkmark-circle" size={20} color="#4CC38A" />
                        <Text style={[styles.sectionTitle, { color: '#4CC38A' }]}>{i18next.t('ui.warning.recommendation')}</Text>
                    </View>
                    <Text style={styles.bodyText}>{warning.recommendation}</Text>
                </View>

                {/* Educational Note */}
                <View style={styles.educationalBox}>
                    <View style={styles.educationalIconWrap}>
                        <Ionicons name={isHardBlock ? 'shield-checkmark' : 'school'} size={16} color={isHardBlock ? '#4CC38A' : '#4A8EE8'} />
                    </View>
                    <Text style={styles.educationalText}>
                        {isHardBlock
                            ? i18next.t('ui.warning.blockedNote')
                            : i18next.t('ui.warning.warningNote')}
                    </Text>
                </View>

                {/* Acknowledgment Checkbox for high/critical warnings */}
                {warning.canProceed && needsCheckbox && (
                    <TouchableOpacity
                        style={styles.checkboxRow}
                        onPress={() => setAcknowledged(!acknowledged)}
                        activeOpacity={0.7}
                    >
                        <View style={[styles.checkbox, acknowledged && styles.checkboxChecked]}>
                            {acknowledged && <Ionicons name="checkmark" size={16} color="#0B0E14" />}
                        </View>
                        <Text style={styles.checkboxLabel}>
                            {i18next.t('ui.warning.acknowledge')}</Text>
                    </TouchableOpacity>
                )}
            </ScrollView>

            {/* Action Buttons */}
            <View style={styles.footer}>
                <TouchableOpacity
                    style={[styles.button, styles.buttonPrimary]}
                    onPress={onGoBack}
                >
                    <Ionicons name="arrow-back" size={20} color="#0B0E14" />
                    <Text style={styles.buttonText}>
                        {i18next.t('common.goBack')}</Text>
                </TouchableOpacity>

                {warning.canProceed && onProceed && (
                    <TouchableOpacity
                        style={[
                            styles.button,
                            styles.buttonDanger,
                            needsCheckbox && !acknowledged && styles.buttonDisabled
                        ]}
                        onPress={onProceed}
                        disabled={needsCheckbox && !acknowledged}
                    >
                        <Ionicons name="warning" size={20} color={needsCheckbox && !acknowledged ? '#9CA3AF' : '#0B0E14'} />
                        <Text style={[
                            styles.buttonTextDanger,
                            needsCheckbox && !acknowledged && styles.buttonTextDisabled
                        ]}>
                            {needsCheckbox && !acknowledged ? i18next.t('ui.warning.acknowledgeFirst') : i18next.t('ui.warning.acceptRisk')}
                        </Text>
                    </TouchableOpacity>
                )}
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#0B0E14',
    },
    header: {
        alignItems: 'center',
        paddingTop: SPACING.xl,
        paddingHorizontal: SPACING.l,
        paddingBottom: SPACING.l,
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(200,205,214,0.08)',
    },
    iconContainer: {
        width: 112,
        height: 112,
        borderRadius: 32,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: SPACING.m,
    },
    title: {
        fontSize: 22,
        fontWeight: '700',
        color: COLORS.text,
        textAlign: 'center',
    },
    blockSubtitle: {
        fontSize: 14,
        color: '#8B929E',
        textAlign: 'center',
        marginTop: SPACING.xs,
    },
    content: {
        flex: 1,
    },
    contentContainer: {
        padding: SPACING.l,
    },
    section: {
        marginBottom: SPACING.l,
        backgroundColor: 'rgba(18,21,26,0.70)',
        padding: SPACING.m,
        borderRadius: 18,
        borderLeftWidth: 3,
        borderLeftColor: '#4A8EE8',
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
    },
    dangerSection: {
        backgroundColor: 'rgba(255,71,87,0.06)',
        borderLeftColor: COLORS.error,
        borderColor: 'rgba(255,71,87,0.15)',
    },
    recommendSection: {
        backgroundColor: 'rgba(0,230,118,0.06)',
        borderLeftColor: '#4CC38A',
        borderColor: 'rgba(0,230,118,0.15)',
    },
    sectionHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
        marginBottom: SPACING.s,
    },
    sectionTitle: {
        fontSize: 15,
        fontWeight: '700',
        color: COLORS.text,
    },
    bodyText: {
        fontSize: 14,
        color: COLORS.chromeMuted,
        lineHeight: 22,
    },
    educationalBox: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: SPACING.s,
        backgroundColor: 'rgba(74,142,232,0.06)',
        padding: SPACING.m,
        borderRadius: 14,
        marginTop: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(74,142,232,0.12)',
    },
    educationalIconWrap: {
        width: 28,
        height: 28,
        borderRadius: 8,
        backgroundColor: 'rgba(74,142,232,0.14)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    educationalText: {
        flex: 1,
        fontSize: 12,
        color: '#8B929E',
        lineHeight: 18,
        fontStyle: 'italic',
    },

    footer: {
        padding: SPACING.l,
        gap: SPACING.m,
        borderTopWidth: 1,
        borderTopColor: 'rgba(200,205,214,0.08)',
    },
    button: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: SPACING.m,
        borderRadius: 28,
        gap: SPACING.s,
    },
    buttonPrimary: {
        backgroundColor: '#4A8EE8',
        shadowColor: '#4A8EE8',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 16,
        elevation: 8,
    },
    buttonDanger: {
        backgroundColor: COLORS.error,
        shadowColor: COLORS.error,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 12,
        elevation: 6,
    },
    buttonText: {
        color: '#0B0E14',
        fontSize: 16,
        fontWeight: '700',
    },
    buttonTextDanger: {
        color: '#0B0E14',
        fontSize: 14,
        fontWeight: '600',
    },
    buttonDisabled: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        opacity: 0.6,
        shadowOpacity: 0,
    },
    buttonTextDisabled: {
        color: '#9CA3AF',
    },
    checkboxRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.m,
        marginTop: SPACING.xl,
        padding: SPACING.m,
        backgroundColor: 'rgba(255,71,87,0.06)',
        borderRadius: 18,
        borderWidth: 1,
        borderColor: 'rgba(255,71,87,0.25)',
    },
    checkbox: {
        width: 24,
        height: 24,
        borderRadius: 6,
        borderWidth: 2,
        borderColor: COLORS.error,
        alignItems: 'center',
        justifyContent: 'center',
    },
    checkboxChecked: {
        backgroundColor: COLORS.error,
    },
    checkboxLabel: {
        flex: 1,
        fontSize: 14,
        color: COLORS.text,
        fontWeight: '500',
    },
});

export default WarningScreen;
