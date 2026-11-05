/**
 * — the person's on-demand payout payment.
 *
 * Standard earnings settle on a schedule Provian sets, currently every 30 days for free. To settle now, the person pays a flat $1 USDC service
 * fee from their own wallet: an EIP-3009 `TransferWithAuthorization` on Base USDC, signed on this
 * device with the wallet key, carried to the relay as an x402 v2 payment. It is never a price for
 * PVT — the same $1 whatever the person is owed.
 *
 * The app does NOT trust the relay's quote for the money terms: amount, token, chain and recipient
 * are pinned here, and a quote that names anything else is refused before the key is touched.
 * Mirrors `provian-backend/src/core/payout/payout-terms.ts`.
 */
import { TOKEN_ADDRESSES } from '../chains/evm/config';

export const PAYOUT_FEE_USDC_ATOMIC = '1000000';
export const PAYOUT_NETWORK = 'eip155:8453';
/** Provian's revenue wallet (the relay's PROVIAN_TREASURY), lowercased. */
export const PAYOUT_FEE_RECIPIENT = '0x086e0f377af1245b8888540f39e99a42a7daf1da';
const BASE_USDC = TOKEN_ADDRESSES[8453].USDC.toLowerCase();

export const BASE_USDC_EIP712_DOMAIN = Object.freeze({
    name: 'USD Coin',
    version: '2',
    chainId: 8453,
    verifyingContract: BASE_USDC,
});

const TYPES = {
    TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
    ],
};

export interface PayoutRequirement {
    scheme: string;
    network: string;
    amount: string;
    asset: string;
    payTo: string;
    maxTimeoutSeconds?: number;
    extra?: Record<string, unknown>;
}

/** The narrow signer surface (an ethers `Wallet` satisfies it). */
export interface PayoutSigner {
    readonly address: string;
    signTypedData(domain: typeof BASE_USDC_EIP712_DOMAIN, types: typeof TYPES, value: Record<string, unknown>): Promise<string>;
}

/**
 * Refuse any quote whose money terms differ from a pinned USDC service fee (Base USDC, Provian's
 * revenue wallet, exactly `amountAtomic`). Returns a reason or null. Shared by the $1 payout and
 * the $5 PE Archive GB (`core/meter/archivePayment.ts`).
 */
export function usdcServiceRequirementProblem(req: PayoutRequirement | null | undefined, amountAtomic: string): string | null {
    if (!req) return 'no_requirement';
    if (req.scheme !== 'exact') return 'scheme';
    if (req.network !== PAYOUT_NETWORK) return 'network';
    if (String(req.asset).toLowerCase() !== BASE_USDC) return 'asset';
    if (String(req.payTo).toLowerCase() !== PAYOUT_FEE_RECIPIENT) return 'recipient';
    if (String(req.amount) !== amountAtomic) return 'amount';
    return null;
}

/** Refuse any quote whose money terms differ from the pinned $1 fee. Returns a reason or null. */
export function payoutRequirementProblem(req: PayoutRequirement | null | undefined): string | null {
    return usdcServiceRequirementProblem(req, PAYOUT_FEE_USDC_ATOMIC);
}

function randomNonce(): string {
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function toBase64(text: string): string {
    // The payload is ASCII JSON. The app runs on Hermes (global btoa) and tests on Node (Buffer).
    if (typeof globalThis.btoa === 'function') return globalThis.btoa(text);
    return Buffer.from(text, 'utf8').toString('base64');
}

/**
 * Sign a pinned USDC service fee (`amountAtomic` to Provian's revenue wallet on Base) and return the
 * base64 x402 v2 payment the relay expects. A quote naming other terms is refused before signing.
 */
export async function signUsdcServicePayment(
    signer: PayoutSigner,
    requirement: PayoutRequirement | null,
    amountAtomic: string,
    refusalPrefix: string,
    nowMs: number = Date.now(),
    nonce: string = randomNonce(),
): Promise<string> {
    const problem = usdcServiceRequirementProblem(requirement, amountAtomic);
    if (problem !== null || requirement === null) throw new Error(`${refusalPrefix}:${problem ?? 'no_requirement'}`);
    const nowSeconds = Math.floor(nowMs / 1000);
    const authorization = {
        from: signer.address,
        to: PAYOUT_FEE_RECIPIENT,
        value: amountAtomic,
        validAfter: '0',
        validBefore: String(nowSeconds + 300),
        nonce,
    };
    const signature = await signer.signTypedData(BASE_USDC_EIP712_DOMAIN, TYPES, authorization);
    return toBase64(JSON.stringify({
        x402Version: 2,
        accepted: { ...requirement, asset: BASE_USDC, payTo: PAYOUT_FEE_RECIPIENT, amount: amountAtomic },
        payload: { signature, authorization },
    }));
}

/** Sign the pinned $1 payment and return the base64 x402 v2 payment the relay expects. */
export async function signPayoutPayment(
    signer: PayoutSigner,
    requirement: PayoutRequirement | null,
    nowMs: number = Date.now(),
    nonce: string = randomNonce(),
): Promise<string> {
    return signUsdcServicePayment(signer, requirement, PAYOUT_FEE_USDC_ATOMIC, 'payout_quote_refused', nowMs, nonce);
}
