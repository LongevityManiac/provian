/**
 * STANDING MINTER-vs-VALIDATOR FORMAT CONTRACTS.
 *
 * Two shipped defects motivated this suite, both the same class: a value is
 * MINTED in one module and VALIDATED in another, each side declaring the format
 * independently, and the declarations drift — so every fixture that fabricates
 * the value instead of calling the production minter stays green while
 * production fails. Instance 1: the connection-code generator minted 14-char
 * `PROV-XXXX-XXXX` codes while both resolvers guarded `{16,256}`, rejecting
 * every real code pre-lookup. Instance 2: GitHub owner-capture read
 * `installation.account`, a field push deliveries never carry.
 *
 * The contract this suite enforces: for every minter/validator pair, the test
 * drives the REAL validator with the REAL minter's output — never a fixture
 * literal — and a source-binding scan keeps resolvers importing the single
 * format module rather than growing a private regex back. Each check ships its
 * RED negative control (a guard that cannot fail is not evidence).
 */

import { describe, expect, it, jest } from '@jest/globals';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import express from 'express';
import request from 'supertest';
import type { Firestore } from 'firebase-admin/firestore';

const cacheStore = new Map<string, unknown>();
jest.mock('./cache', () => ({
  cache: {
    get: async (k: string) => cacheStore.get(k) ?? null,
    set: async (k: string, v: unknown) => { cacheStore.set(k, v); },
    del: async (k: string) => { cacheStore.delete(k); },
  },
}));

import {
  generateConnectionToken,
  isValidConnectionTokenFormat,
} from './core/connection-token-format';
import { generateApiCredentials } from './core/agent-wallet/api-key';
import { createFakeFirestore } from './core/pvt/__test-helpers__/fake-firestore';
import { createAgentAuthMiddleware } from './routes/middleware/agent-auth';

// ---------------------------------------------------------------------------
// Contract 1: connection code — the resolvers must bind to the ONE format
// module. A private token regex growing back into a resolver is the exact
// mechanism of the shipped 14-vs-16 bug, so the scan looks for any bounded
// character-class quantifier (the `{16,256}`-style shape) outside the shared
// module.
// ---------------------------------------------------------------------------

const RESOLVER_SOURCES = [
  'src/core/agent-wallet/fleet-code.ts',
  'src/routes/bootstrap.ts',
  'src/core/agent-bootstrap-script.ts',
] as const;

/** A char-class followed by a bounded {m,n} quantifier — the drift signature. */
const PRIVATE_TOKEN_REGEX_SIGNATURE = /\[[^\]\n]*\]\{\d+,\d+\}/;

