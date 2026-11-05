import { guardedFetch as fetch, guardedFetcher } from './guarded-fetch';
/**
 * connection-code-check — ask the relay about a connection code before `onboard` writes anything.
 *
 * The npm twin of the check the hosted install script runs in sh and PowerShell
 * (`agentCodeCheckSh`, `agentCodeCheckPs` in provian-backend/src/core/agent-bootstrap-script.ts,
 * kept equal to this file by bootstrap.code-check.test.ts). The relay answers 200 for a live code
 * and 404, 409 or 410 for a dead one. Anything else leaves the code unruled, and an unruled code
 * stops the install too (Unknown = Block). The check is a read and spends nothing.
 *
 * A machine already holding a wallet skips the check. Re-running is how an installed agent updates
 * and repairs itself, the code it holds has usually expired, and only request-link, which knows
 * the wallet asking, can rule on a resume.
 */

import * as fs from 'fs';
import { isValidConnectionTokenFormat } from './connection-token-format';
import { getDefaultKeystorePath } from './keystore';
import { DEFAULT_PENDING_AGENT_WALLET_REGISTRATION_PATH } from './pending-wallet-registration';

/** MIRRORS AGENT_BOOTSTRAP_CODE_CHECK_ROUTE in provian-backend/src/core/agent-bootstrap-script.ts. */
export const CONNECTION_CODE_CHECK_ROUTE = '/v1/bootstrap/agent/code';

/** The hosted script's limits: three tries, thirty seconds each. */
const CHECK_ATTEMPTS = 3;
const CHECK_TIMEOUT_MS = 30_000;

export type ConnectionCodeCheck =
  /** The code is live, or this machine holds a wallet and request-link rules on the resume. */
  | { verdict: 'proceed' }
  | { verdict: 'dead' }
  | { verdict: 'rate_limited' }
  /**
   * No ruling: `error` says why, in the shape describeSetupFailure reads. `answered` means
   * something answered that is no ruling. It may be a filtering proxy and not the relay.
   */
  | { verdict: 'unruled'; error: unknown; answered?: true };

/** Every status that rules. Any other answer leaves the code unruled. */
const RELAY_RULINGS: Readonly<Record<number, ConnectionCodeCheck>> = {
  200: { verdict: 'proceed' },
  404: { verdict: 'dead' },
  409: { verdict: 'dead' },
  410: { verdict: 'dead' },
  429: { verdict: 'rate_limited' },
};

export interface ConnectionCodeCheckOptions {
  fetchImpl?: typeof fetch;
  /** Test seam: the files that mean this machine holds a wallet, or one on its way. */
  walletFiles?: readonly string[];
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

async function askRelay(
  url: string,
  connectionToken: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<ConnectionCodeCheck> {
  const signal = AbortSignal.timeout(timeoutMs);
  const timedOut = (): ConnectionCodeCheck =>
    ({ verdict: 'unruled', error: Object.assign(new Error('the invite code check timed out'), { code: 'ETIMEDOUT' }) });

  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { 'x-provian-token': connectionToken }, signal });
  } catch (error) {
    if (signal.aborted) return timedOut();
    // guardedFetch refuses every redirect, so this one was an answer, and no ruling.
    if (error instanceof Error && error.message === 'egress redirect refused') return { verdict: 'unruled', answered: true, error };
    return { verdict: 'unruled', error };
  }

  const ruling = RELAY_RULINGS[res.status];
  if (!ruling) {
    void res.body?.cancel().catch(() => undefined);
    return { verdict: 'unruled', answered: true, error: Object.assign(new Error('the invite code check did not finish'), { code: `HTTP_${res.status}` }) };
  }
  try {
    // The status arrives before the body: a connection dropped after a ruling is no ruling.
    await res.text();
  } catch {
    if (signal.aborted) return timedOut();
    return { verdict: 'unruled', error: Object.assign(new Error('the connection dropped before the answer finished'), { code: 'ECONNRESET' }) };
  }
  return ruling;
}

/**
 * Whether this machine may start an install with this code. Never writes, and never throws: a
 * failure to ask comes back as `unruled`. The code rides the header, never the URL.
 */
export async function checkConnectionCode(
  input: { connectionToken: string; relayUrl: string },
  options: ConnectionCodeCheckOptions = {},
): Promise<ConnectionCodeCheck> {
  const walletFiles = options.walletFiles ?? [getDefaultKeystorePath(), DEFAULT_PENDING_AGENT_WALLET_REGISTRATION_PATH];
  if (walletFiles.some((file) => fs.existsSync(file))) return { verdict: 'proceed' };
  // The hosted route refuses a malformed code before it serves the script. No relay can know one.
  if (!isValidConnectionTokenFormat(input.connectionToken)) return { verdict: 'dead' };

  const fetchImpl = guardedFetcher(options.fetchImpl ?? fetch);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const url = `${input.relayUrl.replace(/\/+$/, '')}${CONNECTION_CODE_CHECK_ROUTE}`;
  for (let attempt = 1; ; attempt += 1) {
    const check = await askRelay(url, input.connectionToken, fetchImpl, options.timeoutMs ?? CHECK_TIMEOUT_MS);
    if (check.verdict === 'proceed' || check.verdict === 'dead' || attempt >= CHECK_ATTEMPTS) return check;
    await sleep(attempt * 1000);
  }
}
