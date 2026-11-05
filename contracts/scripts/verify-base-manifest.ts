import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Standalone drift-catcher for contracts/deployments/base-sprint.json.
 *
 * The bootstrap script runs its own verification pass at deploy time, but
 * that proves the state was correct once - not that it stayed correct. This
 * script reads the manifest as the source of truth and asserts the on-chain
 * state still matches, catching post-deploy admin rotations, protocol-
 * contract unregistrations, or any other drift.
 *
 * Reuses the same assertions the bootstrap uses. Expected values come from
 * the manifest (config.admin, contracts.governance, etc.) - not from script
 * inputs - so this catches divergence between "what we think we deployed"
 * and "what the chain actually holds."
 *
 * Usage:
 *   npx hardhat run scripts/verify-base-manifest.ts --network base
 *
 * Exit codes:
 *   0 - manifest matches on-chain state
 *   1 - drift detected (details printed)
 *   2 - manifest missing or malformed
 */

const ALLOWED_CHAIN_ID = 8453n;
const MANIFEST_FILENAME = "base-sprint.json";

interface Manifest {
  version: string;
  network: string;
  chainId: number;
  contracts: Record<string, string>;
  wiring: Record<string, string>;
  config: {
    admin: string;
    minter: string;
    feeWallet: string;
    provianTreasury: string;
    foundationTreasury: string;
    provianTechWallet: string;
    usdc: string;
    [k: string]: unknown;
  };
  deployer: string;
  timestamp: string;
}

function loadManifest(): Manifest {
  const p = path.join(__dirname, "..", "deployments", MANIFEST_FILENAME);
  if (!fs.existsSync(p)) {
    console.error(`ERROR: manifest not found at ${p}`);
    process.exit(2);
  }
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as Manifest;
  } catch (e) {
    console.error(`ERROR: manifest malformed: ${(e as Error).message}`);
    process.exit(2);
  }
}

