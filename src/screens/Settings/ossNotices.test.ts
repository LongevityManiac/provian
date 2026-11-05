/**
 * The Open Source Licenses screen reads the generated notices: every third-party component is
 * listed once per platform with a license and a resolvable text, dev-only tooling is not, native
 * components ship labelled with their platform, and the Legal screen opens the generated screen
 * instead of the old representative alert.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OSS_NOTICES, OSS_LICENSE_TEXTS } from './ossNotices.generated';
import type { OssNotice } from './ossNoticeTypes';
import { noticeKey, noticeLineKey, noticeText, PLATFORM_LABEL_KEYS } from './ossNoticeText';

const root = resolve(__dirname, '../../..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
const en = JSON.parse(readFileSync(resolve(root, 'src/i18n/locales/en.json'), 'utf8')) as Record<string, unknown>;

function noticeProblems(notices: readonly OssNotice[], texts: readonly string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const n of notices) {
        const key = noticeKey(n);
        if (seen.has(key)) out.push(`duplicate ${key}`);
        seen.add(key);
        if (!n.name || !n.version || !n.license || !Object.hasOwn(PLATFORM_LABEL_KEYS, n.platform)) out.push(`incomplete ${key}`);
        if (n.text !== -1 && (n.text < 0 || n.text >= texts.length || !texts[n.text].trim())) out.push(`dangling text ${key}`);
    }
    return out;
}

// Libraries whose shipped artifact carries Google's bundled license terms and third-party notices.
const BUNDLING_GROUPS = /^com\.google\.(android\.gms|android\.play|mlkit|android\.odml):|^com\.android\.billingclient:/;

/** Notices that would read "does not include a license file" although the library bundles its terms. */
function misstatedLicenseFiles(notices: readonly OssNotice[]): string[] {
    return notices.filter((n) => BUNDLING_GROUPS.test(n.name) && noticeLineKey(n) === 'ossNotices.noLicenseFile').map(noticeKey);
}

