import { guardedFetch as fetch, guardedFetcher } from './guarded-fetch';
/**
 * External-address proof-of-control (agent-side).
 *
 * An agent that ALREADY runs an external EVM wallet proves it controls that
 * address, after which the address's go-forward on-chain FINANCIAL activity on
 * Base (USDC receive / send / swap / x402 settlement) maps to PEs on the
 * standard record path. No new wallet, no custody move, no gas: the proof is a
 * single off-chain signature.
 *
 *   POST /v1/agent/external-address/challenge  { address }
 *   -> sign the returned message off-chain (EIP-191 EOA, or EIP-1271 for a
 *      contract wallet, in which case the caller supplies the signature)
 *   POST /v1/agent/external-address/verify     { address, challenge_id, signature }
 *
 * VERIFY *IS* THE LINK. One address -> one agent. Base-only. Both endpoints
 * take AGENT auth (`Bearer <api_key>:<api_secret>`); the relay takes the
 * agent_id from the authenticated wallet and never from the body, so an agent
 * can only ever bind an address to ITSELF.
 *
 * ── The one thing this module refuses to do ────────────────────────────────
 * It will not blind-sign relay-supplied text with the agent's external key.
 * `assertChallengeBindsToAddress` reconstructs the canonical six-line proof
 * message from the challenge's OWN returned fields and requires byte-equality,
 * with the `address:` line pinned to the address the caller asked for. A
 * challenge whose message is unparseable, mis-shaped, expired, or bound to a
 * different address is REFUSED before any signing happens — the failure mode is
 * refusal, never "sign it anyway". Anything unrecognized fails closed.
 *
 * Earning boundary (unchanged, restated because this is the module that opens
 * it): proving is attribution, not activity. The proof PE is record-only and
 * mints 0 PVT. Prior and same-head history never mints; it only sets a
 * read-only reputation tier. Go-forward on-chain work mints once on the
 * standard lane at its chain-witnessed value.
 */

import { ProvianError } from './errors';
import { signEip191Message } from './link-signing';
import { deriveAddressFromPrivateKey } from './wallet';

/** Proof is Base-only — mirrors PROOF_CHAIN / PROOF_CHAIN_ID on the relay. */
export const EXTERNAL_ADDRESS_PROOF_CHAIN = 'base' as const;
export const EXTERNAL_ADDRESS_PROOF_CHAIN_ID = 8453;

/** First line of the canonical proof message. Server-authoritative. */
const PROOF_MESSAGE_HEADER = 'Provian proof of control';

/** 10 minutes — mirrors EXTERNAL_PROOF_TTL_SECONDS on the relay. */
export const EXTERNAL_ADDRESS_PROOF_TTL_MS = 600_000;

const ADDRESS_LOWER = /^0x[0-9a-f]{40}$/;
const ADDRESS_ANY_CASE = /^0x[0-9a-fA-F]{40}$/;
const NONCE = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_SIGNATURE = /^0x[0-9a-fA-F]+$/;
const MAX_AGENT_ID_LENGTH = 200;

/**
 * Anything this module refuses. `code` is stable and machine-readable so a
 * caller can branch without string-matching a human message.
 */
export class ExternalAddressError extends ProvianError {
  constructor(message: string, code: string) {
    super(message, code);
    this.name = 'ExternalAddressError';
  }
}

/** Agent API credentials + relay endpoint. */
export interface ExternalAddressConfig {
  /** e.g. `https://api.provian.ai` */
  relayUrl: string;
  /** Agent API key (`pvn_live_*`). */
  apiKey: string;
  /** Agent API secret (`pvns_*`). */
  apiSecret: string;
  /** Optional fetch override so tests need not touch the global. */
  fetch?: typeof fetch;
}

/** The relay's one-time challenge. `message` is what gets signed, verbatim. */
export interface ExternalAddressChallenge {
  challenge_id: string;
  /** The exact plaintext to sign. Server-authoritative. */
  message: string;
  nonce: string;
  issued_at: number;
  expires_at: number;
  chain: string;
  chain_id: number;
}

