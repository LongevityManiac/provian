import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, appendFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exerciseJournal } from './exercise-journal.mjs';
test('retains submitted hashes across restarts and reconciles exact receipts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'recourse-journal-')), file = join(directory, 'transactions.jsonl');
  const hash = `0x${'11'.repeat(32)}`;
  try {
    const journal = exerciseJournal(file); journal.submitted('deploy:history', hash);
    const restored = exerciseJournal(file);
    assert.deepEqual(restored.rows, [{ label: 'deploy:history', hash, receipt: null }]);
    restored.receipt(hash, { transactionHash: hash, status: '0x1' });
    assert.deepEqual(exerciseJournal(file).rows, restored.rows);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.throws(() => restored.submitted('duplicate', hash), /invalid/);
    assert.throws(() => restored.receipt(hash, { transactionHash: hash }), /invalid/);
    assert.throws(() => restored.receipt(`0x${'22'.repeat(32)}`, { transactionHash: hash }), /invalid/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('a torn last record is refused, never silently discarded', () => {
  const directory = mkdtempSync(join(tmpdir(), 'recourse-journal-')), file = join(directory, 'transactions.jsonl');
  try {
    exerciseJournal(file); appendFileSync(file, '{"kind":"submitted"');
    assert.throws(() => exerciseJournal(file), /truncated/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
