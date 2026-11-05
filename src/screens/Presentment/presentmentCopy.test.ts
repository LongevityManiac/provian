/**
 * §9 — the presenter / requester screens' copy lives in the locales, and the requester's
 * suggested fields are real reputation-vocabulary fields.
 *
 * 1. Every literal i18n key the two screens (and the Own Profile group labels) read exists in
 * en.json — full-locale key parity is enforced separately by onboardingNarrativeParity.test.ts,
 * so existing in en.json means existing in all 12 locales.
 * 2. Every field the requester screen suggests or presets is a fixed field the relay's vocabulary
 * computes (the relay refuses a predicate on an unknown field — `money.inbound_independent_parties`
 * shipped once and could never be answered).
 *
 * Both guards bind to the single sources they check (the screen source, en.json, the relay's
 * vocabulary.ts) and carry RED controls plus non-empty-population controls.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import en from '../../i18n/locales/en.json';

const ROOT = resolve(__dirname, '../../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

const PRESENTER_SRC = read('src/screens/Presentment/HumanPresentmentScreen.tsx');
const REQUESTER_SRC = read('src/screens/Presentment/PresentationRequesterScreen.tsx');
const VOCABULARY_SRC = read('provian-backend/src/core/presentation/vocabulary.ts');

function lookup(key: string): unknown {
    let node: unknown = en;
    for (const part of key.split('.')) {
        if (node === null || typeof node !== 'object') return undefined;
        node = (node as Record<string, unknown>)[part];
    }
    return node;
}

/** A key resolves when it is a string leaf, or an i18next plural base (`_one` + `_other`). */
function keyExists(key: string): boolean {
    if (typeof lookup(key) === 'string') return true;
    return typeof lookup(`${key}_one`) === 'string' && typeof lookup(`${key}_other`) === 'string';
}

/** Every quoted `trustLayer.*` / `commons*.*` / `common.*` key literal in a source file. */
function literalKeys(src: string): string[] {
    const keys = new Set<string>();
    for (const m of src.matchAll(/'((?:trustLayer|commons|commonsJobs|commonsHumanJobManage|common)\.[A-Za-z0-9_.]+)'/g)) keys.add(m[1]);
    // A `const PREFIX = '<namespace>'` literal names a namespace the screen builds keys under
    // (checked through presetKeys), not a key itself.
    for (const m of src.matchAll(/const [A-Z_]+ = '([A-Za-z0-9_.]+)';/g)) {
        const node = lookup(m[1]);
        if (node !== null && typeof node === 'object') keys.delete(m[1]);
    }
    return [...keys].sort();
}

/** The requester's preset keys are built from `${PRESET}.<key>.label|help`. */
function presetKeys(src: string): string[] {
    const keys: string[] = [];
    for (const m of src.matchAll(/\{ key: '([a-z]+)', label: `\$\{PRESET\}\.([a-z]+)\.label`, help: `\$\{PRESET\}\.([a-z]+)\.help`/g)) {
        keys.push(`trustLayer.requester.preset.${m[2]}.label`, `trustLayer.requester.preset.${m[3]}.help`);
    }
    return keys;
}

/** The fixed facts the relay's vocabulary computes (`facts['a.b'] = …`). */
function vocabularyFields(src: string): Set<string> {
    return new Set([...src.matchAll(/facts\['([a-z_]+\.[a-z0-9_.]+)'\]\s*=/g)].map((m) => m[1]));
}

/** Every field the requester screen suggests or presets. */
function requesterFields(src: string): string[] {
    const suggested = /const SUGGESTED_FIELDS = \[([\s\S]*?)\];/.exec(src);
    const fields = new Set<string>();
    for (const m of (suggested?.[1] ?? '').matchAll(/'([a-z_]+\.[a-z0-9_.]+)'/g)) fields.add(m[1]);
    for (const m of src.matchAll(/field: '([a-z_]+\.[a-z0-9_.]+)'/g)) fields.add(m[1]);
    return [...fields].sort();
}

describe('presentment screens read only keys that exist', () => {
    const keys = [
        ...literalKeys(PRESENTER_SRC),
        ...literalKeys(REQUESTER_SRC),
        ...presetKeys(REQUESTER_SRC),
        'trustLayer.ownProfile.group.share',
    ];

    it('evaluates a non-trivial population (empty-population control)', () => {
        expect(literalKeys(PRESENTER_SRC).length).toBeGreaterThan(50);
        expect(literalKeys(REQUESTER_SRC).length).toBeGreaterThan(50);
        expect(presetKeys(REQUESTER_SRC)).toHaveLength(14);
    });

    it('every key resolves in en.json', () => {
        expect(keys.filter((k) => !keyExists(k))).toEqual([]);
    });

    it('RED — a missing key is caught', () => {
        expect(keyExists('trustLayer.presenter.noSuchKey')).toBe(false);
        expect(keyExists('trustLayer.presenter.summaryExtra')).toBe(true); // plural base
    });
});

describe('requester suggested fields are real vocabulary fields', () => {
    const vocab = vocabularyFields(VOCABULARY_SRC);

    it('evaluates a non-trivial population (empty-population control)', () => {
        expect(vocab.size).toBeGreaterThan(30);
        expect(requesterFields(REQUESTER_SRC).length).toBeGreaterThanOrEqual(10);
    });

    it('every suggested / preset field is computed by the relay vocabulary', () => {
        expect(requesterFields(REQUESTER_SRC).filter((f) => !vocab.has(f))).toEqual([]);
    });

    it('RED — the retired non-field is refused', () => {
        const planted = REQUESTER_SRC.replace("'money.witnessed_financial'", "'money.inbound_independent_parties'");
        expect(planted).not.toBe(REQUESTER_SRC);
        expect(requesterFields(planted).filter((f) => !vocab.has(f))).toEqual(['money.inbound_independent_parties']);
    });
});
