/**
 * Coinbase CDP (Developer Platform) request authentication — shared by every
 * CDP REST call the relay makes (Onramp session-token mint AND the Onramp
 * Transaction Status read; the PE Archive's x402 settlement through CDP's
 * facilitator signs with the same key, `core/payments/cdp-facilitator.ts`).
 *
 * CDP REST endpoints authenticate with a short-lived JWT bearer signed by a CDP
 * **Secret** API Key (Ed25519 / EdDSA). A Client API Key does NOT work on these
 * endpoints. The relay holds the Secret key in Secret Manager
 * (`coinbase-cdp-api-private-key`) + the key id in env.
 *
 * Required env (provisioned in Secret Manager; the private key is a secret):
 *   COINBASE_CDP_API_KEY_ID       - the CDP Secret API Key id (UUID)
 *   COINBASE_CDP_API_PRIVATE_KEY  - the Ed25519 private key, base64 (64 bytes)
 *
 * No external deps: Node's crypto signs Ed25519 natively.
 * Docs: https://docs.cdp.coinbase.com/onramp-&-offramp/session-token-authentication
 */
import crypto from 'crypto';

/** CDP REST host — the same host mints session tokens and serves transactions. */
export const CDP_HOST = 'api.developer.coinbase.com';

/** Thrown when the CDP credentials are not configured (endpoint returns 503). */
export class CoinbaseNotConfiguredError extends Error {
    constructor() {
        super('Coinbase CDP API key not configured');
        this.name = 'CoinbaseNotConfiguredError';
    }
}

/** Resolved CDP Secret API Key credentials. */
export interface CdpCredentials {
    keyId: string;
    secret: string;
}

/**
 * Load the CDP Secret API Key credentials from env, or throw
 * CoinbaseNotConfiguredError when either is absent so callers can return 503.
 */
export function loadCdpCredentials(): CdpCredentials {
    const keyId = process.env.COINBASE_CDP_API_KEY_ID;
    const secret = process.env.COINBASE_CDP_API_PRIVATE_KEY;
    if (!keyId || !secret) {
        throw new CoinbaseNotConfiguredError();
    }
    return { keyId, secret };
}

function base64url(buf: Buffer): string {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Build a Node KeyObject from a CDP Ed25519 secret key.
 * CDP delivers the key as base64 of 64 bytes (32-byte seed + 32-byte public
 * key). We wrap the seed in the fixed Ed25519 PKCS8 DER prefix. Shared with the
 * x402 facilitator client (`core/payments/cdp-facilitator.ts`).
 */
export function ed25519KeyFromCdpSecret(secretB64: string): crypto.KeyObject {
    const raw = Buffer.from(secretB64, 'base64');
    if (raw.length < 32) {
        throw new Error('Invalid CDP Ed25519 private key (expected >=32 bytes)');
    }
    const seed = raw.subarray(0, 32);
    const pkcs8 = Buffer.concat([
        Buffer.from('302e020100300506032b657004220420', 'hex'),
        seed,
    ]);
    return crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
}

/**
 * Mint a short-lived CDP JWT bearer for ONE request (valid 120s).
 *
 * `path` is the request path WITHOUT query string (CDP signs the method + host +
 * path only — query params are appended to the URL but not to the `uri` claim),
 * e.g. `/onramp/v1/token` or `/onramp/v1/buy/user/<ref>/transactions`.
 */
export function generateCdpJwt(
    creds: CdpCredentials,
    method: string,
    path: string,
    host: string = CDP_HOST,
): string {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'EdDSA', typ: 'JWT', kid: creds.keyId };
    const payload = {
        sub: creds.keyId,
        iss: 'cdp',
        aud: ['cdp_service'],
        nbf: now,
        exp: now + 120,
        uri: `${method} ${host}${path}`,
    };
    const signingInput =
        `${base64url(Buffer.from(JSON.stringify(header)))}.${base64url(Buffer.from(JSON.stringify(payload)))}`;
    const signature = crypto.sign(null, Buffer.from(signingInput), ed25519KeyFromCdpSecret(creds.secret));
    return `${signingInput}.${base64url(signature)}`;
}
