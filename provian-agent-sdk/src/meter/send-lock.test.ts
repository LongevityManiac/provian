import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { tryAcquireFileLock } from './file-lock';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const options = { timeoutMs: 0, staleMs: 900_000, syncOnly: false, ownPidBeforeMs: performance.timeOrigin };
function lock(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'send-lock-'));
  roots.push(root);
  return path.join(root, 'send.lock');
}

describe(' async send lock across process images', () => {
  it('reclaims only this pid from before the image, preserving same-image exclusion and replacement tokens (RED)', () => {
    const file = lock();
    fs.writeFileSync(file, `${process.pid}:${Math.floor(performance.timeOrigin) - 1}`);
    const release = tryAcquireFileLock(file, options);
    expect(release).not.toBeNull();
    expect(tryAcquireFileLock(file, options)).toBeNull();
    const replacement = `${process.pid}:${Date.now() + 1}`;
    fs.writeFileSync(file, replacement);
    release!();
    expect(fs.readFileSync(file, 'utf8')).toBe(replacement);
  });

  it('never steals a foreign live pid merely because its lock predates this image (RED)', () => {
    const file = lock();
    const token = `${process.ppid}:${Math.floor(performance.timeOrigin) - 1}`;
    fs.writeFileSync(file, token);
    expect(tryAcquireFileLock(file, options)).toBeNull();
    expect(fs.readFileSync(file, 'utf8')).toBe(token);
  });
});
