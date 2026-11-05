/**
 * settlement runtime — the production `SettlementChainAdapter`.
 *
 * `settlement-cycle-runner.ts` is complete and takes its chain access as an injected port.
 * Until now the ONLY implementation of that port lived in `scripts/wp4-load-harness.ts` and
 * talked to an ephemeral fork, which is why a finished settlement engine had no production
 * runner. This module is the real implementation of the port, and nothing more.
 *
 * KEY HANDLING — READ THIS BEFORE CHANGING THE SIGNATURE
 *
 * This module NEVER reads an environment variable, never constructs a wallet, and never sees
 * key material. It takes an already-constructed `SettlementSigner` and calls it. That is
 * deliberate and load-bearing: the relay's containment posture is that no relay module builds
 * a signer from `PVT_MINTER_KEY`, and a factory here that read the env would silently break
 * it the moment this module were imported by `server.ts`. Key custody belongs to the operator
 * entrypoint (`scripts/pvt9-settlement-run.ts`), which is not mounted on any route.
 *
 * The adapter signs but does NOT decide. Every gate — epoch, cap, approval, claim identity,
 * cursor continuity, fee and transaction budget — is the runner's, and the runner refuses
 * before it ever reaches `sign`.
 */

import { Contract, JsonRpcProvider, Transaction, type Signer } from 'ethers';
import type { BatchApproverAdapter } from './batch-approval';
import { SettlementLane } from '../wp-ev/settlement-batch';
import { CombinedCapMode, type CapClockObservation } from './cap-clock';
import type {
  CycleChainObservation,
  MinedReceipt,
  NonceBlockTag,
  SafeHead,
  SettlementChainAdapter,
  SignableTransaction,
} from './settlement-cycle-runner';

/**
 * The kernel surface the adapter READS. Deliberately read-only: the settlement calldata
 * itself is built and encoded by the runner from `KERNEL_SETTLEMENT_ABI`, so no write
 * function appears here and this ABI cannot be used to compose a mint.
 */
export const KERNEL_OBSERVATION_ABI = [
  'function epochZeroArmed() view returns (bool)',
  'function epochZeroStartsAt() view returns (uint64)',
  'function lastOpenedEpoch() view returns (uint64)',
  'function administrativeHold() view returns (bool)',
  'function operationalMinter() view returns (address)',
  'function nextFinalizedCursor() view returns (uint256)',
  'function epochTotalIssued(uint64) view returns (uint256)',
  'function epochGenesisIssued(uint64) view returns (uint256)',
  'function getEpochPolicy(uint64 epoch) view returns (tuple('
    + 'bool opened, uint64 epoch, uint64 startsAt, uint8 combinedCapMode, uint256 mintRate,'
    + ' uint256 genesisCap, uint256 combinedCap, address provianTreasury, address foundationTreasury,'
    + ' uint256 agentFoundationBps,'
    + ' tuple(address verifier, bytes32 configurationId, uint64 version) beneficiaryVerifier,'
    + ' tuple(address verifier, bytes32 configurationId, uint64 version) eligibilityVerifier,'
    + ' bytes32 policyHash))',
] as const;

/**
 * The signing capability, injected. One method, and it returns a signed transaction WITHOUT
 * broadcasting — the runner records the hash durably before the wire send, so signing and
 * broadcasting must stay separable.
 */
export interface SettlementSigner {
  readonly address: string;
  signTransaction(tx: {
    readonly chainId: bigint;
    readonly to: string;
    readonly data: string;
    readonly value: bigint;
    readonly nonce: number;
    readonly gasLimit: bigint;
    readonly maxFeePerGas: bigint;
    readonly maxPriorityFeePerGas: bigint;
  }): Promise<string>;
}

export interface ProductionAdapterConfig {
  readonly rpcUrl: string;
  readonly kernelAddress: string;
  readonly chainId: bigint;
  /** Extra tip over the observed base fee, in wei. Base runs cheap; this is the floor. */
  readonly priorityFeeWei: bigint;
}

