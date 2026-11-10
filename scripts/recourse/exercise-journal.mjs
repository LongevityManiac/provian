import { existsSync, openSync, readFileSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
/** Append and fsync each submitted hash before polling its receipt. Rewriting
 * the entire journal after every historical import is quadratic in its size. */
export function exerciseJournal(path, initial = []) {
  const rows = initial.map(row => ({ ...row }));
  const apply = event => {
    if (!event || typeof event !== 'object' || typeof event.hash !== 'string' || !/^0x[0-9a-f]{64}$/.test(event.hash)) throw Error('exercise_journal_invalid');
    if (event.kind === 'submitted') {
      if (typeof event.label !== 'string' || rows.some(row => row.hash === event.hash)) throw Error('exercise_journal_invalid');
      rows.push({ label: event.label, hash: event.hash, receipt: null });
    } else if (event.kind === 'receipt') {
      const row = rows.find(row => row.hash === event.hash);
      if (!row || row.receipt !== null || !event.receipt || event.receipt.transactionHash !== event.hash) throw Error('exercise_journal_invalid');
      row.receipt = event.receipt;
    } else throw Error('exercise_journal_invalid');
  };
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8');
    if (raw && !raw.endsWith('\n')) throw Error('exercise_journal_truncated');
    for (const line of raw.split('\n').filter(Boolean)) apply(JSON.parse(line));
  } else {
    const fd = openSync(path, 'wx', 0o600);
    try { fsyncSync(fd); } finally { closeSync(fd); }
    const directory = openSync(dirname(path), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  const append = event => {
    // Apply to memory first to reject inconsistent events before writing bytes.
    // If persistence fails the caller stops; no receipt poll or next send occurs.
    apply(event);
    const fd = openSync(path, 'a');
    try {
      const bytes = Buffer.from(JSON.stringify(event) + '\n');
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset);
        if (written <= 0) throw Error('exercise_journal_write_failed');
        offset += written;
      }
      fsyncSync(fd);
    } finally { closeSync(fd); }
  };
  return { rows, submitted(label, hash) { append({ kind: 'submitted', label, hash }); },
    receipt(hash, receipt) { append({ kind: 'receipt', hash, receipt }); } };
}
