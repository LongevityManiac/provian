#!/usr/bin/env node
/**
 * the RED control for the pre-launch-gate assertions in launch-smoke.mjs.
 *
 * WHY THIS FILE EXISTS. A pre-flip funnel check that asserts a 404 is the single
 * easiest check in this repo to ship broken: it passes against a relay that is
 * down, a DNS failure, a deleted route, a typo in the URL, and an over-broad gate
 * all of which are 404-shaped nothings. Running the suite once against a healthy
 * production relay and seeing green proves none of that.
 *
 * SCOPE. This harness validates the checks that still assert the 404
 * PRE-LAUNCH GATE pre-flip — currently `agents-directory-public` (and, separately,
 * pvt-estimate) — plus, run `--post-flip`, the `agents-directory-filtered` probe's
 * filter-applied assertion (a stub that drops the filter must turn it RED). It does NOT cover `wallet-create-pop` OPENED that rail,
 * so its launch-smoke check drives the LIVE open signup contract in both modes
 * rather than asserting the gate 404. (The former `path-e-connect` check was
 * deleted with `/v1/relay/agent/connect`,.) A static "healthy gate" stub
 * cannot stand in for a full PoP signup + genesis-manifest read, so that check
 * is validated by the live suite run, not by a red-control stub here. (Before
 * this scoping it and the connect check sat in GATED_CHECKS with a
 * stub that 404-closed them, which made the POSITIVE control go RED against its own
 * fixture — the checks correctly flagged the stub's closed rail as a
 * regression.)
 *
 * So each control below stands up a LOCAL stub relay that is wrong in exactly one
 * way, points launch-smoke at it, and requires the suite to go RED with the right
 * reason. A control that fails to go red is itself reported as a failure — the
 * "guard that cannot fail" this codebase keeps producing.
 *
 * node scripts/launch-smoke/gate-control.mjs
 *
 * Exits 0 only if EVERY control went red for the expected reason. Reads/writes
 * nothing outside this process; never touches production.
 */

import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const SUITE = join(HERE, 'launch-smoke.mjs');

const GATED_CHECKS = 'agents-directory-public';

/**
 * Stub relay. `shape` decides the ONE thing that is wrong.
 * healthy — behaves like the real gated relay: everything the control
 * needs is right. Used for the POSITIVE case, so a control
 * that reds unconditionally is caught.
 * relay-down — every route 404s with the gate body, INCLUDING /health.
 * gate-universal — gate body + /health ok, but the ungated sibling also 404s.
 * foreign-404 — a 404 whose body is NOT the gate's (route simply missing).
 * estimate-open — /v1/pvt/estimate answers 200 while PUBLIC_LAUNCH is
 * closed (its launch gate is not gating it).
 * dir-honors — POST-FLIP: /v1/agents/directory applies availability +
 * capability (the filters the relay honors since).
 * dir-ignores — POST-FLIP: the filtered read answers 200 but returns every
 * row, filter dropped (the min_governance_score failure mode).
 * dir-empty — POST-FLIP: the filtered read returns zero rows although the
 * bare directory lists an available agent with the capability.
 */
function stub(shape) {
  const GATE = JSON.stringify({ error: 'not found' });
  return createServer((req, res) => {
    const path = req.url.split('?')[0];
    const send = (code, body, json = true) => {
      res.writeHead(code, { 'Content-Type': json ? 'application/json' : 'text/plain' });
      res.end(body);
    };

    if (path === '/health') {
      if (shape === 'relay-down') return send(404, GATE);
      return send(200, JSON.stringify({ status: 'ok' }));
    }
    if (path === '/v1/meter/batch') {
      if (shape === 'gate-universal') return send(404, GATE);
      return send(401, JSON.stringify({ error: 'unauthorized' }));
    }
    if (path === '/v1/pvt/estimate') {
      if (shape === 'estimate-open') return send(200, JSON.stringify({ estimated_pvt: 1.5, disclaimers: ['x'] }));
      if (shape === 'estimate-503') {
        return send(503, JSON.stringify({ error: 'PVT9_DEPENDENCY_UNAVAILABLE', code: 'PVT9_DEPENDENCY_UNAVAILABLE' }));
      }
      // Correctly gated pre-flip: the launch gate's own refusal body.
      return send(404, GATE);
    }
    if (path === '/v1/agents/directory' && shape.startsWith('dir-')) {
      const q = new URL(req.url, 'http://stub').searchParams;
      const all = DIRECTORY_ROWS;
      let rows = all;
      if (q.has('availability') || q.has('capability')) {
        if (shape === 'dir-empty') rows = [];
        else if (shape === 'dir-honors') {
          rows = all.filter((a) => (!q.has('availability') || a.availability === q.get('availability'))
            && (!q.has('capability') || a.capabilities.includes(q.get('capability'))));
        }
      }
      return send(200, JSON.stringify({ agents: rows, count: rows.length }));
    }
    // Everything else is a "closed" surface.
    if (shape === 'foreign-404') return send(404, JSON.stringify({ error: 'Cannot GET' }));
    return send(404, GATE);
  });
}

