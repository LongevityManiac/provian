/**
 * (round-robin fairness) — the anchor-runtime constructors are load-bearing
 * and, being in SANCTIONED_MINT_SIGNER_FILES, are SKIPPED by the signer sweep.
 * These tests guard the two properties nothing else can see:
 * (a) fail-closed: both constructors return null on missing/malformed env —
 * the posture the scheduler handlers and pe-verify depend on;
 * (b) the READ constructor never touches key material — its runner must have
 * no signing capability, so request-path deps can never carry a key.
 */
import { describe, it, expect } from '@jest/globals';
import { ethers } from 'ethers';
import {
  buildPeAnchorReadContract,
  buildPeAnchorSignerContract,
  isPeAnchorRuntimeConfigured,
} from './pe-anchor-runtime';

// Deterministic throwaway key (a well-known test vector, NOT a real secret).
const TEST_KEY = '0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d';
const TEST_ADDRESS = '0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1';
const ANCHOR = '0x889A59A847e490c5Cc91f281468AbAacc100a9fD';

const provider = () => new ethers.JsonRpcProvider('http://127.0.0.1:1', 8453, { staticNetwork: true });

describe('pe-anchor-runtime — fail-closed construction (defect 3)', () => {
  it('both constructors return null when either env half is missing', () => {
    expect(buildPeAnchorSignerContract(provider, {})).toBeNull();
    expect(buildPeAnchorSignerContract(provider, { PVT_MINTER_KEY: TEST_KEY })).toBeNull();
    expect(buildPeAnchorSignerContract(provider, { PE_ANCHOR_CONTRACT_ADDRESS: ANCHOR })).toBeNull();
    expect(buildPeAnchorReadContract(provider, {})).toBeNull();
    expect(isPeAnchorRuntimeConfigured({})).toBe(false);
    expect(isPeAnchorRuntimeConfigured({ PVT_MINTER_KEY: TEST_KEY })).toBe(false);
  });

  it('a malformed key or address yields null, never a throw', () => {
    expect(buildPeAnchorSignerContract(provider, {
      PVT_MINTER_KEY: 'not-a-key',
      PE_ANCHOR_CONTRACT_ADDRESS: ANCHOR,
    })).toBeNull();
    expect(buildPeAnchorSignerContract(provider, {
      PVT_MINTER_KEY: TEST_KEY,
      PE_ANCHOR_CONTRACT_ADDRESS: 'not-an-address',
    })).toBeNull();
    expect(buildPeAnchorReadContract(provider, {
      PE_ANCHOR_CONTRACT_ADDRESS: 'not-an-address',
    })).toBeNull();
  });

  it('the SIGNER constructor binds a Wallet runner at the derived address', () => {
    const contract = buildPeAnchorSignerContract(provider, {
      PVT_MINTER_KEY: TEST_KEY,
      PE_ANCHOR_CONTRACT_ADDRESS: ANCHOR,
    });
    expect(contract).not.toBeNull();
    const runner = contract!.runner as ethers.Wallet;
    expect(runner).toBeInstanceOf(ethers.Wallet);
    expect(runner.address).toBe(TEST_ADDRESS);
  });

  it('[the load-bearing negative] the READ constructor carries NO signing capability', () => {
    const contract = buildPeAnchorReadContract(provider, {
      // Even with a key PRESENT in the env, the read constructor must ignore it.
      PVT_MINTER_KEY: TEST_KEY,
      PE_ANCHOR_CONTRACT_ADDRESS: ANCHOR,
    });
    expect(contract).not.toBeNull();
    const runner = contract!.runner;
    expect(runner).not.toBeInstanceOf(ethers.Wallet);
    expect(runner).not.toBeInstanceOf(ethers.AbstractSigner);
    // A provider runner has no signTransaction; a signer would.
    expect((runner as { signTransaction?: unknown }).signTransaction).toBeUndefined();
  });

  it('isPeAnchorRuntimeConfigured is true iff both halves are present', () => {
    expect(isPeAnchorRuntimeConfigured({
      PVT_MINTER_KEY: TEST_KEY,
      PE_ANCHOR_CONTRACT_ADDRESS: ANCHOR,
    })).toBe(true);
  });
});
