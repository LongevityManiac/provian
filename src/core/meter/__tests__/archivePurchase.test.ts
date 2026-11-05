/**
 * The person's PE Archive purchase logic. Every positive assertion has its RED beside it.
 *
 * - The app derives a payment's request id exactly as the relay does (so a purchase whose answer was
 * lost can be found), from the payment `signArchivePayment` actually produces.
 * - "Nothing was charged" is said for every refusal, and the one message that is not a refusal
 * (an expired authorization) says it can never be charged instead.
 * - The follow-up never claims "not charged" while the signed authorization could still be used.
 * - The $0.945 balance that stopped the operator reads as $0.94, never rounded up to look like more.
 */
import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { Wallet } from 'ethers';
import en from '../../../i18n/locales/en.json';
import { signArchivePayment } from '../archivePayment';
import {
    ARCHIVE_PENDING_PURCHASE_KEY,
    archiveFailureText,
    archiveRequestIdOf,
    ARCHIVE_FOLLOW_UP_GRACE_S,
    biometricFailureCode,
    followUpVerdict,
    readPendingPurchase,
    savePendingPurchase,
    signedArchivePaymentOf,
    usdcDollars,
} from '../archivePurchase';

const REQUIREMENT = {
    scheme: 'exact',
    network: 'eip155:8453',
    amount: '5000000',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    payTo: '0x086e0F377af1245B8888540f39e99A42a7daF1dA',
};

const archive = (en as unknown as { peArchive: Record<string, string> }).peArchive;
const textOf = (key: string): string => archive[key.replace('peArchive.', '')];

/** The relay's derivation, written out independently (provian-backend usdcChargeRequestId). */
function relayRequestId(from: string, nonce: string): string {
    return `ap_${createHash('sha256').update(`provian.archive.v1|${from.toLowerCase()}|${nonce.toLowerCase()}`).digest('hex').slice(0, 40)}`;
}

describe('archive purchase — request id and the signed payment', () => {
    it('the request id of a real signed payment equals the relay\'s derivation; RED: another nonce differs', async () => {
        const signer = Wallet.createRandom();
        const nonce = '0x' + 'ab'.repeat(32);
        const payment = await signArchivePayment(signer, REQUIREMENT, Date.UTC(2026, 9, 7), nonce);
        const signed = signedArchivePaymentOf(payment);
        expect(signed.requestId).toBe(relayRequestId(signer.address, nonce));
        expect(signed.requestId).toMatch(/^ap_[0-9a-f]{40}$/);
        expect(signed.validBefore).toBe(Math.floor(Date.UTC(2026, 9, 7) / 1000) + 300);
        expect(archiveRequestIdOf(signer.address, '0x' + 'cd'.repeat(32))).not.toBe(signed.requestId);
    });

    it('RED: an unreadable payment is refused, not given a made-up id', () => {
        expect(() => signedArchivePaymentOf(Buffer.from('{"payload":{}}').toString('base64'))).toThrow('archive_payment_unreadable');
    });
});

describe('archive purchase — what a failure says', () => {
    const refusals = [
        'cancelled', 'biometric:lockout', 'sign:no_key', 'record:database or disk is full', 'archive_quote_refused:amount', 'quote:http_500',
        'payment_insufficient_funds', 'waits_for_gas', 'archive_space_available',
        'payment_submit_failed', 'charge_failed', 'transfer_reverted', 'session_unavailable', 'archive_http_401',
        'archive_not_configured', 'archive_payments_not_configured', 'archive_owner_unresolved',
        'payment_signature_invalid', 'payment_expires_too_soon', 'payment_amount_wrong', 'archive_http_404',
    ];

    it('every refusal maps to an existing key whose English says "Nothing was charged." (count > 0)', () => {
        expect(refusals.length).toBeGreaterThan(0);
        for (const code of refusals) {
            const { key } = archiveFailureText(code);
            expect(textOf(key), `${code} → ${key}`).toBeDefined();
            expect(textOf(key), code).toContain('Nothing was charged.');
        }
    });

    it('a reused authorization says nothing MORE was charged (it may have paid once before); RED: not the plain claim', () => {
        for (const code of ['payment_nonce_used', 'payment_already_used']) {
            expect(textOf(archiveFailureText(code).key), code).toContain('Nothing more was charged.');
            expect(textOf(archiveFailureText(code).key), code).not.toContain('Nothing was charged.');
        }
    });

    it('an expired authorization says it can never be charged; RED: the generic answer text carries no such claim', () => {
        expect(textOf(archiveFailureText('authorization_expired').key)).toContain('can never be charged');
        expect(textOf('peArchive.reasonUnknown')).not.toContain('Nothing was charged');
    });

    it('the operator’s case reads plainly: insufficient funds, and the quote\'s balance shows as $0.94 (rounded down)', () => {
        expect(textOf(archiveFailureText('payment_insufficient_funds').key)).toContain('less than $5.00 USDC on Base');
        expect(usdcDollars('945000')).toBe('$0.94');
        expect(usdcDollars('5000000')).toBe('$5.00');
        expect(usdcDollars('0')).toBe('$0.00');
        expect(usdcDollars('4999999')).toBe('$4.99'); // RED: never rounded up to look affordable
    });

    it('a cancelled Face ID is "you cancelled"; any other biometric failure names itself', () => {
        expect(biometricFailureCode({ authError: 'user_cancel' })).toBe('cancelled');
        expect(biometricFailureCode({ authError: 'lockout' })).toBe('biometric:lockout');
        expect(biometricFailureCode(new TypeError('x'))).toBe('biometric:TypeError');
    });
});

