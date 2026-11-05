import { guardedFetcher } from '../guarded-fetch';
/**
 * Pure connect-flow function - extracted from connect-github.ts so the
 * polling + state-management logic is testable without spawning a
 * subprocess or hitting the network.
 *
 * The CLI script (connect-github.ts) injects: a state nonce, a real
 * fetch, a real sleep, a real browser-opener. Tests inject mock
 * versions of all four.
 */

export interface ConnectFlowDeps {
  relayUrl: string;
  deviceKey: string;
  deviceSecret: string;
  state: string;
  timeoutMs: number;
  /** Defaults to globalThis.fetch in the CLI; overridable for tests. */
  fetch: typeof globalThis.fetch;
  /** Defaults to setTimeout-based in the CLI; overridable for tests. */
  sleep: (ms: number) => Promise<void>;
  /** Called once after the install URL is known. CLI opens browser; tests assert it was called. */
  onInstallUrl: (url: string) => Promise<void>;
  /** Called before each poll attempt, starting at 1. Optional. */
  onPoll?: (attempt: number) => void;
  /** Interval between polls. Defaults to 2 seconds. */
  pollIntervalMs?: number;
}

export type ConnectFlowResult =
  | { status: 'completed'; install_id: string; pe_id: string }
  | { status: 'timeout' }
  | { status: 'error'; error: string };

const DEFAULT_POLL_INTERVAL_MS = 2000;

function authHeader(deviceKey: string, deviceSecret: string): string {
  return `DeviceKey ${deviceKey}:${deviceSecret}`;
}

/**
 * Run the full connect flow:
 *   1. POST /v1/witnesses/github/connect/start → install_url
 *   2. onInstallUrl(url) - CLI opens browser; user installs on github.com
 *   3. Poll GET /v1/witnesses/github/connect/poll?state=... until
 *      completed | expired | timeoutMs elapsed.
 */
export async function runConnectFlow(deps: ConnectFlowDeps): Promise<ConnectFlowResult> {
  const startUrl = `${deps.relayUrl}/v1/witnesses/github/connect/start`;
  let startResp: Response;
  try {
    startResp = await guardedFetcher(deps.fetch)(startUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(deps.deviceKey, deps.deviceSecret),
      },
      body: JSON.stringify({ state: deps.state }),
    });
  } catch (err) {
    return { status: 'error', error: `start request failed: ${(err as Error).message}` };
  }

  if (!startResp.ok) {
    const body = await startResp.text().catch(() => '');
    return {
      status: 'error',
      error: `start returned ${startResp.status}: ${body.slice(0, 200)}`,
    };
  }

  let startPayload: { install_url?: string; expires_at?: number };
  try {
    startPayload = (await startResp.json()) as { install_url?: string; expires_at?: number };
  } catch (err) {
    return { status: 'error', error: `start response was not JSON: ${(err as Error).message}` };
  }
  if (!startPayload.install_url) {
    return { status: 'error', error: 'start response missing install_url' };
  }

  await deps.onInstallUrl(startPayload.install_url);

  // Poll until completion, expiry, or local timeout.
  const pollInterval = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + deps.timeoutMs;
  const pollUrl = `${deps.relayUrl}/v1/witnesses/github/connect/poll?state=${encodeURIComponent(deps.state)}`;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    if (deps.onPoll) deps.onPoll(attempt);
    let pollResp: Response;
    try {
      pollResp = await guardedFetcher(deps.fetch)(pollUrl, {
        method: 'GET',
        headers: { Authorization: authHeader(deps.deviceKey, deps.deviceSecret) },
      });
    } catch (err) {
      // Transient network error - keep trying until the deadline.
      await deps.sleep(pollInterval);
      continue;
    }
    if (!pollResp.ok) {
      const body = await pollResp.text().catch(() => '');
      return {
        status: 'error',
        error: `poll returned ${pollResp.status}: ${body.slice(0, 200)}`,
      };
    }
    let pollPayload: {
      status?: string;
      install_id?: string;
      pe_id?: string;
    };
    try {
      pollPayload = (await pollResp.json()) as {
        status?: string;
        install_id?: string;
        pe_id?: string;
      };
    } catch (err) {
      return { status: 'error', error: `poll response was not JSON: ${(err as Error).message}` };
    }
    if (pollPayload.status === 'completed' && pollPayload.install_id && pollPayload.pe_id) {
      return {
        status: 'completed',
        install_id: pollPayload.install_id,
        pe_id: pollPayload.pe_id,
      };
    }
    if (pollPayload.status === 'expired') {
      return { status: 'timeout' };
    }
    if (pollPayload.status === 'conflict') {
      // The relay's hijack guard (2026-10-17): this installation is active under
      // another Provian wallet. Nothing was changed on the relay.
      return {
        status: 'error',
        error: 'installation_already_linked: this GitHub App installation is connected to another '
          + 'Provian wallet. Disconnect it from that wallet (or uninstall and reinstall the app on '
          + 'GitHub, which issues a new installation) before connecting it here.',
      };
    }
    // 'pending' → wait and retry
    await deps.sleep(pollInterval);
  }
  return { status: 'timeout' };
}
