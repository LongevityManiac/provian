/**
 * Unit tests for the WalletConnect ERC-20 / ERC-721 calldata decoder.
 *
 * This file deliberately does NOT mock ethers (unlike WalletConnectService.test.ts),
 * so real ethers v6 Interface decoding runs. Vitest isolates module mocks per file.
 */
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { decodeTransactionCall, resolveToken } from '../decodeCalldata';

const BASE = 8453;
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH_BASE = '0x4200000000000000000000000000000000000006';
const RANDOM_TOKEN = '0x1234567890123456789012345678901234567890';
const RECIPIENT = '0x1111111111111111111111111111111111111111';
const SPENDER = '0x2222222222222222222222222222222222222222';
const OPERATOR = '0x3333333333333333333333333333333333333333';

const IFACE = new ethers.Interface([
    'function transfer(address to, uint256 amount)',
    'function approve(address spender, uint256 amount)',
    'function increaseAllowance(address spender, uint256 addedValue)',
    'function transferFrom(address from, address to, uint256 amount)',
    'function setApprovalForAll(address operator, bool approved)',
]);

describe('resolveToken', () => {
    it('resolves a known token (USDC on Base) to symbol + decimals', () => {
        const t = resolveToken(USDC_BASE, BASE);
        expect(t.known).toBe(true);
        expect(t.symbol).toBe('USDC');
        expect(t.decimals).toBe(6);
    });

    it('resolves WETH on Base to 18 decimals', () => {
        expect(resolveToken(WETH_BASE, BASE)).toMatchObject({ known: true, symbol: 'WETH', decimals: 18 });
    });

    it('is case-insensitive on the address', () => {
        expect(resolveToken(USDC_BASE.toLowerCase(), BASE).symbol).toBe('USDC');
    });

    it('returns known:false for an unrecognised address', () => {
        expect(resolveToken(RANDOM_TOKEN, BASE).known).toBe(false);
    });

    it('returns known:false for an unconfigured chain (e.g. ETH mainnet)', () => {
        expect(resolveToken(USDC_BASE, 1).known).toBe(false);
    });
});

