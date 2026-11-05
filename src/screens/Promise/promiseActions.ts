import { counterAwaitsMyAnswer, type PromiseRecord, type PromiseStatus } from '../../core/promises/PromiseService';

/**
 * Which statuses show the detail screen's Actions card. `countered` was missing until
 * 2026-10-17, so a counter-offer showed no actions and dead-ended for both parties.
 */
export const PROMISE_ACTION_STATUSES: ReadonlySet<PromiseStatus> = new Set(['pending', 'accepted', 'countered']);

export type CounterOfferAction = 'accept' | 'counter' | 'decline' | 'share' | 'withdraw';

/** The status each counter-offer action moves the promise to (`share` changes nothing). */
export const COUNTER_OFFER_ACTION_TARGET: Readonly<Record<CounterOfferAction, PromiseStatus | null>> = {
    accept: 'accepted',
    counter: 'countered',
    decline: 'rejected',
    share: null,
    withdraw: 'rejected',
};

export type CounterOfferView =
    /** The other party countered; this device answers. */
    | { readonly kind: 'answer'; readonly actions: readonly CounterOfferAction[] }
    /** The other party countered, but their terms have not reached this device yet. */
    | { readonly kind: 'awaiting_terms'; readonly actions: readonly CounterOfferAction[] }
    /** This device countered and waits for the other party. */
    | { readonly kind: 'mine'; readonly actions: readonly CounterOfferAction[] };

/**
 * The actions a countered promise offers on this device. The party who did not counter may take
 * every transition the state machine allows from `countered` except `expired`, which only time
 * takes: accept, counter again, decline. Until the counter's terms arrive (the re-shared link)
 * only a decline is possible: nothing is signed over terms this device has not seen. The party
 * who countered shares the counter's link, or withdraws it.
 */
export function counterOfferView(promise: Pick<PromiseRecord, 'status' | 'counterFromCounterparty' | 'counterTermsPending'>): CounterOfferView | null {
    if (promise.status !== 'countered') return null;
    if (!counterAwaitsMyAnswer(promise)) return { kind: 'mine', actions: ['share', 'withdraw'] };
    if (promise.counterTermsPending) return { kind: 'awaiting_terms', actions: ['decline'] };
    return { kind: 'answer', actions: ['accept', 'counter', 'decline'] };
}
