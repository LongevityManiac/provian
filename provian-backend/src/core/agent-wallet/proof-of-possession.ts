/**
 * Proof-of-Possession (PoP) for Agent Wallet Creation
 *
 * Replaces the previous flow where the relay generated the agent's
 * private key. The new flow:
 *
 *   1. Agent SDK generates a secp256k1 keypair locally.
 *   2. SDK calls GET /v1/agent/wallet/challenge?public_key=... to get a
 *      random nonce + expiry. The challenge is bound to the public key.
 *   3. SDK signs the challenge bytes with its private key (SHA-256 over
 *      the message, then secp256k1 ECDSA via Node crypto.createSign).
 *   4. SDK posts {public_key, agent_id, ..., challenge_id, signature}
 *      to POST /v1/agent/wallet/create.
 *   5. Relay verifies:
 *        - The challenge_id is recent and was issued for this public_key
 *        - The signature verifies under the public_key
 *        - The challenge has not been redeemed (single-use)
 *      If everything checks out, the wallet is created and the
 *      challenge is marked redeemed.
 *
 * The relay never sees the private key. The PE chain is anchored to the
 * public key and address the agent already controls.
 *
 * Security properties:
 *   - The challenge is HMAC-bound to the public key the agent claims to
 *     own, so an attacker cannot reuse a challenge to register a
 *     different key.
 *   - 5-minute expiry limits replay window.
 *   - Single-use redemption (challenge_id removed from cache on use)
 *     prevents the same proof from being submitted twice.
 *   - Cache is fail-closed: if Redis is unavailable, challenge issuance
 *     and verification both fail.
 */

import crypto from 'crypto';

/**
 * Structural interface for the cache methods PoP needs. Accepting a
 * structural type (instead of the concrete RedisCache class) lets
 * provisional.ts and other routes that wrap the cache in stripped-down
 * dependency interfaces still call this helper without casting.
 */
export interface PopCacheDeps {
  isEnabled?: () => boolean;
  set: (key: string, value: unknown, ttlSeconds: number) => Promise<void>;
  /** Atomic single-use redemption claim. Security-critical callers fail closed
   * when this capability is absent or Redis cannot establish ownership. */
  setNx?: (key: string, value: unknown, ttlSeconds: number) => Promise<boolean>;
  get: <T>(key: string) => Promise<T | null>;
  del: (key: string) => Promise<void>;
}

const CHALLENGE_TTL_SECONDS = 300; // 5 minutes
const CHALLENGE_PREFIX = 'agent_wallet_pop:';
const CHALLENGE_REDEMPTION_PREFIX = 'agent_wallet_pop_redeemed:';

export interface PopChallenge {
  challenge_id: string;
  challenge: string;          // hex-encoded random bytes (32 bytes)
  expires_at: number;         // unix ms
}

export interface AgentRegistrationPopContext {
  registration_id: string;
  agent_id: string;
  /** Null means the registration did not exist when the challenge was issued. */
  credential_recovery_generation: number | null;
}

/**
 * Issue a new PoP challenge bound to the supplied public key.
 *
 * The cache key is `agent_wallet_pop:{challenge_id}` and the value is
 * the public_key the challenge is locked to.
 */
export async function issuePopChallenge(
  cache: PopCacheDeps,
  publicKeyHex: string,
  registrationContext: AgentRegistrationPopContext,
): Promise<PopChallenge> {
  if (cache.isEnabled && !cache.isEnabled()) {
    throw new Error('CACHE_UNAVAILABLE');
  }

  const challenge = crypto.randomBytes(32).toString('hex');
  const challengeId = crypto.randomUUID();
  const expiresAt = Date.now() + CHALLENGE_TTL_SECONDS * 1000;

  // Store: cache_key -> { public_key, challenge }
  // Upstash auto-serialises objects; expiry handled by Redis TTL.
  await cache.set(
    CHALLENGE_PREFIX + challengeId,
    {
      public_key: publicKeyHex.toLowerCase(),
      challenge,
      registration_context: registrationContext,
    },
    CHALLENGE_TTL_SECONDS,
  );

  return { challenge_id: challengeId, challenge, expires_at: expiresAt };
}

/**
 * Verify a signed challenge and consume it (single-use).
 *
 * Returns true if the challenge exists, was issued for the given public
 * key, and the signature verifies. Returns false otherwise. On any
 * success path the challenge is deleted from the cache before returning,
 * so a second call with the same challenge_id will fail even if it
 * arrives concurrently.
 */