describe('decodeTransactionCall', () => {
    it('classifies a plain native transfer when data is 0x', () => {
        expect(decodeTransactionCall(RECIPIENT, '0x', BASE).kind).toBe('native_transfer');
    });

    it('decodes an ERC-20 transfer of a known token with a formatted amount', () => {
        const data = IFACE.encodeFunctionData('transfer', [RECIPIENT, 1_500_000n]); // 1.5 USDC
        const d = decodeTransactionCall(USDC_BASE, data, BASE);
        expect(d.kind).toBe('erc20_transfer');
        expect(d.tokenKnown).toBe(true);
        expect(d.tokenSymbol).toBe('USDC');
        expect(d.amountRaw).toBe('1500000');
        expect(d.amountFormatted).toBe('1.5');
        expect(d.counterparty?.toLowerCase()).toBe(RECIPIENT);
        expect(d.riskLevel).toBe('low');
    });

    it('does NOT format the amount for an unknown token (never assumes decimals)', () => {
        const data = IFACE.encodeFunctionData('transfer', [RECIPIENT, 1_500_000n]);
        const d = decodeTransactionCall(RANDOM_TOKEN, data, BASE);
        expect(d.kind).toBe('erc20_transfer');
        expect(d.tokenKnown).toBe(false);
        expect(d.amountRaw).toBe('1500000');
        expect(d.amountFormatted).toBeUndefined();
        expect(d.riskLevel).toBe('medium');
    });

    it('decodes a limited approve as medium risk', () => {
        const data = IFACE.encodeFunctionData('approve', [SPENDER, 1_000_000n]); // 1 USDC
        const d = decodeTransactionCall(USDC_BASE, data, BASE);
        expect(d.kind).toBe('erc20_approve');
        expect(d.isUnlimitedApproval).toBe(false);
        expect(d.amountFormatted).toBe('1');
        expect(d.counterparty?.toLowerCase()).toBe(SPENDER);
        expect(d.riskLevel).toBe('medium');
    });

    it('flags an unlimited approve (MaxUint256) as high risk', () => {
        const data = IFACE.encodeFunctionData('approve', [SPENDER, ethers.MaxUint256]);
        const d = decodeTransactionCall(USDC_BASE, data, BASE);
        expect(d.kind).toBe('erc20_approve');
        expect(d.isUnlimitedApproval).toBe(true);
        expect(d.riskLevel).toBe('high');
        expect(d.amountRaw).toBe(ethers.MaxUint256.toString());
    });

    it('flags a near-max approve (2^240) as unlimited', () => {
        const data = IFACE.encodeFunctionData('approve', [SPENDER, 2n ** 240n]);
        expect(decodeTransactionCall(USDC_BASE, data, BASE).isUnlimitedApproval).toBe(true);
    });

    it('flags a drain-all stablecoin approve (decimals-aware) as unlimited', () => {
        // 1e30 USDC base units = 1e24 whole USDC (far above any real supply),
        // yet 1e30 < 2^200 — the absolute threshold alone would miss it.
        const data = IFACE.encodeFunctionData('approve', [SPENDER, 10n ** 30n]);
        const d = decodeTransactionCall(USDC_BASE, data, BASE);
        expect(d.isUnlimitedApproval).toBe(true);
        expect(d.riskLevel).toBe('high');
    });

    it('treats the decimals-aware boundary correctly (>= 1e12 whole tokens is unlimited)', () => {
        const atCeiling = IFACE.encodeFunctionData('approve', [SPENDER, 10n ** 18n]); // 1e12 USDC
        expect(decodeTransactionCall(USDC_BASE, atCeiling, BASE).isUnlimitedApproval).toBe(true);
        const belowCeiling = IFACE.encodeFunctionData('approve', [SPENDER, (10n ** 18n) - 1n]);
        expect(decodeTransactionCall(USDC_BASE, belowCeiling, BASE).isUnlimitedApproval).toBe(false);
    });

    it('decodes transferFrom with the recipient (2nd arg) as counterparty', () => {
        const data = IFACE.encodeFunctionData('transferFrom', [SPENDER, RECIPIENT, 2_000_000n]);
        const d = decodeTransactionCall(USDC_BASE, data, BASE);
        expect(d.kind).toBe('erc20_transfer');
        expect(d.counterparty?.toLowerCase()).toBe(RECIPIENT);
        expect(d.amountFormatted).toBe('2');
    });

    it('flags setApprovalForAll(true) as a high-risk collection-wide approval', () => {
        const data = IFACE.encodeFunctionData('setApprovalForAll', [OPERATOR, true]);
        const d = decodeTransactionCall(RANDOM_TOKEN, data, BASE);
        expect(d.kind).toBe('erc721_approve_all');
        expect(d.isUnlimitedApproval).toBe(true);
        expect(d.counterparty?.toLowerCase()).toBe(OPERATOR);
        expect(d.riskLevel).toBe('high');
    });

    it('treats setApprovalForAll(false) as low risk (revocation)', () => {
        const data = IFACE.encodeFunctionData('setApprovalForAll', [OPERATOR, false]);
        const d = decodeTransactionCall(RANDOM_TOKEN, data, BASE);
        expect(d.isUnlimitedApproval).toBe(false);
        expect(d.riskLevel).toBe('low');
    });

    it('returns contract_call for an unknown selector', () => {
        const d = decodeTransactionCall(RANDOM_TOKEN, '0xdeadbeef0000', BASE);
        expect(d.kind).toBe('contract_call');
        expect(d.riskLevel).toBe('medium');
    });

    it('falls back to contract_call on malformed (truncated) calldata', () => {
        // transfer selector but insufficient args → decode throws → contract_call
        const d = decodeTransactionCall(USDC_BASE, '0xa9059cbb1234', BASE);
        expect(d.kind).toBe('contract_call');
    });

    it('decodes increaseAllowance as an approval (limited)', () => {
        const data = IFACE.encodeFunctionData('increaseAllowance', [SPENDER, 5_000_000n]); // +5 USDC
        const d = decodeTransactionCall(USDC_BASE, data, BASE);
        expect(d.kind).toBe('erc20_approve');
        expect(d.isIncrease).toBe(true);
        expect(d.amountFormatted).toBe('5');
        expect(d.counterparty?.toLowerCase()).toBe(SPENDER);
        expect(d.isUnlimitedApproval).toBe(false);
    });

    it('flags an unlimited increaseAllowance as high risk', () => {
        const data = IFACE.encodeFunctionData('increaseAllowance', [SPENDER, ethers.MaxUint256]);
        const d = decodeTransactionCall(USDC_BASE, data, BASE);
        expect(d.kind).toBe('erc20_approve');
        expect(d.isIncrease).toBe(true);
        expect(d.isUnlimitedApproval).toBe(true);
        expect(d.riskLevel).toBe('high');
    });

    it('never infers "unlimited" for an unknown-token approve (could be an ERC-721 tokenId)', () => {
        const data = IFACE.encodeFunctionData('approve', [SPENDER, ethers.MaxUint256]);
        const d = decodeTransactionCall(RANDOM_TOKEN, data, BASE);
        expect(d.kind).toBe('erc20_approve');
        expect(d.tokenKnown).toBe(false);
        expect(d.isUnlimitedApproval).toBe(false);
        expect(d.amountFormatted).toBeUndefined();
    });

    it('routes short non-empty calldata to a contract_call caution (not native)', () => {
        const d = decodeTransactionCall(RANDOM_TOKEN, '0x123456', BASE);
        expect(d.kind).toBe('contract_call');
        expect(d.riskLevel).toBe('medium');
    });

    it('captures the transferFrom source in the `from` field', () => {
        const data = IFACE.encodeFunctionData('transferFrom', [SPENDER, RECIPIENT, 2_000_000n]);
        const d = decodeTransactionCall(USDC_BASE, data, BASE);
        expect(d.from?.toLowerCase()).toBe(SPENDER);
        expect(d.counterparty?.toLowerCase()).toBe(RECIPIENT);
    });
});

