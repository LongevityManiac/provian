import { expect } from "chai";
import { artifacts, ethers } from "hardhat";
import fs from "node:fs";
import path from "node:path";

// Independent expected value for `BOOTSTRAP_ADMIN()`. Deliberately a literal, not a
// read of the contract's own constant, or the assertion below proves nothing.
const FRANK = "0xCa37a15A64213b2ACD1784ae3f8e6Cbd4600D9D3";

function executableOpcodes(bytecode: string): number[] {
  const full = Buffer.from(bytecode.replace(/^0x/, ""), "hex");
  const metadataLength = full.length >= 2 ? full.readUInt16BE(full.length - 2) : 0;
  const codeEnd = metadataLength + 2 <= full.length ? full.length - metadataLength - 2 : full.length;
  const code = full.subarray(0, codeEnd);
  const opcodes: number[] = [];
  for (let i = 0; i < code.length; ) {
    const opcode = code[i];
    opcodes.push(opcode);
    i += 1;
    if (opcode >= 0x60 && opcode <= 0x7f) i += opcode - 0x5f;
  }
  return opcodes;
}

describe("ProvianPVT9 bounded surface", function () {
  it("deploys fresh with zero supply, no constructor authority input, and remains unarmed", async function () {
    const artifact = await artifacts.readArtifact("ProvianPVT9");
    const constructor = artifact.abi.find((item: any) => item.type === "constructor") as any;
    expect(constructor?.inputs ?? []).to.have.length(0);

    const factory = await ethers.getContractFactory("ProvianPVT9");
    const token = await factory.deploy();
    await token.waitForDeployment();
    expect(await token.totalSupply()).to.equal(0n);
    expect(await token.epochZeroArmed()).to.equal(false);
    expect(await token.operationalMinter()).to.equal(ethers.ZeroAddress);
    expect(await token.BOOTSTRAP_ADMIN()).to.equal(FRANK);
  });

  it("exposes exactly the approved state-changing ABI", async function () {
    const artifact = await artifacts.readArtifact("ProvianPVT9");
    const mutating = artifact.abi
      .filter(
        (item: any) =>
          item.type === "function" && item.stateMutability !== "view" && item.stateMutability !== "pure",
      )
      .map((item: any) => item.name)
      .sort();

    expect(mutating).to.deep.equal(
      [
        "appointOperationalMinter",
        "approve",
        "armEpochZero",
        "burn",
        "burnFrom",
        "closeGenesisAdmission",
        "openNextEpoch",
        "placeAdministrativeHold",
        "resumeFromAdministrativeHold",
        "revokeOperationalMinter",
        "scheduleAgentFoundationRate",
        "scheduleBeneficiaryVerifier",
        "scheduleCapPolicy",
        "scheduleEligibilityVerifier",
        "scheduleMintRate",
        "scheduleTreasuryDestinations",
        "settleGenesisPEBatch",
        "settleStandardPEBatch",
        "transfer",
        "transferFrom",
      ].sort(),
    );

    const allNames = new Set(
      artifact.abi.filter((item: any) => item.type === "function").map((item: any) => item.name),
    );
    for (const prohibited of [
      "mint",
      "transferAdmin",
      "renounceAdmin",
      "replaceAdmin",
      "recoverAdmin",
      "transferOwnership",
      "renounceOwnership",
      "upgradeTo",
      "upgradeToAndCall",
      "changeAdmin",
      "setExecutor",
      "setGovernanceContract",
      "delegateAuthority",
      "protocolBurn",
    ]) {
      expect(allNames.has(prohibited), `${prohibited} must be absent`).to.equal(false);
    }
  });

  it("contains no proxy opcodes or legacy settlement controls", async function () {
    const artifact = await artifacts.readArtifact("ProvianPVT9");
    const opcodes = executableOpcodes(artifact.deployedBytecode);
    expect(opcodes, "DELEGATECALL opcode").not.to.include(0xf4);
    expect(opcodes, "CALLCODE opcode").not.to.include(0xf2);
    expect(opcodes, "SELFDESTRUCT opcode").not.to.include(0xff);

    const abiText = JSON.stringify(artifact.abi).toLowerCase();
    for (const legacyTerm of [
      "peweight",
      "supplyscaler",
      "effectivemintrate",
      "baseline",
      "compositionmultiplier",
      "circuitbreaker",
      "emergencyrate",
      "genesispool",
      "constitutionexecutor",
      "humangovernance",
    ]) {
      expect(abiText, `${legacyTerm} must be absent`).not.to.include(legacyTerm);
    }

    const source = fs
      .readFileSync(path.resolve(__dirname, "../src/ProvianPVT9.sol"), "utf8")
      .toLowerCase();
    for (const prohibitedSourceTerm of [
      "genesispool",
      "peweights",
      "supplyscaler",
      "effectivemintrate",
      "delegatecall",
      "selfdestruct",
      "transferadmin",
      "transferownership",
      "renounceadmin",
      "renounceownership",
      "setgovernance",
      "upgradeto",
    ]) {
      expect(source, `${prohibitedSourceTerm} source term`).not.to.include(prohibitedSourceTerm);
    }
  });

  it("provides the policy and settlement events needed for reconciliation", async function () {
    const artifact = await artifacts.readArtifact("ProvianPVT9");
    const events = new Set(
      artifact.abi.filter((item: any) => item.type === "event").map((item: any) => item.name),
    );
    for (const required of [
      "OperationalMinterUpdated",
      "AdministrativeHoldPlaced",
      "AdministrativeHoldResumed",
      "EpochZeroArmed",
      "GenesisAdmissionClosed",
      "MintRateScheduled",
      "AgentFoundationRateScheduled",
      "TreasuryDestinationsScheduled",
      "BeneficiaryVerifierScheduled",
      "EligibilityVerifierScheduled",
      "CapPolicyScheduled",
      "EpochOpened",
      "SettlementBatchBound",
      "SettlementBatchMinted",
    ]) {
      expect(events.has(required), `${required} event`).to.equal(true);
    }
  });

  it("keeps the Base runtime configuration null, undeployed, unarmed, and legacy-inert", function () {
    const configPath = path.resolve(__dirname, "../../config/pvt9-base.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(config.status).to.equal("unconfigured");
    expect(config.assets.pvt9).to.deep.equal({
      address: null,
      abi: null,
      deployment_status: "not_deployed",
    });
    expect(config.genesis).to.deep.include({
      armed: false,
      window_approved: false,
      start_at: null,
      end_at: null,
    });
    expect(config.compatibility).to.deep.equal({
      legacy_fallback: false,
      legacy_migration: false,
      cross_chain_fallback: false,
    });
  });
});
