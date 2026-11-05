/**
 * execution probe: what can an OUTSIDE AGENT actually do with PVT, end-to-end,
 * through the API a third-party agent uses. Re-establishes/corrects Finding 6.
 *
 * Execution, not inspection. Creates real outside agents (API key, no admin/operator/
 * internal path), reads on-chain PVT state, and drives every institution primitive with a
 * PVT-denominated body. Classifies each: WORKS / REACHABLE(processes, blocked downstream) /
 * GATED(flag/boundary) / AUTH(not reachable as outside agent) / NOT-BUILT. Includes a
 * positive auth control (the key works on its own resource) and a negative control (the key
 * is refused on an admin/operator route).
 */
import { generateKeyPairSync, createSign } from 'crypto';

const API = 'https://api.provian.ai';
const RPC = 'https://mainnet.base.org';
const KERNEL = '0x8811441914381143b9408c5C32247367F86F173A';

async function http(url, init = {}) {
  const r = await fetch(url, init);
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { /* non-json */ }
  return { status: r.status, text, json };
}
async function ethCall(to, data) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }) });
  return (await r.json()).result;
}
function genKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const pubDer = publicKey.export({ type: 'spki', format: 'der' });
  const pubKeyHex = pubDer.subarray(pubDer.length - 65).subarray(1).toString('hex');
  return { privateKey, pubKeyHex };
}
function signChallenge(privateKeyObj, challenge) {
  const s = createSign('SHA256'); s.update(challenge); return s.sign(privateKeyObj, 'hex');
}
const rid = (p) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e9).toString(16)}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function createOutsideAgent(label) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const kp = genKeyPair();
    const agentId = rid(`d291-${label}`);
    const registrationId = rid(`d291-reg-${label}`);
    const ch = await http(`${API}/v1/agent/wallet/challenge?public_key=${encodeURIComponent(kp.pubKeyHex)}`
      + `&registration_id=${encodeURIComponent(registrationId)}&agent_id=${encodeURIComponent(agentId)}`);
    if (ch.status === 503) { await sleep(3000 * attempt); continue; }
    if (ch.status !== 200 || !ch.json?.challenge) throw new Error(`challenge ${label}: ${ch.status} ${ch.text.slice(0, 160)}`);
    const create = await http(`${API}/v1/agent/wallet/create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        registration_id: registrationId, agent_name: `D291 ${label}`, agent_id: agentId,
        platform: 'test', constitution_accepted_at: new Date().toISOString(),
        public_key: kp.pubKeyHex, challenge_id: ch.json.challenge_id,
        signature: signChallenge(kp.privateKey, ch.json.challenge),
      }),
    });
    if (create.status === 503) { await sleep(3000 * attempt); continue; }
    if (create.status !== 201) throw new Error(`create ${label}: ${create.status} ${create.text.slice(0, 200)}`);
    const w = create.json;
    return { walletId: w.wallet_id, address: (w.address || w.evm_address || w.wallet_address || '').toLowerCase(),
      auth: `Bearer ${w.api_key}:${w.api_secret}`, raw: w };
  }
  throw new Error(`create ${label}: registration fence 503 after retries`);
}

function classify(status, body) {
  const b = (body || '').toString();
  if (status === 201 || status === 200) return 'WORKS';
  if (status === 503 && /PVT9_|boundary|UNCONFIGURED|DEPENDENCY/i.test(b)) return 'GATED(boundary 503)';
  if (status === 404 && /pre.?launch|not.?found|PUBLIC_LAUNCH/i.test(b)) return 'GATED(pre-launch 404)';
  if (status === 404) return 'NOT-FOUND/404';
  if (status === 401) return 'AUTH(401 not reachable as outside agent)';
  if (status === 400 || status === 403 || status === 422 || status === 429) return `REACHABLE (processes; ${status})`;
  return `OTHER ${status}`;
}

async function main() {
  const out = [];
  const log = (...a) => { console.log(...a); out.push(a.join(' ')); };

  // ---- On-chain PVT state (the supply gate) ----
  const ts = await ethCall(KERNEL, '0x18160ddd');
  log('ON-CHAIN live PVT kernel', KERNEL, 'totalSupply =', ts && ts !== '0x' ? (BigInt(ts) / 10n ** 18n).toString() + ' PVT (raw ' + BigInt(ts).toString() + ')' : ts);

  // ---- Stand up two OUTSIDE agents (API key only) ----
  const A = await createOutsideAgent('depositor');
  const B = await createOutsideAgent('recipient');
  log('AGENT A (depositor):', A.walletId, 'addr', A.address || '(no addr in create resp)');
  log('AGENT B (recipient):', B.walletId, 'addr', B.address || '(no addr in create resp)');
  const bal = A.address ? await ethCall(KERNEL, '0x70a08231' + '000000000000000000000000' + A.address.slice(2)) : null;
  log('AGENT A on-chain PVT balanceOf =', bal && bal !== '0x' ? BigInt(bal).toString() : bal);

  // ---- Positive auth control: the key works on its OWN resource ----
  const posc = await http(`${API}/v1/agent/genesis/status/${A.walletId}`, { headers: { Authorization: A.auth } });
  log('\nPOS-CONTROL  GET /v1/agent/genesis/status/<A> with A key ->', posc.status, `(${posc.status === 200 ? 'key valid' : 'UNEXPECTED'})`);

  // ---- Negative control: the same key must be REFUSED on an admin/operator route ----
  const negRoutes = [
    ['POST /v1/admin/pvt/policy (admin)', 'POST', `${API}/v1/admin/pvt/policy`, {}],
    ['POST /v1/internal/scheduler/pvt9-epoch-keeper (operator)', 'POST', `${API}/v1/internal/scheduler/pvt9-epoch-keeper`, {}],
  ];
  for (const [name, method, url, body] of negRoutes) {
    const r = await http(url, { method, headers: { Authorization: A.auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const refused = r.status === 401 || r.status === 403 || (r.status === 404);
    log('NEG-CONTROL ', name, '->', r.status, refused ? '(REFUSED — key is not privileged ✓)' : '(⚠ NOT refused)');
  }

  // ---- The primitives, PVT-denominated, as OUTSIDE AGENT A ----
  const amtPvt = '1000000000000000000'; // 1 PVT atomic
  const probes = [
    ['direct-transfer (record)', 'POST', `${API}/v1/agent/wallet/${A.walletId}/transfer/record`,
      { tx_hash: '0x' + '00'.repeat(32), token: 'PVT', to: B.address || B.walletId, amount: amtPvt, chain: 'base' }],
    ['escrow create (PVT)', 'POST', `${API}/v1/escrow/create`,
      { depositor_wallet_id: A.walletId, recipient_wallet_id: B.walletId, currency: 'pvt', amount_pvt: amtPvt, chain: 'base', description: 'd291 probe' }],
    ['promise create (PVT)', 'POST', `${API}/v1/promises/create`,
      { lender_wallet_id: A.walletId, borrower_wallet_id: B.walletId, currency: 'pvt', principal_pvt: amtPvt, chain: 'base', terms: 'd291 probe' }],
    ['pool create (PVT)', 'POST', `${API}/v1/pools/create`,
      { creator_wallet_id: A.walletId, currency: 'pvt', target_pvt: amtPvt, chain: 'base', name: 'd291 probe' }],
    ['bond post', 'POST', `${API}/v1/bonds/post`,
      { wallet_id: A.walletId, amount_pvt: amtPvt, chain: 'base' }],
    ['court opt-in', 'POST', `${API}/v1/court/opt-in`, { wallet_id: A.walletId }],
    ['job post', 'POST', `${API}/v1/jobs/post`,
      { poster_wallet_id: A.walletId, currency: 'pvt', budget_pvt: amtPvt, chain: 'base', title: 'd291 probe', description: 'd291' }],
  ];
  log('\n=== PRIMITIVE PROBES (outside agent A, PVT-denominated) ===');
  for (const [name, method, url, body] of probes) {
    const r = await http(url, { method, headers: { Authorization: A.auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const cls = classify(r.status, r.text);
    const snippet = (r.text || '').replace(/\s+/g, ' ').slice(0, 180);
    log(`\n[${name}]`, url.replace(API, ''));
    log('   ->', r.status, '=>', cls);
    log('   body:', snippet);
    // If escrow created, surface the PVT funding instruction (the agent-to-agent PVT move mechanism)
    if (name.startsWith('escrow') && r.json?.funding_instructions) {
      log('   FUNDING:', JSON.stringify(r.json.funding_instructions), '| currency', r.json.currency, '| contract', r.json.contract_address);
    }
  }
  log('\n=== DONE ===');
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
