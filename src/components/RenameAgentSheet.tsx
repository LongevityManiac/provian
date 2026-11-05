import { errorDisplayCopy } from '../i18n/displayCopy';
/**
 * RenameAgentSheet (item 5) — the human names (or renames) a linked agent. One small bottom sheet
 * (a transparent Modal — Alert.prompt does nothing on Android), used from the Agent Hub cards and
 * the agent detail header. It saves through POST /v1/agent/wallet/:wallet_id/human-name: the name
 * is display metadata, the agent's identity stays its key, and no PE is sealed. Theme only.
 *
 * on Android the sheet is hosted INLINE (an absolute overlay the parent screen renders as
 * its last child), not in a Modal — under edge-to-edge a Modal's dialog never resizes for the
 * keyboard and its IME is invisible to KeyboardAvoidingView, so the field and Save sat under the
 * keyboard. Inline, the KeyboardAvoidingView pads the sheet up above it (see utils/keyboardLayout).
 */
import React, { useEffect, useState } from 'react';
import {
    ActivityIndicator, BackHandler, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput,
    TouchableOpacity, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS } from '../constants/theme';
import RelayAPIService from '../services/RelayAPIService';
import { checkAgentName, AGENT_NAME_MAX } from '../core/agents/agentDisplayName';
import { bottomSheetHost, keyboardAvoidingBehavior } from '../utils/keyboardLayout';

interface Props {
    visible: boolean;
    /** The agent being renamed; null closes the sheet. */
    agentWalletId: string | null;
    currentName: string;
    onClose: () => void;
    /** Called with the saved name after the relay accepted it. */
    onSaved: (displayName: string) => void;
}

export default function RenameAgentSheet({ visible, agentWalletId, currentName, onClose, onSaved }: Props): React.JSX.Element {
    const { t } = useTranslation();
    const [name, setName] = useState(currentName);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (visible) {
            setName(currentName);
            setError(null);
            setSaving(false);
        }
    }, [visible, currentName]);

    const save = async () => {
        if (!agentWalletId) return;
        const check = checkAgentName(name);
        if (!check.ok) {
            setError(check.error === 'required' ? t('agentName.errorRequired')
                : check.error === 'tooLong' ? t('agentName.errorTooLong', { max: AGENT_NAME_MAX })
                    : t('agentName.errorMarkup'));
            return;
        }
        if (check.value === currentName.trim()) {
            onClose();
            return;
        }
        setSaving(true);
        setError(null);
        const result = await RelayAPIService.renameLinkedAgent(agentWalletId, check.value);
        setSaving(false);
        if (result.ok) {
            onSaved(result.displayName);
            return;
        }
        setError(result.error === 'agent_name_markup' ? t('agentName.errorMarkup')
            : result.error === 'agent_name_too_long' ? t('agentName.errorTooLong', { max: AGENT_NAME_MAX })
                : result.error === 'agent_name_required' ? t('agentName.errorRequired')
                    : t('agentName.errorSaveFailed'));
    };

    const host = bottomSheetHost(Platform.OS);

    // Inline host: the hardware back button closes the sheet, as the Modal's onRequestClose did.
    useEffect(() => {
        if (host !== 'inline' || !visible) return undefined;
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            if (!saving) onClose();
            return true;
        });
        return () => sub.remove();
    }, [host, visible, saving, onClose]);

    const content = (
            <KeyboardAvoidingView style={styles.overlay} behavior={keyboardAvoidingBehavior(Platform.OS)}>
                <Pressable
                    style={styles.backdrop}
                    onPress={saving ? undefined : onClose}
                    accessibilityRole="button"
                    accessibilityLabel={t('agentName.cancel')}
                />
                <View style={styles.sheet}>
                    <View style={styles.handle} />
                    <View style={styles.iconWrap}>
                        <Ionicons name="create-outline" size={22} color={COLORS.primary} />
                    </View>
                    <Text style={styles.title}>{t('agentName.renameTitle')}</Text>
                    <Text style={styles.body}>{t('agentName.renameBody')}</Text>
                    <TextInput
                        style={[styles.input, error ? styles.inputError : null]}
                        value={name}
                        onChangeText={(v) => { setName(v); if (error) setError(null); }}
                        placeholder={t('agentName.placeholder')}
                        placeholderTextColor={COLORS.textMuted}
                        maxLength={AGENT_NAME_MAX}
                        autoCapitalize="words"
                        autoCorrect={false}
                        autoFocus
                        editable={!saving}
                        returnKeyType="done"
                        onSubmitEditing={() => { void save(); }}
                        accessibilityLabel={t('agentName.placeholder')}
                    />
                    {error ? <Text style={styles.error}>{errorDisplayCopy(error)}</Text> : null}
                    <TouchableOpacity
                        style={[styles.primaryBtn, saving && styles.disabled]}
                        disabled={saving}
                        onPress={() => { void save(); }}
                        accessibilityRole="button"
                    >
                        {saving ? <ActivityIndicator color={COLORS.text} /> : (
                            <Text style={styles.primaryText}>{t('agentName.save')}</Text>
                        )}
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.secondaryBtn} onPress={onClose} disabled={saving} accessibilityRole="button">
                        <Text style={styles.secondaryText}>{t('agentName.cancel')}</Text>
                    </TouchableOpacity>
                </View>
            </KeyboardAvoidingView>
    );

    if (host === 'inline') {
        return visible ? <View style={styles.inlineHost}>{content}</View> : <></>;
    }
    return (
        <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
            {content}
        </Modal>
    );
}