describe('archive purchase — following up a lost answer', () => {
    const WALLET = '0x' + '1f'.repeat(20);
    const pending = { requestId: 'ap_' + 'a'.repeat(40), from: WALLET, validBefore: 1_800_000_000, startedAtMs: 0 };

    it('credited / confirming / charge_failed follow the relay', () => {
        expect(followUpVerdict({ state: 'charged', credited: true }, pending, 0)).toEqual({ kind: 'credited' });
        expect(followUpVerdict({ state: 'charge_unconfirmed', credited: false }, pending, 0)).toEqual({ kind: 'confirming' });
        expect(followUpVerdict({ state: 'charge_failed', credited: false }, pending, 0)).toEqual({ kind: 'not_charged', code: 'charge_failed' });
    });

    it('no record: keep waiting while the authorization (plus grace) can still be used; RED: only after it expires is it "not charged"', () => {
        const at = (s: number): number => s * 1000;
        expect(followUpVerdict(null, pending, at(pending.validBefore))).toEqual({ kind: 'keep_waiting' });
        expect(followUpVerdict(null, pending, at(pending.validBefore + ARCHIVE_FOLLOW_UP_GRACE_S))).toEqual({ kind: 'keep_waiting' });
        expect(followUpVerdict(null, pending, at(pending.validBefore + ARCHIVE_FOLLOW_UP_GRACE_S + 1))).toEqual({ kind: 'not_charged', code: 'authorization_expired' });
    });

    const memoryStore = () => {
        const kv = new Map<string, string>();
        return {
            kv,
            getItem: async (k: string) => kv.get(k) ?? null,
            setItem: async (k: string, v: string) => { kv.set(k, v); },
            removeItem: async (k: string) => { kv.delete(k); },
        };
    };

    it('the pending purchase survives a restart for its own wallet (any letter case); RED: a malformed record reads as none', async () => {
        const store = memoryStore();
        await savePendingPurchase(store, pending);
        expect(await readPendingPurchase(store, WALLET)).toEqual(pending);
        expect(await readPendingPurchase(store, WALLET.toUpperCase().replace('0X', '0x'))).toEqual(pending);
        await savePendingPurchase(store, { ...pending, requestId: 'nope' });
        expect(await readPendingPurchase(store, WALLET)).toBeNull();
    });

    it('RED: another wallet never sees (or is blocked by) a pending purchase — the record is cleared', async () => {
        const store = memoryStore();
        await savePendingPurchase(store, pending);
        expect(await readPendingPurchase(store, '0x' + '2e'.repeat(20))).toBeNull();
        expect(store.kv.size).toBe(0);
        expect(await readPendingPurchase(store, WALLET)).toBeNull();
    });

    it('RED: a record from before payers were stored (no from) is cleared, never followed as this wallet\'s', async () => {
        const store = memoryStore();
        store.kv.set(ARCHIVE_PENDING_PURCHASE_KEY, JSON.stringify({ requestId: pending.requestId, validBefore: pending.validBefore, startedAtMs: 0 }));
        expect(await readPendingPurchase(store, WALLET)).toBeNull();
        expect(store.kv.size).toBe(0);
    });
});
