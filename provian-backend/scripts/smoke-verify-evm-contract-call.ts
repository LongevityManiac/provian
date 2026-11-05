/**
 * Wave J-bis verifyEvmContractCall per-chain smoke.
 *
 * Calls verifyEvmContractCall against a known Chunk II
 * setProtocolContract(escrow) tx on each of Base / Arbitrum / Optimism.
 * The expected contract is the chain's PVTv4 (the tx target).
 *
 * Run: cd provian-backend && npx ts-node scripts/smoke-verify-evm-contract-call.ts
 */

import { verifyEvmContractCall } from '../src/core/onchain/tx-verifier';

interface SmokeCase {
  chain: string;
  chainId: number;
  txHash: string;
  expectedContract: string;
  expectedFrom: string; // deployer EOA on the call
}

const FOUNDATION_SAFE = '0x94F3D06ca027dFD1e6cCaa1117b050E08D5EA936';

// All 3 setProtocolContract(escrow) txs were sent by the deployer EOA
// (admin during deploy, before transferAdmin to Foundation Safe at the end).
// expectedFrom is intentionally omitted on each case so the smoke just
// verifies tx existence + status + to-address.
const CASES: SmokeCase[] = [
  {
    chain: 'Base',
    chainId: 8453,
    txHash: '0xff8be10010f002938b62a390ecb27c70a9e9666f88f684e57b701ee28d809474',
    expectedContract: '0x23D126600BA4f606240b5F60dB4B27BD0f8EC2aD',
    expectedFrom: '',
  },
  {
    chain: 'Arbitrum',
    chainId: 42161,
    txHash: '0xd64af0117c55b9328eda9269e5c7b7625e82f766dab7b4c13589be4a6fd320c4',
    expectedContract: '0x9193BD1958773DAe4f2212E281DeBCb3BEa50bd3',
    expectedFrom: '',
  },
  {
    chain: 'Optimism',
    chainId: 10,
    txHash: '0xd64965141d4c466203b06f0cc2c8758ca01c8099d1fe7dc05b886f1f7006fa33',
    expectedContract: '0x9193BD1958773DAe4f2212E281DeBCb3BEa50bd3',
    expectedFrom: '',
  },
];

async function main(): Promise<void> {
  let allOk = true;
  for (const c of CASES) {
    process.stdout.write(`[${c.chain.padEnd(8)}] verifyEvmContractCall ${c.txHash.slice(0, 14)}...\n`);
    const result = await verifyEvmContractCall({
      chainId: c.chainId,
      txHash: c.txHash,
      expectedContract: c.expectedContract,
      minConfirmations: 1,
    });
    if (result.ok) {
      process.stdout.write(
        `             ok  block=${result.blockNumber} confirmations=${result.confirmations}\n`,
      );
    } else {
      allOk = false;
      process.stdout.write(`             FAIL reason=${result.reason}\n`);
    }
  }

  // Negative case: a deliberately wrong expectedContract on Base should
  // fail with `tx_to_mismatch`. Validates the path doesn't accept any tx.
  process.stdout.write(`[NegBase ] verifyEvmContractCall with wrong expectedContract...\n`);
  const negative = await verifyEvmContractCall({
    chainId: 8453,
    txHash: CASES[0].txHash,
    expectedContract: FOUNDATION_SAFE, // Foundation Safe is not the tx target
    minConfirmations: 1,
  });
  if (!negative.ok && negative.reason === 'tx_to_mismatch') {
    process.stdout.write(`             ok  rejected with tx_to_mismatch\n`);
  } else {
    allOk = false;
    process.stdout.write(`             FAIL expected tx_to_mismatch, got ${JSON.stringify(negative)}\n`);
  }

  if (!allOk) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('smoke crashed:', err);
  process.exit(2);
});
