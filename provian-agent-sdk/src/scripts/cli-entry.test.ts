/**
 * cli-entry — a dispatched CLI must not also self-execute.
 *
 * The bug: under Node 26, the single-file bundle evaluates `require.main ===
 * module` as TRUE for a dynamically-imported submodule, so a CLI that both
 * exports its body (for bootstrap to call) and self-execs ran TWICE — a double
 * PE per commit for report-pe, and a double-submit of every turn for backfill.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { markCliDispatched, isDirectCliEntry } from './cli-entry';

const FLAG = '__PROVIAN_CLI_DISPATCHED__';
afterEach(() => { delete (globalThis as Record<string, unknown>)[FLAG]; });

describe('isDirectCliEntry', () => {
  it('THE FIX — returns false once the dispatcher has marked the process', () => {
    // Even for a module that genuinely IS require.main, a marked dispatcher wins:
    // the dispatcher will call the exported body, so self-exec must not fire.
    markCliDispatched();
    expect(isDirectCliEntry(require.main as NodeModule)).toBe(false);
  });

  it('returns true for a direct invocation (this module is not require.main here, so simulate)', () => {
    // In a direct `node script.js`, require.main === module. We cannot BE the
    // entry under vitest, so assert the two halves: unmarked + identity holds.
    delete (globalThis as Record<string, unknown>)[FLAG];
    const fakeEntry = require.main as NodeModule;
    expect(isDirectCliEntry(fakeEntry)).toBe(require.main === fakeEntry);
  });

  it('NEGATIVE CONTROL — a NON-entry module is never a direct entry, marked or not', () => {
    delete (globalThis as Record<string, unknown>)[FLAG];
    const notEntry = { id: 'some-other-module' } as unknown as NodeModule;
    expect(isDirectCliEntry(notEntry)).toBe(false);
    markCliDispatched();
    expect(isDirectCliEntry(notEntry)).toBe(false);
  });

  it('the mark is idempotent and global', () => {
    markCliDispatched();
    markCliDispatched();
    expect((globalThis as Record<string, unknown>)[FLAG]).toBe(true);
  });
});
