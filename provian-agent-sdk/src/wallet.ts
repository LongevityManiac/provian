import { guardedFetch as fetch, guardedFetcher } from './guarded-fetch';
/**
 * Agent Wallet - Self-sovereign wallet creation for AI agents.
 *
 * Uses Node.js crypto for secp256k1 key generation and a minimal
 * keccak256 implementation for EVM address derivation.
 * This module itself adds no runtime deps beyond Node.js crypto; the SDK as a
 * whole has minimal runtime deps (@noble/curves + @scure/base for crypto; viem
 * for the EVM signer/bond paths).
 */
import {
  generateKeyPairSync,
  createSign,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  createHash,
} from 'crypto';
import { keccak256 } from './keccak256';
import { deriveEVMAddress, deriveSolanaAddress } from './chains';
import type {
  AgentWalletConfig,
  AgentWalletResult,
  MultiChainAddresses,
  PersistPreparedAgentWalletRegistration,
  PreparedAgentWalletRegistration,
  TrustProfile,
} from './types';
import { NETWORK_CONSTITUTION_VERSION } from './types';
import { ProvianError, ConnectionError } from './errors';

/**
 * Generate a new secp256k1 key pair for an agent wallet.
 * Returns hex-encoded private and public keys plus derived EVM address.
 */
export function generateAgentKeyPair(): {
  privateKey: string;
  publicKey: string;
  address: string;
  chainAddresses: MultiChainAddresses;
} {
  // Generate secp256k1 key pair using Node.js crypto
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'secp256k1',
  });

  // Export raw keys
  const privKeyDer = privateKey.export({ type: 'sec1', format: 'der' });
  const pubKeyDer = publicKey.export({ type: 'spki', format: 'der' });

  // Extract raw private key bytes from SEC1 DER
  // SEC1 format: SEQUENCE { INTEGER 1, OCTET STRING(privkey), [0] OID, [1] BIT STRING(pubkey) }
  // The private key OCTET STRING starts at offset 7 (after 30 xx 02 01 01 04 20)
  const privKeyHex = privKeyDer.subarray(7, 7 + 32).toString('hex');

  // Extract raw uncompressed public key (last 65 bytes of SPKI DER, skip 04 prefix)
  const pubKeyRaw = pubKeyDer.subarray(pubKeyDer.length - 65);
  const pubKeyHex = pubKeyRaw.subarray(1).toString('hex'); // skip 04 prefix

  const addressHash = keccak256(pubKeyRaw.subarray(1));
  const address = toChecksumAddress('0x' + addressHash.subarray(12).toString('hex'));
  // Solana address is derived from the SAME secret (noble/scure, no heavy dep).
  const solana = deriveSolanaAddress(privKeyHex);
  const chainAddresses: MultiChainAddresses = { evm: address, solana };

  return { privateKey: privKeyHex, publicKey: pubKeyHex, address, chainAddresses };
}

/**
 * Reconstruct key pair from an existing hex-encoded private key.
 * Derives the public key using Node.js crypto's createPublicKey.
 * Returns the same structure as generateAgentKeyPair().
 */
function keyPairFromPrivateKey(privKeyHex: string): {
  privateKey: string;
  publicKey: string;
  address: string;
} {
  const privKeyBuf = Buffer.from(privKeyHex, 'hex');
  if (privKeyBuf.length !== 32) {
    throw new ProvianError('Private key must be 32 bytes (64 hex chars)', 'INVALID_KEY');
  }

  // Build SEC1 DER structure for secp256k1 private key
  const ecPrivKey = createPrivateKey({
    key: buildSec1Der(privKeyBuf),
    format: 'der',
    type: 'sec1',
  });

  // Derive the public key from the private key
  const ecPubKey = createPublicKey(ecPrivKey);

  // Export as SPKI DER and extract the uncompressed public key (last 65 bytes)
  const pubKeyDer = ecPubKey.export({ type: 'spki', format: 'der' });
  const pubKeyRaw = pubKeyDer.subarray(pubKeyDer.length - 65);

  if (pubKeyRaw[0] !== 0x04) {
    throw new ProvianError('Unexpected public key format (expected uncompressed)', 'KEY_DERIVATION_ERROR');
  }

  const pubKeyHex = pubKeyRaw.subarray(1).toString('hex');
  const addressHash = keccak256(pubKeyRaw.subarray(1));
  const address = toChecksumAddress('0x' + addressHash.subarray(12).toString('hex'));

  return { privateKey: privKeyHex, publicKey: pubKeyHex, address };
}

