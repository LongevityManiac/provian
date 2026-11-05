/**
 * Exact read-only preparation for a sovereign agent-work occurrence mint claim
 *.
 *
 * One verified sovereign-work occurrence mints ONCE. The claim is keyed by
 * (earning agent address, occurrence_id): the first PE to claim it mints; a
 * later PE reusing the same (agent, occurrence) records for chain integrity but
 * earns 0 PVT (relation 'duplicate' → exactDuplicate → 0). This mirrors the
 * cross-witness commit and x402 mint-once claims — the same crash-safe machinery
 * that commits the claim atomically with pe_history or fails the whole write.
 *
 * The occurrence binding itself (the agent's own-key signature over the
 * occurrence) is verified UPSTREAM at the sovereign-pe route before this PE is
 * ever stamped verified; this claim is the anti-replay layer on top of that.
 */

import type { Firestore } from 'firebase-admin/firestore';
import {
  prepareMintOnceClaim,
  type PreparedMintOnceClaim,
} from './mint-once-claim';

/**
 * Prepare without mutating Firestore. writePEHistory commits the returned
 * canonical claim together with the PE row or rejects a concurrent race.
 *
 * `agentAddress` is the earning agent's own address (the verified
 * `binding_signer`); `occurrenceId` is the signed occurrence identifier.
 */
export async function prepareOccurrenceMintClaim(
  db: Firestore,
  agentAddress: string,
  occurrenceId: string,
  peId: string,
  userId: string,
  nowMs = Date.now(),
): Promise<PreparedMintOnceClaim> {
  return prepareMintOnceClaim(db, {
    kind: 'occurrence',
    subjectId: agentAddress,
    eventId: occurrenceId,
    peId,
    userId,
    nowMs,
  });
}
