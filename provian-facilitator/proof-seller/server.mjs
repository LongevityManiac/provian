// Provian x402 proof seller ( live proof). One paid resource per chain, settled through
// Provian's facilitator: GET /paid (USDC on Base) and GET /paid-solana (USDC on Solana). Holds NO key:
// each seller wallet registered with the facilitator separately (and on Base approved the fee
// settler); this server only names its payTo addresses and forwards the buyer's signed payment to the
// facilitator's /verify and /settle (x402 v2).
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8080);
const FACILITATOR = (process.env.FACILITATOR_URL ?? '').replace(/\/+$/, '');
const PAY_TO = process.env.SELLER_ADDRESS ?? '';
const SOLANA_PAY_TO = process.env.SOLANA_SELLER_ADDRESS ?? '';
const PRICE = process.env.PRICE_ATOMIC ?? '10000'; // $0.01 USDC
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const SOLANA_NETWORK = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const SOLANA_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
if (!/^https:\/\//.test(FACILITATOR) || !/^0x[0-9a-fA-F]{40}$/.test(PAY_TO)) throw new Error('FACILITATOR_URL (https) and SELLER_ADDRESS are required');
if (SOLANA_PAY_TO !== '' && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(SOLANA_PAY_TO)) throw new Error('SOLANA_SELLER_ADDRESS is not a base58 address');

const baseRequirement = {
  scheme: 'exact', network: 'eip155:8453', asset: USDC, amount: PRICE, payTo: PAY_TO, maxTimeoutSeconds: 120,
  extra: { name: 'USD Coin', version: '2', provianFee: { payer: 'seller', quote: `${FACILITATOR}/fee-quote?network=base` } },
};

/** A fresh Solana requirement: the facilitator's fee quote names the fee payer and the buyer's fee leg. */
async function solanaRequirement() {
  const res = await fetch(`${FACILITATOR}/fee-quote?network=solana`);
  const quote = await res.json();
  if (res.status !== 200 || !quote.extra) throw new Error(`solana fee quote unavailable (${res.status})`);
  return { scheme: 'exact', network: SOLANA_NETWORK, asset: SOLANA_USDC, amount: PRICE, payTo: SOLANA_PAY_TO, maxTimeoutSeconds: 120, extra: quote.extra };
}

/** The buyer echoes the requirement it accepted (with its time-bound fee quote); take it only if it sells this. */
function acceptedSolana(payload) {
  const a = payload?.accepted;
  if (!a || a.scheme !== 'exact' || a.network !== SOLANA_NETWORK || a.asset !== SOLANA_USDC || a.amount !== PRICE || a.payTo !== SOLANA_PAY_TO) return null;
  return a;
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');

async function facilitator(path, paymentPayload, paymentRequirements) {
  const res = await fetch(`${FACILITATOR}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})), signature: res.headers.get('provian-output-signature') };
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'); return; }
  const solana = url.pathname === '/paid-solana';
  if (url.pathname !== '/paid' && !(solana && SOLANA_PAY_TO !== '')) { res.writeHead(404).end(); return; }
  const resource = { url: `https://${req.headers.host}${url.pathname}`, description: 'Provian x402 facilitator live proof', mimeType: 'text/plain' };
  const header = req.headers['payment-signature'];
  try {
    if (typeof header !== 'string' || header.length === 0) {
      const requirement = solana ? await solanaRequirement() : baseRequirement;
      const required = { x402Version: 2, error: 'payment required', resource, accepts: [requirement] };
      res.writeHead(402, { 'content-type': 'application/json', 'PAYMENT-REQUIRED': b64(required) }).end(JSON.stringify(required));
      return;
    }
    const payload = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    const requirement = solana ? acceptedSolana(payload) : baseRequirement;
    if (requirement === null) {
      res.writeHead(402, { 'content-type': 'application/json' }).end(JSON.stringify({ x402Version: 2, error: 'requirements_mismatch' }));
      return;
    }
    const verified = await facilitator('/verify', payload, requirement);
    if (verified.status !== 200 || verified.body.isValid !== true) {
      console.log(JSON.stringify({ stage: 'verify', chain: solana ? 'solana' : 'base', status: verified.status, body: verified.body }));
      res.writeHead(402, { 'content-type': 'application/json' }).end(JSON.stringify({ x402Version: 2, error: verified.body.invalidReason ?? 'verify_failed', accepts: [requirement] }));
      return;
    }
    const settled = await facilitator('/settle', payload, requirement);
    console.log(JSON.stringify({ stage: 'settle', chain: solana ? 'solana' : 'base', status: settled.status, body: settled.body, receipt_signed: Boolean(settled.signature) }));
    if (settled.status !== 200 || settled.body.success !== true) {
      res.writeHead(402, { 'content-type': 'application/json' }).end(JSON.stringify({ x402Version: 2, error: settled.body.errorReason ?? 'settle_failed', accepts: [requirement] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain', 'PAYMENT-RESPONSE': b64(settled.body) })
      .end(`Paid through the Provian x402 facilitator. Settlement ${settled.body.transaction}\n`);
  } catch (err) {
    console.log(JSON.stringify({ stage: 'error', message: err instanceof Error ? err.message : String(err) }));
    res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"bad_payment"}');
  }
}).listen(PORT, () => console.log(`proof seller on :${PORT}, Base payTo ${PAY_TO}, Solana payTo ${SOLANA_PAY_TO || '(off)'}, price ${PRICE}`));