/**
 * the finality reads, injected. Production binds them to the SAME quorum-2 seams the
 * watchers use (`readAgreedBaseHead` / `readAgreedBaseSafeHead` / `readAgreedBaseBlockHash` in
 * `economic-discovery.ts`, wired in `operator-runtime.ts`), so a settle is final at exactly the
 * depth a watched deposit is and a single RPC cannot declare a block canonical. The
 * adapter never falls back to its own single-endpoint provider for any of the three.
 */
export interface SettlementFinalityPort {
  readHead(): Promise<number>;
  readSafeHead(): Promise<SafeHead | null>;
  getBlockHash(blockNumber: number): Promise<string | null>;
}

export interface ProductionAdapterDeps {
  readonly assertWriterActive?: () => Promise<void>;
  readonly signer: SettlementSigner;
  readonly finality: SettlementFinalityPort;
  readonly log?: (message: string) => void;
}

/** The kernel's per-claim mint-once map (`ProvianPVT9.sol` `claimSettled`), a view. */
export const KERNEL_CLAIM_SETTLED_ABI = ['function claimSettled(bytes32) view returns (bool)'] as const;

/**
 * Ask the ENDPOINT what chain it is, bypassing the provider's pinned answer.
 *
 * `new JsonRpcProvider(url, chainId, { staticNetwork: true })` makes `getNetwork()` return the
 * CONFIGURED value without a round trip — that is the whole point of pinning. So comparing
 * `getNetwork()` against the config, which the first version of this adapter did, compares the
 * config to itself: a guard that cannot fail. Pointed at a Sepolia endpoint it would have
 * reported Base and signed against the wrong chain.
 *
 * `send('eth_chainId')` is a raw request; it is answered by the node, not by ethers, so the
 * comparison is between two independent facts and the mismatch branch is reachable.
 * `settlement-chain-adapter.test.ts` reaches it with a transport that answers a different id.
 */
export interface RawJsonRpc {
  send(method: string, params: unknown[]): Promise<unknown>;
}

export async function readEndpointChainId(provider: RawJsonRpc): Promise<bigint> {
  const raw = await provider.send('eth_chainId', []);
  if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'bigint') {
    throw new Error(`settlement-adapter: eth_chainId returned ${typeof raw}`);
  }
  return BigInt(raw);
}

/**
 * Refuse unless the endpoint IS the configured chain.
 *
 * Extracted and exported so the mismatch branch is CONSTRUCTIBLE: inlined against a pinned
 * provider it was unreachable, which is precisely the run contract's "unreachable branch"
 * defect. Taking the raw-JSON-RPC interface rather than a `JsonRpcProvider` is the input-type
 * widening that makes the violating case buildable in a test while production still passes the
 * real provider.
 */
export async function assertEndpointChainId(
  provider: RawJsonRpc,
  configuredChainId: bigint,
): Promise<bigint> {
  const endpointChainId = await readEndpointChainId(provider);
  if (endpointChainId !== configuredChainId) {
    throw new Error(
      `settlement-adapter: chain id mismatch (configured ${configuredChainId}, rpc ${endpointChainId})`,
    );
  }
  return endpointChainId;
}

/**
 * Build the production adapter.
 *
 * `staticNetwork` pins the provider to the configured chain id: without it ethers will happily
 * follow whatever chain the RPC endpoint claims to be, and a settlement signed for the wrong
 * chain is a settlement signed for a chain where the nonce means something else. The pin is
 * why the guard below must ask the endpoint directly — see `readEndpointChainId`.
 */
