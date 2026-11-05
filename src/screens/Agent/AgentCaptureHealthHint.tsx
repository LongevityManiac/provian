/**
 * The "Not receiving work" hint, on an agent's card in Agent Hub and on the
 * agent's own page: that agent's capture health, and the line to send the agent to start its
 * observer. When the agent fixes the state with one command of its own (no launcher recorded, or a
 * harness change), that line is offered too. Each line copies on tap.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING } from '../../constants/theme';
import { captureHealthHint } from '../../core/agents/captureHealthHint';
import { AGENT_START_OBSERVER_CMD } from '../../core/agents/agentShellCommands';

export interface AgentCaptureHealthHintProps {
    /** `capture_broken_reason` from the relay's linked-agent record. */
    reason: unknown;
    /** The agent's earning computer has reported capture health at least once. */
    reported: boolean;
    /** Smaller type for the Agent Hub card. */
    compact?: boolean;
}

const AgentCaptureHealthHint = ({ reason, reported, compact }: AgentCaptureHealthHintProps): React.JSX.Element => {
    const { t } = useTranslation();
    const hint = captureHealthHint({ reason, reported });
    const [copied, setCopied] = useState<string | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
    const copy = useCallback(async (cmd: string) => {
        await Clipboard.setStringAsync(cmd);
        setCopied(cmd);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(null), 1800);
    }, []);

    const line = (label: string, cmd: string): React.JSX.Element => (
        <View key={cmd}>
            <Text style={[styles.label, compact && styles.compactText]}>{label}</Text>
            <TouchableOpacity
                style={styles.cmdRow}
                onPress={() => void copy(cmd)}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={t('agentHub.copyLine')}
            >
                <Text style={styles.cmdText} numberOfLines={1} ellipsizeMode="middle" selectable>{cmd}</Text>
                <Ionicons
                    name={copied === cmd ? 'checkmark-circle' : 'copy-outline'}
                    size={14}
                    color={copied === cmd ? COLORS.success : COLORS.primary}
                />
            </TouchableOpacity>
        </View>
    );

    return (
        <View style={styles.wrap}>
            <Text style={[styles.health, compact && styles.compactText]}>{t(hint.lineKey)}</Text>
            {hint.fixCommand ? line(t('agentHub.sendFixLine'), hint.fixCommand) : null}
            {line(t('agentHub.sendObserverLine'), AGENT_START_OBSERVER_CMD)}
        </View>
    );
};

const styles = StyleSheet.create({
    wrap: { marginTop: SPACING.s, gap: SPACING.xs },
    health: { fontSize: 12, color: COLORS.textSecondary, lineHeight: 17 },
    label: { fontSize: 12, color: COLORS.textSecondary, lineHeight: 17, marginTop: 2 },
    compactText: { fontSize: 11, lineHeight: 15 },
    cmdRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
        marginTop: 4,
        paddingVertical: 6,
        paddingHorizontal: SPACING.s,
        borderRadius: 8,
        backgroundColor: 'rgba(74,142,232,0.10)',
    },
    cmdText: { flex: 1, fontSize: 11, color: '#C8D0DC', fontFamily: 'Courier' },
});

export default AgentCaptureHealthHint;
