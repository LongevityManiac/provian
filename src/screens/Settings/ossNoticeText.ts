import { OSS_LICENSE_TEXTS } from './ossNotices.generated';
import type { OssNotice, OssPlatform } from './ossNoticeTypes';

/** The license text shown for a notice, or null when the component ships no license file. */
export function noticeText(notice: OssNotice, texts: readonly string[] = OSS_LICENSE_TEXTS): string | null {
    return Number.isInteger(notice.text) && notice.text >= 0 && notice.text < texts.length ? texts[notice.text] : null;
}

/**
 * The i18n key of the line shown under a notice's text: the library carries terms and notices that
 * are not reproduced (with or without a reproduced text), or it ships no license file at all.
 * Null when the reproduced text is the whole story.
 */
export function noticeLineKey(notice: OssNotice, texts: readonly string[] = OSS_LICENSE_TEXTS): string | null {
    const hasText = noticeText(notice, texts) !== null;
    if (notice.notice === 'bundled_not_reproduced') return hasText ? 'ossNotices.bundledAlsoNotReproduced' : 'ossNotices.bundledNotReproduced';
    return hasText ? null : 'ossNotices.noLicenseFile';
}

/** A notice's unique key: the same name and version can ship on more than one platform. */
export function noticeKey(notice: OssNotice): string {
    return `${notice.platform} ${notice.name}@${notice.version}`;
}

/** The i18n key of each platform label. */
export const PLATFORM_LABEL_KEYS: Readonly<Record<OssPlatform, string>> = {
    npm: 'ossNotices.platform.npm',
    ios: 'ossNotices.platform.ios',
    android: 'ossNotices.platform.android',
    'ios-android': 'ossNotices.platform.iosAndroid',
};
