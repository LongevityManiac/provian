import { type BiometricAction } from '../security/biometricAction';
/**
 * agentRecovery — orchestration for the phone side of non-custodial agent-key
 * recovery (the two-touch onboarding). Pure-ish glue over the crypto core
 * (agentKeyRecovery.ts) and the cloud-backed custody store (agentAnchorStore.ts),
 * kept out of the screen so the fund-safety-critical logic is unit-testable.
 *
 * Touch 1 (Invite): mintAndPersistRecoveryAnchor() mints an x25519 anchor,
 * durably stores the SECRET half in cloud-backed storage, and returns the PUBLIC
 * half to ride the one copied command.
 *
 * Touch 2 (Recover): recoverAgentKeyHex() takes the ciphertext the relay escrowed
 * plus the anchor pubkey the relay echoes back, finds the matching anchor secret
 * on this phone / in cloud backup, opens the sealed box, and returns the agent's
 * secp256k1 private key hex to be handed to a fresh install via a restore command.
 */

import * as Crypto from 'expo-crypto';
import { bytesToHex } from '@noble/hashes/utils';
import {
    generateAnchorKeyPair,
    openWithAnchor,
    fromB64u,
} from '../security/agentKeyRecovery';
import {
    persistRecoveryAnchor,
    loadRecoveryAnchorSecret,
    isRecoveryAnchorStorageAvailable,
    linkAnchorToWallet,
} from '../security/agentAnchorStore';
import { derivedAnchorSecretFor } from './humanRecoveryAnchor';

/** Structured, code-carrying error so the onboarding error mapper can humanise it. */
export class AgentRecoveryError extends Error {
    readonly code: string;
    constructor(code: string, message?: string) {
        super(message ?? code);
        this.name = 'AgentRecoveryError';
        this.code = code;
    }
}

export type MintAnchorResult =
    | { recoveryEnabled: true; recoveryAnchorPubkeyB64u: string }
    | { recoveryEnabled: false; reason: 'cloud_backup_unavailable' | 'anchor_persist_failed' };

/**
 * Touch 1. Mint the recovery anchor and durably persist the secret half.
 *
 * The returned pubkey is what the caller sends as `recovery_anchor_pubkey` in the
 * connection-token request. If durable (cloud-backed) storage is unavailable we
 * DO NOT fall back to device-only storage — recovery is reported disabled so the
 * UI can say so honestly, and the connection token is still issued without an
 * anchor (the agent connects and works; it just has no escrow yet).
 *
 * @param opts.randomBytes injectable CSPRNG (tests pass a deterministic one).
 *        In production the screen passes expo-crypto's getRandomBytes; when
 *        omitted the crypto core's @noble default (crypto.getRandomValues,
 *        polyfilled by react-native-get-random-values in App.tsx) is used.
 */
export async function mintAndPersistRecoveryAnchor(opts?: {
    randomBytes?: (n: number) => Uint8Array;
}, biometricAction?: BiometricAction): Promise<MintAnchorResult> {
    if (!isRecoveryAnchorStorageAvailable()) {
        return { recoveryEnabled: false, reason: 'cloud_backup_unavailable' };
    }
    const rng = opts?.randomBytes ?? Crypto.getRandomBytes;
    const { secretKey, publicKey } = generateAnchorKeyPair(rng);
    try {
        const { pubkeyB64u } = await persistRecoveryAnchor({ publicKey, secretKey }, biometricAction);
        return { recoveryEnabled: true, recoveryAnchorPubkeyB64u: pubkeyB64u };
    } catch {
        // persistRecoveryAnchor throws on cloud-unavailable / not-synced. Never
        // store device-only; report disabled and let the invite proceed.
        return { recoveryEnabled: false, reason: 'anchor_persist_failed' };
    }
}

