import { test, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, symlinkSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openChangeoverArtifacts } from './changeover-artifacts.mjs';
const syncFault = vi.hoisted(() => ({ target: null, paths: new Map() }));
vi.mock('node:fs', async original => {
  const fs = await original();
  return { ...fs, openSync: (...args) => { const fd = fs.openSync(...args); syncFault.paths.set(fd, String(args[0])); return fd; },
    closeSync: fd => { syncFault.paths.delete(fd); fs.closeSync(fd); },
    fsyncSync: fd => { if (syncFault.target === syncFault.paths.get(fd)) throw Error('ancestor_sync_failed'); fs.fsyncSync(fd); } };
});
function fixture(action) {
  const directory = mkdtempSync(join(tmpdir(), 'provian-changeover-artifacts-'));
  try { action(openChangeoverArtifacts(directory), directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}
test('immutable artifacts survive reopening and idempotent lost-response retries', () => fixture((store, directory) => {
  const input = { steps: [{ from: 'fixture', value: '0' }], cutoff: { number: 1 } };
  expect(store.read('retirement')).toBeNull(); expect(store.create('retirement', input)).toEqual(input);
  expect(statSync(join(directory, 'retirement.json')).mode & 0o777).toBe(0o600);
  expect(openChangeoverArtifacts(directory).read('retirement')).toEqual(input);
  expect(store.create('retirement', structuredClone(input))).toEqual(input);
  expect(readdirSync(directory)).toEqual(['retirement.json']);
  input.steps[0].value = '100'; expect(store.read('retirement').steps[0].value).toBe('0');
  expect(() => store.create('retirement', input)).toThrow(/conflicting_record/);
  expect(store.read('retirement').steps[0].value).toBe('0');
}));
test('corrupted payloads, traversal and symlink replacement refuse', () => fixture((store, directory) => {
  store.create('retirement', { amount: '1' });
  const path = join(directory, 'retirement.json'), row = JSON.parse(readFileSync(path, 'utf8')); row.payload.amount = '2';
  writeFileSync(path, JSON.stringify(row)); expect(() => store.read('retirement')).toThrow(/record_changed/);
  expect(() => store.create('../outside', {})).toThrow(/name_invalid/);
  const other = join(directory, 'other'); writeFileSync(other, 'unchanged'); symlinkSync(other, join(directory, 'activation.json'));
  expect(() => store.create('activation', { unsafe: true })).toThrow(); expect(readFileSync(other, 'utf8')).toBe('unchanged');
  expect(readdirSync(directory).some(name => name.endsWith('.tmp'))).toBe(false);
}));
test('new and adopted nested artifact stores require durable ancestor directory links', () => fixture((_store, directory) => {
  const nested = join(directory, 'one', 'two'); syncFault.target = directory;
  try { expect(() => openChangeoverArtifacts(nested)).toThrow(/ancestor_sync_failed/); }
  finally { syncFault.target = null; }
  const store = openChangeoverArtifacts(nested); store.create('retirement', { fixed: true });
  syncFault.target = directory;
  try {
    expect(() => openChangeoverArtifacts(nested)).toThrow(/ancestor_sync_failed/);
    expect(() => store.read('retirement')).toThrow(/ancestor_sync_failed/);
    expect(() => store.create('activation', { fixed: true })).toThrow(/ancestor_sync_failed/);
  } finally { syncFault.target = null; }
  expect(openChangeoverArtifacts(nested).read('retirement')).toEqual({ fixed: true });
}));
