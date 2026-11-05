/**
 * output-citation — a SIGNED citation is the only citation that counts toward the producer's
 * Consumption .
 *
 * "every output an agent hands out carries its signature over the output's hash (SDK, MCP and
 * facilitator responses). A citation counts toward the producer's consumption when it carries
 * that signature: checked at intake and folded into the per-pair count. Unsigned citations don't
 * count, matching the invariant: for unsigned origins."
 * "1. The producer's signature only establishes who made the output. The citing act must still
 * be witnessed, and the ring and self filters still apply, so declared citations of public
 * signed outputs can't inflate anyone's consumption.
 * 2. Outputs produced on devices that don't hold the wallet key (the MacBook daemon, phones) are
 * signed with that device's registered key and map to the owner through the same identity
 * index, so human-device work earns consumption too."
 *
 * The 09-12 rule (`input_origins` Prompt 1b): an origin is witnessed only when a key that is
 * NOT the actor's vouched it crossed the process boundary, and anything the actor supplied in the
 * body is unwitnessed and counts zero. So this module does ONE thing — it establishes the OWNER of a
 * citation edge from the producer's signature — and NEVER the edge's witness: whether the citing act
 * was witnessed stays the citing lane's own relay-authoritative verdict (`origin-pricing-inputs.ts` * a registered device's body-bound batch, a relay-performed act; never a declared body,). An
 * unwitnessed citing act's edge is recorded as `pe_unwitnessed` and counts zero; the same-party and
 * closed-loop filters run on the owner this resolves, exactly as for every other origin.
 *
 * AT INTAKE (every accrual path that takes `input_origins` reaches `resolveOriginPricingInputs`,
 * which calls this):
 * 1. the entry is an `out:<kind>:<id>` origin carrying `signature` (`signedCitationOf` the same
 * signer and the same hash as the entry);
 * 2. the signer's REGISTERED key verifies the signature over `provian-output:v1:<hash>` * wallet → EIP-191 recovers exactly the address;
 * device → P-256 against `devices/{id}` (its Secure-Enclave signing key, or a bearer
 * device's registered output key);
 * app → P-256 against `app_output_keys_v1/{id}` (a phone's PE-attestation key);
 * 3. the signer maps to its actor through the per-IDENTITY registries only — the canonical native
 * wallet address index, `proven_addresses`, `human_proven_addresses`, the `devices` row's own
 * owner, the app key's owner — never a per-output or per-citation document. The owner is
 * `signer:<actor id>`, the id space the per-pair counts, the same-party fence and the
 * closed-loop detector already key on.
 *
 * Nothing here is written.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { verifyMessage } from 'ethers';
import {
  outputCitationSignerOf,
  outputSignatureMessage,
  signedCitationOf,
  type OutputSignature,
  type OutputSigner,
} from '../meter/output-signature';
import {
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
  nativeWalletAddressIndexId,
  parseCanonicalNativeAddressIndex,
} from './native-wallet-registration';
import {
  HUMAN_PROVEN_ADDRESSES_COLLECTION,
  PROVEN_ADDRESSES_COLLECTION,
  isEconomicallyActiveProvenAddress,
} from '../external-address/link';
import { isEconomicallyActiveHumanProvenAddress } from '../external-address/human-link';
import { readAppOutputKey, readDeviceOutputKey, verifyP256Sha256 } from './output-signing-keys';

/** True for an `out:` origin identifier (a citation of a signed output). */
export function isOutputCitationIdentifier(originIdentifier: string): boolean {
  return outputCitationSignerOf(originIdentifier) !== null;
}

/**
 * The actor id behind a WALLET signer address, from the per-identity registries only, or null when
 * no registry knows the address. A read that THROWS propagates. A corrupt native-index row is not
 * an identity (null), exactly as the closed-loop detector treats it.
 */
