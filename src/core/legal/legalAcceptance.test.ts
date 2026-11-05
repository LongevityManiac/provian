/**
 * Accepted-version persistence for the Terms of Service and Privacy Policy: first acceptance
 * records both current versions; an unchanged version asks nothing; a changed version (of either
 * document), or an acceptance recorded before versions were kept, asks the person to review and
 * accept again after unlock.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    CURRENT_LEGAL_VERSIONS,
    acceptedLegalVersions,
    legalAcceptanceCurrent,
    legalReviewRequired,
    type LegalAcceptanceRecord,
} from './legalAcceptance';
import { TERMS_DOCUMENT } from '../../screens/Legal/termsContent.generated';
import { PRIVACY_DOCUMENT } from '../../screens/Legal/privacyContent.generated';
import type { LegalDocument } from '../../screens/Legal/legalDocumentTypes';
import { useWalletStore, selectLegalAcceptanceCurrent } from '../../store/walletStore';
import { landAfterUnlock, type UnlockNavigation } from '../../navigation/afterUnlock';

const SRC = resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(resolve(SRC, rel), 'utf8');

function contentVersion(doc: LegalDocument): string {
    const { title, lastUpdated, footer, blocks } = doc;
    return `sha256:${createHash('sha256').update(JSON.stringify({ title, lastUpdated, footer, blocks })).digest('hex')}`;
}

function unlockRoutes(record: LegalAcceptanceRecord, current = CURRENT_LEGAL_VERSIONS): string[] {
    const routes: string[] = [];
    const navigation: UnlockNavigation = {
        reset: (state) => { routes.push(...state.routes.map((r) => `${r.name}${r.params ? JSON.stringify(r.params) : ''}`)); },
        navigate: (screen) => { routes.push(screen); },
    };
    landAfterUnlock(navigation, legalReviewRequired(record, current) ? 'terms' : 'app', () => undefined, () => null);
    return routes;
}

const REVIEW = ['Consent{"review":true}'];
const APP = ['MainTabs'];

describe('legal document versions', () => {
    it('each generated document carries the hash of its own content', () => {
        for (const doc of [TERMS_DOCUMENT, PRIVACY_DOCUMENT]) {
            expect(doc.version).toMatch(/^sha256:[0-9a-f]{64}$/);
            expect(doc.version).toBe(contentVersion(doc));
        }
        expect(TERMS_DOCUMENT.version).not.toBe(PRIVACY_DOCUMENT.version);
        expect(CURRENT_LEGAL_VERSIONS).toEqual({ terms: TERMS_DOCUMENT.version, privacy: PRIVACY_DOCUMENT.version });
    });

    it('RED: any change a person would read yields a different version', () => {
        const edited: LegalDocument = { ...TERMS_DOCUMENT, lastUpdated: `${TERMS_DOCUMENT.lastUpdated} (revised)` };
        expect(contentVersion(edited)).not.toBe(TERMS_DOCUMENT.version);
        const reworded: LegalDocument = { ...PRIVACY_DOCUMENT, blocks: [...PRIVACY_DOCUMENT.blocks, { type: 'paragraph', spans: [{ text: 'New clause.' }] }] };
        expect(contentVersion(reworded)).not.toBe(PRIVACY_DOCUMENT.version);
    });
});

describe('accepted-version persistence', () => {
    it('first acceptance: a fresh install is asked, and accepting records both current versions', () => {
        useWalletStore.getState().resetOnboarding();
        const fresh = useWalletStore.getState();
        expect(fresh.termsAcceptedVersion).toBeNull();
        expect(fresh.privacyAcceptedVersion).toBeNull();
        expect(selectLegalAcceptanceCurrent(fresh)).toBe(false);
        expect(unlockRoutes(fresh)).toEqual(REVIEW);

        fresh.acceptTos();
        const accepted = useWalletStore.getState();
        expect(accepted.tosAcceptedAt).toEqual(expect.any(String));
        expect(accepted.termsAcceptedVersion).toBe(TERMS_DOCUMENT.version);
        expect(accepted.privacyAcceptedVersion).toBe(PRIVACY_DOCUMENT.version);
        expect(selectLegalAcceptanceCurrent(accepted)).toBe(true);
        expect(unlockRoutes(accepted)).toEqual(APP);
    });

    it('the accepted versions are persisted with the wallet store and cleared by a reset', () => {
        const persist = (useWalletStore as unknown as { persist: { getOptions: () => { partialize: (s: unknown) => Record<string, unknown> } } }).persist;
        useWalletStore.getState().acceptTos();
        const saved = persist.getOptions().partialize(useWalletStore.getState());
        expect(saved.termsAcceptedVersion).toBe(TERMS_DOCUMENT.version);
        expect(saved.privacyAcceptedVersion).toBe(PRIVACY_DOCUMENT.version);
        useWalletStore.getState().resetOnboarding();
        expect(useWalletStore.getState().termsAcceptedVersion).toBeNull();
        expect(useWalletStore.getState().privacyAcceptedVersion).toBeNull();
    });

    it('unchanged version: no prompt', () => {
        const record = acceptedLegalVersions();
        expect(legalReviewRequired(record)).toBe(false);
        expect(unlockRoutes(record)).toEqual(APP);
    });

    it('changed version of either document: prompt', () => {
        const record = acceptedLegalVersions();
        const termsChanged = { ...CURRENT_LEGAL_VERSIONS, terms: 'sha256:' + '1'.repeat(64) };
        const privacyChanged = { ...CURRENT_LEGAL_VERSIONS, privacy: 'sha256:' + '2'.repeat(64) };
        for (const current of [termsChanged, privacyChanged]) {
            expect(legalReviewRequired(record, current)).toBe(true);
            expect(unlockRoutes(record, current)).toEqual(REVIEW);
        }
    });

    it('an acceptance recorded before versions were kept, or a blank one, is not current', () => {
        for (const record of [
            {} as LegalAcceptanceRecord,
            { termsAcceptedVersion: null, privacyAcceptedVersion: null },
            { termsAcceptedVersion: '', privacyAcceptedVersion: '' },
            { termsAcceptedVersion: CURRENT_LEGAL_VERSIONS.terms },
            { privacyAcceptedVersion: CURRENT_LEGAL_VERSIONS.privacy },
        ]) {
            expect(legalAcceptanceCurrent(record), JSON.stringify(record)).toBe(false);
        }
        expect(legalAcceptanceCurrent(null)).toBe(false);
        // A blank current version can never be matched, even by a blank record.
        expect(legalAcceptanceCurrent({ termsAcceptedVersion: '', privacyAcceptedVersion: '' }, { terms: '', privacy: '' })).toBe(false);
    });

    it('RED: the old acceptance check (a timestamp only) would never ask again after a document changed', () => {
        const oldCheck = (s: { tosAcceptedAt: string | null }) => Boolean(s.tosAcceptedAt);
        const termsChanged = { ...CURRENT_LEGAL_VERSIONS, terms: 'sha256:' + '3'.repeat(64) };
        const state = { tosAcceptedAt: '2026-10-01T00:00:00.000Z', ...acceptedLegalVersions() };
        expect(oldCheck(state)).toBe(true); // treats the person as accepted
        expect(legalAcceptanceCurrent(state, termsChanged)).toBe(false); // the version check does not
    });
});

describe('wiring', () => {
    it('unlock routes a stale acceptance to the review, after the backup and restore gates', () => {
        const s = read('screens/Security/WalletLockScreen.tsx');
        expect(s).toContain("const termsGate = legalReviewRequired(useWalletStore.getState()) ? 'terms' as const : 'app' as const;");
        expect(s).toContain("landAfterUnlock(navigation, seedUnreadable ? 'restore' : backupGate === 'backup' ? 'backup' : termsGate, () => setAuthenticated(true));");
    });

    it('review mode accepts into the app and cannot be backed out of', () => {
        const s = read('screens/Onboarding/ConsentScreen.tsx');
        expect(s).toContain("{review ? <View style={styles.headerSpacer} /> : <BackButton onPress={() => navigation.goBack()} />}");
        expect(s).toContain("if (review) navigation.reset({ index: 0, routes: [{ name: 'MainTabs' }] });");
    });

    it('restore reads the version-aware acceptance, not the timestamp', () => {
        const s = read('screens/Recovery/RecoveryStartScreen.tsx');
        expect(s).toContain('useWalletStore(selectLegalAcceptanceCurrent)');
        expect(s).not.toContain('s.tosAcceptedAt');
    });
});
