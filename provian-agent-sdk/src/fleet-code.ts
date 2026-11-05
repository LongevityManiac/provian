import { guardedFetch as fetch, guardedFetcher } from './guarded-fetch';
/**
 * fleet-code — any of your linked agents onboards your other agents.
 *
 * "Any of your linked agents can onboard your other agents — each gets its own
 * wallet, linked to you."
 *
 * An agent that is ACTIVE and already LINKED to its human asks the relay
 * (agent API-key auth, POST /v1/agent/wallet/:wallet_id/fleet-code) for a
 * one-hour, single-use `PROV-XXXX-XXXX` link code. The other agent runs the
 * returned install line on its OWN machine: its wallet key is generated there,
 * and at the link step the code links it to the same human with no tap in the
 * app. Nothing here carries, derives or ships any key — the issuing agent never
 * holds another agent's key.
 *
 * Pure (native fetch, injectable) so the `CommonsInstitutions.issueFleetCode()` method,
 * the `fleet-code` bin and the hosted bundle's `fleet-code` verb all share ONE
 * implementation, unit-testable with a fake fetch.
 */

export interface IssueFleetCodeParams {
  relayUrl: string;
  walletId: string;
  apiKey: string;
  apiSecret: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface FleetCodeInstallLine {
  /** macOS / Linux: `curl -sSL -H 'x-provian-token: …' "…/v1/bootstrap/agent" | sh` */
  sh: string;
  /** Windows PowerShell: `irm -Headers @{…} "…/v1/bootstrap/agent" | iex` */
  powershell: string;
}

export interface IssueFleetCodeResult {
  ok: boolean;
  status: number;
  /** The one-hour, single-use link code. */
  code?: string;
  /** Epoch ms after which the code no longer links. */
  expiresAt?: number;
  /** The install line the other agent runs on its own machine. */
  installLine?: FleetCodeInstallLine;
  /** Relay error code on failure: `not_linked`, `agent_not_active`, a 429 limit, … */
  error?: string;
}

const CODE_PATTERN = /^PROV-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

export async function issueFleetCode(params: IssueFleetCodeParams): Promise<IssueFleetCodeResult> {
  const doFetch = guardedFetcher(params.fetchImpl);
  const url = `${params.relayUrl.replace(/\/+$/, '')}/v1/agent/wallet/${encodeURIComponent(params.walletId)}/fleet-code`;
  let response: Response;
  try {
    response = await doFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.apiKey}:${params.apiSecret}`,
      },
      // An explicit (empty) body, so the request always carries Content-Length.
      body: '{}',
    });
  } catch (err) {
    return { ok: false, status: 0, error: `network_error: ${(err as Error).message}` };
  }
  let parsed: Record<string, unknown> | null = null;
  try { parsed = await response.json() as Record<string, unknown>; } catch { parsed = null; }
  if (!response.ok) {
    const error = typeof parsed?.error === 'string' ? parsed.error : `http_${response.status}`;
    return { ok: false, status: response.status, error };
  }
  const code = parsed?.code;
  const expiresAt = parsed?.expires_at;
  const line = parsed?.install_line as Record<string, unknown> | undefined;
  if (typeof code !== 'string' || !CODE_PATTERN.test(code)
    || typeof expiresAt !== 'number'
    || typeof line?.sh !== 'string' || typeof line?.powershell !== 'string') {
    return { ok: false, status: response.status, error: 'malformed_fleet_code_response' };
  }
  return {
    ok: true,
    status: response.status,
    code,
    expiresAt,
    installLine: { sh: line.sh, powershell: line.powershell },
  };
}

/** A plain sentence for a failed issue — never a raw status. */
export function friendlyFleetCodeError(error: string | undefined): string {
  if (error === 'not_linked') {
    return 'This agent is not linked to a human yet, so it cannot onboard that human\'s other agents. Finish your own link first (your human taps Accept in the Provian app).';
  }
  if (error === 'agent_not_active') return 'This agent wallet is not active.';
  if (error?.startsWith('network_error')) return 'This machine could not reach Provian — check its internet connection.';
  if (error?.includes('limit')) return 'Too many codes this hour. Try again later.';
  return `Could not issue a code (${error ?? 'unknown'}). Try again in a minute.`;
}
