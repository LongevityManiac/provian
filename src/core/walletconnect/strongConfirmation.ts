/**
 * The hard_confirm ("type I UNDERSTAND" + cooling-off) gate, enforced by the SERVICE at execution
 * (fix run 2026-10-24, CC launch audit H3). The screen renders the control; the service decides.
 * A confirmation names the request it was typed for, so a confirmation (or a verdict) belonging to
 * another request can never satisfy this one, and the cooling-off is measured from the moment the
 * service first computed a strong verdict for THIS request.
 */
import type { WalletConnectVerdict } from './WalletConnectGovernance';
import { translate } from '../../i18n/translate';

export const STRONG_CONFIRM_PHRASE = 'I UNDERSTAND';
export const STRONG_CONFIRM_COOLING_SECONDS = 5;
export const STRONG_CONFIRM_COOLING_MS = STRONG_CONFIRM_COOLING_SECONDS * 1000;

/** What the screen hands the service with an approval: the request it was typed for, and the text. */
export interface StrongConfirmation {
    readonly requestId: number;
    readonly phrase: string;
}

const STRONG_CONFIRM_REQUIRED_ENGLISH = 'This request needs you to type I UNDERSTAND and wait for the cooling-off before approving.';

export class StrongConfirmationRequiredError extends Error {
    /** English text for dApp replies and PE records; `message` is the on-screen copy. */
    readonly englishMessage: string;
    constructor(message?: string) {
        super(message ?? translate('walletConnect.strongConfirmRequired', STRONG_CONFIRM_REQUIRED_ENGLISH, { phrase: STRONG_CONFIRM_PHRASE }));
        this.englishMessage = message ?? STRONG_CONFIRM_REQUIRED_ENGLISH;
        this.name = 'StrongConfirmationRequiredError';
    }
}

/**
 * True when `verdict` (computed at execution for request `requestId`) needs no strong confirmation,
 * or the confirmation names this request, carries the phrase, and the cooling-off since the
 * service first showed a strong verdict for this request has elapsed. PURE.
 */
export function strongConfirmationSatisfied(input: {
    readonly requestId: number;
    readonly verdict: Pick<WalletConnectVerdict, 'requiresStrongConfirm'>;
    readonly confirmation: StrongConfirmation | undefined;
    readonly strongShownAtMs: number | undefined;
    readonly nowMs: number;
}): boolean {
    if (!input.verdict.requiresStrongConfirm) return true;
    const c = input.confirmation;
    if (!c || c.requestId !== input.requestId) return false;
    if (typeof c.phrase !== 'string' || c.phrase.trim().toUpperCase() !== STRONG_CONFIRM_PHRASE) return false;
    if (input.strongShownAtMs === undefined) return false;
    return input.nowMs - input.strongShownAtMs >= STRONG_CONFIRM_COOLING_MS;
}
