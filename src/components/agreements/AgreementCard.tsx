import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING } from '../../constants/theme';
import { ProvenanceEnvelope, PromiseStatus } from '../../core/provenance/types';

interface AgreementCardProps {
    envelope: ProvenanceEnvelope;
    status?: PromiseStatus;
    onPress: () => void;
}

const AgreementCard: React.FC<AgreementCardProps> = ({ envelope, status, onPress }) => {
    const details = envelope.agreement_details;

    // Fallback logic if status not provided (backward compatibility)
    const isSettled = status === 'KEPT' || envelope.action_type === 'agreement_settled' || !!(details as any)?.settledAt;
    const isAwaiting = status === 'AWAITING_CONFIRMATION';

    // Format date
    const date = new Date(envelope.timestamp).toLocaleDateString();

    // Truncate description
    const description = (details as any)?.description || envelope.intent_text || 'No description';
    const truncatedDesc = description.length > 50 ? description.substring(0, 50) + '...' : description;

    let iconName: keyof typeof Ionicons.glyphMap = "heart";
    let iconColor = '#4A8EE8';
    let badgeText = "OPEN";
    let badgeStyle = styles.openBadge;
    let badgeTextStyle = styles.openText;

    if (isSettled) {
        iconName = "checkmark-circle";
        iconColor = '#4CC38A';
        badgeText = "KEPT";
        badgeStyle = styles.settledBadge;
        badgeTextStyle = styles.settledText;
    } else if (isAwaiting) {
        iconName = "hourglass";
        iconColor = '#E8A838';
        badgeText = "WAITING";
        badgeStyle = styles.awaitingBadge;
        badgeTextStyle = styles.awaitingText;
    }

    return (
        <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.8}>
            <View style={[styles.iconContainer, { backgroundColor: `${iconColor}18` }]}>
                <Ionicons
                    name={iconName}
                    size={22}
                    color={iconColor}
                />
            </View>
            <View style={styles.content}>
                <Text style={styles.description}>{truncatedDesc}</Text>
                <View style={styles.metaRow}>
                    <Text style={styles.date}>{date}</Text>
                    <Text style={styles.party}>
                        With: {(details as any)?.partyB ? `${(details as any).partyB.substring(0, 6)}...` : 'Unknown'}
                    </Text>
                </View>
            </View>
            <View style={styles.statusContainer}>
                <View style={[styles.badge, badgeStyle]}>
                    <Text style={[styles.badgeText, badgeTextStyle]}>
                        {badgeText}
                    </Text>
                </View>
                <Ionicons name="chevron-forward" size={20} color="#9CA3AF" />
            </View>
        </TouchableOpacity>
    );
};

const styles = StyleSheet.create({
    card: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(18,21,26,0.70)',
        padding: SPACING.m,
        borderRadius: 18,
        marginBottom: SPACING.s,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.3,
        shadowRadius: 12,
        elevation: 5,
    },
    iconContainer: {
        width: 44,
        height: 44,
        borderRadius: 14,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: SPACING.m,
    },
    content: {
        flex: 1,
    },
    description: {
        fontSize: 15,
        fontWeight: '700',
        color: COLORS.text,
        marginBottom: 4,
    },
    metaRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
    },
    date: {
        fontSize: 12,
        color: '#9CA3AF',
    },
    party: {
        fontSize: 12,
        color: '#9CA3AF',
    },
    statusContainer: {
        alignItems: 'flex-end',
        gap: SPACING.xs,
    },
    badge: {
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 10,
    },
    openBadge: {
        backgroundColor: 'rgba(74,142,232,0.14)',
    },
    settledBadge: {
        backgroundColor: 'rgba(0,230,118,0.14)',
    },
    badgeText: {
        fontSize: 10,
        fontWeight: '700',
        letterSpacing: 1,
    },
    openText: {
        color: '#4A8EE8',
    },
    settledText: {
        color: '#4CC38A',
    },
    awaitingBadge: {
        backgroundColor: 'rgba(255,179,0,0.14)',
    },
    awaitingText: {
        color: '#E8A838',
    },
});

export default AgreementCard;
