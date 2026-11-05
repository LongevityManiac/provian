/**
 * PE meter — a pe_fact built from the presenter's own store (the relay keeps no PE), and finding
 * that store from a CLI verb.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { verifyActInclusion } from '../meter-wire';
import { peFactFromStore } from './prove';
import { resolveLocalPeStore } from './local-store';
import { anchoredStore, ANCHORED_ACTOR_ID, ANCHORED_DEVICE_ID } from './anchored-store.test-support';

describe('peFactFromStore', () => {
  it('builds {pe, pe_hash, inclusion} for an anchored PE, and the inclusion proves the PE (hop 1)', async () => {
    const { store, pes } = await anchoredStore({ pes: 3 });
    const r = await peFactFromStore(store, pes[1].pe_id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fact.envelopeHash).toBe(pes[1].pe_hash);
    expect(r.fact.pe).toEqual(pes[1]);
    expect(r.fact.inclusion.batch).toEqual({ device_id: ANCHORED_DEVICE_ID, actor_id: ANCHORED_ACTOR_ID, seq: 1, batch_hash: 'b0'.repeat(32) });
    expect(r.fact.inclusion.anchor?.day).toBe('2026-10-02');
    expect(verifyActInclusion(r.fact.pe, r.fact.inclusion).ok).toBe(true);
  });

  it('accepts <pe_id>:<pe_hash> when the hash matches, and refuses a different hash (RED)', async () => {
    const { store, pes } = await anchoredStore();
    expect((await peFactFromStore(store, `${pes[0].pe_id}:${pes[0].pe_hash}`)).ok).toBe(true);
    const wrong = await peFactFromStore(store, `${pes[0].pe_id}:${'0'.repeat(64)}`);
    expect(wrong).toMatchObject({ ok: false, reason: 'envelope_hash_mismatch' });
  });

  it('RED: a PE whose day is not anchored yet, not batched yet, or not held here is refused with a reason', async () => {
    const unanchored = await anchoredStore({ anchored: false });
    expect(await peFactFromStore(unanchored.store, unanchored.pes[0].pe_id)).toMatchObject({ ok: false, reason: 'not_anchored_yet' });
    const unbatched = await anchoredStore({ batched: false });
    expect(await peFactFromStore(unbatched.store, unbatched.pes[0].pe_id)).toMatchObject({ ok: false, reason: 'not_batched_yet' });
    const r = await peFactFromStore(unanchored.store, 'pe_elsewhere');
    expect(r).toMatchObject({ ok: false, reason: 'pe_not_found' });
    if (!r.ok) expect(r.detail).toMatch(/not in this machine's PE store/);
  });
});

describe('resolveLocalPeStore', () => {
  const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'pe-store-root-'));
  const seed = (root: string, dir: string): void => {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, 'pes.jsonl'), '');
  };

  it('uses the given device id', () => {
    const root = tmp();
    const r = resolveLocalPeStore({ deviceId: 'dev_abc', root, env: {} });
    expect(r.ok && r.store.deviceId).toBe('dev_abc');
  });

  it('without a device id, resolves the one store under the root', () => {
    const root = tmp();
    seed(root, 'dev_only1');
    const r = resolveLocalPeStore({ root, env: {} });
    expect(r.ok && r.store.deviceId).toBe('dev_only1');
  });

  it('RED: never guesses between two stores, and reports an empty root', () => {
    const root = tmp();
    expect(resolveLocalPeStore({ root, env: {} })).toMatchObject({ ok: false, reason: 'no_store' });
    seed(root, 'dev_one');
    seed(root, 'dev_two');
    expect(resolveLocalPeStore({ root, env: {} })).toMatchObject({ ok: false, reason: 'ambiguous' });
    // PROVIAN_DEVICE_ID chooses.
    const chosen = resolveLocalPeStore({ root, env: { PROVIAN_DEVICE_ID: 'dev_two' } });
    expect(chosen.ok && chosen.store.deviceId).toBe('dev_two');
  });
});
