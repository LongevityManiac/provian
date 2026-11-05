import { useTranslation } from 'react-i18next';
import i18next from 'i18next';
import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated, Dimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING } from '../constants/theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const { width } = Dimensions.get('window');

export interface InAppNotificationData {
    id: string;
    title: string;
    body: string;
    data: {
        type: string;
        request_id: string;
        agent_id: string;
        merchant: string;
        amount: string;
        currency: string;
        purpose: string;
        friction_level: string;
    };
}

interface InAppNotificationBannerProps {
    notification: InAppNotificationData | null;
    onPress: (notification: InAppNotificationData) => void;
    onDismiss: () => void;
    autoDismissMs?: number;
}

const InAppNotificationBanner: React.FC<InAppNotificationBannerProps> = ({
    notification,
    onPress,
    onDismiss,
    autoDismissMs = 8000,
}) => {
    useTranslation();
    const insets = useSafeAreaInsets();
    const translateY = useRef(new Animated.Value(-200)).current;
    const opacity = useRef(new Animated.Value(0)).current;

    useEffect(() => {
        if (notification) {
            // Slide in
            Animated.parallel([
                Animated.spring(translateY, {
                    toValue: 0,
                    useNativeDriver: true,
                    tension: 50,
                    friction: 8,
                }),
                Animated.timing(opacity, {
                    toValue: 1,
                    duration: 200,
                    useNativeDriver: true,
                }),
            ]).start();

            // Auto dismiss
            const timer = setTimeout(() => {
                dismissBanner();
            }, autoDismissMs);

            return () => clearTimeout(timer);
        } else {
            // Reset position when no notification
            translateY.setValue(-200);
            opacity.setValue(0);
        }
    }, [notification]);

    const dismissBanner = () => {
        Animated.parallel([
            Animated.timing(translateY, {
                toValue: -200,
                duration: 300,
                useNativeDriver: true,
            }),
            Animated.timing(opacity, {
                toValue: 0,
                duration: 200,
                useNativeDriver: true,
            }),
        ]).start(() => {
            onDismiss();
        });
    };

    const handlePress = () => {
        if (notification) {
            dismissBanner();
            setTimeout(() => onPress(notification), 100);
        }
    };

    if (!notification) return null;

    return (
        <Animated.View
            style={[
                styles.container,
                {
                    paddingTop: insets.top + SPACING.s,
                    transform: [{ translateY }],
                    opacity,
                },
            ]}
        >
            <TouchableOpacity
                style={styles.banner}
                onPress={handlePress}
                activeOpacity={0.9}
            >
                <View style={styles.iconContainer}>
                    <Ionicons name="hardware-chip" size={24} color="#E8A838" />
                </View>
                <View style={styles.content}>
                    <Text style={styles.title} numberOfLines={1}>
                        {notification.title}
                    </Text>
                    <Text style={styles.body} numberOfLines={2}>
                        {notification.body}
                    </Text>
                </View>
                <TouchableOpacity style={styles.closeButton} onPress={dismissBanner}>
                    <Ionicons name="close" size={20} color="#9CA3AF" />
                </TouchableOpacity>
            </TouchableOpacity>
            <Text style={styles.tapHint}>{i18next.t('ui.notifications.tapToReview')}</Text>
        </Animated.View>
    );
};

const styles = StyleSheet.create({
    container: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 9999,
        paddingHorizontal: SPACING.m,
        paddingBottom: SPACING.s,
    },
    banner: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(18,21,26,0.88)',
        borderRadius: 18,
        padding: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(255,179,0,0.35)',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.3,
        shadowRadius: 12,
        elevation: 5,
        gap: SPACING.m,
    },
    iconContainer: {
        width: 44,
        height: 44,
        borderRadius: 14,
        backgroundColor: 'rgba(255,179,0,0.14)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    content: {
        flex: 1,
    },
    title: {
        fontSize: 15,
        fontWeight: '700',
        color: COLORS.text,
        marginBottom: 2,
    },
    body: {
        fontSize: 13,
        color: '#8B929E',
        lineHeight: 18,
    },
    closeButton: {
        padding: SPACING.xs,
    },
    tapHint: {
        textAlign: 'center',
        fontSize: 11,
        color: '#9CA3AF',
        marginTop: SPACING.xs,
        fontWeight: '600',
        letterSpacing: 1,
        textTransform: 'uppercase',
    },
});

export default InAppNotificationBanner;