/**
 * Derive the EVM address for a hex-encoded secp256k1 private key.
 * Single source of truth for private-key → address derivation; used by the
 * keystore recovery integrity check.
 */
export function deriveAddressFromPrivateKey(privKeyHex: string): string {
  const clean = privKeyHex.trim().toLowerCase().replace(/^0x/, '');
  return keyPairFromPrivateKey(clean).address;
}

/** Internal identity reconstruction used to cross-check authenticated pending
 * registrations. This is intentionally not re-exported from the package root. */
export function deriveAgentIdentityFromPrivateKey(privKeyHex: string): {
  publicKey: string;
  address: string;
} {
  const clean = privKeyHex.trim().toLowerCase().replace(/^0x/, '');
  const derived = keyPairFromPrivateKey(clean);
  return { publicKey: derived.publicKey, address: derived.address };
}

/**
 * Build a SEC1 DER encoding for a secp256k1 private key.
 * This constructs the ASN.1 structure that Node.js crypto can parse.
 */
function buildSec1Der(privKeyBytes: Buffer): Buffer {
  // OID for secp256k1: 1.3.132.0.10
  const oid = Buffer.from('06052b8104000a', 'hex');

  // Wrap private key in OCTET STRING
  const privKeyOctetString = Buffer.concat([
    Buffer.from([0x04, privKeyBytes.length]),
    privKeyBytes,
  ]);

  // Context-specific [0] for curve OID
  const oidWrapped = Buffer.concat([
    Buffer.from([0xa0, oid.length]),
    oid,
  ]);

  // INTEGER version = 1
  const version = Buffer.from([0x02, 0x01, 0x01]);

  // SEQUENCE wrapper
  const innerLength = version.length + privKeyOctetString.length + oidWrapped.length;
  const sequence = Buffer.concat([
    Buffer.from([0x30, innerLength]),
    version,
    privKeyOctetString,
    oidWrapped,
  ]);

  return sequence;
}

/**
 * EIP-55 checksum address encoding.
 */
function toChecksumAddress(address: string): string {
  const addr = address.toLowerCase().replace('0x', '');
  const hash = keccak256(Buffer.from(addr, 'utf8')).toString('hex');

  let checksummed = '0x';
  for (let i = 0; i < 40; i++) {
    checksummed += parseInt(hash[i], 16) >= 8
      ? addr[i].toUpperCase()
      : addr[i];
  }
  return checksummed;
}

/**
 * Prepare one stable registration identity and require the caller to durably
 * persist it before any networking is possible. The persistence callback is
 * the security boundary: if it throws, no prepared identity is returned.
 */
