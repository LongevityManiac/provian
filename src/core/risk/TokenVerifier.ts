import { VERIFIED_TOKENS, HIGH_RISK_SYMBOLS, EXPECTED_DECIMALS } from '../../data/verified-tokens';

export interface TokenImpersonationResult {
    isImpersonator: boolean;
    severity: 'critical' | 'high' | 'medium' | 'low';
    reason: string;
    realAddress?: string;
    block: boolean;
    frictionLevel?: number;
    userMessage: string;
}

class TokenVerifier {
    private static instance: TokenVerifier;

    private constructor() { }

    static getInstance(): TokenVerifier {
        if (!TokenVerifier.instance) {
            TokenVerifier.instance = new TokenVerifier();
        }
        return TokenVerifier.instance;
    }

    /**
     * Verify if a token is legitimate or an impersonator
     */
    async verifyToken(params: {
        address: string;
        symbol: string;
        decimals: number;
        chainId: number;
        name?: string;
    }): Promise<TokenImpersonationResult> {
        const { address, symbol, decimals, chainId, name } = params;

        // Check 1: Known stablecoin impersonation (CRITICAL)
        const knownTokenCheck = this.checkKnownToken(address, symbol, chainId);
        if (knownTokenCheck.isImpersonator) {
            return knownTokenCheck;
        }

        // Check 2: Decimals mismatch (HIGH)
        const decimalsCheck = this.checkDecimals(symbol, decimals);
        if (decimalsCheck.isImpersonator) {
            return decimalsCheck;
        }

        // Check 3: High-risk symbol collision (MEDIUM)
        const symbolCheck = this.checkSymbolCollision(address, symbol, chainId);
        if (symbolCheck.isImpersonator) {
            return symbolCheck;
        }

        // Token appears legitimate
        return {
            isImpersonator: false,
            severity: 'low',
            reason: 'Token appears legitimate',
            block: false,
            userMessage: ''
        };
    }

    /**
     * Check if token claims to be a known token but has wrong address
     */
    private checkKnownToken(address: string, symbol: string, chainId: number): TokenImpersonationResult {
        const verifiedTokens = VERIFIED_TOKENS[chainId as keyof typeof VERIFIED_TOKENS];

        if (!verifiedTokens) {
            return { isImpersonator: false, severity: 'low', reason: '', block: false, userMessage: '' };
        }

        const knownToken = verifiedTokens[symbol as keyof typeof verifiedTokens];

        if (knownToken && address.toLowerCase() !== knownToken.address.toLowerCase()) {
            return {
                isImpersonator: true,
                severity: 'critical',
                reason: `Fake ${symbol} detected. Address mismatch.`,
                realAddress: knownToken.address,
                block: true,
                userMessage: `🚫 FAKE ${symbol} DETECTED

This is NOT real ${symbol}.

Real ${symbol}: ${knownToken.address.slice(0, 8)}...${knownToken.address.slice(-6)}
This token: ${address.slice(0, 8)}...${address.slice(-6)}

Issuer: ${knownToken.issuer}

This is a common scam. If you buy/swap this:
• You'll receive worthless tokens
• Your money will be permanently lost  
• The scammer keeps your real funds

⚠️ ALWAYS verify token addresses before trading!

TRANSACTION BLOCKED FOR YOUR SAFETY`
            };
        }

        return { isImpersonator: false, severity: 'low', reason: '', block: false, userMessage: '' };
    }

    /**
     * Check if decimals match expected for known symbols
     */
    private checkDecimals(symbol: string, decimals: number): TokenImpersonationResult {
        const expectedDecimals = EXPECTED_DECIMALS[symbol];

        if (expectedDecimals && decimals !== expectedDecimals) {
            return {
                isImpersonator: true,
                severity: 'high',
                reason: `${symbol} decimals mismatch. Expected ${expectedDecimals}, got ${decimals}.`,
                block: true,
                userMessage: `⚠️ SUSPICIOUS ${symbol}

Real ${symbol} has ${expectedDecimals} decimals.
This token has ${decimals} decimals.

This mismatch is a common trick used by scammers to:
• Make fake tokens look real
• Confuse users about amounts
• Steal funds through swaps

TRANSACTION BLOCKED FOR YOUR SAFETY`
            };
        }

        return { isImpersonator: false, severity: 'low', reason: '', block: false, userMessage: '' };
    }

    /**
     * Check for high-risk symbol collision
     */
    private checkSymbolCollision(address: string, symbol: string, chainId: number): TokenImpersonationResult {
        const isHighRiskSymbol = HIGH_RISK_SYMBOLS.includes(symbol);
        const verifiedTokens = VERIFIED_TOKENS[chainId as keyof typeof VERIFIED_TOKENS];
        const isKnownGood = verifiedTokens && verifiedTokens[symbol as keyof typeof verifiedTokens];

        if (isHighRiskSymbol && !isKnownGood) {
            return {
                isImpersonator: true,
                severity: 'medium',
                reason: `Unknown token using high-risk symbol ${symbol}`,
                block: false,
                frictionLevel: 3, // Cooling period
                userMessage: `⚠️ UNVERIFIED ${symbol}

This token uses the symbol "${symbol}" but we cannot verify it's legitimate.

Common ${symbol} scams:
• Fake tokens on wrong networks
• Copies with similar names
• Worthless tokens claiming to be stablecoins

Before proceeding:
✓ Triple-check the contract address
✓ Verify on blockchain explorer
✓ Confirm you're on the right network
✓ Make sure you know what you're buying

Only proceed if you KNOW this is legitimate.`
            };
        }

        return { isImpersonator: false, severity: 'low', reason: '', block: false, userMessage: '' };
    }

}

export default TokenVerifier.getInstance();
