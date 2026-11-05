/**
 * WalletConnect signing vectors for the Provian-reserved-message guard, shared by
 * `provianReserved.test.ts` (the guard alone) and `WalletConnectService.test.ts` (the door +
 * backstop, whose RED controls show each reserved vector SIGNED on the pre-guard service).
 *
 * Every reserved vector is built from the SOURCE that defines the format — the relay's own
 * builders (`provian-backend/...`) or the app's — never a hand-typed copy of the format, so a
 * format change moves the vector with it (no self-referential control).
 */
import stableStringify from 'json-stable-stringify';
import {
    RECOVERY_DOMAIN,
    RECOVERY_TYPES,
    RECOVERY_PURPOSE,
} from '../../../../provian-backend/src/routes/recovery-eip712';
import { humanPromiseSignMessage } from '../../../../provian-backend/src/core/human-promises/promise-signing';
import { buildProofMessage } from '../../../../provian-backend/src/core/external-address/challenge';
import { presentationBindingString } from '../../presentation/humanPresentation';
import { HIRE_ESCROW_SALT_MESSAGE } from '../../wallet/hireEscrowSaltMessage';

export interface SignVector {
    name: string;
    method: string;
    params: unknown[];
}

export const WALLET = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const DIGEST = 'a'.repeat(64);

const hex = (text: string): string => `0x${Buffer.from(text, 'utf8').toString('hex')}`;

/** The exact RelayRecovery typed data POST /v1/users/recover accepts. */
export function recoveryTypedData(): Record<string, unknown> {
    return {
        types: {
            EIP712Domain: [
                { name: 'name', type: 'string' },
                { name: 'version', type: 'string' },
                { name: 'chainId', type: 'uint256' },
                { name: 'verifyingContract', type: 'address' },
            ],
            ...RECOVERY_TYPES,
        },
        primaryType: 'RelayRecovery',
        domain: { ...RECOVERY_DOMAIN },
        message: { user: WALLET, timestamp: 1790000000, purpose: RECOVERY_PURPOSE },
    };
}

/** An innocuous-looking struct under a caller-chosen verifyingContract. */
export function innocuousTypedData(verifyingContract: string): Record<string, unknown> {
    return {
        types: {
            EIP712Domain: [
                { name: 'name', type: 'string' },
                { name: 'version', type: 'string' },
                { name: 'chainId', type: 'uint256' },
                { name: 'verifyingContract', type: 'address' },
            ],
            Login: [
                { name: 'wallet', type: 'address' },
                { name: 'nonce', type: 'uint256' },
            ],
        },
        primaryType: 'Login',
        domain: { name: 'Friendly Game', version: '1', chainId: 8453, verifyingContract },
        message: { wallet: WALLET, nonce: 7 },
    };
}

const linkPayload = { action: 'link_agent', agent_wallet_id: 'wallet_agent1', human_wallet_id: 'wallet_human1', timestamp: 1790000000 };
const unlinkPayload = { action: 'unlink_agent', agent_wallet_id: 'wallet_agent1', human_wallet_id: 'wallet_human1', timestamp: 1790000000 };
const sharePayload = {
    action: 'update_beneficiary_share',
    agent_wallet_id: 'wallet_agent1',
    human_wallet_id: 'wallet_human1',
    operational_reserve_bps: 2000,
    timestamp: 1790000000,
};

const presentationV1 = presentationBindingString({
    tier: 'reputation',
    presenterAddress: WALLET,
    aud: 'https://verifier.example',
    chal: 'c'.repeat(32),
    iat: 1790000000,
    exp: 1790000300,
    jti: 'jti-1',
    burnId: 'burn-1',
    claimsDigest: DIGEST,
});
const presentationV2 = presentationBindingString({
    tier: 'reputation',
    presenterAddress: WALLET,
    aud: 'https://verifier.example',
    chal: 'c'.repeat(32),
    iat: 1790000000,
    exp: 1790000300,
    jti: 'jti-1',
    burnId: 'burn-1',
    claimsDigest: DIGEST,
    requester: { type: 'domain', id: 'verifier.example' },
    chalExp: 1790000600,
});
const proofOfControl = buildProofMessage({
    agentId: 'wallet_agent1',
    address: WALLET,
    nonce: 'n'.repeat(32),
    issuedIso: '2026-09-26T00:00:00.000Z',
    expiresIso: '2026-09-26T00:10:00.000Z',
});
const promiseCloseout = humanPromiseSignMessage('closeout', 'promise_123', DIGEST);

