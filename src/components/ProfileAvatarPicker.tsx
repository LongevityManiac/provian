import { useTranslation } from 'react-i18next';
import i18next from 'i18next';
import React, { useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    Modal,
    Image,
    ScrollView,
    Alert,
    Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { COLORS, SPACING } from '../constants/theme';
import { useTheme } from '../theme';

const AVATAR_STORAGE_KEY = '@provian_profile_avatar';

// Common emojis for profile avatars
const EMOJI_OPTIONS = [
    '😊', '😎', '🤖', '👻', '🦊', '🐱', '🐶', '🦁',
    '🐼', '🦄', '🐲', '🌟', '⚡', '🔥', '💎', '🚀',
    '🌈', '🎮', '🎯', '🎨', '🎭', '🎪', '🏆', '💫',
];

export type AvatarType = 'photo' | 'emoji' | 'default';

export interface AvatarData {
    type: AvatarType;
    value: string; // URI for photo or emoji character
}

interface ProfileAvatarPickerProps {
    currentAvatar?: AvatarData;
    onAvatarChange: (avatar: AvatarData) => void;
    size?: number;
    editable?: boolean;
}

export const loadStoredAvatar = async (): Promise<AvatarData | null> => {
    try {
        const stored = await AsyncStorage.getItem(AVATAR_STORAGE_KEY);
        if (stored) {
            return JSON.parse(stored);
        }
    } catch (error) {
        console.error('[ProfileAvatarPicker] Error loading avatar:', error);
    }
    return null;
};

export const saveAvatar = async (avatar: AvatarData): Promise<void> => {
    try {
        await AsyncStorage.setItem(AVATAR_STORAGE_KEY, JSON.stringify(avatar));
    } catch (error) {
        console.error('[ProfileAvatarPicker] Error saving avatar:', error);
    }
};

const ProfileAvatarPicker: React.FC<ProfileAvatarPickerProps> = ({
    currentAvatar,
    onAvatarChange,
    size = 80,
    editable = true,
}) => {
    useTranslation();
    const { colors: themeColors } = useTheme();
    const [modalVisible, setModalVisible] = useState(false);
    const [activeTab, setActiveTab] = useState<'photo' | 'emoji'>('emoji');

    const handlePickPhoto = async () => {
        // Android opens the system photo picker, which needs no media permission
        // (the app declares none); iOS still asks for photo library access.
        const permission = Platform.OS === 'android'
            ? { granted: true }
            : await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!permission.granted) {
            Alert.alert(
                i18next.t('ui.avatar.permissionTitle'),
                i18next.t('ui.avatar.permissionBody')
            );
            return;
        }

        const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
            allowsEditing: true,
            aspect: [1, 1],
            quality: 0.8,
        });

        if (!result.canceled && result.assets[0]) {
            const newAvatar: AvatarData = {
                type: 'photo',
                value: result.assets[0].uri,
            };
            onAvatarChange(newAvatar);
            saveAvatar(newAvatar);
            setModalVisible(false);
        }
    };

    const handleSelectEmoji = (emoji: string) => {
        const newAvatar: AvatarData = {
            type: 'emoji',
            value: emoji,
        };
        onAvatarChange(newAvatar);
        saveAvatar(newAvatar);
        setModalVisible(false);
    };

    const renderAvatar = () => {
        const avatarStyle = {
            width: size,
            height: size,
            borderRadius: size / 2,
        };

        if (!currentAvatar || currentAvatar.type === 'default') {
            return (
                <View style={[styles.defaultAvatar, avatarStyle]}>
                    <Ionicons name="person" size={size * 0.5} color="#9CA3AF" />
                </View>
            );
        }

        if (currentAvatar.type === 'emoji') {
            return (
                <View style={[styles.emojiAvatar, avatarStyle]}>
                    <Text style={[styles.emojiText, { fontSize: size * 0.5 }]}>{currentAvatar.value}</Text>
                </View>
            );
        }

        if (currentAvatar.type === 'photo') {
            return (
                <Image
                    source={{ uri: currentAvatar.value }}
                    style={[styles.photoAvatar, avatarStyle]}
                />
            );
        }

        return null;
    };

    return (
        <>
            <TouchableOpacity
                style={styles.avatarContainer}
                onPress={() => editable && setModalVisible(true)}
                disabled={!editable}
            >
                {renderAvatar()}
                {editable && (
                    <View style={styles.editBadge}>
                        <Ionicons name="pencil" size={12} color="#FFFFFF" />
                    </View>
                )}
            </TouchableOpacity>

            <Modal
                visible={modalVisible}
                animationType="slide"
                transparent={true}
                onRequestClose={() => setModalVisible(false)}
            >
                <View style={styles.modalOverlay}>
                    <View style={styles.modalContent}>
                        <View style={styles.modalHeader}>
                            <Text style={styles.modalTitle}>
                                {i18next.t('ui.avatar.title')}</Text>
                            <TouchableOpacity onPress={() => setModalVisible(false)}>
                                <Ionicons name="close" size={24} color={COLORS.text} />
                            </TouchableOpacity>
                        </View>

                        {/* Tabs */}
                        <View style={styles.tabContainer}>
                            <TouchableOpacity
                                style={[
                                    styles.tab,
                                    activeTab === 'emoji' && styles.tabActive,
                                ]}
                                onPress={() => setActiveTab('emoji')}
                            >
                                <Text style={[
                                    styles.tabText,
                                    { color: activeTab === 'emoji' ? '#4A8EE8' : '#9CA3AF' }
                                ]}>
                                    {i18next.t('ui.avatar.emoji')}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={[
                                    styles.tab,
                                    activeTab === 'photo' && styles.tabActive,
                                ]}
                                onPress={() => setActiveTab('photo')}
                            >
                                <Text style={[
                                    styles.tabText,
                                    { color: activeTab === 'photo' ? '#4A8EE8' : '#9CA3AF' }
                                ]}>
                                    {i18next.t('ui.avatar.photo')}</Text>
                            </TouchableOpacity>
                        </View>

                        {/* Tab Content */}
                        <ScrollView style={styles.tabContent}>
                            {activeTab === 'emoji' && (
                                <View style={styles.emojiGrid}>
                                    {EMOJI_OPTIONS.map((emoji, index) => (
                                        <TouchableOpacity
                                            key={index}
                                            style={[
                                                styles.emojiOption,
                                                currentAvatar?.type === 'emoji' && currentAvatar.value === emoji && styles.emojiSelected
                                            ]}
                                            onPress={() => handleSelectEmoji(emoji)}
                                        >
                                            <Text style={styles.emojiOptionText}>{emoji}</Text>
                                        </TouchableOpacity>
                                    ))}
                                </View>
                            )}

                            {activeTab === 'photo' && (
                                <View style={styles.photoSection}>
                                    <TouchableOpacity
                                        style={styles.photoButton}
                                        onPress={handlePickPhoto}
                                    >
                                        <Ionicons name="image" size={24} color="#0B0E14" />
                                        <Text style={styles.photoButtonText}>{i18next.t('ui.avatar.chooseLibrary')}</Text>
                                    </TouchableOpacity>
                                    <Text style={styles.photoHint}>
                                        {i18next.t('ui.avatar.squareHint')}</Text>
                                </View>
                            )}

                        </ScrollView>
                    </View>
                </View>
            </Modal>
        </>
    );
};

