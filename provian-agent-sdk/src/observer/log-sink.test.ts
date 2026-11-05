/**
 * follow-up: the daemon writes ~/.provian/observer.log itself, however it was
 * started (the operator’s Grok bot ran it from a shell and the log went stale).
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureDaemonWritesLog } from './log-sink';

function fakeStream(): NodeJS.WriteStream & { seen: string[] } {
  const e = new EventEmitter() as unknown as NodeJS.WriteStream & { seen: string[] };
  e.seen = [];
  (e as unknown as { write: (c: string) => boolean }).write = (c: string) => { e.seen.push(String(c)); return true; };
  return e;
}

describe('ensureDaemonWritesLog', () => {
  it('stdout pointed at a shell: every line also lands in observer.log, and the shell still sees it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-'));
    try {
      const log = path.join(dir, 'observer.log');
      const stdout = fakeStream();
      const stderr = fakeStream();
      expect(ensureDaemonWritesLog(log, { fstat: () => ({ dev: 1, ino: 99 }), stdout, stderr })).toBe('teed');
      stdout.write('[observer] started (pid 1839490)\n');
      stderr.write('warn line\n');
      expect(fs.readFileSync(log, 'utf8')).toBe('[observer] started (pid 1839490)\nwarn line\n');
      expect(stdout.seen).toEqual(['[observer] started (pid 1839490)\n']);
      expect(stderr.seen).toEqual(['warn line\n']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('a shell that went away (EPIPE) never takes the daemon down; the log keeps every line', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-'));
    try {
      const log = path.join(dir, 'observer.log');
      const stdout = fakeStream();
      (stdout as unknown as { write: () => boolean }).write = () => { throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }); };
      const stderr = fakeStream();
      ensureDaemonWritesLog(log, { fstat: () => ({ dev: 1, ino: 99 }), stdout, stderr });
      expect(() => stdout.write('a\n')).not.toThrow();
      stderr.emit('error', new Error('EPIPE'));
      expect(() => stderr.write('b\n')).not.toThrow();
      expect(stderr.seen).toEqual([]); // passthrough dropped after the error
      expect(fs.readFileSync(log, 'utf8')).toBe('a\nb\n');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('RED control: stdout already IS observer.log (installer / hook / successor) — nothing is wrapped, no line is written twice', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-'));
    try {
      const log = path.join(dir, 'observer.log');
      fs.writeFileSync(log, '');
      const st = fs.statSync(log);
      const stdout = fakeStream();
      const before = stdout.write;
      expect(ensureDaemonWritesLog(log, { fstat: () => ({ dev: st.dev, ino: st.ino }), stdout, stderr: fakeStream() })).toBe('already_logging');
      expect(stdout.write).toBe(before);
      stdout.write('x\n');
      expect(fs.readFileSync(log, 'utf8')).toBe('');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
