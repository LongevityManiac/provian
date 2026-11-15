/**
 * settlement runtime — the production chain adapter's guards.
 *
 * The chain-id guard is the reason this file exists. Its first version compared
 * `provider.getNetwork()` against the configured chain id — but the provider is constructed
 * with `staticNetwork: true` and an explicit network, so `getNetwork()` RETURNS the configured
 * value without asking anyone. The guard compared the config to itself and could not fail:
 * pointed at a Sepolia endpoint it would have reported Base and signed against the wrong
 * chain. A guard that cannot fail is the defect this repo keeps finding, and the only proof it
 * is fixed is a test that makes it fail.
 */

import {
  KERNEL_OBSERVATION_ABI,
  VERIFIER_ABI,
  assertApproveMined,
  assertEndpointChainId,
  readEndpointChainId,
} from './settlement-chain-adapter';

/** A transport that answers `eth_chainId` with whatever the test says, and nothing else. */
function endpoint(chainId: unknown): { send(method: string, params: unknown[]): Promise<unknown> } {
  return {
    async send(method: string) {
      if (method !== 'eth_chainId') throw new Error(`unexpected method ${method}`);
      return chainId;
    },
  };
}

const BASE_MAINNET = 8453n;
const BASE_SEPOLIA = 84532n;

describe('endpoint chain id', () => {
  it('reads the hex string an EVM node actually returns', async () => {
    expect(await readEndpointChainId(endpoint('0x2105'))).toBe(BASE_MAINNET);
    expect(await readEndpointChainId(endpoint('0x14a34'))).toBe(BASE_SEPOLIA);
    // Some transports decode it before ethers sees it.
    expect(await readEndpointChainId(endpoint(8453))).toBe(BASE_MAINNET);
    expect(await readEndpointChainId(endpoint(8453n))).toBe(BASE_MAINNET);
  });

  it('passes when the endpoint IS the configured chain', async () => {
    await expect(assertEndpointChainId(endpoint('0x2105'), BASE_MAINNET))
      .resolves.toBe(BASE_MAINNET);
  });

  it('RED CONTROL: REFUSES a Sepolia endpoint configured as Base mainnet', async () => {
    // This is the case the old guard could not see. It is the whole point of the file.
    await expect(assertEndpointChainId(endpoint('0x14a34'), BASE_MAINNET))
      .rejects.toThrow('chain id mismatch');
    await expect(assertEndpointChainId(endpoint('0x14a34'), BASE_MAINNET))
      .rejects.toThrow('rpc 84532');
  });

  it('refuses a response it cannot decode rather than coercing it', async () => {
    await expect(assertEndpointChainId(endpoint(null), BASE_MAINNET)).rejects.toThrow('eth_chainId');
    await expect(assertEndpointChainId(endpoint({ chainId: 8453 }), BASE_MAINNET))
      .rejects.toThrow('eth_chainId');
  });

  it('propagates a transport failure instead of assuming the configured chain', async () => {
    const broken = {
      async send() { throw new Error('rpc down'); },
    };
    await expect(assertEndpointChainId(broken, BASE_MAINNET)).rejects.toThrow('rpc down');
  });
});

describe('ABI surfaces', () => {
  it('the observation ABI is READ-ONLY — it cannot be used to compose a mint', () => {
    // Settlement calldata is built by the runner from its own ABI. If a state-changing
    // signature ever appeared here, this module would gain the ability to write.
    const isView = (signature: string): boolean => /\bview\b/.test(signature);
    expect(KERNEL_OBSERVATION_ABI.length).toBeGreaterThan(0); // empty-population guard
    for (const signature of KERNEL_OBSERVATION_ABI) expect(isView(signature)).toBe(true);

    // Named explicitly, because a `view`-suffix check alone would pass a mutating function
    // someone mislabelled. These are every state-changing entrypoint on the kernel that a
    // settler could otherwise compose.
    const forbidden = [
      'settleStandardPEBatch', 'settleGenesisPEBatch', 'openNextEpoch', 'appointOperationalMinter',
      'scheduleCapPolicy', 'placeAdministrativeHold', 'closeGenesisAdmission',
    ];
    for (const name of forbidden) {
      expect(KERNEL_OBSERVATION_ABI.some((s) => s.includes(name))).toBe(false);
    }

    // RED CONTROL: the same predicate applied to a write signature must fail, so the loop
    // above is testing something rather than passing over a vacuously-satisfied list.
    expect(isView('function settleStandardPEBatch(bytes32 batchId) returns (bool)')).toBe(false);
  });

  it('the verifier ABI exposes exactly the two approvals and the two views', () => {
    const names = VERIFIER_ABI.map((s) => s.replace(/^function\s+(\w+).*$/, '$1'));
    expect(names.sort()).toEqual([
      'approveGenesisBatch', 'approveStandardBatch', 'verifyGenesisBatch', 'verifyStandardBatch',
    ]);
    // `revokeBatchApproval` exists on the contract and is deliberately NOT here: an adapter
    // that can un-approve a batch mid-cycle is an adapter that can strand a submitted batch.
    expect(names).not.toContain('revokeBatchApproval');
  });
});

describe('assertApproveMined — a reverted approve must not read as a recorded approval', () => {
  // Without this guard the adapter returns the staticCall digest as if the approve landed, and
  // the failure resurfaces downstream as the misleading `approval_not_affirmed` rather than the
  // real revert. The throw is caught by the approval gate and surfaces as `approval_call_failed`.
  it('throws on a reverted receipt (status 0)', () => {
    expect(() => assertApproveMined({ status: 0 }, 'approveGenesisBatch', '0xabc'))
      .toThrow('approveGenesisBatch reverted');
  });

  it('throws on a null receipt (never mined / replaced)', () => {
    expect(() => assertApproveMined(null, 'approveStandardBatch', '0xdef'))
      .toThrow('approveStandardBatch reverted');
  });

  // CONTROL: a mined receipt must NOT throw — otherwise the guard above would reject every
  // approval, including the ones that succeeded, and could not distinguish revert from success.
  it('CONTROL — passes on a mined receipt (status 1)', () => {
    expect(() => assertApproveMined({ status: 1 }, 'approveGenesisBatch', '0x1')).not.toThrow();
  });
});
