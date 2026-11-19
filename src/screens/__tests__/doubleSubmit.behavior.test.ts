/**
 * One tap, one action — even when the second tap lands before the approval prompt answers.
 *
 * Approval prompts queue: a second request made while the first prompt is still up runs its action
 * afterwards. A busy flag set INSIDE the approved action therefore cannot stop a second tap; each
 * handler must refuse it synchronously, before it asks for approval. These tests run each screen's
 * real handler twice in the same tick against a queueing approval stand-in and count what was sent.
 * They also prove the guard is released: a later tap, and a tap after a declined prompt, still work.
 */
import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { mergeThreadMessages } from '../../core/commons/threadHistory';
import { queuedApproval, screenHandler } from './screenHandler';

class BiometricAuthError extends Error {}
class BiometricNotAvailableError extends Error {}
const t = (key: string): string => key;
const screen = (rel: string): string => resolve(__dirname, '..', rel);
const ref = <T>(current: T): { current: T } => ({ current });

function base() {
    const approval = queuedApproval();
    return {
        approval,
        scope: {
            withBiometricAction: approval.request,
            BiometricAuthError, BiometricNotAvailableError,
            Alert: { alert: vi.fn() }, t, console, Date,
            errorDisplayCopy: (s: string) => s,
            navigation: { navigate: vi.fn(), goBack: vi.fn() },
            offerSpeechWindow: () => false,
        },
    };
}

/** Two taps in one tick, then settle. */
async function doubleTap(handler: (...args: unknown[]) => Promise<unknown>, ...args: unknown[]): Promise<void> {
    const first = handler(...args);
    const second = handler(...args);
    await Promise.all([first, second]);
}

describe('Send: Confirm', () => {
    function send() {
        const { approval, scope } = base();
        const sendETH = vi.fn(async () => ({ txHash: '0xhash', explorerUrl: 'https://explorer/0xhash' }));
        const c = {
            ...scope,
            loading: false, step: 'review', isOffline: false,
            selectedAsset: { symbol: 'ETH', chain: 'Base' }, amount: '1', recipient: '0xabc', recipientAddress: '0xabc',
            currentChainId: 8453, currentChainInfo: { name: 'Base' }, multiChainInfo: null,
            address: '0xme', solanaAddress: null,
            reviewedRef: ref({ recipient: '0xabc', amount: '1', asset: 'ETH', chain: 'Base', chainId: 8453 }),
            confirmInFlightRef: ref(false),
            policyResult: { decision: 'allow', riskScore: 1, riskCategory: 'low' },
            setLoading: vi.fn(), setStep: vi.fn(), setTxResult: vi.fn(), setPeDeferred: vi.fn(),
            queueTransaction: vi.fn(), getAmountUsd: () => 1,
            CHAIN_IDS: { ARBITRUM: 42161, OPTIMISM: 10 },
            TransactionService: { sendETH, sendERC20: vi.fn() },
            solanaTransactionService: { sendSOL: vi.fn(), sendSPL: vi.fn() },
            TransactionHistoryService: { addLocalTransaction: vi.fn(async () => undefined) },
            ProvenanceEnvelopeManager: { createEnvelope: vi.fn(async () => ({})), enqueueDeferredEnvelope: vi.fn(async () => undefined) },
            AddressHistoryService: { recordSend: vi.fn(async () => undefined) },
            InsufficientSolForFeesError: class extends Error {},
        };
        return { c, approval, sendETH, confirm: screenHandler(screen('Action/SendScreen.tsx'), 'handleConfirm', c) };
    }

    it('two taps before the prompt answers send ONE transfer and ask for ONE approval', async () => {
        const { confirm, sendETH, approval, c } = send();
        await doubleTap(confirm);
        expect(sendETH).toHaveBeenCalledTimes(1);
        expect(approval.requests()).toBe(1);
        expect(c.ProvenanceEnvelopeManager.createEnvelope).toHaveBeenCalledTimes(1);
    });

    it('the guard is released when the send settles, and after a declined prompt', async () => {
        const { confirm, sendETH, c } = send();
        await confirm();
        expect(c.confirmInFlightRef.current).toBe(false);
        c.withBiometricAction = async () => { throw new BiometricAuthError('cancelled'); };
        const declined = screenHandler(screen('Action/SendScreen.tsx'), 'handleConfirm', c);
        await declined();
        expect(c.confirmInFlightRef.current).toBe(false);
        expect(sendETH).toHaveBeenCalledTimes(1);
    });
});

