import React, { useState, useEffect } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    TextInput,
    KeyboardAvoidingView,
    Platform,
    Alert,
    ScrollView,
    Keyboard,
    TouchableWithoutFeedback,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS, GRADIENTS, SHADOWS } from '../../constants/theme';
import { useWalletStore } from '../../store/walletStore';
import BackButton from '../../components/BackButton';

const DISPLAY_NAME_KEY = 'provian_user_display_name';

const ProfileEditScreen = ({ navigation }: any) => {
    const { t } = useTranslation();
    const { userName, setUserName } = useWalletStore();
    const [displayName, setDisplayName] = useState('');
    const [originalName, setOriginalName] = useState('');
    const [isSaving, setIsSaving] = useState(false);

    useEffect(() => {
        loadDisplayName();
    }, []);

    const loadDisplayName = async () => {
        try {
            const storedName = await AsyncStorage.getItem(DISPLAY_NAME_KEY);
            const name = storedName || userName || '';
            setDisplayName(name);
            setOriginalName(name);
        } catch (err) {
            console.error('[ProfileEdit] Failed to load display name:', err);
        }
    };

    const handleSave = async () => {
        if (!displayName.trim()) {
            Alert.alert(t('common.required'), t('profile.nameRequired'));
            return;
        }

        setIsSaving(true);

        try {
            await AsyncStorage.setItem(DISPLAY_NAME_KEY, displayName.trim());

            // Update store if available
            if (setUserName) {
                setUserName(displayName.trim());
            }

            Alert.alert(t('profile.saved'), t('profile.nameUpdated'), [
                { text: t('common.ok'), onPress: () => navigation.goBack() }
            ]);
        } catch (err) {
            console.error('[ProfileEdit] Failed to save:', err);
            Alert.alert(t('common.errorTitle'), t('profile.failedToSave'));
        } finally {
            setIsSaving(false);
        }
    };

    const hasChanges = displayName.trim() !== originalName;

    return (
        <SafeAreaView style={styles.container}>
            <LinearGradient
                colors={GRADIENTS.backgroundDiagonal}
                style={StyleSheet.absoluteFill}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
            />

            {/* Header */}
            <View style={styles.header}>
                <BackButton onPress={() => navigation.goBack()} />
                <Text style={styles.headerTitle}>{t('profile.editProfile')}</Text>
                <View style={{ width: 44 }} />
            </View>

            <KeyboardAvoidingView
                style={styles.keyboardView}
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                keyboardVerticalOffset={Platform.OS === 'ios' ? 100 : 0}
            >
                <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
                    <ScrollView
                        contentContainerStyle={styles.scrollContent}
                        keyboardShouldPersistTaps="handled"
                        showsVerticalScrollIndicator={false}
                    >
                        {/* Avatar */}
                        <View style={styles.avatarContainer}>
                            <View style={styles.avatar}>
                                <Ionicons name="person" size={48} color="#4A8EE8" />
                            </View>
                        </View>

                        {/* Name Input */}
                        <Text style={styles.label}>{t('profile.displayNameLabel')}</Text>
                        <View style={styles.inputContainer}>
                            <TextInput
                                style={styles.input}
                                placeholder={t('profile.namePlaceholder')}
                                placeholderTextColor="#9CA3AF"
                                value={displayName}
                                onChangeText={setDisplayName}
                                autoCapitalize="words"
                                returnKeyType="done"
                                maxLength={50}
                            />
                        </View>
                        <Text style={styles.hint}>
                            {t('profile.hint')}
                        </Text>

                        {/* Save Button */}
                        <View style={styles.spacer} />

                        <TouchableOpacity
                            style={[
                                styles.saveButton,
                                (!hasChanges || isSaving) && styles.saveButtonDisabled
                            ]}
                            onPress={handleSave}
                            disabled={!hasChanges || isSaving}
                            activeOpacity={0.8}
                        >
                            <LinearGradient
                                colors={hasChanges && !isSaving ? GRADIENTS.primary : ['rgba(42,48,56,1)', 'rgba(42,48,56,1)']}
                                start={{ x: 0, y: 0 }}
                                end={{ x: 1, y: 0 }}
                                style={styles.buttonGradient}
                            >
                                <Text style={[
                                    styles.saveButtonText,
                                    (!hasChanges || isSaving) && styles.saveButtonTextDisabled
                                ]}>
                                    {isSaving ? t('common.saving') : t('profile.saveChanges')}
                                </Text>
                            </LinearGradient>
                        </TouchableOpacity>

                        {/* Privacy Note */}
                        <View style={styles.privacyNote}>
                            <Ionicons name="shield-checkmark" size={16} color="#4CC38A" />
                            <Text style={styles.privacyNoteText}>
                                {t('profile.privacyNote')}
                            </Text>
                        </View>
                    </ScrollView>
                </TouchableWithoutFeedback>
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
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: SPACING.m,
    },
    headerTitle: {
        fontSize: 18,
        fontWeight: '700',
        color: COLORS.text,
    },
    keyboardView: {
        flex: 1,
    },
    scrollContent: {
        flexGrow: 1,
        padding: SPACING.l,
    },
    avatarContainer: {
        alignItems: 'center',
        marginBottom: SPACING.xl,
    },
    avatar: {
        width: 100,
        height: 100,
        borderRadius: 50,
        backgroundColor: 'rgba(74,142,232,0.10)',
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 2,
        borderColor: 'rgba(74,142,232,0.4)',
        shadowColor: '#4A8EE8',
        shadowOpacity: 0.4,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 0 },
    },
    label: {
        fontSize: 11,
        fontWeight: '600',
        color: '#9CA3AF',
        marginBottom: SPACING.s,
        textTransform: 'uppercase',
        letterSpacing: 2,
    },
    inputContainer: {
        backgroundColor: 'rgba(18,21,26,0.60)',
        borderRadius: 14,
        borderWidth: 1,
        borderColor: 'rgba(42,48,56,1)',
        paddingHorizontal: SPACING.m,
    },
    input: {
        color: COLORS.text,
        fontSize: 18,
        paddingVertical: SPACING.m,
    },
    hint: {
        fontSize: 13,
        color: '#9CA3AF',
        marginTop: SPACING.s,
    },
    spacer: {
        flex: 1,
        minHeight: SPACING.xxl,
    },
    saveButton: {
        borderRadius: 28,
        overflow: 'hidden',
        shadowColor: '#4A8EE8',
        shadowOpacity: 0.3,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
    },
    saveButtonDisabled: {
        shadowOpacity: 0,
    },
    buttonGradient: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: SPACING.m + 2,
        borderRadius: 28,
    },
    saveButtonText: {
        color: 'white',
        fontSize: 17,
        fontWeight: 'bold',
    },
    saveButtonTextDisabled: {
        color: '#9CA3AF',
    },
    privacyNote: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: SPACING.xs,
        marginTop: SPACING.l,
    },
    privacyNoteText: {
        fontSize: 12,
        color: '#8B929E',
    },
});

export default ProfileEditScreen;
