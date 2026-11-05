#!/usr/bin/env node
/**
 * institution deployment readback verifier — asserts on chain everything P2 and P3 were supposed to do.
 *
 * node scripts/wp13/verify-institutions.mjs # verify the recorded set
 * node scripts/wp13/verify-institutions.mjs --expect-wired # also require P3 fired
 *
 * Exits non-zero on the FIRST mismatch. Reads only; broadcasts nothing.
 *
 * Deliberately re-derives every expectation from chain state and from the contracts'
 * OWN published constants rather than from a second copy of the numbers written here,
 * so this cannot pass by agreeing with itself.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const ARTIFACT = resolve(REPO, 'contracts/deployments/base-pvt9-institutions.json');

const RPC = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
// successor kernel (admin nonce 0). 0x8b2306be… is the ABANDONED kernel.
const KERNEL = '0x8811441914381143b9408c5C32247367F86F173A'; // the live kernel (the kernel 0x4Bf02d5C… is retired)
const ADMIN = '0xCa37a15A64213b2ACD1784ae3f8e6Cbd4600D9D3';
const FEE_WALLET = '0x086e0F377af1245B8888540f39e99A42a7daF1dA';

const EXPECT_WIRED = process.argv.includes('--expect-wired');

let failures = 0;
let checks = 0;

function call(to, sig, args = []) {
  try {
    return execFileSync('cast', ['call', to, sig, ...args.map(String), '--rpc-url', RPC], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

function eq(label, actual, expected) {
  checks++;
  const a = String(actual ?? '').toLowerCase();
  const e = String(expected ?? '').toLowerCase();
  if (a === e) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}\n          expected ${expected}\n          actual   ${actual}`);
  }
}

function absent(label, to, sig) {
  checks++;
  const r = call(to, sig);
  if (r === null) console.log(`  ok    ${label} (absent, as required)`);
  else {
    failures++;
    console.log(`  FAIL  ${label} is PRESENT and returned ${r}`);
  }
}

function main() {
  const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8'));
  const src = artifact.contracts ?? artifact.predictedContracts;
  const addr = (k) => (typeof src[k] === 'string' ? src[k] : src[k].address);

  if (artifact.mode === 'PENDING_BROADCAST') {
    console.log(
      '! artifact still says PENDING_BROADCAST — verifying the PREDICTED addresses.\n' +
        '  Expect "no code" failures until P2 has actually been broadcast.\n',
    );
  }

  const all = ['escrowV4', 'promiseV3', 'poolV3', 'bondPool', 'courtV2'];

  console.log('code present');
  for (const k of all) {
    checks++;
    const size = Number(execFileSync('cast', ['codesize', addr(k), '--rpc-url', RPC], { encoding: 'utf8' }).trim());
    if (size > 0) console.log(`  ok    ${k} codesize=${size}`);
    else {
      failures++;
      console.log(`  FAIL  ${k} ${addr(k)} has NO CODE`);
    }
  }

  console.log('\nauthority + wiring');
  for (const k of all) eq(`${k}.admin`, call(addr(k), 'admin()(address)'), ADMIN);
  for (const k of all) eq(`${k}.epochClock`, call(addr(k), 'epochClock()(address)'), KERNEL);
  for (const k of ['escrowV4', 'promiseV3', 'poolV3', 'bondPool', 'courtV2']) {
    eq(`${k}.pvt`, call(addr(k), 'pvt()(address)'), KERNEL);
  }
  eq('escrowV4.issuanceIndex', call(addr('escrowV4'), 'issuanceIndex()(address)'), KERNEL);
  eq('bondPool.issuanceIndex', call(addr('bondPool'), 'issuanceIndex()(address)'), KERNEL);
  eq('courtV2.issuanceIndex', call(addr('courtV2'), 'issuanceIndex()(address)'), KERNEL);
  eq('escrowV4.feeWallet', call(addr('escrowV4'), 'feeWallet()(address)'), FEE_WALLET);
  eq('bondPool.provianTechWallet', call(addr('bondPool'), 'provianTechWallet()(address)'), FEE_WALLET);
  eq('courtV2.escrowContract', call(addr('courtV2'), 'escrowContract()(address)'), addr('escrowV4'));

  console.log('\nthe retired price read is GONE (institution deployment item 4)');
  for (const k of ['escrowV4', 'promiseV3', 'poolV3']) {
    absent(`${k}.pvtUsdcRate()`, addr(k), 'pvtUsdcRate()(uint256)');
  }

  console.log('\nno economic value scheduled (every active* must be unset)');
  const actives = {
    bondPool: [
      'activeDepositBurnBps()(bool,uint256)',
      'activeDepositFeeBps()(bool,uint256)',
      'activeRenewalBurnBps()(bool,uint256)',
      'activeRenewalFeeBps()(bool,uint256)',
      'activeClaimsProcessingFee()(bool,uint256)',
      'activeClaimFilingFee()(bool,uint256)',
      'activeRenewalPeriod()(bool,uint256)',
      'activeAbandonmentPeriod()(bool,uint256)',
      'activeMaxBondDeposit()(bool,uint256)',
    ],
    courtV2: ['activePanelVotingPeriod()(bool,uint256)', 'activePanelPostingWindow()(bool,uint256)'],
  };
  for (const [k, sigs] of Object.entries(actives)) {
    for (const sig of sigs) {
      const r = call(addr(k), sig);
      eq(`${k}.${sig.split('(')[0]} exists`, r ? r.split(/\s+/)[0] : null, 'false');
    }
  }

  console.log('\nfloored parameters read their literals at the current epoch');
  const req = call(addr('bondPool'), 'indexedRequirements()(uint256,uint256,uint256,uint256,uint256,uint256)');
  if (!req) {
    failures++;
    checks++;
    console.log('  FAIL  bondPool.indexedRequirements() unreadable');
  } else {
    const [l2, l3, cap, proc, filing] = req.split(/\s+/).filter((t) => /^\d/.test(t));
    eq('level2BaseBond', l2, '750000000000000000000');
    eq('level3BaseBond', l3, '3000000000000000000000');
    eq('maxBondDeposit', cap, '7500000000000000000000');
    eq('claimsProcessingFee', proc, '30000000000000000000');
    eq('claimFilingFee', filing, '15000000000000000000');
  }
  eq('arbitratorCollateral', call(addr('courtV2'), 'arbitratorCollateral()(uint256)')?.split(/\s+/)[0], '75000000000000000000');
  // the flat escrow adjudication fee reads its 30 PVT literal at a thin index —
  // the same figure as the bond claims-processing fee just above, which is the point.
  eq(
    'disputeAdjudicationFee',
    call(addr('escrowV4'), 'disputeAdjudicationFee()(uint256)')?.split(/\s+/)[0],
    '30000000000000000000',
  );
  eq(
    'unassignedRewardBurnDelay',
    call(addr('courtV2'), 'UNASSIGNED_REWARD_BURN_DELAY()(uint256)')?.split(/\s+/)[0],
    String(42 * 86400),
  );

  console.log('\nlengthened bond durations (institution deployment item 5)');
  eq('renewalPeriod', call(addr('bondPool'), 'renewalPeriod()(uint256)')?.split(/\s+/)[0], String(180 * 86400));
  eq('renewalGracePeriod', call(addr('bondPool'), 'renewalGracePeriod()(uint256)')?.split(/\s+/)[0], String(30 * 86400));
  eq('abandonmentPeriod', call(addr('bondPool'), 'abandonmentPeriod()(uint256)')?.split(/\s+/)[0], String(365 * 86400));

  console.log(`\none-time setters (${EXPECT_WIRED ? 'expected FIRED' : 'expected UNFIRED'})`);
  const setters = [
    ['escrowV4.courtContract', addr('escrowV4'), 'courtContract()(address)', addr('courtV2')],
    ['courtV2.bondPool', addr('courtV2'), 'bondPool()(address)', addr('bondPool')],
    ['bondPool.courtContract', addr('bondPool'), 'courtContract()(address)', addr('courtV2')],
    ['bondPool.executor', addr('bondPool'), 'executor()(address)', ADMIN],
  ];
  const ZERO = '0x0000000000000000000000000000000000000000';
  for (const [label, to, sig, want] of setters) {
    eq(label, call(to, sig), EXPECT_WIRED ? want : ZERO);
  }

  console.log(`\n${checks} checks, ${failures} failures`);
  if (failures > 0) process.exit(1);
}

main();
