/**
 * no onboarding path finishes with a wallet that lacks a completed backup of
 * that wallet. The create path already could not (CloudBackupConfirm has no skip and precedes the
 * completion step); the recovery-phrase path completed onboarding and only raised a banner. It
 * now marks the wallet as owing a backup and routes it to the backup screen — again at every
 * unlock until the backup exists (a force-quit on the backup screen must not land in the app).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const store = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => { store.set(k, v); },
    removeItem: async (k: string) => { store.delete(k); },
} }));

import {
    BACKUP_REQUIRED_KEY,
    decideBackupGate,
    markBackupRequired,
    pendingBackupRequirement,
    resolveBackupGate,
} from './backupRequirement';

const A = '0xAaAaaAAAaAaaAaAaAAAAAAAAAaAAAaaaAAaaaaAa';
const B = '0xbBbBBBbbBbBBbbbBbbbBbBBBBbbbbbBbBBbBbbBb';

describe('decideBackupGate', () => {
    it('nothing owed → app; owed and missing → backup; owed and unknown → backup (unknown = block)', () => {
        expect(decideBackupGate({ pendingAddress: null, currentAddress: A, hasBackup: false })).toEqual({ route: 'app', clearMark: false });
        expect(decideBackupGate({ pendingAddress: A.toLowerCase(), currentAddress: A, hasBackup: false })).toEqual({ route: 'backup', clearMark: false });
        expect(decideBackupGate({ pendingAddress: A.toLowerCase(), currentAddress: A, hasBackup: null })).toEqual({ route: 'backup', clearMark: false });
    });
    it('owed and backed up → app and the mark clears; a mark for a wallet no longer here clears', () => {
        expect(decideBackupGate({ pendingAddress: A.toLowerCase(), currentAddress: A, hasBackup: true })).toEqual({ route: 'app', clearMark: true });
        expect(decideBackupGate({ pendingAddress: A.toLowerCase(), currentAddress: B, hasBackup: false })).toEqual({ route: 'app', clearMark: true });
    });
});

describe('resolveBackupGate (persisted mark)', () => {
    beforeEach(() => store.clear());

    it('a restored wallet without a backup is routed to the backup screen at every unlock until it has one', async () => {
        await markBackupRequired(A);
        let backedUp = false;
        const hasBackup = vi.fn(async () => backedUp);
        expect(await resolveBackupGate(A, hasBackup)).toBe('backup');
        // "Force-quit" — the mark survives; the next unlock routes there again.
        expect(await pendingBackupRequirement()).toBe(A.toLowerCase());
        expect(await resolveBackupGate(A, hasBackup)).toBe('backup');
        backedUp = true;
        expect(await resolveBackupGate(A, hasBackup)).toBe('app');
        expect(store.has(BACKUP_REQUIRED_KEY)).toBe(false);
    });

    it('a failed check keeps the wallet on the backup screen', async () => {
        await markBackupRequired(A);
        expect(await resolveBackupGate(A, async () => { throw new Error('offline'); })).toBe('backup');
    });

    it('no mark: the app, without reading the cloud', async () => {
        const hasBackup = vi.fn(async () => false);
        expect(await resolveBackupGate(A, hasBackup)).toBe('app');
        expect(hasBackup).not.toHaveBeenCalled();
    });
});

describe('the onboarding paths are wired to the gate', () => {
    const src = (p: string) => readFileSync(resolve(__dirname, '../../../', p), 'utf8');

    it('the phrase restore marks a wallet without a backup and routes through the gate', () => {
        const s = src('screens/Recovery/ImportRecoveryPhraseScreen.tsx');
        // , defect 3: the mark is written BEFORE onboarding completes and cleared
        // only on proof, so nothing between the two can land the wallet in the app without it.
        const mark = s.indexOf('await markBackupRequired(evmAddress);');
        const complete = s.indexOf("completeOnboarding('wallet');");
        expect(mark).toBeGreaterThan(-1);
        expect(mark).toBeLessThan(complete);
        expect(s).toMatch(/if \(backedUp\) await clearBackupRequired\(\)/);
        expect(s).toMatch(/resolveBackupGate\(evmAddress, hasCloudBackup\)/);
        expect(s).toMatch(/name: 'CloudBackupConfirm', params: \{ requiredBeforeApp: true \}/);
    });

    it('unlock routes a wallet that still owes its backup to the backup screen', () => {
        const s = src('screens/Security/WalletLockScreen.tsx');
        expect(s).toMatch(/resolveBackupGate\(/);
        expect(s).toMatch(/landAfterUnlock\(navigation, [^;]{0,60}backupGate === 'backup' \? 'backup'/);
        // …and the helper it calls opens the backup screen first for that gate.
        expect(src('navigation/afterUnlock.ts')).toMatch(/gate === 'backup'[\s\S]{0,120}name: 'CloudBackupConfirm', params: \{ requiredBeforeApp: true \}/);
    });

    it('the backup screen offers Keep and Replace — every answer ends with this wallet backed up', () => {
        const s = src('screens/Onboarding/CloudBackupConfirmScreen.tsx');
        const alert = s.slice(s.indexOf('Alert.alert('), s.indexOf('{ cancelable: false }'));
        expect(alert).toMatch(/keepBothBackups[\s\S]*createBackupWith\(backupPin, 'keep'\)/);
        expect(alert).toMatch(/replaceBackup[\s\S]*createBackupWith\(backupPin, 'replace'\)/);
        // No button that leaves this wallet without a backup (the 2026-10-17 Cancel did).
        expect(alert).not.toMatch(/common\.cancel/);
        expect(s).toMatch(/clearBackupRequired\(\)/);
    });
});