export async function prepareAgentWalletRegistration(
  config: AgentWalletConfig,
  persist: PersistPreparedAgentWalletRegistration,
): Promise<PreparedAgentWalletRegistration> {
  if (typeof persist !== 'function') {
    throw new ProvianError(
      'A durable prepared-registration store is required before wallet creation',
      'DURABLE_REGISTRATION_REQUIRED',
    );
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(config.agentId)) {
    throw new ProvianError('agentId must be alphanumeric with ._- only', 'INVALID_AGENT_ID');
  }
  const keyPair = generateAgentKeyPair();
  const createdAt = new Date().toISOString();
  const prepared: PreparedAgentWalletRegistration = {
    schemaVersion: 'prepared-agent-wallet-registration/v1',
    registrationId: `agent-registration-${randomUUID()}`,
    relayUrl: config.relayUrl.replace(/\/$/, ''),
    agentId: config.agentId,
    agentName: config.agentName || config.agentId,
    platform: config.platform || 'sdk',
    constitutionAccepted: config.constitutionAccepted === true,
    constitutionVersion: config.constitutionVersion || NETWORK_CONSTITUTION_VERSION,
    constitutionAcceptedAt: config.constitutionAcceptedAt || createdAt,
    // Sealed into the durable snapshot alongside the key, so the anchor cannot drift
    // between preparing and resuming a registration.
    ...(config.connectionToken ? { connectionToken: config.connectionToken } : {}),
    ...(config.parentWalletId ? { parentWalletId: config.parentWalletId } : {}),
    ...(config.governance ? { governance: config.governance } : {}),
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
    address: keyPair.address,
    chainAddresses: keyPair.chainAddresses,
    createdAt,
  };
  await persist(prepared);
  return prepared;
}

/**
 * The legacy one-call convenience cannot prove that its fund-bearing key was
 * durable before the first request, so it fails before generating a key or
 * contacting the relay. Use loadOrCreatePendingAgentWalletRegistration() from
 * the package root to obtain an authenticated opaque handle, then use the
 * package-root resumeAgentWalletRegistration().
 */
export async function createAgentWallet(
  _config: AgentWalletConfig,
): Promise<AgentWalletResult> {
  throw new ProvianError(
    'Durable registration state is required. Prepare and persist the agent ID/key before networking, then resume the registration.',
    'DURABLE_REGISTRATION_REQUIRED',
  );
}

/**
 * Retired raw-object resume compatibility entrypoint.
 *
 * A structurally valid object cannot prove it is the exact snapshot persisted
 * before networking. The safe package-root entrypoint with this name accepts
 * only an opaque handle returned by loadOrCreatePendingAgentWalletRegistration
 * and rereads the authenticated file before every request.
 */
export async function resumeAgentWalletRegistration(
  _prepared: PreparedAgentWalletRegistration,
): Promise<AgentWalletResult> {
  throw new ProvianError(
    'Raw prepared registrations cannot authorize networking; load an authenticated durable registration handle first',
    'DURABLE_REGISTRATION_HANDLE_REQUIRED',
  );
}

/**
 * Sign a message with the agent's private key (for relay authentication).
 * Returns a hex-encoded ECDSA signature.
 */
export function signMessage(privateKeyHex: string, message: string): string {
  const privKeyBuf = Buffer.from(privateKeyHex, 'hex');
  const privKey = createPrivateKey({
    key: buildSec1Der(privKeyBuf),
    format: 'der',
    type: 'sec1',
  });

  const signer = createSign('SHA256');
  signer.update(message);
  return signer.sign(privKey, 'hex');
}

// ---------------------------------------------------------------------------
// Key Rotation
// ---------------------------------------------------------------------------

export interface RotateKeyConfig {
  /** Persist this tuple before calling; retries use the same identity and credentials. */
  durableRotation?: { rotationId: string; apiKey: string; apiSecret: string };
  /** Relay base URL */
  relayUrl: string;
  /** Provian wallet ID */
  walletId: string;
  /** Current (old) hex-encoded secp256k1 private key (64 hex chars) */
  oldPrivateKey: string;
  /** New hex-encoded secp256k1 private key (64 hex chars) */
  newPrivateKey: string;
  /** Current API key */
  apiKey: string;
  /** Current API secret */
  apiSecret: string;
}

export interface RotateKeyResult {
  /** Wallet ID (unchanged) */
  walletId: string;
  /** Previous EVM address */
  oldAddress: string;
  /** New EVM address */
  newAddress: string;
  /** New API key - old one is invalidated */
  apiKey: string;
  /** New API secret - old one is invalidated */
  apiSecret: string;
  /** Timestamp of rotation */
  rotatedAt: number;
}

