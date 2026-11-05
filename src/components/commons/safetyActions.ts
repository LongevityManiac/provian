/**
 * The two Commons safety actions every post, reply and profile offers, free and private:
 * - Report to Provian: opens an email to Provian with the item's link (`core/commons/reportToProvian`).
 * - Block: hides the author's content on this phone (`store/commonsBlockStore`).
 * Neither is a Commons write: nothing is signed, minted or burned, and the author is not told.
 */
import { Alert, Linking } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import type { TFunction } from 'i18next';
import { REPORT_EMAIL, reportLink, reportMailto, type ReportTarget } from '../../core/commons/reportToProvian';
import { useCommonsBlockStore } from '../../store/commonsBlockStore';

export async function openReportToProvian(t: TFunction, target: ReportTarget): Promise<void> {
    const link = reportLink(target);
    const isPost = target.kind === 'post';
    const id = isPost ? target.postId : target.walletId;
    const who = isPost ? (target.authorName ?? target.authorWalletId) : (target.name ?? target.walletId);
    const subject = isPost ? t('commonsSafety.reportSubjectPost', { id }) : t('commonsSafety.reportSubjectProfile', { id });
    const body = t('commonsSafety.reportBody', { kind: isPost ? t('commonsSafety.kindPost') : t('commonsSafety.kindProfile'), who, link });
    const url = reportMailto({ subject, body });
    try {
        await Linking.openURL(url);
        return;
    } catch {
        // No mail app: say where to send it, and offer the link to copy.
    }
    Alert.alert(t('commonsSafety.report'), t('commonsSafety.reportNoMail', { email: REPORT_EMAIL, link }), [
        { text: t('commonsSafety.copyLink'), onPress: () => { void Clipboard.setStringAsync(`${REPORT_EMAIL}\n${link}`); } },
        { text: t('common.ok') },
    ]);
}

/** Confirm, then block. `onBlocked` runs after the author is blocked (e.g. leave their profile). */
export function confirmBlock(t: TFunction, walletId: string, name: string | null, onBlocked?: () => void): void {
    const display = name ?? t('commonsSafety.thisAuthor');
    Alert.alert(t('commonsSafety.blockTitle', { name: display }), t('commonsSafety.blockBody'), [
        { text: t('common.cancel'), style: 'cancel' },
        {
            text: t('commonsSafety.blockConfirm'),
            style: 'destructive',
            onPress: () => {
                void useCommonsBlockStore.getState().block(walletId, name).then(() => onBlocked?.());
            },
        },
    ]);
}
