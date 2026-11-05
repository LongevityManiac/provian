/**
 * The relay's store-purchase runtime, from relay config.
 *
 * - App Store: `APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_KEY_ID`, and
 *   `APP_STORE_CONNECT_PRIVATE_KEY` (the .p8 key's PEM text).
 * - Google Play: `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` (the service account's JSON key).
 * - `STORE_ACCEPT_SANDBOX=true` credits purchases the store itself marks as sandbox / license-test
 *   purchases (App Review and testers buy in the sandbox). Anything else leaves them refused. It
 *   never credits a purchase the store did not confirm.
 * A store whose config is missing or unreadable has no credentials, and every purchase from it is
 * refused as not configured.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { createPrivateKey } from 'crypto';
import type { PayoutDeps } from '../payout/on-demand-payout';
import type { StorePurchaseDeps } from './store-purchase-service';
import {
  acknowledgePlayPurchase,
  verifyAppStorePurchase,
  verifyPlayPurchase,
  type AppStoreCredentials,
  type PlayCredentials,
  type StoreFetch,
} from './store-verify';

type Env = Record<string, string | undefined>;

function pem(value: string | undefined): string | null {
  if (value === undefined || value.trim().length === 0) return null;
  const text = value.includes('\\n') ? value.replace(/\\n/g, '\n') : value;
  try {
    createPrivateKey(text);
    return text;
  } catch {
    return null;
  }
}

export function appStoreCredentialsFrom(env: Env): AppStoreCredentials | null {
  const issuerId = env.APP_STORE_CONNECT_ISSUER_ID?.trim();
  const keyId = env.APP_STORE_CONNECT_KEY_ID?.trim();
  const privateKeyPem = pem(env.APP_STORE_CONNECT_PRIVATE_KEY);
  if (!issuerId || !keyId || privateKeyPem === null) return null;
  return { issuerId, keyId, privateKeyPem };
}

export function playCredentialsFrom(env: Env): PlayCredentials | null {
  const raw = env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  if (raw === undefined || raw.trim().length === 0) return null;
  try {
    const json = JSON.parse(raw) as { client_email?: unknown; private_key?: unknown };
    const privateKeyPem = typeof json.private_key === 'string' ? pem(json.private_key) : null;
    if (typeof json.client_email !== 'string' || privateKeyPem === null) return null;
    return { clientEmail: json.client_email, privateKeyPem };
  } catch {
    return null;
  }
}

const globalFetch: StoreFetch = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: AbortSignal.timeout(15_000) });
  return { status: res.status, json: () => res.json() as Promise<unknown> };
};

export function createStorePurchaseDeps(params: {
  readonly db: Firestore;
  readonly env: Env;
  readonly payout: () => PayoutDeps | null;
  readonly fetch?: StoreFetch;
}): StorePurchaseDeps {
  const appStore = appStoreCredentialsFrom(params.env);
  const play = playCredentialsFrom(params.env);
  const acceptSandbox = params.env.STORE_ACCEPT_SANDBOX === 'true';
  const fetchFn = params.fetch ?? globalFetch;
  return {
    db: params.db,
    now: () => Date.now(),
    acceptSandbox,
    payout: params.payout,
    verifyAppStore: (jws) => verifyAppStorePurchase({ creds: appStore, fetch: fetchFn, nowMs: Date.now(), acceptSandbox }, jws),
    verifyPlay: (input) => verifyPlayPurchase({ creds: play, fetch: fetchFn, nowMs: Date.now() }, input),
    acknowledgePlay: (input) => acknowledgePlayPurchase({ creds: play, fetch: fetchFn, nowMs: Date.now() }, input),
  };
}