export async function verifyAndConsumePopChallenge(
  cache: PopCacheDeps,
  challengeId: string,
  publicKeyHex: string,
  signatureHex: string,
  expectedRegistration: Pick<AgentRegistrationPopContext, 'registration_id' | 'agent_id'>,
): Promise<
  | { ok: true; registration_context: AgentRegistrationPopContext }
  | { ok: false; reason: string }
> {
  if (cache.isEnabled && !cache.isEnabled()) {
    return { ok: false, reason: 'cache_unavailable' };
  }

  const cacheKey = CHALLENGE_PREFIX + challengeId;
  const parsed = await cache.get<{
    public_key: string;
    challenge: string;
    registration_context: AgentRegistrationPopContext;
  }>(cacheKey);
  if (!parsed
    || typeof parsed.public_key !== 'string'
    || typeof parsed.challenge !== 'string'
    || typeof parsed.registration_context !== 'object'
    || parsed.registration_context === null
    || parsed.registration_context.registration_id !== expectedRegistration.registration_id
    || parsed.registration_context.agent_id !== expectedRegistration.agent_id
    || (parsed.registration_context.credential_recovery_generation !== null
      && (!Number.isSafeInteger(parsed.registration_context.credential_recovery_generation)
        || parsed.registration_context.credential_recovery_generation < 0))) {
    return { ok: false, reason: 'challenge_not_found' };
  }

  // Bind to the original public key - submitting a challenge with a
  // different key MUST fail.
  if (parsed.public_key !== publicKeyHex.toLowerCase()) {
    return { ok: false, reason: 'public_key_mismatch' };
  }

  // Verify ECDSA signature over the challenge bytes using the public key.
  // Construct an SPKI DER for the secp256k1 public key.
  let spkiPem: string;
  try {
    spkiPem = uncompressedHexToSpkiPem(publicKeyHex);
  } catch {
    return { ok: false, reason: 'public_key_invalid' };
  }

  let valid: boolean;
  try {
    const verifier = crypto.createVerify('SHA256');
    verifier.update(parsed.challenge);
    valid = verifier.verify(spkiPem, Buffer.from(signatureHex, 'hex'));
  } catch {
    return { ok: false, reason: 'signature_verify_error' };
  }

  if (!valid) {
    return { ok: false, reason: 'signature_invalid' };
  }

  // Single-use is an atomic ownership claim, not a read-then-delete race.
  // The redemption marker outlives the original key's remaining TTL, so a
  // best-effort deletion failure cannot reopen the challenge.
  if (!cache.setNx || !await cache.setNx(
    CHALLENGE_REDEMPTION_PREFIX + challengeId,
    true,
    CHALLENGE_TTL_SECONDS,
  )) {
    return { ok: false, reason: 'challenge_consume_failed' };
  }
  await cache.del(cacheKey).catch(() => undefined);

  return { ok: true, registration_context: parsed.registration_context };
}

// ---------------------------------------------------------------------------
// Claims-bound PoP (Wave 4: HIGH-1 connect, HIGH-2 parent authorization)
// ---------------------------------------------------------------------------
//
// The pubkey-only flow above is fine when the challenge is locked to a key
// the caller is producing (wallet creation). For agent connect and parent
// authorization, the challenge needs to bind to additional claims the SDK
// presents in the protected request: connection_token + agent_wallet_id, or
// parent_wallet_id + child_address. The signed message commits to those
// claims so the server-side check is "you proved possession AND you knew
// the exact context the challenge was issued for."

export type PopPurpose = 'agent_connect' | 'parent_authorization' | 'agent_author_mapping';

const CLAIMS_CHALLENGE_PREFIX = 'agent_wallet_pop_claims:';
const CLAIMS_CHALLENGE_REDEMPTION_PREFIX = 'agent_wallet_pop_claims_redeemed:';

export interface ClaimsPopChallenge {
  challenge_id: string;
  challenge: string;
  expires_at: number;
}

interface StoredClaimsChallenge {
  purpose: PopPurpose;
  challenge: string;
  public_key: string; // canonical lowercase, no 0x / 04 prefix (64 hex / 128 chars)
  claims: Record<string, string>;
}

/** Canonical preimage the SDK signs and the relay verifies. Sorts keys so
 *  ordering drift can't break verification. */
export function canonicalPopMessage(input: {
  purpose: PopPurpose;
  challenge: string;
  claims: Record<string, string>;
}): string {
  const sortedKeys = Object.keys(input.claims).sort();
  const claimsBlob = sortedKeys
    .map((k) => `${k}=${input.claims[k]}`)
    .join('|');
  return `${input.purpose}\n${input.challenge}\n${claimsBlob}`;
}