function readResolverSource(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

describe('format contract: connection code minter vs resolvers', () => {
  it('every resolver imports the shared format module (no private redeclaration)', () => {
    for (const rel of RESOLVER_SOURCES) {
      const src = readResolverSource(rel);
      expect(src).toMatch(/from '.*connection-token-format'/);
      expect(src).toMatch(/isValidConnectionTokenFormat|CONNECTION_TOKEN_PATTERN/);
    }
  });

  it('no resolver carries a private bounded token regex (the drift signature)', () => {
    let scanned = 0;
    for (const rel of RESOLVER_SOURCES) {
      const src = readResolverSource(rel);
      scanned += 1;
      expect({ file: rel, match: src.match(PRIVATE_TOKEN_REGEX_SIGNATURE) })
        .toEqual({ file: rel, match: null });
    }
    // Empty-population guard: the universally-quantified claim above is
    // meaningless over zero files.
    expect(scanned).toBe(RESOLVER_SOURCES.length);
  });

  it('RED CONTROL: the drift signature detector catches the shipped bug verbatim', () => {
    // The exact guard both resolvers carried before the collapse. If the
    // detector cannot see THIS, the scan above proves nothing.
    const shippedBugLine = "if (!/^[A-Za-z0-9_-]{16,256}$/.test(token)) return null;";
    expect(shippedBugLine).toMatch(PRIVATE_TOKEN_REGEX_SIGNATURE);
  });

  it('the production minter round-trips the production validator (many samples)', () => {
    for (let i = 0; i < 64; i += 1) {
      expect(isValidConnectionTokenFormat(generateConnectionToken())).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Contract 1b: the relay canonical connection-token-format and the SDK mirror
// (provian-agent-sdk/src/connection-token-format.ts) are two copies of the same
// format BY NECESSITY — the SDK is a separate published package and cannot import
// across the boundary. That is the exact duplication that drifted three times.
// The parity guard fails if they diverge on ALPHABET, PATTERN, or LENGTH. This
// drives the SAME script CI runs in the copy-guards job, so backend suite and CI
// enforce one checker, and its --self-test proves the checker can still fail.
// ---------------------------------------------------------------------------

const PARITY_SCRIPT = path.join(
  __dirname, '..', '..', 'scripts', 'check-connection-token-format-parity.mjs',
);

describe('format contract: connection-token-format canonical vs SDK mirror', () => {
  it('the relay canonical and the SDK mirror are in sync today', () => {
    // Non-zero exit (divergence, or a missing declaration) throws; the assertion
    // is "does not throw", and the OK line names the agreed alphabet/pattern/length.
    expect(() => execFileSync('node', [PARITY_SCRIPT], { encoding: 'utf8' })).not.toThrow();
  });

  it('RED CONTROL: the parity guard still detects a planted divergence on every axis', () => {
    const out = execFileSync('node', [PARITY_SCRIPT, '--self-test'], { encoding: 'utf8' });
    expect(out).toContain('alphabet divergence detected');
    expect(out).toContain('length divergence detected');
    expect(out).toContain('pattern divergence detected');
  });
});

// ---------------------------------------------------------------------------
// Contract 2: agent API key — the mint-side prefix (api-key.ts) and the
// auth-side extraction (agent-auth.ts) each declare `slice(0, 24)` in their own
// file. This drives the REAL middleware with the REAL minted credential: if
// either side's length or shape moves alone, the index doc id no longer matches
// the auth-side lookup and the round-trip 401s.
// ---------------------------------------------------------------------------

async function mountAuthWith(cred: ReturnType<typeof generateApiCredentials>, opts?: {
  indexDocId?: string;
}): Promise<express.Express> {
  cacheStore.clear();
  const fake = createFakeFirestore();
  const db = fake as unknown as Firestore;
  const walletId = 'wallet_aw_format_contract';
  await db.collection('api_key_index').doc(opts?.indexDocId ?? cred.api_key_prefix).set({
    api_key_prefix: cred.api_key_prefix,
    wallet_id: walletId,
    created_at: 1,
  });
  await db.collection('agent_wallets').doc(walletId).set({
    id: walletId,
    agent_id: 'format-contract-agent',
    status: 'active',
    api_key_prefix: cred.api_key_prefix,
    api_key_hash: cred.api_key_hash,
    api_key_salt: cred.api_key_salt,
  });
  const app = express();
  app.get('/protected', createAgentAuthMiddleware(db), (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('format contract: agent API key mint vs auth extraction', () => {
  it('a freshly minted credential authenticates through the real middleware', async () => {
    const cred = generateApiCredentials();
    const app = await mountAuthWith(cred);
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${cred.api_key}:${cred.api_secret}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('RED CONTROL: an index doc keyed off the minted prefix by one char is not found', async () => {
    const cred = generateApiCredentials();
    const app = await mountAuthWith(cred, { indexDocId: `${cred.api_key_prefix}x` });
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${cred.api_key}:${cred.api_secret}`);
    expect(res.status).toBe(401);
  });

  it('RED CONTROL: a tampered secret is refused (scrypt discriminates)', async () => {
    const cred = generateApiCredentials();
    const app = await mountAuthWith(cred);
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${cred.api_key}:pvns_${'0'.repeat(64)}`);
    expect(res.status).toBe(401);
  });
});
