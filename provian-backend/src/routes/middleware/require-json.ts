/**
 * require-json — belt-and-braces CSRF defense for the ops admin routers (F2 / F26 / F57 / F65).
 *
 * The primary CSRF gate is at nginx (ops.provian.ai refuses cross-site mutating requests and
 * requires a custom header the console's fetch always sends). This is the relay-side backstop
 * the security pass asked for: a cross-site HTML form can only send an
 * `application/x-www-form-urlencoded`, `multipart/form-data`, or `text/plain` body WITHOUT a
 * CORS preflight — never `application/json`. The relay parses only JSON (`express.json`), so a
 * form-encoded body already arrives as `{}` and a non-dangerous action would otherwise execute
 * on an empty body; this guard turns that into an explicit refusal.
 *
 * Called from each admin router's `authenticateAdmin`, AFTER the admin-secret check, so an
 * unauthenticated caller still gets 401 (auth is the first gate) and only an authenticated
 * request with the wrong content-type is refused. Only mutating methods are gated — GET/HEAD
 * reads carry no body and must not be forced to declare JSON.
 *
 * The console always sends `application/json` on every write (its apiFetch sets the
 * content-type whenever a body is present, and every write passes a body), so this refuses
 * nothing the real console does.
 */

import type { Request, Response } from 'express';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Returns true when the request's method/content-type are acceptable. For a mutating method
 * whose Content-Type is not application/json, writes a 415 and returns false. Never throws.
 */
export function jsonContentTypeOkForMutation(req: Request, res: Response): boolean {
  if (SAFE_METHODS.has(req.method)) return true;
  // req.is('application/json') matches application/json, application/json; charset=…, and +json;
  // returns false for form/text bodies and null when there is no body at all.
  if (req.is('application/json')) return true;
  res.status(415).json({ error: 'content_type_must_be_application_json' });
  return false;
}
