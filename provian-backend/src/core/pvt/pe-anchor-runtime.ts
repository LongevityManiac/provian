import { CanonicalWallet } from '../onchain/canonical-wallet';
/**
 * PE-anchor runtime construction (B10, the design requires ARM).
 *
 * THE ONE module that constructs the PE-ANCHOR signer. Declared in
 * `mint-capability-guard.ts::SANCTIONED_MINT_SIGNER_FILES` a POSITIVE,
 * deliberate on-chain-write capability at a named location, exactly like the
 * settlement runtime's `wp4/operator-runtime.ts`. What this signer can and
 * cannot do, stated precisely:
 *
 * - It signs `ProvianPEAnchor.anchorPEBatch` transactions on the
 * DEPLOYED anchor contract `0x889A59A8…` (the `PE_ANCHOR_CONTRACT_ADDRESS`
 * Cloud Run has carried all along). That contract stores Merkle roots and
 * batch metadata. It holds no funds, mints no PVT, and grants no economic
 * authority — verified its roles are operational-only (admin = the
 * Foundation Safe, per the standing rule it STAYS there; minter = the
 * gas-only anchoring EOA `PVT_MINTER_KEY` resolves to).
 * - The kernel, settlement, Genesis, and every other value path are
 * untouched: this module never reads the PVT9 settlement keys and the
 * anchor contract has zero coupling to the successor kernel.
 *
 * recorded the restoration recipe this module implements: "stop
 * hardcoding null, wire the live contract in" + the runtime boundary boundary leg — no
 * broadcast, no gas beyond the ~1 tx/day anchoring itself (~$0.19/mo
 * measured), no new address.
 *
 * Two constructors, deliberately separate:
 * - `buildPeAnchorSignerContract` signer-bearing, for the two scheduler
 * runs (daily anchor + one-time backfill) ONLY. Never put this in
 * request-path router deps.
 * - `buildPeAnchorReadContract` provider-only (no key material at all),
 * for `POST /v1/pe/verify`'s on-chain proof reads.
 *
 * Both return null when the runtime is unconfigured (missing key or address),
 * and every consumer fails closed on null — same posture as before B10, so a
 * misconfigured environment degrades to the pre-B10 behavior, never to a
 * fabricated answer.
 */

import { ethers } from 'ethers';
import { PE_ANCHOR_ABI } from '../agent-bank/types';

export interface PeAnchorRuntimeEnv {
  readonly PVT_MINTER_KEY?: string;
  readonly PE_ANCHOR_CONTRACT_ADDRESS?: string;
}

/** Provider factory injected by server.ts (its pooled `getChainProvider`). */
export type BaseProviderFactory = () => ethers.Provider;

/**
 * Pure configured-ness check for the DISCOVERY surfaces (, review
 * defect 4): openapi/ecosystem derive their anchoring truth claims from this
 * instead of publishing unconditional constants — an unconfigured environment
 * must answer `pe_anchoring_active: false`, matching what the routes and
 * schedulers actually serve (the same honest derivation pe-verify already
 * makes per-request). Reads two env presences; constructs nothing, touches no
 * key material.
 */
export function isPeAnchorRuntimeConfigured(
  env: PeAnchorRuntimeEnv = process.env as PeAnchorRuntimeEnv,
): boolean {
  return typeof env.PVT_MINTER_KEY === 'string' && env.PVT_MINTER_KEY.length > 0
    && typeof env.PE_ANCHOR_CONTRACT_ADDRESS === 'string'
    && env.PE_ANCHOR_CONTRACT_ADDRESS.length > 0;
}

/**
 * Checksum-validate the anchor address BEFORE construction. `ethers.Contract`
 * accepts any string (it would treat garbage as an ENS name and fail only at
 * call time), so without this the "malformed address → null" fail-closed
 * property would be a comforting falsehood — the review's exact concern.
 */
function validAnchorAddress(address: string | undefined): string | null {
  if (!address) return null;
  try {
    return ethers.getAddress(address);
  } catch {
    return null;
  }
}

export function buildPeAnchorSignerContract(
  getBaseProvider: BaseProviderFactory,
  env: PeAnchorRuntimeEnv = process.env as PeAnchorRuntimeEnv,
): ethers.Contract | null {
  const minterKey = env.PVT_MINTER_KEY;
  const address = validAnchorAddress(env.PE_ANCHOR_CONTRACT_ADDRESS);
  if (!minterKey || !address) return null;
  try {
    const signer = new CanonicalWallet(minterKey, getBaseProvider());
    return new ethers.Contract(address, PE_ANCHOR_ABI, signer);
  } catch {
    // A malformed key is an unconfigured runtime, not a crash path.
    return null;
  }
}

export function buildPeAnchorReadContract(
  getBaseProvider: BaseProviderFactory,
  env: PeAnchorRuntimeEnv = process.env as PeAnchorRuntimeEnv,
): ethers.Contract | null {
  const address = validAnchorAddress(env.PE_ANCHOR_CONTRACT_ADDRESS);
  if (!address) return null;
  try {
    return new ethers.Contract(address, PE_ANCHOR_ABI, getBaseProvider());
  } catch {
    return null;
  }
}