const styles = StyleSheet.create({
    // Inline (Android) host: covers the whole screen above its content.
    inlineHost: { ...StyleSheet.absoluteFillObject, zIndex: 100, elevation: 24 },
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
    backdrop: { flex: 1 },
    sheet: {
        backgroundColor: COLORS.surfaceElevated,
        borderTopLeftRadius: BORDER_RADIUS.xl,
        borderTopRightRadius: BORDER_RADIUS.xl,
        paddingHorizontal: SPACING.l,
        paddingTop: SPACING.s,
        paddingBottom: SPACING.xl,
        borderWidth: 1,
        borderColor: COLORS.borderLight,
        borderBottomWidth: 0,
    },
    handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: BORDER_RADIUS.round, backgroundColor: COLORS.border, marginBottom: SPACING.m },
    iconWrap: {
        width: 44, height: 44, borderRadius: BORDER_RADIUS.round, backgroundColor: 'rgba(74,142,232,0.14)',
        alignItems: 'center', justifyContent: 'center', marginBottom: SPACING.m,
    },
    title: { fontSize: 18, fontWeight: '700', color: COLORS.text, marginBottom: SPACING.xs },
    body: { fontSize: 14, lineHeight: 20, color: COLORS.textSecondary, marginBottom: SPACING.m },
    input: {
        backgroundColor: COLORS.surface,
        borderRadius: BORDER_RADIUS.m,
        borderWidth: 1,
        borderColor: COLORS.border,
        color: COLORS.text,
        fontSize: 16,
        paddingHorizontal: SPACING.m,
        minHeight: 48,
    },
    inputError: { borderColor: COLORS.error },
    error: { fontSize: 12, lineHeight: 17, color: COLORS.error, marginTop: SPACING.xs },
    primaryBtn: {
        marginTop: SPACING.l, backgroundColor: COLORS.primary, borderRadius: BORDER_RADIUS.l, minHeight: 50,
        alignItems: 'center', justifyContent: 'center', paddingHorizontal: SPACING.m,
    },
    disabled: { opacity: 0.5 },
    primaryText: { fontSize: 16, fontWeight: '700', color: COLORS.text, textAlign: 'center' },
    secondaryBtn: { marginTop: SPACING.s, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    secondaryText: { fontSize: 16, color: COLORS.textSecondary },
});
