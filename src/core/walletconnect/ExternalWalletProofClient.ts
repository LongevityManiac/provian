import { translate } from '../../i18n/translate';
/**
 * ExternalWalletProofClient — the app as a WalletConnect *dApp*.
 *
 * The rest of src/core/walletconnect/ is WALLET-side: dApps ask the Provian
 * wallet to sign (WalletConnectService + the crypto-governance pipeline). This
 * module is the other direction and serves exactly one flow: the linked human
 * links a THIRD-PARTY wallet (MetaMask, Coinbase Wallet, Rainbow, Trust …) to
 * one of their agents. The app proposes a session to that wallet, reads the
 * address it exposes, and asks it to `personal_sign` the relay's one-time
 * "Provian proof of control" message — the exact text, byte for byte.
 *
 * What this module never does: sign anything with the Provian wallet key (the
 * human's own wallet refuses that message — walletconnect/provianReserved.ts),
 * send a transaction, or request any method other than `personal_sign`.
 *
 * Configuration: the same WalletConnect Cloud project id as the wallet side
 * (EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID), with its OWN storage prefix so the
 * proposer's pairings/sessions never mix with the wallet's.
 */

import '@walletconnect/react-native-compat';
import SignClient from '@walletconnect/sign-client';
import type { SessionTypes } from '@walletconnect/types';
import { ethers } from 'ethers';

/** The proof is Base-only (the relay verifies at a Base block). */
export const EXTERNAL_PROOF_CAIP_CHAIN = 'eip155:8453';
export const EXTERNAL_PROOF_METHOD = 'personal_sign';
const STORAGE_PREFIX = 'provian-external-proof';

const PROJECT_ID = process.env.EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID || '';

export function isExternalWalletConnectConfigured(): boolean {
    return PROJECT_ID.length > 0;
}

/**
 * Wallet apps the human can open straight from the sheet. `connect(uri)` is the
 * app's WalletConnect deep link; `open` re-opens the app so the human sees the
 * signature request. Anything else: the generic `wc:` link, Copy, or the QR.
 */
export interface ExternalWalletApp {
    id: 'metamask' | 'coinbase' | 'rainbow' | 'trust';
    label: string;
    connect: (uri: string) => string;
    open: string;
}

export const EXTERNAL_WALLET_APPS: readonly ExternalWalletApp[] = [
    { id: 'metamask', label: 'MetaMask', connect: (u) => `metamask://wc?uri=${encodeURIComponent(u)}`, open: 'metamask://' },
    { id: 'coinbase', label: 'Coinbase Wallet', connect: (u) => `cbwallet://wc?uri=${encodeURIComponent(u)}`, open: 'cbwallet://' },
    { id: 'rainbow', label: 'Rainbow', connect: (u) => `rainbow://wc?uri=${encodeURIComponent(u)}`, open: 'rainbow://' },
    { id: 'trust', label: 'Trust Wallet', connect: (u) => `trust://wc?uri=${encodeURIComponent(u)}`, open: 'trust://' },
];

export interface ExternalWalletAccount {
    /** Lowercased EVM address. */
    address: string;
    /** CAIP-2 chain the wallet approved for this account (used to route the request). */
    chainId: string;
}

/**
 * The account the wallet exposed for the proof. Prefers an account on Base; a
 * wallet that exposes only other EVM chains still names the same EOA, and the
 * relay verifies the signature against Base state. Null when the session
 * carries no valid EVM account.
 */
export function accountFromSession(
    namespaces: SessionTypes.Namespaces | undefined,
): ExternalWalletAccount | null {
    const accounts = namespaces?.eip155?.accounts ?? [];
    const parsed = accounts
        .map((a) => a.split(':'))
        // The wallet (not a human typist) supplies the address, so compare case-insensitively.
        .filter((p) => p.length === 3 && p[0] === 'eip155' && ethers.isAddress(p[2].toLowerCase()));
    const onBase = parsed.find((p) => `${p[0]}:${p[1]}` === EXTERNAL_PROOF_CAIP_CHAIN);
    const pick = onBase ?? parsed[0];
    return pick ? { address: pick[2].toLowerCase(), chainId: `${pick[0]}:${pick[1]}` } : null;
}

/**
 * `personal_sign` params: the message as 0x-hex of its UTF-8 bytes (what
 * wallets decode and display as text) and the signer address. The signature is
 * EIP-191 over those exact bytes, which is what the relay recovers against.
 */
export function personalSignParams(message: string, address: string): [string, string] {
    return [ethers.hexlify(ethers.toUtf8Bytes(message)), address];
}

/** A wallet's returned signature must be 0x-hex (65 bytes for an EOA; longer for EIP-1271). */
export function isHexSignature(value: unknown): value is string {
    return typeof value === 'string' && /^0x[0-9a-fA-F]{130,}$/.test(value);
}

class ExternalWalletProofClient {
    private client: SignClient | null = null;
    private initializing: Promise<SignClient> | null = null;

    private async getClient(): Promise<SignClient> {
        if (this.client) return this.client;
        if (!PROJECT_ID) throw new Error('walletconnect_not_configured');
        if (!this.initializing) {
            this.initializing = SignClient.init({
                projectId: PROJECT_ID,
                customStoragePrefix: STORAGE_PREFIX,
                metadata: {
                    name: 'Provian',
                    description: translate('externalWalletProof.description', 'Link this wallet to your agent — sign one message, no transaction.'),
                    url: 'https://provian.ai',
                    icons: ['https://provian.ai/logos/provian-256.png'],
                },
            }).then((c) => {
                this.client = c;
                return c;
            }).catch((err: unknown) => {
                this.initializing = null;
                throw err;
            });
        }
        return this.initializing;
    }

    /**
     * Propose a session asking only for `personal_sign` on Base. Returns the
     * pairing URI (deep link / QR) and a promise that resolves once the wallet
     * approves.
     */
    async connect(): Promise<{ uri: string; approval: () => Promise<SessionTypes.Struct> }> {
        const client = await this.getClient();
        const { uri, approval } = await client.connect({
            optionalNamespaces: {
                eip155: {
                    methods: [EXTERNAL_PROOF_METHOD],
                    chains: [EXTERNAL_PROOF_CAIP_CHAIN],
                    events: ['accountsChanged', 'chainChanged'],
                },
            },
        });
        if (!uri) throw new Error('walletconnect_no_uri');
        return { uri, approval };
    }

    /** Ask the connected wallet to sign the exact proof message. */
    async requestPersonalSign(
        session: SessionTypes.Struct,
        account: ExternalWalletAccount,
        message: string,
    ): Promise<string> {
        const client = await this.getClient();
        const result: unknown = await client.request({
            topic: session.topic,
            chainId: account.chainId,
            request: { method: EXTERNAL_PROOF_METHOD, params: personalSignParams(message, account.address) },
        });
        if (!isHexSignature(result)) throw new Error('walletconnect_bad_signature');
        return result;
    }

    /** End the session once the proof is done (or abandoned). Best-effort. */
    async disconnect(session: SessionTypes.Struct | null): Promise<void> {
        if (!session || !this.client) return;
        try {
            await this.client.disconnect({
                topic: session.topic,
                reason: { code: 6000, message: 'Proof complete' },
            });
        } catch {
            // Already gone on the wallet side — nothing to clean up.
        }
    }
}

export const externalWalletProofClient = new ExternalWalletProofClient();
