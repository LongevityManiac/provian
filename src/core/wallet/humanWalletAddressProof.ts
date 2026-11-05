/**
 * the human wallet's registration PROVES control of its address.
 *
 * The relay binds a NEW human wallet registration only when it carries an EIP-712 signature by the
 * address's own key over `RegisterHumanWallet { user_id, address, device_id, timestamp }` (the relay
 * rebuilds the message from its own auth context, so the proof is bound to this account, this device
 * and this address; ±5 minutes; single-use). An EXISTING registration replays proof-free, so the app
 * tries without a proof first and signs only when the relay answers `428 address_proof_required` * a wallet registered before never prompts for anything.
 *
 * Mirrors `provian-backend/src/core/wallet-registration/human-wallet-address-proof.ts` (domain +
 * types pinned by a shared digest vector in both suites). The domain names "Provian", which the
 * WalletConnect path refuses to sign for any dApp, so no external site can obtain this signature.
 */

export const HUMAN_WALLET_REGISTRATION_DOMAIN = Object.freeze({
    name: 'Provian Human Wallet Registration',
    version: '1',
    chainId: 8453,
});

export const HUMAN_WALLET_REGISTRATION_TYPES = {
    RegisterHumanWallet: [
        { name: 'user_id', type: 'string' },
        { name: 'address', type: 'address' },
        { name: 'device_id', type: 'string' },
        { name: 'timestamp', type: 'uint256' },
    ],
};

export interface HumanWalletAddressProof {
    signature: string;
    timestamp: number;
}

/** The narrow signer surface (an ethers `Wallet` satisfies it). */
export interface TypedDataSigner {
    signTypedData(
        domain: typeof HUMAN_WALLET_REGISTRATION_DOMAIN,
        types: typeof HUMAN_WALLET_REGISTRATION_TYPES,
        value: Record<string, unknown>,
    ): Promise<string>;
}

export function humanWalletRegistrationMessage(params: {
    userId: string;
    address: string;
    deviceId: string;
    nowMs: number;
}): { user_id: string; address: string; device_id: string; timestamp: number } {
    return {
        user_id: params.userId,
        address: params.address.toLowerCase(),
        device_id: params.deviceId,
        timestamp: Math.floor(params.nowMs / 1000),
    };
}

export async function signHumanWalletAddressProof(
    signer: TypedDataSigner,
    params: { userId: string; address: string; deviceId: string; nowMs: number },
): Promise<HumanWalletAddressProof> {
    const message = humanWalletRegistrationMessage(params);
    const signature = await signer.signTypedData(HUMAN_WALLET_REGISTRATION_DOMAIN, HUMAN_WALLET_REGISTRATION_TYPES, message);
    return { signature, timestamp: message.timestamp };
}

/**
 * Register: first WITHOUT a proof (an existing registration replays proof-free); on
 * `428 address_proof_required` sign once and retry WITH the proof. Returns the final response.
 *
 * `sign` returns null when this device is NOT authorized to prove the address for its current
 * account (round-robin fairness): a proof may displace an unproven registration of the address
 * including the key holder's OWN intact legacy account — so it is signed only when the relay has
 * definitively placed this device on the address's account (a successful credential recovery) or
 * the address is brand new (fresh wallet creation). Never after a transient recovery failure.
 * On null the 428 is returned as-is and nothing binds.
 */
export async function registerWithAddressProof<R extends { status: number }>(
    post: (addressProof: HumanWalletAddressProof | null) => Promise<R>,
    sign: () => Promise<HumanWalletAddressProof | null>,
): Promise<R> {
    const first = await post(null);
    if (first.status !== 428) return first;
    const proof = await sign();
    if (proof === null) return first;
    return post(proof);
}

/**
 * round-robin fairness: the per-device record of WHICH relay account may carry an address proof
 * for WHICH address. Written only when the relay has DEFINITIVELY placed this device on the
 * address's account — a resolved `/v1/users/recover` (recovered, or owner-missing → fresh account)
 * or when the address was freshly generated on this device (`userId: null` no other account can
 * hold a registration of a never-before-seen key). Never written after a transient failure.
 */
export interface AddressProofAuthorization {
    readonly address: string;
    readonly userId: string | null;
}

export function encodeAddressProofAuthorization(auth: AddressProofAuthorization): string {
    return JSON.stringify({ address: auth.address.toLowerCase(), userId: auth.userId });
}

/**
 * May the device's CURRENT relay account (`currentUserId`) sign a registration proof for
 * `address`? Fail-closed: a missing, malformed, other-address or other-account record is NO.
 */
export function addressProofAuthorized(
    stored: string | null,
    currentUserId: string | null,
    address: string,
): boolean {
    if (stored === null || currentUserId === null || currentUserId === '') return false;
    let parsed: unknown;
    try {
        parsed = JSON.parse(stored);
    } catch {
        return false;
    }
    if (typeof parsed !== 'object' || parsed === null) return false;
    const rec = parsed as { address?: unknown; userId?: unknown };
    if (typeof rec.address !== 'string' || rec.address !== address.toLowerCase()) return false;
    if (rec.userId === null) return true; // freshly generated on this device
    return typeof rec.userId === 'string' && rec.userId === currentUserId;
}

/**
 * round-robin fairness: produce the registration proof for a 428, or null (nothing binds).
 * `allowed: false` (a caller that just saw recovery fail transiently) -> null, nothing signed.
 * Not yet authorized -> run recovery FIRST and sign only if it resolved AND now authorizes this
 * account; a rejected recovery (503, 429, network, declined biometric) -> null.
 */
export async function authorizedAddressProof(deps: {
    readonly allowed: boolean;
    readonly isAuthorized: () => Promise<boolean>;
    readonly recover: () => Promise<unknown>;
    readonly sign: () => Promise<HumanWalletAddressProof>;
}): Promise<HumanWalletAddressProof | null> {
    if (!deps.allowed) return null;
    if (!(await deps.isAuthorized())) {
        try {
            await deps.recover();
        } catch {
            return null;
        }
        if (!(await deps.isAuthorized())) return null;
    }
    return deps.sign();
}