describe('Commons thread: Send', () => {
    function thread(held: Array<{ message_id: string; created_at: number }> = []) {
        const { approval, scope } = base();
        const state = { messages: held };
        const sendThreadMessage = vi.fn(async () => ({ message: { message_id: 'm1', created_at: 50 } }));
        const c = {
            ...scope,
            sending: false, sendInFlight: ref(false), threadId: 'thread', myId: 'me', otherId: 'them', otherName: 'Them', ownAgent: null,
            confirmCommonsWrite: approval.request,
            useCommonsStore: { getState: () => ({ profile: { wallet_id: 'me' } }) },
            ensureKeys: vi.fn(async () => ({ me: 'k1', them: 'k2' })),
            cachedMessageKeyPair: () => null,
            signedThreadPlaintext: async (body: string) => body,
            sealThreadMessage: () => ({ ciphertexts: {}, content_sha256: 'h' }),
            CommonsService: { sendThreadMessage, openThread: vi.fn() },
            mergeThreadMessages,
            setSending: vi.fn(), setText: vi.fn(), setPlain: vi.fn(), setThread: vi.fn(), setThreadId: vi.fn(),
            setMessages: vi.fn((next: unknown) => { state.messages = typeof next === 'function' ? (next as (p: typeof held) => typeof held)(state.messages) : next as typeof held; }),
            sendFailureOutcome: () => 'refused', keyMissingCopyKeys: () => ({ title: 'x', body: 'y' }), savePendingDraft: vi.fn(),
        };
        return { c, state, approval, sendThreadMessage, sendText: screenHandler(screen('Commons/CommonsThread.tsx'), 'sendText', c) };
    }

    it('two taps before the prompt answers send ONE message', async () => {
        const { sendText, sendThreadMessage, approval, state } = thread();
        await doubleTap(sendText, 'hello');
        expect(sendThreadMessage).toHaveBeenCalledTimes(1);
        expect(approval.requests()).toBe(1);
        expect(state.messages.map((m) => m.message_id)).toEqual(['m1']);
    });

    it('a later send still goes out (the guard is released)', async () => {
        const { sendText, sendThreadMessage, c } = thread();
        expect(await sendText('one')).toBe('sent');
        expect(c.sendInFlight.current).toBe(false);
        expect(await sendText('two')).toBe('sent');
        expect(sendThreadMessage).toHaveBeenCalledTimes(2);
    });

    it('a message the refresh already delivered is shown once when the send answers', async () => {
        // The 10-second refresh fetched m1 while the send was still waiting for its answer.
        const { sendText, state } = thread([{ message_id: 'm0', created_at: 10 }, { message_id: 'm1', created_at: 50 }]);
        await sendText('hello');
        expect(state.messages.map((m) => m.message_id)).toEqual(['m0', 'm1']);
    });
});

describe('Commons requests: post a request, answer one', () => {
    function wants() {
        const { approval, scope } = base();
        const postWant = vi.fn(async () => ({}));
        const c: Record<string, unknown> = {
            ...scope,
            gateInFlight: ref(false),
            caps: 'design', outcome: 'a logo', budget: '',
            parseWantBudget: () => ({ ok: true, atomic: null }),
            CommonsService: { postWant },
            setBusy: vi.fn(), setShowPost: vi.fn(), setOutcome: vi.fn(), setCaps: vi.fn(), setBudget: vi.fn(),
            load: vi.fn(async () => undefined), wantPostErrorKey: () => 'k', resumeWantRef: ref(false),
        };
        c.gate = screenHandler(screen('Commons/CommonsWants.tsx'), 'gate', c);
        return { c, approval, postWant, submitWant: screenHandler(screen('Commons/CommonsWants.tsx'), 'submitWant', c) };
    }

    it('two taps before the prompt answers post ONE request', async () => {
        const { submitWant, postWant, approval } = wants();
        await doubleTap(submitWant);
        expect(postWant).toHaveBeenCalledTimes(1);
        expect(approval.requests()).toBe(1);
    });

    it('a later post still goes out (the guard is released)', async () => {
        const { submitWant, postWant } = wants();
        await submitWant();
        await submitWant();
        expect(postWant).toHaveBeenCalledTimes(2);
    });
});

