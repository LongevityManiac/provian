/**
 * x402 live-verify + mainnet transfer smoke (OPEN_ITEMS hard gate,
 * "Agent payment paths").
 *
 * Phase 1 — x402 (needs USDC only; EIP-3009 is gasless for the payer):
 * From the funded Base agent EOA, drive a real 402 -> agent-key sign -> 200
 * against a LIVE x402 endpoint via ProvianClient.wrapFetchWithX402 — no
 * phone, no AAG, no relay in the payment path. Asserts the USDC balance
 * dropped, then reads the settlement transaction back from Base and asserts
 * it has the shape the relay's outbound USDC watcher classifies as
 * `x402_payment` (provian-backend/src/core/pvt/outbound-usdc-watcher.ts,
 * classifyOutbound): a USDC Transfer from the agent in a transaction someone
 * else submitted, either straight to USDC's `transferWithAuthorization`
 * (0xe3ee160e) or through Provian's ProvianX402FeeSettler with a matching
 * `FeeSettled`. That watcher is the only witness of an x402 payment: the
 * SDK records no x402_payment PE and the relay refuses an agent's own
 * report of one (403 actor_declared_work_is_not_a_pe). The watcher skips
 * platform:'test' wallets, so this smoke payment is never priced or minted.
 *
 * Phase 2 — transfer smoke (needs gas ETH too), --transfer or --all:
 * transferToken: small USDC transfer from the agent EOA (default: to
 * itself), waitForReceipt, then a DIRECT CommonsInstitutions.recordTransfer so
 * failures surface -> chain-verified PE {verified:true}; a replay must
 * return idempotent:true with the SAME pe_id.
 *
 * Wallet: the persistent x402 live-verify test agent (platform:'test')
 * created 2026-07-07 — keystore + credentials under ~/.provian/
 * (x402-test-agent.{keystore.json,credentials.json,passphrase}).
 * F5: the operator funds the address with ~$10 USDC + a little ETH on Base.
 *
 * Usage (from repo root, after `npm --prefix provian-agent-sdk run build`):
 * node scripts/launch-smoke/x402-live-verify.mjs # phase 1
 * node scripts/launch-smoke/x402-live-verify.mjs --transfer # phase 2
 * node scripts/launch-smoke/x402-live-verify.mjs --all # both
 * Env: X402_TARGET_URL (default https://x402.ottoai.services/crypto-news —
 * live Base-mainnet 0.001 USDC seller from the x402 Bazaar index),
 * BASE_RPC_URL (default https://mainnet.base.org),
 * X402_MAX_USDC_ATOMIC (per-payment ceiling the SDK requires, default
 * 100000 = 10 cents), FACILITATOR_SETTLER_ADDRESS (default: the deployed
 * ProvianX402FeeSettler, contracts/deployments/base-x402-fee-settler.json),
 * TRANSFER_TO (default: self), TRANSFER_USDC_ATOMIC (default 10000 = 1 cent).
 *
 * Exit codes: 0 green, 1 failure, 2 not funded yet (waiting on F5).
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const SDK_DIST = join(HERE, '..', '..', 'provian-agent-sdk', 'dist');
const require = createRequire(join(SDK_DIST, 'index.js'));
const sdk = require(join(SDK_DIST, 'index.js'));

const API = process.env.PROVIAN_API_BASE || 'https://api.provian.ai';
const RPC = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const TARGET = process.env.X402_TARGET_URL || 'https://x402.ottoai.services/crypto-news';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const MAX_X402_ATOMIC = process.env.X402_MAX_USDC_ATOMIC || '100000'; // 0.10 USDC per payment
const SETTLER = (process.env.FACILITATOR_SETTLER_ADDRESS || '0x7c99bb203ad47ec768612a1234f137d8d3588b7c').toLowerCase();
// keccak256("Transfer(address,address,uint256)") / keccak256("FeeSettled(address,address,address,uint256,uint256)")
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const FEE_SETTLED_TOPIC = '0x5239aaf6047eb7085755b84e198af2e81ff0b6035cd979d9ec8c9996c8fb4815';
// USDC EIP-3009 transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)
const TRANSFER_WITH_AUTHORIZATION = '0xe3ee160e';

const log = (m) => console.log(`[x402-live-verify] ${m}`);
const fail = (m) => { console.error(`[x402-live-verify] FAIL: ${m}`); process.exit(1); };

function loadWallet() {
  const dir = join(homedir(), '.provian');
  const creds = JSON.parse(readFileSync(join(dir, 'x402-test-agent.credentials.json'), 'utf8'));
  const keystore = sdk.loadKeystore(join(dir, 'x402-test-agent.keystore.json'));
  const passphrase = readFileSync(join(dir, 'x402-test-agent.passphrase'), 'utf8').trim();
  const key = sdk.decryptKeystore(keystore, passphrase);
  if (key.address.toLowerCase() !== creds.address.toLowerCase()) fail('keystore/credentials address mismatch');
  return { creds, privateKeyHex: key.privateKey };
}

async function rpcCall(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

const ethBalance = async (addr) => BigInt(await rpcCall('eth_getBalance', [addr, 'latest']));
const usdcBalance = async (addr) =>
  BigInt(await rpcCall('eth_call', [{ to: USDC, data: '0x70a08231' + addr.toLowerCase().replace('0x', '').padStart(64, '0') }, 'latest']));

const addressTopic = (addr) => '0x' + addr.toLowerCase().replace('0x', '').padStart(64, '0');

/**
 * The USDC Transfers the agent sent since `fromBlock`, each with its transaction
 * and receipt — the same chain facts the outbound USDC watcher reads.
 */
