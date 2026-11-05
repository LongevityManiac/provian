import { describe, it, expect, afterAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Firestore } from 'firebase-admin/firestore';
import { createBootstrapRouter } from './bootstrap';

// These routes read no record; a stray read throws here instead of passing quietly.
const noDb = { collection() { throw new Error('serving a script must not read Firestore'); } } as unknown as Firestore;

function buildApp(opts: { allow?: boolean; bundlePath?: string } = {}) {
  const allow = opts.allow !== false;
  const cache = {
    async checkRateLimit() { return { allowed: allow, retryAfter: allow ? 0 : 30 }; },
    async getConnectionToken() { return null; },
  };
  const app = express();
  app.use('/v1/bootstrap', createBootstrapRouter({ db: noDb, cache, bundlePath: opts.bundlePath }));
  return app;
}

const TOKEN = 'PROV-ABCD-2345';
// F36: the /agent route now hashes the bundle to pin it in the script, so it
// needs a bundle present. A tiny fixture stands in for the built agent.js.
const BUNDLE_FIXTURE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'provian-agent-bundle-')), 'agent.js');
fs.writeFileSync(BUNDLE_FIXTURE, 'console.log("agent bundle");\n');

/** Run a served body through real `sh`, exactly as `curl … | sh` does. */
function runThroughSh(body: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('sh', [], { input: body, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('POST /v1/bootstrap/agent', () => {
  it('serves a runnable sh script for a valid token', async () => {
    const res = await request(buildApp({ bundlePath: BUNDLE_FIXTURE })).post('/v1/bootstrap/agent').send({ token: TOKEN });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toContain(`CONNECTION_TOKEN='${TOKEN}'`);
    // the SERVED body must parse as POSIX sh (this is what the user pipes to sh)
    const parse = spawnSync('sh', ['-n'], { input: res.text, encoding: 'utf8' });
    expect(parse.status).toBe(0);
  });

  it('is served no-store so a stale code is never cached', async () => {
    const res = await request(buildApp({ bundlePath: BUNDLE_FIXTURE })).post('/v1/bootstrap/agent').send({ token: TOKEN });
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('RED CONTROL: a malformed token FAILS LOUD — piped to sh it exits non-zero with a reason, never a script', async () => {
    const res = await request(buildApp({ bundlePath: BUNDLE_FIXTURE })).post('/v1/bootstrap/agent').send({ token: 'conn_bogus_1234567890' });
    expect(res.status).toBe(400);
    expect(res.text).not.toContain('exec node'); // never emits the real script
    // the body is still valid sh…
    expect(spawnSync('sh', ['-n'], { input: res.text, encoding: 'utf8' }).status).toBe(0);
    // …but running it the way `curl | sh` does FAILS (non-zero) and says why on
    // stderr — the exact regression that let a mangled/empty token read as a
    // completed onboarding (exit 0, no output).
    const run = runThroughSh(res.text);
    expect(run.status).not.toBe(0);
    expect(run.stdout).toBe(''); // nothing that could look like progress/success
    expect(run.stderr).toContain('Provian:');
    expect(run.stderr).toMatch(/Invalid or missing connection code/);
  });

  it('RED CONTROL: an EMPTY token (the real-incident case) FAILS LOUD, not exit-0-silent', async () => {
    const res = await request(buildApp({ bundlePath: BUNDLE_FIXTURE })).post('/v1/bootstrap/agent').send({ token: '' });
    expect(res.status).toBe(400);
    const run = runThroughSh(res.text);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('Provian:');
  });

  it('a missing token FAILS LOUD when piped to sh', async () => {
    const res = await request(buildApp({ bundlePath: BUNDLE_FIXTURE })).post('/v1/bootstrap/agent').send({});
    expect(res.status).toBe(400);
    const run = runThroughSh(res.text);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('Provian:');
  });

  it('rate-limited requests FAIL LOUD (a 429 must not look like success when piped to sh)', async () => {
    const res = await request(buildApp({ allow: false, bundlePath: BUNDLE_FIXTURE })).post('/v1/bootstrap/agent').send({ token: TOKEN });
    expect(res.status).toBe(429);
    expect(res.headers['content-type']).toContain('text/plain');
    const run = runThroughSh(res.text);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('Provian:');
  });

  // --- x-provian-token header + trim (mangle-resistance) ---

  it('accepts the token via the x-provian-token HEADER, no JSON body (the mangle-resistant form)', async () => {
    const res = await request(buildApp({ bundlePath: BUNDLE_FIXTURE })).post('/v1/bootstrap/agent').set('x-provian-token', TOKEN);
    expect(res.status).toBe(200);
    expect(res.text).toContain(`CONNECTION_TOKEN='${TOKEN}'`);
    expect(spawnSync('sh', ['-n'], { input: res.text, encoding: 'utf8' }).status).toBe(0);
  });

  it('the header token is TRIMMED — a stray copy/paste space no longer 400s a valid code (HTTP forbids newlines in headers, so space is the realistic case)', async () => {
    const res = await request(buildApp({ bundlePath: BUNDLE_FIXTURE })).post('/v1/bootstrap/agent').set('x-provian-token', `  ${TOKEN}  `);
    expect(res.status).toBe(200);
    expect(res.text).toContain(`CONNECTION_TOKEN='${TOKEN}'`); // baked WITHOUT the surrounding whitespace
  });

  it('the BODY token is TRIMMED too (same rescue on the legacy body path)', async () => {
    const res = await request(buildApp({ bundlePath: BUNDLE_FIXTURE })).post('/v1/bootstrap/agent').send({ token: `${TOKEN}\n` });
    expect(res.status).toBe(200);
    expect(res.text).toContain(`CONNECTION_TOKEN='${TOKEN}'`);
  });

  it('the header wins over an empty body token', async () => {
    const res = await request(buildApp({ bundlePath: BUNDLE_FIXTURE })).post('/v1/bootstrap/agent')
      .set('x-provian-token', TOKEN).send({ token: '' });
    expect(res.status).toBe(200);
    expect(res.text).toContain(`CONNECTION_TOKEN='${TOKEN}'`);
  });

  it('x-provian-platform:windows header returns the PowerShell script', async () => {
    const res = await request(buildApp({ bundlePath: BUNDLE_FIXTURE })).post('/v1/bootstrap/agent')
      .set('x-provian-token', TOKEN).set('x-provian-platform', 'windows');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('#!/bin/sh');
    expect(res.text).toContain(`$ConnectionToken = '${TOKEN}'`);
  });

  it('RED CONTROL: neither header nor body FAILS LOUD, not a script', async () => {
    const res = await request(buildApp({ bundlePath: BUNDLE_FIXTURE })).post('/v1/bootstrap/agent').send();
    expect(res.status).toBe(400);
    expect(res.text).not.toContain('exec node');
    const run = runThroughSh(res.text);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('Provian:');
  });

  it('F36: the served script pins the SHA256 of the EXACT bundle bytes it serves', async () => {
    const res = await request(buildApp({ bundlePath: BUNDLE_FIXTURE })).post('/v1/bootstrap/agent').send({ token: TOKEN });
    expect(res.status).toBe(200);
    const expected = createHash('sha256').update(fs.readFileSync(BUNDLE_FIXTURE)).digest('hex');
    expect(res.text).toContain(`BUNDLE_SHA256='${expected}'`);
    // And the bundle GET serves those exact bytes (hash matches).
    const bundleRes = await request(buildApp({ bundlePath: BUNDLE_FIXTURE })).get('/v1/bootstrap/agent.js');
    expect(createHash('sha256').update(bundleRes.text).digest('hex')).toBe(expected);
  });

  it('F36 RED CONTROL: with NO bundle, /agent fails closed (503) instead of an unverifiable script', async () => {
    const prev = process.env.BOOTSTRAP_BUNDLE_PATH;
    delete process.env.BOOTSTRAP_BUNDLE_PATH;
    const res = await request(buildApp({})).post('/v1/bootstrap/agent').send({ token: TOKEN });
    expect(res.status).toBe(503);
    expect(res.text).not.toContain('exec node');
    if (prev !== undefined) process.env.BOOTSTRAP_BUNDLE_PATH = prev;
  });
});

describe('POST /v1/bootstrap/device — same header + trim contract', () => {
  const DEVICE_TOKEN = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; // 64 hex

  it('accepts the device setup token via the x-provian-token header', async () => {
    const res = await request(buildApp()).post('/v1/bootstrap/device').set('x-provian-token', DEVICE_TOKEN);
    expect(res.status).toBe(200);
    expect(res.text).toContain(DEVICE_TOKEN);
    expect(spawnSync('sh', ['-n'], { input: res.text, encoding: 'utf8' }).status).toBe(0);
  });

  it('trims the device token, and FAILS LOUD when absent', async () => {
    const ok = await request(buildApp()).post('/v1/bootstrap/device').set('x-provian-token', `  ${DEVICE_TOKEN}  `);
    expect(ok.status).toBe(200);
    const bad = await request(buildApp()).post('/v1/bootstrap/device').send();
    expect(bad.status).toBe(400);
    const run = runThroughSh(bad.text);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('Provian:');
  });
});

describe('GET /v1/bootstrap/agent.js (the onboarding bundle)', () => {
  const tmpBundle = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'provian-bundle-')), 'agent.js');
  fs.writeFileSync(tmpBundle, 'console.log("bundle");\n');
  afterAll(() => { try { fs.rmSync(path.dirname(tmpBundle), { recursive: true, force: true }); } catch { /* ignore */ } });

  it('serves the bundle as JavaScript when the path is configured', async () => {
    const res = await request(buildApp({ bundlePath: tmpBundle })).get('/v1/bootstrap/agent.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/javascript');
    expect(res.text).toContain('console.log');
  });

  it('RED CONTROL: with NO bundle configured, fails closed 503 (never an empty/garbage file)', async () => {
    const prev = process.env.BOOTSTRAP_BUNDLE_PATH;
    delete process.env.BOOTSTRAP_BUNDLE_PATH;
    const res = await request(buildApp({})).get('/v1/bootstrap/agent.js');
    expect(res.status).toBe(503);
    expect(res.text.startsWith('#')).toBe(true); // sh-safe
    if (prev !== undefined) process.env.BOOTSTRAP_BUNDLE_PATH = prev;
  });
});

// item 9: the install line works however an agent issues the request. A
// body-less HTTP/1.1 POST with no Content-Length is refused 411 by Google Front
// End before it reaches Cloud Run, so GET is the canonical line; POST and
// HEAD keep working, inspecting never spends the code, and a GET with no code
// gets a shell-safe explanation instead of an HTML 404 piped into sh.
describe('GET / POST / HEAD /v1/bootstrap/agent — the install line however it is issued (item 9)', () => {
  it('GET with the x-provian-token header serves the runnable sh script, no-store', async () => {
    const res = await request(buildApp({ bundlePath: BUNDLE_FIXTURE })).get('/v1/bootstrap/agent').set('x-provian-token', TOKEN);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.text).toContain(`CONNECTION_TOKEN='${TOKEN}'`);
    expect(spawnSync('sh', ['-n'], { input: res.text, encoding: 'utf8' }).status).toBe(0);
  });

  it('GET with x-provian-platform:windows serves the PowerShell script', async () => {
    const res = await request(buildApp({ bundlePath: BUNDLE_FIXTURE })).get('/v1/bootstrap/agent')
      .set('x-provian-token', TOKEN).set('x-provian-platform', 'windows');
    expect(res.status).toBe(200);
    expect(res.text).toContain(`$ConnectionToken = '${TOKEN}'`);
  });

  it('HEAD answers 200 text/plain no-store with no body', async () => {
    const res = await request(buildApp({ bundlePath: BUNDLE_FIXTURE })).head('/v1/bootstrap/agent').set('x-provian-token', TOKEN);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.text ?? '').toBe('');
  });

  it('a body-less POST (header only, no content-type) is still served', async () => {
    const res = await request(buildApp({ bundlePath: BUNDLE_FIXTURE })).post('/v1/bootstrap/agent').set('x-provian-token', TOKEN);
    expect(res.status).toBe(200);
    expect(res.text).toContain(`CONNECTION_TOKEN='${TOKEN}'`);
  });

  it('inspection is free: GET, GET again and POST return the identical script, and nothing but the rate limiter is touched', async () => {
    const calls: string[] = [];
    const cache = {
      async checkRateLimit(key: string) { calls.push(key); return { allowed: true }; },
      async getConnectionToken() { calls.push('connection-token'); return null; },
    };
    const app = express();
    app.use('/v1/bootstrap', createBootstrapRouter({ db: noDb, cache, bundlePath: BUNDLE_FIXTURE }));
    const first = await request(app).get('/v1/bootstrap/agent').set('x-provian-token', TOKEN);
    const second = await request(app).get('/v1/bootstrap/agent').set('x-provian-token', TOKEN);
    const viaPost = await request(app).post('/v1/bootstrap/agent').set('x-provian-token', TOKEN);
    expect(first.status).toBe(200);
    expect(second.text).toBe(first.text);
    expect(viaPost.text).toBe(first.text);
    // The router's only dependency is the transport limiter: no code-keyed read
    // or write exists, so a look can never consume or invalidate the code.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((k) => k.startsWith('rl:bootstrap-'))).toBe(true);
    expect(calls.some((k) => k.includes(TOKEN))).toBe(false);
    // …and the same code still bootstraps after being inspected.
    const after = await request(app).get('/v1/bootstrap/agent').set('x-provian-token', TOKEN);
    expect(after.status).toBe(200);
    expect(after.text).toBe(first.text);
  });

  it('GET with NO token header FAILS LOUD with how to pass the code — a shell script, not an HTML 404', async () => {
    const res = await request(buildApp({ bundlePath: BUNDLE_FIXTURE })).get('/v1/bootstrap/agent');
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).not.toMatch(/<html|<!DOCTYPE/i);
    expect(spawnSync('sh', ['-n'], { input: res.text, encoding: 'utf8' }).status).toBe(0);
    const run = runThroughSh(res.text);
    expect(run.status).not.toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('x-provian-token');
    expect(run.stderr).toContain("curl -sSL -H 'x-provian-token: PROV-XXXX-XXXX'");
  });

  it('RED CONTROL: the code in the QUERY STRING is never read (still the no-code script)', async () => {
    const res = await request(buildApp({ bundlePath: BUNDLE_FIXTURE })).get(`/v1/bootstrap/agent?token=${TOKEN}`);
    expect(res.status).toBe(400);
    expect(res.text).not.toContain(`CONNECTION_TOKEN='${TOKEN}'`);
  });

  it('a malformed header code on GET fails loud like POST', async () => {
    const res = await request(buildApp({ bundlePath: BUNDLE_FIXTURE })).get('/v1/bootstrap/agent').set('x-provian-token', 'conn_bogus');
    expect(res.status).toBe(400);
    const run = runThroughSh(res.text);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/Invalid or missing connection code/);
  });
});

