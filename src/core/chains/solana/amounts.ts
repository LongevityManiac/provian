/**
 * Integer-safe conversion between human decimal strings and atomic units for
 * Solana assets (lamports for SOL, base units for SPL). No floating point — a
 * float rounding error on a money path is a silent loss.
 */

/**
 * Parse a decimal string (e.g. "1.25", ".01") into atomic units for `decimals`
 * precision. Throws on malformed input or on more fractional digits than the
 * token supports (fail closed rather than silently truncate value).
 */
export function parseAtomicAmount(decimal: string, decimals: number): bigint {
    const trimmed = decimal.trim();
    // Accept what a decimal keypad produces and the EVM path (ethers.parseUnits) accepts:
    // "1", "1.5", ".01", "1.". A lone "." or anything non-numeric is refused.
    if (!/^(\d+(\.\d*)?|\.\d+)$/.test(trimmed)) {
        throw new Error(`Invalid amount: "${decimal}"`);
    }
    const [wholeRaw, frac = ''] = trimmed.split('.');
    const whole = wholeRaw === '' ? '0' : wholeRaw;
    if (frac.length > decimals) {
        throw new Error(`Amount has more than ${decimals} decimal places: "${decimal}"`);
    }
    const fracPadded = frac.padEnd(decimals, '0');
    const scale = 10n ** BigInt(decimals);
    return BigInt(whole) * scale + BigInt(fracPadded || '0');
}

/**
 * Format atomic units back to a decimal UI string, trailing zeros trimmed.
 */
export function formatAtomicAmount(atomic: bigint, decimals: number): string {
    if (decimals === 0) return atomic.toString();
    const negative = atomic < 0n;
    const abs = negative ? -atomic : atomic;
    const s = abs.toString().padStart(decimals + 1, '0');
    const whole = s.slice(0, s.length - decimals);
    const frac = s.slice(s.length - decimals).replace(/0+$/, '');
    const out = frac ? `${whole}.${frac}` : whole;
    return negative ? `-${out}` : out;
}