async function outboundUsdcTransfers(agent, fromBlock) {
  const logs = await rpcCall('eth_getLogs', [{
    address: USDC,
    fromBlock: '0x' + fromBlock.toString(16),
    toBlock: 'latest',
    topics: [TRANSFER_TOPIC, addressTopic(agent)],
  }]);
  const out = [];
  for (const log of logs) {
    const tx = await rpcCall('eth_getTransactionByHash', [log.transactionHash]);
    const receipt = await rpcCall('eth_getTransactionReceipt', [log.transactionHash]);
    out.push({ log, tx, receipt });
  }
  return out;
}

/**
 * Mirror of classifyOutbound + facilitatorSettlementNamesLeg: is this outbound
 * USDC Transfer an x402 payment as the watcher reads it?
 */
function x402ShapeOf({ log, tx, receipt }, agent) {
  const submitter = (tx?.from || '').toLowerCase();
  const to = (tx?.to || '').toLowerCase();
  const selector = (tx?.input || '').slice(0, 10).toLowerCase();
  if (receipt?.status !== '0x1') return null;
  if (!submitter || submitter === agent.toLowerCase()) return null; // the agent submitted it itself: a send
  if (to === USDC.toLowerCase() && selector === TRANSFER_WITH_AUTHORIZATION) return 'direct transferWithAuthorization';
  if (to === SETTLER) {
    const seller = '0x' + log.topics[2].slice(26);
    const named = receipt.logs.some((l) => l.address.toLowerCase() === SETTLER
      && l.topics[0]?.toLowerCase() === FEE_SETTLED_TOPIC
      && l.topics[1]?.toLowerCase() === addressTopic(agent)
      && l.topics[2]?.toLowerCase() === addressTopic(seller)
      && l.topics[3]?.toLowerCase() === addressTopic(USDC)
      && BigInt(l.data.slice(0, 66)) === BigInt(log.data));
    if (named) return 'ProvianX402FeeSettler settlement';
  }
  return null;
}

