/**
 * origin-owner-to-signer — map an origin OWNER party to the Provian signer that IS it (,
 * Prompt 3). The closed-loop detector uses this: only an owner that resolves to another Provian
 * signer can be part of a ring. An external party (a domain, a DOI registrant, a repo owner with no
 * Provian binding) is NOT a signer, so citing it is always outward and never a ring.
 *
 * Today only an on-chain address maps to a signer, via the canonical native-address index (the same
 * index the same-owner fence and both USDC watchers read — never a re-declared schema). A corrupt
 * index row is treated as external (conservative: never FALSE-flags a citation as a ring); a read
 * that THROWS propagates so the detector marks the whole determination unresolvable and flags nothing.
 */

import type { Firestore } from 'firebase-admin/firestore';
import {
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
  nativeWalletAddressIndexId,
  parseCanonicalNativeAddressIndex,
} from './native-wallet-registration';

const EVM_OWNER = /^evm:(0x[0-9a-f]{40})$/;
/**
 * Trust Layer build (§2.1): a `pe:` origin resolves to the cited PE's SIGNER,
 * expressed as the owner party `signer:<economic actor id>` the graph's own `signer` id space.
 * The mapping is the identity function (no read): the owner IS a Provian signer by construction,
 * which is exactly why `pe:` edges participate in the closed-loop walk.
 */
const SIGNER_OWNER = /^signer:(.+)$/;

/** Build the detector's owner→signer resolver bound to a Firestore instance. */
export function makeOwnerToSigner(db: Firestore): (owner: string) => Promise<string | null> {
  return async (owner: string): Promise<string | null> => {
    const signer = SIGNER_OWNER.exec(owner);
    if (signer && signer[1].length > 0) return signer[1];
    const m = EVM_OWNER.exec(owner);
    if (!m) return null; // repo/domain/doi owners are external parties, never Provian signers
    const snap = await db.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION)
      .doc(nativeWalletAddressIndexId(m[1]))
      .get();
    if (!snap.exists) return null; // an address not in the index is not a Provian native wallet
    try {
      return parseCanonicalNativeAddressIndex(snap.data() as Record<string, unknown>, 'closed_loop_detector').owner_id;
    } catch {
      // A corrupt/unusable index row is NOT proof of a ring — treat as external (never over-flag).
      return null;
    }
  };
}
