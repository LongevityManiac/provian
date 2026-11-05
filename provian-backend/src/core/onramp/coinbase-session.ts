/**
 * Coinbase Onramp - secure initialization (session token).
 *
 * Coinbase's "secure initialization" requires a single-use session token,
 * minted server-side with a CDP Secret API Key, to be passed into the onramp
 * URL instead of the wallet address as a query param. Without it, the onramp
 * widget rejects the request with "Missing or invalid parameters ... requires
 * a sessionToken".
 *
 * This module generates the CDP JWT bearer (Ed25519 / EdDSA) via the shared
 * `coinbase-cdp-auth` module and calls
 * POST https://api.developer.coinbase.com/onramp/v1/token. Tokens are single
 * use and expire after 5 minutes, so we mint one per buy attempt.
 *
 * Docs: https://docs.cdp.coinbase.com/onramp-&-offramp/session-token-authentication
 */
import { CDP_HOST, generateCdpJwt, loadCdpCredentials } from './coinbase-cdp-auth';

export { CoinbaseNotConfiguredError } from './coinbase-cdp-auth';

const TOKEN_PATH = '/onramp/v1/token';

export interface CoinbaseSessionTokenParams {
    address: string;
    blockchains?: string[];
    assets?: string[];
    clientIp?: string;
}

/**
 * Mint a single-use Coinbase Onramp session token for a wallet address.
 * @throws CoinbaseNotConfiguredError when CDP credentials are absent.
 */
export async function createCoinbaseSessionToken(
    params: CoinbaseSessionTokenParams,
): Promise<{ token: string; channelId: string | null }> {
    const creds = loadCdpCredentials();
    const jwt = generateCdpJwt(creds, 'POST', TOKEN_PATH);
    const body = {
        addresses: [{ address: params.address, blockchains: params.blockchains ?? ['base'] }],
        assets: params.assets ?? ['USDC', 'ETH'],
        ...(params.clientIp ? { clientIp: params.clientIp } : {}),
    };

    const res = await fetch(`https://${CDP_HOST}${TOKEN_PATH}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Coinbase session token request failed (${res.status}): ${detail.slice(0, 300)}`);
    }

    const data = (await res.json()) as { token?: string; channel_id?: string };
    if (!data.token) {
        throw new Error('Coinbase session token response missing token');
    }
    return { token: data.token, channelId: data.channel_id ?? null };
}
