/**
 * Agent self-sovereign chain-address reporting.
 *
 * An agent derives its per-chain addresses (EVM + Solana) from its OWN key. The
 * EVM address is PoP-verified at wallet creation, but the Solana address is
 * derived from the SAME secret key via a SHA-512 KDF the relay CANNOT reproduce
 * (it never holds the key). So the relay stores what the agent reports, guarded
 * only by shape + a self-consistency check on the EVM leg:
 *
 * - `evm` (if present) MUST equal the canonical PoP-verified EVM address, else
 * the whole report is refused. This stops a mismatched-address injection.
 * - `solana` MUST be a base58 ed25519 address (32-byte pubkey → 32..44 base58
 * chars). The relay cannot verify it points at the agent's key, but a wrong
 * value is only self-harm: funds sent there are unspendable by anyone but the
 * holder of the key that derives it, and the agent controls that key.
 *
 * The result is DISPLAY-ONLY: the app shows it so a human can fund the agent on
 * Solana. It grants no auth, mint, or economic authority.
 *
 * Kept as a pure function (not inlined into the route) so it carries an in-suite
 * RED negative control rather than being reachable only through a route
 * integration test.
 */

/** base58 alphabet (Bitcoin/Solana), excludes 0 O I l. */
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface ReportedChainAddresses {
  evm?: unknown;
  solana?: unknown;
}

export interface ValidatedChainAddresses {
  evm: string;
  solana: string;
}

/**
 * Validate an agent-reported chain-address bundle against its canonical (PoP-
 * verified) EVM address. Returns the stored `{ evm, solana }` on success, or
 * `null` when there is nothing valid to store (absent, malformed, or an EVM leg
 * that disagrees with the verified address). Returning null is the honest
 * "store nothing" outcome — the caller leaves `chain_addresses` unset.
 *
 * `canonicalEvmAddress` is the wallet's verified EVM address; the stored `evm`
 * is always THAT address, never the client's echo, so the two can never drift.
 */
export function validateReportedChainAddresses(
  reported: ReportedChainAddresses | null | undefined,
  canonicalEvmAddress: string,
): ValidatedChainAddresses | null {
  if (!reported || typeof reported !== 'object') return null;

  const solana = reported.solana;
  if (typeof solana !== 'string' || !BASE58_RE.test(solana)) return null;

  // If the client echoed an EVM address it MUST match the verified one (case-
  // insensitive). A mismatch is refused outright — we never store a
  // client-asserted EVM address that disagrees with proof of possession.
  if (reported.evm !== undefined && reported.evm !== null) {
    if (
      typeof reported.evm !== 'string'
      || reported.evm.toLowerCase() !== canonicalEvmAddress.toLowerCase()
    ) {
      return null;
    }
  }

  // Store the canonical (lowercased) EVM leg + the reported Solana address.
  return { evm: canonicalEvmAddress.toLowerCase(), solana };
}

/**
 * The bundle to STORE for a validated report. `chain_addresses.evm` is the wallet's BIRTH
 * EVM address once the key has rotated: the beneficiary relationship's rotation-lineage check reads
 * it as the start of the lineage. A report always carries the CURRENT address, so storing it after
 * a rotation broke that check (Atlas's link went unverifiable). Once rotated, a stored `evm`
 * is kept as it is and only `solana` is refreshed; an unrotated wallet's current address IS its
 * birth address, so the validated bundle is stored unchanged. A rotated wallet with no stored `evm`
 * keeps none: the relay cannot know the birth address from a report.
 */
export function chainAddressesToStore(
  validated: ValidatedChainAddresses,
  stored: unknown,
  rotationCount: number,
): { evm?: string; solana: string } {
  if (rotationCount === 0) return validated;
  const storedEvm = stored !== null && typeof stored === 'object' && !Array.isArray(stored)
    && typeof (stored as Record<string, unknown>).evm === 'string'
    ? (stored as Record<string, unknown>).evm as string
    : null;
  return storedEvm === null ? { solana: validated.solana } : { evm: storedEvm, solana: validated.solana };
}