function normalisePublicKeyHex(publicKeyHex: string): string {
  let cleaned = publicKeyHex.toLowerCase().replace(/^0x/, '');
  if (cleaned.length === 130 && cleaned.startsWith('04')) cleaned = cleaned.slice(2);
  return cleaned;
}

export async function issueClaimsPopChallenge(
  cache: PopCacheDeps,
  params: {
    purpose: PopPurpose;
    public_key_hex: string;
    claims: Record<string, string>;
  },
): Promise<ClaimsPopChallenge> {
  if (cache.isEnabled && !cache.isEnabled()) {
    throw new Error('CACHE_UNAVAILABLE');
  }
  const normalisedKey = normalisePublicKeyHex(params.public_key_hex);
  if (normalisedKey.length !== 128) {
    throw new Error('public_key_hex must be 64 bytes uncompressed secp256k1');
  }
  const challenge = crypto.randomBytes(32).toString('hex');
  const challengeId = crypto.randomUUID();
  const expiresAt = Date.now() + CHALLENGE_TTL_SECONDS * 1000;
  const stored: StoredClaimsChallenge = {
    purpose: params.purpose,
    challenge,
    public_key: normalisedKey,
    claims: { ...params.claims },
  };
  await cache.set(
    CLAIMS_CHALLENGE_PREFIX + challengeId,
    stored,
    CHALLENGE_TTL_SECONDS,
  );
  return { challenge_id: challengeId, challenge, expires_at: expiresAt };
}

export type ClaimsPopVerifyResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Read-only view of a stored claims challenge (no consumption, no signature
 * check). Used by the two-party author-mapping handoff: the repo OWNER issues
 * a challenge bound to the target agent's key; the AGENT later fetches the
 * challenge + claims by id to sign them. Returns null when the challenge does
 * not exist, has expired out of the cache, or was issued for another purpose —
 * the caller treats every null identically (Unknown = Block, no oracle).
 */
export async function peekClaimsPopChallenge(
  cache: PopCacheDeps,
  params: { challenge_id: string; purpose: PopPurpose },
): Promise<{ challenge: string; public_key: string; claims: Record<string, string> } | null> {
  if (cache.isEnabled && !cache.isEnabled()) return null;
  const stored = await cache.get<StoredClaimsChallenge>(CLAIMS_CHALLENGE_PREFIX + params.challenge_id);
  if (
    !stored
    || typeof stored.challenge !== 'string'
    || typeof stored.public_key !== 'string'
    || stored.purpose !== params.purpose
    || stored.claims === null
    || typeof stored.claims !== 'object'
  ) {
    return null;
  }
  return { challenge: stored.challenge, public_key: stored.public_key, claims: { ...stored.claims } };
}

/**
 * Verify and consume a claims-bound challenge. The verifier:
 *   1. Loads the stored {purpose, public_key, challenge, claims}.
 *   2. Confirms the caller's purpose, public_key, and supplied claims
 *      EXACTLY match the stored values.
 *   3. Verifies the signature over canonicalPopMessage(...) under the
 *      stored public_key.
 *   4. Deletes the cache entry (single-use).
 *
 * Any structural or claim-equality mismatch fails before the crypto check
 * so the verifier can't be coaxed into accepting a different request.
 */
