/**
 * Delete All Data: the "Delete everything" choice reaches the deletion (2026-10-22).
 *
 * The first prompt asks whether the cloud backup goes too. The choice used to be written to React
 * state (`setDeleteCloudShares(true)`) and then read by handlers bound in the SAME render, so
 * "Delete everything" ran the deletion with the render's stale `false` and the wallet's cloud backup
 * survived. The choice now travels as an argument from the prompt to performDeletion.
 *
 * RN screens cannot be imported under vitest (node_modules ship untranspiled JSX), so this executes
 * the actual TSX with host elements and synchronous hooks — the VisionScreen.test.ts harness — and
 * drives the real Alert buttons.
 *
 * RED control (in-suite, permanent): the same harness run over the screen rewritten back to the
 * pre-fix state shape calls deleteCloudBackup 0 times on "Delete everything". Recorded by hand
 * 2026-10-22: the first test, run against `git show c1653c1:src/screens/Settings/DeleteAllDataScreen.tsx`,
 * fails with `expected "vi.fn()" to be called 1 times, but got 0 times` (the "Keep cloud backup" test passes).
 *
 * Relay deletion first (2026-10-23 close-out): the relay request used to run AFTER the wallet wipe and
 * AsyncStorage.clear(), best-effort with its result ignored, so it could not sign wallet auth and a
 * failure was silent. : a failed request may have deleted part of the server data
 * (the relay deletes in steps), so the alert says so and offers "Try again" (a fresh approval);
 * a 401 for a gone account counts as done. RED controls, recorded by hand 2026-10-23 (the
 * pre-fix-shape control above is excluded: its rewrite anchors exist only in the current screen):
 *  - against the pre-fix screen (`git show 57f40b0:src/screens/Settings/DeleteAllDataScreen.tsx`)
 *    all 8 relay-first tests fail: the wipe ran before the relay request on every outcome and no
 *    failure alert was ever shown;
 *  - against the round-0 screen (WIP ab99afc, with its boolean result and biometricAction import
 *    mocked) the not_finished / unknown / throws / no_access tests fail (one 2-button "nothing has
 *    been deleted" alert, no "Try again", no no_access message) and the Try-again test finds no button.
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const source = readFileSync(resolve(__dirname, 'DeleteAllDataScreen.tsx'), 'utf8');
type Node = { type: unknown; props: Record<string, unknown>; children: unknown[] };
type AlertButton = { text?: string; style?: string; onPress?: () => unknown };

/** What each relay deletion request resolves to, in order (the last one repeats). */
type RelayOutcome = 'deleted' | 'account_gone' | 'not_finished' | 'unknown' | 'no_access' | 'throws';

