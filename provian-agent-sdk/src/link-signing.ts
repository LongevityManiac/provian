/**
 * Human-side link consent signing.
 *
 * Used by callers that hold a human's BIP-39-derived secp256k1 private key
 * (e.g. an agent operator running this SDK on a machine where the human has
 * pasted in their wallet key) and need to produce an EIP-191 `personal_sign`
 * signature over the canonical payload that the relay's
 * `POST /v1/agent/wallet/:wallet_id/link-human`, `POST /unlink-human` and
 * `PUT /link-human` (share change) endpoints verify.
 *
 * The relay reconstructs the canonical JSON, applies the EIP-191 prefix,
 * recovers the signer's EVM address from the signature, and compares it to
 * the address on the human's `wallets/` document. There is no separate
 * "link key" - the wallet's existing EVM key authorizes the link directly.
 *
 * SINGLE-USE : every payload names `link_epoch` the agent's
 * beneficiary-relationship epoch, read from
 * `GET /v1/agent/wallet/:wallet_id/link-epoch` (`CommonsInstitutions.readLinkEpoch()`).
 * Every link, unlink and share change advances it, and the relay consumes
 * each signed payload, so a signature applies at most once and never after a
 * later state change. A payload without `link_epoch` is refused (400).
 *
 * The mobile app does NOT sign these payloads: a person links an agent in the
 * app by accepting its invite / link request under wallet auth, and ends a link
 * alone through `POST /:wallet_id/human-unlink` (wallet auth). This helper is
 * only for a human key held outside the app. The app's WalletConnect guard
 * refuses any dApp `personal_sign` that parses as one of these payloads.
 */

import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak256 } from './keccak256';

/** Canonical payload signed by the human to authorize a link. */
export interface LinkPayload {
  action: 'link_agent';
  agent_wallet_id: string;
  human_wallet_id: string;
  /** the relationship epoch from `GET /v1/agent/wallet/:wallet_id/link-epoch`. */
  link_epoch: number;
  timestamp: number;
}

/** Canonical payload signed by the human to authorize an unlink. */
export interface UnlinkPayload {
  action: 'unlink_agent';
  agent_wallet_id: string;
  human_wallet_id: string;
  /** the relationship epoch from `GET /v1/agent/wallet/:wallet_id/link-epoch`. */
  link_epoch: number;
  timestamp: number;
}

/** Canonical payload signed by the linked human to authorize a beneficiary-share change (`PUT /link-human`). */
export interface ShareChangePayload {
  action: 'update_beneficiary_share';
  agent_wallet_id: string;
  human_wallet_id: string;
  /** the relationship epoch from `GET /v1/agent/wallet/:wallet_id/link-epoch`. */
  link_epoch: number;
  /** The exact agent share (integer bps, 500–5000) the human consents to. */
  operational_reserve_bps: number;
  timestamp: number;
}

export type LinkConsentPayload = LinkPayload | UnlinkPayload | ShareChangePayload;

/**
 * Stable-stringify a canonical payload - keys sorted alphabetically,
 * separators consistent with `json-stable-stringify` defaults so the
 * relay reconstructs the byte-identical string.
 */
function canonicalize(payload: LinkConsentPayload): string {
  const keys = Object.keys(payload).sort() as Array<keyof typeof payload>;
  const parts: string[] = [];
  for (const k of keys) {
    parts.push(`${JSON.stringify(k)}:${JSON.stringify(payload[k])}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * Compute the EIP-191 `personal_sign` digest for an arbitrary UTF-8 message.
 * Equivalent to `ethers.hashMessage(message)`.
 */
function eip191Digest(message: string): Uint8Array {
  const bodyBytes = Buffer.from(message, 'utf-8');
  const prefix = `\x19Ethereum Signed Message:\n${bodyBytes.length}`;
  const prefixed = Buffer.concat([Buffer.from(prefix, 'utf-8'), bodyBytes]);
  return keccak256(prefixed);
}

/**
 * Produce a 0x-prefixed 65-byte hex EIP-191 (`personal_sign`) signature of
 * the canonical link, unlink or share-change payload.
 *
 * @param privateKeyHex - 32-byte secp256k1 private key as hex (with or without 0x)
 * @param payload       - LinkPayload, UnlinkPayload or ShareChangePayload to sign
 * @returns 0x-prefixed 132-char hex signature (r || s || v)
 *
 * @example
 *   const { link_epoch } = await institutions.readLinkEpoch();
 *   const timestamp = Date.now();
 *   const signature = signLinkPayload(humanPrivKey, {
 *     action: 'link_agent',
 *     agent_wallet_id: 'wallet_atlas',
 *     human_wallet_id: 'wallet_frank',
 *     link_epoch,
 *     timestamp,
 *   });
 *   // POST { human_wallet_id, signature, timestamp, link_epoch } to /link-human
 */
export function signLinkPayload(
  privateKeyHex: string,
  payload: LinkConsentPayload,
): string {
  return signEip191Message(privateKeyHex, canonicalize(payload));
}

/**
 * Produce a 0x-prefixed 65-byte hex EIP-191 (`personal_sign`) signature over an
 * arbitrary UTF-8 message with a secp256k1 key. The relay recovers the signer's
 * EVM address with `ethers.verifyMessage(message, signature)` — byte-identical
 * to what this produces. Shared by `signLinkPayload` and the sovereign x402 PE
 * submission (the agent signs its OWN reputation PE with its OWN EOA — no relay
 * session needed; x402 is governance-free).
 *
 * @param privateKeyHex - 32-byte secp256k1 private key as hex (with or without 0x)
 * @param message       - the exact UTF-8 message string to sign
 * @returns 0x-prefixed 132-char hex signature (r || s || v, v = 27/28)
 */
export function signEip191Message(privateKeyHex: string, message: string): string {
  const cleanKey = privateKeyHex.startsWith('0x') ? privateKeyHex.slice(2) : privateKeyHex;
  if (cleanKey.length !== 64) {
    throw new Error('signEip191Message: privateKeyHex must be 32 bytes (64 hex chars)');
  }

  const digest = eip191Digest(message);
  const sig = secp256k1.sign(digest, cleanKey);
  const r = sig.r.toString(16).padStart(64, '0');
  const s = sig.s.toString(16).padStart(64, '0');
  const v = (27 + (sig.recovery ?? 0)).toString(16).padStart(2, '0');
  return `0x${r}${s}${v}`;
}
