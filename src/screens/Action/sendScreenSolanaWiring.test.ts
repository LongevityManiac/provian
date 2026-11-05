/**
 * SendScreen wiring for Solana assets (2026-09-25). "USDC (Solana)" got the EVM network picker
 * (keyed by symbol), Base was auto-selected, and the balance check read the Base USDC row, so a
 * valid Solana send was refused. The decisions live in sendAssetSelection.ts (unit-tested there);
 * this SOURCE scan (RN screens can't be imported under vitest) proves SendScreen actually uses
 * them, in the right order. Each rule ships with a RED control: the reverted form is detected.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SEND_SCREEN = resolve(__dirname, 'SendScreen.tsx');

/** The handleContinue body: from its declaration to the next top-level handler. */
function handleContinueBody(src: string): string {
    const start = src.indexOf('const handleContinue = async');
    if (start < 0) return '';
    const end = src.indexOf('\n    const ', start + 1);
    return src.slice(start, end < 0 ? undefined : end);
}

export function scanSendScreenSolanaWiring(src: string): string[] {
    const v: string[] = [];
    const multi = src.match(/const isMultiChain = [^\n]*/g) ?? [];
    if (multi.length !== 1 || !/offersEvmNetworkPicker\(selectedAsset,/.test(multi[0])) {
        v.push('isMultiChain must be computed by offersEvmNetworkPicker(selectedAsset, …)');
    }
    if (/a\.symbol === asset\.symbol && a\.chainId === currentChainId/.test(src)) {
        v.push('balance row looked up by symbol + chainId directly (a Solana asset matches the Base row)');
    }
    const body = handleContinueBody(src);
    if (!/const chainScopedAsset = balanceRowForSend\(asset, assets, currentChainId\)/.test(body)) {
        v.push('handleContinue must take the balance row from balanceRowForSend');
    }
    const addr = body.indexOf('if (addressError)');
    const wallet = body.indexOf("if (asset.chain === 'Solana' && !isSolanaWalletAddress(recipientAddress))");
    const pre = body.indexOf('if (isSolanaTokenSend(asset)');
    const loading = body.indexOf('setLoading(true)');
    if (addr < 0 || pre < 0 || loading < 0 || !(addr < pre && pre < loading)) {
        v.push('the SOL-fee preflight must run after the address check and before setLoading(true)');
    } else if (wallet < 0 || !(addr < wallet && wallet < pre) || !/^[^\n]*\{\s*\n[^}]*return;/.test(body.slice(wallet))) {
        v.push('a Solana send must refuse a non-wallet (off-curve) recipient before the fee preflight');
    } else {
        const block = body.slice(pre, loading);
        if (!/splSendSolRequirement\(/.test(block) || !/if \(!funding\.sufficient\) \{[^}]*return;/s.test(block)) {
            v.push('the preflight must call splSendSolRequirement and stop when funding is insufficient');
        }
    }
    if (!/need: formatSolAtLeast\(neededLamports\)/.test(src)) {
        v.push('the needed-SOL figure must be rounded up (formatSolAtLeast)');
    }
    if (!/error instanceof InsufficientSolForFeesError/.test(src)) {
        v.push('the send catch must handle InsufficientSolForFeesError');
    }
    return v;
}

describe('SendScreen Solana wiring (source scan)', () => {
    const src = readFileSync(SEND_SCREEN, 'utf8');

    it('the shipped SendScreen passes every rule', () => {
        expect(handleContinueBody(src).length).toBeGreaterThan(500);
        expect(scanSendScreenSolanaWiring(src)).toEqual([]);
    });

    it('RED: the pre-fix picker condition is detected', () => {
        const bad = src.replace(
            /const isMultiChain = [^\n]*/,
            'const isMultiChain = multiChainInfo !== undefined && multiChainInfo.chains.length > 1;',
        );
        expect(scanSendScreenSolanaWiring(bad)).toContain(
            'isMultiChain must be computed by offersEvmNetworkPicker(selectedAsset, …)',
        );
    });

    it('RED: the pre-fix symbol+chainId balance lookup is detected', () => {
        const bad = src.replace(
            'const chainScopedAsset = balanceRowForSend(asset, assets, currentChainId);',
            'const chainScopedAsset = assets.find((a) => a.symbol === asset.symbol && a.chainId === currentChainId) ?? asset;',
        );
        const v = scanSendScreenSolanaWiring(bad);
        expect(v).toContain('handleContinue must take the balance row from balanceRowForSend');
        expect(v.some((x) => x.startsWith('balance row looked up'))).toBe(true);
    });

    it('RED: a preflight moved ahead of the address check, disabled, or not stopping is detected', () => {
        const body = handleContinueBody(src);
        const pre = body.indexOf('        // A Solana token (SPL) send pays');
        const loading = body.indexOf('        setLoading(true)');
        expect(pre).toBeGreaterThan(0);
        const block = body.slice(pre, loading);
        const withoutBlock = src.replace(block, '');
        const moved = withoutBlock.replace('        // Check for address validation errors', block + '        // Check for address validation errors');
        expect(scanSendScreenSolanaWiring(moved)).toContain(
            'the SOL-fee preflight must run after the address check and before setLoading(true)',
        );
        expect(scanSendScreenSolanaWiring(withoutBlock)).toContain(
            'the SOL-fee preflight must run after the address check and before setLoading(true)',
        );
        const noStop = src.replace(/(if \(!funding\.sufficient\) \{[^}]*?)return;/s, '$1');
        expect(scanSendScreenSolanaWiring(noStop)).toContain(
            'the preflight must call splSendSolRequirement and stop when funding is insufficient',
        );
    });

    it('RED: dropping the InsufficientSolForFeesError catch branch is detected', () => {
        const bad = src.replace('error instanceof InsufficientSolForFeesError', 'false');
        expect(scanSendScreenSolanaWiring(bad)).toContain('the send catch must handle InsufficientSolForFeesError');
    });
});

describe('SendScreen Solana wiring: wallet-address check and rounding (source scan)', () => {
    const src = readFileSync(SEND_SCREEN, 'utf8');
    const WALLET_CHECK = "if (asset.chain === 'Solana' && !isSolanaWalletAddress(recipientAddress))";

    it('RED: dropping or disabling the wallet-address check is detected', () => {
        expect(src).toContain(WALLET_CHECK);
        expect(scanSendScreenSolanaWiring(src.replace(WALLET_CHECK, 'if (false)'))).toContain(
            'a Solana send must refuse a non-wallet (off-curve) recipient before the fee preflight',
        );
    });

    it('RED: rounding the needed figure to nearest again is detected', () => {
        const bad = src.replace('need: formatSolAtLeast(neededLamports)', 'need: formatSolHeld(neededLamports)');
        expect(scanSendScreenSolanaWiring(bad)).toContain('the needed-SOL figure must be rounded up (formatSolAtLeast)');
    });
});