// ---------------------------------------------------------------------------
// Shallow wrapper unwrapping (one level): Universal Router execute + multicall.
// Encoded with real ethers so the wrapper selectors + ABI layouts are exercised
// exactly as a dApp would send them.
// ---------------------------------------------------------------------------

const WRAPPER_IFACE = new ethers.Interface([
    'function execute(bytes commands, bytes[] inputs)',
    'function execute(bytes commands, bytes[] inputs, uint256 deadline)',
    'function multicall(bytes[] data)',
    'function multicall(uint256 deadline, bytes[] data)',
]);
// Some arbitrary router/aggregator address that is NOT a known token.
const ROUTER = '0x4444444444444444444444444444444444444444';
const coder = ethers.AbiCoder.defaultAbiCoder();

describe('decodeTransactionCall — wrapper unwrapping', () => {
    it('unwraps a Universal Router execute() carrying a PERMIT2_PERMIT approve', () => {
        // command 0x0a = PERMIT2_PERMIT; input = abi.encode(PermitSingle, bytes sig)
        // PermitSingle = ((token, amount, expiration, nonce), spender, sigDeadline)
        const permitInput = coder.encode(
            ['tuple(tuple(address,uint160,uint48,uint48),address,uint256)', 'bytes'],
            [[[USDC_BASE, 1_000_000n, 0n, 0n], SPENDER, 0n], '0x'],
        );
        const data = WRAPPER_IFACE.encodeFunctionData('execute(bytes,bytes[])', ['0x0a', [permitInput]]);
        const d = decodeTransactionCall(ROUTER, data, BASE);

        expect(d.kind).toBe('wrapped_calls');
        expect(d.wrapper).toBe('universal_router');
        expect(d.innerCalls).toHaveLength(1);
        const inner = d.innerCalls![0];
        expect(inner.kind).toBe('erc20_approve');
        expect(inner.tokenSymbol).toBe('USDC');
        expect(inner.amountFormatted).toBe('1');
        expect(inner.counterparty?.toLowerCase()).toBe(SPENDER);
    });

    it('flags an UNLIMITED inner approve inside a Universal Router execute as high risk', () => {
        const permitInput = coder.encode(
            ['tuple(tuple(address,uint160,uint48,uint48),address,uint256)', 'bytes'],
            // uint160 max — Permit2's "infinite" allowance sentinel
            [[[USDC_BASE, (2n ** 160n) - 1n, 0n, 0n], SPENDER, 0n], '0x'],
        );
        const data = WRAPPER_IFACE.encodeFunctionData('execute(bytes,bytes[])', ['0x0a', [permitInput]]);
        const d = decodeTransactionCall(ROUTER, data, BASE);

        expect(d.kind).toBe('wrapped_calls');
        expect(d.isUnlimitedApproval).toBe(true);
        expect(d.riskLevel).toBe('high');
        expect(d.innerCalls![0].isUnlimitedApproval).toBe(true);
    });

    it('handles the execute(bytes,bytes[],uint256) deadline overload', () => {
        const transferInput = coder.encode(
            ['address', 'address', 'uint256'],
            [WETH_BASE, RECIPIENT, ethers.parseUnits('2', 18)],
        );
        // command 0x05 = TRANSFER
        const data = WRAPPER_IFACE.encodeFunctionData('execute(bytes,bytes[],uint256)', ['0x05', [transferInput], 0n]);
        const d = decodeTransactionCall(ROUTER, data, BASE);

        expect(d.kind).toBe('wrapped_calls');
        expect(d.innerCalls![0].kind).toBe('erc20_transfer');
        expect(d.innerCalls![0].tokenSymbol).toBe('WETH');
        expect(d.innerCalls![0].amountFormatted).toBe('2');
    });

    it('returns contract_call for a Universal Router execute with only non-authority commands (swap)', () => {
        // command 0x00 = V3_SWAP_EXACT_IN — moves already-approved tokens, no new authority
        const swapInput = coder.encode(['address', 'uint256'], [RECIPIENT, 1n]);
        const data = WRAPPER_IFACE.encodeFunctionData('execute(bytes,bytes[])', ['0x00', [swapInput]]);
        const d = decodeTransactionCall(ROUTER, data, BASE);
        expect(d.kind).toBe('contract_call');
    });

    it('unwraps a multicall(bytes[]) carrying a single ERC-20 transfer', () => {
        const transferCall = IFACE.encodeFunctionData('transfer', [RECIPIENT, 1_500_000n]); // 1.5 USDC
        const data = WRAPPER_IFACE.encodeFunctionData('multicall(bytes[])', [[transferCall]]);
        const d = decodeTransactionCall(USDC_BASE, data, BASE);

        expect(d.kind).toBe('wrapped_calls');
        expect(d.wrapper).toBe('multicall');
        expect(d.innerCalls).toHaveLength(1);
        expect(d.innerCalls![0].kind).toBe('erc20_transfer');
        expect(d.innerCalls![0].amountFormatted).toBe('1.5');
        expect(d.innerCalls![0].counterparty?.toLowerCase()).toBe(RECIPIENT);
    });

    it('unwraps a multicall with several inner calls and rolls up the riskLevel', () => {
        const transferCall = IFACE.encodeFunctionData('transfer', [RECIPIENT, 1_000_000n]);
        const approveCall = IFACE.encodeFunctionData('approve', [SPENDER, ethers.MaxUint256]); // unlimited
        const data = WRAPPER_IFACE.encodeFunctionData('multicall(bytes[])', [[transferCall, approveCall]]);
        const d = decodeTransactionCall(USDC_BASE, data, BASE);

        expect(d.kind).toBe('wrapped_calls');
        expect(d.innerCalls).toHaveLength(2);
        expect(d.isUnlimitedApproval).toBe(true); // the unlimited approve rolls up
        expect(d.riskLevel).toBe('high');
    });

    it('handles the multicall(uint256 deadline, bytes[]) overload', () => {
        const transferCall = IFACE.encodeFunctionData('transfer', [RECIPIENT, 2_000_000n]);
        const data = WRAPPER_IFACE.encodeFunctionData('multicall(uint256,bytes[])', [0n, [transferCall]]);
        const d = decodeTransactionCall(USDC_BASE, data, BASE);
        expect(d.kind).toBe('wrapped_calls');
        expect(d.innerCalls![0].amountFormatted).toBe('2');
    });

    it('returns contract_call for a multicall whose inner calls are all undecodable', () => {
        const data = WRAPPER_IFACE.encodeFunctionData('multicall(bytes[])', [['0xdeadbeef', '0xc0ffee00']]);
        const d = decodeTransactionCall(ROUTER, data, BASE);
        expect(d.kind).toBe('contract_call');
    });

    it('bounds recursion to one level: a multicall nested inside a multicall stays contract_call', () => {
        const transferCall = IFACE.encodeFunctionData('transfer', [RECIPIENT, 1_000_000n]);
        const innerMulticall = WRAPPER_IFACE.encodeFunctionData('multicall(bytes[])', [[transferCall]]);
        const outer = WRAPPER_IFACE.encodeFunctionData('multicall(bytes[])', [[innerMulticall]]);
        const d = decodeTransactionCall(ROUTER, outer, BASE);
        // inner element decodes (at depth 1) to contract_call, which is filtered
        // out, leaving no meaningful inner call → the outer wrapper cautions.
        expect(d.kind).toBe('contract_call');
    });

    it('leaves an unknown wrapper selector as a cautioned contract_call', () => {
        const d = decodeTransactionCall(ROUTER, '0x12345678abcdef', BASE);
        expect(d.kind).toBe('contract_call');
        expect(d.riskLevel).toBe('medium');
    });
});
