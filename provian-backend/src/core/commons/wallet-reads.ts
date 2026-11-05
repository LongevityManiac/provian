/**
 * Live wallet reads for Commons (Wave 4 STEP 4 / STEP 6).
 *
 * Commons profiles previously snapshotted attestation_tier at registration and
 * never updated it (HIGH-8: it was hardcoded to 'software', so hardware-attested
 * participants were invisible to the filter). The fix is to resolve the live
 * attestation tier from the device registry on every trust-bearing access:
 * profile.attestation_tier is actively maintained by
 * recomputeCommonsAttestationTier() on every device or wallet attestation event.
 *
 * the governance-score live read (loadLiveWalletGovernanceScore) is
 * DELETED with the governance_score field — no Commons read is gated on a
 * governance signal any more.
 */

import type { CommonsDeps } from './types';

interface DeviceDoc {
  status?: string;
  signing_method?: string;
  owner_type?: 'human' | 'agent';
  attestation_capability?: string;
  platform?: string;
  attested_security_level?: string;
}

interface WalletAttestationDoc {
  attested_security_level?: string;
  security_level?: string;
}

const TIER_RANK: Record<string, number> = {
  software: 0,
  software_verified: 1,
  hardware_partial: 2,
  hardware_tpm: 3,
  hardware: 3,
  hardware_full: 4,
};

const TIER_FOR_FILTER: Record<string, string> = {
  hardware_tpm: 'hardware',
  hardware_partial: 'hardware',
  hardware_full: 'hardware',
};

function tierForFilter(raw: string): string {
  return TIER_FOR_FILTER[raw] ?? raw;
}

/**
 * Resolve the wallet's effective Commons attestation tier from its
 * highest-tier active device, gated by the wallet's attested
 * security level (Wave 3 BLOCKER-2 fail-closed). Output is
 * 'software', 'software_verified', or 'hardware' for filter use;
 * the original device tier is also returned for consumers that
 * want full granularity.
 */
export async function computeWalletAttestationTier(
  // Only the Firestore handle is used; accept the minimal shape so callers that
  // hold just { db } (e.g. the device/wallet attestation routes) need no cast.
  deps: Pick<CommonsDeps, 'db'>,
  walletId: string,
): Promise<{ tier: string; raw_tier: string }> {
  let walletSecLevel: string | null = null;
  try {
    // `walletId` is the wallet DOC id (callers pass owner_wallet_id / the
    // wallet doc id), and `wallets` is keyed by that id. The prior
    // `where('user_id','==',walletId)` matched a wallet-id value against the
    // user_id FIELD — always empty, so the hardware gate stayed stuck closed
    // (a non-SE hardware_tpm device could never be honored). Resolve by doc id,
    // mirroring the sibling devices lookup below (owner_wallet_id) and
    // governance-score.ts.
    const walletDoc = await deps.db.collection('wallets').doc(walletId).get();
    if (walletDoc.exists) {
      const w = walletDoc.data() as WalletAttestationDoc;
      walletSecLevel = w.attested_security_level || w.security_level || null;
    }
  } catch {
    walletSecLevel = null;
  }

  let bestTier = 'software';
  try {
    const deviceSnap = await deps.db.collection('devices')
      .where('owner_wallet_id', '==', walletId)
      .where('status', '==', 'active')
      .get();
    for (const doc of deviceSnap.docs) {
      const d = doc.data() as DeviceDoc;
      const claimed = d.attestation_capability || 'software';
      // Approved policy boundary: only an explicitly human-owned device may
      // enter hardware selection. Agent-owned and unknown legacy owner types
      // remain software before signing-method selection, so
      // secure_enclave_p256 cannot re-promote them in Commons projections.
      if (d.owner_type !== 'human') {
        continue;
      }
      // Mirror Wave-3 fail-closed: a hardware claim only sticks if
      // the wallet's attested_security_level recognises it.
      const allowsHardware = walletSecLevel === 'hardware'
        || walletSecLevel === 'hardware_tpm'
        || walletSecLevel === 'hardware_partial'
        || walletSecLevel === 'hardware_full';
      let resolved = claimed;
      if (!allowsHardware && (claimed === 'hardware' || claimed === 'hardware_tpm' || claimed === 'hardware_full' || claimed === 'hardware_partial')) {
        resolved = 'software';
      }
      // A syntactically valid SE signature without a verified platform chain
      // is hardware_partial. Only server-verified platform attestation may
      // lift a human device to hardware_full / hardware_tpm.
      if (d.signing_method === 'secure_enclave_p256') {
        resolved = d.attested_security_level === 'hardware_full'
          || d.attested_security_level === 'hardware_tpm'
          ? d.attested_security_level
          : 'hardware_partial';
      }
      if ((TIER_RANK[resolved] ?? 0) > (TIER_RANK[bestTier] ?? 0)) {
        bestTier = resolved;
      }
    }
  } catch {
    // best-effort; fall back to software
  }
  return { tier: tierForFilter(bestTier), raw_tier: bestTier };
}

/**
 * Recompute and persist a Commons profile's attestation_tier from
 * the live wallet/device state. Called from device registration,
 * device revocation, and the wallet-attestation upload route so
 * filter values stay fresh without a per-read live join.
 */
export async function recomputeCommonsAttestationTier(
  // Only the Firestore handle is used; accept the minimal shape (see above).
  deps: Pick<CommonsDeps, 'db'>,
  walletId: string,
): Promise<void> {
  try {
    const profileDoc = await deps.db
      .collection('commons_profiles')
      .doc(walletId)
      .get();
    if (!profileDoc.exists) return;
    const { tier, raw_tier } = await computeWalletAttestationTier(deps, walletId);
    await profileDoc.ref.update({
      attestation_tier: tier,
      attestation_tier_raw: raw_tier,
      attestation_tier_updated_at: Date.now(),
    });
  } catch (err) {
    console.warn(`[Commons] recomputeCommonsAttestationTier failed for ${walletId}:`, err);
  }
}
