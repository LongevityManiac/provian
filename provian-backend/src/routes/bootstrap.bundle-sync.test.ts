/**
 * Bundle-sync tripwire: the relay image serves the
 * onboarding bundle from a STAGED copy inside this package's Docker build
 * context (`provian-backend/bootstrap-bundle/agent.js`, wired via
 * BOOTSTRAP_BUNDLE_PATH in the Dockerfile), because the canonical esbuild
 * artifact (`provian-agent-sdk/dist-bundle/agent.js`) sits outside the
 * `gcloud run deploy --source provian-backend` context. A rebuilt bundle that
 * is not re-staged would silently deploy STALE onboarding code — this suite
 * makes that divergence a red build instead.
 */

import { describe, expect, it } from '@jest/globals';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { CONNECTION_TOKEN_ALPHABET } from '../core/connection-token-format';

const STAGED = path.join(__dirname, '..', '..', 'bootstrap-bundle', 'agent.js');
const CANONICAL = path.join(
  __dirname, '..', '..', '..', 'provian-agent-sdk', 'dist-bundle', 'agent.js',
);

const sha256 = (p: string): string =>
  crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// The retired connection-token guard the pre-rebuild bundle shipped:
// `/^[A-Za-z0-9_-]{16,256}$/`, whose 16-char minimum rejected every real 14-char
// PROV code. No live field uses a 16..256 bound (agentSessionId is {1,256},
// only ever meant the retired guard — a precise, false-positive-free stale signal.
const RETIRED_CONNECTION_TOKEN_GUARD = /\[A-Za-z0-9_-\]\{16,\s*256\}/;

describe('bootstrap bundle staging sync', () => {
  it('the staged image copy is byte-identical to the canonical SDK build artifact', () => {
    expect(fs.existsSync(STAGED)).toBe(true);
    expect(fs.existsSync(CANONICAL)).toBe(true);
    expect(sha256(STAGED)).toBe(sha256(CANONICAL));
  });

  it('the staged bundle is a real bundle, not an empty placeholder', () => {
    const bytes = fs.readFileSync(STAGED);
    expect(bytes.length).toBeGreaterThan(50_000);
    // The bundle must carry BOTH dispatch legs the hosted flows depend on.
    const text = bytes.toString('utf8');
    expect(text).toContain('restore-wallet');
    expect(text).toContain('PROVIAN_CONNECTION_TOKEN');
  });

  // Byte-identity (test 1) only proves the two COPIES agree — it cannot notice
  // that BOTH are stale, which is exactly how master shipped a bundle five SDK
  // commits behind its own source (the connectionToken fix among them). This
  // binds the bundle to the connection-token format class directly: a bundle
  // rebuilt from current source inlines the canonical alphabet and drops the
  // retired 16-char guard; a stale bundle (rebuild forgotten) still carries it.
  it('the staged bundle binds the canonical connection-token validator (no retired 16-char guard)', () => {
    const text = fs.readFileSync(STAGED, 'utf8');
    expect(text).toContain(CONNECTION_TOKEN_ALPHABET);
    expect(RETIRED_CONNECTION_TOKEN_GUARD.test(text)).toBe(false);
  });

  it('RED CONTROL: the stale-guard scan detects the exact guard the pre-rebuild bundle shipped', () => {
    // The literal line the stale bundle carried, minified-shape. If the scan
    // above cannot see THIS, its clean verdict on the real bundle proves nothing.
    const staleLine = 'if(!/^[A-Za-z0-9_-]{16,256}$/.test(t.connectionToken))throw 0;';
    expect(RETIRED_CONNECTION_TOKEN_GUARD.test(staleLine)).toBe(true);
    // The same scan is clean on the real staged bundle — the two verdicts
    // together prove it discriminates rather than always-passing.
    expect(RETIRED_CONNECTION_TOKEN_GUARD.test(fs.readFileSync(STAGED, 'utf8'))).toBe(false);
  });
});