describe('GET / HEAD /v1/bootstrap/device — same GET support as /agent (item 9)', () => {
  const DEVICE_TOKEN = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; // 64 hex

  it('GET with the header serves the device script; HEAD answers 200', async () => {
    const res = await request(buildApp()).get('/v1/bootstrap/device').set('x-provian-token', DEVICE_TOKEN);
    expect(res.status).toBe(200);
    expect(res.text).toContain(DEVICE_TOKEN);
    expect(spawnSync('sh', ['-n'], { input: res.text, encoding: 'utf8' }).status).toBe(0);
    const head = await request(buildApp()).head('/v1/bootstrap/device').set('x-provian-token', DEVICE_TOKEN);
    expect(head.status).toBe(200);
  });

  it('GET with no token FAILS LOUD naming the header', async () => {
    const res = await request(buildApp()).get('/v1/bootstrap/device');
    expect(res.status).toBe(400);
    const run = runThroughSh(res.text);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('x-provian-token');
  });
});

describe('GET /v1/bootstrap/agent-device — "A device for your agent"', () => {
  const DEVICE_TOKEN = 'ab'.repeat(32);
  const bundleSha = createHash('sha256').update(fs.readFileSync(BUNDLE_FIXTURE)).digest('hex');

  it('serves the SHA-pinned bundle installer with the agent-device token in the environment', async () => {
    const res = await request(buildApp({ bundlePath: BUNDLE_FIXTURE }))
      .get('/v1/bootstrap/agent-device')
      .set('x-provian-token', DEVICE_TOKEN)
      .set('x-provian-device-name', 'Build box');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.text).toContain(`AGENT_DEVICE_TOKEN='${DEVICE_TOKEN}'`);
    expect(res.text).toContain("DEVICE_NAME='Build box'");
    expect(res.text).toContain(`BUNDLE_SHA256='${bundleSha}'`);
    expect(res.text).toContain('PROVIAN_AGENT_DEVICE_TOKEN="$AGENT_DEVICE_TOKEN"');
    expect(res.text).toContain('exec node "$BUNDLE"');
    // never the connection-code install (that would create a second wallet)
    expect(res.text).not.toContain('PROVIAN_CONNECTION_TOKEN');
    expect(spawnSync('sh', ['-n'], { input: res.text, encoding: 'utf8' }).status).toBe(0);
  });

  it('RED CONTROL: a hostile device-name header is stripped to inert characters', async () => {
    const res = await request(buildApp({ bundlePath: BUNDLE_FIXTURE }))
      .get('/v1/bootstrap/agent-device')
      .set('x-provian-token', DEVICE_TOKEN)
      .set('x-provian-device-name', "x'; rm -rf ~; echo '$(id)`id`");
    expect(res.status).toBe(200);
    const line = res.text.split('\n').find((l) => l.startsWith('DEVICE_NAME='));
    expect(line).toBe("DEVICE_NAME='x rm -rf  echo (id)id'");
    // nothing that can close the quote or expand inside it survives
    expect(line!.slice("DEVICE_NAME='".length, -1)).not.toMatch(/['$`;\\]/);
    expect(spawnSync('sh', ['-n'], { input: res.text, encoding: 'utf8' }).status).toBe(0);
  });

  it('RED CONTROL: a connection code (or any non-64-hex token) FAILS LOUD, never a script', async () => {
    for (const bad of ['PROV-ABCD-2345', 'AB'.repeat(32), 'ab'.repeat(31)]) {
      const res = await request(buildApp({ bundlePath: BUNDLE_FIXTURE }))
        .get('/v1/bootstrap/agent-device').set('x-provian-token', bad);
      expect(res.status).toBe(400);
      expect(res.text).not.toContain('exec node');
      const run = runThroughSh(res.text);
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain('A device for your agent');
    }
  });

  it('F36 RED CONTROL: with no bundle it fails closed (503), never an unverifiable script', async () => {
    const res = await request(buildApp()).get('/v1/bootstrap/agent-device').set('x-provian-token', DEVICE_TOKEN);
    expect(res.status).toBe(503);
    expect(res.text).not.toContain('exec node');
  });

  it('x-provian-platform:windows returns the PowerShell installer', async () => {
    const res = await request(buildApp({ bundlePath: BUNDLE_FIXTURE }))
      .get('/v1/bootstrap/agent-device')
      .set('x-provian-token', DEVICE_TOKEN)
      .set('x-provian-platform', 'windows');
    expect(res.status).toBe(200);
    expect(res.text).toContain(`$AgentDeviceToken = '${DEVICE_TOKEN}'`);
    expect(res.text).toContain('$env:PROVIAN_AGENT_DEVICE_TOKEN = $AgentDeviceToken');
  });
});
