import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import i18next from 'i18next';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KNOWN_ACTION_TYPES, getActionTypeDisplay, getActionTypeDescription } from '../utils/actionTypeDisplay';
import { mapAgentOnboardingError } from '../core/agents/agentOnboardingErrors';
import { buildEarningChip } from '../utils/peDisposition';

type Copy = { [key: string]: string | Copy };
function flatten(copy: Copy, prefix = ''): Record<string, string> {
    return Object.fromEntries(Object.entries(copy).flatMap(([key, value]) =>
        typeof value === 'string' ? [[prefix + key, value]] : Object.entries(flatten(value, prefix + key + '.'))));
}
const localeDir = join(import.meta.dirname, 'locales');
const resources = Object.fromEntries(readdirSync(localeDir).filter(name => name.endsWith('.json')).map(name =>
    [name.slice(0, -5), { translation: JSON.parse(readFileSync(join(localeDir, name), 'utf8')) as Copy }]));
const english = flatten(resources.en.translation);
const placeholders = (value: string) => [...new Set([...value.matchAll(/{{\s*([^}]+?)\s*}}/g)].map(match => match[1]))].sort();

function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const path = join(dir, entry.name);
        return entry.isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(entry.name) && !entry.name.includes('.test.') ? [path] : [];
    });
}

function localeProblems(copy: Record<string, string>, locale: string): string[] {
    const problems: string[] = [];
    for (const key of Object.keys(copy)) {
        if (key !== '_translator_note' && !(key in english)) problems.push(`extra key: ${key}`);
    }
    for (const [key, value] of Object.entries(english)) {
        if (!(key in copy)) { problems.push(`missing key: ${key}`); continue; }
        // These languages put the verb after the interpolated recipient's name.
        const emptyPrefix = key === 'trustLayer.requester.ledeAskLead' && ['ja', 'ko', 'hi'].includes(locale);
        if (!emptyPrefix && !copy[key].trim()) problems.push(`empty value: ${key}`);
        if (JSON.stringify(placeholders(copy[key])) !== JSON.stringify(placeholders(value))) problems.push(`placeholder drift: ${key}`);
    }
    return problems;
}

function literalReferences(path: string, text: string): string[] {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const keys: string[] = [];
    const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && /^(?:t|translate|i18next\.t|i18n\.t)$/.test(node.expression.getText(source))) {
            const key = node.arguments[0];
            if (key && ts.isStringLiteralLike(key)) keys.push(key.text);
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return keys;
}
const missingReferences = (keys: string[]) => keys.filter(key =>
    !(key in english) && !(`${key}_one` in english) && !(`${key}_other` in english));

describe('Translation coverage for the actual app sources', () => {
    it('all 12 locales have the English key set and preserve interpolation names', () => {
        expect(Object.keys(resources)).toHaveLength(12);
        for (const [locale, resource] of Object.entries(resources)) {
            expect(localeProblems(flatten(resource.translation), locale), locale).toEqual([]);
        }
    });

    it('RED: rejects missing/extra/empty copy and renamed interpolation variables', () => {
        const corrupted = { ...english };
        delete corrupted['ui.peViewer.device'];
        corrupted['notTranslated.newControl'] = 'Untranslated';
        corrupted['ui.backupBanner.body'] = '';
        corrupted['notifications.receivedBody'] = english['notifications.receivedBody'].replace('{{symbol}}', '{{asset}}');
        expect(localeProblems(corrupted, 'en')).toEqual([
            'extra key: notTranslated.newControl',
            'empty value: ui.backupBanner.body',
            'missing key: ui.peViewer.device',
            'placeholder drift: notifications.receivedBody',
        ]);
    });

    it('every literal t()/translate() reference resolves, including plural-only keys', () => {
        const missing: string[] = [];
        let references = 0;
        for (const path of sourceFiles(join(import.meta.dirname, '..'))) {
            const keys = literalReferences(path, readFileSync(path, 'utf8'));
            references += keys.length;
            missing.push(...missingReferences(keys).map(key => `${path}: ${key}`));
        }
        expect(references).toBeGreaterThan(2000);
        expect(missing).toEqual([]);
    });

    it('RED: catches a planted missing reference while accepting a real plural-only key', () => {
        const keys = literalReferences('control.tsx', `t('notTranslated.newButton'); i18next.t('settleNow.ready', { count: 1 });`);
        expect(keys).toEqual(['notTranslated.newButton', 'settleNow.ready']);
        expect(missingReferences(keys)).toEqual(['notTranslated.newButton']);
    });
});

describe('Shared PE display follows the selected language', () => {
    beforeAll(async () => { await i18next.init({ resources, lng: 'en', fallbackLng: 'en', interpolation: { escapeValue: false } }); });
    afterAll(async () => { await i18next.changeLanguage('en'); });

    it('switches existing action labels, descriptions and chips across all locales without changing amounts', async () => {
        for (const language of Object.keys(resources)) {
            await i18next.changeLanguage(language);
            for (const actionType of KNOWN_ACTION_TYPES) {
                const key = `actionTypes.labels.${actionType.replace(/:/g, '_')}`;
                expect(i18next.exists(key), `${language}: ${actionType}`).toBe(true);
                expect(getActionTypeDisplay(actionType).label).toBe(i18next.t(key));
            }
            expect(getActionTypeDescription('service:github_commit')).toBe(i18next.t('actionTypes.descriptions.service_github_commit'));
            expect(getActionTypeDescription('future_unknown')).toBe(i18next.t('actionTypes.overview'));
            const chip = buildEarningChip({ mintStatus: 'eligible', currentSettlementProjectionPVT: '1.2345' });
            expect(chip?.label).toContain('1.2345 PVT');
            expect(chip?.label).not.toContain('{{');
            expect(chip?.disposition).toBe('earning');
            const record = buildEarningChip({ mintStatus: 'record_only', currentSettlementProjectionPVT: '999' });
            expect(record?.label).toBe(i18next.t('pe.disposition.recordOnly.label'));
            expect(record?.label).not.toContain('999');
            expect(record?.explainer).toBe(i18next.t('pe.disposition.recordOnly.explainer'));
            expect(buildEarningChip({ mintStatus: 'future_unknown' })).toBeNull();
            const recovery = mapAgentOnboardingError('HTTP 404: no_recovery_escrow');
            expect(recovery.message).toBe(i18next.t('agentOnboardingErrors.no_recovery_escrow.message'));
            expect(recovery.action).toBe(i18next.t('agentOnboardingErrors.no_recovery_escrow.action'));
            const unknown = mapAgentOnboardingError('sensitive_machine_error_123');
            expect(unknown.message).toBe(i18next.t('agentOnboardingErrors.generic.message'));
            expect(unknown.message + unknown.action).not.toContain('sensitive_machine_error_123');
        }
    });
});
