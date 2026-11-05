import type { BiometricAction } from '../security/biometricAction';
/**
 * Coinbase Onramp URL generator.
 *
 * WS7: the OnRampManager singleton — mock MoonPay/Coinbase quote providers,
 * getMockRate, getQuote/getQuotes, createOrder/order tracking — was dead code.
 * Nothing imported the default export, so the mock exchange rates it returned
 * were never surfaced anywhere. It was removed. The only live surface is
 * generateCoinbaseOnRampURL (used by BuyCryptoScreen): Coinbase performs quoting
 * and KYC inside its hosted widget, so the app never needs a local quote engine.
 */

/**
 * Generate a Coinbase Onramp URL for use in a WebView, using secure
 * initialization. Coinbase requires a server-minted `sessionToken` (the wallet
 * address is encoded into the token rather than passed as a query param); the
 * legacy `appId` + addresses flow is rejected with "Missing or invalid
 * parameters ... requires a sessionToken".
 *
 * The token is fetched from the relay (which holds the CDP Secret API Key).
 * Returns null if a token can't be obtained (offline, or onramp not configured)
 * so the caller can show an error rather than a broken widget.
 *
 * @param walletAddress - EVM wallet address on Base
 * @param options - Optional overrides
 */
export async function generateCoinbaseOnRampURL(
    walletAddress: string,
    options?: {
        defaultAsset?: string;
        presetFiatAmount?: number;
    }, biometricAction?: BiometricAction,
): Promise<string | null> {
    const RelayAPIService = (await import('../../services/RelayAPIService')).default;
    const session = await RelayAPIService.getCoinbaseSessionToken(walletAddress, ['USDC', 'ETH'], biometricAction);
    if (!session) {
        return null;
    }

    const params = new URLSearchParams({
        sessionToken: session.token,
        defaultNetwork: 'base',
        defaultExperience: 'buy',
        presetFiatAmount: String(options?.presetFiatAmount ?? 50),
        handlingRequestedUrls: 'true',
    });
    if (options?.defaultAsset) {
        params.set('defaultAsset', options.defaultAsset);
    }
    // Attach the stable per-user partnerUserId so Coinbase links this buy's
    // transaction to the ref the relay later queries for on-chain source
    // verification (#30). Harmless when absent (older relay).
    if (session.partnerUserRef) {
        params.set('partnerUserId', session.partnerUserRef);
    }
    return `https://pay.coinbase.com/buy/select-asset?${params.toString()}`;
}