const styles = StyleSheet.create({
    avatarContainer: {
        position: 'relative',
    },
    defaultAvatar: {
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1.5,
        borderColor: 'rgba(200,205,214,0.08)',
        backgroundColor: 'rgba(18,21,26,0.70)',
    },
    emojiAvatar: {
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1.5,
        borderColor: 'rgba(200,205,214,0.08)',
        backgroundColor: 'rgba(18,21,26,0.70)',
    },
    emojiText: {
        textAlign: 'center',
    },
    photoAvatar: {
        borderWidth: 1.5,
        borderColor: 'rgba(74,142,232,0.25)',
    },
    editBadge: {
        position: 'absolute',
        bottom: 0,
        right: 0,
        width: 26,
        height: 26,
        borderRadius: 13,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 2,
        borderColor: '#0B0E14',
        backgroundColor: '#4A8EE8',
    },
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0, 0, 0, 0.7)',
        justifyContent: 'flex-end',
    },
    modalContent: {
        borderTopLeftRadius: 22,
        borderTopRightRadius: 22,
        maxHeight: '70%',
        backgroundColor: 'rgba(18,21,26,0.88)',
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        borderBottomWidth: 0,
    },
    modalHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: SPACING.l,
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(200,205,214,0.08)',
    },
    modalTitle: {
        fontSize: 18,
        fontWeight: '700',
        color: COLORS.text,
    },
    tabContainer: {
        flexDirection: 'row',
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(200,205,214,0.08)',
    },
    tab: {
        flex: 1,
        paddingVertical: SPACING.m,
        alignItems: 'center',
        borderBottomWidth: 2,
        borderBottomColor: 'transparent',
    },
    tabActive: {
        borderBottomColor: '#4A8EE8',
    },
    tabText: {
        fontSize: 14,
        fontWeight: '600',
    },
    tabContent: {
        padding: SPACING.l,
    },
    emojiGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'center',
        gap: SPACING.s,
    },
    emojiOption: {
        width: 56,
        height: 56,
        borderRadius: 14,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
    },
    emojiSelected: {
        borderWidth: 2,
        borderColor: 'rgba(74,142,232,0.55)',
        backgroundColor: 'rgba(74,142,232,0.08)',
    },
    emojiOptionText: {
        fontSize: 28,
    },
    photoSection: {
        alignItems: 'center',
        paddingVertical: SPACING.xl,
    },
    photoButton: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: SPACING.m,
        paddingHorizontal: SPACING.xl,
        borderRadius: 28,
        gap: SPACING.s,
        backgroundColor: '#4A8EE8',
        shadowColor: '#4A8EE8',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 16,
        elevation: 8,
    },
    photoButtonText: {
        color: '#0B0E14',
        fontSize: 16,
        fontWeight: '700',
    },
    photoHint: {
        marginTop: SPACING.m,
        fontSize: 13,
        color: '#9CA3AF',
    },
});

export default ProfileAvatarPicker;
