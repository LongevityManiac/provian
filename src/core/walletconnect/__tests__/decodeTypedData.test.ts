/**
 * Unit tests for the WalletConnect gasless-approval (permit / Permit2) decoder.
 * Uses real ethers (no mock) — see decodeCalldata.test.ts for the rationale.
 */
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { decodeTypedData, isKnownNonSpendTypedData, PERMIT2_ADDRESS } from '../decodeTypedData';

const BASE = 8453;
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const DAI_BASE = '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb';
const RANDOM_TOKEN = '0x1234567890123456789012345678901234567890';
const NOT_PERMIT2 = '0x9999999999999999999999999999999999999999';
const SPENDER = '0x2222222222222222222222222222222222222222';
const OWNER = '0x1111111111111111111111111111111111111111';
const UINT160_MAX = ((2n ** 160n) - 1n).toString();

const EIP2612_TYPES = {
    EIP712Domain: [{ name: 'name', type: 'string' }],
    Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
    ],
};
const DAI_TYPES = {
    Permit: [
        { name: 'holder', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'nonce', type: 'uint256' },
        { name: 'expiry', type: 'uint256' },
        { name: 'allowed', type: 'bool' },
    ],
};
const PERMIT_DETAILS = [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint160' },
    { name: 'expiration', type: 'uint48' },
    { name: 'nonce', type: 'uint48' },
];
const PERMIT_SINGLE_TYPES = {
    PermitSingle: [
        { name: 'details', type: 'PermitDetails' },
        { name: 'spender', type: 'address' },
        { name: 'sigDeadline', type: 'uint256' },
    ],
    PermitDetails: PERMIT_DETAILS,
};
const PERMIT_BATCH_TYPES = {
    PermitBatch: [
        { name: 'details', type: 'PermitDetails[]' },
        { name: 'spender', type: 'address' },
        { name: 'sigDeadline', type: 'uint256' },
    ],
    PermitDetails: PERMIT_DETAILS,
};
const TRANSFER_FROM_TYPES = {
    PermitTransferFrom: [
        { name: 'permitted', type: 'TokenPermissions' },
        { name: 'spender', type: 'address' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
    ],
    TokenPermissions: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint256' },
    ],
};
// [F16] EIP-3009 gasless transfer authorization — the exact shape this repo's own
// x402 signer produces. The verifyingContract IS the token; a signature here
// authorizes an immediate one-shot spend of `value` from `from` to `to`.
const EIP3009_TYPES = {
    TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
    ],
};
const RECEIVE_3009_TYPES = { ReceiveWithAuthorization: EIP3009_TYPES.TransferWithAuthorization };
const NONCE32 = '0x' + '11'.repeat(32);
function eip3009(token: string, value: string, primaryType: 'TransferWithAuthorization' | 'ReceiveWithAuthorization' = 'TransferWithAuthorization') {
    return {
        primaryType,
        domain: { name: 'USD Coin', version: '2', chainId: BASE, verifyingContract: token },
        types: primaryType === 'TransferWithAuthorization' ? EIP3009_TYPES : RECEIVE_3009_TYPES,
        message: { from: OWNER, to: SPENDER, value, validAfter: '0', validBefore: '1900000000', nonce: NONCE32 },
    };
}