export function createProductionChainAdapter(
  config: ProductionAdapterConfig,
  deps: ProductionAdapterDeps,
): SettlementChainAdapter {
  const provider = new JsonRpcProvider(config.rpcUrl, Number(config.chainId), {
    staticNetwork: true,
  });
  const kernel = new Contract(
    config.kernelAddress,
    KERNEL_OBSERVATION_ABI as unknown as string[],
    provider,
  );
  const claimView = new Contract(
    config.kernelAddress,
    KERNEL_CLAIM_SETTLED_ABI as unknown as string[],
    provider,
  );

  return {
    async observe(): Promise<CycleChainObservation> {
      const block = await provider.getBlock('latest');
      if (block === null) throw new Error('settlement-adapter: latest block unavailable');

      // Asked of the ENDPOINT, not of the pinned provider: the whole point is that a mismatch
      // must be an error rather than a silent switch to whatever answered.
      const endpointChainId = await assertEndpointChainId(provider, config.chainId);

      const lastOpenedEpoch = Number(await kernel.lastOpenedEpoch());
      const policy = await kernel.getEpochPolicy(lastOpenedEpoch);

      return {
        epochZeroArmed: Boolean(await kernel.epochZeroArmed()),
        epochZeroStartsAtSec: Number(await kernel.epochZeroStartsAt()),
        lastOpenedEpoch,
        administrativeHold: Boolean(await kernel.administrativeHold()),
        operationalMinter: String(await kernel.operationalMinter()),
        settlementSigner: deps.signer.address,
        observedAtSec: Number(block.timestamp),
        nextFinalizedCursor: BigInt(await kernel.nextFinalizedCursor()),
        openEpochPolicyHash: String(policy.policyHash),
        kernelAddress: config.kernelAddress,
        mintRateAtomic: BigInt(policy.mintRate),
        agentFoundationBps: BigInt(policy.agentFoundationBps),
        genesisCapAtomic: BigInt(policy.genesisCap),
        combinedCapAtomic: BigInt(policy.combinedCap),
        epochGenesisIssuedAtomic: BigInt(await kernel.epochGenesisIssued(lastOpenedEpoch)),
        epochTotalIssuedAtomic: BigInt(await kernel.epochTotalIssued(lastOpenedEpoch)),
        chainId: endpointChainId,
      };
    },

    async getTransactionCount(address: string, blockTag: NonceBlockTag = 'latest'): Promise<number> {
      // The runner combines the canonical count with its durable signed attempts.
      // Exact heights resolve consumed nonces at the accepted confirmation boundary.
      return provider.getTransactionCount(address, blockTag);
    },

    async feeData() {
      const block = await provider.getBlock('latest');
      const baseFee = block?.baseFeePerGas ?? 1_000_000n;
      const priority = config.priorityFeeWei;
      // 2x base fee headroom absorbs one full block of base-fee growth between signing and
      // inclusion; the runner's replacement path handles anything beyond that.
      return { maxFeePerGasWei: baseFee * 2n + priority, maxPriorityFeePerGasWei: priority };
    },

    async estimateGas(tx) {
      return provider.estimateGas({ from: tx.from, to: tx.to, data: tx.data });
    },

    async simulate(tx) {
      try {
        await provider.call({ from: tx.from, to: tx.to, data: tx.data });
        return { ok: true, revertReason: null };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, revertReason: message.slice(0, 200) };
      }
    },

    async sign(tx: SignableTransaction) {
      const raw = await deps.signer.signTransaction({
        chainId: config.chainId,
        to: tx.to,
        data: tx.data,
        value: tx.valueWei,
        nonce: tx.nonce,
        gasLimit: tx.gasLimit,
        maxFeePerGas: tx.maxFeePerGasWei,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGasWei,
      });
      const hash = Transaction.from(raw).hash;
      if (hash === null) throw new Error('settlement-adapter: signed transaction has no hash');
      return { raw, hash };
    },

    async broadcast(raw: string) {
      await deps.assertWriterActive?.();
      await provider.send('eth_sendRawTransaction', [raw]);
      deps.log?.('settlement-adapter: broadcast');
    },

    async getReceipt(txHash: string): Promise<MinedReceipt | null> {
      const receipt = await provider.getTransactionReceipt(txHash);
      if (receipt === null) return null;
      return {
        status: receipt.status === 1 ? 'success' : 'reverted',
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash.toLowerCase(),
        gasUsed: receipt.gasUsed,
        effectiveGasPriceWei: receipt.gasPrice,
      };
    },

    readSafeHead: () => deps.finality.readSafeHead(),
    readHead: () => deps.finality.readHead(),
    getBlockHash: (blockNumber: number) => deps.finality.getBlockHash(blockNumber),

    async isClaimSettled(claimId: string, blockTag?: number): Promise<boolean> {
      // a height-tagged read answers AT that block (the safe block), never `latest`.
      return Boolean(blockTag === undefined
        ? await claimView.claimSettled(claimId)
        : await claimView.claimSettled(claimId, { blockTag }));
    },
  };
}

