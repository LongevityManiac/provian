/**
 * F55 (S2 2026-09-10) — operator audit identity for the ops-console admin routes.
 *
 * The PRIMARY audit identity is `x-ops-basic-user`: nginx sets it from the
 * authenticated htpasswd user (`$remote_user`) on the ops.provian.ai path, and a
 * caller cannot set it through that path. `x-operator-id` (and any body
 * `operator_id`) is CALLER-SUPPLIED — nginx injects a single FIXED value
 * (`optimist@provian.ai`) for every Basic-Auth user, and a direct
 * admin-secret caller can send anything — so it is recorded only as
 * `asserted_operator_id`, never as the primary identity. A direct-secret caller
 * that bypasses nginx carries no `x-ops-basic-user`, so it is unattributable
 * (primary null); the assertion is retained for forensics.
 *
 * Before F55 the three admin routers each derived the audit identity solely from
 * the caller-supplied `x-operator-id`, so `ops_action_log.operator_id`,
 * `acked_by`, `ruled_by`, etc. proved only "the admin secret was used", never who
 * used it — and `genesis_close_admission` even let the request BODY override it.
 */
import type { Request } from 'express';

const OPERATOR_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{2,99}$/;

function validated(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return OPERATOR_ID_RE.test(normalized) ? normalized : null;
}

/** The un-spoofable primary audit identity (nginx-set htpasswd user), or null. */
export function primaryOperatorId(req: Request): string | null {
  return validated(req.headers['x-ops-basic-user']);
}

/** The caller-asserted operator id (`x-operator-id`) — recorded, never the
 *  primary identity. Null when absent/invalid. */
export function assertedOperatorId(req: Request): string | null {
  return validated(req.headers['x-operator-id']);
}
