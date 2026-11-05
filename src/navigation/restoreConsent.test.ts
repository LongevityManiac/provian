/**
 * Restoring a wallet passes through the same three acknowledgements as creating one: a person who
 * has not accepted goes to ConsentScreen first, which continues to the chosen restore method only
 * after accepting. Source-level wiring checks bind to the real screens; RED controls mutate them.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { restoreEntry, restoreNextOf, RESTORE_METHODS } from './restoreConsent';

const SRC = resolve(__dirname, '..');
const START = readFileSync(resolve(SRC, 'screens/Recovery/RecoveryStartScreen.tsx'), 'utf8');
const CONSENT = readFileSync(resolve(SRC, 'screens/Onboarding/ConsentScreen.tsx'), 'utf8');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });
}

describe('restoreEntry', () => {
  it('sends a person whose acceptance is not current to the acknowledgements, carrying the chosen method', () => {
    for (const method of RESTORE_METHODS) {
      expect(restoreEntry(method, false)).toEqual({ screen: 'Consent', params: { next: method } });
    }
  });

  it('sends a person who accepted the current documents straight to the chosen method', () => {
    expect(restoreEntry('CloudRecovery', true)).toEqual({ screen: 'CloudRecovery' });
    expect(restoreEntry('ImportRecoveryPhrase', true)).toEqual({ screen: 'ImportRecoveryPhrase' });
  });

  it('RED: only the two restore methods continue a restore; anything else is the create path', () => {
    expect(restoreNextOf('CloudRecovery')).toBe('CloudRecovery');
    expect(restoreNextOf('ImportRecoveryPhrase')).toBe('ImportRecoveryPhrase');
    for (const other of [undefined, null, '', 'MainTabs', 'BiometricSetup', 42, { screen: 'CloudRecovery' }]) {
      expect(restoreNextOf(other)).toBeNull();
    }
  });
});

const START_HANDLERS = [
  "    const handleCloudRecovery = () => startRestore('CloudRecovery');",
  "    const handleSeedPhraseRecovery = () => startRestore('ImportRecoveryPhrase');",
];
const START_ROUTER = [
  '    const startRestore = (method: RestoreMethod) => {',
  '        const entry = restoreEntry(method, legalAccepted);',
  "        if (entry.screen === 'Consent') navigation.navigate('Consent', entry.params);",
  '        else navigation.navigate(entry.screen);',
  '    };',
].join('\n');
const CONSENT_ACCEPT = [
  '                        acceptTos();',
  "                        if (review) navigation.reset({ index: 0, routes: [{ name: 'MainTabs' }] });",
  '                        else if (restoreNext) navigation.replace(restoreNext);',
  "                        else navigation.navigate('BiometricSetup');",
].join('\n');

function startViolations(src: string): string[] {
  const out: string[] = [];
  for (const h of START_HANDLERS) if (!src.includes(h)) out.push('a restore choice skips the acknowledgements');
  if (!src.includes(START_ROUTER)) out.push('the restore router does not check acceptance');
  if (!src.includes('useWalletStore(selectLegalAcceptanceCurrent)')) out.push('the restore router does not read acceptance');
  if (/navigate\(\s*'(?:CloudRecovery|ImportRecoveryPhrase)'/.test(src)) out.push('a restore choice skips the acknowledgements');
  return out;
}

function consentViolations(src: string): string[] {
  const out: string[] = [];
  if (!src.includes('const restoreNext = restoreNextOf(route?.params?.next);')) out.push('the restore method is not validated');
  if (!src.includes('const review = route?.params?.review === true && !restoreNext;')) out.push('review mode is not limited to an explicit review');
  if (!src.includes(CONSENT_ACCEPT)) out.push('a restore continues without accepting');
  if (!src.includes('disabled={!allChecked}')) out.push('the button is enabled before all three are checked');
  if (!src.includes('const allChecked = checks.every(Boolean);')) out.push('the button is enabled before all three are checked');
  return out;
}

describe('restore wiring', () => {
  it('both restore choices go through the acceptance check, and ConsentScreen continues only after accepting', () => {
    expect(startViolations(START)).toEqual([]);
    expect(consentViolations(CONSENT)).toEqual([]);
  });

  it('nothing else opens a restore method directly (only the cloud restore hands off to the phrase restore)', () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const file of walk(SRC)) {
      const text = readFileSync(file, 'utf8');
      scanned++;
      if (!/navigate\(\s*'(?:CloudRecovery|ImportRecoveryPhrase)'/.test(text)) continue;
      const rel = relative(SRC, file);
      if (rel === join('screens', 'Recovery', 'CloudRecoveryScreen.tsx')) continue;
      offenders.push(rel);
    }
    expect(scanned).toBeGreaterThan(200);
    expect(offenders).toEqual([]);
  });

  it('RED: a restore choice wired straight to its method is caught', () => {
    const mutated = START.replace("startRestore('CloudRecovery')", "navigation.navigate('CloudRecovery')");
    expect(mutated).not.toBe(START);
    expect(startViolations(mutated)).toContain('a restore choice skips the acknowledgements');
  });

  it('RED: a router that ignores acceptance is caught', () => {
    const mutated = START.replace("        if (entry.screen === 'Consent') navigation.navigate('Consent', entry.params);\n        else navigation.navigate(entry.screen);", '        navigation.navigate(method);');
    expect(mutated).not.toBe(START);
    expect(startViolations(mutated)).toContain('the restore router does not check acceptance');
  });

  it('RED: ConsentScreen continuing a restore without accepting, or with the button always enabled, is caught', () => {
    const noAccept = CONSENT.replace('                        acceptTos();\n                        if (review)', '                        if (review)');
    expect(noAccept).not.toBe(CONSENT);
    expect(consentViolations(noAccept)).toContain('a restore continues without accepting');
    const enabled = CONSENT.replace('disabled={!allChecked}', 'disabled={false}');
    expect(enabled).not.toBe(CONSENT);
    expect(consentViolations(enabled)).toContain('the button is enabled before all three are checked');
  });
});