function screen(code = source, relayOutcomes: readonly RelayOutcome[] = ['deleted']) {
    const state: unknown[] = [];
    let cursor = 0;
    // Every side effect in the order it happened: the relay request must precede the local wipe.
    const order: string[] = [];
    const alert = vi.fn();
    const deleteCloudBackup = vi.fn(async (_address?: string) => { order.push('cloudBackup'); return { keptUnidentifiedBackup: false }; });
    const deleteWallet = vi.fn(async () => { order.push('deleteWallet'); });
    const reset = vi.fn(() => { order.push('navigate'); });
    const asyncClear = vi.fn(async () => { order.push('asyncStorageClear'); });
    const secureDelete = vi.fn(async (_key: string) => { order.push('secureStoreDelete'); });
    // The relay request signs with the credentials the device still holds: record when it ran.
    let sent = 0;
    const requestDataDeletion = vi.fn(async () => {
        order.push('relayDelete');
        const outcome = relayOutcomes[Math.min(sent++, relayOutcomes.length - 1)];
        if (outcome === 'throws') throw new Error('network down');
        return outcome;
    });
    const clearRelayCredentials = vi.fn(async () => { order.push('clearRelayCredentials'); });
    const requireBiometric = vi.fn(async (_reason: string) => { order.push('approval'); });
    const react = {
        createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Node =>
            ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        // React's contract inside one render: a setter updates the stored value for the NEXT render;
        // the handlers this render created keep the value they closed over.
        useState: (initial: unknown) => {
            const i = cursor++;
            if (!(i in state)) state[i] = initial;
            return [state[i], (value: unknown) => { state[i] = typeof value === 'function' ? value(state[i]) : value; }];
        },
    };
    const native = Object.fromEntries(['View', 'Text', 'ScrollView', 'TouchableOpacity', 'ActivityIndicator'].map((k) => [k, k]));
    class BiometricNotAvailableError extends Error {}
    class BiometricAuthError extends Error {}
    const useWalletStore = Object.assign(() => ({ resetOnboarding: vi.fn() }), { getState: () => ({ address: '0xabc' }) });
    const imports: Record<string, unknown> = {
        '../../i18n/displayCopy': { errorDisplayCopy: (value: string) => value },
        react,
        'react-native': { ...native, StyleSheet: { create: (s: unknown) => s, absoluteFill: {} }, Alert: { alert } },
        'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
        'expo-linear-gradient': { LinearGradient: 'LinearGradient' },
        '@expo/vector-icons': { Ionicons: 'Ionicons' },
        '../../core/security/requireBiometric': {
            requireBiometric,
            BiometricNotAvailableError,
            BiometricAuthError,
            clearBiometricFallback: async () => undefined,
        },
        '@react-native-async-storage/async-storage': { getItem: async () => null, clear: asyncClear },
        'expo-secure-store': { deleteItemAsync: secureDelete },
        'react-i18next': { useTranslation: () => ({ t: (key: string) => key }) },
        '../../constants/theme': { COLORS: {}, SPACING: {}, GRADIENTS: {} },
        '../../theme': { useTheme: () => ({ colors: {} }) },
        '../../store/walletStore': { useWalletStore },
        '../../services/RelayAPIService': { requestDataDeletion, clearRelayCredentials },
        '../../core/security/biometricLabel': { useBiometricLabel: () => ({ label: 'Face ID' }) },
        '../../core/wallet/WalletCreationService': { getInstance: () => ({ deleteWallet }) },
        '../../core/recovery/cloud/CloudBackupV2': { deleteCloudBackup },
        '../../components/BackButton': { default: () => null, BACK_BUTTON_SIZE: 40 },
    };
    const compiled = ts.transpileModule(code, { compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
    const mod = { exports: {} as { default: (p: { navigation: unknown }) => Node } };
    new Function('require', 'module', 'exports', compiled)((name: string) => {
        if (!(name in imports)) throw new Error(`Unmocked import ${name}`);
        return imports[name];
    }, mod, mod.exports);
    const navigation = { reset, goBack: vi.fn() };
    return {
        render: () => { cursor = 0; return mod.exports.default({ navigation }); },
        alert, deleteCloudBackup, deleteWallet, reset, requestDataDeletion, clearRelayCredentials, asyncClear, order, requireBiometric,
    };
}

function walk(node: unknown): unknown[] {
    if (!node || typeof node !== 'object' || !('children' in node)) return [node];
    return [node, ...(node as Node).children.flatMap(walk)];
}
const nodes = (tree: Node) => walk(tree).filter((n): n is Node => !!n && typeof n === 'object' && 'props' in n);
const text = (node: Node) => walk(node).filter((n) => typeof n === 'string').join(' ');

/** Press the delete button, pick `firstChoice`, and confirm (no expectation about the outcome). */
async function confirmDeletion(s: ReturnType<typeof screen>, firstChoice: string): Promise<void> {
    const tree = s.render();
    const button = nodes(tree).find((n) => n.type === 'TouchableOpacity' && text(n) === 'deleteData.headerTitle');
    expect(button, 'the screen\'s delete button').toBeDefined();
    await (button!.props.onPress as () => Promise<void>)();
    const first = s.alert.mock.calls[0][2] as AlertButton[];
    const choice = first.find((b) => b.text === firstChoice);
    expect(choice, `first prompt offers ${firstChoice}`).toBeDefined();
    choice!.onPress!();
    const second = s.alert.mock.calls[1][2] as AlertButton[];
    await second.find((b) => b.style === 'destructive')!.onPress!();
}

/** Press the screen's delete button, pick `firstChoice`, confirm, and let the deletion finish. */
async function deleteWith(s: ReturnType<typeof screen>, firstChoice: string): Promise<void> {
    await confirmDeletion(s, firstChoice);
    // The deletion ran to the end (wallet wiped, navigation reset) — so a missing cloud delete is the choice, not a crash.
    expect(s.deleteWallet).toHaveBeenCalledTimes(1);
    expect(s.reset).toHaveBeenCalledTimes(1);
}

/** The screen as it was before the fix: the choice is written to state and read by this render's handlers. */
function preFixShape(src: string): string {
    const swaps: Array<[string, string]> = [
        ['    const [isDeleting, setIsDeleting] = useState(false);\n',
            '    const [isDeleting, setIsDeleting] = useState(false);\n    const [deleteCloudShares, setDeleteCloudShares] = useState(false);\n'],
        ['onPress: () => handleSecondConfirmation(false),', 'onPress: () => { setDeleteCloudShares(false); handleSecondConfirmation(); },'],
        ['onPress: () => handleSecondConfirmation(true),', 'onPress: () => { setDeleteCloudShares(true); handleSecondConfirmation(); },'],
        ['const handleSecondConfirmation = (deleteCloudBackupToo: boolean) => {', 'const handleSecondConfirmation = () => {'],
        ['onPress: () => handleBiometricAuth(deleteCloudBackupToo),', 'onPress: handleBiometricAuth,'],
        ['const handleBiometricAuth = async (deleteCloudBackupToo: boolean) => {', 'const handleBiometricAuth = async () => {'],
        ['await performDeletion(deleteCloudBackupToo);', 'await performDeletion();'],
        ['const performDeletion = async (deleteCloudBackupToo: boolean) => {', 'const performDeletion = async () => {'],
        ['onPress: () => { void handleBiometricAuth(deleteCloudBackupToo); } },', 'onPress: () => { void handleBiometricAuth(); } },'],
        ['onPress: () => { void wipeThisDevice(deleteCloudBackupToo); },', 'onPress: () => { void wipeThisDevice(); },'],
        ['await wipeThisDevice(deleteCloudBackupToo);', 'await wipeThisDevice();'],
        ['const wipeThisDevice = async (deleteCloudBackupToo: boolean) => {', 'const wipeThisDevice = async () => {'],
        ['if (deleteCloudBackupToo) {', 'if (deleteCloudShares) {'],
    ];
    let out = src;
    for (const [from, to] of swaps) {
        expect(out.split(from).length - 1, `pre-fix rewrite anchor: ${from}`).toBe(1);
        out = out.replace(from, to);
    }
    return out;
}

describe('Delete All Data — the cloud-backup choice', () => {
    it('"Delete everything" deletes this wallet\'s cloud backup', async () => {
        const s = screen();
        await deleteWith(s, 'deleteData.deleteEverything');
        expect(s.deleteCloudBackup).toHaveBeenCalledTimes(1);
        expect(s.deleteCloudBackup).toHaveBeenCalledWith('0xabc');
    });

    it('"Keep cloud backup" leaves the cloud backup alone', async () => {
        const s = screen();
        await deleteWith(s, 'deleteData.keepCloudBackup');
        expect(s.deleteCloudBackup).not.toHaveBeenCalled();
    });

    it('RED control: the pre-fix state shape loses the "Delete everything" choice', async () => {
        const s = screen(preFixShape(source));
        await deleteWith(s, 'deleteData.deleteEverything');
        expect(s.deleteCloudBackup).toHaveBeenCalledTimes(0);
    });
});

/** The local-wipe side effects: none may happen before the relay confirms. */
const LOCAL_WIPE = ['deleteWallet', 'cloudBackup', 'secureStoreDelete', 'clearRelayCredentials', 'asyncStorageClear', 'navigate'];
const wiped = (order: readonly string[]) => order.filter((step) => LOCAL_WIPE.includes(step));

describe('Delete All Data — the relay deletion runs first and its result decides (2026-10-23 close-out)', () => {
    for (const outcome of ['deleted', 'account_gone'] as const) {
        it(`relay outcome ${outcome}: the request is sent BEFORE anything local is wiped, then the phone is cleared`, async () => {
            const s = screen(source, [outcome]);
            await deleteWith(s, 'deleteData.deleteEverything');
            expect(s.requestDataDeletion).toHaveBeenCalledTimes(1);
            expect(s.order.slice(0, 2)).toEqual(['approval', 'relayDelete']);
            for (const step of LOCAL_WIPE) expect(s.order, step).toContain(step);
            // The relay credentials go with the device's data.
            expect(s.clearRelayCredentials).toHaveBeenCalledTimes(1);
            // No failure alert: only the two confirmations.
            expect(s.alert).toHaveBeenCalledTimes(2);
        });
    }

    for (const outcome of ['not_finished', 'unknown', 'throws'] as const) {
        it(`relay outcome ${outcome}: nothing local is wiped and the person is told it may be partly done`, async () => {
            const s = screen(source, [outcome]);
            await confirmDeletion(s, 'deleteData.deleteEverything');
            expect(wiped(s.order)).toEqual([]);
            const failure = s.alert.mock.calls[2];
            expect(failure[0]).toBe('deleteData.relayDeletionFailedTitle');
            expect(failure[1]).toBe('deleteData.relayDeletionFailedMsg');
            const buttons = failure[2] as AlertButton[];
            expect(buttons.map((b) => b.text)).toEqual(['common.cancel', 'common.tryAgain', 'deleteData.deleteOnThisPhoneOnly']);
            buttons.find((b) => b.style === 'cancel')!.onPress?.();
            expect(wiped(s.order)).toEqual([]);
            expect(s.requestDataDeletion).toHaveBeenCalledTimes(1);
        });
    }

    it('relay outcome no_access: nothing is wiped and the person is told this phone cannot reach the server data', async () => {
        const s = screen(source, ['no_access']);
        await confirmDeletion(s, 'deleteData.deleteEverything');
        expect(wiped(s.order)).toEqual([]);
        const failure = s.alert.mock.calls[2];
        expect(failure[0]).toBe('deleteData.relayNoAccessTitle');
        expect(failure[1]).toBe('deleteData.relayNoAccessMsg');
        expect((failure[2] as AlertButton[]).map((b) => b.text)).toEqual(['common.cancel', 'common.tryAgain', 'deleteData.deleteOnThisPhoneOnly']);
    });

    it('"Try again" re-sends under a fresh approval and, once the relay finishes, clears the phone', async () => {
        const s = screen(source, ['unknown', 'deleted']);
        await confirmDeletion(s, 'deleteData.keepCloudBackup');
        const tryAgain = (s.alert.mock.calls[2][2] as AlertButton[]).find((b) => b.text === 'common.tryAgain');
        tryAgain!.onPress!();
        await vi.waitFor(() => expect(s.reset).toHaveBeenCalledTimes(1));
        expect(s.requireBiometric).toHaveBeenCalledTimes(2);
        expect(s.requestDataDeletion).toHaveBeenCalledTimes(2);
        expect(s.order.slice(0, 4)).toEqual(['approval', 'relayDelete', 'approval', 'relayDelete']);
        expect(s.deleteCloudBackup).not.toHaveBeenCalled(); // the first choice still holds
    });

    it('after a failed relay deletion, "Clear this phone only" is an explicit choice that then wipes locally', async () => {
        const s = screen(source, ['not_finished']);
        await confirmDeletion(s, 'deleteData.keepCloudBackup');
        const phoneOnly = (s.alert.mock.calls[2][2] as AlertButton[]).find((b) => b.text === 'deleteData.deleteOnThisPhoneOnly');
        expect(phoneOnly?.style).toBe('destructive');
        phoneOnly!.onPress!();
        await vi.waitFor(() => expect(s.reset).toHaveBeenCalledTimes(1));
        expect(s.requestDataDeletion).toHaveBeenCalledTimes(1); // never re-sent behind the person's back
        expect(s.deleteWallet).toHaveBeenCalledTimes(1);
        expect(s.deleteCloudBackup).not.toHaveBeenCalled();
        expect(s.order[1]).toBe('relayDelete');
    });
});