function eip2612(token: string, value: string, chainId?: number | string) {
    const domain: Record<string, unknown> = { name: 'USD Coin', version: '2', verifyingContract: token };
    if (chainId !== undefined) domain.chainId = chainId;
    return { primaryType: 'Permit', domain, types: EIP2612_TYPES, message: { owner: OWNER, spender: SPENDER, value, nonce: '0', deadline: '1900000000' } };
}
function daiPermit(allowed: unknown) {
    return {
        primaryType: 'Permit',
        domain: { name: 'Dai Stablecoin', version: '1', chainId: BASE, verifyingContract: DAI_BASE },
        types: DAI_TYPES,
        message: { holder: OWNER, spender: SPENDER, nonce: '0', expiry: '1900000000', allowed },
    };
}
function permit2Single(token: string, amount: string, verifyingContract: string = PERMIT2_ADDRESS) {
    return {
        primaryType: 'PermitSingle',
        domain: { name: 'Permit2', chainId: BASE, verifyingContract },
        types: PERMIT_SINGLE_TYPES,
        message: { details: { token, amount, expiration: '1900000000', nonce: '0' }, spender: SPENDER, sigDeadline: '1900000000' },
    };
}
function permit2Batch(items: Array<{ token: string; amount: string }>) {
    return {
        primaryType: 'PermitBatch',
        domain: { name: 'Permit2', chainId: BASE, verifyingContract: PERMIT2_ADDRESS },
        types: PERMIT_BATCH_TYPES,
        message: {
            details: items.map(i => ({ token: i.token, amount: i.amount, expiration: '1900000000', nonce: '0' })),
            spender: SPENDER, sigDeadline: '1900000000',
        },
    };
}
function permitTransferFrom(token: string, amount: string) {
    return {
        primaryType: 'PermitTransferFrom',
        domain: { name: 'Permit2', chainId: BASE, verifyingContract: PERMIT2_ADDRESS },
        types: TRANSFER_FROM_TYPES,
        message: { permitted: { token, amount }, spender: SPENDER, nonce: '0', deadline: '1900000000' },
    };
}

describe('decodeTypedData — EIP-2612 permit', () => {
    it('decodes a limited USDC permit as medium risk', () => {
        const d = decodeTypedData(eip2612(USDC_BASE, '1000000', BASE));
        expect(d?.kind).toBe('erc2612_permit');
        expect(d?.tokenKnown).toBe(true);
        expect(d?.tokenSymbol).toBe('USDC');
        expect(d?.amountFormatted).toBe('1');
        expect(d?.spender.toLowerCase()).toBe(SPENDER);
        expect(d?.isUnlimited).toBe(false);
        expect(d?.riskLevel).toBe('medium');
    });

    it('flags an unlimited (MaxUint256) permit as high risk', () => {
        const d = decodeTypedData(eip2612(USDC_BASE, ethers.MaxUint256.toString(), BASE));
        expect(d?.isUnlimited).toBe(true);
        expect(d?.riskLevel).toBe('high');
    });

    it('resolves the token when chainId is a hex string', () => {
        const d = decodeTypedData(eip2612(USDC_BASE, '1000000', '0x2105')); // 0x2105 = 8453
        expect(d?.tokenSymbol).toBe('USDC');
    });

    it('treats an unverified-token permit as high risk (most-restrictive null-state)', () => {
        const d = decodeTypedData(eip2612(RANDOM_TOKEN, ethers.MaxUint256.toString(), BASE));
        expect(d?.tokenKnown).toBe(false);
        expect(d?.amountFormatted).toBeUndefined();
        expect(d?.riskLevel).toBe('high');
    });

    it('rejects a superset struct merely named "Permit" (type mismatch)', () => {
        const td = eip2612(USDC_BASE, '1000000', BASE);
        // Fresh types object (do NOT mutate the shared EIP2612_TYPES const).
        td.types = {
            EIP712Domain: EIP2612_TYPES.EIP712Domain,
            Permit: [...EIP2612_TYPES.Permit, { name: 'operator', type: 'address' }], // extra field → different digest
        };
        expect(decodeTypedData(td)).toBeNull();
    });

    it('uses the session chainId when domain.chainId is omitted', () => {
        const td = eip2612(USDC_BASE, ethers.MaxUint256.toString()); // no domain.chainId
        const d = decodeTypedData(td, BASE);
        expect(d?.tokenKnown).toBe(true);
        expect(d?.tokenSymbol).toBe('USDC');
        expect(d?.isUnlimited).toBe(true);
        expect(d?.riskLevel).toBe('high');
    });
});

