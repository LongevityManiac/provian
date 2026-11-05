/**
 * Connection-code issuance guard (the embedded-beneficiary-link refusal).
 *
 * retired the relay connect and, with it, the transactional single-use
 * consume this module once held: nothing burns a HUMAN connection code
 * (`connection_tokens/{token}`) any more. It lives one hour; /create and
 * /v1/bootstrap/agent only read it; request-link enforces its expiry and files at
 * most one pending request per agent, and every such link still needs the
 * human's in-app acceptance. The one single-use code is a FLEET code (
 * ), consumed transactionally at request-link — see
 * core/agent-wallet/fleet-code.ts. What remains here is the refusal below.
 */

import type admin from 'firebase-admin';

export const EMBEDDED_BENEFICIARY_LINK_REJECTION = Object.freeze({
  error: 'embedded_beneficiary_link_not_supported',
  migration: 'Connect the agent without beneficiary_link, then use the authenticated direct-link or beneficiary-invite flow.',
});

/**
 * The old connection-token auto-bind crossed three independent commits
 * (token/session, wallet relationship, and PE) and treated bind failure as
 * non-fatal. Until those are one recoverable state machine, reject any
 * embedded beneficiary intent before token issuance/consumption. Callers can
 * use the canonical direct-link or beneficiary-invite flow instead.
 */
export function rejectEmbeddedBeneficiaryLink(
  beneficiaryLink: unknown,
): typeof EMBEDDED_BENEFICIARY_LINK_REJECTION | null {
  return beneficiaryLink === undefined || beneficiaryLink === null
    ? null
    : EMBEDDED_BENEFICIARY_LINK_REJECTION;
}

