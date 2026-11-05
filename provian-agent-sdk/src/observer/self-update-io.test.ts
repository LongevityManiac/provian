import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { atomicReplaceFile, buildSelfUpdateIO } from './self-update-io';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-update-io-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('atomicReplaceFile', () => {
  it('replaces an existing file with new bytes and preserves its mode', () => {
    const target = path.join(dir, 'agent.js');
    fs.writeFileSync(target, 'OLD', { mode: 0o755 });
    atomicReplaceFile(target, Buffer.from('NEW BYTES'));
    expect(fs.readFileSync(target, 'utf8')).toBe('NEW BYTES');
    expect(fs.statSync(target).mode & 0o777).toBe(0o755);
    // No temp files left behind.
    expect(fs.readdirSync(dir).filter((n) => n.startsWith('.agent.js.new'))).toHaveLength(0);
  });

  it('creates the file when the target does not yet exist', () => {
    const target = path.join(dir, 'fresh.js');
    atomicReplaceFile(target, Buffer.from('HELLO'));
    expect(fs.readFileSync(target, 'utf8')).toBe('HELLO');
  });
});

describe('buildSelfUpdateIO', () => {
  it('round-trips the version file and reads current bytes', () => {
    const target = path.join(dir, 'agent.js');
    const versionFile = path.join(dir, 'release-version');
    fs.writeFileSync(target, 'RUNNING');
    const io = buildSelfUpdateIO({
      fetchManifest: async () => ({ body: {}, bytes: 0 }),
      fetchBundle: async () => Buffer.alloc(0),
      targetPath: target,
      versionFile,
      log: () => {},
      reExec: () => {},
    });
    expect(io.readVersion()).toBe(0); // absent → 0
    io.writeVersion(7);
    expect(io.readVersion()).toBe(7);
    expect(io.readCurrent()?.toString()).toBe('RUNNING');
    io.applyBytes(Buffer.from('SWAPPED'));
    expect(fs.readFileSync(target, 'utf8')).toBe('SWAPPED');
  });

  it('readCurrent returns null for a missing target, never throws', () => {
    const io = buildSelfUpdateIO({
      fetchManifest: async () => ({ body: {}, bytes: 0 }),
      fetchBundle: async () => Buffer.alloc(0),
      targetPath: path.join(dir, 'nope.js'),
      versionFile: path.join(dir, 'v'),
      log: () => {},
      reExec: () => {},
    });
    expect(io.readCurrent()).toBeNull();
  });
});
