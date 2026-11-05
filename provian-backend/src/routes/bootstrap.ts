/**
 * Bootstrap router — serves the hosted `curl … | sh` agent onboarding script.
 *
 * GET /v1/bootstrap/agent header `x-provian-token: PROV-XXXX-XXXX` (canonical, item 9)
 * POST /v1/bootstrap/agent same header, or JSON body {"token" "PROV-XXXX-XXXX"} (still served)
 * HEAD /v1/bootstrap/agent answered by Express from the GET handler (headers only)
 * GET /v1/bootstrap/agent/code header `x-provian-token`: the check a new install runs before it writes
 *
 * The app shows one line — `curl -sSL -H 'x-provian-token: …'
 * "…/v1/bootstrap/agent" | sh` (PowerShell: `irm -Headers @{…} … | iex`) — and
 * this returns the POSIX-sh script (see core/agent-bootstrap-script) with the
 * connection token baked in.
 *
 * WHY GET IS CANONICAL: an HTTP/1.1 POST with no body and no Content-Length
 * never reaches Cloud Run — Google Front End answers it 411 Length Required
 * (seen from a hosted agent, 2026-09-24). A GET carries no body, so the line works however an agent
 * issues the request. POST stays served, with or without a body, so every line
 * already handed out keeps working.
 *
 * INSPECTION IS FREE: an agent that fetches the URL first to look at it (GET or
 * POST, same header) gets the same script, byte for byte. Serving the script
 * only checks the code's FORMAT — it reads no record, never consumes and never
 * invalidates the code — so a look never spends the human's invite. RUNNING the
 * script on a machine with no agent wallet is what asks about the code: GET
 * /agent/code reads the record, consumes nothing, and lets a dead code stop before
 * anything lands on the machine.
 *
 * The token is read HEADER-first, body-fallback (readBootstrapToken): agent shells
 * mangle the nested quotes in `-d '{"token" "…"}'` down to an empty token, and
 * a header carries the code with no inner quotes. Either way the single-use
 * code travels in a header or the POST BODY, never a URL query string —
 * request logs and TLS-terminating intermediaries record full URLs, and a
 * logged live code lets a log-reader bind the human's invite first
 * (setup-command.ts carries the same tokens-out-of-the-URL rule). PUBLIC and deliberately UN-gated pre-flip: the
 * two-touch onboarding runs before the PUBLIC_LAUNCH flip, so this prefix must
 * NOT be added to CLOSED_PRE_LAUNCH_PREFIXES.
 *
 * Because the body is piped straight into `sh`, EVERY response is emitted as
 * sh-safe text. Errors must FAIL LOUD: each error body is a real shell command
 * (`printf … >&2; exit 1`), so `curl … | sh` prints the reason to stderr and
 * ends with a non-zero status. A prior design used inert `#` comments, which
 * made every error — a mangled/empty token, a rate-limit — exit 0 with no
 * output, indistinguishable from a completed onboarding (the silent-invite
 * incident: an agent handed a valid code saw "no output, exit 0, no wallet" and
 * reported success). A human who runs the curl alone still reads the sentence.
 * A GET with no token header gets the same kind of script, naming how to pass
 * the code — never an HTML 404 piped into a shell.
 */

import * as fs from 'fs';
import { createHash } from 'crypto';
import express, { Router, Request, Response } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import { isValidConnectionTokenFormat } from '../core/connection-token-format';
import { readConnectionCodeStanding, type ConnectionCodeStanding } from '../core/agent-wallet/fleet-code';
import {
  buildAgentBootstrapScript,
  buildAgentBootstrapPowershell,
  buildAgentDeviceBootstrapScript,
  buildAgentDeviceBootstrapPowershell,
  isValidAgentDeviceTokenFormat,
  safeAgentDeviceName,
} from '../core/agent-bootstrap-script';
import {
  buildDeviceBootstrapScript,
  buildDeviceBootstrapPowershell,
  isValidDeviceSetupTokenFormat,
} from '../core/device-bootstrap-script';
import { resolveRelayUrl } from '../core/setup-command';

export interface BootstrapRouterDeps {
  /** Reads connection codes for GET /agent/code. Serving a script never touches it. */
  db: Firestore;
  cache: {
    // Structurally matches RedisCache.checkRateLimit (which also returns
    // current/limit and an optional retryAfter); we only read `allowed`.
    checkRateLimit(key: string, limit: number, windowSec: number): Promise<{ allowed: boolean; retryAfter?: number }>;
    getConnectionToken(token: string): Promise<{ user_id?: unknown; expires_at?: unknown } | null>;
  };
  /**
   * Filesystem path to the pre-built agent onboarding bundle (the esbuild output
   * of provian-agent-sdk `build:bootstrap`). Placed into the relay image at
   * deploy; falls back to BOOTSTRAP_BUNDLE_PATH env. When absent, GET /agent.js
   * fail-closes with a plain 503 (never a fabricated/empty bundle).
   */
  bundlePath?: string;
}

