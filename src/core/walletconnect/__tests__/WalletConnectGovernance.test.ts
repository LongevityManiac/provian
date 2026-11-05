/**
 * WalletConnectGovernance — lane tests against the REAL crypto-spending
 * governance pipeline (evaluateCryptoTransaction + classifier + decoder).
 *
 * Only the leaf dependencies are mocked (storage, secure-store, the kill-switch
 * flag, and the dev-host discovery used by the lazy registry refresh). Everything
 * that decides a friction lane runs for real, so these tests prove the actual
 * verdicts the human WalletConnect path will produce:
 *   - over-budget        → block
 *   - approval           → hard_confirm
 *   - unlimited approval → block (default)
 *   - unknown contract   → hard_confirm (default)
 *   - kill switch        → block (deny)
 *   - signature transfer → governed as a spend (hard_confirm)
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { ethers } from 'ethers';

// ── Leaf-dependency mocks ────────────────────────────────────────────────────
// AsyncStorage is STATEFUL (Map-backed) so the real DailyCryptoSpendTracker can
// persist + read back the daily accumulator — needed to prove a recorded permit
// spend makes the daily cap bind (#29). Starts empty each test (cleared below),
// so the existing read-only tests still see a fresh day (getItem → null).
const { mockAsyncStore } = vi.hoisted(() => ({ mockAsyncStore: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn((k: string) => Promise.resolve(mockAsyncStore.get(k) ?? null)),
        setItem: vi.fn((k: string, v: string) => { mockAsyncStore.set(k, v); return Promise.resolve(); }),
        removeItem: vi.fn((k: string) => { mockAsyncStore.delete(k); return Promise.resolve(); }),
    },
}));
vi.mock('expo-secure-store', () => ({
    getItemAsync: vi.fn().mockResolvedValue(null),
    setItemAsync: vi.fn().mockResolvedValue(undefined),
    deleteItemAsync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('expo-crypto', () => ({
    digestStringAsync: vi.fn().mockResolvedValue('mock-hash'),
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
}));
vi.mock('../../relay/DevHostDiscovery', () => ({
    resolveRelayBaseUrl: () => 'http://localhost:65535',
}));

import {
    evaluateWalletConnectTransaction,
    evaluateWalletConnectPermit,
} from '../WalletConnectGovernance';
import { DEFAULT_WC_GOVERNANCE_SETTINGS, WalletConnectGovernanceSettings } from '../governanceSettings';
import type { DecodedPermit } from '../decodeTypedData';
import { recordDailyCryptoSpendUsd } from '../../crypto-governance/DailyCryptoSpendTracker';

// ── Fixtures ─────────────────────────────────────────────────────────────────
const BASE = 8453;
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const RANDOM_CONTRACT = '0x1234567890123456789012345678901234567890';
const RECIPIENT = '0x1111111111111111111111111111111111111111';
const SPENDER = '0x2222222222222222222222222222222222222222';

const IFACE = new ethers.Interface([
    'function transfer(address to, uint256 amount)',
    'function approve(address spender, uint256 amount)',
]);
const transferData = (amount: bigint) => IFACE.encodeFunctionData('transfer', [RECIPIENT, amount]);
const approveData = (spender: string, amount: bigint) => IFACE.encodeFunctionData('approve', [spender, amount]);

function settings(over: Partial<WalletConnectGovernanceSettings> = {}): WalletConnectGovernanceSettings {
    return { ...DEFAULT_WC_GOVERNANCE_SETTINGS, ...over };
}

const txCtx = (to: string, data: string) => ({
    to,
    value: '0',
    data,
    chainId: BASE,
    chainShortName: 'base',
    dappName: 'Test dApp',
});

beforeAll(() => {
    // The lazy registry refresh fires fetch() on unknown contracts; make it fail
    // fast instead of hitting the network. It is fire-and-forget and swallowed.
    (globalThis as { fetch?: unknown }).fetch = vi.fn().mockRejectedValue(new Error('no network in test'));
});

beforeEach(() => {
        mockAsyncStore.clear();
});

describe('evaluateWalletConnectTransaction', () => {
    it('small stablecoin transfer under cap → allowed (auto_approve, biometric-only)', async () => {
        const v = await evaluateWalletConnectTransaction(txCtx(USDC_BASE, transferData(1_000_000n)), settings());
        expect(v.allowed).toBe(true);
        expect(v.lane).toBe('auto_approve');
        expect(v.requiresStrongConfirm).toBe(false);
        expect(v.category).toBe('token_transfer');
    });

    it('stablecoin transfer over the per-tx USD cap → block', async () => {
        // 50 USDC transfer against a $10 per-transaction cap.
        const v = await evaluateWalletConnectTransaction(
            txCtx(USDC_BASE, transferData(50_000_000n)),
            settings({ perTransactionLimitUsd: 10 }),
        );
        expect(v.lane).toBe('block');
        expect(v.allowed).toBe(false);
    });

    it('bounded token approval → hard_confirm (requireApprovalConfirm)', async () => {
        const v = await evaluateWalletConnectTransaction(txCtx(USDC_BASE, approveData(SPENDER, 100_000_000n)), settings());
        expect(v.allowed).toBe(true);
        expect(v.lane).toBe('hard_confirm');
        expect(v.requiresStrongConfirm).toBe(true);
        expect(v.category).toBe('token_approval');
    });

    it('UNLIMITED approval → block by default', async () => {
        const v = await evaluateWalletConnectTransaction(txCtx(USDC_BASE, approveData(SPENDER, ethers.MaxUint256)), settings());
        expect(v.lane).toBe('block');
        expect(v.allowed).toBe(false);
        expect(v.denyReason?.toLowerCase()).toContain('unlimited');
    });

    it('UNLIMITED approval → hard_confirm when owner loosens the policy', async () => {
        const v = await evaluateWalletConnectTransaction(
            txCtx(USDC_BASE, approveData(SPENDER, ethers.MaxUint256)),
            settings({ unlimitedApprovalPolicy: 'hard_confirm' }),
        );
        expect(v.lane).toBe('hard_confirm');
        expect(v.allowed).toBe(true);
    });

    it('unknown / undecodable contract call → hard_confirm by default', async () => {
        const v = await evaluateWalletConnectTransaction(txCtx(RANDOM_CONTRACT, '0xdeadbeef' + '00'.repeat(32)), settings());
        expect(v.category).toBe('unknown');
        expect(v.lane).toBe('hard_confirm');
        expect(v.allowed).toBe(true);
    });

    it('unknown contract call → block when owner tightens the policy', async () => {
        const v = await evaluateWalletConnectTransaction(
            txCtx(RANDOM_CONTRACT, '0xdeadbeef' + '00'.repeat(32)),
            settings({ unknownContractPolicy: 'block' }),
        );
        expect(v.lane).toBe('block');
        expect(v.allowed).toBe(false);
    });

    // Wrapped router / multicall calls: the gate must enforce the same risk the
    // decoded banner shows, so a wrapped unlimited approval blocks just like a
    // direct one (no laundering authority through a wrapper).
    const WRAP_IFACE = new ethers.Interface(['function multicall(bytes[] data)']);
    const multicallOf = (...calls: string[]) => WRAP_IFACE.encodeFunctionData('multicall(bytes[])', [calls]);

    it('multicall wrapping a bounded approve → token_approval + hard_confirm', async () => {
        const v = await evaluateWalletConnectTransaction(
            txCtx(USDC_BASE, multicallOf(approveData(SPENDER, 100_000_000n))),
            settings(),
        );
        expect(v.category).toBe('token_approval');
        expect(v.lane).toBe('hard_confirm');
        expect(v.allowed).toBe(true);
    });

    it('multicall wrapping an UNLIMITED approve → block by default', async () => {
        const v = await evaluateWalletConnectTransaction(
            txCtx(USDC_BASE, multicallOf(approveData(SPENDER, ethers.MaxUint256))),
            settings(),
        );
        expect(v.lane).toBe('block');
        expect(v.allowed).toBe(false);
        expect(v.denyReason?.toLowerCase()).toContain('unlimited');
    });

    it('multicall wrapping a small transfer → token_transfer (no spurious escalation)', async () => {
        const v = await evaluateWalletConnectTransaction(
            txCtx(USDC_BASE, multicallOf(transferData(1_000_000n))),
            settings(),
        );
        expect(v.category).toBe('token_transfer');
        expect(v.allowed).toBe(true);
    });
});

describe('evaluateWalletConnectPermit (gasless approvals / signature transfers)', () => {
    const basePermit = (over: Partial<DecodedPermit>): DecodedPermit => ({
        kind: 'permit2_single',
        spender: SPENDER,
        tokenAddress: USDC_BASE,
        tokenSymbol: 'USDC',
        tokenKnown: true,
        amountRaw: '40000000',
        amountFormatted: '40',
        isUnlimited: false,
        isTransfer: false,
        riskLevel: 'medium',
        ...over,
    });
    const ctx = { chainId: BASE, chainShortName: 'base', dappName: 'Test dApp' };

    it('signature transfer (PermitTransferFrom) is governed as a spend → hard_confirm', async () => {
        const permit = basePermit({ kind: 'permit2_transfer', isTransfer: true, amountFormatted: '25', amountRaw: '25000000', riskLevel: 'high' });
        const v = await evaluateWalletConnectPermit(permit, ctx, settings());
        expect(v.allowed).toBe(true);
        expect(v.lane).toBe('hard_confirm');
        expect(v.category).toBe('token_transfer');
    });

    it('bounded permit approval of a known token → hard_confirm', async () => {
        const v = await evaluateWalletConnectPermit(basePermit({}), ctx, settings());
        expect(v.allowed).toBe(true);
        expect(v.lane).toBe('hard_confirm');
    });

    it('UNLIMITED permit → block by default', async () => {
        const permit = basePermit({ kind: 'erc2612_permit', isUnlimited: true, amountFormatted: undefined, amountRaw: undefined, riskLevel: 'high' });
        const v = await evaluateWalletConnectPermit(permit, ctx, settings());
        expect(v.lane).toBe('block');
        expect(v.allowed).toBe(false);
    });

    it('permit on an unverified token → hard_confirm with an unverified reason', async () => {
        const permit = basePermit({ tokenAddress: RANDOM_CONTRACT, tokenSymbol: undefined, tokenKnown: false, amountFormatted: undefined, riskLevel: 'high' });
        const v = await evaluateWalletConnectPermit(permit, ctx, settings());
        expect(v.lane).toBe('hard_confirm');
        expect(v.reasons.some(r => /unverified/i.test(r))).toBe(true);
    });

    // ── Pass-2 #37: the decoder's chainMismatch / high-risk flags must drive the
    // permit lane (escalation only — invariant #12). requireApprovalConfirm is
    // turned OFF so a bounded known-token permit would otherwise sit BELOW
    // hard_confirm; the flag is what forces hard_confirm. Before the fix the lane
    // ignored these flags and stayed at the lower lane. ────────────────────────
    it('#37 chain-mismatch permit escalates to hard_confirm (lower base lane)', async () => {
        const permit = basePermit({ chainMismatch: true, riskLevel: 'high' });
        const v = await evaluateWalletConnectPermit(permit, ctx, settings({ requireApprovalConfirm: false }));
        expect(v.lane).toBe('hard_confirm');
        expect(v.requiresStrongConfirm).toBe(true);
        expect(v.reasons.some(r => /chain/i.test(r))).toBe(true);
    });

    it('#37 a decoder-rated high-risk permit is at least hard_confirm (no chain mismatch)', async () => {
        const permit = basePermit({ riskLevel: 'high' });
        const v = await evaluateWalletConnectPermit(permit, ctx, settings({ requireApprovalConfirm: false }));
        expect(v.lane).toBe('hard_confirm');
    });

    it('#37 escalation never de-escalates: a chain-mismatch UNLIMITED permit still blocks', async () => {
        const permit = basePermit({ kind: 'erc2612_permit', isUnlimited: true, chainMismatch: true, amountFormatted: undefined, amountRaw: undefined, riskLevel: 'high' });
        const v = await evaluateWalletConnectPermit(permit, ctx, settings());
        expect(v.lane).toBe('block');
        expect(v.allowed).toBe(false);
    });

    // ── Pass-2 #29: escalating a permit's LANE must not discard its priced USD.
    // buildVerdict() defaults amountUsd to 0, so before the escalate()/applyUnlimitedRule()
    // fix a known-stablecoin permit that escalated would carry amountUsd:0 and the
    // service would record 0 into the daily accumulator — under-counting the cap. ─
    it('#29 a known-stablecoin signature transfer keeps its priced amountUsd across escalation', async () => {
        const permit = basePermit({ kind: 'permit2_transfer', isTransfer: true, amountFormatted: '25', amountRaw: '25000000', riskLevel: 'high' });
        const v = await evaluateWalletConnectPermit(permit, ctx, settings());
        expect(v.lane).toBe('hard_confirm'); // escalated (signature transfer)
        expect(v.amountUsd).toBe(25);        // NOT reset to 0 by the escalation
    });

    it('#29 a chain-mismatch stablecoin permit keeps its priced amountUsd across escalation', async () => {
        const permit = basePermit({ amountFormatted: '40', amountRaw: '40000000', chainMismatch: true, riskLevel: 'high' });
        const v = await evaluateWalletConnectPermit(permit, ctx, settings({ requireApprovalConfirm: false }));
        expect(v.lane).toBe('hard_confirm'); // escalated (chain mismatch, #37)
        expect(v.amountUsd).toBe(40);        // priced value survives the lane bump
    });

    // ── Pass-2 #29: a recorded permit spend accumulates and then makes the daily
    // on-chain cap bind on the NEXT permit. Before the fix the first permit was
    // never recorded, so the second would have slipped under the cap. ──────────
    it('#29 a recorded permit spend makes the daily cap bind on the next permit', async () => {
        const capped = (over: Partial<WalletConnectGovernanceSettings>) =>
            settings({ dailyLimitUsd: 50, requireApprovalConfirm: false, ...over });

        // First 40-USDC permit under a $50/day cap → allowed; record it (exactly
        // as WalletConnectService.handlePermitSign does after a successful sign).
        const p1 = basePermit({ amountFormatted: '40', amountRaw: '40000000' });
        const v1 = await evaluateWalletConnectPermit(p1, ctx, capped({}));
        expect(v1.allowed).toBe(true);
        expect(v1.amountUsd).toBe(40);
        await recordDailyCryptoSpendUsd('wallet-owner', 'sig-permit-1', v1.amountUsd);

        // Second 20-USDC permit: 40 (recorded) + 20 = 60 > 50 → block.
        const p2 = basePermit({ amountFormatted: '20', amountRaw: '20000000' });
        const v2 = await evaluateWalletConnectPermit(p2, ctx, capped({}));
        expect(v2.lane).toBe('block');
        expect(v2.allowed).toBe(false);
    });
});
