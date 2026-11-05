import React, { useState, useEffect, useCallback } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    ScrollView,
    TextInput,
    Alert,
    KeyboardAvoidingView,
    Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS, GRADIENTS } from '../../constants/theme';
import AddressHistoryService, { Contact, SendHistoryItem, ChainType } from '../../core/protection/AddressHistoryService';
import type { ContactDetailScreenProps } from '../../navigation/types';
import BackButton from '../../components/BackButton';

const ContactDetailScreen = ({ navigation, route }: ContactDetailScreenProps) => {
    const { t } = useTranslation();
    const initialContact = route.params.contact;

    const [contact, setContact] = useState<Contact>(initialContact);
    const [sendHistory, setSendHistory] = useState<SendHistoryItem[]>([]);
    const [isEditingName, setIsEditingName] = useState(false);
    const [editedName, setEditedName] = useState(initialContact.name);
    const [loading, setLoading] = useState(true);

    const loadData = useCallback(async () => {
        try {
            const [updatedContact, history] = await Promise.all([
                AddressHistoryService.getContact(initialContact.address),
                AddressHistoryService.getSendHistoryForAddress(initialContact.address),
            ]);

            if (updatedContact) {
                // Merge with history stats
                const addressHistory = await AddressHistoryService.getAddressHistory(initialContact.address);
                setContact({
                    ...updatedContact,
                    lastSentAt: addressHistory?.lastSentAt,
                    sendCount: addressHistory?.sendCount || 0,
                    totalSentUsd: addressHistory?.totalAmountUsd || 0,
                });
            }
            setSendHistory(history);
        } catch (error) {
            console.error('[ContactDetailScreen] Failed to load:', error);
        } finally {
            setLoading(false);
        }
    }, [initialContact.address]);

    useEffect(() => {
        loadData();
    }, [loadData]);

    const handleToggleFavorite = async () => {
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        const newStatus = await AddressHistoryService.toggleFavorite(contact.address);
        setContact(prev => ({ ...prev, isFavorite: newStatus }));
    };

    const handleDeleteContact = () => {
        Alert.alert(
            t('contacts.deleteContact'),
            t('contacts.deleteContactConfirm', { name: contact.name }),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('common.delete'),
                    style: 'destructive',
                    onPress: async () => {
                        await AddressHistoryService.deleteContact(contact.address);
                        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                        navigation.goBack();
                    },
                },
            ]
        );
    };

    const handleSaveName = async () => {
        if (!editedName.trim()) {
            Alert.alert(t('common.errorTitle'), t('contacts.nameEmpty'));
            return;
        }

        await AddressHistoryService.updateContact(contact.address, { name: editedName.trim() });
        setContact(prev => ({ ...prev, name: editedName.trim() }));
        setIsEditingName(false);
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    };

    const handleCopyAddress = async (address: string) => {
        await Clipboard.setStringAsync(address);
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        Alert.alert(t('common.copied'), t('contacts.addressCopied'));
    };

    const handleSendMoney = () => {
        navigation.navigate('Send', {
            prefillAddress: contact.address,
            prefillChain: contact.chain,
            prefillName: contact.name,
        });
    };

    const formatAddress = (address: string): string => {
        if (address.length <= 20) return address;
        return `${address.slice(0, 10)}...${address.slice(-8)}`;
    };

    const formatDate = (timestamp: number): string => {
        const date = new Date(timestamp);
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    };

    const formatUsd = (amount: number): string => {
        // no recorded USD (price unknown at send time) is " ", never $0.
        if (!Number.isFinite(amount) || amount <= 0) return '—';
        if (amount < 1) return '<$1';
        return `$${amount.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
    };

    const totalSent = contact.totalSentUsd || sendHistory.reduce((sum, item) => sum + item.amountUsd, 0);

    return (
        <SafeAreaView style={styles.container}>
            <LinearGradient
                colors={GRADIENTS.backgroundDiagonal}
                style={StyleSheet.absoluteFill}
            />
            <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>

            {/* Header */}
            <View style={styles.header}>
                <BackButton onPress={() => navigation.goBack()} />
                <View style={styles.headerActions}>
                    <TouchableOpacity
                        style={styles.headerButton}
                        onPress={handleToggleFavorite}
                    >
                        <Ionicons
                            name={contact.isFavorite ? 'star' : 'star-outline'}
                            size={24}
                            color={contact.isFavorite ? '#E8A838' : '#8B929E'}
                        />
                    </TouchableOpacity>
                    <TouchableOpacity
                        style={styles.headerButton}
                        onPress={handleDeleteContact}
                    >
                        <Ionicons name="trash" size={24} color="#F2555A" />
                    </TouchableOpacity>
                </View>
            </View>

            <ScrollView contentContainerStyle={styles.content}>
                {/* Profile Section */}
                <View style={styles.profileSection}>
                    <View style={[styles.avatar, contact.isFavorite && styles.avatarFavorite]}>
                        <Text style={styles.avatarText}>
                            {contact.name.charAt(0).toUpperCase()}
                        </Text>
                    </View>

                    {isEditingName ? (
                        <View style={styles.editNameContainer}>
                            <TextInput
                                style={styles.editNameInput}
                                value={editedName}
                                onChangeText={setEditedName}
                                autoFocus
                                selectTextOnFocus
                            />
                            <View style={styles.editNameActions}>
                                <TouchableOpacity
                                    style={styles.editNameButton}
                                    onPress={() => {
                                        setEditedName(contact.name);
                                        setIsEditingName(false);
                                    }}
                                >
                                    <Text style={styles.editNameCancel}>{t('common.cancel')}</Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={[styles.editNameButton, styles.editNameSaveButton]}
                                    onPress={handleSaveName}
                                >
                                    <Text style={styles.editNameSave}>{t('common.save')}</Text>
                                </TouchableOpacity>
                            </View>
                        </View>
                    ) : (
                        <TouchableOpacity
                            style={styles.nameContainer}
                            onPress={() => setIsEditingName(true)}
                        >
                            <Text style={styles.profileName}>{contact.name}</Text>
                            <Ionicons name="pencil" size={16} color="#8B929E" />
                        </TouchableOpacity>
                    )}
                </View>

                {/* Address Section */}
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>{t('contactDetail.addressSection')}</Text>
                    <View style={styles.addressCard}>
                        <View style={styles.addressInfo}>
                            <Text style={styles.addressChain}>
                                {AddressHistoryService.getChainDisplayName(contact.chain)}
                                {contact.additionalAddresses?.length === 0 && ' (Primary)'}
                            </Text>
                            <Text style={styles.addressText}>{formatAddress(contact.address)}</Text>
                        </View>
                        <TouchableOpacity
                            style={styles.copyButton}
                            onPress={() => handleCopyAddress(contact.address)}
                        >
                            <Ionicons name="copy-outline" size={20} color="#4A8EE8" />
                        </TouchableOpacity>
                    </View>

                    {/* Additional addresses */}
                    {contact.additionalAddresses?.map((addr, index) => (
                        <View key={index} style={styles.addressCard}>
                            <View style={styles.addressInfo}>
                                <Text style={styles.addressChain}>
                                    {AddressHistoryService.getChainDisplayName(addr.chain)}
                                </Text>
                                <Text style={styles.addressText}>{formatAddress(addr.address)}</Text>
                            </View>
                            <TouchableOpacity
                                style={styles.copyButton}
                                onPress={() => handleCopyAddress(addr.address)}
                            >
                                <Ionicons name="copy-outline" size={20} color="#4A8EE8" />
                            </TouchableOpacity>
                        </View>
                    ))}
                </View>

                {/* Stats Section */}
                <View style={styles.statsRow}>
                    <View style={styles.statCard}>
                        <Text style={styles.statValue}>{formatUsd(totalSent)}</Text>
                        <Text style={styles.statLabel}>{t('contactDetail.totalSent')}</Text>
                    </View>
                    <View style={styles.statCard}>
                        <Text style={styles.statValue}>{contact.sendCount || 0}</Text>
                        <Text style={styles.statLabel}>{t('contactDetail.transactions')}</Text>
                    </View>
                    <View style={styles.statCard}>
                        <Text style={styles.statValue}>
                            {contact.lastSentAt
                                ? AddressHistoryService.formatRelativeTime(contact.lastSentAt)
                                : t('contactDetail.never')}
                        </Text>
                        <Text style={styles.statLabel}>{t('contactDetail.lastSent')}</Text>
                    </View>
                </View>

                {/* History Section */}
                {sendHistory.length > 0 && (
                    <View style={styles.section}>
                        <Text style={styles.sectionTitle}>{t('contactDetail.historySection')}</Text>
                        {sendHistory.slice(0, 10).map((item) => (
                            <View key={item.id} style={styles.historyItem}>
                                <View style={styles.historyIcon}>
                                    <Ionicons name="arrow-up" size={16} color="#4A8EE8" />
                                </View>
                                <View style={styles.historyInfo}>
                                    <Text style={styles.historyAmount}>
                                        {t('contactDetail.sentAmount', { amount: formatUsd(item.amountUsd), asset: item.asset })}
                                    </Text>
                                    <Text style={styles.historyDate}>{formatDate(item.timestamp)}</Text>
                                </View>
                            </View>
                        ))}
                    </View>
                )}

                {/* Send Button */}
                <TouchableOpacity style={styles.sendButton} onPress={handleSendMoney}>
                    <Ionicons name="arrow-up" size={20} color="white" />
                    <Text style={styles.sendButtonText}>{t('contactDetail.sendMoney')}</Text>
                </TouchableOpacity>
            </ScrollView>
            </KeyboardAvoidingView>
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
    headerActions: {
        flexDirection: 'row',
        gap: SPACING.s,
    },
    headerButton: {
        width: 44,
        height: 44,
        borderRadius: 22,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
    },
    content: {
        padding: SPACING.l,
        paddingBottom: SPACING.xl * 2,
    },
    profileSection: {
        alignItems: 'center',
        marginBottom: SPACING.xl,
    },
    avatar: {
        width: 80,
        height: 80,
        borderRadius: 40,
        backgroundColor: 'rgba(18,21,26,0.70)',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: SPACING.m,
        borderWidth: 2,
        borderColor: 'rgba(74,142,232,0.4)',
        shadowColor: '#4A8EE8',
        shadowOpacity: 0.4,
        shadowRadius: 10,
        shadowOffset: { width: 0, height: 0 },
    },
    avatarFavorite: {
        borderColor: '#E8A838',
        backgroundColor: 'rgba(255, 179, 0, 0.08)',
        shadowColor: '#E8A838',
    },
    avatarText: {
        fontSize: 32,
        fontWeight: 'bold',
        color: '#4A8EE8',
    },
    nameContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
    },
    profileName: {
        fontSize: 24,
        fontWeight: 'bold',
        color: COLORS.chromeMuted,
    },
    editNameContainer: {
        width: '100%',
        alignItems: 'center',
    },
    editNameInput: {
        fontSize: 24,
        fontWeight: 'bold',
        color: COLORS.text,
        textAlign: 'center',
        borderBottomWidth: 2,
        borderBottomColor: '#4A8EE8',
        paddingBottom: SPACING.xs,
        minWidth: 150,
    },
    editNameActions: {
        flexDirection: 'row',
        gap: SPACING.m,
        marginTop: SPACING.m,
    },
    editNameButton: {
        paddingVertical: SPACING.s,
        paddingHorizontal: SPACING.l,
        borderRadius: 28,
    },
    editNameSaveButton: {
        backgroundColor: '#4A8EE8',
        shadowColor: '#4A8EE8',
        shadowOpacity: 0.3,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 2 },
    },
    editNameCancel: {
        color: '#8B929E',
        fontSize: 14,
    },
    editNameSave: {
        color: 'white',
        fontSize: 14,
        fontWeight: '600',
    },
    section: {
        marginBottom: SPACING.xl,
    },
    sectionTitle: {
        fontSize: 11,
        fontWeight: '600',
        color: '#9CA3AF',
        marginBottom: SPACING.s,
        textTransform: 'uppercase',
        letterSpacing: 2,
    },
    addressCard: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: 'rgba(18,21,26,0.70)',
        padding: SPACING.m,
        borderRadius: 18,
        marginBottom: SPACING.s,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        shadowColor: '#000',
        shadowOpacity: 0.3,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
        elevation: 5,
    },
    addressInfo: {
        flex: 1,
    },
    addressChain: {
        fontSize: 12,
        color: '#8B929E',
        marginBottom: 4,
    },
    addressText: {
        fontSize: 14,
        color: COLORS.text,
        fontFamily: 'monospace',
    },
    copyButton: {
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(74,142,232,0.10)',
    },
    statsRow: {
        flexDirection: 'row',
        gap: SPACING.s,
        marginBottom: SPACING.xl,
    },
    statCard: {
        flex: 1,
        backgroundColor: 'rgba(18,21,26,0.70)',
        padding: SPACING.m,
        borderRadius: 18,
        alignItems: 'center',
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        shadowColor: '#000',
        shadowOpacity: 0.3,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
        elevation: 5,
    },
    statValue: {
        fontSize: 18,
        fontWeight: 'bold',
        color: COLORS.text,
        marginBottom: 4,
    },
    statLabel: {
        fontSize: 12,
        color: '#8B929E',
    },
    historyItem: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(18,21,26,0.70)',
        padding: SPACING.m,
        borderRadius: 14,
        marginBottom: SPACING.xs,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
    },
    historyIcon: {
        width: 32,
        height: 32,
        borderRadius: 16,
        backgroundColor: 'rgba(74,142,232,0.10)',
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: SPACING.m,
    },
    historyInfo: {
        flex: 1,
    },
    historyAmount: {
        fontSize: 14,
        color: COLORS.text,
        fontWeight: '500',
    },
    historyDate: {
        fontSize: 12,
        color: '#8B929E',
        marginTop: 2,
    },
    sendButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: SPACING.s,
        backgroundColor: '#4A8EE8',
        paddingVertical: SPACING.m,
        borderRadius: 28,
        marginTop: SPACING.m,
        shadowColor: '#4A8EE8',
        shadowOpacity: 0.3,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
    },
    sendButtonText: {
        fontSize: 16,
        fontWeight: 'bold',
        color: 'white',
    },
});

export default ContactDetailScreen;