/** Requests that must never be signed. */
export const RESERVED_VECTORS: SignVector[] = [
    { name: 'recovery typed data (v4, JSON string)', method: 'eth_signTypedData_v4', params: [WALLET, JSON.stringify(recoveryTypedData())] },
    { name: 'recovery typed data (v4, object)', method: 'eth_signTypedData_v4', params: [WALLET, recoveryTypedData()] },
    { name: 'recovery typed data (legacy method, reversed params)', method: 'eth_signTypedData', params: [JSON.stringify(recoveryTypedData()), WALLET] },
    { name: 'promise closeout (hex)', method: 'personal_sign', params: [hex(promiseCloseout), WALLET] },
    { name: 'promise closeout (text, reversed params)', method: 'personal_sign', params: [WALLET, promiseCloseout] },
    { name: 'link_agent consent (relay stableStringify)', method: 'personal_sign', params: [stableStringify(linkPayload), WALLET] },
    {
        name: 'link_agent consent (reordered keys + whitespace)',
        method: 'personal_sign',
        params: [`  ${JSON.stringify({ timestamp: 1790000000, human_wallet_id: 'wallet_human1', agent_wallet_id: 'wallet_agent1', action: 'link_agent' }, null, 2)}\n`, WALLET],
    },
    { name: 'unlink_agent consent (hex)', method: 'personal_sign', params: [hex(stableStringify(unlinkPayload) ?? ''), WALLET] },
    { name: 'share update consent', method: 'personal_sign', params: [stableStringify(sharePayload), WALLET] },
    { name: 'presentation v1 binding', method: 'personal_sign', params: [presentationV1, WALLET] },
    { name: 'presentation v2 binding (hex)', method: 'personal_sign', params: [hex(presentationV2), WALLET] },
    { name: 'external-address proof of control', method: 'personal_sign', params: [proofOfControl, WALLET] },
    { name: 'hire escrow salt message', method: 'personal_sign', params: [HIRE_ESCROW_SALT_MESSAGE, WALLET] },
    { name: 'hire escrow salt message (hex)', method: 'personal_sign', params: [hex(HIRE_ESCROW_SALT_MESSAGE), WALLET] },
    { name: 'zero-width obfuscated "Prov\\u200Bian"', method: 'personal_sign', params: ['Sign in to Prov​ian relay', WALLET] },
    { name: 'BOM + soft-hyphen + word-joiner obfuscation', method: 'personal_sign', params: ['﻿P­ro⁠vian recovery', WALLET] },
    { name: 'uppercase PROVIAN', method: 'personal_sign', params: ['PROVIAN.PROMISE.V1|closeout|x|y', WALLET] },
    { name: 'spaced p r o v i a n', method: 'personal_sign', params: ['p r o v\ti a n', WALLET] },
    { name: 'fullwidth ｐｒｏｖｉａｎ', method: 'personal_sign', params: ['ｐｒｏｖｉａｎ', WALLET] },
    { name: 'Cyrillic homoglyph "Prоviаn"', method: 'personal_sign', params: ['Prоviаn', WALLET] },
    { name: 'accented "Províán"', method: 'personal_sign', params: ['Províán', WALLET] },
    { name: 'typed data: Provian verifyingContract, innocuous name', method: 'eth_signTypedData_v4', params: [WALLET, JSON.stringify(innocuousTypedData(RECOVERY_DOMAIN.verifyingContract as string))] },
    {
        name: 'typed data: RegisterHumanWallet under a Provian domain',
        method: 'eth_signTypedData_v4',
        params: [WALLET, JSON.stringify({
            types: { RegisterHumanWallet: [{ name: 'wallet', type: 'address' }, { name: 'userId', type: 'string' }, { name: 'nonce', type: 'bytes32' }] },
            primaryType: 'RegisterHumanWallet',
            domain: { name: 'Provian Human Wallet Registration', version: '1', chainId: 8453 },
            message: { wallet: WALLET, userId: 'u1', nonce: `0x${DIGEST}` },
        })],
    },
    {
        name: 'typed data: RegisterHumanWallet struct under an innocuous domain',
        method: 'eth_signTypedData_v4',
        params: [WALLET, JSON.stringify({
            types: { RegisterHumanWallet: [{ name: 'wallet', type: 'address' }] },
            primaryType: 'RegisterHumanWallet',
            domain: { name: 'Friendly Game', version: '1', chainId: 8453 },
            message: { wallet: WALLET },
        })],
    },
    {
        name: 'typed data: RelayRecovery struct under an innocuous domain, no verifyingContract',
        method: 'eth_signTypedData_v4',
        params: [WALLET, JSON.stringify({
            ...recoveryTypedData(),
            domain: { name: 'SomeApp', version: '1', chainId: 8453 },
        })],
    },
    {
        name: 'link_agent consent with an extra single-use nonce field',
        method: 'personal_sign',
        params: [stableStringify({ ...linkPayload, nonce: 'n-123' }), WALLET],
    },
    // the single-use consent payloads the relay now verifies (link_epoch bound in).
    {
        name: ' link_agent consent with link_epoch',
        method: 'personal_sign',
        params: [stableStringify({ ...linkPayload, link_epoch: 3 }), WALLET],
    },
    {
        name: ' unlink_agent consent with link_epoch',
        method: 'personal_sign',
        params: [stableStringify({ ...unlinkPayload, link_epoch: 4 }), WALLET],
    },
    {
        name: ' update_beneficiary_share consent with link_epoch',
        method: 'personal_sign',
        params: [stableStringify({ action: 'update_beneficiary_share', agent_wallet_id: 'wallet_agent1', human_wallet_id: 'wallet_human1', link_epoch: 5, operational_reserve_bps: 3000, timestamp: 1790000000 }), WALLET],
    },
    {
        name: 'typed data: "Provian" only in domain.version',
        method: 'eth_signTypedData_v4',
        params: [WALLET, JSON.stringify({ ...innocuousTypedData('0x1111111111111111111111111111111111111111'), domain: { name: 'X', version: 'provian-1', chainId: 8453 } })],
    },
    {
        name: 'typed data: verifyingContract without 0x, upper-case',
        method: 'eth_signTypedData_v4',
        params: [WALLET, JSON.stringify(innocuousTypedData((RECOVERY_DOMAIN.verifyingContract as string).slice(2).toUpperCase()))],
    },
    {
        name: 'typed data v1 array form naming Provian',
        method: 'eth_signTypedData',
        params: [[{ type: 'string', name: 'note', value: 'Recover Provian relay credentials' }], WALLET],
    },
];