async function main(): Promise<void> {
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== ALLOWED_CHAIN_ID) {
    throw new Error(
      `REFUSED: verify-base-manifest.ts targets Base mainnet (chainId ${ALLOWED_CHAIN_ID}). ` +
      `Got chainId ${network.chainId}.`,
    );
  }

  const m = loadManifest();
  if (m.chainId !== Number(ALLOWED_CHAIN_ID)) {
    console.error(`ERROR: manifest.chainId=${m.chainId} does not match current network ${ALLOWED_CHAIN_ID}`);
    process.exit(2);
  }

  const required = ["pvtV3", "peAnchor", "governance", "escrowV3", "promiseV2", "poolV2", "courtV2", "bondPool"];
  for (const key of required) {
    if (!m.contracts[key]) {
      console.error(`ERROR: manifest missing contracts.${key}`);
      process.exit(2);
    }
  }

  const pvtAddr = m.contracts.pvtV3;
  const peAnchorAddr = m.contracts.peAnchor;
  const governanceAddr = m.contracts.governance;
  const escrowAddr = m.contracts.escrowV3;
  const promiseAddr = m.contracts.promiseV2;
  const poolAddr = m.contracts.poolV2;
  const courtAddr = m.contracts.courtV2;
  const bondPoolAddr = m.contracts.bondPool;

  console.log("========================================================");
  console.log("  verify-base-manifest - reading on-chain state");
  console.log("========================================================");
  console.log(`Manifest:  ${MANIFEST_FILENAME}`);
  console.log(`Network:   base (chainId ${network.chainId})`);
  console.log(`Recorded:  admin=${m.config.admin}`);
  console.log("");

  const pvt = await ethers.getContractAt("ProvianPVTv3", pvtAddr);
  const peAnchor = await ethers.getContractAt("ProvianPEAnchor", peAnchorAddr);
  const governance = await ethers.getContractAt("ProvianGovernance", governanceAddr);
  const escrow = await ethers.getContractAt("ProvianEscrowV3", escrowAddr);
  const court = await ethers.getContractAt("ProvianCourtV2", courtAddr);
  const bondPool = await ethers.getContractAt("ProvianBondPool", bondPoolAddr);

  const failures: string[] = [];
  const rows: Array<{ contract: string; address: string; fields: Record<string, string> }> = [];

  function check(label: string, actual: string, expected: string): string {
    const pass = actual.toLowerCase() === expected.toLowerCase();
    if (!pass) failures.push(`${label}: got ${actual}, expected ${expected}`);
    return pass ? actual : `MISMATCH(${actual} ≠ ${expected})`;
  }

  async function assertHasCode(label: string, addr: string): Promise<void> {
    const code = await ethers.provider.getCode(addr);
    if (!code || code === "0x") failures.push(`${label}: no bytecode at ${addr}`);
  }

  for (const [key, addr] of Object.entries(m.contracts)) {
    if (typeof addr === "string") await assertHasCode(`${key}.bytecode`, addr);
  }

  {
    const admin = await pvt.admin();
    const minter = await pvt.minter();
    const gov = await pvt.governanceContract();
    const crt = await pvt.courtContract();
    const protoEscrow = await pvt.protocolContracts(escrowAddr);
    const protoPromise = await pvt.protocolContracts(promiseAddr);
    const protoPool = await pvt.protocolContracts(poolAddr);
    const protoBond = await pvt.protocolContracts(bondPoolAddr);
    rows.push({
      contract: "ProvianPVTv3",
      address: pvtAddr,
      fields: {
        admin: check("pvt.admin", admin, m.config.admin),
        minter: check("pvt.minter", minter, m.config.minter),
        governance: check("pvt.governance", gov, governanceAddr),
        court: check("pvt.court", crt, courtAddr),
        "protocol(escrow)": protoEscrow ? "true" : (failures.push("pvt.protocolContracts(escrow)=false"), "false"),
        "protocol(promise)": protoPromise ? "true" : (failures.push("pvt.protocolContracts(promise)=false"), "false"),
        "protocol(pool)": protoPool ? "true" : (failures.push("pvt.protocolContracts(pool)=false"), "false"),
        "protocol(bondPool)": protoBond ? "true" : (failures.push("pvt.protocolContracts(bondPool)=false"), "false"),
      },
    });
  }

  {
    const admin = await peAnchor.admin();
    const minter = await peAnchor.minter();
    rows.push({
      contract: "ProvianPEAnchor",
      address: peAnchorAddr,
      fields: {
        admin: check("peAnchor.admin", admin, m.config.admin),
        minter: check("peAnchor.minter", minter, m.config.minter),
      },
    });
  }

  {
    const admin = await governance.admin();
    const pvtRef = await governance.pvtContract();
    const minter = await governance.minter();
    rows.push({
      contract: "ProvianGovernance",
      address: governanceAddr,
      fields: {
        admin: check("governance.admin", admin, m.config.admin),
        pvtContract: check("governance.pvtContract", pvtRef, pvtAddr),
        minter: check("governance.minter", minter, m.config.minter),
      },
    });
  }

  {
    const admin = await escrow.admin();
    const feeWallet = await escrow.feeWallet();
    const courtRef = await escrow.courtContract();
    rows.push({
      contract: "ProvianEscrowV3",
      address: escrowAddr,
      fields: {
        admin: check("escrow.admin", admin, m.config.admin),
        feeWallet: check("escrow.feeWallet", feeWallet, m.config.feeWallet),
        courtContract: check("escrow.courtContract", courtRef, courtAddr),
      },
    });
  }

  {
    const admin = await court.admin();
    const escrowRef = await court.escrowContract();
    // The court↔token binding, read through a LOCAL one-line fragment rather
    // than the shared artifact ABI.
    //
    // This script verifies one HISTORICAL deployment (base-sprint.json, court
    // deployed 2026-04-23). That court's immutable bytecode still has `pvt()`,
    // so the invariant below is exactly as true as it ever was. What changed is
    // only local: the reputation-stake drop removed `pvt` from ProvianCourtV2's
    // SOURCE, so `getContractAt` no longer builds a wrapper carrying the getter.
    // Declaring the fragment here restores the original check without reaching
    // for the artifact — and without asserting ABSENCE, which would be the wrong
    // direction for a historical target and would make this script permanently
    // red, masking every other field it verifies.
    const courtPvtView = new ethers.Contract(
      courtAddr,
      ["function pvt() view returns (address)"],
      ethers.provider,
    );
    const pvtRefCourt: string = await courtPvtView.pvt();
    rows.push({
      contract: "ProvianCourtV2",
      address: courtAddr,
      fields: {
        admin: check("court.admin", admin, m.config.admin),
        escrowContract: check("court.escrowContract", escrowRef, escrowAddr),
        pvt: check("court.pvt", pvtRefCourt, pvtAddr),
      },
    });
  }

  {
    const admin = await bondPool.admin();
    const techWallet = await bondPool.provianTechWallet();
    const pvtRef = await bondPool.pvt();
    const courtRef = await bondPool.courtContract();
    const govRef = await bondPool.governanceContract();
    rows.push({
      contract: "ProvianBondPool",
      address: bondPoolAddr,
      fields: {
        admin: check("bondPool.admin", admin, m.config.admin),
        provianTechWallet: check("bondPool.provianTechWallet", techWallet, m.config.provianTechWallet),
        pvt: check("bondPool.pvt", pvtRef, pvtAddr),
        courtContract: check("bondPool.courtContract", courtRef, courtAddr),
        governanceContract: check("bondPool.governanceContract", govRef, governanceAddr),
      },
    });
  }

  for (const row of rows) {
    console.log(`${row.contract}  ${row.address}`);
    for (const [k, v] of Object.entries(row.fields)) {
      console.log(`  ${k.padEnd(22)}  ${v}`);
    }
    console.log("");
  }

  if (failures.length > 0) {
    console.error(`\nDRIFT DETECTED (${failures.length}):`);
    for (const f of failures) console.error(`  - ${f}`);
    console.error("\nManifest and chain state diverge. Investigate before relying on this deployment.");
    process.exit(1);
  }

  console.log("========================================================");
  console.log(`  OK - manifest matches on-chain state (${rows.length} contracts checked)`);
  console.log("========================================================");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
