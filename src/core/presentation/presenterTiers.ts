/**
 * Which presentation tiers the presenter screen offers.
 *
 * A presentation that backs a Commons act — a hire (the rail handshake to the applicant) or a vouch —
 * is always at the reputation tier: a hire handshake counts only when its burn is at least the 15 PVT
 * reputation floor, and a vouch rides a reputation presentation. Those flows offer no tier choice.
 * Every other presentation offers both tiers.
 */
export type PresenterTier = 'reputation' | 'pe_fact';

export function presenterTierOptions(commonsActKind: 'hire' | 'vouch' | null): readonly PresenterTier[] {
    return commonsActKind === null ? ['reputation', 'pe_fact'] : ['reputation'];
}
