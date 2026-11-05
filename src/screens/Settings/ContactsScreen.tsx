import React, { useState, useEffect, useCallback } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    ScrollView,
    TextInput,
    Alert,
    Modal,
    RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS, GRADIENTS } from '../../constants/theme';
import AddressHistoryService, { Contact, ChainType } from '../../core/protection/AddressHistoryService';
import { useTheme } from '../../theme';
import BackButton from '../../components/BackButton';

const ContactsScreen = ({ navigation }: any) => {
    const { t } = useTranslation();
    const { colors: themeColors } = useTheme();

    const backgroundGradient = GRADIENTS.backgroundDiagonal;
    const [favorites, setFavorites] = useState<Contact[]>([]);
    const [recentAddresses, setRecentAddresses] = useState<Contact[]>([]);
    const [allContacts, setAllContacts] = useState<Contact[]>([]);
    const [refreshing, setRefreshing] = useState(false);
    const [loading, setLoading] = useState(true);

    // Add contact modal
    const [showAddModal, setShowAddModal] = useState(false);
    const [newContactName, setNewContactName] = useState('');
    const [newContactAddress, setNewContactAddress] = useState('');
    const [newContactChain, setNewContactChain] = useState<ChainType>('evm');
    const [saving, setSaving] = useState(false);

    const loadData = useCallback(async () => {
        try {
            const [favs, recent, contacts] = await Promise.all([
                AddressHistoryService.getFavorites(),
                AddressHistoryService.getRecentAddresses(5),
                AddressHistoryService.getContactsWithHistory(),
            ]);

            setFavorites(favs);
            setRecentAddresses(recent.filter(r => !r.name)); // Only show non-contacts in recent
            setAllContacts(contacts);
        } catch (error) {
            console.error('[ContactsScreen] Failed to load:', error);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadData();
    }, [loadData]);

    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        await loadData();
        setRefreshing(false);
    }, [loadData]);

    const handleToggleFavorite = async (contact: Contact) => {
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        await AddressHistoryService.toggleFavorite(contact.address);
        await loadData();
    };

    const handleDeleteContact = (contact: Contact) => {
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
                        await loadData();
                    },
                },
            ]
        );
    };

    const handleSendToContact = (contact: Contact) => {
        navigation.navigate('Send', {
            prefillAddress: contact.address,
            prefillChain: contact.chain,
            prefillName: contact.name,
        });
    };

    const handleAddRecentToContacts = (recent: Contact) => {
        setNewContactAddress(recent.address);
        setNewContactChain(recent.chain || 'evm');
        setNewContactName('');
        setShowAddModal(true);
    };

    const handleViewContact = (contact: Contact) => {
        navigation.navigate('ContactDetail', { contact });
    };

    const handleSaveNewContact = async () => {
        if (!newContactName.trim()) {
            Alert.alert(t('common.errorTitle'), t('contacts.enterName'));
            return;
        }
        if (!newContactAddress.trim()) {
            Alert.alert(t('common.errorTitle'), t('contacts.enterAddress'));
            return;
        }

        setSaving(true);
        try {
            await AddressHistoryService.saveContact(
                newContactAddress.trim(),
                newContactName.trim(),
                newContactChain
            );
            await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            setShowAddModal(false);
            setNewContactName('');
            setNewContactAddress('');
            await loadData();
        } catch (error) {
            Alert.alert(t('common.errorTitle'), t('contacts.failedToSave'));
        } finally {
            setSaving(false);
        }
    };

    const formatAddress = (address: string): string => {
        if (address.length <= 12) return address;
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
    };

    const formatUsd = (amount: number | undefined): string => {
        // no recorded USD (price unknown at send time) is " ", never $0.
        if (!amount || amount <= 0) return '—';
        if (amount < 1) return '<$1';
        return `$${Math.round(amount).toLocaleString()}`;
    };

    const renderContactCard = (contact: Contact, showAddButton = false) => (
        <TouchableOpacity
            key={contact.id}
            style={styles.contactCard}
            onPress={() => contact.name ? handleViewContact(contact) : undefined}
            onLongPress={() => contact.name && handleDeleteContact(contact)}
            activeOpacity={contact.name ? 0.7 : 1}
        >
            <View style={styles.contactLeft}>
                <View style={[styles.avatar, contact.isFavorite && styles.avatarFavorite]}>
                    {contact.name ? (
                        <Text style={styles.avatarText}>
                            {contact.name.charAt(0).toUpperCase()}
                        </Text>
                    ) : (
                        <Ionicons name="wallet-outline" size={18} color="#8B929E" />
                    )}
                </View>
                <View style={styles.contactInfo}>
                    {contact.name ? (
                        <>
                            <Text style={styles.contactName}>{contact.name}</Text>
                            <Text style={styles.contactAddress}>
                                {formatAddress(contact.address)}
                                {contact.chain && ` · ${AddressHistoryService.getChainShortName(contact.chain)}`}
                            </Text>
                        </>
                    ) : (
                        <>
                            <Text style={styles.contactAddress}>
                                {formatAddress(contact.address)}
                            </Text>
                            <Text style={styles.contactMeta}>
                                {contact.chain && `${AddressHistoryService.getChainShortName(contact.chain)} · `}
                                {formatUsd(contact.totalSentUsd)}{t('contacts.sentLower')}</Text>
                        </>
                    )}
                    {contact.lastSentAt && contact.name && (
                        <Text style={styles.contactMeta}>{t('contacts.lastPrefix')}{formatUsd(contact.totalSentUsd)} · {AddressHistoryService.formatRelativeTime(contact.lastSentAt)}
                        </Text>
                    )}
                </View>
            </View>

            <View style={styles.contactActions}>
                {contact.name && (
                    <TouchableOpacity
                        style={styles.actionButton}
                        onPress={() => handleToggleFavorite(contact)}
                    >
                        <Ionicons
                            name={contact.isFavorite ? 'star' : 'star-outline'}
                            size={20}
                            color={contact.isFavorite ? '#E8A838' : '#8B929E'}
                        />
                    </TouchableOpacity>
                )}
                {showAddButton && !contact.name && (
                    <TouchableOpacity
                        style={[styles.actionButton, styles.addActionButton]}
                        onPress={() => handleAddRecentToContacts(contact)}
                    >
                        <Ionicons name="person-add" size={18} color="#4A8EE8" />
                    </TouchableOpacity>
                )}
                <TouchableOpacity
                    style={[styles.actionButton, styles.sendActionButton]}
                    onPress={() => handleSendToContact(contact)}
                >
                    <Ionicons name="arrow-up" size={18} color="#4A8EE8" />
                </TouchableOpacity>
            </View>
        </TouchableOpacity>
    );

    const chainOptions: { value: ChainType; label: string }[] = [
        { value: 'evm', label: t('contacts.evmNetwork') },
    ];

    return (
        <SafeAreaView style={styles.container}>
            <LinearGradient
                colors={backgroundGradient}
                style={StyleSheet.absoluteFill}
            />

            {/* Header */}
            <View style={styles.header}>
                <BackButton onPress={() => navigation.goBack()} />
                <Text style={styles.headerTitle}>{t('contacts.title')}</Text>
                <TouchableOpacity style={styles.headerAction} onPress={() => {
                    setNewContactName('');
                    setNewContactAddress('');
                    setNewContactChain('evm');
                    setShowAddModal(true);
                }}>
                    <Ionicons name="add" size={24} color="#4A8EE8" />
                </TouchableOpacity>
            </View>

            <ScrollView
                contentContainerStyle={styles.content}
                refreshControl={
                    <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#4A8EE8" />
                }
            >
                {/* Favorites Section */}
                {favorites.length > 0 && (
                    <View style={styles.section}>
                        <View style={styles.sectionHeader}>
                            <Ionicons name="star" size={16} color="#E8A838" />
                            <Text style={styles.sectionTitle}>{t('contacts.favorites')}</Text>
                        </View>
                        {favorites.map(contact => renderContactCard(contact))}
                    </View>
                )}

                {/* Recent Addresses Section */}
                {recentAddresses.length > 0 && (
                    <View style={styles.section}>
                        <View style={styles.sectionHeader}>
                            <Ionicons name="time" size={16} color="#9CA3AF" />
                            <Text style={styles.sectionTitle}>{t('contacts.recent')}</Text>
                        </View>
                        {recentAddresses.map(contact => renderContactCard(contact, true))}
                    </View>
                )}

                {/* All Contacts Section */}
                <View style={styles.section}>
                    <View style={styles.sectionHeader}>
                        <Ionicons name="people" size={16} color="#9CA3AF" />
                        <Text style={styles.sectionTitle}>{t('contacts.allContacts')}</Text>
                        <Text style={styles.sectionCount}>{allContacts.length}</Text>
                    </View>
                    {allContacts.length > 0 ? (
                        allContacts.map(contact => renderContactCard(contact))
                    ) : (
                        <View style={styles.emptyState}>
                            <Ionicons name="people" size={48} color="#9CA3AF" />
                            <Text style={styles.emptyText}>{t('contacts.noContacts')}</Text>
                            <Text style={styles.emptySubtext}>
                                {t('contacts.addToSendFaster')}
                            </Text>
                            <TouchableOpacity
                                style={styles.emptyButton}
                                onPress={() => setShowAddModal(true)}
                            >
                                <Ionicons name="add" size={20} color="white" />
                                <Text style={styles.emptyButtonText}>{t('contacts.add')}</Text>
                            </TouchableOpacity>
                        </View>
                    )}
                </View>
            </ScrollView>

            {/* Add Contact Modal */}
            <Modal
                visible={showAddModal}
                animationType="slide"
                presentationStyle="pageSheet"
                onRequestClose={() => setShowAddModal(false)}
            >
                <View style={styles.modalContainer}>
                    <View style={styles.modalHeader}>
                        <TouchableOpacity onPress={() => setShowAddModal(false)}>
                            <Text style={styles.modalCancel}>{t('common.cancel')}</Text>
                        </TouchableOpacity>
                        <Text style={styles.modalTitle}>{t('contacts.add')}</Text>
                        <TouchableOpacity onPress={handleSaveNewContact} disabled={saving}>
                            <Text style={[styles.modalSave, saving && styles.modalSaveDisabled]}>
                                {saving ? t('common.saving') : t('common.save')}
                            </Text>
                        </TouchableOpacity>
                    </View>

                    <ScrollView style={styles.modalContent}>
                        <View style={styles.inputGroup}>
                            <Text style={styles.inputLabel}>{t('contacts.nameLabel')}</Text>
                            <TextInput
                                style={styles.input}
                                placeholder={t('contacts.namePlaceholder')}
                                placeholderTextColor="#9CA3AF"
                                value={newContactName}
                                onChangeText={setNewContactName}
                                autoFocus
                            />
                        </View>

                        <View style={styles.inputGroup}>
                            <Text style={styles.inputLabel}>{t('contacts.addressLabel')}</Text>
                            <TextInput
                                style={[styles.input, styles.inputMono]}
                                placeholder={t('contacts.addressPlaceholder')}
                                placeholderTextColor="#9CA3AF"
                                value={newContactAddress}
                                onChangeText={(text) => {
                                    setNewContactAddress(text);
                                    // Auto-detect chain
                                    if (text.length > 5) {
                                        setNewContactChain(AddressHistoryService.detectChainFromAddress(text));
                                    }
                                }}
                                autoCapitalize="none"
                                autoCorrect={false}
                            />
                        </View>

                        <View style={styles.inputGroup}>
                            <Text style={styles.inputLabel}>{t('contacts.networkLabel')}</Text>
                            <View style={styles.chainSelector}>
                                {chainOptions.map(option => (
                                    <TouchableOpacity
                                        key={option.value}
                                        style={[
                                            styles.chainOption,
                                            newContactChain === option.value && styles.chainOptionSelected
                                        ]}
                                        onPress={() => setNewContactChain(option.value)}
                                    >
                                        <Text style={[
                                            styles.chainOptionText,
                                            newContactChain === option.value && styles.chainOptionTextSelected
                                        ]}>
                                            {option.label}
                                        </Text>
                                    </TouchableOpacity>
                                ))}
                            </View>
                        </View>
                    </ScrollView>
                </View>
            </Modal>
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    // Right-hand header action, sized like BackButton so the title stays centered.
    headerAction: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
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
        fontSize: 18,
        fontWeight: '700',
        color: COLORS.text,
    },
    content: {
        padding: SPACING.m,
        paddingBottom: SPACING.xl * 2,
    },
    section: {
        marginBottom: SPACING.xl,
    },
    sectionHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.xs,
        marginBottom: SPACING.s,
    },
    sectionTitle: {
        fontSize: 11,
        fontWeight: '600',
        color: '#9CA3AF',
        letterSpacing: 2,
        textTransform: 'uppercase',
    },
    sectionCount: {
        fontSize: 12,
        color: '#9CA3AF',
        marginLeft: 'auto',
    },
    contactCard: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        padding: SPACING.m,
        borderRadius: 18,
        marginBottom: SPACING.s,
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        shadowColor: '#000',
        shadowOpacity: 0.3,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
        elevation: 5,
    },
    contactLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
        gap: SPACING.m,
    },
    avatar: {
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: 'rgba(18,21,26,0.70)',
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
    },
    avatarFavorite: {
        borderColor: '#E8A838',
        backgroundColor: 'rgba(255, 179, 0, 0.08)',
    },
    avatarText: {
        fontSize: 18,
        fontWeight: 'bold',
        color: '#4A8EE8',
    },
    contactInfo: {
        flex: 1,
    },
    contactName: {
        fontSize: 16,
        fontWeight: '600',
        color: COLORS.text,
        marginBottom: 2,
    },
    contactAddress: {
        fontSize: 13,
        color: '#8B929E',
        fontFamily: 'monospace',
    },
    contactMeta: {
        fontSize: 12,
        color: '#8B929E',
        marginTop: 2,
    },
    contactActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.xs,
    },
    actionButton: {
        width: 36,
        height: 36,
        borderRadius: 18,
        alignItems: 'center',
        justifyContent: 'center',
    },
    addActionButton: {
        backgroundColor: 'rgba(74,142,232,0.10)',
    },
    sendActionButton: {
        backgroundColor: 'rgba(74,142,232,0.10)',
    },
    emptyState: {
        alignItems: 'center',
        paddingVertical: SPACING.xl * 2,
    },
    emptyText: {
        fontSize: 18,
        fontWeight: 'bold',
        color: COLORS.text,
        marginTop: SPACING.m,
    },
    emptySubtext: {
        fontSize: 14,
        color: '#8B929E',
        textAlign: 'center',
        marginTop: SPACING.s,
        marginBottom: SPACING.l,
    },
    emptyButton: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
        backgroundColor: '#4A8EE8',
        paddingVertical: SPACING.s,
        paddingHorizontal: SPACING.l,
        borderRadius: 28,
        shadowColor: '#4A8EE8',
        shadowOpacity: 0.3,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 2 },
    },
    emptyButtonText: {
        fontSize: 14,
        fontWeight: '600',
        color: 'white',
    },
    // Modal styles
    modalContainer: {
        flex: 1,
        backgroundColor: '#0B0E14',
    },
    modalHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: SPACING.m,
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(200,205,214,0.08)',
    },
    modalCancel: {
        fontSize: 16,
        color: '#8B929E',
    },
    modalTitle: {
        fontSize: 18,
        fontWeight: '700',
        color: COLORS.text,
    },
    modalSave: {
        fontSize: 16,
        fontWeight: '600',
        color: '#4A8EE8',
    },
    modalSaveDisabled: {
        opacity: 0.5,
    },
    modalContent: {
        flex: 1,
        padding: SPACING.l,
    },
    inputGroup: {
        marginBottom: SPACING.xl,
    },
    inputLabel: {
        fontSize: 11,
        fontWeight: '600',
        color: '#9CA3AF',
        marginBottom: SPACING.s,
        letterSpacing: 2,
        textTransform: 'uppercase',
    },
    input: {
        backgroundColor: 'rgba(18,21,26,0.60)',
        borderRadius: 14,
        padding: SPACING.m,
        fontSize: 16,
        color: COLORS.text,
        borderWidth: 1,
        borderColor: 'rgba(42,48,56,1)',
    },
    inputMono: {
        fontFamily: 'monospace',
        fontSize: 14,
    },
    chainSelector: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: SPACING.s,
    },
    chainOption: {
        paddingVertical: SPACING.s,
        paddingHorizontal: SPACING.m,
        borderRadius: 14,
        backgroundColor: 'rgba(18,21,26,0.60)',
        borderWidth: 1,
        borderColor: 'rgba(42,48,56,1)',
    },
    chainOptionSelected: {
        borderColor: '#4A8EE8',
        backgroundColor: 'rgba(74,142,232,0.10)',
    },
    chainOptionText: {
        fontSize: 14,
        color: '#8B929E',
    },
    chainOptionTextSelected: {
        color: '#4A8EE8',
        fontWeight: '600',
    },
});

export default ContactsScreen;
