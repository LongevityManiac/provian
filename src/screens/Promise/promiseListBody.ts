/**
 * What the promise list shows where its rows go.
 *
 * "No promises yet" (and its "Make a Promise" prompt) is a statement about the person's promises.
 * It is shown only after a read that returned none — never before the first read answers, and
 * never in place of a read that failed.
 */
export type PromiseListLoad = 'loading' | 'loaded' | 'failed';
export type PromiseListBody = 'loading' | 'failed' | 'empty' | 'rows';

export function promiseListBody(load: PromiseListLoad, count: number): PromiseListBody {
    if (count > 0) return 'rows';
    return load === 'loaded' ? 'empty' : load;
}