/** Ordinary requests that must still reach the normal signing path. */
export const ALLOWED_VECTORS: SignVector[] = [
    {
        name: 'SIWE (EIP-4361) login',
        method: 'personal_sign',
        params: [[
            'app.uniswap.org wants you to sign in with your Ethereum account:',
            WALLET,
            '',
            'Sign in to Uniswap',
            '',
            'URI: https://app.uniswap.org',
            'Version: 1',
            'Chain ID: 8453',
            'Nonce: 32891756',
            'Issued At: 2026-09-26T00:00:00.000Z',
        ].join('\n'), WALLET],
    },
    { name: 'SIWE-style login (hex)', method: 'personal_sign', params: [hex('Welcome to OpenSea!\n\nNonce: 1234'), WALLET] },
    { name: '32-byte digest', method: 'personal_sign', params: [`0x${'ab'.repeat(32)}`, WALLET] },
    { name: 'JSON message without consent keys', method: 'personal_sign', params: [JSON.stringify({ nonce: 5, app: 'game' }), WALLET] },
    { name: 'generic JSON sign-in with an "action" key', method: 'personal_sign', params: [JSON.stringify({ action: 'login', nonce: 'abc', timestamp: 1790000000 }), WALLET] },
    {
        name: 'typed data Grant{user,purpose} under another app domain',
        method: 'eth_signTypedData_v4',
        params: [WALLET, JSON.stringify({
            types: { Grant: [{ name: 'user', type: 'address' }, { name: 'purpose', type: 'string' }] },
            primaryType: 'Grant',
            domain: { name: 'SomeApp', version: '1', chainId: 8453 },
            message: { user: WALLET, purpose: 'access' },
        })],
    },
    {
        name: 'Uniswap Permit2 PermitSingle',
        method: 'eth_signTypedData_v4',
        params: [WALLET, JSON.stringify({
            types: {
                EIP712Domain: [
                    { name: 'name', type: 'string' },
                    { name: 'chainId', type: 'uint256' },
                    { name: 'verifyingContract', type: 'address' },
                ],
                PermitSingle: [
                    { name: 'details', type: 'PermitDetails' },
                    { name: 'spender', type: 'address' },
                    { name: 'sigDeadline', type: 'uint256' },
                ],
                PermitDetails: [
                    { name: 'token', type: 'address' },
                    { name: 'amount', type: 'uint160' },
                    { name: 'expiration', type: 'uint48' },
                    { name: 'nonce', type: 'uint48' },
                ],
            },
            primaryType: 'PermitSingle',
            domain: { name: 'Permit2', chainId: 8453, verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3' },
            message: {
                details: { token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '1000000', expiration: '1790000000', nonce: '0' },
                spender: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD',
                sigDeadline: '1790000000',
            },
        })],
    },
    {
        name: 'USDC EIP-2612 permit on Base',
        method: 'eth_signTypedData_v4',
        params: [WALLET, JSON.stringify({
            types: {
                EIP712Domain: [
                    { name: 'name', type: 'string' },
                    { name: 'version', type: 'string' },
                    { name: 'chainId', type: 'uint256' },
                    { name: 'verifyingContract', type: 'address' },
                ],
                Permit: [
                    { name: 'owner', type: 'address' },
                    { name: 'spender', type: 'address' },
                    { name: 'value', type: 'uint256' },
                    { name: 'nonce', type: 'uint256' },
                    { name: 'deadline', type: 'uint256' },
                ],
            },
            primaryType: 'Permit',
            domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
            message: { owner: WALLET, spender: '0x2222222222222222222222222222222222222222', value: '1000000', nonce: '0', deadline: '1790000000' },
        })],
    },
    { name: 'innocuous typed data, unrelated contract', method: 'eth_signTypedData_v4', params: [WALLET, JSON.stringify(innocuousTypedData('0x1111111111111111111111111111111111111111'))] },
];
