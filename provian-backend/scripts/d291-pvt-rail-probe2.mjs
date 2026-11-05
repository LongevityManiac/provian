/** follow-up: clean escrow PVT gate + USDC control + promise(borrower=A). */
import { generateKeyPairSync, createSign } from 'crypto';
const API = 'https://api.provian.ai';
async function http(url, init = {}) { const r = await fetch(url, init); const text = await r.text(); let json; try { json = JSON.parse(text); } catch {} return { status: r.status, text, json }; }
function genKeyPair() { const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' }); const d = publicKey.export({ type: 'spki', format: 'der' }); return { privateKey, pubKeyHex: d.subarray(d.length - 65).subarray(1).toString('hex') }; }
const sign = (k, c) => { const s = createSign('SHA256'); s.update(c); return s.sign(k, 'hex'); };
const rid = (p) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e9).toString(16)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function mk(label) {
  for (let i = 1; i <= 6; i++) {
    const kp = genKeyPair(); const agentId = rid(`d291b-${label}`); const registrationId = rid(`d291b-reg-${label}`);
    const ch = await http(`${API}/v1/agent/wallet/challenge?public_key=${encodeURIComponent(kp.pubKeyHex)}&registration_id=${encodeURIComponent(registrationId)}&agent_id=${encodeURIComponent(agentId)}`);
    if (ch.status === 503) { await sleep(3000 * i); continue; }
    if (ch.status !== 200) throw new Error(`ch ${label}  ${ch.status}  ${ch.text.slice(0,120)}`);
    const cr = await http(`${API}/v1/agent/wallet/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ registration_id: registrationId, agent_name: `D291b ${label}`, agent_id: agentId, platform: 'test', constitution_accepted_at: new Date().toISOString(), public_key: kp.pubKeyHex, challenge_id: ch.json.challenge_id, signature: sign(kp.privateKey, ch.json.challenge) }) });
    if (cr.status === 503) { await sleep(3000 * i); continue; }
    if (cr.status !== 201) throw new Error(`cr ${label}  ${cr.status}  ${cr.text.slice(0,160)}`);
    return { walletId: cr.json.wallet_id, auth: `Bearer ${cr.json.api_key}:${cr.json.api_secret}` };
  }
  throw new Error(`fence ${label}`);
}
async function post(auth, path, body) { const r = await http(`${API}${path}`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return `${r.status}  ${(r.text||'').replace(/\s+/g,' ').slice(0,200)}`; }
const A = await mk('A'); const B = await mk('B');
console.log('A', A.walletId, '| B', B.walletId);
console.log('\nescrow PVT (valid body):\n ', await post(A.auth, '/v1/escrow/create', { depositor_wallet_id: A.walletId, recipient_wallet_id: B.walletId, currency: 'pvt', amount_pvt: '1000000000000000000', chain: 'base', deadline_hours: 24, auto_release_hours: 48, description: 'd291' }));
console.log('\nescrow USDC control (valid body):\n ', await post(A.auth, '/v1/escrow/create', { depositor_wallet_id: A.walletId, recipient_wallet_id: B.walletId, currency: 'usdc', amount_usdc: 10, chain: 'base', deadline_hours: 24, auto_release_hours: 48, description: 'd291' }));
console.log('\npromise PVT (A=borrower, hits PVT gate):\n ', await post(A.auth, '/v1/promises/create', { borrower_wallet_id: A.walletId, lender_wallet_id: B.walletId, currency: 'pvt', principal_pvt: '1000000000000000000', chain: 'base', terms: 'd291', due_hours: 72 }));
console.log('\npromise USDC control (A=borrower):\n ', await post(A.auth, '/v1/promises/create', { borrower_wallet_id: A.walletId, lender_wallet_id: B.walletId, currency: 'usdc', principal_usdc: 10, chain: 'base', terms: 'd291', due_hours: 72 }));