describe('decodeTypedData — DAI allowed-style permit', () => {
    it('treats allowed=true as an unlimited approval (high risk)', () => {
        const d = decodeTypedData(daiPermit(true));
        expect(d?.kind).toBe('dai_permit');
        expect(d?.tokenSymbol).toBe('DAI');
        expect(d?.isUnlimited).toBe(true);
        expect(d?.riskLevel).toBe('high');
    });

    it('treats allowed=false as a revocation (medium, isRevoke)', () => {
        const d = decodeTypedData(daiPermit(false));
        expect(d?.kind).toBe('dai_permit');
        expect(d?.isRevoke).toBe(true);
        expect(d?.isUnlimited).toBe(false);
        expect(d?.riskLevel).toBe('medium');
    });

    it('fails closed: a truthy non-boolean allowed is a grant, not a revoke', () => {
        // EIP-712 bool encodes by truthiness — "0x1" signs as allowed=true.
        const d = decodeTypedData(daiPermit('0x1'));
        expect(d?.kind).toBe('dai_permit');
        expect(d?.isRevoke).toBeFalsy();
        expect(d?.isUnlimited).toBe(true);
        expect(d?.riskLevel).toBe('high');
    });
});

describe('decodeTypedData — Permit2', () => {
    it('decodes a PermitSingle as a permit2_single approval', () => {
        const d = decodeTypedData(permit2Single(USDC_BASE, '5000000'));
        expect(d?.kind).toBe('permit2_single');
        expect(d?.tokenSymbol).toBe('USDC');
        expect(d?.amountFormatted).toBe('5');
        expect(d?.isUnlimited).toBe(false);
    });

    it('flags a uint160-max PermitSingle as unlimited/high', () => {
        const d = decodeTypedData(permit2Single(USDC_BASE, UINT160_MAX));
        expect(d?.isUnlimited).toBe(true);
        expect(d?.riskLevel).toBe('high');
    });

    it('REJECTS a Permit2 shape whose verifyingContract is not canonical Permit2', () => {
        // The attack: real USDC token in details, but a malicious verifying contract.
        expect(decodeTypedData(permit2Single(USDC_BASE, '5000000', NOT_PERMIT2))).toBeNull();
    });

    it('decodes a PermitBatch with per-item amounts and flags high when any is unlimited', () => {
        const d = decodeTypedData(permit2Batch([
            { token: USDC_BASE, amount: '1000000' },
            { token: USDC_BASE, amount: UINT160_MAX },
        ]));
        expect(d?.kind).toBe('permit2_batch');
        expect(d?.batchCount).toBe(2);
        expect(d?.items?.length).toBe(2);
        expect(d?.isUnlimited).toBe(true);
        expect(d?.riskLevel).toBe('high');
    });

    it('escalates a PermitBatch to high when any token is unverified', () => {
        const d = decodeTypedData(permit2Batch([
            { token: USDC_BASE, amount: '1000000' },
            { token: RANDOM_TOKEN, amount: '1000000' },
        ]));
        expect(d?.isUnlimited).toBe(false);
        expect(d?.riskLevel).toBe('high'); // unverified token present
    });

    it('treats an all-known, all-bounded PermitBatch as medium', () => {
        const d = decodeTypedData(permit2Batch([
            { token: USDC_BASE, amount: '1000000' },
            { token: USDC_BASE, amount: '2000000' },
        ]));
        expect(d?.riskLevel).toBe('medium');
    });

    it('returns null for an empty PermitBatch', () => {
        expect(decodeTypedData(permit2Batch([]))).toBeNull();
    });

    it('decodes PermitTransferFrom as a high-risk one-shot transfer', () => {
        const d = decodeTypedData(permitTransferFrom(USDC_BASE, '5000000'));
        expect(d?.kind).toBe('permit2_transfer');
        expect(d?.isTransfer).toBe(true);
        expect(d?.tokenSymbol).toBe('USDC');
        expect(d?.riskLevel).toBe('high');
    });

    it('does not throw on a malformed batch row (null element) and treats it as high', () => {
        const td = {
            primaryType: 'PermitBatch',
            domain: { name: 'Permit2', chainId: BASE, verifyingContract: PERMIT2_ADDRESS },
            types: PERMIT_BATCH_TYPES,
            message: { details: [null], spender: SPENDER, sigDeadline: '1900000000' },
        };
        const d = decodeTypedData(td);
        expect(d?.kind).toBe('permit2_batch');
        expect(d?.riskLevel).toBe('high'); // unverified/garbage row → high, no throw
    });
});

