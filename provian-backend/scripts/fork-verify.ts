/**
 * Backend verifier harness - proves the /transfer/record and /bonds/post
 * on-chain VERIFIERS validate GENUINE Base-fork txs (not mocked receipts).
 *
 * Reads the real tx hashes the SDK harness (provian-agent-sdk/test-harness/
 * fork-base.mjs) broadcast against the anvil Base fork, points the verifiers at
 * the fork, and asserts each one ACCEPTS the real tx and REJECTS a mismatched
 * claim (FIX B value/recipient; FIX C BondPosted agent/level).
 *
 * Run (anvil fork + fork-base.mjs must have run first):
 *   BASE_RPC_URL=http://127.0.0.1:8545 \
 *   ENABLE_PVT_PRINCIPAL=true PVT_PRINCIPAL_CHAINS=base \
 *   PVT_CONTRACT_ADDRESS_BASE="$(node -p "require('./config/pvt9-base.json').assets.pvt9.address")" \
 *   provian-backend/node_modules/.bin/tsx provian-backend/scripts/fork-verify.ts
 */
import { readFileSync } from 'node:fs';
import {
  verifyEvmNativeTransfer,
  verifyTransfer,
  verifyEvmBondPosted,
  verifyEvmBondRenewed,
  verifyEvmBondToppedUp,
  type TxVerificationResult,
} from '../src/core/onchain/tx-verifier';

const h = JSON.parse(readFileSync('/tmp/fork-hashes.json', 'utf8'));
const CHAIN_ID = 8453;
let pass = 0;
let fail = 0;

async function expectOk(name: string, p: Promise<TxVerificationResult>): Promise<void> {
  const r = await p;
  if (r.ok === true) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  -> ${JSON.stringify(r)}`); }
}
async function expectReject(name: string, expected: string, p: Promise<TxVerificationResult>): Promise<void> {
  const r = await p;
  if (r.ok === false && r.reason === expected) { pass++; console.log(`PASS  ${name} (rejected: ${r.reason})`); }
  else { fail++; console.log(`FAIL  ${name}  expected reject '${expected}', got ${JSON.stringify(r)}`); }
}

async function main(): Promise<void> {
  console.log(`Verifying real Base-fork txs via BASE_RPC_URL=${process.env.BASE_RPC_URL}\n`);

  // --- ACCEPT: the verifiers validate the genuine on-chain txs ---
  await expectOk('FIX B  native value+recipient verified', verifyEvmNativeTransfer({
    chainId: CHAIN_ID, txHash: h.native.hash,
    expectedFrom: h.agent, expectedTo: h.recipient, expectedAmountWei: BigInt(h.native.amountWei),
  }));
  await expectOk('USDC transfer verified (from+to+amount)', verifyTransfer({
    chain: 'base', txHash: h.usdc_transfer.hash,
    expectedFrom: h.agent, expectedTo: h.recipient, currency: 'usdc',
    expectedAmountUsdc: Number(BigInt(h.usdc_transfer.amountAtomic)) / 1e6,
  }));
  await expectOk('PVT transfer verified (from+to+amount)', verifyTransfer({
    chain: 'base', txHash: h.pvt_transfer.hash,
    expectedFrom: h.agent, expectedTo: h.recipient, currency: 'pvt',
    expectedAmountPvtWei: BigInt(h.pvt_transfer.amountAtomic),
  }));
  await expectOk('FIX C  BondPosted event + agent + level verified', verifyEvmBondPosted({
    chainId: CHAIN_ID, txHash: h.postBond.hash, bondPoolAddress: h.pool,
    expectedAgent: h.agent, expectedAutonomyLevel: h.postBond.level,
  }));
  await expectOk('FIX C  BondRenewed event + agent verified', verifyEvmBondRenewed({
    chainId: CHAIN_ID, txHash: h.renewBond.hash, bondPoolAddress: h.pool, expectedAgent: h.agent,
  }));

  const topUp = await verifyEvmBondToppedUp({
    chainId: CHAIN_ID, txHash: h.topUpBond.hash, bondPoolAddress: h.pool, expectedAgent: h.agent,
  });
  await expectOk('bond lifecycle BondToppedUp event + agent + amount verified', Promise.resolve(
    topUp.ok && topUp.toppedAmountAtomic !== h.topUpBond.amountAtomic
      ? { ok: false, reason: `topped_amount ${topUp.toppedAmountAtomic} != ${h.topUpBond.amountAtomic}` } as TxVerificationResult
      : topUp,
  ));

  // --- REJECT: genuine txs that don't match the claim fail closed ---
  await expectReject('FIX B  native wrong-amount fails closed', 'native_value_mismatch', verifyEvmNativeTransfer({
    chainId: CHAIN_ID, txHash: h.native.hash,
    expectedFrom: h.agent, expectedTo: h.recipient, expectedAmountWei: BigInt(h.native.amountWei) + 1n,
  }));
  await expectReject('FIX B  native wrong-recipient fails closed', 'native_recipient_mismatch', verifyEvmNativeTransfer({
    chainId: CHAIN_ID, txHash: h.native.hash,
    expectedFrom: h.agent, expectedTo: h.pool, expectedAmountWei: BigInt(h.native.amountWei),
  }));
  await expectReject('FIX C  bond wrong-agent fails closed', 'bond_agent_mismatch', verifyEvmBondPosted({
    chainId: CHAIN_ID, txHash: h.postBond.hash, bondPoolAddress: h.pool,
    expectedAgent: h.recipient, expectedAutonomyLevel: h.postBond.level,
  }));
  await expectReject('FIX C  bond wrong-level fails closed', 'bond_level_mismatch', verifyEvmBondPosted({
    chainId: CHAIN_ID, txHash: h.postBond.hash, bondPoolAddress: h.pool,
    expectedAgent: h.agent, expectedAutonomyLevel: h.postBond.level === 2 ? 3 : 2,
  }));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('VERIFY HARNESS ERROR:', e); process.exit(1); });