export async function resolveWalletSignerActor(db: Firestore, address: string): Promise<string | null> {
  const lower = address.toLowerCase();
  const indexId = nativeWalletAddressIndexId(lower);
  const index = await db.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION).doc(indexId).get();
  if (index.exists) {
    try {
      const authority = parseCanonicalNativeAddressIndex(index.data() as Record<string, unknown>, indexId);
      return authority.address === lower ? authority.owner_id : null;
    } catch {
      return null;
    }
  }
  const agentProven = await db.collection(PROVEN_ADDRESSES_COLLECTION).doc(lower).get();
  if (agentProven.exists) {
    const record: unknown = agentProven.data();
    if (isEconomicallyActiveProvenAddress(record, lower)) return record.agent_id;
  }
  const personProven = await db.collection(HUMAN_PROVEN_ADDRESSES_COLLECTION).doc(lower).get();
  if (personProven.exists) {
    const record: unknown = personProven.data();
    if (isEconomicallyActiveHumanProvenAddress(record, lower)) return record.user_id;
  }
  return null;
}

export type OutputSignatureVerdict =
  | { readonly ok: true; readonly actorId: string }
  | { readonly ok: false; readonly reason: 'not_signed' | 'bad_signature' | 'unknown_signer' };

/**
 * Verify one signature against its signer's REGISTERED key and name the producing actor. A read
 * failure propagates (the caller resolves to no owner).
 */
export async function verifyOutputSignature(db: Firestore, signature: OutputSignature): Promise<OutputSignatureVerdict> {
  const message = outputSignatureMessage(signature.hash);
  const signer: OutputSigner = signature.signer;
  if (signer.kind === 'wallet') {
    let recovered: string;
    try {
      recovered = verifyMessage(message, signature.sig).toLowerCase();
    } catch {
      return { ok: false, reason: 'bad_signature' };
    }
    if (recovered !== signer.id) return { ok: false, reason: 'bad_signature' };
    const actorId = await resolveWalletSignerActor(db, signer.id);
    return actorId === null ? { ok: false, reason: 'unknown_signer' } : { ok: true, actorId };
  }
  const key = signer.kind === 'device' ? await readDeviceOutputKey(db, signer.id) : await readAppOutputKey(db, signer.id);
  if (key === null) return { ok: false, reason: 'unknown_signer' };
  if (!verifyP256Sha256(key.publicKey, message, signature.sig)) return { ok: false, reason: 'bad_signature' };
  return { ok: true, actorId: key.actorId };
}

/** What one citation entry resolved to (keyed by `outputCitationVerdictKey`). */
export interface ResolvedOutputCitation {
  /** The producer's actor id, or null (unsigned / bad signature / unknown signer / read failure). */
  readonly producerActorId: string | null;
  readonly reason: 'verified' | 'not_signed' | 'bad_signature' | 'unknown_signer' | 'registry_unreadable';
}

/** One CITATION (one output): identifier + hash. A PE citing the same output twice cites it once. */
export function outputCitationKey(origin: { readonly origin_identifier: string; readonly hash: string }): string {
  return `${origin.origin_identifier}|${origin.hash}`;
}

/**
 * One VERDICT: identifier + hash + the signature carried. Entries naming the same output with
 * different signatures (or none) are verified separately, so an unsigned or forged entry can never
 * borrow a valid entry's verdict, and a valid entry is never shadowed by an earlier bad one.
 */
export function outputCitationVerdictKey(origin: { readonly origin_identifier: string; readonly hash: string; readonly signature?: unknown }): string {
  return `${outputCitationKey(origin)}|${signedCitationOf(origin)?.sig ?? ''}`;
}

/**
 * Verify and resolve every `out:` origin of one PE. A read failure resolves that citation to no
 * owner (recorded, counts zero, never guessed). Nothing here decides witnessing.
 */
export async function resolveOutputCitations(
  db: Firestore,
  origins: readonly { readonly origin_identifier: string; readonly hash: string; readonly signature?: unknown }[],
): Promise<Map<string, ResolvedOutputCitation>> {
  const out = new Map<string, ResolvedOutputCitation>();
  for (const origin of origins) {
    if (!isOutputCitationIdentifier(origin.origin_identifier)) continue;
    const key = outputCitationVerdictKey(origin);
    if (out.has(key)) continue;
    const signature = signedCitationOf(origin);
    if (signature === null) {
      out.set(key, { producerActorId: null, reason: 'not_signed' });
      continue;
    }
    try {
      const verdict = await verifyOutputSignature(db, signature);
      out.set(key, verdict.ok
        ? { producerActorId: verdict.actorId, reason: 'verified' }
        : { producerActorId: null, reason: verdict.reason });
    } catch {
      out.set(key, { producerActorId: null, reason: 'registry_unreadable' });
    }
  }
  return out;
}
