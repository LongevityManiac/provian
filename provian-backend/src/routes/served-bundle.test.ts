/**
 * served-bundle — the resolver of THIS revision's served bundle sha256 ((1B)).
 * The release-manifest route gates on this to serve a manifest only when its bundle
 * is in place, so the digest here must be the sha256 of the exact bytes on disk.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import {
  resolveServedBundle,
  resolveServedBundleSha256,
  servedBundlePath,
  __clearServedBundleCache,
} from './served-bundle';

describe('served-bundle ((1B))', () => {
  let dir: string;
  let bundlePath: string;
  const BYTES = Buffer.from('#!/usr/bin/env node\nconsole.log("served bundle");\n');
  const SHA = createHash('sha256').update(BYTES).digest('hex');
  const prevEnv = process.env.BOOTSTRAP_BUNDLE_PATH;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'served-bundle-'));
    bundlePath = path.join(dir, 'agent.js');
    fs.writeFileSync(bundlePath, BYTES);
    __clearServedBundleCache();
    delete process.env.BOOTSTRAP_BUNDLE_PATH;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (prevEnv === undefined) delete process.env.BOOTSTRAP_BUNDLE_PATH;
    else process.env.BOOTSTRAP_BUNDLE_PATH = prevEnv;
    __clearServedBundleCache();
  });

  it('computes the sha256 of the exact bytes on disk (explicit path)', () => {
    expect(resolveServedBundleSha256(bundlePath)).toBe(SHA);
    expect(resolveServedBundle(bundlePath)!.equals(BYTES)).toBe(true);
  });

  it('reads the BOOTSTRAP_BUNDLE_PATH env when no explicit path is given', () => {
    process.env.BOOTSTRAP_BUNDLE_PATH = bundlePath;
    expect(servedBundlePath()).toBe(bundlePath);
    expect(resolveServedBundleSha256()).toBe(SHA);
  });

  it('returns null when no bundle is configured (a deploy gap) — the route fails closed on this', () => {
    expect(servedBundlePath()).toBeUndefined();
    expect(resolveServedBundleSha256()).toBeNull();
    expect(resolveServedBundle()).toBeNull();
  });

  it('returns null when the configured path is unreadable', () => {
    expect(resolveServedBundleSha256(path.join(dir, 'missing.js'))).toBeNull();
  });

  // CONTROL: two different byte contents must produce different digests — the whole
  // point of the gate is that a changed bundle changes the hash the route compares.
  it('CONTROL — different bytes produce a different digest', () => {
    const other = path.join(dir, 'other.js');
    fs.writeFileSync(other, Buffer.concat([BYTES, Buffer.from('// extra\n')]));
    expect(resolveServedBundleSha256(other)).not.toBe(SHA);
  });
});
