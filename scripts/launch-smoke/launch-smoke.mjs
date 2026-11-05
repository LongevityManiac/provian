/**
 * Provian launch smoke suite (settlement kernel — the flip gate).
 *
 * Curated (not auto-parsed) checks proving the documented agent funnel works
 * against production. Two modes:
 *
 * pre-flip (default while scripts/launch-smoke/MODE says "pre-flip"):
 * discovery surfaces must be GATED (404/401), packages expectedly
 * unpublished, and the agent funnel must be CLOSED BY THE GATE — see
 * below. pe/submit auth must still be enforced.
 * post-flip (--post-flip, or flip the MODE file at launch):
 * everything PUBLIC_LAUNCH gates must be OPEN and functional: packages
 * installable, discovery 200, llms.txt + every URL it lists, remote MCP
 * initialize + an unauthenticated tools/call, the agent funnel live.
 *
 * The pre-launch surface gate closes discovery while the wallet-create rail
 * remains available. The agent-session route is absent. Post-flip expectations
 * require the discovery and estimator mounts to be reachable; an estimator
 * dependency failure remains distinct from its own launch gate.
 */

import { execFile } from 'node:child_process';
import { generateKeyPairSync, createSign, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

const API = process.env.PROVIAN_API_BASE || 'https://api.provian.ai';
const SITE = process.env.PROVIAN_SITE_BASE || 'https://provian.ai';
const FETCH_TIMEOUT_MS = 20_000;

// Packages this launch publishes; unpublished pre-flip is expected, not a doc bug.
const PENDING_PUBLISH_NPM = ['@provian/agent-sdk', '@provian/cli', '@provian/mcp', '@provian/commons'];
const PENDING_PUBLISH_PYPI = ['provian-sdk'];

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

function resolveMode(argv) {
  if (argv.includes('--post-flip')) return 'post-flip';
  if (argv.includes('--pre-flip')) return 'pre-flip';
  try {
    const raw = readFileSync(join(HERE, 'MODE'), 'utf8').trim();
    if (raw === 'pre-flip' || raw === 'post-flip') return raw;
    console.error(`[launch-smoke] MODE file contains "${raw}" — expected pre-flip or post-flip`);
    process.exit(2);
  } catch {
    return 'pre-flip';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function http(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { redirect: 'manual', ...init, signal: controller.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body is fine */ }
    return { status: res.status, text, json, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

function pass(detail) { return { status: 'pass', detail }; }
function fail(detail) { return { status: 'fail', detail }; }
function warn(detail) { return { status: 'warn', detail }; }
function skip(detail) { return { status: 'skip', detail }; }

/**
 * Judge a filtered `/v1/agents/directory` answer against the filters sent. Pure, so
 * `gate-control.mjs` can drive it RED through a stub relay that ignores the filter.
 * A relay that DROPS a filter still answers 200 {agents:[…]}; only checking each row
 * against the filter (and requiring a match when one is known to exist) tells the two apart.
 */
function judgeFilteredDirectory(agents, { availability, capability, expectMatch }) {
  const offending = agents.filter((a) => a?.availability !== availability
    || !Array.isArray(a?.capabilities) || !a.capabilities.includes(capability));
  if (offending.length > 0) {
    const a = offending[0];
    return fail(`filtered directory: filter was not applied — ${offending.length}/${agents.length} rows break availability=${availability}&capability=${capability} (e.g. ${a?.wallet_id ?? '?'} availability=${a?.availability} capabilities=${JSON.stringify(a?.capabilities ?? null)})`);
  }
  if (expectMatch && agents.length === 0) {
    return fail(`filtered directory returned no rows for availability=${availability}&capability=${capability}, though the bare directory lists an available agent with it`);
  }
  return pass(`filtered directory 200, ${agents.length} row(s) all match availability=${availability}&capability=${capability} (composite index served)`);
}

// ---------------------------------------------------------------------------
// The pre-launch surface gate, and the control that stops a 404 assertion from
// passing over nothing.
// ---------------------------------------------------------------------------

/**
 * The M10 gate's ONE refusal body, byte for byte:
 *   res.status(404).json({ error: 'not found' })
 * (provian-backend/src/routes/middleware/pre-launch-surface-gate.ts). Matching
 * the body — not just the status — is what distinguishes "the gate closed this"
 * from "this route does not exist".
 */
const GATE_REFUSAL = { error: 'not found' };

/**
 * Assert a surface is closed BY THE GATE, with a control that can detect absence.
 *
 * A bare `status === 404` assertion is the textbook vacuous check: it passes
 * identically against a relay that is down, a DNS failure, a deleted route, an
 * over-broad catch-all, or a typo in the URL under test. Every one of those is
 * also a 404-shaped nothing, and a suite that reports green through an outage is
 * worse than no suite.
 *
 * So a gated assertion has to show three things, not one:
 *   1. the status is 404 AND the body is EXACTLY the gate's `{"error":"not found"}`;
 *   2. the relay is UP           — `/health` still answers 200 {"status":"ok"};
 *   3. the gate is not universal — an ungated sibling still answers on its own
 *      terms (`/v1/meter/batch` with garbage device credentials → 401, never 404).
 * Control 3 is the one that catches an over-broad prefix list: if a future edit
 * closed everything, (1) and (2) would both still pass.
 */
async function assertClosedByPreLaunchGate(label, res) {
  if (res.status !== 404) {
    return fail(`${label}: expected the pre-launch gate's 404, got ${res.status} ${res.text.slice(0, 120)}`);
  }
  const keys = res.json && typeof res.json === 'object' ? Object.keys(res.json) : [];
  if (res.json?.error !== GATE_REFUSAL.error || keys.length !== 1) {
    return fail(
      `${label}: 404 but the body is not the gate's {"error":"not found"} — got ${res.text.slice(0, 120)}. ` +
        'A 404 from something other than the gate means the route is missing, not gated.',
    );
  }
  const health = await http(`${API}/health`);
  if (health.status !== 200 || health.json?.status !== 'ok') {
    return fail(
      `${label}: the 404 proves NOTHING — /health -> ${health.status}, so the relay may simply be down. ` +
        'Refusing to report a gated pass over an unreachable relay.',
    );
  }
  const ungated = await http(`${API}/v1/meter/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'DeviceKey pdk_deadbeef:pds_deadbeef' },
    body: JSON.stringify({ acts: [] }),
  });
  if (ungated.status !== 401) {
    return fail(
      `${label}: the 404 proves NOTHING — the UNGATED control /v1/meter/batch -> ${ungated.status}, expected 401. ` +
        'Either the gate now closes surfaces it should not, or the relay is answering everything the same way.',
    );
  }
  return pass(
    `${label}: closed by the pre-launch surface gate (404 {"error":"not found"}); controls green ` +
      '(/health 200, ungated /v1/meter/batch 401) so the relay is up and the gate is not universal',
  );
}

async function npmView(pkg) {
  try {
    const { stdout } = await execFileP('npm', ['view', pkg, 'version', '--json'], { timeout: 30_000 });
    return { published: true, version: stdout.trim().replace(/"/g, '') };
  } catch (e) {
    const msg = `${e.stdout || ''}${e.stderr || ''}`;
    if (/404|E404|not found/i.test(msg)) return { published: false };
    throw new Error(`npm view ${pkg} errored (not a clean 404): ${msg.slice(0, 200)}`);
  }
}

async function pypiIndex(pkg) {
  // Prefer `pip index versions` per the runbook; fall back to the PyPI JSON
  // API when pip is unavailable (CI runners without python).
  try {
    const { stdout } = await execFileP(
      'python3', ['-m', 'pip', 'index', 'versions', pkg, '--disable-pip-version-check'],
      { timeout: 30_000 },
    );
    return { published: true, detail: stdout.trim().split('\n')[0] };
  } catch (e) {
    const msg = `${e.stdout || ''}${e.stderr || ''}`;
    if (/No matching distribution|not found/i.test(msg)) return { published: false };
    // pip missing or other error — fall back to PyPI JSON API.
    const res = await http(`https://pypi.org/pypi/${pkg}/json`);
    if (res.status === 200 && res.json?.info?.version) {
      return { published: true, detail: `pypi.org: ${res.json.info.version}` };
    }
    if (res.status === 404) return { published: false };
    throw new Error(`PyPI lookup for ${pkg} inconclusive: HTTP ${res.status}`);
  }
}

function packageCheck(kind, pkg, lookup) {
  return async (mode) => {
    const r = await lookup(pkg);
    if (mode === 'post-flip') {
      return r.published
        ? pass(`${pkg} published (${r.version || r.detail || 'ok'})`)
        : fail(`${pkg} NOT installable from the public ${kind} registry — publish before flip`);
    }
    return r.published
      ? warn(`${pkg} is ALREADY published (${r.version || r.detail || ''}) — expected unpublished pre-flip; flip sequence may have started`)
      : pass(`${pkg} unpublished, as expected pre-flip`);
  };
}

// ---------------------------------------------------------------------------
// Wallet-create PoP crypto (mirrors provian-agent-sdk/src/wallet.ts — the
// challenge is signed as ECDSA-secp256k1 over SHA-256 of the ASCII challenge
// string, DER signature hex-encoded; NOT EIP-191)
// ---------------------------------------------------------------------------

function generateAgentKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const privKeyDer = privateKey.export({ type: 'sec1', format: 'der' });
  const privKeyHex = privKeyDer.subarray(7, 7 + 32).toString('hex');
  const pubKeyDer = publicKey.export({ type: 'spki', format: 'der' });
  const pubKeyHex = pubKeyDer.subarray(pubKeyDer.length - 65).subarray(1).toString('hex');
  return { privateKey, privKeyHex, pubKeyHex };
}

function signChallenge(privateKeyObj, challenge) {
  const signer = createSign('SHA256');
  signer.update(challenge);
  return signer.sign(privateKeyObj, 'hex');
}

// ---------------------------------------------------------------------------
// Checks. Each: (mode) => {status, detail}. Order is the report order.
// ---------------------------------------------------------------------------

const CHECKS = {
  'api-health': async () => {
    const r = await http(`${API}/health`);
    return r.status === 200 && r.json?.status === 'ok'
      ? pass('GET /health 200 {"status":"ok"}')
      : fail(`GET /health -> ${r.status} ${r.text.slice(0, 120)}`);
  },

  'npm-agent-sdk': packageCheck('npm', '@provian/agent-sdk', npmView),
  'npm-cli': packageCheck('npm', '@provian/cli', npmView),
  'npm-mcp': packageCheck('npm', '@provian/mcp', npmView),
  'npm-commons': packageCheck('npm', '@provian/commons', npmView),
  'pypi-provian-sdk': packageCheck('PyPI', 'provian-sdk', pypiIndex),

  'discovery-openapi': async (mode) => {
    const r = await http(`${API}/v1/openapi.json`);
    if (mode === 'post-flip') {
      return r.status === 200 && r.json?.openapi
        ? pass(`200, OpenAPI ${r.json.openapi}, ${Object.keys(r.json.paths || {}).length} paths`)
        : fail(`expected open OpenAPI spec, got ${r.status} ${r.text.slice(0, 120)}`);
    }
    return r.status === 404
      ? pass('gated 404, as expected pre-flip')
      : fail(`expected gated 404 pre-flip, got ${r.status} — PUBLIC_LAUNCH may be flipped early`);
  },

  'discovery-mcp-descriptor': async (mode) => {
    const r = await http(`${API}/.well-known/mcp.json`);
    if (mode === 'post-flip') {
      return r.status === 200 && r.json?.name === 'provian' && Array.isArray(r.json?.tools)
        ? pass(`200, descriptor "provian" with ${r.json.tools.length} tools`)
        : fail(`expected MCP descriptor, got ${r.status} ${r.text.slice(0, 120)}`);
    }
    // PRE-FLIP, TWO VALID STATES (corrected 2026-08-23). The MCP door is
    // deliberately OPEN pre-flip when `MCP_AGENT_ONBOARDING=true` (
    // DIST-MCP-DOOR) so a discovering agent can read the descriptor before the
    // flip — and `llms.txt`'s "bootstrap tools need no auth" only HOLDS while it
    // is open. This check used to hard-expect 404 and therefore FAILED on the
    // intended state. It now accepts the closed door (404) or the open one, but
    // an open door must serve a STRUCTURALLY VALID descriptor: a 200 carrying
    // anything else, or any other status, still fails.
    if (r.status === 404) return pass('gated 404 — MCP door closed');
    if (r.status === 200 && r.json?.name === 'provian' && Array.isArray(r.json?.tools)) {
      return pass(`open MCP door : descriptor "provian" with ${r.json.tools.length} tools`);
    }
    return fail(`expected a gated 404 or a valid open-door descriptor, got ${r.status} ${r.text.slice(0, 120)}`);
  },

  'discovery-ecosystem': async (mode) => {
    const r = await http(`${API}/v1/ecosystem`);
    if (mode === 'post-flip') {
      if (r.status !== 200 || typeof r.json?.name !== 'string') {
        return fail(`expected ecosystem JSON, got ${r.status} ${r.text.slice(0, 120)}`);
      }
      // Semantic, not just 200+JSON: the genesis posture must be the LIVE armed truth
      // (campaign manifest), not the runtime boundary config's fail-closed false/null.
      const g = r.json?.pvt9;
      if (g?.genesis_armed !== true) {
        return fail(`ecosystem pvt9.genesis_armed=${JSON.stringify(g?.genesis_armed)}, expected true (armed manifest, not runtime boundary config)`);
      }
      if (!g?.genesis_window
        || typeof g.genesis_window.start_ms !== 'number'
        || typeof g.genesis_window.end_ms !== 'number'
        || g.genesis_window.end_ms <= g.genesis_window.start_ms) {
        return fail(`ecosystem pvt9.genesis_window missing/invalid: ${JSON.stringify(g?.genesis_window)}`);
      }
      return pass(`200, "${r.json.name}", genesis_armed=true window ${g.genesis_window.start_ms}..${g.genesis_window.end_ms}`);
    }
    return r.status === 404
      ? pass('gated 404, as expected pre-flip')
      : fail(`expected gated 404 pre-flip, got ${r.status}`);
  },

  'website-llms-txt': async (mode) => {
    const r = await http(`${SITE}/llms.txt`);
    if (mode === 'pre-flip') {
      return r.status === 401
        ? pass('401 Basic Auth wall up, as expected pre-flip')
        : fail(`expected 401 pre-flip, got ${r.status} — website auth wall may be down early`);
    }
    if (r.status !== 200 || !r.text.trim()) {
      return fail(`expected 200 llms.txt post-flip, got ${r.status}`);
    }
    // institution parameters acceptance: every URL listed in llms.txt must resolve — EXCEPT two
    // that llms.txt legitimately advertises but that are non-200 BY DESIGN, so
    // a hard 200 requirement would false-fail a healthy launch (and command a
    // needless FLIP_RUNBOOK §6.1 rollback):
    //   - the bare API host has no root route            → GET 404
    //   - the remote MCP endpoint is POST-only (JSON-RPC) → GET 405
    // Keys are the exact strings the URL regex extracts (trailing slash tolerated).
    const BY_DESIGN = {
      'https://api.provian.ai': 404,
      'https://api.provian.ai/mcp': 405,
    };
    const urls = [...r.text.matchAll(/https?:\/\/[^\s)\]>"']+/g)].map((m) => m[0]);
    const failures = [];
    let byDesign = 0;
    for (const u of urls) {
      const res = await http(u).catch((e) => ({ status: `ERR ${e.message}` }));
      const expected = BY_DESIGN[u.replace(/\/$/, '')];
      if (res.status === 200) continue;
      if (expected !== undefined && res.status === expected) { byDesign += 1; continue; }
      failures.push(`${u} -> ${res.status}`);
    }
    return failures.length === 0
      ? pass(`200, ${urls.length} linked URLs all resolve (${byDesign} by-design non-200 allowed)`)
      : fail(`llms.txt 200 but ${failures.length}/${urls.length} linked URLs broken: ${failures.slice(0, 5).join('; ')}`);
  },

  'mcp-remote-endpoint': async (mode) => {
    const initBody = {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'provian-launch-smoke', version: '1.0.0' } },
    };
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    const r = await http(`${API}/mcp`, { method: 'POST', headers, body: JSON.stringify(initBody) });
    // PRE-FLIP (corrected 2026-08-23): a 404 means the door is closed, which is
    // fine. Anything else is NOT "deployed early" — with `MCP_AGENT_ONBOARDING=true`
    // the open door is the intended state, so instead of warning vaguely we
    // fall THROUGH to the same full validation post-flip uses. That turns this into
    // the real DIST-MCP-DOOR gate: an unauthenticated initialize + tools/call
    // round-trip from outside. A malformed or erroring open door now FAILS.
    if (mode === 'pre-flip' && r.status === 404) {
      return pass('no remote MCP endpoint pre-flip (404) — MCP door closed');
    }
    const parse = (res) => {
      if (res.json) return res.json;
      const m = res.text.match(/^data:\s*(\{.*\})\s*$/m); // streamable-HTTP SSE frame
      return m ? JSON.parse(m[1]) : null;
    };
    const init = parse(r);
    if (r.status !== 200 || !init?.result?.serverInfo) {
      return fail(`MCP initialize failed: ${r.status} ${r.text.slice(0, 160)}`);
    }
    const session = r.headers.get('mcp-session-id');
    const callHeaders = session ? { ...headers, 'Mcp-Session-Id': session } : headers;
    const call = await http(`${API}/mcp`, {
      method: 'POST', headers: callHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'get_pvt_estimate', arguments: { action_type: 'agent_tool_orchestration', attestation_tier: 'software' } },
      }),
    });
    const callResult = parse(call);
    if (call.status !== 200 || !callResult?.result) {
      return fail(`MCP tools/call get_pvt_estimate failed: ${call.status} ${call.text.slice(0, 160)}`);
    }
    //, SAME FACT AS `pvt-estimate` ONE LAYER UP. The `get_pvt_estimate`
    // tool is a proxy for GET /v1/pvt/estimate (mcp/core/tools.ts), so while the
    // runtime boundary runtime boundary blocks that route the tool returns isError with the
    // relay's own 503. What THIS check exists to prove is that the remote MCP
    // transport carries an UNAUTHENTICATED tools/call end to end — and a
    // well-formed error result proves exactly that. So the boundary's 503 is
    // accepted by name and nothing else is: any other isError still fails.
    // EXTENDED 2026-08-23. Same reasoning as the 503 above, one state wider.
    // Since deployed, `/v1/pvt/estimate` pre-flip is closed by its OWN
    // `PUBLIC_LAUNCH` gate and answers 404 with a prose message carrying no
    // status or error code — so the 503-only accept-list rejected the intended
    // pre-flip state and failed a healthy open door. Both by-design closures are
    // now accepted BY NAME and nothing else is: any other isError still fails.
    const body = JSON.stringify(callResult.result);
    const blockedByBoundary = /HTTP 503/.test(body) && /PVT9_(DEPENDENCY_UNAVAILABLE|UNCONFIGURED)/.test(body);
    const closedByLaunchGate = /\/v1\/pvt\/estimate/.test(body) && /not live on this relay yet/.test(body);
    const unavailableByDesign = blockedByBoundary || closedByLaunchGate;
    if (callResult.result.isError && !unavailableByDesign) {
      return fail(`MCP tools/call get_pvt_estimate returned an unexpected error: ${body.slice(0, 200)}`);
    }
    return pass(
      `initialize -> ${init.result.serverInfo.name}; unauthenticated tools/call round-tripped`
        + (blockedByBoundary ? ' (get_pvt_estimate reports the runtime boundary boundary 503, as expected)' : '')
        + (closedByLaunchGate ? ' (get_pvt_estimate closed by its own PUBLIC_LAUNCH gate, as expected pre-flip)' : ''),
    );
  },

  // The estimator has its own launch gate: 404 before the flip, 200 after it.
  // A dependency 503 is distinct from a closed launch gate. Statistics,
  // tokenomics and mint-history remain outside this mounted read surface.
  'pvt-estimate': async (mode) => {
    const r = await http(`${API}/v1/pvt/estimate?action_type=agent_tool_orchestration&attestation_tier=software`);
    const code = r.json?.code;
    if (r.status === 503) {
      // PRE-FLIP THIS IS A WARN, NOT A FAIL, and the distinction is the whole
      // point. This suite runs read-only against the LIVE relay, and runbook
      // Step 2.1 runs it BEFORE Step 4.1 deploys. A relay whose image predates
      // has no mount, so the runtime boundary boundary still answers 503 — nothing is
      // broken, the code simply is not deployed yet. Failing here would fail the
      // runbook at its own check, which is the exact defect in reverse.
      // POST-flip the deploy has happened, so 503 is a real failure.
      const detail = `503 ${code ?? '(no code)'} — no mount on the deployed revision. Either this `
        + 'relay predates (expected before runbook Step 4.1 deploys) or the mount '
        + '(`mountPvtPublicReads`) / boundary widening was lost.';
      return mode === 'post-flip' ? fail(detail) : warn(detail);
    }
    if (mode === 'post-flip') {
      if (r.status === 200 && typeof r.json?.estimated_pvt === 'number') {
        return pass(`200 estimated_pvt=${r.json.estimated_pvt} — the launch gate is open and the estimator answers`);
      }
      return fail(`expected 200 {estimated_pvt}, got ${r.status} ${r.text.slice(0, 160)}`);
    }
    if (r.status === 404 && r.json?.error === 'not found') {
      return pass("404 {error:'not found'} — closed by its own PUBLIC_LAUNCH gate, which the flip opens");
    }
    if (r.status === 200) {
      return fail('/v1/pvt/estimate answers 200 with PUBLIC_LAUNCH closed — the launch gate is not gating it.');
    }
    return fail(`expected 404 from the launch gate pre-flip, got ${r.status} ${r.text.slice(0, 160)}`);
  },

  // /. The agent-credential door. `/v1/agent/wallet` was a CLOSED
  // prefix pre-flip; OPENED the invite→signup rail (it works with
  // PUBLIC_LAUNCH still false — "live, not shown"), so this runs the REAL,
  // full PoP signup end-to-end in BOTH modes — the exact path an agent (Atlas)
  // uses. Contract (, agent-wallet.ts): register→challenge→create is keyed
  // by a caller-generated `registration_id` that is durably retained and reused
  // across challenge + create; challenge also needs `agent_id`; create pins
  // `constitution_accepted_at`. platform:'test' keeps the wallet out of public
  // stats and proves no external address, so it never touches the Genesis pool.
  'wallet-create-pop': async () => {
    const kp = generateAgentKeyPair();
    const agentId = `launch-smoke-${Date.now()}-${randomBytes(3).toString('hex')}`;
    // Caller-generated, durably-retained registration id (16–128 canonical chars,
    // /^[A-Za-z0-9][A-Za-z0-9_.:@-]{15,127}$/); the SAME value goes to challenge + create.
    const registrationId = `launch-smoke-reg-${Date.now()}-${randomBytes(6).toString('hex')}`;
    const ch = await http(
      `${API}/v1/agent/wallet/challenge?public_key=${encodeURIComponent(kp.pubKeyHex)}`
        + `&registration_id=${encodeURIComponent(registrationId)}&agent_id=${encodeURIComponent(agentId)}`,
    );
    if (ch.status === 404 && ch.json?.error === GATE_REFUSAL.error) {
      return fail('challenge -> the pre-launch gate 404: the signup rail is CLOSED, but opened it — a gate regression.');
    }
    if (ch.status !== 200 || !ch.json?.challenge_id || !ch.json?.challenge) {
      return fail(`challenge failed: ${ch.status} ${ch.text.slice(0, 160)}`);
    }
    const create = await http(`${API}/v1/agent/wallet/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        registration_id: registrationId,
        agent_name: 'Provian Launch Smoke',
        agent_id: agentId,
        platform: 'test',
        constitution_accepted_at: new Date().toISOString(),
        public_key: kp.pubKeyHex,
        challenge_id: ch.json.challenge_id,
        signature: signChallenge(kp.privateKey, ch.json.challenge),
      }),
    });
    if (create.status !== 201) {
      return fail(`create failed: ${create.status} ${create.text.slice(0, 200)}`);
    }
    const w = create.json;
    if (!w?.wallet_id?.startsWith('wallet_aw_') || !w?.api_key?.startsWith('pvn_live_') || !w?.api_secret?.startsWith('pvns_')) {
      return fail(`create 201 but response shape off: ${JSON.stringify(Object.keys(w || {}))}`);
    }
    if (!w.welcome?.genesis?.track_progress) {
      return fail('create 201 but welcome.genesis.track_progress missing — onboarding pointer to genesis status broken');
    }
    // Genesis status must tell the newborn agent where it stands.
    const st = await http(`${API}/v1/agent/genesis/status/${w.wallet_id}`, {
      headers: { Authorization: `Bearer ${w.api_key}:${w.api_secret}` },
    });
    if (st.status !== 200) {
      return fail(`wallet created (${w.wallet_id}) but genesis status -> ${st.status} ${st.text.slice(0, 160)}`);
    }
    const s = st.json;
    // The v3 legacy-record projection: genesis_pvt_earned_record + a pvt9 posture block
    // sourced from the campaign manifest + activation doc (NOT the retired campaign.* shape).
    const shapeOk = s && s.wallet_id === w.wallet_id
      && typeof s.genesis_pvt_earned_record === 'number'
      && s.pvt9 && typeof s.pvt9.genesis_armed === 'boolean'
      && typeof s.pvt9.genesis_window_approved === 'boolean'
      && typeof s.pvt9.genesis_grants_live === 'boolean';
    if (!shapeOk) return fail(`genesis status shape off: ${st.text.slice(0, 200)}`);
    if (s.genesis_pvt_earned_record !== 0) return fail(`fresh wallet reports genesis_pvt_earned_record=${s.genesis_pvt_earned_record}, expected 0`);
    if (s.pvt9.genesis_armed !== true) return fail(`genesis status reports genesis_armed=${s.pvt9.genesis_armed}, expected true (armed manifest)`);
    return pass(`PoP register→challenge→create OK (${w.wallet_id}, platform:test) + genesis status reads back (armed=${s.pvt9.genesis_armed}, grants_live=${s.pvt9.genesis_grants_live})`);
  },

  'meter-batch-device': async () => {
    // The device's one recording route since the relay stopped storing PEs is the
    // daily meter batch. Asserted with garbage credentials only, so it never writes:
    // a real batch would seal acts that can mint on production, and smoke acts
    // must never mint. The retired recorder must answer 410 and name the batch route.
    const bad = await http(`${API}/v1/meter/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'DeviceKey pdk_deadbeef:pds_deadbeef' },
      body: JSON.stringify({ acts: [] }),
    });
    if (bad.status !== 401) {
      return fail(`meter/batch with garbage DeviceKey -> expected 401, got ${bad.status} ${bad.text.slice(0, 120)}`);
    }
    const retired = await http(`${API}/v1/pe/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'DeviceKey pdk_deadbeef:pds_deadbeef' },
      body: JSON.stringify({ action_type: 'test_run' }),
    });
    return retired.status === 410 && retired.json?.error === 'pe_recorder_retired' && retired.json?.use === '/v1/meter/batch'
      ? pass('device auth enforced on /v1/meter/batch (401 on bad creds); retired /v1/pe/submit answers 410 pe_recorder_retired → /v1/meter/batch; nothing written')
      : fail(`retired /v1/pe/submit -> expected 410 pe_recorder_retired naming /v1/meter/batch, got ${retired.status} ${retired.text.slice(0, 160)}`);
  },

  'install-lint': async (mode) => {
    try {
      const args = [join(HERE, 'install-lint.mjs')];
      if (mode === 'post-flip') args.push('--post-flip');
      const { stdout } = await execFileP('node', args, { timeout: 300_000 });
      const last = stdout.trim().split('\n').pop();
      return pass(last || 'install-command lint clean');
    } catch (e) {
      const out = `${e.stdout || ''}${e.stderr || ''}`.trim().split('\n');
      return fail(`install-command lint failed:\n      ${out.slice(-6).join('\n      ')}`);
    }
  },

  //. The public agent directory, advertised by /v1/ecosystem. The old
  // pre-flip branch warned on 401 as a "known route-shadow bug"; that warn is
  // DEAD and was removed — the fix (skipReservedAgentSegments, commit 16b1dd26)
  // shipped and is in the serving revision, so a 401 here would now be a real
  // regression and not a known condition. Pre-flip the whole `/v1/agents`
  // prefix is closed by the M10 gate; post-flip it is an open functional read.
  'agents-directory-public': async (mode) => {
    const r = await http(`${API}/v1/agents/directory`);
    if (mode === 'pre-flip') return assertClosedByPreLaunchGate('agents/directory', r);
    return r.status === 200 && r.json && Array.isArray(r.json.agents)
      ? pass(`public directory 200 (${r.json.count} agents)`)
      : fail(`expected public 200 {agents:[…]}, got ${r.status} ${r.text.slice(0, 120)}`);
  },

  // institution LIST paths were the blind spot: the funnel checks above
  // exercise the BARE directory + record (neither needs a composite index), so a
  // missing/wrong-direction index on a FILTERED institution browse (the /292
  // class) never showed up in smoke. This hits the two-filter directory browse the
  // relay actually serves — `availability` (==) + `capability` (array-contains)
  // (`browseDirectory`, core/agent-bank/directory.ts), which the planner can only
  // serve with the agent_directory (availability ASC, capabilities CONTAINS)
  // composite. (It used to send `min_governance_score`, which the relay has
  // ignored since removed governance_score — so the probe proved nothing
  // about a filter.) Post-flip it also asserts the filter was APPLIED: every row
  // returned is `available` and carries the capability, and when the bare
  // directory lists an available agent with that capability, at least one row
  // comes back (so an empty result cannot pass for a honored filter). Public
  // post-flip; a 500 here means that composite regressed. (The agent-AUTHED
  // browse rails — jobs/available, promises/marketplace, pools/active — can't be
  // reached unauthenticated from smoke; their index shapes are covered by
  // `npm run verify-launch-indexes`, FLIP_RUNBOOK §2.)
  'agents-directory-filtered': async (mode) => {
    if (mode === 'pre-flip') {
      const r = await http(`${API}/v1/agents/directory?availability=available&capability=smoke_probe`);
      return assertClosedByPreLaunchGate('agents/directory (filtered)', r);
    }
    // Pick a capability a currently-available agent really lists, so the filter
    // has something to match; fall back to a probe token (then zero rows is right).
    const bare = await http(`${API}/v1/agents/directory?limit=100`);
    const listed = Array.isArray(bare.json?.agents) ? bare.json.agents : [];
    const seed = listed.find((a) => a?.availability === 'available'
      && Array.isArray(a.capabilities) && a.capabilities.some((c) => typeof c === 'string' && c.length > 0));
    const capability = seed ? seed.capabilities.find((c) => typeof c === 'string' && c.length > 0) : 'smoke_probe';
    const url = `${API}/v1/agents/directory?availability=available&capability=${encodeURIComponent(capability)}`;
    const r = await http(url);
    if (r.status === 500) return fail(`filtered directory 500 — likely a missing composite index (${r.text.slice(0, 120)})`);
    if (!(r.status === 200 && r.json && Array.isArray(r.json.agents))) {
      return fail(`expected 200 {agents:[…]}, got ${r.status} ${r.text.slice(0, 120)}`);
    }
    return judgeFilteredDirectory(r.json.agents, { availability: 'available', capability, expectMatch: Boolean(seed) });
  },

  // Session-2 API surfaces (Agent Passport + Reputation), read DIRECTLY — the
  // website record page above only exercises /record indirectly via the /a/[id]
  // fallback. All three are PUBLIC_LAUNCH-gated → 404 pre-flip, open post-flip.

  // GET /v1/agents/:id/record — the Provenance Record JSON. Identifier
  // resolution is EXACT + case-sensitive on agent_id/display_name (or a
  // wallet id/address), so we never hardcode a mutable name: post-flip we
  // resolve a REAL, currently-listed subject from the public directory, and
  // fall back to Atlas (the founding agent) by its immutable wallet-doc id.
  'agents-record': async (mode) => {
    if (mode === 'pre-flip') {
      const r = await http(`${API}/v1/agents/atlas/record`);
      return r.status === 404
        ? pass('gated 404, as expected pre-flip')
        : warn(`/v1/agents/*/record responded ${r.status} pre-flip — landed early?`);
    }
    // Fall back to the stable agent identifier, never a wallet id: wallet ids change
    // when an agent is re-provisioned, and a stale one reads found:false.
    const dir = await http(`${API}/v1/agents/directory`);
    const first = Array.isArray(dir.json?.agents) ? dir.json.agents[0] : null;
    const id = first?.wallet_id || first?.agent_id || first?.address || 'atlas';
    const r = await http(`${API}/v1/agents/${encodeURIComponent(id)}/record`);
    return r.status === 200 && r.json?.record_type === 'provenance_record' && r.json?.found === true
      ? pass(`200, provenance_record found for ${id}`)
      : fail(`expected 200 {record_type:'provenance_record', found:true} for ${id}, got ${r.status} ${r.text.slice(0, 160)}`);
  },

  // GET /v1/agents/:id/badge.svg — embeddable README badge. Always 200 SVG
  // post-flip (even an unknown id renders an "unknown" badge), image/svg+xml.
  'agents-badge': async (mode) => {
    const r = await http(`${API}/v1/agents/atlas/badge.svg`);
    if (mode === 'pre-flip') {
      return r.status === 404
        ? pass('gated 404, as expected pre-flip')
        : warn(`/v1/agents/atlas/badge.svg responded ${r.status} pre-flip — landed early?`);
    }
    const ct = r.headers?.get?.('content-type') || '';
    return r.status === 200 && r.text.includes('<svg') && /image\/svg\+xml/.test(ct)
      ? pass(`200, image/svg+xml badge (${r.text.length} bytes)`)
      : fail(`expected 200 SVG (image/svg+xml, contains <svg), got ${r.status} ct="${ct}" ${r.text.slice(0, 120)}`);
  },

  // GET /v1/reputation/address/:address — trust-consumption lane. A valid-format
  // but unknown address must return HTTP 200 {known:false} (Unknown = unknown,
  // never an invented score), with the forward-compat pricing:'free_beta' field.
  'reputation-address': async (mode) => {
    const unknownAddr = '0x000000000000000000000000000000000000dEaD';
    const r = await http(`${API}/v1/reputation/address/${unknownAddr}`);
    if (mode === 'pre-flip') {
      return r.status === 404
        ? pass('gated 404, as expected pre-flip')
        : warn(`/v1/reputation/address responded ${r.status} pre-flip — landed early?`);
    }
    return r.status === 200 && r.json?.known === false && r.json?.pricing === 'free_beta'
      ? pass("200, unknown address -> {known:false, pricing:'free_beta'}")
      : fail(`expected 200 {known:false, pricing:'free_beta'}, got ${r.status} ${r.text.slice(0, 160)}`);
  },

  // /a/<agentId> — the Agent Passport page (beneficiary routing website half). nginx serves
  // one static page for /a and any /a/<id>; the record renders client-side.
  'website-agent-record-page': async (mode) => {
    const landing = await http(`${SITE}/a/`);
    if (mode === 'pre-flip') {
      return landing.status === 401
        ? pass('401 Basic Auth wall up, as expected pre-flip')
        : fail(`expected 401 pre-flip, got ${landing.status} — website auth wall may be down early`);
    }
    if (landing.status !== 200 || !landing.text.includes('Agent Provenance Record')) {
      return fail(`expected 200 /a/ landing with the record page, got ${landing.status}`);
    }
    // The nginx rewrite must serve the same page for any /a/<id>.
    const withId = await http(`${SITE}/a/wallet_aw_smoke-check`);
    return withId.status === 200 && withId.text.includes('Agent Provenance Record')
      ? pass('/a/ landing 200 + /a/<id> rewrite serves the record page')
      : fail(`/a/<id> rewrite broken: got ${withId.status} (nginx location ^~ /a/ missing?)`);
  },
};

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const mode = resolveMode(argv);
  const onlyArg = argv[argv.indexOf('--only') + 1];
  const only = argv.includes('--only') ? onlyArg?.split(',').map((s) => s.trim()) : null;
  if (only?.some((n) => !CHECKS[n])) {
    console.error(`[launch-smoke] unknown check in --only; available: ${Object.keys(CHECKS).join(', ')}`);
    process.exit(2);
  }

  console.log(`[launch-smoke] mode=${mode} api=${API} site=${SITE}`);
  console.log('');

  const results = [];
  for (const [name, check] of Object.entries(CHECKS)) {
    if (only && !only.includes(name)) continue;
    let r;
    try {
      r = await check(mode);
    } catch (e) {
      r = fail(`threw: ${e.message}`);
    }
    results.push({ name, ...r });
    const icon = { pass: '✓', fail: '✗', warn: '!', skip: '-' }[r.status];
    console.log(`  ${icon} ${name.padEnd(24)} ${r.detail}`);
  }

  const failed = results.filter((r) => r.status === 'fail');
  const warned = results.filter((r) => r.status === 'warn');
  console.log('');
  console.log(`[launch-smoke] ${results.length} checks: ${results.length - failed.length - warned.length} pass, ${warned.length} warn, ${failed.length} fail (mode=${mode})`);
  if (failed.length > 0) {
    console.error(`[launch-smoke] FAILING: ${failed.map((f) => f.name).join(', ')}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('[launch-smoke] fatal:', e);
  process.exit(1);
});
