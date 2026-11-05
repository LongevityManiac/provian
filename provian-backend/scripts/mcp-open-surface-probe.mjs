/**
 * execution probe: what an ARBITRARY agent API key can reach through the
 * hosted /mcp tool surface, BEFORE opening the allowlist. /mcp forwards the
 * caller's own Bearer to the underlying REST routes (relayCall injects NO admin/
 * internal secret — verified in code), so an arbitrary key's capability through
 * /mcp == its capability on the 7 tools' endpoints. We drive those endpoints
 * directly as a fresh outside agent, plus admin/operator negative controls,
 * unauthenticated reads, and a wallet-creation loop for anti-farm.
 */
import { generateKeyPairSync, createSign, randomBytes } from 'crypto';

const API = process.env.PROVIAN_API_BASE || 'https://api.provian.ai';
async function http(url, init = {}) {
  const r = await fetch(url, init);
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { /* non-json */ }
  return { status: r.status, text, json };
}
function genKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const pubDer = publicKey.export({ type: 'spki', format: 'der' });
  return { privateKey, pubKeyHex: pubDer.subarray(pubDer.length - 65).subarray(1).toString('hex') };
}
const sign = (k, c) => { const s = createSign('SHA256'); s.update(c); return s.sign(k, 'hex'); };
const rid = (p) => `${p}-${Date.now()}-${randomBytes(5).toString('hex')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GENESIS SAFETY (fixed 2026-08-23). This default used to be 'mcp', which is NOT
// on the Genesis test-platform denial list (`isTestPlatformWallet` /
// GENESIS_TEST_PLATFORM_DENIAL; `genesis-milestones.ts` refuses platform==='test').
// So every run of this probe queued a REAL 75-PVT `genesis_signup` reservation per
// throwaway agent it created — 8 per run, 600 PVT, sitting in the settlement queue
// until the Monday 12:00Z cron paid them. A gate script must never mint. It now
// defaults to the same platform:'test' convention launch-smoke already uses, which
// keeps the wallet fully functional for everything this probe asserts (onboarding,
// browse, link, submit, and the admin/operator/cross-agent refusals) while the
// Genesis path denies the grant by name.
async function createAgent(label, platform = 'test') {
  for (let a = 1; a <= 6; a++) {
    const kp = genKeyPair();
    const agentId = rid(`d294-${label}`), registrationId = rid(`d294-reg-${label}`);
    const ch = await http(`${API}/v1/agent/wallet/challenge?public_key=${encodeURIComponent(kp.pubKeyHex)}&registration_id=${encodeURIComponent(registrationId)}&agent_id=${encodeURIComponent(agentId)}`);
    if (ch.status === 503) { await sleep(2500 * a); continue; }
    if (ch.status !== 200 || !ch.json?.challenge) return { error: `challenge ${ch.status}: ${ch.text.slice(0, 160)}` };
    const cr = await http(`${API}/v1/agent/wallet/create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ registration_id: registrationId, agent_name: `D294 ${label}`, agent_id: agentId, platform, constitution_accepted_at: new Date().toISOString(), public_key: kp.pubKeyHex, challenge_id: ch.json.challenge_id, signature: sign(kp.privateKey, ch.json.challenge) }),
    });
    if (cr.status === 503) { await sleep(2500 * a); continue; }
    if (cr.status !== 201) return { error: `create ${cr.status}: ${cr.text.slice(0, 200)}`, status: cr.status };
    const w = cr.json;
    return { walletId: w.wallet_id, agentId, address: (w.address || w.evm_address || '').toLowerCase(), auth: `Bearer ${w.api_key}:${w.api_secret}`, apiKey: w.api_key, apiSecret: w.api_secret };
  }
  return { error: 'registration fence 503 after retries' };
}

const results = [];
const rec = (cat, label, r, expect) => { results.push({ cat, label, status: r.status, expect, body: (r.text || '').slice(0, 120) }); console.log(`  [${cat}] ${label} -> ${r.status}  ${expect ? '(expect ' + expect + ')' : ''}`); };

