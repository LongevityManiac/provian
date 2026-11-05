/**
 * HUMAN WALLET REGISTRATION PROVES CONTROL OF THE ADDRESS.
 *
 * `POST /v1/wallet/human/register` used to bind whatever `address` the caller named: it
 * regex-checked the string and wrote the address index. Any account could therefore squat a
 * victim's address first, after which the real key holder's own registration answered
 * `409 human_wallet_address_in_use` forever and recovery handed them the squatter's account.
 *
 * A NEW registration (the creation branch — no per-user marker yet) now carries an EIP-712
 * signature by the address's own key over `RegisterHumanWallet { user_id, address, device_id,
 * timestamp }`. The relay reconstructs the message from its OWN context — the authenticated
 * user and device, the address in the body — so a proof is bound to one account, one device and
 * one address; the timestamp must sit within ±5 minutes; and the proof is single-use (a
 * Firestore `create` of the typed-data digest inside the registration transaction). The
 * idempotent replay of an existing registration stays proof-free, so every wallet registered
 * before keeps working unchanged.
 *
 * The domain name carries "Provian" on purpose: the app's WalletConnect path refuses to sign any
 * typed data whose domain names Provian, so no external dApp can obtain this signature.
 *
 * Pure (ethers only) — the route calls it, the transaction consumes its digest.
 */
import { ethers } from 'ethers';

export const HUMAN_WALLET_REGISTRATION_DOMAIN: ethers.TypedDataDomain = Object.freeze({
  name: 'Provian Human Wallet Registration',
  version: '1',
  chainId: 8453,
});

export const HUMAN_WALLET_REGISTRATION_PRIMARY_TYPE = 'RegisterHumanWallet';

export const HUMAN_WALLET_REGISTRATION_TYPES: Record<string, ethers.TypedDataField[]> = {
  RegisterHumanWallet: [
    { name: 'user_id', type: 'string' },
    { name: 'address', type: 'address' },
    { name: 'device_id', type: 'string' },
    { name: 'timestamp', type: 'uint256' },
  ],
};

/** Single-use ledger: one doc per consumed proof, id = the typed-data digest (hex, no 0x). */
export const HUMAN_WALLET_ADDRESS_PROOF_COLLECTION = 'human_wallet_address_proofs_v1';

/** ±5 minutes around the relay's clock. */
export const HUMAN_WALLET_ADDRESS_PROOF_WINDOW_MS = 5 * 60 * 1000;

export interface HumanWalletRegistrationMessage {
  readonly user_id: string;
  readonly address: string;
  readonly device_id: string;
  readonly timestamp: number;
}

/** A proof the relay has verified; the digest is what the transaction consumes. */
export interface VerifiedHumanWalletAddressProof {
  readonly digest: string;
  readonly signer: string;
  readonly user_id: string;
  readonly device_id: string;
  readonly signed_at_ms: number;
}

export type HumanWalletAddressProofVerdict =
  | { readonly ok: true; readonly proof: VerifiedHumanWalletAddressProof }
  | { readonly ok: false; readonly reason: string };

export function humanWalletRegistrationDigest(message: HumanWalletRegistrationMessage): string {
  return ethers.TypedDataEncoder
    .hash(HUMAN_WALLET_REGISTRATION_DOMAIN, HUMAN_WALLET_REGISTRATION_TYPES, message)
    .slice(2)
    .toLowerCase();
}

/**
 * Verify `address_proof = { signature, timestamp }` against the relay's own context.
 * Every field of the signed message except the timestamp is taken from `ctx`, never from the
 * body, so a proof made for another account, device or address cannot verify here.
 */
export function verifyHumanWalletAddressProof(
  raw: unknown,
  ctx: { readonly userId: string; readonly deviceId: string | null | undefined; readonly address: string; readonly nowMs: number },
): HumanWalletAddressProofVerdict {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, reason: 'address_proof_malformed' };
  const { signature, timestamp } = raw as { signature?: unknown; timestamp?: unknown };
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return { ok: false, reason: 'address_proof_signature_malformed' };
  if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp <= 0) return { ok: false, reason: 'address_proof_timestamp_malformed' };
  if (typeof ctx.deviceId !== 'string' || ctx.deviceId.length === 0) return { ok: false, reason: 'address_proof_device_unbound' };
  if (!/^0x[0-9a-fA-F]{40}$/.test(ctx.address)) return { ok: false, reason: 'address_proof_address_malformed' };
  const signedAtMs = timestamp * 1000;
  if (Math.abs(ctx.nowMs - signedAtMs) > HUMAN_WALLET_ADDRESS_PROOF_WINDOW_MS) return { ok: false, reason: 'address_proof_stale' };
  const message: HumanWalletRegistrationMessage = {
    user_id: ctx.userId,
    address: ctx.address.toLowerCase(),
    device_id: ctx.deviceId,
    timestamp,
  };
  let signer: string;
  try {
    signer = ethers.verifyTypedData(HUMAN_WALLET_REGISTRATION_DOMAIN, HUMAN_WALLET_REGISTRATION_TYPES, message, signature).toLowerCase();
  } catch {
    return { ok: false, reason: 'address_proof_signature_invalid' };
  }
  if (signer !== ctx.address.toLowerCase()) return { ok: false, reason: 'address_proof_signer_mismatch' };
  return {
    ok: true,
    proof: {
      digest: humanWalletRegistrationDigest(message),
      signer,
      user_id: ctx.userId,
      device_id: ctx.deviceId,
      signed_at_ms: signedAtMs,
    },
  };
}