/**
 * sh-safe error that FAILS LOUD. Piped into `sh`, the body prints the sentence
 * to stderr and exits non-zero, so `curl … | sh` ends with a failing status
 * instead of the inert-`#`-comment no-op that silently exited 0. `message` is a
 * server-controlled constant; single-quote-escape it defensively (POSIX
 * `'\''`) so it is inert inside the shell string regardless of contents.
 */
function shError(res: Response, status: number, message: string): void {
  const quoted = `'${message.replace(/'/g, "'\\''")}'`;
  res
    .status(status)
    .type('text/plain; charset=utf-8')
    .set('Cache-Control', 'no-store')
    .send(`printf 'Provian: %s\\n' ${quoted} >&2\nexit 1\n`);
}

/**
 * Read the setup token, preferring the `x-provian-token` HEADER over the JSON
 * body, and TRIM it. Agent shells routinely mangle the nested quotes in
 * `-d '{"token":"…"}'` down to an empty/garbled token (the retry that exposed
 * this after the fail-loud fix landed: OpenClaw re-quoted the body to
 * `{"token":""}`). A header carries the code with no inner quotes and survives
 * re-quoting; trim also covers the copy/paste trailing-newline that fails the
 * exact-length format check. The token still never rides the URL/query (which
 * intermediaries log), so the security posture is unchanged.
 */
function readBootstrapToken(req: Request, bodyToken: unknown): string {
  const header = req.get('x-provian-token');
  const raw = typeof header === 'string' && header.trim().length > 0
    ? header
    : (typeof bodyToken === 'string' ? bodyToken : '');
  return raw.trim();
}

/**
 * The sentence a request with NO code gets (typically an agent that fetched the
 * bare URL). Names the header and the exact line shape so the next attempt
 * works; never suggests the query string.
 */
function missingCodeMessage(relayUrl: string, route: string, placeholder: string, appScreen: string): string {
  return `No code was sent. Pass it in the x-provian-token header: `
    + `curl -sSL -H 'x-provian-token: ${placeholder}' "${relayUrl}${route}" | sh `
    + `(Windows: irm -Headers @{'x-provian-token'='${placeholder}';'x-provian-platform'='windows'} "${relayUrl}${route}" | iex). `
    + `Get the code in the Provian app under "${appScreen}".`;
}

/** Windows PowerShell requested via body `platform` OR the `x-provian-platform` header. */
function wantsWindows(req: Request, bodyPlatform: unknown): boolean {
  return bodyPlatform === 'windows' || req.get('x-provian-platform') === 'windows';
}

/**
 * How GET /agent/code answers each standing. The install script acts on the status alone:
 * 200 runs, and 404, 409 and 410 are dead (see agentCodeCheckSh).
 */
const CODE_CHECK_RESPONSES: Record<ConnectionCodeStanding, { status: number; body: Record<string, string> }> = {
  live: { status: 200, body: { status: 'live' } },
  unknown: { status: 404, body: { error: 'connection_token_issuer_unresolved' } },
  expired: { status: 410, body: { error: 'connection_token_expired' } },
  issuer_not_linked: { status: 410, body: { error: 'fleet_code_issuer_not_linked' } },
  used: { status: 409, body: { error: 'connection_token_already_used' } },
};