/**
 * Rotate an agent wallet's key pair (activation — re-enabled). Proves control of BOTH
 * the current (old) key and the new key via dual ECDSA-SHA256 proof-of-possession
 * over LOWERCASED addresses (byte-canonical with the relay), then the relay runs
 * the atomic wallet/trust identity transition (wallet + trust mirror + native
 * indexes + fresh two-operator H+1 fence + watcher admission + membership
 * generation + API credentials + old-address retirement + rotation_history +
 * the record_only agent_key_rotated PE, all in one Firestore transaction). The
 * PE chain and any beneficiary links survive because they reference wallet_id,
 * not the address. Returns the NEW API credentials (the old ones are retired);
 * the relay enforces max 1 rotation / 24h.
 *
 * This is the SDK half of the joint flip: it and the relay's 503 were lifted
 * together. Persist the new private key + returned credentials before relying on
 * them — the old key/credentials stop working once the relay returns 200.
 */
export async function rotateKey(config: RotateKeyConfig): Promise<RotateKeyResult> {
  const oldKeyPair = keyPairFromPrivateKey(config.oldPrivateKey);
  const newKeyPair = keyPairFromPrivateKey(config.newPrivateKey);
  const timestamp = Date.now();
  const durable = config.durableRotation;
  const suffix = durable ? `:${durable.rotationId}:${createHash('sha256').update(`${durable.apiKey}:${durable.apiSecret}`).digest('hex')}` : '';

  // proof_of_old_key: sign "rotate:{walletId}:{newAddress}:{ts}" with the OLD key.
  const oldKeyMessage = `rotate:${config.walletId}:${newKeyPair.address.toLowerCase()}:${timestamp}${suffix}`;
  const proofOfOldKey = signMessage(config.oldPrivateKey, oldKeyMessage);
  // proof_of_new_key: sign "rotate:{walletId}:{oldAddress}:{ts}" with the NEW key.
  const newKeyMessage = `rotate:${config.walletId}:${oldKeyPair.address.toLowerCase()}:${timestamp}${suffix}`;
  const proofOfNewKey = signMessage(config.newPrivateKey, newKeyMessage);

  const base = config.relayUrl.replace(/\/$/, '');
  const authToken = `${config.apiKey}:${config.apiSecret}`;

  // re-escrow the NEW key ATOMICALLY with the rotation. Read this agent's
  // existing escrow anchor (public half) and re-seal the new key to the SAME
  // anchor, so the linked human's phone can still recover it. When no escrow
  // exists yet (404) the agent rotates without one (nothing to keep recoverable);
  // the relay refuses a rotation that would ORPHAN an existing escrow.
  let recoveryEscrow: { sealed_key_blob: string; recovery_anchor_pubkey: string } | undefined;
  try {
    const anchorRes = await fetch(`${base}/v1/agent/wallet/${config.walletId}/recovery-anchor`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${authToken}` },
    });
    if (anchorRes.ok) {
      const anchor = await anchorRes.json() as { recovery_anchor_pubkey?: string };
      if (typeof anchor.recovery_anchor_pubkey === 'string' && anchor.recovery_anchor_pubkey.length > 0) {
        const { sealToAnchor, fromB64u, toB64u } = await import('./agent-key-recovery.js');
        const { hexToBytes } = await import('@noble/hashes/utils');
        const anchorPub = fromB64u(anchor.recovery_anchor_pubkey);
        const sealed = sealToAnchor(anchorPub, hexToBytes(config.newPrivateKey.replace(/^0x/, '')));
        recoveryEscrow = {
          sealed_key_blob: toB64u(sealed),
          recovery_anchor_pubkey: anchor.recovery_anchor_pubkey,
        };
      }
    }
    // A 404 (no escrow) leaves recoveryEscrow undefined → rotate without one.
  } catch {
    // Anchor read / seal failed: leave recoveryEscrow undefined. The relay then
    // refuses the rotation if an escrow exists (never orphans it), which surfaces
    // loudly rather than silently un-escrowing the agent.
  }

  const url = `${base}/v1/agent/wallet/${config.walletId}/rotate-key`;
  let response: Response;
  try {
    const send = (credential: string): Promise<Response> => fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${credential}`,
      },
      body: JSON.stringify({
        new_address: newKeyPair.address,
        new_public_key: newKeyPair.publicKey,
        proof_of_old_key: proofOfOldKey,
        proof_of_new_key: proofOfNewKey,
        timestamp,
        ...(recoveryEscrow ? recoveryEscrow : {}),
        ...(durable ? { rotation_id: durable.rotationId, new_api_key: durable.apiKey, new_api_secret: durable.apiSecret } : {}),
      }),
    });
    // Try the proposed pair first: if the cut committed but its response was
    // lost, this returns the SAME rotation. Before the cut it returns 401 and
    // the still-current old pair authorizes the first transition.
    response = await send(durable ? `${durable.apiKey}:${durable.apiSecret}` : authToken);
    if (durable && response.status === 401) response = await send(authToken);
  } catch (error) {
    throw new ConnectionError(`Failed to reach relay: ${(error as Error).message}`, { cause: error });
  }

  if (!response.ok) {
    const errorBody = await response.text();
    let parsed: { error?: string; reason?: string } | null;
    try { parsed = JSON.parse(errorBody); } catch { parsed = null; }
    throw new ProvianError(
      parsed?.reason || parsed?.error || `HTTP ${response.status}: ${response.statusText}`,
      `HTTP_${response.status}`,
    );
  }

  const result = await response.json() as {
    wallet_id: string;
    old_address: string;
    new_address: string;
    api_key: string;
    api_secret: string;
    rotated_at: number;
  };

  if (result.wallet_id !== config.walletId || result.old_address?.toLowerCase() !== oldKeyPair.address.toLowerCase()
    || result.new_address?.toLowerCase() !== newKeyPair.address.toLowerCase()
    || !/^pvn_live_[0-9a-f]{32}$/.test(result.api_key) || !/^pvns_[0-9a-f]{64}$/.test(result.api_secret)
    || (durable && (result.api_key !== durable.apiKey || result.api_secret !== durable.apiSecret))) {
    throw new ProvianError('Rotation response does not match the staged identity', 'ROTATION_RESPONSE_MISMATCH');
  }
  return {
    walletId: result.wallet_id,
    oldAddress: result.old_address,
    newAddress: result.new_address,
    apiKey: result.api_key,
    apiSecret: result.api_secret,
    rotatedAt: result.rotated_at,
  };
}

/**
 * Fetch the unified trust profile for any wallet address (human or agent).
 * Requires authentication - pass a session token or wallet auth token.
 */
export async function getTrustProfile(
  relayUrl: string,
  address: string,
  authToken: string
): Promise<TrustProfile> {
  const url = `${relayUrl}/v1/trust/profile/${address}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
    });
  } catch (error) {
    throw new ConnectionError(`Failed to reach relay: ${(error as Error).message}`, { cause: error });
  }

  if (!response.ok) {
    const errorBody = await response.text();
    let parsed: { error?: string } | null;
    try { parsed = JSON.parse(errorBody); } catch { parsed = null; }
    throw new ProvianError(
      parsed?.error || `HTTP ${response.status}: ${response.statusText}`,
      `HTTP_${response.status}`,
    );
  }

  const data = await response.json() as TrustProfile;

  return {
    address: data.address,
    ownerType: data.ownerType,
    peCount: data.peCount,
    pvtEarned: data.pvtEarned,
    trustScore: data.trustScore,
    memberSince: data.memberSince,
    actionBreakdown: data.actionBreakdown,
  };
}
