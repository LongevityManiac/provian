/**
 * every production writer of a watched-address SOURCE row (the native address index, an
 * agent's proven address, a person's proven address) also records the address in the watch
 * registry, in its own transaction. The registry is add-only and the daily reconcile is the
 * backstop, but a writer that skips it delays a new wallet's first payment by up to a day; this
 * guard refuses such a writer when it lands.
 *
 * Detection is static: a reference bound to `collection(<source>)` and then passed to `set` or
 * `create` (directly, or as `<obj>.<ref>`). A file that writes one must call
 * `recordWatchRegistryEntry` or `writeNativeWalletWatcherRegistration`.
 */
import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';

const SOURCE_COLLECTIONS = ['NATIVE_WALLET_ADDRESS_INDEX_COLLECTION', 'PROVEN_ADDRESSES_COLLECTION', 'HUMAN_PROVEN_ADDRESSES_COLLECTION'];
const REGISTRY_CALLS = /\b(recordWatchRegistryEntry|writeNativeWalletWatcherRegistration)\s*\(/;
const SRC = path.resolve(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__test-helpers__' || entry.name === 'node_modules') continue;
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** The source-row refs this file writes (empty when it writes none). */
export function sourceRowWrites(text: string): string[] {
  const collections = SOURCE_COLLECTIONS.join('|');
  const binding = new RegExp(`(?:const|let)\\s+(\\w+)\\s*=\\s*[\\w.]*collection\\(\\s*(?:${collections})\\s*\\)|(\\w+)\\s*:\\s*[\\w.]*collection\\(\\s*(?:${collections})\\s*\\)`, 'g');
  const refs = new Set<string>();
  for (const match of text.matchAll(binding)) refs.add(match[1] ?? match[2]);
  const written: string[] = [];
  for (const ref of refs) {
    const write = new RegExp(`\\b(?:set|create)\\(\\s*(?:[\\w.]+\\.)?${ref}\\b`);
    if (write.test(text)) written.push(ref);
  }
  // A write straight through the collection expression, with no ref in between.
  if (new RegExp(`collection\\(\\s*(?:${collections})\\s*\\)\\s*\\.doc\\([^)]*\\)\\s*\\.(?:set|create)\\(`).test(text)) written.push('<inline>');
  return written;
}

describe('watched-address source writers record the watch registry entry', () => {
  it('every production file that writes a source row calls the registry writer', () => {
    const offenders: string[] = [];
    let writers = 0;
    for (const file of sourceFiles(SRC)) {
      const text = fs.readFileSync(file, 'utf8');
      if (!SOURCE_COLLECTIONS.some((name) => text.includes(name))) continue;
      if (sourceRowWrites(text).length === 0) continue;
      writers += 1;
      if (!REGISTRY_CALLS.test(text)) offenders.push(path.relative(SRC, file));
    }
    // The known writers: agent create, human registration, key rotation, the two proof writers.
    console.log(`[watch-registry-writers] source-row writers evaluated: ${writers}`);
    expect(writers).toBeGreaterThanOrEqual(5);
    expect(offenders).toEqual([]);
  });

  it('RED CONTROL — a writer of each shape without the registry call is detected', () => {
    const viaRef = `const addressIndexRef = db.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION).doc(id);\ntxn.create(addressIndexRef, row);`;
    const viaPlan = `return { addressIndexRef: db.collection(PROVEN_ADDRESSES_COLLECTION).doc(a) };\ntxn.set(plan.addressIndexRef, row);`;
    const inline = `await db.collection(HUMAN_PROVEN_ADDRESSES_COLLECTION).doc(a).set(row);`;
    const readOnly = `const ref = db.collection(PROVEN_ADDRESSES_COLLECTION).doc(a);\nawait txn.get(ref);`;
    expect(sourceRowWrites(viaRef)).toEqual(['addressIndexRef']);
    expect(sourceRowWrites(viaPlan)).toEqual(['addressIndexRef']);
    expect(sourceRowWrites(inline)).toEqual(['<inline>']);
    expect(sourceRowWrites(readOnly)).toEqual([]);
    expect(REGISTRY_CALLS.test(viaRef)).toBe(false);
  });
});
