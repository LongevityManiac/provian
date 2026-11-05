/**
 * SwapScreen wiring (source scan; RN screens can't be imported under vitest). The routing
 * and no-mock rules live in swapQuoteRouter.ts (unit-tested there); this proves the screen uses
 * that router and nothing else, shows the chain on both sides, never renders a mock price, and
 * drops a quote answering a pair or amount no longer on screen. Each rule ships with a RED
 * control: the pre- form is detected.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SWAP_SCREEN = resolve(__dirname, 'SwapScreen.tsx');

export function scanSwapScreenRouting(src: string): string[] {
    const v: string[] = [];
    if (/involvesSolana\(/.test(src)) v.push('the route must be decided by chain inequality, not by involvesSolana');
    if (/SwapService\.getQuote\(/.test(src) || /CrossChainSwapEngine\.getQuote\(/.test(src)) {
        v.push('the screen must quote only through swapQuoteRouter.quoteSwap');
    }
    if ((src.match(/await quoteSwap\(\{/g) ?? []).length !== 1) v.push('the screen must quote through quoteSwap exactly once');
    if (/estimatedRatesOnly/.test(src) || /quote\?\.isMock\s*&&/.test(src)) v.push('a mock quote must never be rendered');
    if (!/const quoteSeq = useRef\(0\)/.test(src) || !/if \(!current\(\)\) return;\s*\n\s*setQuote\(newQuote\)/.test(src)) {
        v.push('a quote answering a pair or amount no longer on screen must be dropped');
    }
    if (!/setQuote\(null\);\s*\n\s*setQuoteError\(null\);/.test(src)) v.push('a new pair or amount must clear the quote on screen at once');
    if (!/if \(!newQuote\) \{\s*\n\s*setQuoteError\(t\('swap\.noRoute'\)\)/.test(src)) v.push('no quote for the pair must say so (swap.noRoute) for every route');
    if (!/const pairText = `\$\{onChain\(fromAsset\)\} → \$\{onChain\(toAsset\)\}`/.test(src) || !/\{pairText\}/.test(src)) {
        v.push('the review must show "<token> on <chain> → <token> on <chain>"');
    }
    if (!/\{fromAsset\.chain\}<\/Text>/.test(src) || !/\{toAsset\.chain\}<\/Text>/.test(src)) v.push('both asset badges must show the chain');
    return v;
}

/**
 * : a swap in flight freezes the pair and the amount, executes the swap
 * submitted, lets a re-quote replace the quote only while that swap is still what the screen
 * shows, and names the submitted pair in the result.
 */
export function scanSwapInFlight(src: string): string[] {
    const v: string[] = [];
    // The amount handed to beginSubmission is the canonical form of the text on screen — the value
    // the quote was built from (2026-10-17), never the raw text and never a later re-render's value.
    if (!/const canonicalConfirm = canonicalizeAmount\(amount, sendDecimalsOf\(fromAsset\)\);\s*\n\s*const shownAmount = canonicalConfirm\.ok \? canonicalConfirm\.value : amount;\s*\n\s*const sub = beginSubmission\(fromAsset, toAsset, shownAmount, quoteSeq\.current, quote\);/.test(src)) {
        v.push('the swap on screen must be recorded when Swap is tapped');
    }
    if (!/CrossChainSwapEngine\.executeSwap\(sub\.quoteId, sub, biometricAction\)/.test(src)) v.push('the cross-chain engine must be told the swap on screen');
    // Every quote the screen shows comes from the sequence-guarded fetch or a re-quote that still applies.
    const sets = [...src.matchAll(/setQuote\((?!null\))([^)]*)\)/g)].map((m) => m[1]);
    if (sets.length !== 2 || !sets.includes('newQuote') || !sets.includes('fresh')) v.push(`unexpected setQuote calls: ${sets.join(', ')}`);
    if (!/requoteQuote && requoteApplies\(sub, quoteSeq\.current, requoteQuote\)\) \{[\s\S]{0,900}setQuote\(fresh\)/.test(src)) {
        v.push('a re-quote must replace the quote only while the submitted swap is still on screen');
    }
    if (!/fromToken: onChain\(sub\.fromAsset\)/.test(src) || !/toToken: onChain\(sub\.toAsset\)/.test(src)) {
        v.push('the result must name the pair that executed');
    }
    const disabled = (src.match(/disabled=\{loading\}/g) ?? []).length;
    if (disabled < 5) v.push(`the pair and amount controls must be disabled while a swap is in flight (found ${disabled} of 5)`);
    if (!/editable=\{isSwapSupported && !loading\}/.test(src)) v.push('the amount must not be editable while a swap is in flight');
    for (const h of ['const openSelector', 'const selectAsset', 'const handleSwapAssets', 'const handleMaxPress']) {
        const at = src.indexOf(h);
        if (at < 0 || !/if \(submittingRef\.current\) return;/.test(src.slice(at, at + 160))) v.push(`${h.slice(6)} must refuse while a swap is in flight`);
    }
    return v;
}

