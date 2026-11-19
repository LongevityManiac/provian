import React, { useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { BORDER_RADIUS, COLORS, SPACING } from '../constants/theme';
import type { AppParamList } from '../navigation/types';
import { DestinationRow } from './ScreenActions';

export function AppMenu() {
    const { t } = useTranslation();
    const navigation = useNavigation<NativeStackNavigationProp<AppParamList>>();
    const [open, setOpen] = useState(false);
    const select = (screen: 'Vision' | 'BuildWithProvian' | 'Settings') => {
        setOpen(false);
        navigation.navigate(screen);
    };
    return (
        <>
            <Pressable accessibilityRole="button" accessibilityLabel={t('overhaul.menu')}
                onPress={() => setOpen(true)} style={styles.button}>
                <Ionicons name="menu-outline" size={26} color={COLORS.text} />
            </Pressable>
            <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
                <View style={styles.overlay}>
                    <Pressable style={StyleSheet.absoluteFillObject} accessibilityRole="button"
                        accessibilityLabel={t('common.close')} onPress={() => setOpen(false)} />
                    <View style={styles.menu} accessibilityViewIsModal>
                        <DestinationRow label={t('nav.vision')} stockIcon="compass-outline" onPress={() => select('Vision')} />
                        <DestinationRow label={t('overhaul.buildTitle')} stockIcon="code-slash-outline" onPress={() => select('BuildWithProvian')} />
                        <DestinationRow label={t('settings.title')} stockIcon="settings-outline" onPress={() => select('Settings')} />
                    </View>
                </View>
            </Modal>
        </>
    );
}

const styles = StyleSheet.create({
    button: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end', padding: SPACING.l, paddingBottom: 45 },
    menu: { backgroundColor: COLORS.surface, borderRadius: BORDER_RADIUS.l, borderColor: COLORS.border, borderWidth: 1, padding: SPACING.m },
});