describe('decodeTypedData — EIP-3009 transfer authorization [F16]', () => {
    it('decodes a USDC TransferWithAuthorization as a high-risk one-shot transfer', () => {
        const d = decodeTypedData(eip3009(USDC_BASE, '5000000'), BASE);
        expect(d?.kind).toBe('eip3009_transfer');
        expect(d?.isTransfer).toBe(true);
        expect(d?.tokenSymbol).toBe('USDC');
        expect(d?.tokenKnown).toBe(true);
        // The recipient (`to`) is surfaced as the spender for display/governance.
        expect(d?.spender.toLowerCase()).toBe(SPENDER);
        expect(d?.riskLevel).toBe('high'); // any transfer authorization is high
        // A transfer authorization is NOT a revoke, so the service routes it to the
        // GOVERNED permit path — never the biometric-only plain path.
        expect(d?.isRevoke).toBeFalsy();
    });

    it('decodes ReceiveWithAuthorization the same way (also a spend authorization)', () => {
        const d = decodeTypedData(eip3009(USDC_BASE, '1000000', 'ReceiveWithAuthorization'), BASE);
        expect(d?.kind).toBe('eip3009_transfer');
        expect(d?.isTransfer).toBe(true);
        expect(d?.isRevoke).toBeFalsy();
    });

    it('treats an unverified-token EIP-3009 authorization as high (most-restrictive null-state)', () => {
        const d = decodeTypedData(eip3009(RANDOM_TOKEN, '5000000'), BASE);
        expect(d?.kind).toBe('eip3009_transfer');
        expect(d?.tokenKnown).toBe(false);
        expect(d?.riskLevel).toBe('high');
    });

    it('rejects a struct merely NAMED TransferWithAuthorization with a mismatched field list', () => {
        const td = eip3009(USDC_BASE, '5000000');
        // An extra field changes the EIP-712 digest → not the canonical shape → null
        // (falls through to the service\'s fail-closed unknown-typed-data path).
        td.types = { TransferWithAuthorization: [...EIP3009_TYPES.TransferWithAuthorization, { name: 'extra', type: 'address' }] };
        expect(decodeTypedData(td, BASE)).toBeNull();
    });
});

describe('isKnownNonSpendTypedData — the non-spend allowlist is empty and unborrowable [F16]', () => {
    it('returns false for an EIP-3009 spend authorization (it is never "known non-spend")', () => {
        // The exact confusion F16 closes: a fund-moving signature must not be
        // admitted to the biometric-only branch as a benign non-spend message.
        expect(isKnownNonSpendTypedData(eip3009(USDC_BASE, '5000000'))).toBe(false);
    });

    it('returns false for an arbitrary login-shaped message (registry is intentionally empty)', () => {
        const login = {
            primaryType: 'Login',
            domain: { name: 'App', chainId: BASE },
            types: { Login: [{ name: 'statement', type: 'string' }, { name: 'nonce', type: 'string' }] },
            message: { statement: 'Sign in', nonce: 'abc' },
        };
        expect(isKnownNonSpendTypedData(login)).toBe(false);
    });

    it('returns false for null / non-object / missing primaryType', () => {
        expect(isKnownNonSpendTypedData(null)).toBe(false);
        expect(isKnownNonSpendTypedData('nope')).toBe(false);
        expect(isKnownNonSpendTypedData({ types: {}, message: {} })).toBe(false);
    });
});

describe('decodeTypedData — non-permit and malformed', () => {
    it('returns null for non-permit typed data', () => {
        const mail = {
            primaryType: 'Mail',
            domain: { chainId: BASE },
            types: { Mail: [{ name: 'contents', type: 'string' }] },
            message: { contents: 'hello' },
        };
        expect(decodeTypedData(mail)).toBeNull();
    });

    it('returns null for null / non-object / missing message', () => {
        expect(decodeTypedData(null)).toBeNull();
        expect(decodeTypedData('nope')).toBeNull();
        expect(decodeTypedData({ primaryType: 'Permit' })).toBeNull();
    });
});