(async () => {
  console.log('=== creating two arbitrary outside agents (A = actor, B = victim) ===');
  const A = await createAgent('A'); const B = await createAgent('B');
  if (A.error || B.error) { console.log('AGENT CREATE FAILED:', A.error || B.error); process.exit(1); }
  console.log(`  A=${A.walletId}  B=${B.walletId}`);
  const authA = { Authorization: A.auth };

  console.log('\n=== PART A — the 7 MCP tool endpoints as arbitrary key A ===');
  rec('tool', 'get_pvt_estimate (no auth)', await http(`${API}/v1/pvt/estimate?action_type=agent_task_completed&attestation_tier=software`), '200');
  rec('tool', 'get_agent_record (self)', await http(`${API}/v1/agents/${A.walletId}/record`, { headers: authA }), '200');
  rec('tool', 'get_pvt_estimate', await http(`${API}/v1/pvt/estimate?action_type=code_review&attestation_tier=software`, { headers: authA }), '200');
  rec('tool', 'genesis_status (self)', await http(`${API}/v1/agent/genesis/status/${A.walletId}`, { headers: authA }), '200');
  rec('tool', 'browse_jobs', await http(`${API}/v1/jobs/available`, { headers: authA }), '200');
  rec('tool', 'link_external_address (challenge)', await http(`${API}/v1/agent/external-address/challenge`, { method: 'POST', headers: { ...authA, 'Content-Type': 'application/json' }, body: JSON.stringify({ wallet_id: A.walletId, external_address: '0x' + '1'.repeat(40) }) }), '200/400 (reachable)');
  // submit_pe is gone. A registered device's own caller-typed declaration is REFUSED
  // (actor_declared_work_is_not_a_pe) — the device route records only observation-lane types.
  const regId = rid('dev'), dk = 'pdk_' + randomBytes(16).toString('hex'), ds = 'pds_' + randomBytes(32).toString('hex');
  const reg = await http(`${API}/v1/devices/register`, { method: 'POST', headers: { ...authA, 'Content-Type': 'application/json', 'Idempotency-Key': regId }, body: JSON.stringify({ registration_id: regId, device_key: dk, device_secret: ds, device_name: 'probe', platform: 'mcp-remote' }) });
  rec('tool', 'device-register (self)', reg, '200/201');
  if (reg.status < 300) {
    const devAuth = { Authorization: `DeviceKey ${dk}:${ds}`, 'Content-Type': 'application/json' };
    rec('tool', 'pe-submit own declaration ', await http(`${API}/v1/pe/submit`, { method: 'POST', headers: devAuth, body: JSON.stringify({ action_type: 'agent_task_completed', description: 'd294 probe' }) }), '403 actor_declared_work_is_not_a_pe');
  }

  console.log('\n=== PART B — cross-agent: A tries to touch B ===');
  rec('cross', 'A reads B genesis_status', await http(`${API}/v1/agent/genesis/status/${B.walletId}`, { headers: authA }), 'scoped/refuse');
  rec('cross', 'A rotate-key on B', await http(`${API}/v1/agent/wallet/${B.walletId}/rotate-key`, { method: 'POST', headers: { ...authA, 'Content-Type': 'application/json' }, body: JSON.stringify({}) }), '403');
  rec('cross', 'A device-invite on B', await http(`${API}/v1/agent/wallet/${B.walletId}/device-invite`, { method: 'POST', headers: { ...authA, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'x@x.com' }) }), '403');
  rec('cross', 'A transfer/record on B', await http(`${API}/v1/agent/wallet/${B.walletId}/transfer/record`, { method: 'POST', headers: { ...authA, 'Content-Type': 'application/json' }, body: JSON.stringify({ tx_hash: '0x' + '2'.repeat(64) }) }), '403');

  console.log('\n=== PART C — admin / operator / mint negative controls (key A) ===');
  rec('priv', 'admin pvt/policy', await http(`${API}/v1/admin/pvt/policy`, { method: 'POST', headers: { ...authA, 'Content-Type': 'application/json' }, body: '{}' }), '401/403/404');
  rec('priv', 'operator settlement pvt9-run', await http(`${API}/v1/internal/settlement/pvt9-run`, { method: 'POST', headers: { ...authA, 'Content-Type': 'application/json' }, body: '{"dryRun":true}' }), '401/403');
  rec('priv', 'operator epoch-keeper', await http(`${API}/v1/internal/scheduler/pvt9-epoch-keeper`, { method: 'POST', headers: authA }), '401/403');
  rec('priv', 'admin genesis', await http(`${API}/v1/admin/genesis`, { method: 'POST', headers: { ...authA, 'Content-Type': 'application/json' }, body: '{}' }), '401/403/404');

  console.log('\n=== PART C2 — UNAUTHENTICATED ===');
  rec('anon', 'get_pvt_estimate', await http(`${API}/v1/pvt/estimate?action_type=code_review&attestation_tier=software`), '200 public');
  rec('anon', 'get_agent_record', await http(`${API}/v1/agents/${A.walletId}/record`), 'gate');
  rec('anon', 'browse_jobs (no auth)', await http(`${API}/v1/jobs/available`), '401');
  rec('anon', 'pe/submit (no auth)', await http(`${API}/v1/pe/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"action_type":"x"}' }), '401');

  console.log('\n=== PART D — anti-farm: wallet-creation loop (8 rapid, same IP) ===');
  let ok = 0, limited = 0, other = 0; const codes = [];
  for (let i = 0; i < 8; i++) {
    const w = await createAgent(`loop${i}`);
    if (w.walletId) { ok++; codes.push('201'); }
    else if (w.status === 429) { limited++; codes.push('429'); }
    else { other++; codes.push(String(w.status || w.error).slice(0, 40)); }
  }
  console.log(`  loop outcomes: created=${ok} rate-limited(429)=${limited} other=${other}  [${codes.join(', ')}]`);
  results.push({ cat: 'antifarm', label: 'wallet-creation loop x8', created: ok, limited, other, codes });

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(results, null, 1));
})();
