/**
 * SendScreen review guard and recipient address (2026-10-17, review rounds 2–3). RN screens cannot
 * be imported under vitest, so this is a SOURCE scan: every protection check and the send read the
 * same whitespace-free `recipientAddress`; Continue runs one at a time and only the run that opens
 * the review writes what it checked; Confirm refuses any other recipient, amount, asset or chain;
 * the swap review names the canonical amount that executes. Each rule ships with a RED control.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SEND_SCREEN = resolve(__dirname, 'SendScreen.tsx');
const SWAP_SCREEN = resolve(__dirname, 'SwapScreen.tsx');

/** A handler's body: from its declaration to the next top-level declaration. */
function handlerBody(src: string, name: string): string {
    const start = src.indexOf(`const ${name} = async`);
    if (start < 0) return '';
    const end = src.indexOf('\n    const ', start + 1);
    return src.slice(start, end < 0 ? undefined : end);
}

export function scanSendReviewGuard(src: string): string[] {
    const v: string[] = [];
    const cont = handlerBody(src, 'handleContinue');
    const conf = handlerBody(src, 'handleConfirm');
    if (!cont) v.push('the screen must have a handleContinue');
    if (!conf) v.push('the screen must have a handleConfirm');

    // 1. ONE address. The typed text keeps its spaces (it is also the contact search); every check
    //    and every send read `recipientAddress`, the text without whitespace.
    if (!/const recipientAddress = useMemo\(\(\) => recipient\.replace\(\/\\s\+\/g, ''\), \[recipient\]\);/.test(src)) {
        v.push('recipientAddress must be the typed recipient without any whitespace');
    }
    for (const [where, body, literal, atLeast] of [
        ['handleContinue', cont, 'recipient: recipientAddress,', 2], // PolicyEngine + UserProtectionManager
        ['handleContinue', cont, 'to: recipientAddress,', 1], // RiskEngine
        ['handleContinue', cont, 'recipientAddress.toLowerCase() === address.toLowerCase()', 1], // self-send
        ['handleContinue', cont, 'formatAddressForDisplay(recipientAddress)', 1],
        ['handleConfirm', conf, 'to: recipientAddress,', 5], // every chain send
        ['handleConfirm', conf, 'recipient: recipientAddress,', 1], // the offline queue
        ['handleConfirm', conf, 'counterparty: recipientAddress,', 1], // the PE
        ['handleConfirm', conf, 'recordSend(recipientAddress,', 1],
    ] as const) {
        const n = body.split(literal).length - 1;
        if (n < atLeast) v.push(`${where} must read recipientAddress: "${literal}" found ${n}, expected at least ${atLeast}`);
    }
    if (/[^A-Za-z_.]recipient,\s*\n/.test(cont + conf) || /to: recipient,/.test(cont + conf) || /recipient\.trim\(\)/.test(src)) {
        v.push('a check or send reads the raw recipient text instead of recipientAddress');
    }

    // 2. One Continue at a time; the run that opens the review records what it checked.
    if (!/if \(continueInFlightRef\.current\) return;\s*\n\s*continueInFlightRef\.current = true;\s*\n\s*try \{/.test(cont)
        || !/finally \{\s*\n\s*continueInFlightRef\.current = false;/.test(cont)) {
        v.push('handleContinue must refuse to run twice at once (continueInFlightRef)');
    }
    if (!/const checked = \{ recipient: recipientAddress, amount: canonical\.value, asset: asset\.symbol, chain: asset\.chain, chainId: currentChainId \};\s*\n\s*reviewedRef\.current = null;/.test(cont)) {
        v.push('handleContinue must snapshot the recipient, amount, asset and chain it checks, and clear the previous review');
    }
    // The review opens from Continue directly, or from the warnings step the user acknowledges
    // (handleWarningProceed) — in both cases armed by the Continue run that did the checks.
    const reviews = (cont.match(/setStep\('(?:review|warnings)'\);/g) ?? []).length;
    const armed = (cont.match(/reviewedRef\.current = checked;\s*\n\s*setStep\('(?:review|warnings)'\);/g) ?? []).length;
    if (reviews === 0 || armed !== reviews) v.push(`every setStep('review') in handleContinue must be preceded by reviewedRef.current = checked (${armed} of ${reviews})`);
    const proceed = handlerBody(src, 'handleWarningProceed') || src.slice(src.indexOf('const handleWarningProceed'), src.indexOf('const handleWarningGoBack'));
    if (!/setStep\('review'\);/.test(proceed) || /reviewedRef\.current = /.test(proceed)) v.push('handleWarningProceed must open the review armed by Continue, never re-arm it');

    // 3. Confirm sends only what the review was opened with.
    // The refusal must be the whole block — alert, back to the input step, RETURN — and must come
    // before the Face ID prompt ( : a dropped `return;` would alert and then send).
    const refusal = conf.search(/const reviewed = reviewedRef\.current;\s*\n\s*if \(!reviewed \|\| reviewed\.recipient !== recipientAddress \|\| reviewed\.amount !== amount\s*\n\s*\|\| reviewed\.asset !== asset\.symbol \|\| reviewed\.chain !== asset\.chain \|\| reviewed\.chainId !== currentChainId\) \{\s*\n\s*Alert\.alert\(t\('common\.errorTitle'\), t\('send\.reviewAgain'\)\);\s*\n\s*setStep\('input'\);\s*\n\s*return;\s*\n\s*\}/);
    const faceId = conf.indexOf('withBiometricAction(');
    if (refusal < 0 || faceId < 0 || refusal > faceId) {
        v.push('handleConfirm must refuse a recipient, amount, asset or chain other than the reviewed one');
    }
    // A preflight that never answers must not hold the in-flight guard forever (round 4).
    if ((cont.match(/await withTimeout\(solanaTransactionService\.(?:sol|spl)SendSolRequirement\(/g) ?? []).length !== 2) {
        v.push('both Solana fee preflights must be bounded by withTimeout');
    }
    return v;
}

export function scanSwapReviewAmount(src: string): string[] {
    const v: string[] = [];
    if (!/const reviewPayAmount = React\.useMemo\(\(\) => \{\s*\n\s*const c = canonicalizeAmount\(amount, sendDecimalsOf\(fromAsset\)\);\s*\n\s*return c\.ok \? c\.value : amount;/.test(src)) {
        v.push('reviewPayAmount must be the canonical form of the typed amount');
    }
    if (!/testID="swap-review-pay">\s*\n\s*\{reviewPayAmount\} \{onChain\(fromAsset\)\}/.test(src)) {
        v.push('the swap review must show reviewPayAmount, the amount that executes');
    }
    return v;
}

describe('SendScreen — one recipient address, one reviewed send (source scan)', () => {
    const src = readFileSync(SEND_SCREEN, 'utf8');

    it('the shipped SendScreen passes every rule', () => {
        expect(scanSendReviewGuard(src)).toEqual([]);
    });

    it('RED: a check reading the raw recipient text is detected', () => {
        const old = src.replace("formatAddressForDisplay(recipientAddress)", "formatAddressForDisplay(recipient)");
        expect(old).not.toBe(src);
        expect(scanSendReviewGuard(old)).toContain('handleContinue must read recipientAddress: "formatAddressForDisplay(recipientAddress)" found 0, expected at least 1');
        const trimmed = src.replace("counterparty: recipientAddress,", "counterparty: recipient.trim(),");
        expect(scanSendReviewGuard(trimmed)).toContain('a check or send reads the raw recipient text instead of recipientAddress');
    });

    it('RED (round 3): a second Continue re-arming the review, or a review opened without the snapshot, is detected', () => {
        const reentrant = src.replace("if (continueInFlightRef.current) return;\n        continueInFlightRef.current = true;\n        try {", "try {");
        expect(reentrant).not.toBe(src);
        expect(scanSendReviewGuard(reentrant)).toContain('handleContinue must refuse to run twice at once (continueInFlightRef)');
        const unarmed = src.replace(/reviewedRef\.current = checked;\s*\n(\s*)setStep\('review'\);/, "$1setStep('review');");
        expect(unarmed).not.toBe(src);
        expect(scanSendReviewGuard(unarmed).some((m) => m.startsWith("every setStep('review') in handleContinue must be preceded by reviewedRef.current = checked"))).toBe(true);
    });

    it('RED: a Confirm that ignores the asset or chain, or the snapshot altogether, is detected', () => {
        const narrow = src.replace("\n            || reviewed.asset !== asset.symbol || reviewed.chain !== asset.chain || reviewed.chainId !== currentChainId) {", ") {");
        expect(narrow).not.toBe(src);
        expect(scanSendReviewGuard(narrow)).toContain('handleConfirm must refuse a recipient, amount, asset or chain other than the reviewed one');
    });

    it('RED (round 4): a refusal that alerts but carries on to Face ID (no return), or one placed after the prompt, is detected', () => {
        const noReturn = src.replace("            Alert.alert(t('common.errorTitle'), t('send.reviewAgain'));\n            setStep('input');\n            return;\n", "            Alert.alert(t('common.errorTitle'), t('send.reviewAgain'));\n            setStep('input');\n");
        expect(noReturn).not.toBe(src);
        expect(scanSendReviewGuard(noReturn)).toContain('handleConfirm must refuse a recipient, amount, asset or chain other than the reviewed one');
        const unbounded = src.replace('await withTimeout(solanaTransactionService.solSendSolRequirement(', 'await (solanaTransactionService.solSendSolRequirement(');
        expect(unbounded).not.toBe(src);
        expect(scanSendReviewGuard(unbounded)).toContain('both Solana fee preflights must be bounded by withTimeout');
    });
});

describe('SwapScreen — the review names the amount that executes (source scan)', () => {
    const src = readFileSync(SWAP_SCREEN, 'utf8');

    it('the shipped SwapScreen passes', () => {
        expect(scanSwapReviewAmount(src)).toEqual([]);
    });

    it('RED (round 2): a review showing the raw text ("1,000" while 1 executes) is detected', () => {
        const old = src.replace('{reviewPayAmount} {onChain(fromAsset)}', '{amount} {onChain(fromAsset)}');
        expect(old).not.toBe(src);
        expect(scanSwapReviewAmount(old)).toContain('the swap review must show reviewPayAmount, the amount that executes');
    });
});
