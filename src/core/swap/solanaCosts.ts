/**
 * The SOL a swap starting on Solana needs, as the relay measured it for the user's own
 * transaction (provian-backend core/swap/solana-swap-costs.ts → `solana_costs` on every Jupiter
 * order and LI.FI Solana-source quote).
 *
 * The user pays every one of these in SOL, never in the token being swapped: the network fee,
 * the deposit that opens their own account for the token they receive, the deposit that opens
 * Provian's fee account when this swap is the first to take a fee in that token (the operator,
 * 2026-09-25: the user pays it, not Provian), any other account the route opens, and — for a
 * native SOL swap — the SOL being swapped. A temporary wrapped-SOL account is opened and closed
 * in the same swap: refunded, but the wallet must hold it while the swap runs.
 *
 * `parseSolanaCosts` fails closed: a missing or inconsistent answer is null, and the caller
 * shows no quote rather than a swap whose SOL need is unknown.
 */

export type SolanaCostKind = 'network' | 'receiving' | 'treasury' | 'temporary' | 'other' | 'swapped';

export interface SolanaCostSummary {
    /** Lamports per cost, as decimal strings. */
    lamports: Record<SolanaCostKind, string>;
    /** What the swap takes from the wallet (everything but the refunded part). */
    spendLamports: string;
    /** What the wallet must hold for the swap to run and stay open. */
    requiredLamports: string;
    balanceLamports: string;
    shortfallLamports: string;
    sufficient: boolean;
    /** True when measured by simulating the user's exact transaction. */
    measured: boolean;
}

const UINT = /^[0-9]{1,20}$/;

export function parseSolanaCosts(raw: unknown): SolanaCostSummary | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const fields = [
        'network_fee_lamports', 'receiving_account_lamports', 'treasury_fee_account_lamports',
        'temporary_account_lamports', 'other_accounts_lamports', 'sol_swapped_lamports',
        'spend_lamports', 'required_lamports', 'balance_lamports', 'shortfall_lamports',
        'rent_exempt_minimum_lamports',
    ] as const;
    for (const f of fields) {
        if (typeof r[f] !== 'string' || !UINT.test(r[f] as string)) return null;
    }
    if (typeof r.sufficient !== 'boolean' || typeof r.measured !== 'boolean') return null;
    const n = (f: (typeof fields)[number]) => BigInt(r[f] as string);
    // The relay's own identities: a figure that does not add up is not shown.
    const spend = n('network_fee_lamports') + n('receiving_account_lamports') + n('treasury_fee_account_lamports')
        + n('other_accounts_lamports') + n('sol_swapped_lamports');
    if (spend !== n('spend_lamports')) return null;
    if (n('required_lamports') < spend + n('temporary_account_lamports')) return null;
    // `sufficient` gates sending, so it is recomputed here by the send screen's rule, not
    // trusted: the wallet covers the spend plus the temporary accounts, and ends at 0 or at
    // least the rent-exempt minimum.
    const left = n('balance_lamports') - spend;
    const fits = n('balance_lamports') >= spend + n('temporary_account_lamports')
        && (left === 0n || left >= n('rent_exempt_minimum_lamports'));
    if (r.sufficient !== fits) return null;
    const shortfall = r.sufficient ? 0n : n('required_lamports') - n('balance_lamports');
    if (n('shortfall_lamports') !== (shortfall > 0n ? shortfall : 0n)) return null;
    return {
        lamports: {
            network: r.network_fee_lamports as string,
            receiving: r.receiving_account_lamports as string,
            treasury: r.treasury_fee_account_lamports as string,
            temporary: r.temporary_account_lamports as string,
            other: r.other_accounts_lamports as string,
            swapped: r.sol_swapped_lamports as string,
        },
        spendLamports: r.spend_lamports as string,
        requiredLamports: r.required_lamports as string,
        balanceLamports: r.balance_lamports as string,
        shortfallLamports: r.shortfall_lamports as string,
        sufficient: r.sufficient,
        measured: r.measured,
    };
}

/**
 * The cost rows to show, in order: the network fee always, each account deposit only when
 * non-zero. The SOL being swapped is the amount itself, not a cost; it is inside `required`.
 */
export function solanaCostRows(c: SolanaCostSummary): Array<{ kind: Exclude<SolanaCostKind, 'swapped'>; lamports: string }> {
    const order = ['network', 'receiving', 'treasury', 'temporary', 'other'] as const;
    return order
        .filter((k) => k === 'network' || BigInt(c.lamports[k]) > 0n)
        .map((k) => ({ kind: k, lamports: c.lamports[k] }));
}

/** Exact lamports → SOL, trailing zeros trimmed ("0.00148844"). */
export function lamportsToSol(lamports: string): string {
    const v = BigInt(lamports);
    const whole = v / 1_000_000_000n;
    const frac = (v % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole.toString();
}