/** A completed proof. Verify IS the link — there is no separate link step. */
export interface ExternalAddressProof {
  ok: true;
  proven_address: string;
  proven_at: number;
  proven_at_block: number;
  proof_method: string;
  already_proven?: boolean;
  upgraded_legacy?: boolean;
  pe_id?: string;
  pe_hash?: string;
  /** Read-only reputation tier from prior activity. NEVER mints PVT. */
  initial_reputation_tier?: number;
}

/** Fields decoded out of a challenge message that passed every binding check. */
export interface ProofMessageBinding {
  agent_id: string;
  address: string;
  nonce: string;
  issued_at: number;
  expires_at: number;
}

function authHeaders(config: ExternalAddressConfig): Record<string, string> {
  if (!config.apiKey || !config.apiSecret) {
    throw new ExternalAddressError(
      'Agent API key and secret are required (Bearer <api_key>:<api_secret>)',
      'EXTERNAL_ADDRESS_AUTH_MISSING',
    );
  }
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}:${config.apiSecret}`,
  };
}

function assertConfig(config: ExternalAddressConfig): void {
  if (!config || typeof config.relayUrl !== 'string' || config.relayUrl.length === 0) {
    throw new ExternalAddressError('relayUrl is required', 'EXTERNAL_ADDRESS_CONFIG_INVALID');
  }
}

function normalizeAddress(address: unknown): string {
  if (typeof address !== 'string' || !ADDRESS_ANY_CASE.test(address.trim())) {
    throw new ExternalAddressError(
      'address must be a 0x-prefixed 20-byte EVM address',
      'EXTERNAL_ADDRESS_INVALID',
    );
  }
  return address.trim().toLowerCase();
}

async function postJSON(
  config: ExternalAddressConfig,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  assertConfig(config);
  const fetchImpl = guardedFetcher(config.fetch);
  let response: Response;
  try {
    response = await fetchImpl(`${config.relayUrl}${path}`, {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new ExternalAddressError(
      `Network error calling ${path}: ${(err as Error).message}`,
      'EXTERNAL_ADDRESS_NETWORK_ERROR',
    );
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    payload = {};
  }

  if (!response.ok) {
    const reason = typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
    throw new ExternalAddressError(
      `${path} refused: ${reason}`,
      response.status === 401 || response.status === 403
        ? 'EXTERNAL_ADDRESS_AUTH_REJECTED'
        : 'EXTERNAL_ADDRESS_REFUSED',
    );
  }
  return payload;
}

/**
 * Rebuild the canonical proof message. Mirrors `buildProofMessage` on the
 * relay — field order is fixed so the stored message and the message the agent
 * signs are byte-identical.
 */
export function buildExternalProofMessage(input: ProofMessageBinding): string {
  return [
    PROOF_MESSAGE_HEADER,
    `agent: ${input.agent_id}`,
    `address: ${input.address}`,
    `nonce: ${input.nonce}`,
    `issued: ${new Date(input.issued_at).toISOString()}`,
    `expires: ${new Date(input.expires_at).toISOString()}`,
  ].join('\n');
}

/**
 * Refuse to sign anything that is not a well-formed challenge for the address
 * the caller asked about.
 *
 * Returns the decoded binding on success; THROWS on every other outcome. There
 * is deliberately no "probably fine" branch: an unrecognized shape is a refusal,
 * not a downgrade, because the thing on the other side of this check is the
 * agent's external signing key.
 *
 * @param challenge - the relay's response, as received
 * @param requestedAddress - the address the caller asked to prove
 * @param now - clock override for tests
 */
export function assertChallengeBindsToAddress(
  challenge: ExternalAddressChallenge,
  requestedAddress: string,
  now: number = Date.now(),
): ProofMessageBinding {
  const address = normalizeAddress(requestedAddress);

  if (!challenge || typeof challenge !== 'object') {
    throw new ExternalAddressError(
      'challenge response was not an object',
      'EXTERNAL_ADDRESS_CHALLENGE_UNTRUSTED',
    );
  }
  if (typeof challenge.challenge_id !== 'string' || !UUID.test(challenge.challenge_id)) {
    throw new ExternalAddressError(
      'challenge_id is not a UUID',
      'EXTERNAL_ADDRESS_CHALLENGE_UNTRUSTED',
    );
  }
  if (typeof challenge.nonce !== 'string' || !NONCE.test(challenge.nonce)) {
    throw new ExternalAddressError(
      'challenge nonce is not 128 bits of hex',
      'EXTERNAL_ADDRESS_CHALLENGE_UNTRUSTED',
    );
  }
  if (!Number.isSafeInteger(challenge.issued_at) || challenge.issued_at < 0
    || !Number.isSafeInteger(challenge.expires_at)) {
    throw new ExternalAddressError(
      'challenge timestamps are not safe integers',
      'EXTERNAL_ADDRESS_CHALLENGE_UNTRUSTED',
    );
  }
  if (challenge.expires_at - challenge.issued_at !== EXTERNAL_ADDRESS_PROOF_TTL_MS) {
    throw new ExternalAddressError(
      `challenge lifetime is not the protocol TTL (${EXTERNAL_ADDRESS_PROOF_TTL_MS}ms)`,
      'EXTERNAL_ADDRESS_CHALLENGE_UNTRUSTED',
    );
  }
  if (!Number.isSafeInteger(now) || now >= challenge.expires_at) {
    throw new ExternalAddressError(
      'challenge is already expired',
      'EXTERNAL_ADDRESS_CHALLENGE_EXPIRED',
    );
  }
  if (typeof challenge.message !== 'string') {
    throw new ExternalAddressError(
      'challenge message is missing',
      'EXTERNAL_ADDRESS_CHALLENGE_UNTRUSTED',
    );
  }

  const lines = challenge.message.split('\n');
  if (lines.length !== 6 || lines[0] !== PROOF_MESSAGE_HEADER || !lines[1].startsWith('agent: ')) {
    throw new ExternalAddressError(
      'challenge message is not the canonical Provian proof-of-control message',
      'EXTERNAL_ADDRESS_CHALLENGE_UNTRUSTED',
    );
  }
  const agentId = lines[1].slice('agent: '.length);
  if (agentId.length === 0 || agentId.length > MAX_AGENT_ID_LENGTH) {
    throw new ExternalAddressError(
      'challenge message carries no usable agent id',
      'EXTERNAL_ADDRESS_CHALLENGE_UNTRUSTED',
    );
  }

  const binding: ProofMessageBinding = {
    agent_id: agentId,
    address,
    nonce: challenge.nonce,
    issued_at: challenge.issued_at,
    expires_at: challenge.expires_at,
  };

  // The single equality that carries the whole check: every field the caller
  // supplied or the relay returned is re-derived here, so a message bound to a
  // DIFFERENT address (or a different nonce, or different timestamps) cannot
  // match. This is why the address line is never read out of the message.
  if (buildExternalProofMessage(binding) !== challenge.message) {
    throw new ExternalAddressError(
      'challenge message does not bind to the requested address',
      'EXTERNAL_ADDRESS_CHALLENGE_UNTRUSTED',
    );
  }
  return binding;
}

/**
 * Ask the relay for a one-time proof challenge for `address`.
 *
 * The returned challenge is NOT yet trusted — pass it through
 * `assertChallengeBindsToAddress` (or use `linkExternalAddress`, which does)
 * before signing it.
 */
export async function requestExternalAddressChallenge(
  config: ExternalAddressConfig,
  params: { address: string },
): Promise<ExternalAddressChallenge> {
  const address = normalizeAddress(params?.address);
  const payload = await postJSON(config, '/v1/agent/external-address/challenge', { address });
  return payload as unknown as ExternalAddressChallenge;
}

/**
 * Submit the signature. On success the address is BOUND to the authenticated
 * agent — verify IS the link; there is no separate link call.
 */
export async function verifyExternalAddress(
  config: ExternalAddressConfig,
  params: { address: string; challengeId: string; signature: string },
): Promise<ExternalAddressProof> {
  const address = normalizeAddress(params?.address);
  if (typeof params?.challengeId !== 'string' || !UUID.test(params.challengeId)) {
    throw new ExternalAddressError(
      'challengeId must be the challenge_id returned by /challenge',
      'EXTERNAL_ADDRESS_CHALLENGE_ID_INVALID',
    );
  }
  if (typeof params?.signature !== 'string' || !HEX_SIGNATURE.test(params.signature)) {
    throw new ExternalAddressError(
      'signature must be 0x-prefixed hex',
      'EXTERNAL_ADDRESS_SIGNATURE_INVALID',
    );
  }
  const payload = await postJSON(config, '/v1/agent/external-address/verify', {
    address,
    challenge_id: params.challengeId,
    signature: params.signature,
  });
  if (payload.ok !== true) {
    const reason = typeof payload.error === 'string' ? payload.error : 'unknown';
    throw new ExternalAddressError(
      `external-address proof refused: ${reason}`,
      'EXTERNAL_ADDRESS_PROOF_REFUSED',
    );
  }
  return payload as unknown as ExternalAddressProof;
}

/** How the caller produces the signature over the relay's challenge message. */
export type ExternalAddressSigner =
  /** EOA: the SDK signs EIP-191 locally with this secp256k1 key. */
  | { privateKey: string; sign?: never }
  /**
   * Contract wallet (EIP-1271) or an external signer/HSM: the caller returns a
   * 0x-hex signature over the exact message. The SDK never sees a key.
   */
  | { sign: (message: string) => string | Promise<string>; privateKey?: never };

export type LinkExternalAddressParams = { address: string; now?: number } & ExternalAddressSigner;

/**
 * Prove control of an external address end to end:
 * challenge -> bind-check -> sign off-chain -> verify (which IS the link).
 *
 * No gas, no transaction, no custody move. Base-only.
 *
 * @example EOA
 *   await linkExternalAddress(
 *     { relayUrl: 'https://api.provian.ai', apiKey, apiSecret },
 *     { address: '0xabc…', privateKey: process.env.EXTERNAL_KEY! },
 *   );
 *
 * @example contract wallet (EIP-1271) — the SDK never touches a key
 *   await linkExternalAddress(config, {
 *     address: '0xSafe…',
 *     sign: (message) => myOwnerSigner.signMessage(message),
 *   });
 */
export async function linkExternalAddress(
  config: ExternalAddressConfig,
  params: LinkExternalAddressParams,
): Promise<ExternalAddressProof> {
  const address = normalizeAddress(params?.address);
  const hasKey = typeof params?.privateKey === 'string';
  const hasSigner = typeof params?.sign === 'function';
  if (hasKey === hasSigner) {
    throw new ExternalAddressError(
      'pass exactly one of privateKey (EOA) or sign (contract wallet / external signer)',
      'EXTERNAL_ADDRESS_SIGNER_AMBIGUOUS',
    );
  }

  // Fail fast on the wrong key rather than burning a challenge and getting an
  // opaque signature rejection back from the relay. A contract wallet signs
  // with an OWNER key whose address is deliberately NOT the proven address, so
  // this check applies to the EOA path only.
  if (hasKey) {
    let derived: string;
    try {
      derived = deriveAddressFromPrivateKey(params.privateKey as string).toLowerCase();
    } catch (err) {
      throw new ExternalAddressError(
        `privateKey is not a usable secp256k1 key: ${(err as Error).message}`,
        'EXTERNAL_ADDRESS_KEY_INVALID',
      );
    }
    if (derived !== address) {
      throw new ExternalAddressError(
        'privateKey does not control the address being proven (use `sign` for EIP-1271 contract wallets)',
        'EXTERNAL_ADDRESS_KEY_MISMATCH',
      );
    }
  }

  const challenge = await requestExternalAddressChallenge(config, { address });
  assertChallengeBindsToAddress(challenge, address, params.now ?? Date.now());

  const signature = hasKey
    ? signEip191Message(params.privateKey as string, challenge.message)
    : await (params.sign as (message: string) => string | Promise<string>)(challenge.message);

  if (typeof signature !== 'string' || !HEX_SIGNATURE.test(signature)) {
    throw new ExternalAddressError(
      'signer returned a value that is not a 0x-prefixed hex signature',
      'EXTERNAL_ADDRESS_SIGNATURE_INVALID',
    );
  }

  return verifyExternalAddress(config, {
    address,
    challengeId: challenge.challenge_id,
    signature,
  });
}

/** Exported for tests and for callers that want the exact lowercase form. */
export function toProvenAddressForm(address: string): string {
  return normalizeAddress(address);
}

export { ADDRESS_LOWER as EXTERNAL_ADDRESS_LOWERCASE_PATTERN };
