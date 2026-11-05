/**
 * A Commons write's attached output signature (: every output a person or agent
 * hands out carries its signature over the output's hash).
 *
 * A forum post / reply, a want, a hiring-board job post and a job deliverable may carry
 * `provian_output_signature` the author's signature over EXACTLY the text whose sha256 the
 * write's PE seals in `output_digests` (`forumPostOutputText`, `wantOutputText`,
 * `jobPostOutputText`, `deliverableOutputText` in `core/meter/output-signature.ts`). The relay keeps
 * it beside the record and serves it with the record, so a reader's WITNESSED act can cite it and
 * the citation counts toward the author's consumption.
 *
 * Accepted only when it is the author's: well-formed, over the sealed hash, verified against the
 * signer's REGISTERED key, and resolving to the writing actor (a person's phone key → that person;
 * an agent's wallet → that agent). Anything else is refused BEFORE any write (400), because storing
 * a signature that is not the author's would let a writer route someone else's consumption
 * (Unknown = Block). An unsigned write is unchanged. A registry read failure refuses retryably.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { ValidationError } from '../agent-bank/errors';
import { normalizeOutputSignature, type OutputSignature } from '../meter/output-signature';
import { verifyOutputSignature } from '../pvt/output-citation';

/** The body / record field a signature travels under. */
export const ATTACHED_OUTPUT_SIGNATURE_FIELD = 'provian_output_signature';

export class OutputSignatureUnverifiableError extends Error {
  readonly status = 503;
  constructor() {
    super('output_signature_unverifiable');
    this.name = 'OutputSignatureUnverifiableError';
  }
}

/**
 * The attached signature, verified as the author's over `expectedHashHex` (sha256 hex of the output
 * text), or null when none was attached. Throws ValidationError (400) for any other signature.
 */
export async function acceptAttachedOutputSignature(
  db: Firestore,
  raw: unknown,
  expectedHashHex: string,
  authorActorId: string,
): Promise<OutputSignature | null> {
  if (raw === undefined || raw === null) return null;
  const signature = normalizeOutputSignature(raw);
  if (signature === null) throw new ValidationError('output_signature_malformed');
  if (signature.hash !== `sha256:${expectedHashHex.toLowerCase()}`) throw new ValidationError('output_signature_hash_mismatch');
  let verdict: Awaited<ReturnType<typeof verifyOutputSignature>>;
  try {
    verdict = await verifyOutputSignature(db, signature);
  } catch {
    throw new OutputSignatureUnverifiableError();
  }
  if (!verdict.ok) throw new ValidationError(`output_signature_${verdict.reason}`);
  if (verdict.actorId !== authorActorId) throw new ValidationError('output_signature_not_author');
  return signature;
}