// ---------------------------------------------------------------------------
// The eligibility-verifier approver — the SECOND gas payer
// ---------------------------------------------------------------------------

/**
 * The deployed verifier's surface. `approve*` are state-changing and `onlyBatchApprover`;
 * `verify*` are views. Both approve calls RETURN the digest the verifier derived, and the
 * approval gate asserts that against its own — which is what makes a mirror drift a refusal
 * rather than a silent mismatch discovered on-chain.
 */
export const VERIFIER_ABI = [
  'function approveStandardBatch(bytes32 batchId, uint64 epoch, bytes32 policyHash, uint256 finalizedCursorStart, uint256 finalizedCursorEnd, (address contributor, uint8 beneficiaryClass, uint256 claimCount)[] recipients, (bytes32 claimId, uint256 recordPointsAtomic)[] claims) returns (bytes32)',
  'function approveGenesisBatch(bytes32 batchId, uint64 epoch, bytes32 policyHash, uint256 finalizedCursorStart, uint256 finalizedCursorEnd, (address contributor, uint256 claimCount)[] recipients, (bytes32 claimId, bytes32 walletId, bytes32 oneTimeAnchor, uint8 grantType, uint64 qualifiedAt, uint256 reservedGrossAtomic)[] claims) returns (bytes32)',
  'function verifyStandardBatch(bytes32 settlementDigest, bytes32 configurationId, uint64 configurationVersion) view returns (bool)',
  'function verifyGenesisBatch(bytes32 settlementDigest, bytes32 configurationId, uint64 configurationVersion) view returns (bool)',
] as const;

export interface ApproverConfig {
  readonly verifierAddress: string;
  readonly kernelAddress: string;
  readonly chainId: bigint;
  /** The verifier configuration this epoch's policy snapshotted. */
  readonly configurationId: string;
  readonly configurationVersion: bigint;
}

/**
 * Fail if an approve transaction did not mine successfully.
 *
 * A reverted approve records NOTHING on the verifier; without this check the digest is returned
 * as if the approval landed, and the failure resurfaces downstream as the misleading
 * `approval_not_affirmed` rather than the real cause. Mirrors the epoch keeper's
 * `receipt.status !== 1` guard. The throw is caught by the approval gate's try/catch and
 * surfaces as `approval_call_failed`. Exported so the revert case is an executable control.
 */
export function assertApproveMined(
  receipt: { readonly status?: number | null } | null,
  method: string,
  txHash: string | null,
): void {
  if (receipt === null || receipt.status !== 1) {
    throw new Error(`settlement-adapter: ${method} reverted (tx ${txHash})`);
  }
}

/**
 * Build the production approver.
 *
 * The approve leg is a REAL transaction from a SEPARATE EOA (`onlyBatchApprover`), so this
 * signer must be funded independently of the settlement minter. Its gas is not counted in the
 * runner's fee accounting, which tracks only the settle leg.
 *
 * `isAffirmed` is a view and is asked BEFORE settling; an approval that did not land makes the
 * settle a guaranteed revert, so the gate refuses rather than spending gas to discover it.
 * A throw here is never an approval — the gate treats an unreachable verifier as a refusal.
 */