function lookup(obj: unknown, path: string): unknown {
    return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

describe('generated open source notices', () => {
    it('lists every component once per platform with a license and a resolvable text', () => {
        expect(OSS_NOTICES.length).toBeGreaterThan(1000);
        expect(noticeProblems(OSS_NOTICES, OSS_LICENSE_TEXTS)).toEqual([]);
        expect(OSS_NOTICES.filter((n) => n.text >= 0).length).toBeGreaterThan(OSS_NOTICES.length / 2);
    });

    it('covers every direct runtime dependency and no dev-only tool', () => {
        const names = new Set(OSS_NOTICES.filter((n) => n.platform === 'npm').map((n) => n.name));
        const direct = Object.keys(pkg.dependencies);
        expect(direct.length).toBeGreaterThan(20);
        expect(direct.filter((d) => !names.has(d))).toEqual([]);
        const devOnly = Object.keys(pkg.devDependencies).filter((d) => !(d in pkg.dependencies));
        expect(['vitest', 'typescript'].every((d) => devOnly.includes(d))).toBe(true);
        expect(devOnly.filter((d) => names.has(d) && ['vitest', 'typescript', 'jest'].includes(d))).toEqual([]);
    });

    it('carries the native components of both binaries, each labelled with its platform', () => {
        const on = (platform: OssNotice['platform']) => OSS_NOTICES.filter((n) => n.platform === platform).map((n) => n.name);
        expect(on('ios')).toEqual(expect.arrayContaining(['ZXingObjC', 'CocoaAsyncSocket', 'YttriumWrapper', 'hermes-engine', 'SocketRocket']));
        expect(on('ios-android')).toEqual(expect.arrayContaining(['folly', 'glog', 'fmt', 'double-conversion']));
        expect(on('android')).toEqual(expect.arrayContaining(['androidx.core:core', 'com.squareup.okhttp3:okhttp', 'com.google.firebase:firebase-messaging', 'com.facebook.react:hermes-android']));
        expect(on('android').length).toBeGreaterThan(150);
        for (const key of Object.values(PLATFORM_LABEL_KEYS)) expect(typeof lookup(en, key)).toBe('string');
    });

    it('RED: a duplicate, an incomplete entry, an unknown platform and a dangling text index are caught', () => {
        const base = OSS_NOTICES[0];
        expect(noticeProblems([base, base], OSS_LICENSE_TEXTS)).toEqual([`duplicate ${noticeKey(base)}`]);
        expect(noticeProblems([{ ...base, license: '' }], OSS_LICENSE_TEXTS)).toEqual([`incomplete ${noticeKey(base)}`]);
        const unknown = { ...base, platform: 'web' } as unknown as OssNotice;
        expect(noticeProblems([unknown], OSS_LICENSE_TEXTS)).toEqual([`incomplete ${noticeKey(unknown)}`]);
        expect(noticeProblems([{ ...base, text: OSS_LICENSE_TEXTS.length }], OSS_LICENSE_TEXTS)).toEqual([`dangling text ${noticeKey(base)}`]);
        // The same name and version on two platforms are two notices.
        expect(noticeProblems([base, { ...base, platform: base.platform === 'ios' ? 'android' : 'ios' }], OSS_LICENSE_TEXTS)).toEqual([]);
    });

    it('says a Google library ships a third-party notices file instead of claiming it ships no license file', () => {
        const runtime = JSON.parse(readFileSync(resolve(root, 'scripts/oss-notices/android-runtime.json'), 'utf8')) as { artifacts: { id: string; bundledNotices?: true }[] };
        const bundledIds = runtime.artifacts.filter((a) => a.bundledNotices).map((a) => a.id);
        expect(bundledIds.length).toBeGreaterThanOrEqual(24);
        expect(bundledIds).toEqual(expect.arrayContaining(['com.google.android.play:integrity:1.4.0', 'com.google.android.play:core-common:2.0.4', 'com.google.mlkit:barcode-scanning:17.3.0']));
        const bundled = OSS_NOTICES.filter((n) => n.notice === 'bundled_not_reproduced');
        expect(bundled.map((n) => `${n.name}:${n.version}`).sort()).toEqual([...bundledIds].sort());
        expect(bundled.filter((n) => n.text === -1).length).toBeGreaterThanOrEqual(24);
        expect(misstatedLicenseFiles(OSS_NOTICES)).toEqual([]);
        for (const key of ['ossNotices.bundledNotReproduced', 'ossNotices.bundledAlsoNotReproduced', 'ossNotices.noLicenseFile']) expect(typeof lookup(en, key)).toBe('string');
    });

    it('RED: a bundled library stripped of its state reads as shipping no license file, and is caught', () => {
        const bundled = OSS_NOTICES.find((n) => n.notice === 'bundled_not_reproduced' && n.text === -1);
        expect(bundled).toBeDefined();
        if (!bundled) return;
        expect(noticeLineKey(bundled)).toBe('ossNotices.bundledNotReproduced');
        const stripped: OssNotice = { name: bundled.name, version: bundled.version, platform: bundled.platform, license: bundled.license, text: -1 };
        expect(noticeLineKey(stripped)).toBe('ossNotices.noLicenseFile');
        expect(misstatedLicenseFiles([stripped])).toEqual([noticeKey(stripped)]);
        const withText = OSS_NOTICES.find((n) => n.notice === 'bundled_not_reproduced' && n.text >= 0);
        if (withText) expect(noticeLineKey(withText)).toBe('ossNotices.bundledAlsoNotReproduced');
    });

    it('does not claim an exact total or that every unlisted notice travels inside its component', () => {
        const locales = ['en', 'es', 'fr', 'hi', 'id', 'ja', 'ko', 'pt', 'sw', 'tl', 'vi', 'zh'];
        for (const loc of locales) {
            const copy = JSON.parse(readFileSync(resolve(root, `src/i18n/locales/${loc}.json`), 'utf8')) as { ossNotices: Record<string, unknown> };
            const questions = String(copy.ossNotices.questions);
            expect(questions).toContain('Yttrium');
            expect(questions).toContain('Google');
            expect(questions).toContain('hello@provian.ai');
            // The bundled lines name the notices file the library ships, and take the component's own
            // license from the declared license rather than claiming where its terms are.
            expect(String(copy.ossNotices.bundledNotReproduced)).toContain('third_party_licenses.txt');
            expect(String(copy.ossNotices.bundledNotReproduced)).toContain('{{license}}');
            expect(String(copy.ossNotices.bundledAlsoNotReproduced)).toContain('third_party_licenses.txt');
        }
        const intro = String(lookup(en, 'ossNotices.intro'));
        expect(intro).not.toMatch(/built with \{\{count\}\}/);
        // The npm closure includes build tools no binary ships, so the list is of components used to
        // build or run the apps, not components "in" them.
        expect(intro).toMatch(/itemizes \{\{count\}\} third-party components used to build or run/);
        expect(String(lookup(en, 'ossNotices.questions'))).not.toMatch(/carry the notices/);
        for (const key of ['ossNotices.bundledNotReproduced', 'ossNotices.bundledAlsoNotReproduced']) {
            expect(String(lookup(en, key))).not.toMatch(/own license terms|carries its own/);
        }
    });

    it('shows the shipped text, or none for a component without a license file', () => {
        const withText = OSS_NOTICES.find((n) => n.text >= 0);
        const without = OSS_NOTICES.find((n) => n.text === -1);
        expect(withText && noticeText(withText)).toBe(withText && OSS_LICENSE_TEXTS[withText.text]);
        if (without) expect(noticeText(without)).toBeNull();
        expect(noticeText({ name: 'x', version: '1', platform: 'npm', license: 'MIT', text: 1e9 })).toBeNull();
    });

    it('the Legal screen opens the generated notices, not a representative alert', () => {
        const legal = readFileSync(resolve(__dirname, 'LegalScreen.tsx'), 'utf8');
        expect(legal).toContain("navigation.navigate('OpenSourceNotices')");
        expect(legal).not.toContain('openSourceLicensesBody');
        expect(readFileSync(resolve(root, 'src/navigation/AppNavigator.tsx'), 'utf8')).toContain('<Stack.Screen name="OpenSourceNotices" component={OpenSourceNoticesScreen} />');
        expect(JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).scripts['check:copy']).toContain('npm run check:oss-notices');
    });
});