describe('Hiring board: Post a job', () => {
    function post() {
        const { approval, scope } = base();
        const postHumanJob = vi.fn(async () => ({ job_id: 'job_1' }));
        const c = {
            ...scope,
            submitInFlightRef: ref(false), form: {},
            buildPostHumanJobBody: () => ({ title: 'x' }),
            PostHumanJobValidationError: class extends Error {},
            CommonsService: { postHumanJob },
            setErrorField: vi.fn(), setErrorMessage: vi.fn(), setSubmitting: vi.fn(),
        };
        return { c, approval, postHumanJob, submit: screenHandler(screen('Commons/CommonsHumanJobsPost.tsx'), 'handleSubmit', c) };
    }

    it('two taps before the prompt answers post ONE job', async () => {
        const { submit, postHumanJob, approval } = post();
        await doubleTap(submit);
        expect(postHumanJob).toHaveBeenCalledTimes(1);
        expect(approval.requests()).toBe(1);
    });

    it('a later post still goes out (the guard is released)', async () => {
        const { submit, postHumanJob, c } = post();
        await submit();
        expect(c.submitInFlightRef.current).toBe(false);
        await submit();
        expect(postHumanJob).toHaveBeenCalledTimes(2);
    });
});

describe('Hiring board: job actions (deliver, cancel, rate…)', () => {
    function manage() {
        const { approval, scope } = base();
        const c = {
            ...scope,
            actionInFlight: ref(false), setBusy: vi.fn(), load: vi.fn(async () => undefined), showError: vi.fn(),
        };
        return { c, approval, runAction: screenHandler(screen('Commons/CommonsHumanJobManage.tsx'), 'runAction', c) };
    }

    it('two taps before the prompt answers run the action ONCE', async () => {
        const { runAction, approval } = manage();
        const action = vi.fn(async () => undefined);
        await doubleTap(runAction, 'reason', action, 'done');
        expect(action).toHaveBeenCalledTimes(1);
        expect(approval.requests()).toBe(1);
    });

    it('a later action still runs (the guard is released)', async () => {
        const { runAction, c } = manage();
        const action = vi.fn(async () => undefined);
        await runAction('reason', action, 'done');
        expect(c.actionInFlight.current).toBe(false);
        await runAction('reason', action, 'done');
        expect(action).toHaveBeenCalledTimes(2);
    });
});

describe('Swap: declining the approval prompt', () => {
    function swap(approvalError: Error) {
        const { scope } = base();
        const c = {
            ...scope,
            withBiometricAction: async () => { throw approvalError; },
            submittingRef: ref(false), quoteSeq: ref(1),
            quote: { crossChain: false }, quoteIsSubmittable: () => true,
            amount: '1', fromAsset: { symbol: 'ETH' }, toAsset: { symbol: 'USDC' },
            canonicalizeAmount: () => ({ ok: true, value: '1' }), sendDecimalsOf: () => 18,
            beginSubmission: () => ({ quoteId: 'q' }),
            setLoading: vi.fn(), setReviewVisible: vi.fn(),
        };
        return { c, confirm: screenHandler(screen('Action/SwapScreen.tsx'), 'handleConfirm', c) };
    }

    it('a cancelled prompt raises no alert and leaves the review open', async () => {
        const { c, confirm } = swap(new BiometricAuthError('user_cancel'));
        await confirm();
        expect(c.Alert.alert).not.toHaveBeenCalled();
        expect(c.setReviewVisible).not.toHaveBeenCalled();
        expect(c.submittingRef.current).toBe(false);
        expect(c.setLoading).toHaveBeenLastCalledWith(false);
    });

    it('no usable biometrics says so, not "swap failed"', async () => {
        const { c, confirm } = swap(new BiometricNotAvailableError('none'));
        await confirm();
        expect(c.Alert.alert).toHaveBeenCalledTimes(1);
        expect(c.Alert.alert).toHaveBeenCalledWith('biometric.biometricRequired', 'swap.errorBiometricUnavailable');
    });

    it('any other failure is still reported as an error', async () => {
        const { c, confirm } = swap(new Error('rpc down'));
        await confirm();
        expect(c.Alert.alert).toHaveBeenCalledTimes(1);
        expect(c.Alert.alert.mock.calls[0][1]).toBe('swap.execution_error');
    });
});
