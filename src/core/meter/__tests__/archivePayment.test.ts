/**
 * — the person's $5 PE Archive payment (one GB, kept permanently). The money terms are
 * pinned on the device: a quote naming another amount, token, chain or recipient is refused BEFORE
 * the key signs anything. The $1 payout quote is refused here too (and the $5 quote by the payout).
 */
import { describe, it, expect, vi } from 'vitest';
import { ethers } from 'ethers';
import { BASE_USDC_EIP712_DOMAIN, PAYOUT_FEE_RECIPIENT, payoutRequirementProblem, type PayoutRequirement } from '../../payout/payoutPayment';
import { ARCHIVE_GB_FEE_USDC_ATOMIC, archiveRequirementProblem, signArchivePayment } from '../archivePayment';

const quote: PayoutRequirement = {
    scheme: 'exact',
    network: 'eip155:8453',
    amount: '5000000',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    payTo: '0x086e0f377af1245b8888540f39e99a42a7daf1da',
    maxTimeoutSeconds: 300,
};

describe('PE Archive payment (app)', () => {
    it('signs exactly $5 Base USDC to the revenue wallet, recoverable to this wallet', async () => {
        expect(ARCHIVE_GB_FEE_USDC_ATOMIC).toBe('5000000');
        const wallet = new ethers.Wallet(`0x${'11'.repeat(32)}`);
        const b64 = await signArchivePayment(wallet, quote, 1_790_000_000_000, `0x${'ab'.repeat(32)}`);
        const decoded = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
        expect(decoded.x402Version).toBe(2);
        expect(decoded.accepted).toMatchObject({ amount: '5000000', payTo: PAYOUT_FEE_RECIPIENT });
        const auth = decoded.payload.authorization;
        expect(auth).toMatchObject({ from: wallet.address, to: PAYOUT_FEE_RECIPIENT, value: '5000000', validAfter: '0' });
        const types = { TransferWithAuthorization: [
            { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
            { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
        ] };
        expect(ethers.verifyTypedData(BASE_USDC_EIP712_DOMAIN, types, auth, decoded.payload.signature)).toBe(wallet.address);
    });

    it.each([
        ['another recipient', { payTo: '0x' + '22'.repeat(20) }, 'recipient'],
        ['the $1 payout amount', { amount: '1000000' }, 'amount'],
        ['a larger amount', { amount: '50000000' }, 'amount'],
        ['another token', { asset: '0x' + '33'.repeat(20) }, 'asset'],
        ['another chain', { network: 'eip155:1' }, 'network'],
    ])('RED: refuses a quote naming %s, before signing', async (_label, change, reason) => {
        const bad = { ...quote, ...change };
        expect(archiveRequirementProblem(bad)).toBe(reason);
        const signer = { address: '0x' + '44'.repeat(20), signTypedData: vi.fn(async () => '0x') };
        await expect(signArchivePayment(signer, bad)).rejects.toThrow(`archive_quote_refused:${reason}`);
        expect(signer.signTypedData).not.toHaveBeenCalled();
    });

    it('RED: the payout signer refuses the $5 Archive quote (each fee is pinned to its own terms)', () => {
        expect(payoutRequirementProblem(quote)).toBe('amount');
        expect(archiveRequirementProblem(quote)).toBeNull();
    });
});
