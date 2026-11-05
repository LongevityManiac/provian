/**
 * Reference-gate live proof (reference-gate run, 2026-10-09).
 *
 * A REAL presenter — the x402-test-agent (platform:'test', key under ~/.provian/) — burns PVT it
 * already holds to present to a running instance of `provian-reference-gate` against the deployed
 * relay, for each worked example:
 * 1. GET <gate>/ — the policies and their predicates
 * 2. POST <gate>/gates/<policy>/challenge — a challenge SIGNED by the gate's own domain identity
 * (the SDK verifies it against https://<gate>/.well-known/provian-requester.json before any burn)
 * 3. CommonsInstitutions.respondToChallenge — burn exactly the tier floor, present via the relay, get the token
 * 4. POST <gate>/gates/<policy>/decide — the gate verifies once (relay verify + local verify) and decides
 * 5. POST the SAME token again — the gate refuses the replay
 * Prints a JSON report with every tx hash, burn id, challenge and decision.
 *
 * Usage (after `npm --prefix provian-agent-sdk run build`):
 * GATE_URL=https://<gate host> node scripts/launch-smoke/reference-gate-proof.mjs [policy...]
 * Env: PROVIAN_API_BASE (default https://api.provian.ai), BASE_RPC_URL (default https://mainnet.base.org),
 * REPORT_OUT (path for the JSON report).
 * DISCLOSE=all : answer every requester-named disclosure request on the challenge
 * from the presenter's PE store — PROVIAN_HOME (default $HOME) names the ~/.provian whose device
 * credentials and pe-store hold the presenter's own anchored PEs. Without it every request is declined.
 * Exit 0 when every example rendered a decision and every replay was refused; 1 otherwise.
 * the operator’s wallet and keys are never in the path. No supply is minted.
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const SDK_DIST = join(HERE, '..', '..', 'provian-agent-sdk', 'dist');
const require = createRequire(join(SDK_DIST, 'index.js'));
const sdk = require(join(SDK_DIST, 'index.js'));

const API = process.env.PROVIAN_API_BASE || 'https://api.provian.ai';
const RPC = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const GATE = (process.env.GATE_URL || '').replace(/\/+$/, '');
const OUT = process.env.REPORT_OUT || '';
if (!GATE) { console.error('GATE_URL is required'); process.exit(1); }

const log = (m) => console.log(`[reference-gate-proof] ${m}`);

const PROVIAN_HOME = process.env.PROVIAN_HOME || homedir();
const DISCLOSE = (process.env.DISCLOSE || '').trim();

function loadWallet() {
  const dir = join(homedir(), '.provian');
  const creds = JSON.parse(readFileSync(join(dir, 'x402-test-agent.credentials.json'), 'utf8'));
  const keystore = sdk.loadKeystore(join(dir, 'x402-test-agent.keystore.json'));
  const passphrase = readFileSync(join(dir, 'x402-test-agent.passphrase'), 'utf8').trim();
  const key = sdk.decryptKeystore(keystore, passphrase);
  if (key.address.toLowerCase() !== creds.address.toLowerCase()) throw new Error('keystore/credentials address mismatch');
  return { creds, privateKeyHex: key.privateKey };
}

async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

/** The presenter's own PE store (its device's chain under PROVIAN_HOME/.provian) when disclosing. */
function openDisclosureStore() {
  if (!DISCLOSE) return null;
  const credsPath = join(PROVIAN_HOME, '.provian', 'credentials');
  const deviceId = readFileSync(credsPath, 'utf8').split('\n').map((l) => l.match(/^(?:export\s+)?PROVIAN_DEVICE_ID=["']?([^"']+)/)).filter(Boolean)[0]?.[1] ?? null;
  const opened = sdk.resolveLocalPeStore({ deviceId, root: join(PROVIAN_HOME, '.provian', 'pe-store') });
  if (!opened.ok) throw new Error(`cannot open the presenter's PE store: ${opened.detail}`);
  log(`disclosing from ${join(PROVIAN_HOME, '.provian', 'pe-store')} device ${deviceId}`);
  return opened.store;
}

async function main() {
  const { creds, privateKeyHex } = loadWallet();
  const disclosureStore = openDisclosureStore();
  const bank = new sdk.CommonsInstitutions({ relayUrl: API, walletId: creds.walletId, apiKey: creds.apiKey, apiSecret: creds.apiSecret });
  const index = await (await fetch(`${GATE}/`)).json();
  const wanted = process.argv.slice(2);
  const policies = index.policies.filter((p) => wanted.length === 0 || wanted.includes(p.slug));
  log(`gate ${index.gate} (${index.identity}); relay ${API}; presenter ${creds.address}; policies ${policies.map((p) => p.slug).join(', ')}`);
  const wk = await (await fetch(`https://${index.gate}/.well-known/provian-requester.json`)).json();
  log(`well-known kids: ${wk.keys.map((k) => k.kid).join(', ')}`);

  const report = { gate: index.gate, relay: API, presenter: { wallet_id: creds.walletId, address: creds.address }, started_at: new Date().toISOString(), examples: [] };
  let ok = true;
  for (const p of policies) {
    const entry = { policy: p.slug, predicates: p.predicates };
    try {
      const ch = await postJson(`${GATE}/gates/${p.slug}/challenge`, { presenter: creds.address });
      if (ch.status !== 201) throw new Error(`challenge ${ch.status}: ${JSON.stringify(ch.json)}`);
      const challenge = ch.json.challenge;
      entry.challenge = challenge;
      log(`${p.slug}: challenge ${challenge.challenge.slice(0, 16)}… requester ${challenge.requester.type}:${challenge.requester.id} kid ${challenge.requester.kid}`);

      // The presenter verifies the signed challenge against the gate's well-known key BEFORE burning
      // (requesterVerdict), burns exactly the reputation floor, and presents via the relay.
      if (challenge.disclosures?.length) log(`${p.slug}: challenge names ${challenge.disclosures.length} disclosure request(s): ${JSON.stringify(challenge.disclosures)}`);
      const responded = await bank.respondToChallenge(challenge, {
        privateKeyHex, rpcUrl: RPC,
        ...(disclosureStore ? { disclose: DISCLOSE === 'all' ? 'all' : 'declined', disclosureStore } : {}),
        onRequester: (v) => { log(`${p.slug}: requester verdict ${v.status}${v.status === 'verified' ? ` (${v.requester.type}:${v.requester.id})` : ''}`); return v.status === 'verified'; },
      });
      entry.burn = { tx_hash: responded.txHash, burn_id: responded.burnId, amount_atomic: responded.burnAmountAtomic, tier: responded.tier };
      entry.requester_verdict = responded.requesterVerdict.status;
      if (responded.disclosures) {
        entry.disclosures = responded.disclosures.map((d) => ({ request: d.request, election: d.election, records: (d.records ?? []).map((r) => ({ pe_id: r.pe_id, pe_hash: r.pe_hash })) }));
        log(`${p.slug}: disclosures ${JSON.stringify(entry.disclosures)}`);
      }
      entry.token_sha256 = (await import('node:crypto')).createHash('sha256').update(responded.token).digest('hex');
      log(`${p.slug}: burned ${Number(responded.burnAmountAtomic) / 1e18} PVT tx ${responded.txHash} burn ${responded.burnId.slice(0, 16)}…`);

      const first = await postJson(`${GATE}/gates/${p.slug}/decide`, { token: responded.token });
      entry.decision = first.json;
      entry.decision_http = first.status;
      log(`${p.slug}: decision ${first.json?.decision} (${first.status}) — ${JSON.stringify(first.json?.reasons)}`);
      if (!first.json || (first.json.decision !== 'allow' && first.json.decision !== 'block') || !first.json.presentation) {
        ok = false; entry.error = 'no decision over a verified presentation';
      }
      const replay = await postJson(`${GATE}/gates/${p.slug}/decide`, { token: responded.token });
      entry.replay = replay.json;
      entry.replay_http = replay.status;
      log(`${p.slug}: replay ${replay.json?.decision} (${replay.status}) — ${JSON.stringify(replay.json?.reasons)}`);
      if (!replay.json || replay.json.decision !== 'block') { ok = false; entry.error = 'replay was not refused'; }
    } catch (err) {
      ok = false;
      entry.error = err instanceof Error ? err.message : String(err);
      log(`${p.slug}: FAILED ${entry.error}`);
    }
    report.examples.push(entry);
  }
  report.finished_at = new Date().toISOString();
  report.ok = ok;
  if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(ok ? 0 : 1);
}

main().catch((err) => { console.error(`[reference-gate-proof] FAIL: ${err instanceof Error ? err.stack : String(err)}`); process.exit(1); });