/**
 * Touch 2. Recover the agent's secp256k1 private key from the escrowed ciphertext.
 *
 * @param params.sealedKeyBlobB64u        base64url ciphertext from the relay escrow.
 * @param params.recoveryAnchorPubkeyB64u anchor pubkey the relay echoes back — the
 *                                        durable join key to find the anchor secret.
 * @param params.walletId                 optional; recorded in the device-local index.
 * @returns lowercase hex of the recovered private key (no 0x prefix).
 * @throws AgentRecoveryError('anchor_secret_not_found') when this phone/account
 *         holds no matching anchor; rethrows openWithAnchor's fail-closed error
 *         (tamper / wrong key / malformed blob) unchanged for the mapper.
 */
export async function recoverAgentKeyHex(params: {
    sealedKeyBlobB64u: string;
    recoveryAnchorPubkeyB64u: string;
    walletId?: string;
}, biometricAction?: BiometricAction): Promise<string> {
    // A per-invite anchor lives in the cloud-backed store; the human's ONE recovery anchor
    // (item 11 — fleet agents and self-escrowed agents seal to it) is re-derived from the seed.
    const secret = await loadRecoveryAnchorSecret(params.recoveryAnchorPubkeyB64u, biometricAction)
        ?? await derivedAnchorSecretFor(params.recoveryAnchorPubkeyB64u, undefined, biometricAction);
    if (!secret) {
        throw new AgentRecoveryError('anchor_secret_not_found');
    }
    // openWithAnchor is fail-closed: it throws on a wrong key, a tampered blob,
    // or a malformed/too-short/unknown-version blob. We let it propagate so the
    // caller surfaces one plain sentence via mapAgentOnboardingError.
    const keyBytes = openWithAnchor(secret, fromB64u(params.sealedKeyBlobB64u));

    if (params.walletId) {
        // Best-effort: remember which wallet this anchor served (convenience only).
        await linkAnchorToWallet(params.recoveryAnchorPubkeyB64u, params.walletId).catch(() => {});
    }
    return bytesToHex(keyBytes);
}

/**
 * Build the ONE restore command the human copies to the new agent machine.
 *
 * DESIGN / CONTRACT NOTE (see the run report): a canonical
 * "restore-from-recovered-key" SDK subcommand is not yet published pre-flip, so
 * this is a clearly-labelled command SHAPE. The recovered key is fund-bearing
 * and must NEVER reach Provian's servers, so it travels ONLY inside this locally
 * pasted command and is fed over STDIN (a heredoc) rather than as an argv/env
 * value, keeping it out of shell history and the process table. Re-provision,
 * not raw-key display: the human copies a runnable command, not a naked key.
 */
export interface AgentRestoreInstructions {
    /** The command to run on the agent machine — carries NO key, safe to copy and
     *  safe in the shell history. */
    command: string;
    /** The recovered key, shown SEPARATELY and masked. The operator pastes it into
     *  the command's hidden prompt; it never rides the command itself. */
    key: string;
}

export function buildAgentRestoreCommand(params: {
    walletId: string;
    recoveredKeyHex: string;
    relayUrl: string;
}): AgentRestoreInstructions {
    const relay = params.relayUrl.replace(/\/+$/, '');
    // hardening: the key is NO LONGER embedded in the command. The old form
    // pasted the key inside a `<<'PROVIAN_RESTORE'` heredoc, which — pasted into an
    // interactive shell — is written verbatim to the shell history file, and the
    // whole thing was rendered on screen (screenshottable) and copied to the
    // clipboard. Now the command runs interactively and PROMPTS for the key with
    // echo off; the phone shows the key separately (masked), for the operator to
    // paste into that hidden prompt. The command downloads the HOSTED bundle (the
    // same artifact the one-command bootstrap runs); its restore-wallet dispatch
    // re-encrypts the pasted key into the machine-local keystore.
    const command = [
        `# Run on the NEW agent machine. It will ask you to paste the recovery key.`,
        `curl -fsSL "${relay}/v1/bootstrap/agent.js" -o /tmp/provian-restore.js`,
        `PROVIAN_WALLET_ID=${params.walletId} node /tmp/provian-restore.js restore-wallet`,
    ].join('\n');
    return { command, key: params.recoveredKeyHex.replace(/^0x/, '') };
}
