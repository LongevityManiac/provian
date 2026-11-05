/**
 * Shared relay HTTP layer for the Provian CLI.
 *
 * One fetch wrapper with consistent error classification, used by both the
 * command handlers (connect/check/report/status) and the `init` onboarding
 * wizard. This is the raw-HTTP path against the relay; the Commons institutions
 * commands speak to the relay through the @provian/agent-sdk client instead,
 * so they keep their own thin helper.
 */

export const DEFAULT_RELAY_URL = 'https://api.provian.ai';

export type CommandResult = Record<string, unknown>;

/**
 * RelayHTTPError carries the HTTP status code from a non-2xx relay response
 * so callers can distinguish auth failures (401/403) from server errors
 * (5xx) without parsing the message string.
 */
export class RelayHTTPError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'RelayHTTPError';
  }
}

/**
 * NetworkError marks failures that did not produce an HTTP response at all
 * (DNS, connection refused, TLS, etc.). Distinguishable from HTTP errors
 * so the CLI consumer can decide whether to retry.
 */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

export async function fetchJSON(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw new NetworkError(`network error reaching ${url}: ${(error as Error).message}`);
  }

  if (!response.ok) {
    const text = await response.text();
    let parsed: Record<string, unknown> | null = null;
    try { parsed = JSON.parse(text); } catch { /* ignore */ }
    throw new RelayHTTPError(
      response.status,
      (parsed?.error as string) || `HTTP ${response.status}: ${response.statusText}`,
    );
  }

  return await response.json() as Record<string, unknown>;
}

export function errorResult(error: unknown): CommandResult {
  if (error instanceof RelayHTTPError) {
    const kind = error.status === 401 || error.status === 403 ? 'auth_error'
      : error.status === 429 ? 'rate_limited'
      : error.status >= 500 ? 'server_error'
      : 'http_error';
    return { status: 'error', kind, httpStatus: error.status, error: error.message };
  }
  if (error instanceof NetworkError) {
    return { status: 'error', kind: 'network_error', error: error.message };
  }
  return { status: 'error', kind: 'unknown', error: (error as Error).message };
}
