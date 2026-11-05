import { guardedFetch as fetch, guardedFetcher } from './guarded-fetch';
/**
 * Parent-authorization proof-of-possession (HIGH-2, Wave 4).
 *
 * When an agent wallet is created with `parent_wallet_id` set, the relay
 * requires the PARENT to prove it authorized the creation — otherwise anyone
 * could attach themselves as a child of a victim wallet and inherit its
 * `linked_human_*` beneficiary snapshot (the audit reproducer). The relay
 * returns `401 PARENT_POP_REQUIRED` on `POST /v1/agent/wallet/create` when
 * `parent_wallet_id` is present but `parent_proof_of_authorization` is not.
 *
 * The flow mirrors the connect PoP (see connect-pop.ts):
 *   GET /v1/agent/wallet/parent-challenge?parent_wallet_id&child_address
 *       -> { challenge_id, challenge, expires_at }
 *   sign canonicalParentAuthorizationMessage(challenge, {parent_wallet_id, child_address})
 *       with the PARENT's registered secp256k1 key
 *   attach { challenge_id, signature } as parent_proof_of_authorization on create.
 *
 * The relay binds the challenge to {parent_wallet_id, child_address} under the
 * parent's registered public key and verifies with
 * `crypto.createVerify('SHA256').update(message).verify(spki, derSig)` — exactly
 * the signature `wallet.ts` `signMessage` produces. The `child_address` claim is
 * LOWERCASED to byte-match what the relay stores and expects
 * (agent-wallet.ts: `child_address: childAddress.toLowerCase()`).
 */
import { signMessage } from './wallet';

/**
 * The `parent_proof_of_authorization` object attached to a child create request.
 * Shape mirrors the relay's contract exactly (agent-wallet.ts): a `challenge_id`
 * from `/parent-challenge` plus a hex `signature` over the canonical message.
 */
export interface ParentProofOfAuthorization {
  challenge_id: string;
  signature: string;
}

/**
 * Canonical parent-authorization message — byte-identical to the backend's
 * `canonicalPopMessage` (core/agent-wallet/proof-of-possession.ts):
 *   `${purpose}\n${challenge}\n${k1=v1|k2=v2|...}` with claim keys SORTED.
 * MUST match the backend or the signature verifies against the wrong bytes.
 * The purpose is `parent_authorization` (the relay's `PopPurpose`).
 */
export function canonicalParentAuthorizationMessage(
  challenge: string,
  claims: { parent_wallet_id: string; child_address: string },
): string {
  const purpose = 'parent_authorization';
  const sortedKeys = Object.keys(claims).sort() as Array<keyof typeof claims>;
  const claimsBlob = sortedKeys.map((k) => `${k}=${claims[k]}`).join('|');
  return `${purpose}\n${challenge}\n${claimsBlob}`;
}

/**
 * Sign the parent-authorization PoP with the parent's private key. Returns a hex
 * DER ECDSA signature the relay's `createVerify('SHA256')` accepts. The
 * `childAddress` claim is lowercased to byte-match the relay's stored claim.
 */
export function signParentAuthorization(
  parentPrivateKeyHex: string,
  challenge: string,
  parentWalletId: string,
  childAddress: string,
): string {
  const message = canonicalParentAuthorizationMessage(challenge, {
    parent_wallet_id: parentWalletId,
    child_address: childAddress.toLowerCase(),
  });
  return signMessage(parentPrivateKeyHex, message);
}

interface MinimalResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
type FetchLike = (url: string, init?: { method?: string }) => Promise<MinimalResponse>;

/**
 * Fetch the parent-challenge and sign it, producing the
 * `parent_proof_of_authorization` for a child create request.
 *
 *   GET /v1/agent/wallet/parent-challenge?parent_wallet_id&child_address
 *       -> { challenge_id, challenge }
 *   sign canonicalParentAuthorizationMessage(challenge, {parent_wallet_id, child_address})
 *       with the parent's secp256k1 key
 *
 * The parent's private key is only read to sign in-process; it is never logged,
 * returned, or retained here. `fetchImpl` is injectable so the exact HTTP shape
 * + signing can be tested against the backend's verifier without a live relay.
 */
export async function fetchParentAuthorization(params: {
  relayUrl: string;
  parentWalletId: string;
  childAddress: string;
  parentPrivateKey: string;
  fetchImpl?: FetchLike;
}): Promise<ParentProofOfAuthorization> {
  // Native overrides still use the same socket guard; this caller consumes only MinimalResponse.
  const doFetch = guardedFetcher(params.fetchImpl as unknown as typeof fetch | undefined) as unknown as FetchLike;
  const base = params.relayUrl.replace(/\/+$/, '');
  // The relay lowercases child_address when storing the claim; send it
  // lowercased too so the query, the stored claim, and the signed message all
  // agree byte-for-byte.
  const childAddress = params.childAddress.toLowerCase();
  const url =
    `${base}/v1/agent/wallet/parent-challenge` +
    `?parent_wallet_id=${encodeURIComponent(params.parentWalletId)}` +
    `&child_address=${encodeURIComponent(childAddress)}`;

  const res = await doFetch(url, { method: 'GET' });
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string })?.error ?? '';
    } catch {
      /* non-JSON error body */
    }
    throw new Error(
      `parent challenge failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`,
    );
  }
  const body = (await res.json()) as { challenge_id?: string; challenge?: string };
  if (!body.challenge_id || !body.challenge) {
    throw new Error('parent challenge response missing challenge_id/challenge');
  }
  const signature = signParentAuthorization(
    params.parentPrivateKey,
    body.challenge,
    params.parentWalletId,
    childAddress,
  );
  return { challenge_id: body.challenge_id, signature };
}