describe('SwapScreen routing and display (, source scan)', () => {
    const src = readFileSync(SWAP_SCREEN, 'utf8');

    it('the screen meets every rule', () => {
        expect(scanSwapScreenRouting(src)).toEqual([]);
    });

    it('RED: the pre- dispatch (involvesSolana → 0x with the destination chain dropped) is detected', () => {
        const old = src
            .replace(/const routeKind = swapRouteKind\(fromAsset, toAsset\);/, 'const isCrossChain = CrossChainSwapEngine.involvesSolana(fromAsset, toAsset);')
            .replace(/await quoteSwap\(\{/, 'isCrossChain ? await CrossChainSwapEngine.getQuote({ ... }) : await SwapService.getQuote(fromAsset.chain, fromAsset.symbol, toAsset.symbol, amount, 0.5, address); ({');
        const found = scanSwapScreenRouting(old);
        expect(found).toContain('the route must be decided by chain inequality, not by involvesSolana');
        expect(found).toContain('the screen must quote only through swapQuoteRouter.quoteSwap');
    });

    it('RED: the mock banner and a missing staleness guard are detected', () => {
        const old = src
            .replace('{/* [] The exact pair', '{quote?.isMock && (<Text>{t(\'swap.estimatedRatesOnly\')}</Text>)}{/* [] The exact pair')
            .replace(/if \(!current\(\)\) return;\s*\n(\s*)setQuote\(newQuote\)/, '\n$1setQuote(newQuote)');
        const found = scanSwapScreenRouting(old);
        expect(found).toContain('a mock quote must never be rendered');
        expect(found).toContain('a quote answering a pair or amount no longer on screen must be dropped');
    });

    it('RED: a review or badge without the chain is detected', () => {
        const old = src.replace('{pairText}', '{fromAsset.symbol}').replace('{toAsset.chain}</Text>', '</Text>');
        const found = scanSwapScreenRouting(old);
        expect(found).toContain('the review must show "<token> on <chain> → <token> on <chain>"');
        expect(found).toContain('both asset badges must show the chain');
    });
});

describe('SwapScreen — a swap in flight ( , source scan)', () => {
    const src = readFileSync(SWAP_SCREEN, 'utf8');

    it('the screen meets every in-flight rule', () => {
        expect(scanSwapInFlight(src)).toEqual([]);
    });

    it("RED : the round-0 re-quote (setQuote(fresh) unguarded), enabled badges and flip, and a result naming the live pair are detected", () => {
        const old = src
            .replace('requoteQuote && requoteApplies(sub, quoteSeq.current, requoteQuote)', 'requoteQuote')
            .replace(/ disabled=\{loading\}/g, '')
            .replace(/\n\s*disabled=\{loading\}/g, '')
            .replace('fromToken: onChain(sub.fromAsset)', 'fromToken: onChain(fromAsset)')
            .replace('toToken: onChain(sub.toAsset)', 'toToken: onChain(toAsset)');
        const found = scanSwapInFlight(old);
        expect(found).toContain('a re-quote must replace the quote only while the submitted swap is still on screen');
        expect(found).toContain('the pair and amount controls must be disabled while a swap is in flight (found 0 of 5)');
        expect(found).toContain('the result must name the pair that executed');
    });

    it("RED : Confirm handing beginSubmission the RAW text, or a value not derived from the canonical form, is detected", () => {
        const raw = src.replace('beginSubmission(fromAsset, toAsset, shownAmount, quoteSeq.current, quote)', 'beginSubmission(fromAsset, toAsset, amount, quoteSeq.current, quote)');
        expect(raw).not.toBe(src);
        expect(scanSwapInFlight(raw)).toContain('the swap on screen must be recorded when Swap is tapped');
        const quoteDerived = src.replace('const shownAmount = canonicalConfirm.ok ? canonicalConfirm.value : amount;', 'const shownAmount = quote?.sellAmount ?? amount;');
        expect(quoteDerived).not.toBe(src);
        expect(scanSwapInFlight(quoteDerived)).toContain('the swap on screen must be recorded when Swap is tapped');
    });

    it('RED: executing by quote id alone, an editable amount, and handlers that act mid-swap are detected', () => {
        const old = src
            .replace('CrossChainSwapEngine.executeSwap(sub.quoteId, sub, biometricAction)', 'CrossChainSwapEngine.executeSwap(quote.id)')
            .replace('editable={isSwapSupported && !loading}', 'editable={isSwapSupported}')
            .replace(/(const handleSwapAssets = \(\) => \{)\s*\n\s*if \(submittingRef\.current\) return;/, '$1');
        const found = scanSwapInFlight(old);
        expect(found).toContain('the cross-chain engine must be told the swap on screen');
        expect(found).toContain('the amount must not be editable while a swap is in flight');
        expect(found).toContain('handleSwapAssets must refuse while a swap is in flight');
    });
});

/**
 * Swap review gate (2026-10-07): "Review Exchange" opens a review and never executes; only the
 * review's Confirm Swap executes, and only after a FRESH Face ID on every route — a biometric
 * session left open by an earlier approval never lets a swap through without a prompt.
 */
export function scanSwapReviewGate(src: string): string[] {
    const v: string[] = [];
    const body = (name: string): string => {
        const at = src.indexOf(`const ${name} = async () => {`);
        if (at < 0) return '';
        const end = src.indexOf('\n    };\n', at);
        return end < 0 ? '' : src.slice(at, end);
    };
    const review = body('handleReview');
    const confirm = body('handleConfirm');
    if (!review) v.push('the screen must have a handleReview that opens the review');
    if (!confirm) v.push('the screen must have a handleConfirm that executes the reviewed swap');
    if (/executeSwap\(/.test(review)) v.push('Review Exchange must never execute a swap');
    if (review && !/if \(safe\) setReviewVisible\(true\);/.test(review)) v.push('Review Exchange must open the review only after the safety checks pass');

    // Every execution call lives in handleConfirm, after the fresh prompt.
    const execCalls = (src.match(/\.executeSwap\(/g) ?? []).length;
    const execInConfirm = (confirm.match(/\.executeSwap\(/g) ?? []).length;
    if (execCalls === 0 || execCalls !== execInConfirm) v.push('every executeSwap call must be inside handleConfirm');
    const fresh = confirm.indexOf('await withBiometricAction(');
    const firstExec = confirm.indexOf('.executeSwap(');
    if (fresh < 0 || firstExec < 0 || fresh > firstExec) v.push('Confirm Swap must take a fresh Face ID before any route executes');
    // The prompt must not sit inside a route branch (it once gated only the cross-chain route).
    if (fresh >= 0 && /if \(quote\.crossChain\) \{[^}]*$/.test(confirm.slice(0, fresh))) v.push('the fresh Face ID must gate every route, not one branch');
    if (/requireBiometric\(/.test(src)) v.push('the screen must not use a one-branch requireBiometric gate');

    // The main button reviews; only the review's Confirm Swap button calls handleConfirm.
    if (!/onPress=\{\(\) => \{ Keyboard\.dismiss\(\); handleReview\(\); \}\}/.test(src)) v.push('the Review Exchange button must call handleReview');
    const confirmRefs = (src.match(/handleConfirm\b/g) ?? []).length;
    if (confirmRefs !== 2 || !/onPress=\{handleConfirm\}\s*\n\s*disabled=\{loading\}/.test(src)) {
        v.push('handleConfirm must be reachable only from the review\'s Confirm Swap button');
    }
    if (!/setQuoteError\(null\);\s*\n\s*setToUsdValue\(0\);\s*\n\s*\/\/[^\n]*\n\s*setReviewVisible\(false\);/.test(src)) {
        v.push('a new quote must close an open review');
    }
    return v;
}

describe('SwapScreen — review gate (source scan)', () => {
    const src = readFileSync(SWAP_SCREEN, 'utf8');

    it('the screen meets every review-gate rule', () => {
        expect(scanSwapReviewGate(src)).toEqual([]);
    });

    it('RED: the pre-fix form (Review Exchange executes; Face ID only on the cross-chain route) is detected', () => {
        const old = src
            .replace("onPress={() => { Keyboard.dismiss(); handleReview(); }}", "onPress={() => { Keyboard.dismiss(); handleConfirm(); }}")
            .replace(
                /await withBiometricAction\(/,
                'await removedGate(',
            )
            .replace(
                'if (quote.crossChain) {\n',
                "if (quote.crossChain) {\n                await requireBiometric(t('swap.approveSwapBiometric'));\n",
            );
        const found = scanSwapReviewGate(old);
        expect(found).toContain('the Review Exchange button must call handleReview');
        expect(found).toContain('Confirm Swap must take a fresh Face ID before any route executes');
        expect(found).toContain('the screen must not use a one-branch requireBiometric gate');
        expect(found).toContain('handleConfirm must be reachable only from the review\'s Confirm Swap button');
    });

    it('RED: a review that executes, a session-reusing prompt, and a review that survives a re-quote are detected', () => {
        const old = src
            .replace('if (safe) setReviewVisible(true);', 'if (safe) await SwapService.executeSwap(quote, address, fromAsset.chain);')
            .replace('withBiometricAction(', 'SeedManager.requireBiometricSession(')
            .replace(/setToUsdValue\(0\);\s*\n\s*\/\/[^\n]*\n\s*setReviewVisible\(false\);/, 'setToUsdValue(0);');
        const found = scanSwapReviewGate(old);
        expect(found).toContain('Review Exchange must never execute a swap');
        expect(found).toContain('Review Exchange must open the review only after the safety checks pass');
        expect(found).toContain('every executeSwap call must be inside handleConfirm');
        expect(found).toContain('Confirm Swap must take a fresh Face ID before any route executes');
        expect(found).toContain('a new quote must close an open review');
    });
});
