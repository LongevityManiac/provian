/**
 * agentRekeyCrypto — the PURE crypto for the recovery re-key, split from
 * agentRekey.ts (which also touches React-Native-only storage + the relay client)
 * so this fund-bearing key material handling is unit-testable in isolation and
 * cross-checkable against the relay's `verifyEcdsaSha256`.
 *
 * Depends only on @noble + ethers — no RN, no storage, no network.
 */

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { ethers } from 'ethers';

export interface AgentKeyPair {
  /** 64-hex secp256k1 private key (no 0x prefix). */
  privateKeyHex: string;
  /** 128-hex uncompressed public key (X||Y, no 04 prefix) — the relay's expected shape. */
  publicKeyHex: string;
  /** Lowercase EVM address derived from the public key. */
  address: string;
}

/** Generate a fresh secp256k1 agent keypair on the phone. */
export async function generateAgentKeyPair(): Promise<AgentKeyPair> {
  const { secp256k1 } = await import('@noble/curves/secp256k1');
  const priv = secp256k1.utils.randomPrivateKey();
  const pubUncompressed = secp256k1.getPublicKey(priv, false); // 65 bytes: 0x04 || X || Y
  const pubHex = bytesToHex(pubUncompressed); // 130 hex, leading '04'
  const address = ethers.computeAddress(`0x${pubHex}`).toLowerCase();
  return { privateKeyHex: bytesToHex(priv), publicKeyHex: pubHex.slice(2), address };
}

/**
 * Sign the recovery-rekey message with the NEW key: ECDSA over SHA-256(message),
 * DER-encoded — the exact shape the relay's `verifyEcdsaSha256` accepts (Node
 * `crypto.createVerify('SHA256')`). low-S by @noble default; Node accepts DER.
 */
export async function signRecoveryRekeyPoP(privateKeyHex: string, message: string): Promise<string> {
  const { secp256k1 } = await import('@noble/curves/secp256k1');
  const msgHash = sha256(utf8ToBytes(message));
  const sig = secp256k1.sign(msgHash, hexToBytes(privateKeyHex.replace(/^0x/, '')));
  return sig.toDERHex();
}

/** The canonical recovery-rekey PoP message (must byte-match the relay's construction). */
export function recoveryRekeyMessage(walletId: string, newAddress: string, timestamp: number): string {
  return `recovery-rekey:${walletId}:${newAddress.toLowerCase()}:${timestamp}`;
}

export interface AgentRekeyInstructions {
  /** The command to run on the agent machine — carries NO key/credentials, safe to
   *  copy and safe in the shell history. */
  command: string;
  /** The JSON payload (new key + rotated credentials), shown SEPARATELY and masked;
   *  pasted into the command's hidden prompt, never riding the command itself. */
  payload: string;
}

/**
 * Build the restore instructions the human runs on the agent machine (
 * hardening). The command carries NO secret: it runs interactively and PROMPTS for
 * the payload with echo OFF. The rotated key + API credentials ride SEPARATELY as a
 * masked JSON payload the operator pastes into that hidden prompt — so they never
 * appear on screen (screenshottable), on the clipboard-as-command, or in the shell
 * history file (a heredoc pasted interactively IS written to history). The hosted
 * bundle's `restore-wallet` dispatch re-encrypts the key into the machine keystore
 * (under a fresh local at-rest secret) and writes the rotated creds so the daemon
 * can authenticate again.
 */
export function buildAgentRekeyCommand(params: {
  walletId: string;
  privateKeyHex: string;
  apiKey: string;
  apiSecret: string;
  relayUrl: string;
}): AgentRekeyInstructions {
  const relay = params.relayUrl.replace(/\/+$/, '');
  const payload = JSON.stringify({
    private_key: params.privateKeyHex.replace(/^0x/, ''),
    api_key: params.apiKey,
    api_secret: params.apiSecret,
  });
  const command = [
    '# Run on the agent machine. It will ask you to paste the recovery payload.',
    `curl -fsSL "${relay}/v1/bootstrap/agent.js" -o /tmp/provian-restore.js`,
    `PROVIAN_WALLET_ID=${params.walletId} node /tmp/provian-restore.js restore-wallet`,
  ].join('\n');
  return { command, payload };
}
