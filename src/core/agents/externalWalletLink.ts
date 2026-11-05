/**
 * Pure helpers for proving a third-party wallet: linked to a linked agent
 * (relay: POST /v1/agent/wallet/:id/external-address/*), or proven by the person
 * themself (relay: POST /v1/wallet/external-address/*).
 */

import { ethers } from 'ethers';

/** i18n key (under `linkExternalWallet.`) for each failure the flow can hit. */
export type ExternalLinkErrorKey =
    | 'errorNotYourAgent'
    | 'errorAgentInactive'
    | 'errorOwnProvian'
    | 'errorAgentNative'
    | 'errorBoundOther'
    | 'errorProvianWallet'
    | 'errorBoundOtherOwner'
    | 'errorSignature'
    | 'errorExpired'
    | 'errorRateLimited'
    | 'errorInvalidAddress'
    | 'errorWalletRejected'
    | 'errorWalletNoAccount'
    | 'errorUnavailable'
    | 'errorGeneric';

/** Map a relay error code (or a WalletConnect failure) onto one user-facing sentence key. */
export function externalLinkErrorKey(code: string | null | undefined): ExternalLinkErrorKey {
    switch (code) {
        case 'not_your_linked_agent':
            return 'errorNotYourAgent';
        case 'agent_not_active':
        case 'agent_identity_unavailable':
            return 'errorAgentInactive';
        case 'address_is_your_provian_wallet':
            return 'errorOwnProvian';
        case 'address_is_agent_native_wallet':
            return 'errorAgentNative';
        case 'address_bound_to_other_agent':
            return 'errorBoundOther';
        // Person-mode refusals (POST /v1/wallet/external-address/*).
        case 'address_is_provian_wallet':
            return 'errorProvianWallet';
        case 'address_bound_to_other_owner':
            return 'errorBoundOtherOwner';
        case 'no_human_wallet':
        case 'human_wallet_not_active':
        case 'human_wallet_ambiguous':
            return 'errorGeneric';
        case 'signature_invalid':
        case 'address_mismatch':
        case 'agent_mismatch':
        case 'walletconnect_bad_signature':
            return 'errorSignature';
        case 'challenge_expired':
        case 'challenge_not_found':
        case 'challenge_consume_failed':
            return 'errorExpired';
        case 'http_429':
            return 'errorRateLimited';
        case 'invalid_address':
        case 'address must be a valid EVM address':
            return 'errorInvalidAddress';
        case 'wallet_rejected':
            return 'errorWalletRejected';
        case 'wallet_no_account':
            return 'errorWalletNoAccount';
        case 'head_block_unavailable':
        case 'baseline_nonce_unavailable':
        case 'proof_evidence_changed':
        case 'cache_unavailable':
        case 'pe_emission_failed':
        case 'temporarily_unavailable':
        case 'http_503':
            return 'errorUnavailable';
        default:
            return code && /rate limit/i.test(code) ? 'errorRateLimited' : 'errorGeneric';
    }
}

/** A WalletConnect rejection (the human declined in their wallet app). */
export function isWalletRejection(err: unknown): boolean {
    const e = err as { code?: unknown; message?: unknown } | null;
    if (e && (e.code === 4001 || e.code === 5000 || e.code === 5002)) return true;
    const msg = typeof e?.message === 'string' ? e.message : String(err ?? '');
    return /reject|denied|declined|cancel/i.test(msg);
}

/** Normalize a typed address; null when it is not a valid EVM address. */
export function normalizeExternalAddress(input: string): string | null {
    const trimmed = input.trim();
    return ethers.isAddress(trimmed) ? trimmed.toLowerCase() : null;
}

/** Normalize a pasted signature: trims and adds a missing 0x; null when not hex. */
export function normalizePastedSignature(input: string): string | null {
    const trimmed = input.trim().replace(/\s+/g, '');
    const hex = trimmed.startsWith('0x') || trimmed.startsWith('0X') ? `0x${trimmed.slice(2)}` : `0x${trimmed}`;
    return /^0x[0-9a-fA-F]{130,}$/.test(hex) ? hex : null;
}

/** "0x1234…abcd" for compact display. */
export function shortAddress(address: string): string {
    return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}
