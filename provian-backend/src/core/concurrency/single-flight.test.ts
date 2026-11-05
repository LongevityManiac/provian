/**
 * Single-flight coalescing (H2).
 *
 * shape: "concurrent callers share one computation" is the claim, and a
 * suite that awaited each call in sequence would pass against NO coalescing at
 * all — sequential calls are never concurrent. Every case below therefore starts
 * the calls first and awaits them together, and counts invocations of the
 * compute function rather than inspecting return values.
 */

import { singleFlight, inFlightCount } from './single-flight';

/** A promise plus the handles to settle it, so a flight can be held open. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('singleFlight', () => {
  it('runs compute ONCE for concurrent callers and gives them all the same value', async () => {
    const gate = deferred<string>();
    let calls = 0;
    const compute = () => { calls += 1; return gate.promise; };

    // Started, not awaited — otherwise these would be sequential and the test
    // would pass with no coalescing whatsoever.
    const a = singleFlight('k', compute);
    const b = singleFlight('k', compute);
    const c = singleFlight('k', compute);
    expect(calls).toBe(1);

    gate.resolve('value');
    expect(await Promise.all([a, b, c])).toEqual(['value', 'value', 'value']);
    expect(calls).toBe(1);
  });

  it('CONTROL — DIFFERENT keys do not coalesce', async () => {
    // Without this, the case above would pass against an implementation that
    // ignored the key and always returned the first flight.
    let calls = 0;
    const compute = () => { calls += 1; return Promise.resolve(calls); };

    const [x, y] = await Promise.all([singleFlight('k1', compute), singleFlight('k2', compute)]);

    expect(calls).toBe(2);
    expect(x).not.toBe(y);
  });

  it('does NOT cache a failure — the next caller recomputes', async () => {
    let calls = 0;
    const compute = () => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve('ok');
    };

    await expect(singleFlight('k', compute)).rejects.toThrow('boom');
    await expect(singleFlight('k', compute)).resolves.toBe('ok');
    expect(calls).toBe(2);
  });

  it('propagates one rejection to EVERY joiner, not just the first', async () => {
    const gate = deferred<string>();
    const compute = () => gate.promise;

    const a = singleFlight('k', compute);
    const b = singleFlight('k', compute);
    gate.reject(new Error('shared failure'));

    await expect(a).rejects.toThrow('shared failure');
    await expect(b).rejects.toThrow('shared failure');
  });

  it('releases the key after settling, so it cannot wedge', async () => {
    await singleFlight('k', () => Promise.resolve(1));
    expect(inFlightCount()).toBe(0);

    await expect(singleFlight('k', () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(inFlightCount()).toBe(0);
  });

  it('turns a SYNCHRONOUS throw into a rejection without wedging the key', async () => {
    // The nasty one: if `compute()` threw synchronously outside the try, the
    // throw would escape before the cleanup was attached and the key would stay
    // in the map forever, permanently poisoning that cache key.
    await expect(singleFlight('sync', () => { throw new Error('sync boom'); }))
      .rejects.toThrow('sync boom');
    expect(inFlightCount()).toBe(0);

    // Proof it is not wedged: the next flight for the same key runs.
    await expect(singleFlight('sync', () => Promise.resolve('recovered')))
      .resolves.toBe('recovered');
  });

  it('a later flight for the same key is not deleted by an earlier one settling', async () => {
    // Guards the `inFlight.get(key) === tracked` check: a naive
    // `inFlight.delete(key)` in the finally would remove a SECOND flight's entry
    // when the first settled, so that flight's joiners would start a third.
    const first = deferred<string>();
    const firstFlight = singleFlight('k', () => first.promise);
    first.resolve('one');
    await firstFlight;

    const second = deferred<string>();
    let secondCalls = 0;
    const secondFlight = singleFlight('k', () => { secondCalls += 1; return second.promise; });
    const joiner = singleFlight('k', () => { secondCalls += 1; return second.promise; });
    expect(secondCalls).toBe(1);

    second.resolve('two');
    expect(await Promise.all([secondFlight, joiner])).toEqual(['two', 'two']);
    expect(inFlightCount()).toBe(0);
  });
});