export function createProductionApprover(
  config: ApproverConfig,
  signer: Signer,
): BatchApproverAdapter {
  const verifier = new Contract(
    config.verifierAddress,
    VERIFIER_ABI as unknown as string[],
    signer,
  );
  // The kernel, read-only, for the leg-aware `already_minted` relaxation. A view call
  // over the signer's provider — no key material, no transaction. `claimSettled` is the kernel's
  // per-claim authority (`ProvianPVT9.sol:186`), the same map `settleStandardPEBatch` checks
  // before minting, so the gate and the chain agree on what "already paid" means for one leg.
  const kernel = new Contract(
    config.kernelAddress,
    ['function claimSettled(bytes32) view returns (bool)'],
    signer,
  );

  return {
    kernelAddress: config.kernelAddress,
    chainId: config.chainId,

    async isAffirmed(settlementDigest: string, lane: SettlementLane): Promise<boolean> {
      const fn = lane === SettlementLane.GenesisPE ? 'verifyGenesisBatch' : 'verifyStandardBatch';
      return Boolean(await verifier[fn](
        settlementDigest, config.configurationId, config.configurationVersion,
      ));
    },

    async isClaimSettled(claimId: string): Promise<boolean> {
      return Boolean(await kernel.claimSettled(claimId));
    },

    async approveStandardBatch({ header, recipients, claims }): Promise<string> {
      // `staticCall` first: it returns the digest the verifier WOULD derive without spending
      // gas, so a mirror drift is caught before a transaction rather than after one.
      const args = [
        header.batchId, header.epoch, header.policyHash,
        header.finalizedCursorStart, header.finalizedCursorEnd,
        recipients.map((r) => [r.contributor, r.beneficiaryClass, r.claimCount]),
        claims.map((c) => [c.claimId, c.recordPointsAtomic]),
      ] as const;
      const digest = String(await verifier.approveStandardBatch.staticCall(...args));
      const tx = await verifier.approveStandardBatch(...args);
      assertApproveMined(await tx.wait(), 'approveStandardBatch', tx.hash);
      return digest;
    },

    async approveGenesisBatch({ header, recipients, claims }): Promise<string> {
      const args = [
        header.batchId, header.epoch, header.policyHash,
        header.finalizedCursorStart, header.finalizedCursorEnd,
        recipients.map((r) => [r.contributor, r.claimCount]),
        claims.map((c) => [
          c.claimId, c.walletId, c.oneTimeAnchor, c.grantType, c.qualifiedAt, c.reservedGrossAtomic,
        ]),
      ] as const;
      const digest = String(await verifier.approveGenesisBatch.staticCall(...args));
      const tx = await verifier.approveGenesisBatch(...args);
      assertApproveMined(await tx.wait(), 'approveGenesisBatch', tx.hash);
      return digest;
    },
  };
}

/**
 * Read exactly what the cap-death clock needs, including the combined cap MODE.
 *
 * Separate from `observe()` because `CycleChainObservation` is the runner's contract and does
 * not carry the mode. Reading it here rather than assuming Automatic is what keeps the clock
 * from alarming on a kernel that has already been moved to a Fixed cap.
 */
export async function readCapClockObservation(
  config: Pick<ProductionAdapterConfig, 'rpcUrl' | 'kernelAddress' | 'chainId'>,
): Promise<CapClockObservation> {
  const provider = new JsonRpcProvider(config.rpcUrl, Number(config.chainId), {
    staticNetwork: true,
  });
  const kernel = new Contract(
    config.kernelAddress,
    KERNEL_OBSERVATION_ABI as unknown as string[],
    provider,
  );
  const block = await provider.getBlock('latest');
  if (block === null) throw new Error('cap-clock: latest block unavailable');
  const lastOpenedEpoch = Number(await kernel.lastOpenedEpoch());
  const policy = await kernel.getEpochPolicy(lastOpenedEpoch);

  return {
    epochZeroArmed: Boolean(await kernel.epochZeroArmed()),
    epochZeroStartsAtSec: Number(await kernel.epochZeroStartsAt()),
    combinedCapMode: Number(policy.combinedCapMode) === 1
      ? CombinedCapMode.Fixed
      : CombinedCapMode.Automatic,
    totalIssuedAtomic: BigInt(await kernel.epochTotalIssued(lastOpenedEpoch)),
    nextFinalizedCursor: BigInt(await kernel.nextFinalizedCursor()),
    observedAtSec: Number(block.timestamp),
  };
}
