import { guardedFetch as fetch, guardedFetcher } from './guarded-fetch';
/**
 * request-link — file a connection-code link REQUEST to the human who issued the
 * code, closing the onboarding gap on the agent side.
 *
 * This asks the relay (agent-API-key auth) to record a pending link request from
 * this agent to the human who generated the connection code. It creates a
 * REQUEST, never a bind: the human still authorizes the link in-app (their
 * wallet auth + biometric), which is the security anchor. Nothing here moves
 * economics or links anything on its own.
 *
 * The one exception : a FLEET code — minted by any agent already
 * linked to the human (`fleet-code`) — links this agent to that human at the relay
 * directly, single-use, with no Accept; the result is then `linkStatus: 'linked'`,
 * `linkedVia: 'fleet_code'`. An expired code of either kind is refused 410
 * `connection_token_expired` (ask for a fresh code).
 *
 * Pure and dependency-free (native fetch) so it can be called from the bootstrap flow
 * and the standalone `request-link` command, and unit-tested with a fake fetch.
 */

export interface RequestLinkParams {
  relayUrl: string;
  walletId: string;
  connectionToken: string;
  apiKey: string;
  apiSecret: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface RequestLinkResult {
  ok: boolean;
  status: number;
  /** The pending request id, when one was created or reused. */
  requestId?: string;
  /**
   * 'pending' (a request is awaiting the human's Accept), 'already_linked', or
   * 'linked' a fleet code (issued by one of the human's linked agents) linked this
   * agent directly, with no Accept.
   */
  linkStatus?: 'pending' | 'already_linked' | 'linked';
  /** How a 'linked' result formed: 'fleet_code'. */
  linkedVia?: 'fleet_code';
  /** Relay error code on failure (e.g. connection_token_issuer_unresolved). */
  error?: string;
}

export async function requestLink(params: RequestLinkParams): Promise<RequestLinkResult> {
  const doFetch = guardedFetcher(params.fetchImpl);
  const url = `${params.relayUrl.replace(/\/+$/, '')}/v1/agent/wallet/${params.walletId}/request-link`;

  let response: Response;
  try {
    response = await doFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Agent API-key auth — the same Bearer key:secret shape every agent
        // API-key route uses. The human link itself is NOT authorized here.
        Authorization: `Bearer ${params.apiKey}:${params.apiSecret}`,
      },
      body: JSON.stringify({ connection_token: params.connectionToken }),
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

  const linkStatus = parsed?.status === 'already_linked'
    ? 'already_linked'
    : parsed?.status === 'linked' ? 'linked' : 'pending';
  return {
    ok: true,
    status: response.status,
    requestId: typeof parsed?.request_id === 'string' ? parsed.request_id : undefined,
    linkStatus,
    ...(linkStatus === 'linked' && parsed?.linked_via === 'fleet_code' ? { linkedVia: 'fleet_code' as const } : {}),
  };
}