/** Two directory rows: one the filter must keep, one it must drop. */
const DIRECTORY_ROWS = [
  { wallet_id: 'wallet_aw_keep', availability: 'available', capabilities: ['code_review'] },
  { wallet_id: 'wallet_aw_drop', availability: 'busy', capabilities: ['translation'] },
];

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function runSuite(port, only, mode = 'pre-flip') {
  try {
    const { stdout } = await execFileP('node', [SUITE, `--${mode}`, '--only', only], {
      env: { ...process.env, PROVIAN_API_BASE: `http://127.0.0.1:${port}` },
      timeout: 120_000,
    });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.code ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

const CONTROLS = [
  {
    name: 'POSITIVE — a correctly-gated relay passes',
    shape: 'healthy',
    only: `${GATED_CHECKS},pvt-estimate`,
    expectRed: false,
  },
  {
    name: 'RED — relay is DOWN (/health does not answer); a bare 404 assertion would pass here',
    shape: 'relay-down',
    only: GATED_CHECKS,
    expectRed: true,
    expect: /the 404 proves NOTHING — \/health/,
  },
  {
    name: 'RED — the gate closes EVERYTHING, including surfaces it must not',
    shape: 'gate-universal',
    only: GATED_CHECKS,
    expectRed: true,
    expect: /the UNGATED control \/v1\/meter\/batch/,
  },
  {
    name: 'RED — a 404 from a MISSING route, not from the gate (body mismatch)',
    shape: 'foreign-404',
    only: GATED_CHECKS,
    expectRed: true,
    expect: /the body is not the gate's/,
  },
  {
    name: 'RED — /v1/pvt/estimate answers 200 with PUBLIC_LAUNCH closed (gate not gating)',
    shape: 'estimate-open',
    only: 'pvt-estimate',
    expectRed: true,
    expect: /answers 200 with PUBLIC_LAUNCH closed/,
  },
  {
    // PRE-FLIP a 503 is a WARN, not a failure: the suite runs against the live
    // relay before the runbook's deploy step, so a revision without the mount is
    // expected rather than broken. The control asserts the suite still exits 0
    // AND still says the specific true thing. (The post-flip FAIL direction is
    // not reachable from this harness, which only runs `--pre-flip`.)
    name: 'WARN not RED — /v1/pvt/estimate 503 pre-flip means "not deployed yet"',
    shape: 'estimate-503',
    only: 'pvt-estimate',
    expectRed: false,
    expect: /no mount on the deployed revision/,
  },
  // POST-FLIP — the filtered directory probe (residual: it used to send
  // `min_governance_score`, a filter the relay ignores since, so it could not
  // tell a dropped filter from an applied one).
  {
    name: 'POSITIVE (post-flip) — a directory that applies availability + capability passes',
    shape: 'dir-honors',
    only: 'agents-directory-filtered',
    mode: 'post-flip',
    expectRed: false,
    expect: /1 row\(s\) all match availability=available&capability=code_review/,
  },
  {
    name: 'RED (post-flip) — the filtered read answers 200 but ignores the filter',
    shape: 'dir-ignores',
    only: 'agents-directory-filtered',
    mode: 'post-flip',
    expectRed: true,
    expect: /filter was not applied/,
  },
  {
    name: 'RED (post-flip) — the filtered read is empty though a matching agent is listed',
    shape: 'dir-empty',
    only: 'agents-directory-filtered',
    mode: 'post-flip',
    expectRed: true,
    expect: /returned no rows/,
  },
];

async function main() {
  let failures = 0;
  for (const c of CONTROLS) {
    const server = stub(c.shape);
    const port = await listen(server);
    const { code, out } = await runSuite(port, c.only, c.mode);
    server.close();

    const wentRed = code !== 0;
    let ok = wentRed === c.expectRed;
    let why = ok ? '' : c.expectRed ? 'expected RED, got green' : 'expected green, went RED';
    if (ok && c.expect && !c.expect.test(out)) {
      ok = false;
      why = `went red for the WRONG reason (expected ${c.expect})`;
    }
    if (ok) {
      console.log(`  ok    ${c.name}`);
    } else {
      failures++;
      console.log(`  FAIL  ${c.name}\n          ${why}\n${out.split('\n').map((l) => `          ${l}`).join('\n')}`);
    }
  }
  console.log(`\n[gate-control] ${CONTROLS.length} controls, ${failures} failures`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error('[gate-control] fatal:', e);
  process.exit(1);
});