export function createBootstrapRouter(deps: BootstrapRouterDeps): Router {
  const { db, cache } = deps;
  const router = Router();
  // Self-sufficient body parsing: the token may ride the POST body (or the
  // x-provian-token header) — never the URL — so this router must parse JSON
  // regardless of app-level mount order.
  router.use(express.json({ inflate: false, limit: '4kb' }));

  // Resolve + cache the bundle bytes once. A missing bundle is a deploy gap, not
  // a client error — fail closed so the sh script's plain "couldn't download"
  // message fires rather than piping an empty/garbage file into node.
  let cachedBundle: Buffer | null = null;
  let cachedBundleSha256: string | null = null;
  const resolveBundle = (): Buffer | null => {
    if (cachedBundle) return cachedBundle;
    const p = deps.bundlePath || process.env.BOOTSTRAP_BUNDLE_PATH;
    if (!p) return null;
    try {
      cachedBundle = fs.readFileSync(p);
      // F36: hash the EXACT bytes we serve, so the script we hand out can pin the
      // bundle's SHA256 and verify it before exec.
      cachedBundleSha256 = createHash('sha256').update(cachedBundle).digest('hex');
      return cachedBundle;
    } catch { return null; }
  };
  /** The SHA256 of the served bundle, or null when no bundle is available. */
  const resolveBundleSha256 = (): string | null => {
    if (!cachedBundleSha256) resolveBundle();
    return cachedBundleSha256;
  };

  // GET /v1/bootstrap/agent.js — the self-contained onboarding bundle the sh
  // script downloads and runs with `node`. Public, un-gated pre-flip.
  router.get('/agent.js', async (_req: Request, res: Response) => {
    const bundle = resolveBundle();
    if (!bundle) {
      res.status(503).type('text/plain; charset=utf-8').set('Cache-Control', 'no-store')
        .send('# The Provian setup bundle is not available yet. Please try again later.\n');
      return;
    }
    res.status(200)
      .type('application/javascript; charset=utf-8')
      .set('Cache-Control', 'public, max-age=300')
      .send(bundle);
  });

  /**
   * Per-IP transport limit (a transport limit, not a gate). The script routes share one bucket;
   * the code check has its own, so an install's two requests never halve what one address gets.
   */
  const withinRateLimit = async (req: Request, res: Response, bucket = 'bootstrap'): Promise<boolean> => {
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const minuteLimit = await cache.checkRateLimit(`rl:${bucket}-min:${clientIp}`, 20, 60);
    if (!minuteLimit.allowed) {
      shError(res, 429, 'Too many requests. Wait a minute and paste the command again.');
      return false;
    }
    const hourLimit = await cache.checkRateLimit(`rl:${bucket}-hr:${clientIp}`, 200, 3600);
    if (!hourLimit.allowed) {
      shError(res, 429, 'Too many requests. Please try again later.');
      return false;
    }
    return true;
  };

  // GET (canonical) / POST (still served) / HEAD /v1/bootstrap/agent. One
  // handler, so an agent that inspects the URL with either verb gets the exact
  // script the install line runs. GET reads the code from the header only (a
  // GET has no body; the code never rides the query string); POST also takes
  // the legacy JSON body.
  const serveAgentScript = async (req: Request, res: Response): Promise<void> => {
    try {
      if (!(await withinRateLimit(req, res))) return;

      const agentBody = req.method === 'POST'
        ? req.body as { token?: unknown; platform?: unknown } | undefined
        : undefined;
      // Token from the x-provian-token header (mangle-resistant) or the JSON
      // body; trimmed. See readBootstrapToken.
      const token = readBootstrapToken(req, agentBody?.token);
      if (token.length === 0) {
        shError(res, 400, missingCodeMessage(resolveRelayUrl(), '/v1/bootstrap/agent', 'PROV-XXXX-XXXX', 'Connect an agent'));
        return;
      }
      if (!isValidConnectionTokenFormat(token)) {
        shError(res, 400, 'Invalid or missing connection code. Generate a fresh code in the Provian app under "Connect an agent".');
        return;
      }

      // F36: the script pins the bundle's SHA256 and verifies it before exec, so
      // the relay must know the bundle bytes to issue a script at all. Fail closed
      // when the bundle is missing (a deploy gap) rather than hand out a script
      // that would download an unverifiable bundle.
      const bundleSha256 = resolveBundleSha256();
      if (!bundleSha256) {
        shError(res, 503, 'Provian setup is temporarily unavailable (the onboarding bundle is not ready). Please try again in a minute.');
        return;
      }

      // platform:"windows" (body OR x-provian-platform header) -> PowerShell
      // (`irm … | iex`); default -> POSIX sh (`curl … | sh`).
      const relayUrl = resolveRelayUrl();
      const script = wantsWindows(req, agentBody?.platform)
        ? buildAgentBootstrapPowershell({ token, relayUrl, bundleSha256 })
        : buildAgentBootstrapScript({ token, relayUrl, bundleSha256 });
      res.status(200)
        .type('text/plain; charset=utf-8')
        .set('Cache-Control', 'no-store')
        .send(script);
    } catch (error) {
      console.error('[Bootstrap] agent script error:', error);
      shError(res, 500, 'Provian setup is temporarily unavailable. Please try again in a minute.');
    }
  };
  router.get('/agent', serveAgentScript);
  router.post('/agent', serveAgentScript);

  // GET /v1/bootstrap/agent/code: where the install script stops a dead code before it
  // writes anything. Read-only, with the code in the header and never the URL. A relay that
  // cannot read the code answers 503 and the script stops there too (Unknown = Block).
  router.get('/agent/code', async (req: Request, res: Response) => {
    try {
      if (!(await withinRateLimit(req, res, 'bootstrap-code'))) return;
      res.set('Cache-Control', 'no-store');
      const token = readBootstrapToken(req, undefined);
      if (!isValidConnectionTokenFormat(token)) {
        res.status(400).json({ error: 'invalid_connection_token' });
        return;
      }
      const { status, body } = CODE_CHECK_RESPONSES[await readConnectionCodeStanding({ db, cache }, token, Date.now())];
      res.status(status).json(body);
    } catch (error) {
      console.error('[Bootstrap] code check error:', error);
      res.status(503).set('Cache-Control', 'no-store').json({ error: 'code_check_unavailable' });
    }
  });

  // GET (canonical) / POST / HEAD /v1/bootstrap/device — the "Connect a
  // computer" one-liner. Token via the x-provian-token header (or, on POST, body
  // {"token":"<64-hex device_registration setup token>"}) returns the POSIX-sh
  // script that ensures Node.js and runs register-device full setup. Same
  // sh-safe-errors + header-token + un-gated-pre-flip rules as /agent; serving
  // the script consumes nothing (the script's own register call does).
  const serveDeviceScript = async (req: Request, res: Response): Promise<void> => {
    try {
      if (!(await withinRateLimit(req, res))) return;

      const body = req.method === 'POST'
        ? req.body as { token?: unknown; platform?: unknown } | undefined
        : undefined;
      // Same mangle-resistant header-or-body + trim as /agent (readBootstrapToken).
      const token = readBootstrapToken(req, body?.token);
      if (token.length === 0) {
        shError(res, 400, missingCodeMessage(resolveRelayUrl(), '/v1/bootstrap/device', '<setup-token>', 'Connect a computer'));
        return;
      }
      if (!isValidDeviceSetupTokenFormat(token)) {
        shError(res, 400, 'Invalid or missing setup token. Generate a fresh command in the Provian app under "Connect a computer".');
        return;
      }

      // platform:"windows" (body OR x-provian-platform header) -> PowerShell
      // (`irm … | iex`); default -> POSIX sh (`curl … | sh`).
      const relayUrl = resolveRelayUrl();
      const script = wantsWindows(req, body?.platform)
        ? buildDeviceBootstrapPowershell({ token, relayUrl })
        : buildDeviceBootstrapScript({ token, relayUrl });
      res.status(200)
        .type('text/plain; charset=utf-8')
        .set('Cache-Control', 'no-store')
        .send(script);
    } catch (error) {
      console.error('[Bootstrap] device script error:', error);
      shError(res, 500, 'Provian setup is temporarily unavailable. Please try again in a minute.');
    }
  };
  router.get('/device', serveDeviceScript);
  router.post('/device', serveDeviceScript);

  // GET (canonical) / POST / HEAD /v1/bootstrap/agent-device — "A device
  // for your agent". The emailed line carries the single-use
  // agent_device_registration token (64 hex) in x-provian-token and an optional
  // display name in x-provian-device-name. Returns the installer that runs the
  // SAME SHA-pinned bundle as /agent: register this machine to the agent's
  // wallet, then install + start the observer. Serving the script consumes
  // nothing (the bundle's own POST /v1/devices/register burns the token).
  const serveAgentDeviceScript = async (req: Request, res: Response): Promise<void> => {
    try {
      if (!(await withinRateLimit(req, res))) return;

      const body = req.method === 'POST'
        ? req.body as { token?: unknown; platform?: unknown; device_name?: unknown } | undefined
        : undefined;
      const token = readBootstrapToken(req, body?.token);
      if (token.length === 0) {
        shError(res, 400, missingCodeMessage(resolveRelayUrl(), '/v1/bootstrap/agent-device', '<setup-token>', 'A device for your agent'));
        return;
      }
      if (!isValidAgentDeviceTokenFormat(token)) {
        shError(res, 400, 'Invalid or missing device setup token. Ask for a fresh command in the Provian app under "A device for your agent".');
        return;
      }
      const bundleSha256 = resolveBundleSha256();
      if (!bundleSha256) {
        shError(res, 503, 'Provian setup is temporarily unavailable (the onboarding bundle is not ready). Please try again in a minute.');
        return;
      }
      const deviceName = safeAgentDeviceName(req.get('x-provian-device-name') ?? body?.device_name);
      const relayUrl = resolveRelayUrl();
      const script = wantsWindows(req, body?.platform)
        ? buildAgentDeviceBootstrapPowershell({ token, relayUrl, bundleSha256, deviceName })
        : buildAgentDeviceBootstrapScript({ token, relayUrl, bundleSha256, deviceName });
      res.status(200)
        .type('text/plain; charset=utf-8')
        .set('Cache-Control', 'no-store')
        .send(script);
    } catch (error) {
      console.error('[Bootstrap] agent-device script error:', error);
      shError(res, 500, 'Provian setup is temporarily unavailable. Please try again in a minute.');
    }
  };
  router.get('/agent-device', serveAgentDeviceScript);
  router.post('/agent-device', serveAgentDeviceScript);

  return router;
}