async function x402Phase(creds, privateKeyHex) {
  log(`x402 target: ${TARGET}`);
  const usdcBefore = await usdcBalance(creds.address);
  if (usdcBefore === 0n) {
    console.error('[x402-live-verify] NOT FUNDED YET — waiting on F5 (send USDC on Base to ' + creds.address + ')');
    process.exit(2);
  }
  log(`USDC before: ${Number(usdcBefore) / 1e6}`);

  const startBlock = BigInt(await rpcCall('eth_blockNumber', []));

  // Sovereign mode: relayUrl only. x402 needs no relay identity — the agent
  // signs its own EIP-3009 with its own key.
  const client = new sdk.ProvianClient({ relayUrl: API });
  const paidFetch = client.wrapFetchWithX402(
    { privateKeyHex, address: creds.address },
    { maxAmountAtomic: MAX_X402_ATOMIC },
  );

  const res = await paidFetch(TARGET, { headers: { Accept: 'application/json' } });
  if (res.status !== 200) fail(`paid retry did not 200: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const receiptHeader = res.headers.get('payment-response') ?? res.headers.get('x-payment-response');
  const body = (await res.text()).slice(0, 160);
  log(`402 -> sign -> 200 OK. body: ${body}...`);
  if (receiptHeader) {
    try {
      const receipt = JSON.parse(Buffer.from(receiptHeader, 'base64').toString('utf8'));
      log(`settlement receipt: success=${receipt.success} tx=${receipt.transaction || receipt.txHash || 'n/a'} network=${receipt.network || 'n/a'}`);
    } catch {
      log(`settlement receipt header present (unparsed): ${receiptHeader.slice(0, 80)}...`);
    }
  } else {
    log('no PAYMENT-RESPONSE receipt header (the 200 is the settlement signal)');
  }

  const usdcAfter = await usdcBalance(creds.address);
  const spent = usdcBefore - usdcAfter;
  log(`USDC after: ${Number(usdcAfter) / 1e6} (spent ${Number(spent) / 1e6})`);
  if (spent <= 0n) {
    // EIP-3009 settlement is facilitator-broadcast; give it one more look.
    await new Promise((r) => setTimeout(r, 15_000));
    const again = await usdcBalance(creds.address);
    if (usdcBefore - again <= 0n) fail('USDC balance never dropped — settlement not observed on-chain');
    log(`USDC after (delayed): ${Number(again) / 1e6}`);
  }

  // The witness of an x402 payment is the relay's outbound USDC watcher, which
  // reads the settlement from Base. Read the same chain facts and assert the
  // settlement has the shape it classifies as x402_payment.
  let settlements = [];
  for (let attempt = 0; attempt < 10 && settlements.length === 0; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 6_000));
    const transfers = await outboundUsdcTransfers(creds.address, startBlock);
    settlements = transfers
      .map((t) => ({ t, shape: x402ShapeOf(t, creds.address) }))
      .filter((x) => x.shape !== null);
  }
  if (settlements.length === 0) {
    fail('no USDC Transfer from the agent since the payment has the x402 settlement shape the outbound USDC watcher classifies (relayed transferWithAuthorization or a ProvianX402FeeSettler FeeSettled)');
  }
  for (const { t, shape } of settlements) {
    log(`x402 settlement on Base: tx ${t.log.transactionHash} (${shape}), submitted by ${t.tx.from} — the outbound USDC watcher classifies it x402_payment (this platform:'test' agent is skipped, so it never mints)`);
  }
  log('PHASE 1 (x402 live-verify) GREEN');
}

async function transferPhase(creds, privateKeyHex) {
  const eth = await ethBalance(creds.address);
  if (eth === 0n) {
    console.error('[x402-live-verify] transfer smoke needs gas ETH — waiting on F5 (send a little ETH on Base to ' + creds.address + ')');
    process.exit(2);
  }
  const to = process.env.TRANSFER_TO || creds.address; // default: self-transfer keeps funds in place
  const amount = process.env.TRANSFER_USDC_ATOMIC || '10000'; // 0.01 USDC
  log(`transfer smoke: ${Number(amount) / 1e6} USDC -> ${to}`);

  let captured = null;
  const result = await sdk.transferToken(
    { privateKeyHex, address: creds.address },
    {
      token: 'USDC',
      to,
      amount,
      chain: 'base',
      rpcUrl: RPC,
      waitForReceipt: true,
      reportPE: (r) => { captured = r; }, // capture; recordTransfer called directly below so failures surface
    },
  );
  log(`transfer mined: ${result.txHash ?? result.hash ?? JSON.stringify(result).slice(0, 120)}`);
  if (!captured) fail('transferToken never produced a PE transfer report');

  const bank = new sdk.CommonsInstitutions({
    relayUrl: API,
    walletId: creds.walletId,
    apiKey: creds.apiKey,
    apiSecret: creds.apiSecret,
  });
  const rec = await bank.recordTransfer(captured);
  if (!rec.peId || rec.verified !== true) fail(`recordTransfer did not verify: ${JSON.stringify(rec)}`);
  log(`chain-verified transfer PE recorded: ${rec.peId} (verified=${rec.verified})`);

  const replay = await bank.recordTransfer(captured);
  if (replay.peId !== rec.peId || replay.idempotent !== true) {
    fail(`replay guard broken: expected idempotent:true + same pe_id, got ${JSON.stringify(replay)}`);
  }
  log(`replay returns the original PE idempotently (${replay.peId})`);
  log('PHASE 2 (mainnet transfer smoke) GREEN');
}

async function main() {
  const argv = process.argv.slice(2);
  const doX402 = !argv.includes('--transfer') || argv.includes('--all');
  const doTransfer = argv.includes('--transfer') || argv.includes('--all');

  const { creds, privateKeyHex } = loadWallet();
  log(`agent: ${creds.walletId} (${creds.address}, platform:test)`);

  if (doX402) await x402Phase(creds, privateKeyHex);
  if (doTransfer) await transferPhase(creds, privateKeyHex);

  log('ALL REQUESTED PHASES GREEN — tick the OPEN_ITEMS x402 LIVE-VERIFY gate.');
}

main().catch((e) => {
  console.error('[x402-live-verify] fatal:', e);
  process.exit(1);
});
