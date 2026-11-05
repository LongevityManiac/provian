/**
 * Display-only trim of trailing zeros on a plain decimal balance string
 * ("0.000000" -> "0", "1.500000" -> "1.5", "10.00" -> "10"). Anything that is
 * not a plain decimal (already-formatted, empty, grouped) is returned unchanged.
 */
export const displayBalance = (balance: string): string =>
    /^\d+\.\d+$/.test(balance) ? balance.replace(/\.?0+$/, '') : balance;