export async function verifyAndConsumeClaimsPopChallenge(
  cache: PopCacheDeps,
  params: {
    challenge_id: string;
    purpose: PopPurpose;
    public_key_hex: string;
    expected_claims: Record<string, string>;
    signature_hex: string;
  },
): Promise<ClaimsPopVerifyResult> {
  if (cache.isEnabled && !cache.isEnabled()) {
    return { ok: false, reason: 'cache_unavailable' };
  }

  const cacheKey = CLAIMS_CHALLENGE_PREFIX + params.challenge_id;
  const stored = await cache.get<StoredClaimsChallenge>(cacheKey);
  if (
    !stored
    || typeof stored.challenge !== 'string'
    || typeof stored.public_key !== 'string'
    || typeof stored.purpose !== 'string'
    || stored.claims === null
    || typeof stored.claims !== 'object'
  ) {
    return { ok: false, reason: 'challenge_not_found' };
  }
  if (stored.purpose !== params.purpose) {
    return { ok: false, reason: 'purpose_mismatch' };
  }
  const callerKey = normalisePublicKeyHex(params.public_key_hex);
  if (stored.public_key !== callerKey) {
    return { ok: false, reason: 'public_key_mismatch' };
  }
  // Strict claim equality.
  const expected = params.expected_claims;
  const storedKeys = Object.keys(stored.claims).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (storedKeys.length !== expectedKeys.length) {
    return { ok: false, reason: 'claims_mismatch' };
  }
  for (let i = 0; i < storedKeys.length; i++) {
    if (storedKeys[i] !== expectedKeys[i]) {
      return { ok: false, reason: 'claims_mismatch' };
    }
    if (stored.claims[storedKeys[i]] !== expected[storedKeys[i]]) {
      return { ok: false, reason: 'claims_mismatch' };
    }
  }

  let spkiPem: string;
  try {
    spkiPem = uncompressedHexToSpkiPem(callerKey);
  } catch {
    return { ok: false, reason: 'public_key_invalid' };
  }

  const message = canonicalPopMessage({
    purpose: params.purpose,
    challenge: stored.challenge,
    claims: stored.claims,
  });
  let valid: boolean;
  try {
    const verifier = crypto.createVerify('SHA256');
    verifier.update(message);
    valid = verifier.verify(spkiPem, Buffer.from(params.signature_hex, 'hex'));
  } catch {
    return { ok: false, reason: 'signature_verify_error' };
  }
  if (!valid) {
    return { ok: false, reason: 'signature_invalid' };
  }

  if (!cache.setNx || !await cache.setNx(
    CLAIMS_CHALLENGE_REDEMPTION_PREFIX + params.challenge_id,
    true,
    CHALLENGE_TTL_SECONDS,
  )) {
    return { ok: false, reason: 'challenge_consume_failed' };
  }
  await cache.del(cacheKey).catch(() => undefined);
  return { ok: true };
}

/**
 * Convert a 64-byte uncompressed secp256k1 public key (hex, no 0x or 04
 * prefix) into a SPKI PEM string that Node's crypto.createVerify can use.
 *
 * The SPKI structure for secp256k1:
 *   SEQUENCE
 *     SEQUENCE
 *       OBJECT IDENTIFIER 1.2.840.10045.2.1   (id-ecPublicKey)
 *       OBJECT IDENTIFIER 1.3.132.0.10        (secp256k1)
 *     BIT STRING (0 unused bits, 04 || X || Y)
 */
function uncompressedHexToSpkiPem(publicKeyHex: string): string {
  const cleaned = normalisePublicKeyHex(publicKeyHex);
  if (cleaned.length !== 128) {
    throw new Error(`Public key must be 64 bytes (got ${cleaned.length / 2})`);
  }

  // Reattach the 04 uncompressed-point prefix
  const pubKeyBytes = Buffer.from('04' + cleaned, 'hex');

  // SPKI DER for an uncompressed secp256k1 public key (65 bytes of point data)
  const spkiHeaderHex =
    '3056301006072a8648ce3d020106052b8104000a034200';
  const spkiDer = Buffer.concat([Buffer.from(spkiHeaderHex, 'hex'), pubKeyBytes]);

  const b64 = spkiDer.toString('base64');
  // Wrap to 64-char lines per PEM convention
  const wrapped = b64.match(/.{1,64}/g)?.join('\n') ?? b64;
  return `-----BEGIN PUBLIC KEY-----\n${wrapped}\n-----END PUBLIC KEY-----\n`;
}

/**
 * Verify an ECDSA-SHA256 signature over `message` by the holder of the given
 * 64-byte uncompressed secp256k1 public key (hex, no 0x/04 prefix). Returns
 * false on any malformed input or verification error — fail closed, never throw.
 * Shared by the agent wallet-key rotation dual proof-of-possession (old-key and
 * new-key ownership) and any other off-chain secp256k1 ownership check.
 */
export function verifyEcdsaSha256(
  publicKeyHex: string,
  message: string,
  signatureHex: string,
): boolean {
  if (typeof publicKeyHex !== 'string' || typeof message !== 'string'
    || typeof signatureHex !== 'string' || !/^[0-9a-fA-F]+$/.test(signatureHex)
    || signatureHex.length === 0 || signatureHex.length % 2 !== 0) {
    return false;
  }
  let spkiPem: string;
  try {
    spkiPem = uncompressedHexToSpkiPem(publicKeyHex);
  } catch {
    return false;
  }
  try {
    const verifier = crypto.createVerify('SHA256');
    verifier.update(message);
    return verifier.verify(spkiPem, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}
