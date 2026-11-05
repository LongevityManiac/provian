import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING } from '../constants/theme';

interface CoolingPeriodProps {
    durationSeconds: number;
    reason: string;
    antiRushMessage: string;
    onComplete: () => void;
    onCancel: () => void;
}

const CoolingPeriod: React.FC<CoolingPeriodProps> = ({
    durationSeconds,
    reason,
    antiRushMessage,
    onComplete,
    onCancel
}) => {
    const [remainingSeconds, setRemainingSeconds] = useState(durationSeconds);
    const [isBeingRushed, setIsBeingRushed] = useState<boolean | null>(null);

    useEffect(() => {
        const interval = setInterval(() => {
            setRemainingSeconds(prev => {
                if (prev <= 1) {
                    clearInterval(interval);
                    return 0;
                }
                return prev - 1;
            });
        }, 1000);

        return () => clearInterval(interval);
    }, []);

    const handleProceed = () => {
        if (isBeingRushed === true) {
            // User admitted they're being rushed - BLOCK
            return;
        }
        onComplete();
    };

    const progress = ((durationSeconds - remainingSeconds) / durationSeconds) * 100;

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <View style={styles.iconContainer}>
                    <Ionicons name="hourglass" size={56} color={COLORS.primary} />
                </View>
                <Text style={styles.title}>Cooling Period</Text>
                <Text style={styles.subtitle}>{reason}</Text>
            </View>

            <View style={styles.content}>
                <View style={styles.timerContainer}>
                    <Text style={styles.timerText}>
                        {Math.floor(remainingSeconds / 60)}:{(remainingSeconds % 60).toString().padStart(2, '0')}
                    </Text>
                    <Text style={styles.timerLabel}>TIME REMAINING</Text>
                </View>

                <View style={styles.progressBarContainer}>
                    <View style={[styles.progressBar, { width: `${progress}%` }]} />
                </View>

                <View style={styles.messageBox}>
                    <View style={styles.messageIconWrap}>
                        <Ionicons name="shield-checkmark" size={22} color={COLORS.primary} />
                    </View>
                    <View style={styles.messageContent}>
                        <Text style={styles.messageTitle}>Why the wait?</Text>
                        <Text style={styles.messageText}>{antiRushMessage}</Text>
                    </View>
                </View>

                <View style={styles.checklistBox}>
                    <Text style={styles.checklistTitle}>USE THIS TIME TO</Text>
                    <View style={styles.checklistItem}>
                        <Ionicons name="checkmark-circle" size={20} color={COLORS.primary} />
                        <Text style={styles.checklistText}>Double-check the contract address</Text>
                    </View>
                    <View style={styles.checklistItem}>
                        <Ionicons name="checkmark-circle" size={20} color={COLORS.primary} />
                        <Text style={styles.checklistText}>Verify you're on the right website</Text>
                    </View>
                    <View style={styles.checklistItem}>
                        <Ionicons name="checkmark-circle" size={20} color={COLORS.primary} />
                        <Text style={styles.checklistText}>Confirm you really want to do this</Text>
                    </View>
                    <View style={styles.checklistItem}>
                        <Ionicons name="checkmark-circle" size={20} color={COLORS.primary} />
                        <Text style={styles.checklistText}>Make sure no one is rushing you</Text>
                    </View>
                </View>

                {remainingSeconds === 0 && isBeingRushed === null && (
                    <View style={styles.rushCheckBox}>
                        <Text style={styles.rushCheckTitle}>Final Safety Check</Text>
                        <Text style={styles.rushCheckQuestion}>
                            Are you being rushed or pressured to do this?
                        </Text>

                        <TouchableOpacity
                            style={[styles.rushButton, styles.rushButtonNo]}
                            onPress={() => setIsBeingRushed(false)}
                        >
                            <Ionicons name="checkmark-circle" size={24} color="#4CC38A" />
                            <Text style={styles.rushButtonText}>No, I'm doing this on my own timeline</Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                            style={[styles.rushButton, styles.rushButtonYes]}
                            onPress={() => setIsBeingRushed(true)}
                        >
                            <Ionicons name="warning" size={24} color={COLORS.error} />
                            <Text style={styles.rushButtonText}>Yes, someone told me I need to do this NOW</Text>
                        </TouchableOpacity>
                    </View>
                )}

                {isBeingRushed === true && (
                    <View style={styles.blockedBox}>
                        <View style={styles.blockedIconWrap}>
                            <Ionicons name="shield" size={44} color={COLORS.error} />
                        </View>
                        <Text style={styles.blockedTitle}>Transaction Blocked</Text>
                        <Text style={styles.blockedText}>
                            You indicated you're being rushed. This is a common scam tactic.
                        </Text>
                        <Text style={styles.blockedAdvice}>
                            Legitimate services NEVER pressure you to act immediately. Take a break, do research, and only proceed when YOU decide it's right.
                        </Text>
                        <TouchableOpacity style={styles.supportButton} onPress={onCancel}>
                            <Text style={styles.supportButtonText}>Get Help & Exit</Text>
                        </TouchableOpacity>
                    </View>
                )}
            </View>

            <View style={styles.footer}>
                {remainingSeconds > 0 && (
                    <TouchableOpacity style={styles.cancelButton} onPress={onCancel}>
                        <Text style={styles.cancelButtonText}>Cancel Transaction</Text>
                    </TouchableOpacity>
                )}

                {remainingSeconds === 0 && isBeingRushed === false && (
                    <TouchableOpacity style={styles.proceedButton} onPress={handleProceed}>
                        <Ionicons name="arrow-forward" size={20} color="#0B0E14" />
                        <Text style={styles.proceedButtonText}>Continue</Text>
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
    },
    iconContainer: {
        width: 96,
        height: 96,
        borderRadius: 28,
        backgroundColor: 'rgba(74,142,232,0.14)',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: SPACING.m,
    },
    title: {
        fontSize: 26,
        fontWeight: '700',
        color: COLORS.text,
        marginBottom: SPACING.s,
        letterSpacing: -0.3,
    },
    subtitle: {
        fontSize: 14,
        color: '#8B929E',
        textAlign: 'center',
        lineHeight: 20,
    },
    content: {
        flex: 1,
        padding: SPACING.l,
    },
    timerContainer: {
        alignItems: 'center',
        marginBottom: SPACING.l,
    },
    timerText: {
        fontSize: 52,
        fontWeight: '800',
        color: '#4A8EE8',
        fontVariant: ['tabular-nums'],
        letterSpacing: -1,
    },
    timerLabel: {
        fontSize: 11,
        color: '#9CA3AF',
        marginTop: SPACING.s,
        fontWeight: '600',
        letterSpacing: 2,
        textTransform: 'uppercase',
    },
    progressBarContainer: {
        height: 6,
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 3,
        marginBottom: SPACING.xl,
        overflow: 'hidden',
    },
    progressBar: {
        height: '100%',
        backgroundColor: '#4A8EE8',
        borderRadius: 3,
    },
    messageBox: {
        flexDirection: 'row',
        backgroundColor: 'rgba(74,142,232,0.08)',
        padding: SPACING.m,
        borderRadius: 18,
        gap: SPACING.m,
        marginBottom: SPACING.l,
        borderWidth: 1,
        borderColor: 'rgba(74,142,232,0.25)',
    },
    messageIconWrap: {
        width: 40,
        height: 40,
        borderRadius: 14,
        backgroundColor: 'rgba(74,142,232,0.14)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    messageContent: {
        flex: 1,
    },
    messageTitle: {
        fontSize: 14,
        fontWeight: '700',
        color: COLORS.text,
        marginBottom: 4,
    },
    messageText: {
        fontSize: 13,
        color: '#8B929E',
        lineHeight: 18,
    },
    checklistBox: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        padding: SPACING.m,
        borderRadius: 18,
        marginBottom: SPACING.l,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
    },
    checklistTitle: {
        fontSize: 11,
        fontWeight: '600',
        color: '#9CA3AF',
        marginBottom: SPACING.m,
        letterSpacing: 2,
        textTransform: 'uppercase',
    },
    checklistItem: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
        marginBottom: SPACING.s,
    },
    checklistText: {
        fontSize: 14,
        color: COLORS.chromeMuted,
        flex: 1,
    },
    rushCheckBox: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        padding: SPACING.m,
        borderRadius: 18,
        marginBottom: SPACING.l,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
    },
    rushCheckTitle: {
        fontSize: 16,
        fontWeight: '700',
        color: COLORS.text,
        marginBottom: SPACING.s,
    },
    rushCheckQuestion: {
        fontSize: 14,
        color: COLORS.chromeMuted,
        marginBottom: SPACING.m,
        lineHeight: 20,
    },
    rushButton: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: SPACING.m,
        borderRadius: 18,
        gap: SPACING.s,
        marginBottom: SPACING.s,
        borderWidth: 1,
    },
    rushButtonNo: {
        backgroundColor: 'rgba(0,230,118,0.08)',
        borderColor: 'rgba(0,230,118,0.30)',
    },
    rushButtonYes: {
        backgroundColor: 'rgba(255,71,87,0.08)',
        borderColor: 'rgba(255,71,87,0.30)',
    },
    rushButtonText: {
        flex: 1,
        fontSize: 14,
        color: COLORS.text,
        lineHeight: 20,
    },
    blockedBox: {
        alignItems: 'center',
        backgroundColor: 'rgba(255,71,87,0.08)',
        padding: SPACING.l,
        borderRadius: 22,
        borderWidth: 1,
        borderColor: 'rgba(255,71,87,0.30)',
    },
    blockedIconWrap: {
        width: 72,
        height: 72,
        borderRadius: 22,
        backgroundColor: 'rgba(255,71,87,0.14)',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: SPACING.s,
    },
    blockedTitle: {
        fontSize: 20,
        fontWeight: '700',
        color: COLORS.error,
        marginTop: SPACING.s,
        marginBottom: SPACING.s,
    },
    blockedText: {
        fontSize: 14,
        color: COLORS.text,
        textAlign: 'center',
        marginBottom: SPACING.m,
        lineHeight: 20,
    },
    blockedAdvice: {
        fontSize: 12,
        color: '#8B929E',
        textAlign: 'center',
        marginBottom: SPACING.l,
        lineHeight: 18,
    },
    supportButton: {
        backgroundColor: '#4A8EE8',
        paddingHorizontal: SPACING.xl,
        paddingVertical: SPACING.m,
        borderRadius: 28,
        shadowColor: '#4A8EE8',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 16,
        elevation: 8,
    },
    supportButtonText: {
        color: '#0B0E14',
        fontSize: 16,
        fontWeight: '700',
    },
    footer: {
        padding: SPACING.l,
        borderTopWidth: 1,
        borderTopColor: 'rgba(200,205,214,0.08)',
    },
    cancelButton: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        padding: SPACING.m,
        borderRadius: 28,
        alignItems: 'center',
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
    },
    cancelButtonText: {
        color: COLORS.chromeMuted,
        fontSize: 16,
        fontWeight: '600',
    },
    proceedButton: {
        backgroundColor: '#4A8EE8',
        padding: SPACING.m,
        borderRadius: 28,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: SPACING.s,
        shadowColor: '#4A8EE8',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 16,
        elevation: 8,
    },
    proceedButtonText: {
        color: '#0B0E14',
        fontSize: 16,
        fontWeight: '700',
    },
});

export default CoolingPeriod;
