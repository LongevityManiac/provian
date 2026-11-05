/**
 * The canonical form of an amount a person typed on the Send / Swap screens.
 *
 * A decimal keypad produces a comma in many locales ("1,5"), and `parseFloat("1,5")` is 1: the
 * review step then showed the wrong figure, and the chain service refused the raw string only
 * after Face ID, as a node-level error (2026-10-17 bug check). Every typed amount passes through
 * here first: the separators are normalised, the precision is checked against the asset's
 * decimals, and the canonical dot-decimal string is what the chain services receive.
 */
export type CanonicalAmount =
    | { readonly ok: true; readonly value: string }
    | { readonly ok: false; readonly reason: 'empty' | 'format' | 'too_many_decimals' | 'zero' };

const AMOUNT_RE = /^(\d+(\.\d*)?|\.\d+)$/;
/** Grouping glyphs some locales put between thousands: space, NBSP, narrow NBSP, apostrophe, underscore. */
const GROUP_GLYPH = /[\s  '_]/;
/**
 * Well-formed thousands groups: a first group of 1–3 digits that does not start with 0, then groups
 * of exactly 3 — "1,000,000" / "1.000.000". "0.500" is never a grouped integer .
 */
const groupedInteger = (separator: ',' | '.'): RegExp => new RegExp(`^[1-9]\\d{0,2}(?:\\${separator}\\d{3})+$`);
/** "1 000", "1 000,50", "1'000.50": one grouping glyph, used consistently, then an optional decimal part. */
const GLYPH_GROUPED = /^[1-9]\d{0,2}(?:([\s  '_])\d{3})(?:\1\d{3})*(?:[.,]\d+)?$/;

/**
 * Separator rules : a SINGLE separator — dot or comma,
 * whichever the keypad produces — is the decimal mark ("1.5", "1,5", "0,001"). SEVERAL separators
 * are accepted only as well-formed thousands groups, with or without a NON-EMPTY decimal part of the
 * other glyph ("1,000,000", "1.000.000", "1,000.50", "1.000,50"). Anything else — "1.5.", "1.5,",
 * "0.1.5", "1,2,5", "0.500,", "2.500,", "0.000.001", "1 5" — is a typo and is refused, never read as
 * a larger amount (earlier cuts read "1.5." as fifteen and "0.500," as five hundred).
 */
function normalizeSeparators(raw: string): string | null {
    let text = raw.trim();
    if (GROUP_GLYPH.test(text)) {
        // A grouping glyph inside the number is accepted only in the well-formed grouped shape.
        if (!GLYPH_GROUPED.test(text)) return null;
        text = text.replace(/[\s  '_]/g, '');
    }
    const dots = (text.match(/\./g) ?? []).length;
    const commas = (text.match(/,/g) ?? []).length;
    if (dots + commas <= 1) return text.replace(',', '.');
    const lastDot = text.lastIndexOf('.');
    const lastComma = text.lastIndexOf(',');
    if (dots === 1 && lastDot > lastComma) {
        // "1,000.50": commas group, the dot is the mark; the decimal part must be there.
        const [whole, frac] = text.split('.');
        return frac.length > 0 && groupedInteger(',').test(whole) ? `${whole.replace(/,/g, '')}.${frac}` : null;
    }
    if (commas === 1 && lastComma > lastDot) {
        // "1.000,50": dots group, the comma is the mark; the decimal part must be there.
        const [whole, frac] = text.split(',');
        return frac.length > 0 && groupedInteger('.').test(whole) ? `${whole.replace(/\./g, '')}.${frac}` : null;
    }
    if (dots === 0 && groupedInteger(',').test(text)) return text.replace(/,/g, '');
    if (commas === 0 && groupedInteger('.').test(text)) return text.replace(/\./g, '');
    return null;
}

export function canonicalizeAmount(raw: string, decimals: number): CanonicalAmount {
    if (raw.trim().length === 0) return { ok: false, reason: 'empty' };
    const text = normalizeSeparators(raw);
    if (text === null || !AMOUNT_RE.test(text)) return { ok: false, reason: 'format' };
    const [wholeRaw, fracRaw = ''] = text.split('.');
    const whole = (wholeRaw === '' ? '0' : wholeRaw).replace(/^0+(?=\d)/, '');
    // Trailing zeros carry no precision ("1,000" typed on a decimal-comma keypad is one).
    const frac = fracRaw.replace(/0+$/, '');
    if (frac.length > decimals) return { ok: false, reason: 'too_many_decimals' };
    if (whole === '0' && frac.length === 0) return { ok: false, reason: 'zero' };
    return { ok: true, value: frac.length === 0 ? whole : `${whole}.${frac}` };
}

/** The decimals an asset's amount is parsed with, as the chain services parse it. */
export function sendDecimalsOf(asset: { readonly decimals?: number; readonly chain?: string; readonly symbol?: string; readonly isStablecoin?: boolean }): number {
    if (typeof asset.decimals === 'number') return asset.decimals;
    if (asset.chain === 'Solana') return asset.symbol === 'SOL' ? 9 : 6;
    return asset.isStablecoin ? 6 : 18;
}
