import { observeActorSession } from '../core/jurisdiction/mint-compliance';
import {readGenesisActivation} from '../core/pvt/genesis-activation-store';
/**
 * Agent Wallet Router - Self-signup API
 *
 * Endpoints:
 * POST /create - Create agent wallet (no auth, rate limited)
 * GET /:wallet_id - Get wallet info (API key auth)
 * POST /:wallet_id/governance - Store self-declared flags; they gate nothing (API key auth)
 * GET /:wallet_id/pe-chain - 410 pe_kept_by_owner: the agent keeps its own PE chain (API key auth)
 * POST /:wallet_id/link-human - Link agent to human beneficiary (API key auth)
 * POST /:wallet_id/unlink-human - Unlink agent from human (API key auth)
 * POST /:wallet_id/human-unlink - The linked human ends the link alone (wallet auth)
 * PUT /:wallet_id/link-human - Update exact beneficiary agent-share BPS (API key auth)
 * POST /:wallet_id/rotate-key - Rotate the wallet key/address (activation; atomic identity transition + dual PoP)
 */

import { agentGenesisWhatEarns } from './agent-wallet-genesis-copy';
import { readHumanRecoveryAnchor } from '../core/human-recovery-anchor';
import { issueWalletChallengeFromRequest } from '../core/presentation/challenge-issuer';
import { canonicalPeAnchorReadContract } from '../core/presentation/anchor-contract';
import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import admin from 'firebase-admin';
import stableStringify from 'json-stable-stringify';
import { ethers } from 'ethers';
import { getChainProvider } from '../core/onchain/rpc-provider';
import { bumpOpsCounter } from '../core/observability/ops-counters';
import { assertLiveValueRecipient } from '../core/config/live-value-recipients';
import { resolveEvmSwapFeeRecipient, verifyZeroXQuoteFee, SwapFeeError } from '../core/swap/swap-fees';
import { readAgreedBaseHead } from '../core/onchain/economic-discovery';
import { PVT9_BASE_CONFIG } from '../core/pvt/pvt9-base-config.generated';
import {
  escrowV4AddressForChain,
  promiseV3AddressForChain,
  poolV3AddressForChain,
  courtAddressForChain,
} from '../core/agent-bank/chain-registry';
import {
  createNativeWalletRegistrationFence,
  NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION,
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
  nativeAgentRegistrationIndexId,
  nativeWalletAddressIndexId,
} from '../core/pvt/native-wallet-registration';
import {
  prepareNativeWalletWatcherRegistration,
  writeNativeWalletWatcherRegistration,
  type NativeWalletWatcherRegistrationPlan,
} from '../core/pvt/watcher-address-admission';
import {
  generateApiCredentials,
  generateApiCredentialsAsync,
  type ApiCredentials,
} from '../core/agent-wallet/api-key';
import {
  issuePopChallenge,
  verifyAndConsumePopChallenge,
  issueClaimsPopChallenge,
  verifyAndConsumeClaimsPopChallenge,
  verifyEcdsaSha256,
} from '../core/agent-wallet/proof-of-possession';
import { generatePE as generatePEAtomic } from '../core/agent-bank/pe-utils';
import { chainRecordEnqueue } from '../core/pvt/chain-record-watcher';
import { resolvableOrigin, chainWatcherWitness } from '../core/provenance/origin-capture';
import { relayObservationWitness, RELAY_WITNESS_CHAIN_WATCHER } from '../core/pvt/relay-observation-witness';
import { readInbox, INBOX_MAX_LIMIT } from '../core/agent-bank/agent-inbox';
import { chainAddressesToStore, validateReportedChainAddresses } from '../core/agent-wallet/chain-addresses';
import { resolveRelayUrl } from '../core/setup-command';
import { buildAgentDeviceInstallLines } from '../core/agent-bootstrap-script';
import { resolveBirthRecoveryAnchor } from '../core/agent-wallet/birth-recovery-anchor';
import {
  AGENT_BIRTH_RECOVERY_ANCHOR_COLLECTION,
  birthRecoveryAnchorRecord,
  checkEscrowAnchor,
  recordBirthRecoveryAnchorIfAbsent,
} from '../core/agent-wallet/escrow-anchor-policy';
import {
  GENESIS_ACTIVATION_COLLECTION,
  GENESIS_ACTIVATION_DOCUMENT,
  buildGenesisQualification,
  genesisQualificationRef,
  shouldEnqueueGenesisQualification,
  shouldPersistGenesisQualification,
  writeGenesisQualification,
  writeRetainedGenesisQualification,
  type GenesisQualificationDocument,
} from '../core/pvt/genesis-award-state-machine';
import {
  AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION,
  KeyRotationTransitionError,
  executeKeyRotationTransition,
  prepareKeyRotationTransition,
} from '../core/agent-wallet/key-rotation-transition';
import { externalProofRefs } from '../core/external-address/link';
import { verifyEvmTxFrom, verifyTransfer, verifyEvmNativeTransfer, type SupportedVerificationChain } from '../core/onchain/tx-verifier';
import { recordFirstPartyBurn, BURN_RECORD_MAX_WAIT_MS } from '../core/presentation/burn-record';
import { evaluateBadges } from '../core/agent-wallet/badges';
import {
  awardBadgeFromOutbox,
  BadgeProvenanceIntegrityError,
  badgeAwardOutboxRef,
  badgeIds,
  createPendingBadgeAward,
  reconcileBadgeAwards,
} from '../core/agent-wallet/badge-provenance';
import { countVisibleAgentPEs } from '../core/agent-wallet/agent-pe-activity';
import { sendPeKeptByOwner } from '../core/meter/owner-reads';
import {
  DEFAULT_AGENT_BENEFICIARY_SHARE_BPS,
  beneficiaryRelationshipRef,
  beneficiaryRelationshipSnapshot,
  canonicalAgentBeneficiaryShareBps,
  createBeneficiaryRelationshipDocument,
  readValidatedBeneficiaryRelationship,
  readValidatedBeneficiaryRelationshipInTransaction,
  type AgentBeneficiaryShareBps,
  type AgentBeneficiaryRelationshipDocument,
} from '../core/agent-wallet/beneficiary-relationship';
import {
  agentGovernanceSourceRef,
  createAgentGovernanceSourceDocument,
} from '../core/agent-wallet/governance-source';
import {
  BeneficiaryLinkConflictError,
  bindAgentToHuman,
  inviteAcceptanceRefusal,
  unbindAgentFromHuman,
  updateAgentBeneficiaryShareBps,
} from '../core/agent-wallet/link-human-binding';
import { enqueueAgentBankEvent } from '../core/agent-bank/event-outbox';
import {
  AGENT_WALLET_REGISTRATION_COLLECTION,
  AgentWalletRegistrationIntegrityError,
  agentWalletRegistrationDocumentId,
  prevalidateAgentWalletRegistrationRecovery,
  validateAgentWalletRegistrationRecoveryTransaction,
  type AgentWalletRegistrationDocument,
} from '../core/agent-wallet/registration-recovery-integrity';
import { createAgentAuthMiddleware } from './middleware/agent-auth';
import {
  canonicalLinkSignaturePayload,
  linkSignatureAuthorization,
  LinkSignatureRefusedError,
  parseLinkEpoch,
  type LinkSignaturePayload,
} from '../core/agent-wallet/link-signature';
import { AGENT_WALLET_REGISTRATION_CHANNELS } from '../core/agent-wallet/types';
import { verifyWalletAuthToken } from './middleware/wallet-auth';
import {
  applyHumanAgentName,
  validateAgentDisplayName,
} from '../core/agent-wallet/human-agent-name';
import {
  isValidSealedKeyBlobB64u,
  isValidAnchorPubkeyB64u,
  storeRecoveryEscrow,
  readRecoveryEscrow,
  hasRecoveryEscrow,
  isValidRecoveryAlarmReason,
  raiseRecoveryAlarm,
  clearRecoveryAlarm,
} from '../core/agent-recovery-escrow';
import type {
  RouterDeps,
  AgentWalletDocument,
  CreateAgentWalletRequest,
  CreateAgentWalletResponse,
  WelcomeMessage,
  LinkHumanRequest,
  UnlinkHumanRequest,
  LinkHumanResponse,
  RotateKeyRequest,
  RotateKeyResponse,
  RecoveryRekeyRequest,
  RecoveryRekeyResponse,
  AgentInviteDocument,
} from '../core/agent-wallet/types';
import { NETWORK_CONSTITUTION_VERSION } from '../core/agent-wallet/types';
import { sendConnectCommand } from '../email';
import { claimName, namesForWallet } from '../core/commons/name-registry';
import { stakeVouch, vouchesByVoucher } from '../core/commons/burn-vouch';
import { standingPresentationsByWallet } from '../core/commons/standing-export';
import { producePresentationFromRequest, preflightPresentationFromRequest } from '../core/presentation/service';
import { buildAgentPrincipal } from '../core/presentation/principal';
import { computeActorVocabulary, isVocabularyUnavailableError, selfViewOfVocabulary, STANDING_FIELD_PREFIX } from '../core/presentation/vocabulary';
import { encodePresentationToken } from '../core/presentation/types';
import { buildApprovalRequest, toAgentFacingRequest, type ApprovalRequestStatus } from '../core/pe/human-approval-request';
import { writeApprovalRequest, listRequestsForAgent, pushApprovalRequestToHuman } from '../core/pe/human-approval-request-store';
import {
  buildPresentationRequest,
  toAgentFacingRequest as toAgentFacingPresentationRequest,
  type PresentationRequestStatus,
} from '../core/pe/presentation-request';
import {
  writePresentationRequest,
  listRequestsForAgent as listPresentationRequestsForAgent,
  recordPresentationForRequest,
  getPresentationRequest,
  pushPresentationRequestToHuman,
} from '../core/pe/presentation-request-store';
import { verifyFreshPresentationToken } from '../core/pe/presentation-submit-verify';
import { loadCommerceAttestationKeys } from '../core/presentation/jws-key-material';
import { readHandshakeState } from '../core/rail/handshake';
import { makePledge, pledgesByWallet } from '../core/commons/pledges';
import { subscribe, subscriptionsByWallet } from '../core/commons/subscriptions';
import { fetchBounded, DeadlineExceededError, ResponseTooLargeError } from '../core/net/bounded-fetch';

/** body cap on the agent 0x quote read (a quote is a few kB; 5 MiB is far above it). */
const ZEROX_QUOTE_MAX_BYTES = 5 * 1024 * 1024;

const FieldValue = admin.firestore.FieldValue;

export { AGENT_WALLET_REGISTRATION_COLLECTION };
const AGENT_WALLET_REGISTRATION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{15,127}$/;
const AGENT_WALLET_REGISTRATION_CLOCK_SKEW_MS = 5 * 60 * 1000;

type AgentRegistrationRecoveryCode =
  | 'identity_mismatch'
  | 'recovery_in_progress'
  | 'integrity_failure';

class AgentRegistrationRecoveryError extends Error {
  constructor(readonly code: AgentRegistrationRecoveryCode) {
    super(`agent_wallet_registration_recovery_${code}`);
  }
}

/** Accept the documented 128-hex x||y form and the optional 130-hex SEC1
 * 04||x||y form. A legitimate no-prefix x coordinate may itself begin `04`,
 * so the prefix is removed only when the post-0x input is 130 hex chars. */
function normalizeAgentWalletPublicKey(value: string): string {
  let cleaned = value.toLowerCase().replace(/^0x/, '');
  if (cleaned.length === 130 && cleaned.startsWith('04')) cleaned = cleaned.slice(2);
  return cleaned;
}

// Exported for the installed-base compatibility suite (`installed-base-compat.test.ts`):
// this is the frozen relay contract every fielded agent's stored
// `request_fingerprint_sha256` was computed against. A change to its canonical
// (a dropped/added/reordered key) orphans every prior registration's recovery —
// the exact break where dropping `agent_session_id` would have refused
// credential recovery for the entire installed base. The compat suite pins a
// golden input→sha256 so any such change goes RED before it ships.
export function agentWalletRegistrationRequestFingerprint(params: {
  registrationId: string;
  agentName: string;
  agentId: string;
  platform: string;
  chains: readonly string[];
  priorRequestContext?: unknown;
  callbackUrl: string | null;
  governance: AgentWalletDocument['governance'];
  constitutionAccepted: boolean;
  constitutionVersion: string;
  constitutionAcceptedAt: number;
  parentWalletId: string | null;
  /** The connection token as the caller sent it, or null. See the note below. */
  connectionToken: string | null;
  /**
   * addendum 3: the relay session is retired and this value names NOTHING, but it
   * stays in the canonical object AS SENT (or null) because it was an unconditional key
   * before the retirement. Dropping it would change the SHA256 of every registration
   * request, and `registration-recovery-integrity.ts` compares the stored fingerprint
   * exactly — every pre-retirement registration (Atlas included) would then be refused
   * credential recovery with `agent_wallet_registration_recovery_identity_mismatch`.
   * Present-as-sent keeps old and new fingerprints byte-identical.
   */
  agentSessionId: string | null;
}): string {
  const fields = {
    schema_version: 'agent-wallet-registration-request/v1',
    registration_id: params.registrationId,
    agent_name: params.agentName,
    agent_id: params.agentId,
    platform: params.platform,
    chains: [...params.chains],
    callback_url: params.callbackUrl,
    governance: params.governance,
    constitution_accepted: params.constitutionAccepted,
    constitution_version: params.constitutionVersion,
    constitution_accepted_at: params.constitutionAcceptedAt,
    agent_session_id: params.agentSessionId,
    parent_wallet_id: params.parentWalletId,
    // The connection token is fingerprinted AS SENT, never as resolved.
    //
    // This distinction is load-bearing. The token resolves to the issuing human's wallet id
    // by a live lookup, and that lookup's answer can legitimately CHANGE between a first
    // attempt and its retry — most obviously when the issuing human completes their own
    // wallet registration in between, flipping the result from null to a wallet id.
    // Fingerprinting the resolved value would turn that into a fingerprint mismatch, and a
    // mismatch on this route is an integrity error, not a warning: a perfectly valid retry
    // would be refused. The request bytes are stable; the world is not, so bind the bytes.
    // Omit absent optional fields to preserve existing retry bytes.
    ...(params.connectionToken === null ? {} : { connection_token: params.connectionToken }),
  };
  // Opaque former optional fields only reconstruct an already committed digest.
  // They never change the current request or any stored wallet field.
  const context: Record<string, string> = {};
  if (params.priorRequestContext !== undefined) {
    const value = params.priorRequestContext;
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length > 16) {
      throw new Error('invalid_prior_request_context');
    }
    const reserved = new Set([...Object.keys(fields), 'connection_token', 'public_key', 'chain_addresses',
      'challenge_id', 'signature', 'parent_proof_of_authorization', 'prior_request_context', '__proto__', 'constructor', 'prototype']);
    for (const [key, entry] of Object.entries(value)) {
      if (reserved.has(key) || !/^[a-z][a-z0-9_]{0,63}$/.test(key) || /key|secret|token|password|mnemonic|credential/.test(key)
        || typeof entry !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/.test(entry)) throw new Error('invalid_prior_request_context');
      context[key] = entry;
    }
  }
  const canonical = stableStringify({...fields, ...context});
  if (typeof canonical !== 'string') {
    throw new Error('agent_wallet_registration_request_not_canonical');
  }
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

async function recoverCommittedAgentWalletRegistration(params: {
  db: admin.firestore.Firestore;
  registrationId: string;
  requestFingerprint: string;
  agentId: string;
  agentName: string;
  platform: string;
  chains: readonly string[];
  callbackUrl: string | null;
  governance: AgentWalletDocument['governance'];
  parentWalletId: string | null;
  address: string;
  publicKey: string;
  constitutionAccepted: boolean;
  constitutionVersion: string;
  constitutionAcceptedAt: number;
  expectedRecoveryGeneration: number;
  expectedIdentityPeIds: readonly string[];
  expectedIdentityPeHashes: readonly string[];
  expectedExternalActorAddresses: readonly string[];
  expectedChildRelationships: readonly AgentBeneficiaryRelationshipDocument[];
  apiCredentials: ApiCredentials;
  now: number;
}): Promise<{
  wallet: AgentWalletDocument;
  peId: string;
  oldApiKeyPrefix: string;
  recoveryGeneration: number;
}> {
  return params.db.runTransaction(async (txn) => {
    let validated;
    try {
      validated = await validateAgentWalletRegistrationRecoveryTransaction(
        params.db,
        txn,
        {
          registrationId: params.registrationId,
          requestFingerprint: params.requestFingerprint,
          agentId: params.agentId,
          agentName: params.agentName,
          platform: params.platform,
          chains: params.chains,
          callbackUrl: params.callbackUrl,
          governance: params.governance,
          parentWalletId: params.parentWalletId,
          address: params.address.toLowerCase(),
          publicKey: params.publicKey.toLowerCase(),
          constitutionAccepted: params.constitutionAccepted,
          constitutionVersion: params.constitutionVersion,
          constitutionAcceptedAt: params.constitutionAcceptedAt,
          expectedRecoveryGeneration: params.expectedRecoveryGeneration,
          now: params.now,
        },
        params.expectedIdentityPeIds,
        params.expectedIdentityPeHashes,
        params.expectedExternalActorAddresses,
        params.expectedChildRelationships,
      );
    } catch (error) {
      if (error instanceof AgentWalletRegistrationIntegrityError
        && error.reason === 'registration_binding') {
        throw new AgentRegistrationRecoveryError('identity_mismatch');
      }
      if (error instanceof AgentWalletRegistrationIntegrityError
        && error.reason === 'registration_generation_changed') {
        throw new AgentRegistrationRecoveryError('recovery_in_progress');
      }
      throw new AgentRegistrationRecoveryError('integrity_failure');
    }
    const { registration, wallet, refs } = validated;
    const newIndexRef = params.db.collection('api_key_index')
      .doc(params.apiCredentials.api_key_prefix);
    const newIndexSnap = await txn.get(newIndexRef);
    // The replacement prefix must not collide with any existing prefix, nor
    // reuse the CURRENT prefix being retired in this transaction (which is the
    // rotated prefix for a rotated wallet, the birth prefix otherwise). `refs`
    // (incl. oldIndexRef) already follow the current identity via the validator.
    if (newIndexSnap.exists
      || params.apiCredentials.api_key_prefix === wallet.api_key_prefix) {
      throw new AgentRegistrationRecoveryError('integrity_failure');
    }

    const recoveryGeneration = registration.credential_recovery_generation + 1;
    txn.create(newIndexRef, {
      api_key_prefix: params.apiCredentials.api_key_prefix,
      wallet_id: registration.wallet_id,
      created_at: params.now,
    });
    txn.update(refs.walletRef, {
      api_key_hash: params.apiCredentials.api_key_hash,
      api_key_salt: params.apiCredentials.api_key_salt,
      api_key_prefix: params.apiCredentials.api_key_prefix,
      updated_at: params.now,
    });
    txn.update(refs.agentIndexRef, {
      api_key_prefix: params.apiCredentials.api_key_prefix,
      credential_recovery_generation: recoveryGeneration,
      updated_at_ms: params.now,
    });
    txn.update(refs.registrationRef, {
      api_key_prefix: params.apiCredentials.api_key_prefix,
      credential_recovery_generation: recoveryGeneration,
      last_credential_recovered_at_ms: params.now,
    });
    txn.delete(refs.oldIndexRef);
    return {
      wallet,
      peId: registration.pe_id,
      // The retired prefix is the CURRENT one (rotated prefix for a rotated
      // wallet), used only to invalidate the corresponding cache entry.
      oldApiKeyPrefix: wallet.api_key_prefix,
      recoveryGeneration,
    };
  });
}

/**
 * Email availability mirror of server.ts EMAIL_DISABLED. Email is not on the
 * critical path; when no Resend key is configured we 503 the device-invite
 * endpoint rather than minting a token whose command can never be delivered.
 */
const EMAIL_DISABLED = !process.env.RESEND_API_KEY;

/** Same email shape + length validation as the in-app email-command path. */
const DEVICE_INVITE_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** TTL for the emailed agent-device-registration token (1 hour). */
const AGENT_DEVICE_INVITE_TTL_MS = 60 * 60 * 1000;

/** Cap on active (unused, unexpired) agent-device tokens per wallet. */
const MAX_ACTIVE_AGENT_DEVICE_TOKENS = 5;

/**
 * Invite acceptance window. The mint endpoints stamp `expires_at` on every
 * `agent_invites` doc — 7 days for `/invite` (INVITE_EXPIRY_MS), 30 days for
 * `/invite-human` (BENEFICIARY_INVITE_EXPIRY_MS, agent-invite.ts) — and the
 * consumption endpoints honor that stamp. Before 2026-07 both consumption
 * endpoints hardcoded 7 days from `created_at` and never read `expires_at`,
 * silently expiring beneficiary invites 23 days early; legacy docs missing the
 * field keep that 7-day fallback.
 */
const LEGACY_INVITE_FALLBACK_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
function isInviteExpired(invite: { created_at?: number; expires_at?: number }): boolean {
  const expiresAt =
    typeof invite.expires_at === 'number' && invite.expires_at > 0
      ? invite.expires_at
      : (typeof invite.created_at === 'number' ? invite.created_at : 0) + LEGACY_INVITE_FALLBACK_EXPIRY_MS;
  return Date.now() > expiresAt;
}

/**
 * Pure, unit-testable validation + token mint for the agent-initiated
 * device-invite (M5/M6). Does NOT perform rate limiting or email sending - the
 * route does those around this call. Validates the email, then writes a
 * setup_tokens doc with the EXACT field ALLOWLIST (never api_key/secret/hash/
 * salt). owner_address / agent_id come from the loaded wallet doc (the agent
 * wallet doc is the source of truth, not caller input).
 *
 * Returns the minted token plus expiry on success, or a structured error the
 * caller maps to an HTTP status. The token is returned ONLY so the route can
 * embed it in the email; it is NEVER put in the HTTP response.
 */
export interface MintAgentDeviceInviteResult {
  ok: true;
  token: string;
  expiresAt: number;
}
export interface MintAgentDeviceInviteError {
  ok: false;
  status: number;
  error: string;
}

export async function mintAgentDeviceInviteToken(
  deps: RouterDeps,
  params: { agentWallet: AgentWalletDocument; email: string },
): Promise<MintAgentDeviceInviteResult | MintAgentDeviceInviteError> {
  const { db } = deps;
  const { agentWallet, email } = params;

  const trimmedEmail = typeof email === 'string' ? email.trim() : '';
  if (!DEVICE_INVITE_EMAIL_REGEX.test(trimmedEmail) || trimmedEmail.length > 254) {
    return { ok: false, status: 400, error: 'A valid email address is required' };
  }

  const now = Date.now();
  const expiresAt = now + AGENT_DEVICE_INVITE_TTL_MS;
  const emailHash = crypto.createHash('sha256').update(trimmedEmail.toLowerCase()).digest('hex');
  const token = crypto.randomBytes(32).toString('hex');

  // Field ALLOWLIST (M6): write ONLY these keys. NEVER write api_key/api_secret/
  // hash/salt. owner_address / agent_id are read from the wallet doc.
  await db.collection('setup_tokens').doc(token).set({
    agent_wallet_id: agentWallet.id,
    agent_id: agentWallet.agent_id,
    owner_type: 'agent',
    owner_address: agentWallet.address || '',
    type: 'agent_device_registration',
    created_at: now,
    expires_at: expiresAt,
    used: false,
    email_hash: emailHash,
  });

  return { ok: true, token, expiresAt };
}

const LINK_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes
const LINK_EPOCH_REQUIRED = 'link_epoch is required: sign the payload with the relationship epoch from GET /v1/agent/wallet/:wallet_id/link-epoch (link, unlink and share-change signatures are single-use)';

/**
 * Atomic Firestore fallback rate limit. Returns true if the limit is
 * exceeded for the given key, false otherwise. Same 100/hr per-key budget
 * as the original non-transactional version. Re-audit MED-2 fix.
 *
 * Exported for unit testing the transaction's atomicity. Production callers
 * use it through the route handler.
 */
export async function firestoreFallbackRateLimit(
  db: admin.firestore.Firestore,
  rlKey: string,
  limit = 100,
  windowMs = 3600_000,
): Promise<boolean> {
  const rlRef = db.collection('rate_limits').doc(rlKey);
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(rlRef);
    const now = Date.now();
    if (!snap.exists) {
      txn.set(rlRef, { count: 1, window_start: now });
      return false;
    }
    const rl = snap.data() as { count: number; window_start: number };
    const windowAge = now - rl.window_start;
    if (windowAge >= windowMs) {
      txn.set(rlRef, { count: 1, window_start: now });
      return false;
    }
    if (rl.count >= limit) {
      return true;
    }
    txn.update(rlRef, { count: (rl.count || 0) + 1 });
    return false;
  });
}

/** Inputs for recording an agent swap PE (Fix F1). */
export interface RecordAgentSwapParams {
  walletId: string;
  /** The authenticated wallet from req.agentWallet (ownership is checked here). */
  agentWallet: AgentWalletDocument | undefined;
  txHash: string;
  fromToken: string;
  toToken: string;
  fromAmount: string;
  toAmount: string;
  feeAmount?: string;
}

export type RecordAgentSwapResult =
  | { ok: true; peId: string; idempotent?: boolean }
  | { ok: false; status: number; error: string; reason?: string };

/**
 * Verify a completed agent swap on-chain and record its PE (Fix F1).
 *
 * Extracted from the POST /:wallet_id/swap/record handler so the security
 * properties can be unit-tested:
 *  - ownership: only the authenticated wallet may record a swap for wallet_id
 *    (the handler previously re-fetched by path param with NO ownership check);
 *  - sender verification: the tx must have been sent FROM the wallet's address
 *    (verifyEvmTxFrom checks `from` directly - the prior code relied on
 *    verifyEvmContractCall and accepted tx_to_mismatch, which silently discarded
 *    the sender check because `to` is evaluated before `from`);
 *  - hash chain: the PE is written via the atomic helper (Security Invariant #5),
 *    never a raw pe_history write.
 *
 * Swap amounts remain caller-asserted (we do not parse router logs) and are
 * flagged amounts_verified:false, bound to a tx we verified the wallet sent.
 */
export async function recordAgentSwapPE(
  deps: RouterDeps,
  params: RecordAgentSwapParams,
): Promise<RecordAgentSwapResult> {
  const { walletId, agentWallet, txHash, fromToken, toToken, fromAmount, toAmount, feeAmount } = params;

  // Ownership guard - matches every other authenticated handler in this file.
  if (!agentWallet || agentWallet.id !== walletId) {
    return { ok: false, status: 403, error: 'Access denied - wallet_id mismatch' };
  }

  // Idempotency (F37): claim a tx_hash-keyed marker BEFORE recording anything,
  // mirroring the transfer/record (agent_tx_records) and burn/record
  // (pvt_burn_records) siblings in this file. Without it, ONE real base tx (the
  // verifier only checks `from`, so any self-send qualifies) could be replayed
  // into thousands of agent_token_swap PEs, each a fresh pe_id that increments
  // agent_wallets.pe_count — inflating the bond trust discount (real money),
  // governance score, and leaderboard rank. Swap is base-only (chainId 8453),
  // so the chain segment is fixed 'base'. The marker is keyed by
  // (chain, txHash, walletId): the verifier already binds the tx to the caller's
  // own address, and keying in walletId keeps this collection independent of the
  // transfer/record marker for the same tx_hash.
  const claimId = crypto
    .createHash('sha256')
    .update(`base:${txHash.toLowerCase()}:${walletId}`)
    .digest('hex');
  const claimRef = deps.db.collection('swap_record_claims').doc(claimId);
  try {
    await claimRef.create({
      tx_hash: txHash,
      chain: 'base',
      wallet_id: walletId,
      status: 'pending',
      created_at: Date.now(),
    });
  } catch (err) {
    // Firestore ALREADY_EXISTS (code 6): this tx_hash was already recorded (or
    // is in flight) for this wallet. Return the original pe_id rather than
    // sealing a second PE.
    if ((err as { code?: number }).code === 6) {
      const existing = (await claimRef.get()).data();
      if (existing?.pe_id) {
        return { ok: true, peId: String(existing.pe_id), idempotent: true };
      }
      return { ok: false, status: 409, error: 'A swap record for this tx_hash is already in progress' };
    }
    throw err;
  }

  // We own the marker. Verify on-chain; release the marker on any pre-mint
  // failure so a corrected retry can proceed.
  //
  // Verify the tx exists, succeeded, and was sent FROM the wallet's address.
  // Do NOT reuse verifyEvmContractCall + accept tx_to_mismatch: that checks `to`
  // before `from`, so accepting tx_to_mismatch discards the sender check.
  try {
    const verification = await verifyEvmTxFrom({
      chainId: 8453,
      txHash,
      expectedFrom: agentWallet.address,
    });
    if (!verification.ok) {
      await claimRef.delete().catch(() => {});
      return { ok: false, status: 400, error: 'On-chain swap verification failed', reason: verification.reason };
    }

    // Record through the canonical atomic helper (prev_hash/hash + accrual).
    // Stamp the marker to 'recorded' + pe_id INSIDE the PE transaction so the
    // PE and its idempotency marker commit together or neither does (the
    // transfer/record #21 lost-update fix).
    const swapObservation = chainRecordEnqueue(deps.db, { txHash, walletId, source: 'swap_record' });
    const swapPE = await generatePEAtomic(deps, {
      walletId,
      agentId: agentWallet.agent_id,
      actorAddress: agentWallet.address,
      actionType: 'agent_token_swap',
      metadata: {
        from_token: String(fromToken).toUpperCase(),
        to_token: String(toToken).toUpperCase(),
        from_amount: fromAmount,
        to_amount: toAmount,
        fee_amount: feeAmount || '0',
        tx_hash: txHash,
        chain: 'base',
        amounts_verified: false,
      },
      // queue the tx for the chain-record lane in THIS transaction. The
      // lane re-reads the transaction from the chain and mints the swap (this
      // record PE itself stays record_only); the hash is a pointer, not evidence.
      atomicEntityPrecondition: (txn) => swapObservation.read(txn),
      atomicEntityWrite: (txn, peId) => {
        txn.set(claimRef, { status: 'recorded', pe_id: peId }, { merge: true });
        swapObservation.write(txn, peId);
      },
    });

    return { ok: true, peId: swapPE.peId };
  } catch (err) {
    // generatePEAtomic threw. The marker stamp rides the PE tip transaction, so
    // re-read to tell whether it COMMITTED before the throw: a pe_id on the
    // marker ⇒ the PE + stamp committed and only a post-commit step threw
    // (return it idempotently, never delete a durable marker); no pe_id ⇒ the
    // transaction rolled back (release the marker for a retry).
    const after = (await claimRef.get().catch(() => undefined))?.data();
    if (after?.pe_id) {
      return { ok: true, peId: String(after.pe_id), idempotent: true };
    }
    await claimRef.delete().catch(() => {});
    throw err;
  }
}

// ===========================================================================
// Verified raw transfer PE (closes the slice-1 self-asserted gap)
// ===========================================================================

const TRANSFER_CHAIN_IDS: Record<string, number> = { base: 8453, arbitrum: 42161, optimism: 10 };
type TransferCurrency = 'usdc' | 'usdt' | 'pvt' | 'native';

/** Inputs for recording a verified raw transfer PE. */
export interface RecordAgentTransferParams {
  walletId: string;
  /** Authenticated wallet from req.agentWallet (ownership checked here). */
  agentWallet: AgentWalletDocument | undefined;
  txHash: string;
  chain: string;
  currency: TransferCurrency;
  /** Recipient of the transfer (the ERC-20 `to`, or the native ETH recipient). */
  to: string;
  /** Atomic units as an integer string: token atomic for ERC-20, wei for native. */
  amountAtomic: string;
}

export type RecordAgentTransferResult =
  | { ok: true; peId: string; verified: boolean; idempotent?: boolean }
  | { ok: false; status: number; error: string; reason?: string };

/**
 * Convert a 6-decimal atomic integer string to a USD float (USDC/USDT) for
 * verifyTransfer, which re-derives atomic via usdcToAtomic. The atomic->float->
 * atomic round-trip is EXACT below ~1e16 atomic (~$10 billion) - orders of
 * magnitude above the Commons institutions launch caps. Above that, float precision could
 * cause a false REJECT (never a false accept - a non-matching atomic just fails
 * the exact Transfer-log compare, so no wrong-amount PE can be minted). PVT
 * avoids this entirely by carrying a BigInt wei amount end-to-end.
 */
function atomic6ToUsd(amountAtomic: string): number {
  const a = BigInt(amountAtomic);
  const whole = a / 1_000_000n;
  const frac = a % 1_000_000n;
  return Number(whole) + Number(frac) / 1_000_000;
}

/**
 * Verify a RAW on-chain transfer the agent broadcast itself, then record a
 * VERIFIED Provenance Envelope. This is the verified counterpart to the SDK's
 * slice-1 self-asserted reportAction path:
 *  - ownership: only the authenticated wallet may record for wallet_id;
 *  - on-chain verification:
 *      ERC-20 (usdc/usdt/pvt) -> verifyTransfer asserts from + to + amount on the
 *        token's Transfer log (fully verified);
 *      native ETH -> verifyEvmNativeTransfer (FIX B) asserts from + to + value via
 *        eth_getTransactionByHash (tx.from / tx.to / tx.value), so native transfers
 *        are now fully verified — sender, recipient, and value are all confirmed
 *        on-chain, the same as the ERC-20 branch (sender_verified / recipient_verified /
 *        value_verified are all set true);
 *  - idempotency: a deterministic agent_tx_records marker keyed by
 *    sha256(chain:txHash:walletId) is claimed via create() BEFORE recording, so
 *    the same broadcast cannot mint/record (or double-accrue) twice. A repeat
 *    call returns the original pe_id (idempotent), never a second PE.
 */
export async function recordAgentTransferPE(
  deps: RouterDeps,
  params: RecordAgentTransferParams,
): Promise<RecordAgentTransferResult> {
  const { walletId, agentWallet, txHash, chain, currency, to, amountAtomic } = params;

  // Ownership guard - matches every other authenticated handler in this file.
  if (!agentWallet || agentWallet.id !== walletId) {
    return { ok: false, status: 403, error: 'Access denied - wallet_id mismatch' };
  }
  const chainId = TRANSFER_CHAIN_IDS[chain];
  if (!chainId) {
    return { ok: false, status: 400, error: "chain must be 'base', 'arbitrum', or 'optimism'" };
  }
  if (currency !== 'usdc' && currency !== 'usdt' && currency !== 'pvt' && currency !== 'native') {
    return { ok: false, status: 400, error: "currency must be 'usdc', 'usdt', 'pvt', or 'native'" };
  }

  // Idempotency: claim a tx_hash-keyed marker before doing anything that mints.
  const markerId = crypto
    .createHash('sha256')
    .update(`${chain}:${txHash.toLowerCase()}:${walletId}`)
    .digest('hex');
  const markerRef = deps.db.collection('agent_tx_records').doc(markerId);
  try {
    await markerRef.create({
      tx_hash: txHash,
      chain,
      currency,
      wallet_id: walletId,
      status: 'pending',
      created_at: Date.now(),
    });
  } catch (err) {
    // Firestore ALREADY_EXISTS (code 6): this tx_hash was already recorded (or
    // is in flight). Return the original pe_id rather than minting a second PE.
    if ((err as { code?: number }).code === 6) {
      const existing = (await markerRef.get()).data();
      if (existing?.pe_id) {
        return { ok: true, peId: String(existing.pe_id), verified: Boolean(existing.verified), idempotent: true };
      }
      return { ok: false, status: 409, error: 'A record for this tx_hash is already in progress' };
    }
    throw err;
  }

  // We own the marker. Verify on-chain; release the marker on any failure
  // BEFORE the PE is minted so a corrected retry can proceed. The pe_id is
  // stamped onto the marker INSIDE the PE transaction (#21, atomicEntityWrite
  // below), so a committed PE always carries its pe_id on the marker and a
  // thrown generatePEAtomic means nothing committed - either way the marker
  // never gets stuck 'pending' with a real PE behind it.
  try {
    let verified: boolean;
    if (currency === 'native') {
      // FIX B: verify the native value + recipient (eth_getTransactionByHash
      // exposes tx.to / tx.value), not just the sender. Native PEs are now
      // fully verified, same as the ERC-20 branch.
      const v = await verifyEvmNativeTransfer({
        chainId,
        txHash,
        expectedFrom: agentWallet.address,
        expectedTo: to,
        expectedAmountWei: BigInt(amountAtomic),
      });
      if (!v.ok) {
        await markerRef.delete().catch(() => {});
        return { ok: false, status: 400, error: 'On-chain transfer verification failed', reason: v.reason };
      }
      // Native: sender + recipient + value all confirmed on-chain.
      verified = true;
    } else {
      const amountFields =
        currency === 'pvt'
          ? { expectedAmountPvtWei: BigInt(amountAtomic) }
          : currency === 'usdt'
            ? { expectedAmountUsdt: atomic6ToUsd(amountAtomic) }
            : { expectedAmountUsdc: atomic6ToUsd(amountAtomic) };
      const v = await verifyTransfer({
        chain: chain as SupportedVerificationChain,
        txHash,
        expectedFrom: agentWallet.address,
        expectedTo: to,
        currency,
        ...amountFields,
      });
      if (!v.ok) {
        await markerRef.delete().catch(() => {});
        return { ok: false, status: 400, error: 'On-chain transfer verification failed', reason: v.reason };
      }
      verified = true;
    }

    // Prompt 2: the recipient address and the settling transaction are PUBLIC,
    // resolvable origins. The tx-verifier re-checked them on-chain → chain_watcher
    // is the voucher (witnessed:true only when the on-chain verification passed).
    const transferWitness = verified ? chainWatcherWitness(`chain:${chain}`) : null;
    const transferOrigins = [
      resolvableOrigin(`evm:${to.toLowerCase()}`, transferWitness),
      resolvableOrigin(`evmtx:${chain}:${txHash.toLowerCase()}`, transferWitness),
    ];
    // the transfer is queued for the chain-record lane in the SAME transaction
    // as this record PE (which itself stays record_only), on every chain the lane
    // reads (Base, Arbitrum One, OP Mainnet). The lane re-reads the transaction
    // from that chain and mints the send; nothing here (recipient, amount,
    // currency) is read by it.
    const transferObservation = chainRecordEnqueue(deps.db, { txHash, walletId, source: 'transfer_record', chainId });
    const pe = await generatePEAtomic(deps, {
      walletId,
      agentId: agentWallet.agent_id,
      actorAddress: agentWallet.address,
      actionType: currency === 'native' ? 'agent_native_transfer' : 'agent_token_transfer',
      input_origins: transferOrigins,
      // Fact-base fixes item 4 (2026-09-23): when the tx-verifier re-read the settlement on chain,
      // that verification witnesses the recipient and the settling transaction it confirmed.
      ...(verified
        ? { relayObservation: { witness: relayObservationWitness(RELAY_WITNESS_CHAIN_WATCHER, `chain:${chain}`), derivedOrigins: transferOrigins } }
        : {}),
      metadata: {
        tx_hash: txHash,
        chain,
        currency,
        recipient: to,
        amount_atomic: amountAtomic,
        // Both branches now confirm sender + recipient + value on-chain:
        // ERC-20 via the Transfer log; native via tx.to / tx.value (FIX B).
        verified,
        sender_verified: true,
        value_verified: true,
        recipient_verified: true,
      },
      // #21: stamp the idempotency marker to 'recorded' + pe_id INSIDE the PE
      // transaction (WS4 atomicEntityWrite). Previously the marker was stamped
      // in a SEPARATE post-mint update(); a double transient Firestore failure
      // there (the in-try update AND the best-effort catch re-stamp) left the
      // marker stuck 'pending' with no pe_id, so a later retry of the same
      // tx_hash got a PERMANENT 409 'already in progress' even though the PE was
      // minted (the pe_id was unrecoverable). Riding the stamp in the tip
      // transaction removes that lost-update window: PE + pe_id commit together,
      // or neither does.
      ...(transferObservation ? { atomicEntityPrecondition: transferObservation.read } : {}),
      atomicEntityWrite: (txn, peId) => {
        txn.set(markerRef, { status: 'recorded', pe_id: peId, verified }, { merge: true });
        transferObservation?.write(txn, peId);
      },
    });

    return { ok: true, peId: pe.peId, verified };
  } catch (err) {
    // generatePEAtomic threw. The marker stamp rides the PE tip transaction, so
    // re-read to tell whether that transaction COMMITTED before the throw:
    //  - marker now carries a pe_id ⇒ the PE + stamp committed and only a
    //    post-commit step threw (e.g. peBuffer.enqueue during shutdown). Do NOT
    //    delete a durable marker (that would let a retry mint a SECOND PE);
    //    return the committed pe_id idempotently.
    //  - no pe_id ⇒ the transaction rolled back (nothing committed); release the
    //    marker so a corrected / contention retry can proceed.
    const after = (await markerRef.get().catch(() => undefined))?.data();
    if (after?.pe_id) {
      return { ok: true, peId: String(after.pe_id), verified: Boolean(after.verified) };
    }
    await markerRef.delete().catch(() => {});
    throw err;
  }
}

export interface RecordAgentBurnParams {
  walletId: string;
  /** Authenticated wallet from req.agentWallet (ownership checked here). */
  agentWallet: AgentWalletDocument | undefined;
  txHash: string;
  chain: string;
  /** Atomic 18-decimal PVT units burned, as an integer string (wei-style). */
  amountAtomic: string;
  /** hold the request open up to this long for the burn to be mined (see `recordFirstPartyBurn`). */
  waitMs?: number;
}

export type RecordAgentBurnResult =
  | { ok: true; burnId: string; verified: boolean; idempotent?: boolean; finality?: 'provisional' | 'final' }
  | { ok: false; status: number; error: string; reason?: string };

/** Collection holding VERIFIED PVT burn records — the substrate the work package burn
 * products (name registry, vouch, pledges, subscriptions, standing export) bind
 * their resource claim to via `burn_id`. Records only; mints nothing. */
export const PVT_BURN_RECORDS_COLLECTION = 'pvt_burn_records';

/**
 * work package burn substrate — the demand-side counterpart to recordAgentTransferPE.
 * Verify a RAW on-chain PVT burn the agent broadcast itself (a `Transfer(from,
 * 0x0, amount)` on the PVT token), then RECORD the verified burn to the
 * `pvt_burn_records` collection.
 *
 * - ownership: only the authenticated wallet may record for wallet_id;
 * - verification: verifyEvmPvtBurn asserts sender + zero-address destination +
 * exact amount on the PVT token's Transfer log. The destination is PINNED to
 * 0x0, so a self-send (from == to) can never pass as a burn;
 * - idempotency: a deterministic marker keyed by sha256(chain:txHash) is claimed
 * via create() BEFORE verifying, so the same burn cannot be recorded twice —
 * a repeat returns the original burn_id. Keying by (chain, txHash) — not by
 * wallet — dedups the GLOBAL burn tx, so one burn can never be claimed by two
 * wallets (the verifier already binds the burn to `expectedFrom`, i.e. the
 * caller's own address).
 *
 * DELIBERATELY NOT A PE (mirrors the O7 wants board): emitting a
 * `pvt_burned_voluntary` PE from this scanned file would add a static emitter to
 * the -pinned action-policy matrix (`static_emitter_files`), moving its
 * declared `content_sha256` `8ed81e2a…` (re-issue) — a stop-list #3 change. The burn is
 * already provenance-anchored by its on-chain tx; the products that CONSUME a
 * burn record their own outcome (the claimed name/vouch/pledge). So the burn
 * substrate records a plain, verified burn row and mints nothing.
 */
export async function recordAgentBurn(
  deps: RouterDeps,
  params: RecordAgentBurnParams,
): Promise<RecordAgentBurnResult> {
  const { walletId, agentWallet, txHash, chain, amountAtomic } = params;

  if (!agentWallet || agentWallet.id !== walletId) {
    return { ok: false, status: 403, error: 'Access denied - wallet_id mismatch' };
  }
  if (!TRANSFER_CHAIN_IDS[chain]) {
    return { ok: false, status: 400, error: "chain must be 'base', 'arbitrum', or 'optimism'" };
  }
  // ONE recorder for agents and humans (`core/presentation/burn-record.ts`). The agent
  // path differs only in binding `expectedFrom` to the agent's sovereign address; the verifier,
  // the (chain, txHash) idempotency, the cross-wallet 409 (F10), the optional wait for the burn to
  // be mined, and acceptance at inclusion with its finality check are the shared
  // recorder's.
  return recordFirstPartyBurn(deps, {
    walletId,
    address: agentWallet.address,
    ownerKind: 'agent',
    ownerId: agentWallet.agent_id,
    txHash,
    chain,
    amountAtomic,
    waitMs: params.waitMs,
  });
}

/** The `pvt9` block the balances endpoint returns for the on-chain read. */
export interface Pvt9BalanceRead {
  /** Whole-PVT decimal string (18-dp formatted), or null on a read failure. */
  balance: string | null;
  available: boolean;
  /** Present only on failure — the fail-VISIBLE reason. */
  reason?: string;
}

/**
 * Read a wallet's PVT9 balance (18 decimals) fail-VISIBLE (/ audit §6).
 *
 * The prior endpoint hardcoded `balance:null` / `PVT9_UNCONFIGURED` against a
 * kernel that holds real supply (1,185+ PVT) — reporting "unconfigured" for a
 * token that is very much configured. The token IS live, so a null here means the
 * RPC read FAILED (`PVT9_READ_FAILED`), never that PVT9 is unconfigured, and never
 * a silent zero. `balanceOf` is injected (the caller binds it to the on-chain
 * contract) so the read + its fail-visible contract are unit-testable without a
 * live provider.
 */
export async function readPvt9Balance(
  balanceOf: (owner: string) => Promise<bigint>,
  walletAddress: string,
): Promise<Pvt9BalanceRead> {
  try {
    const raw = await balanceOf(walletAddress);
    return { balance: ethers.formatUnits(raw, 18), available: true };
  } catch (pvtErr) {
    console.error('[AgentWallet] PVT9 balance read failed:', pvtErr);
    return { balance: null, available: false, reason: 'PVT9_READ_FAILED' };
  }
}

/**
 * THE `invite_accepted` emitter — one PE on the HUMAN's chain recording that an
 * agent's link to them formed. Two callers, one function: the human's in-app
 * Accept (`POST /accept-invite`) and a fleet-code link at request-link
 * (routes/agent-invite.ts). Keeping the single emission site in
 * this file keeps the action-policy matrix's static-emitter scan unchanged.
 *
 * Policy-sealed record-only, symmetric with the agent_linked_to_human /
 * agent_unlinked_from_human link PEs: a link is ignition, not earnable work (the
 * compatibility zero below is not economic authority). The PE id derives from
 * the invite id, so a retry reuses it and can never create a second chain event.
 * `extraMetadata` is appended AFTER the fixed keys, so the Accept path's sealed
 * metadata is byte-identical to before.
 */
export async function recordInviteAcceptedPE(
  deps: RouterDeps,
  params: {
    humanWalletId: string;
    humanUserId: string;
    humanAddress: string | null;
    inviteId: string;
    agentWalletId: string;
    agentDisplayName: string;
    agentAddress: string;
    acceptedAt: number;
    extraMetadata?: Record<string, string>;
  },
): Promise<void> {
  await generatePEAtomic(deps, {
    walletId: params.humanWalletId,
    agentId: params.humanUserId,
    actorAddress: params.humanAddress || '',
    actionType: 'invite_accepted',
    metadata: {
      invite_id: params.inviteId,
      agent_wallet_id: params.agentWalletId,
      agent_display_name: params.agentDisplayName,
      signing_bonus_pvt: 0,
      no_pvt: 'link_is_ignition_not_earning',
      ...(params.extraMetadata ?? {}),
    },
    counterpartyAddress: params.agentAddress,
    fixedEstimatedPVT: 0,
    peIdOverride: `pe_invite_accepted_${crypto.createHash('sha256')
      .update(params.inviteId, 'utf8')
      .digest('hex')}`,
    timestampOverride: params.acceptedAt,
  });
}

export function createAgentWalletRouter(deps: RouterDeps): Router {
  const { db, cache, deriveAddressFromPublicKey } = deps;
  const router = Router();
  const authenticateAgent = createAgentAuthMiddleware(db);

  // =========================================================================
  // GET /challenge - Issue a proof-of-possession challenge
  //
  // The agent generates its own secp256k1 keypair and calls this endpoint
  // with the public key it intends to register. The relay returns a random
  // challenge bound to that key. The agent signs the challenge bytes and
  // submits the signature on POST /create. This proves the agent controls
  // the private key without ever transmitting it.
  // =========================================================================
  router.get('/challenge', async (req: Request, res: Response) => {
    try {
      const publicKey = typeof req.query.public_key === 'string' ? req.query.public_key : undefined;
      if (!publicKey) {
        res.status(400).json({ error: 'public_key query parameter is required' });
        return;
      }
      const registrationId = typeof req.query.registration_id === 'string'
        ? req.query.registration_id
        : '';
      const agentId = typeof req.query.agent_id === 'string' ? req.query.agent_id : '';
      if (!AGENT_WALLET_REGISTRATION_ID.test(registrationId)) {
        res.status(400).json({
          error: 'registration_id query parameter is required and must be durably retained before this request',
        });
        return;
      }
      if (!agentId || agentId.length > 200 || !/^[a-zA-Z0-9._-]+$/.test(agentId)) {
        res.status(400).json({ error: 'agent_id query parameter is required' });
        return;
      }

      // Validate format: 64-byte uncompressed secp256k1, hex, no 04 prefix
      const cleaned = normalizeAgentWalletPublicKey(publicKey);
      if (cleaned.length !== 128 || !/^[0-9a-f]+$/.test(cleaned)) {
        res.status(400).json({ error: 'public_key must be 64-byte uncompressed secp256k1 hex' });
        return;
      }

      // IP rate limit: 10/min, 100/hr (mirrors /create)
      const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
      const minuteLimit = await cache.checkRateLimit(`rl:aw-pop-min:${clientIp}`, 10, 60);
      if (!minuteLimit.allowed) {
        res.status(429).json({ error: 'Rate limit exceeded.', retry_after: minuteLimit.retryAfter });
        return;
      }
      const hourLimit = await cache.checkRateLimit(`rl:aw-pop-hr:${clientIp}`, 100, 3600);
      if (!hourLimit.allowed) {
        res.status(429).json({ error: 'Rate limit exceeded.', retry_after: hourLimit.retryAfter });
        return;
      }

      try {
        const registrationSnap = await db.collection(AGENT_WALLET_REGISTRATION_COLLECTION)
          .doc(agentWalletRegistrationDocumentId(registrationId))
          .get();
        let credentialRecoveryGeneration: number | null = null;
        if (registrationSnap.exists) {
          const registration = registrationSnap.data() as Partial<AgentWalletRegistrationDocument>;
          // Recovery may present the wallet's CURRENT key — the birth key, or the
          // ROTATED key after a key rotation (the registration doc keeps the
          // immutable birth key). Accept either as a lightweight pre-check; the
          // full rotation-evidence proof runs later in
          // prevalidateAgentWalletRegistrationRecovery.
          let currentPublicKey: string | undefined;
          if (typeof registration.wallet_id === 'string') {
            const walletSnap = await db.collection('agent_wallets')
              .doc(registration.wallet_id).get();
            const livePublicKey = walletSnap.data()?.public_key;
            if (typeof livePublicKey === 'string') currentPublicKey = livePublicKey.toLowerCase();
          }
          const keyMatches = registration.public_key?.toLowerCase() === cleaned
            || currentPublicKey === cleaned;
          if (registration.schema_version !== 'agent-wallet-registration/v1'
            || registration.registration_id !== registrationId
            || registration.agent_id !== agentId
            || !keyMatches
            || !Number.isSafeInteger(registration.credential_recovery_generation)
            || (registration.credential_recovery_generation as number) < 0) {
            res.status(409).json({ error: 'agent_wallet_registration_identity_mismatch' });
            return;
          }
          credentialRecoveryGeneration = registration.credential_recovery_generation as number;
        }
        const challenge = await issuePopChallenge(cache, cleaned, {
          registration_id: registrationId,
          agent_id: agentId,
          credential_recovery_generation: credentialRecoveryGeneration,
        });
        // / L381: a caller that will create with a connection code may learn its BIRTH anchor
        // now, so a hosted (MCP) agent seals its key before `wallet_create` and escrows in the same
        // call. A preview only, read-only and never consuming the code: the create response names
        // the anchor that is recorded and accepted. Parentless only (a child's custodian is resolved
        // from its parent at create).
        const previewCode = typeof req.query.connection_token === 'string' && req.query.connection_token.trim().length > 0
          ? req.query.connection_token.trim()
          : null;
        const previewAnchor = previewCode === null
          ? null
          : (await resolveBirthRecoveryAnchor({ db }, {
            connectionToken: previewCode, isChild: false, inheritedHumanUserId: null,
          })).pubkey;
        // `registration_exists`: whether this registration id is already on record. An installer
        // whose earlier attempt left a pending registration behind reads it to choose between
        // resuming that exact request (the relay holds it, so its fingerprint is binding) and
        // rebinding an unsent one to the current run's code. It names only a registration id the
        // caller already holds with its key and agent id — nothing a stranger can enumerate.
        const body = { ...challenge, registration_exists: registrationSnap.exists };
        res.status(200).json(previewAnchor === null ? body : { ...body, recovery_anchor_pubkey: previewAnchor });
      } catch (err) {
        if (err instanceof Error && err.message === 'CACHE_UNAVAILABLE') {
          res.status(503).json({ error: 'Challenge service unavailable. Try again shortly.' });
          return;
        }
        throw err;
      }
    } catch (error) {
      console.error('[AgentWallet] Challenge issue error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =========================================================================
  // GET /parent-challenge - issue a PoP challenge for parent-wallet authorization
  //
  // HIGH-2 (Wave 4): when a child wallet is created with parent_wallet_id,
  // the creator must prove the parent authorised it. Without this gate,
  // anyone could attach themselves to a victim wallet's parent chain and
  // inherit linked_human_* fields (the audit reproducer).
  //
  // The challenge is bound to {parent_wallet_id, child_address} and the
  // parent's registered public_key. The parent signs the challenge with
  // its registered secret key and the SDK forwards
  // parent_proof_of_authorization on POST /create.
  // =========================================================================
  router.get('/parent-challenge', async (req: Request, res: Response) => {
    try {
      const parentWalletId = typeof req.query.parent_wallet_id === 'string'
        ? req.query.parent_wallet_id
        : '';
      const childAddress = typeof req.query.child_address === 'string'
        ? req.query.child_address
        : '';
      if (!parentWalletId || !childAddress) {
        res.status(400).json({ error: 'parent_wallet_id and child_address are required' });
        return;
      }
      const parentDoc = await db.collection('agent_wallets').doc(parentWalletId).get();
      if (!parentDoc.exists) {
        res.status(404).json({ error: 'parent_wallet_id not found' });
        return;
      }
      const parent = parentDoc.data() as AgentWalletDocument;
      if (parent.status !== 'active') {
        res.status(400).json({ error: 'parent_wallet_id is not active' });
        return;
      }
      if (typeof parent.public_key !== 'string' || parent.public_key.length === 0) {
        res.status(400).json({ error: 'parent_wallet has no registered public_key' });
        return;
      }
      try {
        const challenge = await issueClaimsPopChallenge(cache, {
          purpose: 'parent_authorization',
          public_key_hex: parent.public_key,
          claims: {
            parent_wallet_id: parentWalletId,
            child_address: childAddress.toLowerCase(),
          },
        });
        res.status(200).json(challenge);
      } catch (err) {
        if (err instanceof Error && err.message === 'CACHE_UNAVAILABLE') {
          res.status(503).json({ error: 'Challenge service unavailable. Try again shortly.' });
          return;
        }
        throw err;
      }
    } catch (error) {
      console.error('[AgentWallet] Parent challenge error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =========================================================================
  // POST /create - Create agent wallet (no auth, rate limited)
  //
  // SECURITY (Phase 2.8): Requires proof-of-possession of an
  // agent-generated secp256k1 keypair. The agent must:
  //   1. Generate the keypair locally.
  //   2. Call GET /challenge?public_key=... to receive a challenge.
  //   3. Sign the challenge bytes with the matching private key.
  //   4. POST { public_key, challenge_id, signature, ... }.
  //
  // The relay never sees the private key. There is no fallback path.
  //
  // HIGH-2 (Wave 4): when parent_wallet_id is set, the creator must
  // ALSO present parent_proof_of_authorization (PoP from the parent
  // wallet) over a /parent-challenge issued challenge. Without this,
  // the creator inherits parent.linked_human_* via a free-form
  // parent_wallet_id field.
  // =========================================================================
  router.post('/create', async (req: Request, res: Response) => {
    try {
      const body = req.body as CreateAgentWalletRequest;
      const registrationChannel = body.registration_channel;
      if (registrationChannel !== undefined
        && !AGENT_WALLET_REGISTRATION_CHANNELS.includes(registrationChannel)) {
        res.status(400).json({ error: 'invalid_registration_channel' });
        return;
      }

      // --- Validate inputs ---
      if (!body.registration_id
        || typeof body.registration_id !== 'string'
        || !AGENT_WALLET_REGISTRATION_ID.test(body.registration_id)) {
        res.status(400).json({
          error: 'registration_id is required (16-128 canonical characters) and must be durably retained before requesting a challenge',
        });
        return;
      }
      if (!body.agent_name || typeof body.agent_name !== 'string' || body.agent_name.length > 100) {
        res.status(400).json({ error: 'agent_name is required (string, max 100 chars)' });
        return;
      }
      // F53/F56: reject markup in the display name at the source. It is later
      // interpolated into Provian-branded invite emails (which also HTML-escape
      // it); refusing `<`/`>` here stops the phishing payload from ever being
      // stored as the wallet's display_name.
      if (/[<>]/.test(body.agent_name)) {
        res.status(400).json({ error: 'agent_name must not contain markup characters (< or >)' });
        return;
      }
      if (!body.agent_id || typeof body.agent_id !== 'string' || body.agent_id.length > 200) {
        res.status(400).json({ error: 'agent_id is required (string, max 200 chars)' });
        return;
      }
      if (!body.platform || typeof body.platform !== 'string' || body.platform.length > 50) {
        res.status(400).json({ error: 'platform is required (string, max 50 chars)' });
        return;
      }
      // Constitution acceptance is optional for agent wallet creation. The
      // observation timestamp is nevertheless required because it is part of
      // the exact retry fingerprint and must be caller-pinned before the first
      // request; a Date.now() fallback would change after a lost response.
      // An omitted version defaults to the Network Constitution for a new
      // registration; for a registration_id already on record it resolves,
      // below, to the version that record sealed (retry identity).
      const constitutionVersionOmitted = body.constitution_version === undefined;
      let constitutionVersion = constitutionVersionOmitted
        ? NETWORK_CONSTITUTION_VERSION
        : body.constitution_version;
      if (typeof constitutionVersion !== 'string'
        || constitutionVersion.length === 0
        || constitutionVersion.length > 100) {
        res.status(400).json({ error: 'constitution_version must be a non-empty string (max 100 chars)' });
        return;
      }
      if (typeof body.constitution_accepted_at !== 'string'
        || body.constitution_accepted_at.length === 0) {
        res.status(400).json({
          error: 'constitution_accepted_at is required and must be durably retained for retry-safe registration',
        });
        return;
      }
      const constitutionAcceptedAt = Date.parse(body.constitution_accepted_at);
      if (!Number.isFinite(constitutionAcceptedAt)
        || constitutionAcceptedAt < 0
        || constitutionAcceptedAt > Date.now() + AGENT_WALLET_REGISTRATION_CLOCK_SKEW_MS) {
        res.status(400).json({
          error: 'constitution_accepted_at must be a non-future ISO timestamp (5 minute clock skew allowed)',
        });
        return;
      }
      if (body.constitution_accepted !== undefined
        && typeof body.constitution_accepted !== 'boolean') {
        res.status(400).json({ error: 'constitution_accepted must be a boolean when provided' });
        return;
      }

      // Validate agent_id format: alphanumeric, hyphens, underscores, dots
      if (!/^[a-zA-Z0-9._-]+$/.test(body.agent_id)) {
        res.status(400).json({ error: 'agent_id must be alphanumeric (hyphens, underscores, dots allowed)' });
        return;
      }

      // Validate callback_url if provided
      if (body.callback_url !== undefined && body.callback_url !== null) {
        if (typeof body.callback_url !== 'string' || !body.callback_url.startsWith('https://')) {
          res.status(400).json({ error: 'callback_url must be an HTTPS URL' });
          return;
        }
      }

      // `agent_session_id` (the retired relay-session binding) is accepted
      // from older SDK builds and binds NOTHING — but it still enters the retry
      // fingerprint exactly as sent (string, else null) so pre-retirement
      // registrations keep their byte-identical fingerprint and can still recover.
      if (body.parent_wallet_id !== undefined
        && (typeof body.parent_wallet_id !== 'string'
          || !/^wallet_aw_[A-Za-z0-9-]{8,128}$/.test(body.parent_wallet_id))) {
        res.status(400).json({ error: 'parent_wallet_id must be a canonical agent wallet ID' });
        return;
      }
      if (body.parent_proof_of_authorization !== undefined && body.parent_wallet_id === undefined) {
        res.status(400).json({ error: 'parent_proof_of_authorization requires parent_wallet_id' });
        return;
      }

      const suppliedConnectionToken = typeof body.connection_token === 'string'
        && body.connection_token.trim().length > 0
        ? body.connection_token.trim()
        : null;
      // Validate chains if provided. An explicit null is malformed rather than
      // another spelling of omission: retries must bind one canonical request.
      const chains = body.chains === undefined ? ['base'] : body.chains;
      if (!Array.isArray(chains)
        || chains.length === 0
        || chains.some(c => typeof c !== 'string' || c.length === 0)
        || new Set(chains).size !== chains.length) {
        res.status(400).json({ error: 'chains must be a non-empty unique array of non-empty strings' });
        return;
      }

      // BLOCKER-3: full_governance is derived, never accepted from the
      // body. Resolve it before PoP so the stable request fingerprint can bind
      // the exact original governance payload for ambiguous retries.
      const rawGovernance = body.governance as unknown;
      const governanceKeys = [
        'pe_coverage_enabled',
        'attestation_enabled',
        'human_oversight_enabled',
        'spending_limits_enabled',
      ];
      if (rawGovernance !== undefined
        && (typeof rawGovernance !== 'object'
          || rawGovernance === null
          || Array.isArray(rawGovernance)
          || Object.keys(rawGovernance).some((key) => !governanceKeys.includes(key))
          || Object.values(rawGovernance).some((value) => typeof value !== 'boolean'))) {
        res.status(400).json({
          error: 'governance must contain only supported boolean settings; full_governance is derived',
        });
        return;
      }
      const governanceInput = (rawGovernance ?? {}) as Partial<AgentWalletDocument['governance']>;
      const governance = {
        pe_coverage_enabled: governanceInput.pe_coverage_enabled ?? false,
        attestation_enabled: governanceInput.attestation_enabled ?? false,
        human_oversight_enabled: governanceInput.human_oversight_enabled ?? false,
        spending_limits_enabled: governanceInput.spending_limits_enabled ?? false,
        full_governance: false,
      };

      // PoP fields are required (Phase 2.8). Validate format before consulting cache.
      if (!body.public_key || typeof body.public_key !== 'string') {
        res.status(400).json({ error: 'public_key is required' });
        return;
      }
      const submittedPublicKey = normalizeAgentWalletPublicKey(body.public_key);
      if (submittedPublicKey.length !== 128 || !/^[0-9a-f]+$/.test(submittedPublicKey)) {
        res.status(400).json({ error: 'public_key must be 64-byte uncompressed secp256k1 hex' });
        return;
      }
      if (!body.challenge_id || typeof body.challenge_id !== 'string') {
        res.status(400).json({ error: 'challenge_id is required (call GET /challenge first)' });
        return;
      }
      if (!body.signature || typeof body.signature !== 'string' || !/^[0-9a-f]+$/i.test(body.signature)) {
        res.status(400).json({ error: 'signature is required (hex-encoded ECDSA over the challenge bytes)' });
        return;
      }

      // --- Rate limit: 10/min, 100/hr per IP ---
      const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
      const minuteLimit = await cache.checkRateLimit(
        `rl:aw-create:min:${clientIp}`, 10, 60,
      );
      if (!minuteLimit.allowed) {
        res.status(429).json({
          error: 'Rate limit exceeded. Max 10 wallet creations per minute.',
          retry_after: minuteLimit.retryAfter,
        });
        return;
      }
      const hourLimit = await cache.checkRateLimit(
        `rl:aw-create:hr:${clientIp}`, 100, 3600,
      );
      if (!hourLimit.allowed) {
        res.status(429).json({
          error: 'Rate limit exceeded. Max 100 wallet creations per hour.',
          retry_after: hourLimit.retryAfter,
        });
        return;
      }

      // Firestore fallback rate limit when Redis is unavailable (fail-closed
      // for unauthenticated endpoint). Re-audit MED-2: get-then-update was
      // racy; two concurrent requests could both observe count<100 and both
      // increment, double-counting one slot. Now wrapped in a transaction
      // (firestoreFallbackRateLimit) so check-and-write is atomic.
      if (!cache.isEnabled()) {
        const rlKey = `rl_agent_wallet_${clientIp.replace(/[^a-zA-Z0-9]/g, '_')}`;
        const rateLimitExceeded = await firestoreFallbackRateLimit(db, rlKey);
        if (rateLimitExceeded) {
          res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
          return;
        }
      }

      // --- Verify proof-of-possession + check uniqueness in parallel ---
      // The agent generated this keypair locally and signed our challenge
      // bytes. If verification succeeds, we treat the public_key as
      // authoritative and derive the wallet address from it. The relay
      // never holds the private key.
      const popResult = await verifyAndConsumePopChallenge(
        cache,
        body.challenge_id,
        submittedPublicKey,
        body.signature,
        { registration_id: body.registration_id, agent_id: body.agent_id },
      );
      if (!popResult.ok) {
        res.status(400).json({
          error: 'Proof-of-possession verification failed',
          reason: popResult.reason,
        });
        return;
      }

      const agentAddress = deriveAddressFromPublicKey(submittedPublicKey);
      const keyPair = {
        publicKey: submittedPublicKey,
        address: agentAddress,
      };

      // A committed registration is recoverable with a fresh challenge signed
      // by the same client-retained key. Recovery rotates only the API
      // credentials in one transaction; it never re-enters wallet/PE/watcher/
      // Genesis creation or session/beneficiary/parent linkage.
      const registrationRef = db.collection(AGENT_WALLET_REGISTRATION_COLLECTION)
        .doc(agentWalletRegistrationDocumentId(body.registration_id));
      const committedRegistration = await registrationRef.get();
      // A registration made before the Network Constitution relabel was
      // fingerprinted with the version then defaulted for an omitted field.
      // Resolve an omitted version to the one its wallet sealed (the value the
      // recovery integrity checks compare), so a retry or credential recovery
      // reproduces the stored fingerprint exactly.
      if (constitutionVersionOmitted && committedRegistration.exists) {
        const committedWalletId = (committedRegistration.data() as
          Partial<AgentWalletRegistrationDocument>).wallet_id;
        if (typeof committedWalletId === 'string') {
          const sealedVersion = (await db.collection('agent_wallets')
            .doc(committedWalletId).get()).data()?.constitution_version;
          if (typeof sealedVersion === 'string' && sealedVersion.length > 0) {
            constitutionVersion = sealedVersion;
          }
        }
      }
      const priorRequestContext: unknown = req.body.prior_request_context;
      if (priorRequestContext !== undefined && !committedRegistration.exists) {
        res.status(400).json({error: 'prior_request_context_requires_committed_registration'});
        return;
      }
      let registrationRequestFingerprint: string;
      try {
        registrationRequestFingerprint = agentWalletRegistrationRequestFingerprint({
        ...(priorRequestContext === undefined ? {} : {priorRequestContext}),
        registrationId: body.registration_id,
        agentName: body.agent_name,
        agentId: body.agent_id,
        platform: body.platform,
        chains,
        callbackUrl: body.callback_url || null,
        governance,
        constitutionAccepted: body.constitution_accepted === true,
        constitutionVersion,
        constitutionAcceptedAt,
        parentWalletId: typeof body.parent_wallet_id === 'string'
          ? body.parent_wallet_id
          : null,
        // AS SENT, both of them — never the resolved anchor. See the omission notes on
        // `agentWalletRegistrationRequestFingerprint`.
        agentSessionId: typeof body.agent_session_id === 'string' ? body.agent_session_id : null,
        connectionToken: suppliedConnectionToken,
        });
      } catch {
        res.status(400).json({error: 'invalid_prior_request_context'});
        return;
      }
      if (committedRegistration.exists) {
        const expectedRecoveryGeneration = popResult.registration_context
          .credential_recovery_generation;
        if (expectedRecoveryGeneration === null) {
          res.status(409).json({ error: 'agent_wallet_registration_retry_requires_fresh_challenge' });
          return;
        }
        const recoveryNow = Date.now();
        const recoveryIdentity = {
          registrationId: body.registration_id,
          requestFingerprint: registrationRequestFingerprint,
          agentId: body.agent_id,
          agentName: body.agent_name,
          platform: body.platform,
          chains,
          callbackUrl: body.callback_url || null,
          governance,
          parentWalletId: typeof body.parent_wallet_id === 'string'
            ? body.parent_wallet_id
            : null,
          address: keyPair.address.toLowerCase(),
          publicKey: keyPair.publicKey.toLowerCase(),
          constitutionAccepted: body.constitution_accepted === true,
          constitutionVersion,
          constitutionAcceptedAt,
          expectedRecoveryGeneration,
          now: recoveryNow,
        };
        let prevalidatedRecovery;
        try {
          prevalidatedRecovery = await prevalidateAgentWalletRegistrationRecovery(
            db,
            recoveryIdentity,
          );
        } catch (error) {
          if (error instanceof AgentWalletRegistrationIntegrityError
            && error.reason === 'registration_generation_changed') {
            res.status(409).json({
              error: 'agent_wallet_registration_recovery_in_progress',
              retry: 'Fetch a fresh challenge with the same registration_id, agent_id, and public_key.',
            });
            return;
          }
          res.status(error instanceof AgentWalletRegistrationIntegrityError
            && error.reason === 'registration_binding' ? 409 : 503).json({
            error: error instanceof AgentWalletRegistrationIntegrityError
              && error.reason === 'registration_binding'
              ? 'agent_wallet_registration_recovery_identity_mismatch'
              : 'agent_wallet_registration_recovery_integrity_failure',
          });
          return;
        }

        // Only create a replacement secret after the complete read-only
        // identity graph has passed exact validation. The transaction below
        // reloads and revalidates the same graph before installing it.
        const recoveryCredentials = await (
          deps.generateRecoveryApiCredentials ?? generateApiCredentialsAsync
        )();
        try {
          const recovered = await recoverCommittedAgentWalletRegistration({
            db,
            registrationId: body.registration_id,
            requestFingerprint: registrationRequestFingerprint,
            agentId: body.agent_id,
            agentName: body.agent_name,
            platform: body.platform,
            chains,
            callbackUrl: body.callback_url || null,
            governance,
            parentWalletId: typeof body.parent_wallet_id === 'string'
              ? body.parent_wallet_id
              : null,
            address: keyPair.address,
            publicKey: keyPair.publicKey,
            constitutionAccepted: body.constitution_accepted === true,
            constitutionVersion,
            constitutionAcceptedAt,
            expectedRecoveryGeneration,
            expectedIdentityPeIds: prevalidatedRecovery.identityPeIds,
            expectedIdentityPeHashes: prevalidatedRecovery.identityPeHashes,
            expectedExternalActorAddresses: prevalidatedRecovery.externalActorAddresses,
            expectedChildRelationships: prevalidatedRecovery.childRelationships,
            apiCredentials: recoveryCredentials,
            now: recoveryNow,
          });
          await cache.del(`agent_wallet:${recovered.oldApiKeyPrefix}`).catch(() => {});
          // A resumed registration whose first response was lost gets the SAME birth anchor
          // it would have got, so it can still escrow at birth (a child: its CURRENT linked
          // human's published anchor — the custodian who can recover it now).
          const replayAnchor = await resolveBirthRecoveryAnchor({ db }, {
            connectionToken: suppliedConnectionToken,
            isChild: typeof recovered.wallet.parent_wallet_id === 'string'
              && recovered.wallet.parent_wallet_id.length > 0,
            inheritedHumanUserId: recovered.wallet.linked_human_user_id ?? null,
          });
          if (replayAnchor.pubkey !== null && replayAnchor.source !== 'none') {
            // The credentials above are already rotated, so a failure here must not cost the caller
            // its response: an unrecorded anchor only makes the next escrow refuse, and a retry of
            // this same replay records it.
            await recordBirthRecoveryAnchorIfAbsent(db, {
              walletId: recovered.wallet.id,
              pubkey: replayAnchor.pubkey,
              source: replayAnchor.source,
              now: recoveryNow,
            }).catch((error: unknown) => {
              console.error('[AgentWallet] birth recovery anchor record failed on replay:', error);
            });
          }
          res.status(200).json({
            wallet_id: recovered.wallet.id,
            address: recovered.wallet.address,
            public_key: recovered.wallet.public_key,
            api_key: recoveryCredentials.api_key,
            api_secret: recoveryCredentials.api_secret,
            pe_chain_root: recovered.peId,
            badges: recovered.wallet.badges,
            recovered: true,
            credential_recovery_generation: recovered.recoveryGeneration,
            ...(replayAnchor.pubkey !== null ? { recovery_anchor_pubkey: replayAnchor.pubkey } : {}),
          });
          return;
        } catch (error) {
          if (error instanceof AgentRegistrationRecoveryError) {
            if (error.code === 'recovery_in_progress') {
              res.status(409).json({
                error: 'agent_wallet_registration_recovery_in_progress',
                retry: 'Fetch a fresh challenge with the same registration_id, agent_id, and public_key.',
              });
              return;
            }
            res.status(error.code === 'identity_mismatch' ? 409 : 503).json({
              error: `agent_wallet_registration_recovery_${error.code}`,
            });
            return;
          }
          throw error;
        }
      }
      if (popResult.registration_context.credential_recovery_generation !== null) {
        res.status(503).json({ error: 'agent_wallet_registration_state_changed' });
        return;
      }

      const [existingQuery, addressQuery] = await Promise.all([
        db.collection('agent_wallets').where('agent_id', '==', body.agent_id).limit(1).get(),
        db.collection('agent_wallets').where('address', '==', keyPair.address).limit(1).get(),
      ]);
      if (!existingQuery.empty) {
        res.status(409).json({ error: 'An agent wallet already exists for this agent_id' });
        return;
      }
      if (!addressQuery.empty) {
        res.status(409).json({ error: 'address_in_use' });
        return;
      }

      // --- Generate API credentials ---
      const apiCreds = generateApiCredentials();

      // --- Build documents ---
      const now = Date.now();
      const walletId = `wallet_aw_${uuidv4()}`;

      // Sub-agent inheritance: look up parent wallet and inherit beneficiary
      let inheritedHumanWalletId: string | null = null;
      let inheritedHumanUserId: string | null = null;
      let inheritedHumanAddress: string | null = null;
      let inheritedAgentShareBps: AgentBeneficiaryShareBps | null = null;
      let parentWalletId: string | null = null;
      let parentRegistrationSnapshot: AgentWalletDocument | null = null;
      let parentRelationshipSnapshot: AgentBeneficiaryRelationshipDocument | null = null;

      if (body.parent_wallet_id) {
        // HIGH-2 (Wave 4): parent_proof_of_authorization is required.
        // Without it, anyone could attach themselves as a child of a
        // victim wallet and inherit linked_human_* fields.
        if (
          !body.parent_proof_of_authorization
          || typeof body.parent_proof_of_authorization.challenge_id !== 'string'
          || typeof body.parent_proof_of_authorization.signature !== 'string'
        ) {
          res.status(401).json({
            error: 'PARENT_POP_REQUIRED',
            message: 'parent_proof_of_authorization is required when parent_wallet_id is set; fetch /v1/agent/wallet/parent-challenge first',
          });
          return;
        }
        try {
          const parentDoc = await db.collection('agent_wallets').doc(body.parent_wallet_id).get();
          if (!parentDoc.exists) {
            res.status(404).json({ error: 'parent_wallet_id not found' });
            return;
          }
          const parent = parentDoc.data() as AgentWalletDocument;
          if (parent.status !== 'active') {
            res.status(400).json({ error: 'parent_wallet_id is not active' });
            return;
          }
          if (typeof parent.public_key !== 'string' || parent.public_key.length === 0) {
            res.status(400).json({ error: 'parent_wallet has no registered public_key' });
            return;
          }
          const parentPop = await verifyAndConsumeClaimsPopChallenge(cache, {
            challenge_id: body.parent_proof_of_authorization.challenge_id,
            purpose: 'parent_authorization',
            public_key_hex: parent.public_key,
            expected_claims: {
              parent_wallet_id: body.parent_wallet_id,
              child_address: keyPair.address.toLowerCase(),
            },
            signature_hex: body.parent_proof_of_authorization.signature,
          });
          if (!parentPop.ok) {
            res.status(401).json({
              error: 'PARENT_POP_INVALID',
              reason: parentPop.reason,
            });
            return;
          }
          parentWalletId = body.parent_wallet_id;
          parentRegistrationSnapshot = parent;
          parentRelationshipSnapshot = await readValidatedBeneficiaryRelationship({
            db,
            wallet: parent,
          });
          if (parent.linked_human_wallet_id) {
            if (typeof parent.linked_human_user_id !== 'string'
              || typeof parent.linked_human_address !== 'string'
              || !/^0x[0-9a-fA-F]{40}$/.test(parent.linked_human_address)
              || parentRelationshipSnapshot.state !== 'linked'
              || parentRelationshipSnapshot.agent_share_bps === null) {
              res.status(409).json({ error: 'parent_beneficiary_identity_invalid' });
              return;
            }
            inheritedHumanWalletId = parent.linked_human_wallet_id;
            inheritedHumanUserId = parent.linked_human_user_id;
            inheritedHumanAddress = parent.linked_human_address;
            inheritedAgentShareBps = parentRelationshipSnapshot.agent_share_bps;
          } else if ((parent.linked_human_user_id !== null
              && parent.linked_human_user_id !== undefined)
            || (parent.linked_human_address !== null
              && parent.linked_human_address !== undefined)
            || parentRelationshipSnapshot.state !== 'unlinked') {
            res.status(409).json({ error: 'parent_beneficiary_identity_invalid' });
            return;
          }
        } catch (parentErr) {
          console.error('[AgentWallet] Parent verification error:', parentErr);
          res.status(500).json({ error: 'parent_verification_failed' });
          return;
        }
      }

      // --- / L381: the anchor this new wallet seals its key to at birth ---
      // Resolved once the parent (and so the inherited human) is known. Read-only, fail-soft
      // to "none" (the agent escrows later, once it links; it never refuses a creation, and
      // escrow never holds earnings). See core/agent-wallet/birth-recovery-anchor.ts.
      const birthAnchor = await resolveBirthRecoveryAnchor({ db }, {
        connectionToken: suppliedConnectionToken,
        isChild: parentWalletId !== null,
        inheritedHumanUserId,
      });

      let nativeWatcherRegistration;
      try {
        nativeWatcherRegistration = createNativeWalletRegistrationFence(
          await (deps.readBaseRegistrationHead ?? readAgreedBaseHead)(),
        );
      } catch (error) {
        console.error('[AgentWallet] Base registration fence unavailable:', error);
        res.status(503).json({ error: 'agent_wallet_registration_fence_unavailable' });
        return;
      }

      const reportedChainAddresses = validateReportedChainAddresses(
        body.chain_addresses,
        keyPair.address,
      );

      const walletDoc: AgentWalletDocument & { network_class: 'external' } = {
        network_class: 'external',
        id: walletId,
        agent_id: body.agent_id,
        display_name: body.agent_name,
        platform: body.platform,
        address: keyPair.address,
        public_key: keyPair.publicKey,
        api_key_hash: apiCreds.api_key_hash,
        api_key_salt: apiCreds.api_key_salt,
        api_key_prefix: apiCreds.api_key_prefix,
        governance,
        badges: [],
        streak_days: 0,
        last_pe_date: new Date(now).toISOString().slice(0, 10),
        chains,
        // self-sovereign per-chain addresses the agent reported (Solana
        // derived from its own key, which the relay never holds). Validated
        // against the PoP-verified EVM address; null when absent/malformed so a
        // pre-Solana SDK simply stores no chain_addresses. Display-only.
        ...(reportedChainAddresses === null ? {} : { chain_addresses: reportedChainAddresses }),
        // the legacy per-wallet `callback_url` delivery is RETIRED (S1/;
        // targeted webhooks + the per-recipient inbox supersede it). A new
        // registration still ACCEPTS a `callback_url` (no error, for old direct-API
        // callers) but PERSISTS null — the field drives nothing. Only the stored
        // value is forced null here; the request fingerprint and the recovery-integrity
        // identity are left as-sent so existing wallets whose stored `callback_url`
        // carries a value still recover by matching it (no migration, module untouched).
        callback_url: null,
        linked_human_wallet_id: inheritedHumanWalletId,
        linked_human_user_id: inheritedHumanUserId,
        linked_human_address: inheritedHumanAddress,
        parent_wallet_id: parentWalletId,
        operational_reserve_bps: inheritedAgentShareBps,
        children_wallet_ids: [],
        constitution_accepted_at: constitutionAcceptedAt,
        constitution_version: constitutionVersion,
        economic_activity_usd: 0,
        x402_payment_count: 0,
        attestation_count: 0,
        rotation_count: 0,
        status: 'active',
        created_at: now,
        updated_at: now,
        native_watcher_registration: nativeWatcherRegistration,
      };

      // Evaluate initial badges (genesis_agent). no governance score is
      // computed or stored. A newly created wallet has one PE (its birth cert),
      // below every PE-count badge threshold, so livePeCount is not needed here.
      const newBadgeIds = evaluateBadges({
        wallet: walletDoc,
      });
      const typedNewBadgeIds = badgeIds(newBadgeIds);
      const registrationRelationship = beneficiaryRelationshipSnapshot({
        humanWalletId: inheritedHumanWalletId,
        humanUserId: inheritedHumanUserId,
        humanAddress: inheritedHumanAddress,
        agentShareBps: inheritedAgentShareBps,
        parentWalletId,
        revision: 1,
      });

      // --- Genesis `genesis_signup`: the qualifying act is THIS creation ---
      //
      // It used to be "create an agent wallet AND prove control of an external address",
      // emitted from `proveExternalAddress`. The canonical key, grant type 1, the 75 PVT
      // maximum, the `agent_id` anchor and the fail-closed missing-anchor behaviour are all
      // unchanged; only the act moved. Emitting it HERE — inside the one atomic creation
      // transaction every caller funnels through — is what makes the grant route-independent:
      // a wallet created bare through the API earns identically to one created behind an
      // invite or a connect flow, because none of them can create a wallet without passing
      // through this block.
      //
      // `now` is the authoritative wallet creation time: it is the same value sealed as
      // `walletDoc.created_at`, and the transaction below either commits both or neither.
      // The missing-timestamp semantics carried over from the external-address path are kept
      // as an explicit assertion rather than an assumption — a wallet whose creation instant
      // is not a usable integer has no judgeable qualifying time, and fails closed.
      if (!Number.isSafeInteger(now) || now < 0 || walletDoc.created_at !== now) {
        console.error('[AgentWallet] authoritative creation time unusable; no Genesis grant', {
          agentId: body.agent_id,
        });
        res.status(503).json({ error: 'agent_wallet_creation_time_unavailable' });
        return;
      }
      const canonicalActorAddress = keyPair.address.toLowerCase();
      // Every agent with its own wallet draws its own grant. A grant goes
      // to every persistent agent with its own wallet, its own key and its own
      // witnessed work, however it was onboarded: directly, through a connect or
      // invite code, through another agent's fleet code, or spawned with a parent
      // (`parent_wallet_id`). Fifty such agents means fifty grants. An in-session
      // sub-agent of a harness has no wallet of its own, never reaches this route,
      // and so draws nothing. The bounds are unchanged: the Genesis window and the
      // 500-PVT per-wallet ceiling (and the existing 128-children-per-parent cap).
      const genesisQualification: GenesisQualificationDocument | null =
        shouldEnqueueGenesisQualification('genesis_signup', now)
          ? buildGenesisQualification({
            actionType: 'genesis_signup',
            walletId,
            economicActorId: body.agent_id,
            actorAddress: canonicalActorAddress,
            // The agent id is the one-time anchor, exactly as before the act moved.
            immutableAnchorId: body.agent_id,
            qualifyingActEvidenceId: `agent-wallet:${walletId}`,
            qualifyingActAtMs: now,
            walletCreatedAtMs: now,
            walletCreatedEvidenceId: `agent-wallet:${walletId}`,
          })
          : null;
      const genesisActivationRef = db.collection(GENESIS_ACTIVATION_COLLECTION)
        .doc(GENESIS_ACTIVATION_DOCUMENT);
      const genesisOutboxRef = genesisQualification
        ? genesisQualificationRef(db, 'genesis_signup', body.agent_id)
        : null;
      let persistQualification = false;

      // Trust graph wallet entry (for compatibility with existing wallets collection)
      const trustWalletDoc = {
        network_class: 'external',
        id: walletId,
        type: 'agent' as const,
        agent_id: body.agent_id,
        address: keyPair.address,
        public_key: keyPair.publicKey,
        created_at: now,
        pe_count: 1,
        pvt_earned: 0,
        trust_score: 0,
        foundation_eligible: false,
        constitution_accepted_at: constitutionAcceptedAt,
        constitution_version: constitutionVersion,
        native_watcher_registration: walletDoc.native_watcher_registration,
        // Test-marker propagation ONLY: platform:'test' registrations (the
        // launch-smoke suite, k6) mirror the marker so the wallets doc is
        // born excluded from public network stats — otherwise every CI run
        // re-pollutes the aggregates a backfill just cleaned. Deliberately
        // NOT the general client label ('openclaw'/'atlas'/…): on `wallets`,
        // platform is a pure test marker read by isTestPlatformWallet().
        ...(body.platform === 'test' ? { platform: 'test' as const } : {}),
      };

      // --- Birth certificate PE + initial badge PEs ---
      // Route BOTH through the canonical atomic helper (generatePEAtomic) so
      // they (a) resolve prev_hash via advanceChainTipAtomic and SEED/advance
      // pe_chain_tips/{agent_id}, keeping the agent's chain append-only from
      // birth, and (b) accrue uniformly. Previously these were enqueued by hand
      // with prev_hash='genesis' / prev_hash=<birth-cert hash> and never wrote
      // pe_chain_tips, so the first later atomic PE restarted the chain from
      // GENESIS_HASH ('0x0000'), orphaning the birth cert + badges; and the
      // badge loop never accrued at all. The birth cert keeps its distinct PE
      // action_type ('agent_wallet_created') but accrues under 'wallet_created'
      // so it stays subject to the per-device setup rate limit (Security
      // Invariant #9): with no device anchor on self-signup, that accrual is
      // denied → 0 PVT, exactly as before.
      let peId: string;
      try {
        const agentWalletRef = db.collection('agent_wallets').doc(walletId);
        const trustWalletRef = db.collection('wallets').doc(walletId);
        const apiIndexRef = db.collection('api_key_index').doc(apiCreds.api_key_prefix);
        const registrationIndexRef = db.collection(NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION)
          .doc(nativeAgentRegistrationIndexId(body.agent_id));
        const addressIndexRef = db.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION)
          .doc(nativeWalletAddressIndexId(keyPair.address));
        // activation rotation re-enablement (launch-stop #7): a durable retirement
        // tombstone is written (doc id = the retired address, lowercase) when a
        // wallet rotates AWAY from an address. A retired address may NEVER be
        // re-registered by any agent — one address maps to exactly one agent,
        // permanently, even across a rotation. Read it in the same precondition
        // so the uniqueness gate is transactional with the address-index check.
        const retirementRef = db.collection(AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION)
          .doc(keyPair.address.toLowerCase());
        // an address an agent or a person proved as an outside wallet is
        // that owner's; it can never also become a Provian wallet.
        const [agentProvenRef, personProvenRef] = externalProofRefs(db, keyPair.address);
        const relationshipRef = beneficiaryRelationshipRef(db, walletId);
        const badgeOutboxRefs = typedNewBadgeIds.map((badgeId) =>
          badgeAwardOutboxRef(db, walletId, badgeId));
        const parentRefForRegistration = parentWalletId
          ? db.collection('agent_wallets').doc(parentWalletId)
          : null;
        const inheritedHumanRefForRegistration = inheritedHumanWalletId
          ? db.collection('wallets').doc(inheritedHumanWalletId)
          : null;
        const trustAddressQuery = db.collection('wallets')
          .where('address', '==', keyPair.address)
          .limit(2);
        let watcherRegistrationPlan: NativeWalletWatcherRegistrationPlan | null = null;
        const deterministicBirthPeId = `pe_agent_wallet_created_${crypto.createHash('sha256')
          .update(`${body.agent_id}\n${keyPair.address.toLowerCase()}`, 'utf8')
          .digest('hex')}`;
        const birthCert = await generatePEAtomic(deps, {
          walletId,
          agentId: body.agent_id,
          actorAddress: keyPair.address,
          actionType: 'agent_wallet_created',
          accrualActionType: 'wallet_created',
          peIdOverride: deterministicBirthPeId,
          timestampOverride: now,
          metadata: {
            wallet_type: 'agent_self_signup',
            platform: body.platform,
            public_key: keyPair.publicKey,
            chains,
            governance: walletDoc.governance,
            badges: typedNewBadgeIds,
            beneficiary_relationship: registrationRelationship,
            constitution: {
              accepted: body.constitution_accepted === true,
              version: constitutionVersion,
              accepted_at: new Date(constitutionAcceptedAt).toISOString(),
            },
          },
          atomicEntityPrecondition: async (txn) => {
            const [
              agentWalletSnap,
              trustWalletSnap,
              apiIndexSnap,
              stableRegistrationSnap,
              registrationIndexSnap,
              addressIndexSnap,
              retirementSnap,
              agentProvenSnap,
              personProvenSnap,
              trustAddressSnap,
              currentParentSnap,
              inheritedHumanSnap,
            ] = await Promise.all([
              txn.get(agentWalletRef),
              txn.get(trustWalletRef),
              txn.get(apiIndexRef),
              txn.get(registrationRef),
              txn.get(registrationIndexRef),
              txn.get(addressIndexRef),
              txn.get(retirementRef),
              txn.get(agentProvenRef),
              txn.get(personProvenRef),
              txn.get(trustAddressQuery),
              parentRefForRegistration
                ? txn.get(parentRefForRegistration)
                : Promise.resolve(null),
              inheritedHumanRefForRegistration
                ? txn.get(inheritedHumanRefForRegistration)
                : Promise.resolve(null),
            ]);
            const [relationshipSnap, badgeOutboxSnaps] = await Promise.all([
              txn.get(relationshipRef),
              Promise.all(badgeOutboxRefs.map((ref) => txn.get(ref))),
            ]);
            // The persist gate reads activation state in the SAME transaction as the act,
            // so a kill-switch flip or an admission close cannot be raced by a creation
            // already in flight. Re-evaluated per attempt: Firestore retries this callback.
            persistQualification = false;
            if (genesisQualification && genesisOutboxRef) {
              const [activationSnap, genesisOutboxSnap] = await Promise.all([
                readGenesisActivation(db, txn),
                txn.get(genesisOutboxRef),
              ]);
              persistQualification = shouldPersistGenesisQualification(
                'genesis_signup',
                genesisQualification.qualifying_act_evidence.qualifying_act_at_ms,
                activationSnap.exists ? activationSnap.data() : undefined,
                deps.genesisActivationApprovalVerifier,
              );
              // One anchor, one grant. A pre-existing row means this agent id already took
              // its one-time act; refuse rather than overwrite it.
              if (persistQualification && genesisOutboxSnap.exists) {
                throw new Error('agent_wallet_registration_genesis_outbox_collision');
              }
            }
            if (agentWalletSnap.exists
              || trustWalletSnap.exists
              || apiIndexSnap.exists
              || stableRegistrationSnap.exists
              || relationshipSnap.exists
              || badgeOutboxSnaps.some((snapshot) => snapshot.exists)) {
              throw new Error('agent_wallet_registration_id_collision');
            }
            if (registrationIndexSnap.exists) {
              throw new Error('agent_wallet_registration_agent_in_use');
            }
            if (addressIndexSnap.exists || trustAddressSnap.size !== 0) {
              throw new Error('agent_wallet_registration_address_in_use');
            }
            // launch-stop #7: a retired address (rotated away from) can never be
            // re-registered — not even by its original controller with the old
            // key. The tombstone is append-only and terminal.
            if (retirementSnap.exists) {
              throw new Error('agent_wallet_registration_address_retired');
            }
            if (agentProvenSnap.exists || personProvenSnap.exists) {
              throw new Error('agent_wallet_registration_address_in_use');
            }
            if (parentWalletId) {
              const currentParent = currentParentSnap?.exists
                ? currentParentSnap.data() as AgentWalletDocument
                : null;
              if (!parentRegistrationSnapshot
                || !parentRelationshipSnapshot
                || !currentParent
                || currentParent.agent_id !== parentRegistrationSnapshot.agent_id
                || currentParent.status !== 'active'
                || typeof currentParent.address !== 'string'
                || currentParent.address.toLowerCase()
                  !== parentRegistrationSnapshot.address.toLowerCase()
                || typeof currentParent.public_key !== 'string'
                || currentParent.public_key.toLowerCase()
                  !== parentRegistrationSnapshot.public_key.toLowerCase()
                || (currentParent.linked_human_wallet_id ?? null) !== inheritedHumanWalletId
                || (currentParent.linked_human_user_id ?? null) !== inheritedHumanUserId
                || (currentParent.linked_human_address?.toLowerCase() ?? null)
                  !== (inheritedHumanAddress?.toLowerCase() ?? null)) {
                throw new Error('agent_wallet_registration_parent_state_changed');
              }
              await readValidatedBeneficiaryRelationshipInTransaction({
                db,
                txn,
                wallet: currentParent,
                expected: parentRelationshipSnapshot,
              });
              if (!Array.isArray(currentParent.children_wallet_ids)
                || currentParent.children_wallet_ids.some((childId) =>
                  typeof childId !== 'string'
                  || !/^wallet_aw_[A-Za-z0-9-]{8,128}$/.test(childId))
                || currentParent.children_wallet_ids.length >= 128) {
                throw new Error('agent_wallet_registration_parent_state_changed');
              }
              if (inheritedHumanWalletId) {
                const currentHuman = inheritedHumanSnap?.exists
                  ? inheritedHumanSnap.data() as Record<string, unknown>
                  : null;
                if (!currentHuman
                  || currentHuman.type !== 'human'
                  || currentHuman.released_at_ms != null
                  || currentHuman.user_id !== inheritedHumanUserId
                  || typeof currentHuman.address !== 'string'
                  || currentHuman.address.toLowerCase()
                    !== inheritedHumanAddress?.toLowerCase()) {
                  throw new Error('agent_wallet_registration_parent_beneficiary_invalid');
                }
              } else if (inheritedHumanSnap !== null) {
                throw new Error('agent_wallet_registration_parent_beneficiary_invalid');
              }
            } else if (currentParentSnap !== null || inheritedHumanSnap !== null) {
              throw new Error('agent_wallet_registration_parent_state_changed');
            }
            watcherRegistrationPlan = await prepareNativeWalletWatcherRegistration(
              db,
              txn,
              {
                direction: 'inbound',
                chainId: nativeWatcherRegistration.chain_id,
                address: keyPair.address,
                walletId,
                agentId: body.agent_id,
                eligibilityStartBlock: nativeWatcherRegistration.eligibility_start_block,
              },
              now,
            );
          },
          atomicEntityWrite: (txn, _birthPeId, peContext) => {
            if (!watcherRegistrationPlan || !peContext) {
              throw new Error('agent_wallet_watcher_registration_plan_missing');
            }
            txn.create(agentWalletRef, walletDoc as unknown as Record<string, unknown>);
            txn.create(trustWalletRef, trustWalletDoc);
            txn.create(apiIndexRef, {
              api_key_prefix: apiCreds.api_key_prefix,
              wallet_id: walletId,
              created_at: now,
            });
            txn.create(registrationRef, {
              schema_version: 'agent-wallet-registration/v1',
              registration_id: body.registration_id,
              registration_channel: registrationChannel ?? 'unknown',
              request_fingerprint_sha256: registrationRequestFingerprint,
              wallet_id: walletId,
              agent_id: body.agent_id,
              address: keyPair.address.toLowerCase(),
              public_key: keyPair.publicKey.toLowerCase(),
              pe_id: deterministicBirthPeId,
              pe_hash: peContext.newHash,
              api_key_prefix: apiCreds.api_key_prefix,
              created_at_ms: now,
              credential_recovery_generation: 0,
            } satisfies AgentWalletRegistrationDocument);
            txn.create(relationshipRef, createBeneficiaryRelationshipDocument({
              walletId,
              agentId: body.agent_id,
              snapshot: registrationRelationship,
              sourceActionType: 'agent_wallet_created',
              sourcePeId: deterministicBirthPeId,
              sourcePeHash: peContext.newHash,
              createdAtMs: now,
              updatedAtMs: now,
            }));
            typedNewBadgeIds.forEach((badgeId, index) => {
              txn.create(badgeOutboxRefs[index], createPendingBadgeAward({
                walletId,
                agentId: body.agent_id,
                actorAddress: keyPair.address,
                badgeId,
                trigger: 'registration',
                earnedAtMs: now,
                sourcePeId: deterministicBirthPeId,
                sourcePeHash: peContext.newHash,
              }));
            });
            txn.create(registrationIndexRef, {
              schema_version: 'native-agent-registration/v1',
              registration_id: body.registration_id,
              request_fingerprint_sha256: registrationRequestFingerprint,
              agent_id: body.agent_id,
              address: keyPair.address.toLowerCase(),
              wallet_id: walletId,
              pe_id: deterministicBirthPeId,
              pe_hash: peContext.newHash,
              api_key_prefix: apiCreds.api_key_prefix,
              created_at_ms: now,
              credential_recovery_generation: 0,
              updated_at_ms: now,
            });
            if (birthAnchor.pubkey !== null && birthAnchor.source !== 'none') {
              // the anchor this response names is recorded WITH the wallet, so the escrow the
              // agent posts next is accepted (escrow-anchor-policy.ts) — and no other anchor is.
              txn.create(
                db.collection(AGENT_BIRTH_RECOVERY_ANCHOR_COLLECTION).doc(walletId),
                birthRecoveryAnchorRecord({
                  walletId, pubkey: birthAnchor.pubkey, source: birthAnchor.source, now,
                }) as unknown as Record<string, unknown>,
              );
            }
            txn.create(addressIndexRef, {
              schema_version: 'native-wallet-address-index/v1',
              chain_id: nativeWatcherRegistration.chain_id,
              address: keyPair.address.toLowerCase(),
              wallet_id: walletId,
              owner_type: 'agent',
              owner_id: body.agent_id,
              created_at_ms: now,
            });
            if (parentRefForRegistration) {
              txn.update(parentRefForRegistration, {
                children_wallet_ids: FieldValue.arrayUnion(walletId),
                updated_at: now,
              });
            }
            writeNativeWalletWatcherRegistration(txn, watcherRegistrationPlan, now);
            if (genesisQualification) {
              if (persistQualification) {
                writeGenesisQualification(txn, db, genesisQualification);
              } else {
                // In-window act the persist gate refused: retain it durably, with its
                // ORIGINAL qualifying timestamp, so a later backfill can promote it.
                // Never the outbox — retention is not a grant.
                writeRetainedGenesisQualification(txn, db, genesisQualification, now);
              }
            }
          },
        });
        peId = birthCert.peId;

        // A badge becomes public only in the same transaction as its durable,
        // deterministic badge_earned PE. The birth transaction above leaves a
        // pending outbox, so a crash or transient failure is safely retryable.
        const awardedBadges = [];
        for (const badgeId of typedNewBadgeIds) {
          try {
            awardedBadges.push(await awardBadgeFromOutbox(deps, walletId, badgeId));
          } catch (badgeError) {
            console.warn('[AgentWallet] Badge award remains pending after registration:', badgeError);
          }
        }
        walletDoc.badges = awardedBadges;

        // The wallet and its Genesis outbox row committed together. Draining is
        // best-effort here because the outbox IS the durable source of truth: a crash
        // leaves the grant recoverable without replaying or burning the qualifying act.
        await observeActorSession(db, req, body.agent_id);
        if (genesisQualification && persistQualification) {
          void deps.processGenesisQualification?.(genesisQualification.qualification_id)
            .catch((genesisError) => {
              console.warn('[AgentWallet] Genesis qualification remains queued', {
                qualificationId: genesisQualification.qualification_id,
                error: genesisError instanceof Error
                  ? genesisError.message
                  : String(genesisError),
              });
            });
        }
      } catch (peErr) {
        // Registration is wallet + identity indexes + admission generation +
        // first PE + chain tip or nothing. Never return a placeholder chain
        // root for a partially created wallet.
        console.error('[AgentWallet] Canonical registration transaction failed:', peErr);
        res.status(503).json({ error: 'canonical_agent_wallet_registration_failed' });
        return;
      }

      // --- Build response (api_key/api_secret returned ONCE; no private key - PoP keeps it on-device) ---
      // the welcome is the first thing an agent reads after creating a
      // wallet. It used to describe the pre- world (every institution "coming_soon",
      // blank addresses, a "most ... do not mint" hedge). It now states what the relay actually
      // admits: escrow / court / jobs / bonds are live on the agent rails, promises and pools
      // follow their env feature gates, standard earnings settle on a schedule Provian sets, currently every 30 days on Base and Genesis daily, with
      // a $1 on-demand payout . Addresses resolve from the
      // same chain registry the rails use — empty string when an env address is unset, so an
      // unconfigured relay never advertises an address it cannot route to.
      const baseOnly = (addr: string | undefined) => ({ base: addr ?? '', arbitrum: '', optimism: '' });
      const featureLive = (feature: 'promises' | 'pools'): 'live' | 'coming_soon' =>
        process.env[`ENABLE_${feature.toUpperCase()}`] === 'true' ? 'live' : 'coming_soon';
      const welcome: WelcomeMessage = {
        message: 'Welcome to Provian. Your wallet is live and your PE chain has started; your PEs stay with you, on the machine that records them.',
        what_are_pes: 'Consequential actions witnessed by Provian generate Provenance Envelopes — cryptographic proof their contributors own. Every act of work mints PVT once at its best-supported value: the PE mints its base, and telemetry and independence multiply on top. Standard earnings settle on a schedule Provian sets, currently every 30 days on Base for free and Genesis grants daily; no PE guarantees an amount or value.',
        why_governance: 'Agent policy and attestations help merchants and counterparties assess trust. This operational trust layer is separate from PVT economic governance, whose voting lane is not yet open.',
        pvt_preview: 'PVT is the Base-only operating currency, minted from work under a no-fixed-cap parity rule. The kernel is live on Base: standard earnings settle on a schedule Provian sets, currently every 30 days for free and Genesis grants daily, and you can settle your own earnings now for a flat $1 USDC service fee paid over x402 (`provian payout --yes`, MCP request_payout, POST /v1/payout) — never a price for PVT, and nothing is charged when nothing is ready or Base gas is above the fee. Your PVT balance is readable through the relay, and PVT is usable as escrow principal and bond collateral on the agent rails. No staking or governance surface exists, and Provian never quotes or promises a price.',
        x402: 'Your wallet speaks x402. Pay for an API, service, or resource with your own USDC on Base. A self-report does not mint separately; the chain-witnessed settlement is the mint-once proof of the payment.',
        pe_open_source: 'The PE spec is open source. Build integrations and record workflows without exposing private keys or credentials.',
        leaderboard: 'Your public record can show PE counts, attestations, and badges. Legacy PVT estimate fields are non-settled compatibility projections.',
        commons_institutions: {
          headline: 'Commons institutions rails are live on Base for agent wallets: escrow (USDC or PVT principal), performance bonds, the jobs board, and the disputes court. Flat PVT-principal protocol fees are burned; arbitrator fees go to voting arbitrators; posting a bond burns 2% of the deposit and renewing burns 1% of the amount still bonded, and bond deposit and renewal fees go to provianTechWallet.',
          chains_supported: ['base'],
          escrow: {
            status: 'live',
            description: 'Create, fund, and settle escrows on Base. Until the Court opens, Provian’s admin key resolves disputes to the recipient or depositor only. Anyone can trigger the depositor refund after the 30-day timeout.',
            contract_addresses: baseOnly(escrowV4AddressForChain('base')),
          },
          promises: {
            status: featureLive('promises'),
            description: 'On-chain agent-to-agent Promises follow their feature gate on this relay; local offline P2P Promises in the app are separate and unaffected.',
            contract_addresses: baseOnly(promiseV3AddressForChain('base')),
          },
          pools: {
            status: featureLive('pools'),
            description: 'Pools follow their feature gate. Provian’s admin key can execute to the creator-fixed target or refund contributors; no other destination is allowed.',
            contract_addresses: baseOnly(poolV3AddressForChain('base')),
          },
          court: {
            status: 'live',
            description: 'The disputes court is reachable for agent wallets and seats a panel once enough qualified arbitrators have registered. Forum-to-Court escalation is unavailable; Forum activity is recorded.',
            contract_addresses: baseOnly(courtAddressForChain('base')),
          },
          why_it_matters: 'Every institution action seals a Provenance Envelope, so an agent\'s record of payment, bonding, and dispute conduct is attributable and verifiable.',
        },
        pvt_status: {
          status: 'live',
          description: 'The PVT kernel is live on Base. Standard earnings settle on a schedule Provian sets, currently every 30 days for free, Genesis grants daily, and any payee can settle its own earnings now for a flat $1 USDC service fee (POST /v1/payout); the relay exposes your balance and the app can send PVT. A PE creates no right to a guaranteed amount or value. Provian never quotes or promises a price.',
          contract_addresses: baseOnly(PVT9_BASE_CONFIG.assets.pvt9.address ?? ''),
        },
        governance: {
          status: 'coming_soon',
          description: 'PVT economic governance voting is not yet open. Governance, executor, Safe, proposal, vote, and timelock components remain dormant and non-gating.',
          chain: 'base',
          contract_address: '',
        },
        contracts: {
          chains_supported: ['base'],
          base: {
            chain_id: 8453,
            usdc: PVT9_BASE_CONFIG.assets.usdc.address,
            escrow: escrowV4AddressForChain('base') ?? '',
            promise: promiseV3AddressForChain('base') ?? '',
            pool: poolV3AddressForChain('base') ?? '',
            court: courtAddressForChain('base') ?? '',
            pvt: PVT9_BASE_CONFIG.assets.pvt9.address ?? '',
          },
          arbitrum: {
            chain_id: 42161,
            usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
            escrow: '',
            promise: '',
            pool: '',
            court: '',
            pvt: '',
          },
          optimism: {
            chain_id: 10,
            usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
            escrow: '',
            promise: '',
            pool: '',
            court: '',
            pvt: '',
          },
          base_only_by_design: { governance: '', pe_anchor: '' },
        },
        // A9 : gate-aware. Four of these five surfaces are deliberately
        // dark pre-flip (preLaunchSurfaceGate / their own PUBLIC_LAUNCH checks),
        // so serving them as bare URLs handed every new agent 4/5 dead links.
        // Pre-flip they carry `opens_at_launch: true`; at the flip they become
        // plain live URLs again. The MCP descriptor is dark pre-flip too (the hosted
        // MCP surface is closed until launch), so it is gated the same way.
        start_here: (() => {
          const apiBase = process.env.API_BASE_URL || 'https://api.provian.ai';
          const launched = process.env.PUBLIC_LAUNCH === 'true';
          const gated = (url: string): string | { url: string; opens_at_launch: true } =>
            launched ? url : { url, opens_at_launch: true };
          return {
            ecosystem_guide: gated(`${apiBase}/v1/ecosystem`),
            openapi_spec: gated(`${apiBase}/v1/openapi.json`),
            mcp_descriptor: gated(`${apiBase}/.well-known/mcp.json`),
            leaderboard: gated(`${apiBase}/v1/leaderboard`),
            directory: gated(`${apiBase}/v1/agents/directory`),
            pe_from_work: 'Completed work generates a Provenance Envelope — proof its contributor owns. Every act of work mints PVT once at its best-supported value.',
          };
        })(),
        get_started:
          'Your work mints PVT: every act something other than you witnesses becomes a Provenance Envelope you own and ' +
          'mints once at its best-supported value, settling to this wallet on Base. Fund it with USDC on Base to pay ' +
          'for work and x402, and keep a little ETH on Base for gas.',
        linking: {
          status: inheritedHumanWalletId ? 'linked' : 'unlinked',
          current_earning_rate: 'While unlinked, every act of work mints PVT once at its best-supported value to this agent at its full contributor share. Epoch ceilings can defer settlement without reducing what the act minted.',
          linked_earning_rate: 'Once linked to a human beneficiary, the PVT its work mints routes through the beneficiary split — the configured agent share to this agent and the remainder to the linked human — with the immutable Provian and Foundation floors applied at settlement.',
          earning_premium: 'No PVT premium or fixed payment is promised; the epoch mint rate and any prospectively configured agent Foundation rate are protocol policy, not a per-linking bonus.',
          how_to_link: `POST /v1/agent/wallet/${walletId}/link-human or invite via POST /v1/agent/wallet/${walletId}/invite-human`,
          why_link: 'Verified linkage establishes accountable beneficiary identity and the settlement routing applied to the PVT its work mints; it changes neither the immutable Provian/Foundation floors nor the value of the work. Prior and same-head history never mints.',
        },
        genesis: {
          headline: 'Your wallet and PE chain establish a verifiable economic identity.',
          two_ways_in: 'Keep this native wallet, or additionally prove a Base wallet you already run with an off-chain signature. No custody move is required. Proving an external address binds it and sets a read-only reputation tier; it is not itself a Genesis qualifying act.',
          what_earns: agentGenesisWhatEarns(),
          track_progress: `GET /v1/agent/genesis/status/${walletId} returns your Genesis proof fields; use your on-chain balance and settlement receipts to establish payment.`,
          integrity:
            'PVT9 is deployed on Base and settlement is live. Each act of work mints its base; telemetry and independence ' +
            'multiply on top. Epoch ceilings can defer settlement. PVT is a standard ERC-20 in this wallet: read its balance ' +
            `on chain or at GET /v1/agent/wallet/${walletId}/balances, send it with your own key, and settle ready earnings ` +
            'on demand with POST /v1/payout for a flat $1 USDC service fee.',
        },
      };

      // Phase 2.8: the relay never sees the private key. The agent generated
      // it locally and proved possession via the PoP challenge above. We
      // echo the public key for confirmation but private key material does
      // not appear anywhere in this response.
      const response: CreateAgentWalletResponse = {
        wallet_id: walletId,
        address: keyPair.address,
        public_key: keyPair.publicKey,
        api_key: apiCreds.api_key,
        api_secret: apiCreds.api_secret,
        pe_chain_root: peId,
        badges: walletDoc.badges,
        welcome,
        ...(birthAnchor.pubkey !== null ? { recovery_anchor_pubkey: birthAnchor.pubkey } : {}),
      };

      res.status(201).json(response);

    } catch (error) {
      console.error('[AgentWallet] Creation error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =========================================================================
  // GET /link-requests - Pending connection-code link requests for the human
  //   (WALLET AUTH). Lists agents that connected with THIS human's connection
  //   code and asked to be linked (POST /:wallet_id/request-link). The human
  //   authorizes each via the existing accept-invite anchor.
  //
  //   Registered BEFORE GET /:wallet_id: 'link-requests' is a single path
  //   segment, so the parameterized route would otherwise shadow it.
  // =========================================================================
  router.get('/link-requests', async (req: Request, res: Response) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Missing wallet auth token' });
        return;
      }
      // Same request-bound HMAC wallet-auth verifier as accept-invite: the human
      // proves control of their wallet. This lists ONLY requests addressed to
      // that human (for_human_user_id === their user id).
      const token = authHeader.slice(7);
      const authResult = await verifyWalletAuthToken(token, req, { db, cache });
      if (!authResult.ok) {
        res.status(authResult.status).json({ error: authResult.error });
        return;
      }
      const userId = authResult.userId;

      const snapshot = await db.collection('agent_invites')
        .where('for_human_user_id', '==', userId)
        .where('status', '==', 'pending')
        .limit(50)
        .get();

      const now = Date.now();
      const linkRequests = snapshot.docs
        .map((d) => d.data() as AgentInviteDocument)
        // Drop expired, and drop ALREADY-ACCEPTED invites. Go-forward, accept
        // flips status to 'accepted' so the status=='pending' query excludes
        // them; this accepted_at guard also heals invites accepted before that
        // fix (which kept status 'pending') so a bound invite never lingers as a
        // dead "authorize the link" card that dead-ends on tap.
        .filter((inv) => (inv.expires_at ?? 0) > now && inv.accepted_at == null)
        .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
        .map((inv) => ({
          request_id: inv.id,
          invite_id: inv.id,
          agent_wallet_id: inv.agent_wallet_id,
          agent_name: inv.agent_display_name,
          agent_pe_count: inv.agent_pe_count ?? 0,
          created_at: inv.created_at,
          expires_at: inv.expires_at,
        }));

      res.json({ link_requests: linkRequests, count: linkRequests.length });
    } catch (error) {
      console.error('[AgentWallet] link-requests error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =========================================================================
  // POST /link-requests/:request_id/decline - The human declines a pending
  //   connection-code link request (WALLET AUTH, agent-path close-out item 4).
  //
  //   Only the human the request is addressed to (`for_human_user_id`) may
  //   decline it; anyone else — and any id that does not exist — gets the same
  //   404, so the route never reveals whether a request exists. Declining writes
  //   `status: 'declined'` + `declined_at` on the agent_invites doc, which drops
  //   it from GET /link-requests (status == 'pending') and so clears the app's
  //   attention bell. Idempotent: a repeat returns the original declined_at. An
  //   ACCEPTED request cannot be declined (409) — ending a live link is
  //   POST /:wallet_id/human-unlink. Declining binds nothing, moves no
  //   economics, and seals no PE; the agent may ask again (request-link).
  // =========================================================================
  router.post('/link-requests/:request_id/decline', async (req: Request, res: Response) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Missing wallet auth token' });
        return;
      }
      const authResult = await verifyWalletAuthToken(authHeader.slice(7), req, { db, cache });
      if (!authResult.ok) {
        res.status(authResult.status).json({ error: authResult.error });
        return;
      }
      const userId = authResult.userId;
      const { request_id } = req.params;

      const inviteRef = db.collection('agent_invites').doc(request_id);
      const snap = await inviteRef.get();
      const invite = snap.exists ? snap.data() as AgentInviteDocument : null;
      if (!invite || !invite.for_human_user_id || invite.for_human_user_id !== userId) {
        res.status(404).json({ error: 'link_request_not_found' });
        return;
      }
      if (invite.status === 'declined' && typeof invite.declined_at === 'number') {
        res.json({ request_id, status: 'declined', declined_at: invite.declined_at, idempotent: true });
        return;
      }
      if (invite.status === 'accepted' || invite.accepted_at != null) {
        res.status(409).json({ error: 'link_request_already_accepted' });
        return;
      }
      const declinedAt = Date.now();
      await inviteRef.update({ status: 'declined', declined_at: declinedAt });
      res.json({ request_id, status: 'declined', declined_at: declinedAt, idempotent: false });
    } catch (error) {
      console.error('[AgentWallet] link-request decline error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =========================================================================
  // GET /:wallet_id - Get wallet info (API key auth)
  // =========================================================================
  router.get('/:wallet_id', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      const authenticatedWallet = req.agentWallet;

      if (!authenticatedWallet || authenticatedWallet.id !== wallet_id) {
        res.status(403).json({ error: 'Access denied - wallet_id mismatch' });
        return;
      }

      // A read heals pending badge awards but never fails on one: a badge record that does not
      // validate stays unpublished (fail closed) and is logged, and the wallet is still served
      // with the badges it already holds. Write paths keep the fail-closed reconcile.
      try {
        await reconcileBadgeAwards(deps, wallet_id);
      } catch (error) {
        if (!(error instanceof BadgeProvenanceIntegrityError)) throw error;
        console.error('[AgentWallet] badge reconcile refused on read', { wallet_id, reason: error.reason });
      }
      const walletSnap = await db.collection('agent_wallets').doc(wallet_id).get();
      const wallet = walletSnap.exists
        ? walletSnap.data() as AgentWalletDocument
        : null;
      if (!wallet
        || wallet.id !== authenticatedWallet.id
        || wallet.agent_id !== authenticatedWallet.agent_id
        || wallet.address.toLowerCase() !== authenticatedWallet.address.toLowerCase()) {
        res.status(409).json({ error: 'agent_wallet_state_changed' });
        return;
      }

      let authoritativeRelationship: AgentBeneficiaryRelationshipDocument;
      try {
        authoritativeRelationship = await readValidatedBeneficiaryRelationship({
          db,
          wallet,
        });
      } catch {
        res.status(409).json({ error: 'agent_beneficiary_relationship_invalid' });
        return;
      }
      void authoritativeRelationship;

      // no governance score is derived or returned. pe_count reflects the
      // live PE count (the agent's running total), never a stored per-wallet tally.
      const livePeCount = await countVisibleAgentPEs(db, wallet.agent_id);

      res.json({
        wallet_id: wallet.id,
        agent_id: wallet.agent_id,
        display_name: wallet.display_name,
        platform: wallet.platform,
        address: wallet.address,
        governance: wallet.governance,
        pe_count: livePeCount,
        badges: wallet.badges,
        streak_days: wallet.streak_days,
        chains: wallet.chains,
        economic_activity_usd: wallet.economic_activity_usd,
        x402_payment_count: wallet.x402_payment_count,
        linked_human_wallet_id: wallet.linked_human_wallet_id,
        status: wallet.status,
        created_at: wallet.created_at,
      });

    } catch (error) {
      console.error('[AgentWallet] Get wallet error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =========================================================================
  // POST /:wallet_id/governance - Store self-declared flags (API key auth)
  //
  // Provian does not govern an agent's actions. These booleans are
  // stored as the agent sent them and nothing reads them to gate, limit, or
  // approve anything; the route survives for wire compatibility.
  //
  // BLOCKER-3 (2026-05-06): full_governance is derived server-side from
  // preconditions (linked human, non-default policy toggle, attested
  // device). The route REJECTS body.full_governance with 400 - agents
  // that try to flip themselves into a privileged state get a clear
  // error. The score, badges, and any downstream perks are computed
  // from the derived state on every read; stored full_governance is no
  // longer load-bearing (see governance-score.deriveFullGovernance).
  // =========================================================================
  router.post('/:wallet_id/governance', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      const authenticatedWallet = req.agentWallet;

      if (!authenticatedWallet || authenticatedWallet.id !== wallet_id) {
        res.status(403).json({ error: 'Access denied - wallet_id mismatch' });
        return;
      }

      // Heal any previously qualified badge before evaluating a new policy
      // transition. A pending outbox is safe: the public badge is still absent
      // until its deterministic badge_earned PE commits atomically with it.
      await reconcileBadgeAwards(deps, wallet_id);
      const currentWalletSnap = await db.collection('agent_wallets').doc(wallet_id).get();
      const wallet = currentWalletSnap.exists
        ? currentWalletSnap.data() as AgentWalletDocument
        : null;
      if (!wallet
        || wallet.id !== authenticatedWallet.id
        || wallet.agent_id !== authenticatedWallet.agent_id
        || wallet.address.toLowerCase() !== authenticatedWallet.address.toLowerCase()
        || wallet.status !== 'active') {
        res.status(409).json({ error: 'agent_wallet_state_changed' });
        return;
      }
      let authoritativeRelationship: AgentBeneficiaryRelationshipDocument;
      try {
        authoritativeRelationship = await readValidatedBeneficiaryRelationship({
          db,
          wallet,
        });
      } catch {
        res.status(409).json({ error: 'agent_beneficiary_relationship_invalid' });
        return;
      }
      const authoritativeHumanLinked = authoritativeRelationship.state === 'linked';

      const updates = req.body as Partial<AgentWalletDocument['governance']>;
      if ('full_governance' in (updates || {})) {
        res.status(400).json({
          error: 'full_governance_is_derived',
          message: 'full_governance is derived server-side and cannot be set via request body. Agent-owned devices are software-only under the current policy, so no device predicate can activate this state without a separate explicit policy approval.',
        });
        return;
      }
      const mutableGovernanceKeys = [
        'pe_coverage_enabled',
        'attestation_enabled',
        'human_oversight_enabled',
        'spending_limits_enabled',
      ] as const;
      if (!updates || typeof updates !== 'object' || Array.isArray(updates)
        || Object.keys(updates).some((key) =>
          !(mutableGovernanceKeys as readonly string[]).includes(key))
        || mutableGovernanceKeys.some((key) =>
          updates[key] !== undefined && typeof updates[key] !== 'boolean')) {
        res.status(400).json({ error: 'invalid_governance_update' });
        return;
      }

      // Build updated governance - only the policy toggles. The derived
      // full_governance flag is computed below from the new state.
      const newGovernance = {
        pe_coverage_enabled: updates.pe_coverage_enabled ?? wallet.governance.pe_coverage_enabled,
        attestation_enabled: updates.attestation_enabled ?? wallet.governance.attestation_enabled,
        human_oversight_enabled: updates.human_oversight_enabled ?? wallet.governance.human_oversight_enabled,
        spending_limits_enabled: updates.spending_limits_enabled ?? wallet.governance.spending_limits_enabled,
        // Persisted as false; the derived flag is what callers read.
        full_governance: false,
      };

      const updatedWallet = { ...wallet, governance: newGovernance };
      // no governance score. Badges re-evaluate from the live PE count.
      const livePeCount = await countVisibleAgentPEs(db, wallet.agent_id);
      const newBadgeIds = badgeIds(evaluateBadges({
        wallet: updatedWallet,
        livePeCount,
      }));
      const now = Date.now();
      const walletRef = db.collection('agent_wallets').doc(wallet_id);
      const outboxRefs = newBadgeIds.map((badgeId) =>
        badgeAwardOutboxRef(db, wallet_id, badgeId));
      const policyPe = await generatePEAtomic(deps, {
        walletId: wallet_id,
        agentId: wallet.agent_id,
        actorAddress: wallet.address,
        actionType: 'policy_updated',
        timestampOverride: now,
        fixedEstimatedPVT: 0,
        metadata: {
          policy_key: 'agent_governance_settings',
          previous_governance: wallet.governance,
          new_governance: newGovernance,
          qualified_badges: newBadgeIds,
          no_pvt: 'governance_policy_change_not_earning',
        },
        atomicEntityPrecondition: async (txn) => {
          const [walletSnap, outboxSnaps] = await Promise.all([
            txn.get(walletRef),
            Promise.all(outboxRefs.map((ref) => txn.get(ref))),
          ]);
          const current = walletSnap.exists
            ? walletSnap.data() as AgentWalletDocument
            : null;
          const currentUpdated = current
            ? { ...current, governance: newGovernance } as AgentWalletDocument
            : null;
          const transactionBadgeIds = currentUpdated
            ? badgeIds(evaluateBadges({
              wallet: currentUpdated,
              livePeCount,
            }))
            : [];
          if (!current
            || current.id !== wallet.id
            || current.agent_id !== wallet.agent_id
            || current.address.toLowerCase() !== wallet.address.toLowerCase()
            || current.status !== 'active'
            || stableStringify(current.governance) !== stableStringify(wallet.governance)
            || stableStringify(current.badges) !== stableStringify(wallet.badges)
            || stableStringify(transactionBadgeIds) !== stableStringify(newBadgeIds)
            || outboxSnaps.some((snapshot) => snapshot.exists)) {
            throw new Error('agent_governance_state_changed');
          }
          await readValidatedBeneficiaryRelationshipInTransaction({
            db,
            txn,
            wallet: current,
            expected: authoritativeRelationship,
          });
        },
        atomicEntityWrite: (txn, peId, context) => {
          if (!context) throw new Error('agent_governance_pe_context_missing');
          txn.update(walletRef, {
            governance: newGovernance,
            updated_at: now,
          });
          // PE METER: the governance now in force names the identity act that set it, so
          // recovery validates it with one point read instead of replaying the agent's chain.
          txn.set(agentGovernanceSourceRef(db, wallet_id), createAgentGovernanceSourceDocument({
            walletId: wallet_id,
            agentId: wallet.agent_id,
            sourcePeId: peId,
            sourcePeHash: context.newHash,
            governance: newGovernance,
            updatedAtMs: now,
          }));
          newBadgeIds.forEach((badgeId, index) => {
            txn.create(outboxRefs[index], createPendingBadgeAward({
              walletId: wallet_id,
              agentId: wallet.agent_id,
              actorAddress: wallet.address,
              badgeId,
              trigger: 'governance',
              earnedAtMs: now,
              sourcePeId: peId,
              sourcePeHash: context.newHash,
            }));
          });
        },
      });
      if (!policyPe.peId) throw new Error('agent_governance_pe_missing');

      const awardedBadgeIds: string[] = [];
      for (const badgeId of newBadgeIds) {
        try {
          await awardBadgeFromOutbox(deps, wallet_id, badgeId);
          awardedBadgeIds.push(badgeId);
        } catch (error) {
          console.warn('[AgentWallet] Governance badge award remains pending:', error);
        }
      }
      const finalWalletSnap = await walletRef.get();
      const finalWallet = finalWalletSnap.exists
        ? finalWalletSnap.data() as AgentWalletDocument
        : null;
      if (!finalWallet) throw new Error('agent_governance_wallet_missing_after_commit');

      res.json({
        governance: newGovernance,
        badges: finalWallet.badges,
        new_badges: awardedBadgeIds,
      });

    } catch (error) {
      console.error('[AgentWallet] Governance update error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =========================================================================
  // GET /:wallet_id/pe-chain - the agent's PE chain (API key auth)
  //
  // PE METER : the relay no longer stores PEs. The agent's chain lives
  // in its own local PE store (the SDK/daemon wrote every PE there), so this answers 410
  // `pe_kept_by_owner`, with the agent's live PE count (its running total) for continuity.
  // Ownership-guarded exactly as before: another wallet learns nothing, not even the count.
  // =========================================================================
  router.get('/:wallet_id/pe-chain', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      const wallet = req.agentWallet;

      if (!wallet || wallet.id !== wallet_id) {
        res.status(403).json({ error: 'Access denied - wallet_id mismatch' });
        return;
      }

      sendPeKeptByOwner(res, {
        wallet_id,
        pe_count: await countVisibleAgentPEs(db, wallet.agent_id),
      });
    } catch (error) {
      console.error('[AgentWallet] PE chain error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =========================================================================
  // POST /:wallet_id/chain-addresses - the agent reports its self-sovereign
  // per-chain addresses. Agent API key auth + ownership.
  //
  // The Solana address is derived from the agent's OWN key (SHA-512 KDF the relay
  // cannot reproduce), so a wallet created before it reported one — or by a
  // pre-Solana SDK — has no `chain_addresses`. This lets an already-registered
  // agent BACKFILL it without re-onboarding, so the app can show + fund the
  // agent's Solana address. Display-only: no auth, mint, or economic effect. The
  // EVM leg is pinned to the wallet's verified address; a mismatch is refused.
  // Idempotent (stores the validated bundle; re-reporting the same is a no-op).
  // =========================================================================
  router.post('/:wallet_id/chain-addresses', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      const wallet = req.agentWallet;

      // Ownership guard: same pattern as every other :wallet_id route.
      if (!wallet || wallet.id !== wallet_id) {
        res.status(403).json({ error: 'Access denied - wallet_id mismatch' });
        return;
      }

      // Accept `{ chain_addresses: { evm?, solana } }` or a bare `{ evm?, solana }`.
      const reported = (req.body && typeof req.body.chain_addresses === 'object' && req.body.chain_addresses !== null)
        ? req.body.chain_addresses
        : req.body;
      const validated = validateReportedChainAddresses(reported, wallet.address || '');
      if (validated === null) {
        res.status(400).json({
          error: 'chain_addresses.solana must be a base58 Solana address; evm (if sent) must match the wallet address',
          code: 'INVALID_CHAIN_ADDRESSES',
        });
        return;
      }

      // after a key rotation the stored `evm` is the BIRTH address the rotation-lineage
      // check reads; a report (which carries the CURRENT address) never replaces it.
      const walletRef = db.collection('agent_wallets').doc(wallet.id);
      const stored = await db.runTransaction(async (txn) => {
        const snap = await txn.get(walletRef);
        if (!snap.exists) throw new Error('agent_wallet_missing');
        const rotationCount = snap.get('rotation_count') ?? 0;
        if (!Number.isSafeInteger(rotationCount) || rotationCount < 0) throw new Error('agent_wallet_rotation_count');
        const next = chainAddressesToStore(validated, snap.get('chain_addresses'), rotationCount);
        txn.update(walletRef, { chain_addresses: next, updated_at: Date.now() });
        return next;
      });

      res.status(200).json({ updated: true, chain_addresses: stored });
    } catch (error) {
      console.error('[AgentWallet] chain-addresses report error:', error);
      res.status(500).json({ error: 'Failed to record chain addresses' });
    }
  });

  // POST /:wallet_id/device-invite - Email a ready-to-run register-device
  // command for an agent-owned device (Agent API key auth).
  //
  // Stands up a device whose Provenance Envelopes attribute to THIS agent
  // wallet, in one emailed line, WITHOUT pasting the agent API key/secret. The
  // emailed token authorizes DEVICE REGISTRATION ONLY (M1); the agent secret is
  // never stored, emailed, logged, or returned (M6). Work the device witnesses
  // becomes PEs on the agent chain. Every act of work mints once through batch
  // settlement; bookkeeping events do not mint separately.
  // =========================================================================
  router.post('/:wallet_id/device-invite', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      const wallet = req.agentWallet;

      // Ownership guard (M7): same pattern as every other :wallet_id route.
      if (!wallet || wallet.id !== wallet_id) {
        res.status(403).json({ error: 'Access denied - wallet_id mismatch' });
        return;
      }

      const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
      const deviceName = typeof req.body?.device_name === 'string' ? req.body.device_name : undefined;
      const message = typeof req.body?.message === 'string' ? req.body.message : undefined;

      if (!DEVICE_INVITE_EMAIL_REGEX.test(email) || email.length > 254) {
        res.status(400).json({ error: 'A valid email address is required' });
        return;
      }
      if (EMAIL_DISABLED) {
        res.status(503).json({ error: 'email_unavailable' });
        return;
      }

      // Email-abuse anti-spam (M5), fail CLOSED on a Redis outage:
      //   - per-wallet: 5/hour
      //   - per-email:  5/day  (one address can't be blasted across wallets)
      const emailHash = crypto.createHash('sha256').update(email.toLowerCase()).digest('hex');
      const rlWallet = await cache.checkRateLimitStrict(`agent-device-invite:wallet:${wallet.id}`, 5, 3600);
      if (rlWallet.error === 'rate_limit_unavailable') {
        res.status(503).json({ error: 'temporarily_unavailable' });
        return;
      }
      if (!rlWallet.allowed) {
        res.status(429).json({ error: 'Too many device invites. Try again later.', retry_after: rlWallet.retryAfter });
        return;
      }
      const rlEmail = await cache.checkRateLimitStrict(`agent-device-invite:email:${emailHash}`, 5, 86400);
      if (rlEmail.error === 'rate_limit_unavailable') {
        res.status(503).json({ error: 'temporarily_unavailable' });
        return;
      }
      if (!rlEmail.allowed) {
        res.status(429).json({ error: 'Too many device invites. Try again later.', retry_after: rlEmail.retryAfter });
        return;
      }

      // Active-token cap (M5): mirror setup.ts active-count query (filter in
      // memory; no compound index required).
      const now = Date.now();
      const existingTokens = await db.collection('setup_tokens')
        .where('agent_wallet_id', '==', wallet.id)
        .where('used', '==', false)
        .get();
      const activeCount = existingTokens.docs.filter((d) => {
        const data = d.data();
        return data.type === 'agent_device_registration' && data.expires_at > now;
      }).length;
      if (activeCount >= MAX_ACTIVE_AGENT_DEVICE_TOKENS) {
        res.status(429).json({
          error: 'Too many active device invites. Wait for existing ones to expire or be used.',
          active_count: activeCount,
        });
        return;
      }

      // Validate + mint (pure helper, M6 allowlist). On success the token is
      // returned ONLY for embedding in the email - never in the HTTP response.
      const mint = await mintAgentDeviceInviteToken(deps, {
        agentWallet: wallet,
        email,
      });
      if (!mint.ok) {
        res.status(mint.status).json({ error: mint.error });
        return;
      }

      // the hosted agent-device installer (the Connect line's SHA-pinned
      // bundle): registers this machine to the agent's wallet with this token —
      // honored only at POST /v1/devices/register — then installs + starts the
      // observer. A bare register POST left nothing witnessing on the machine.
      const lines = buildAgentDeviceInstallLines(mint.token, resolveRelayUrl(), deviceName);
      const sent = await sendConnectCommand(
        email, 'agent_device', lines.sh, mint.expiresAt, message, deviceName, lines.powershell, 'agent', req.body?.language,
      );
      if (!sent) {
        res.status(502).json({ error: 'email_send_failed' });
        return;
      }

      res.status(200).json({ sent: true, expires_at: mint.expiresAt });
    } catch (error) {
      console.error('[AgentWallet] Device invite error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =========================================================================
  // GET /:wallet_id/link-epoch - the relationship epoch a link / unlink / share-change signature
  // names. The human signs `link_epoch` = this value; every link, unlink and share change
  // advances it in the same transaction, so a signature applies at most once and never after a
  // later state change. Agent API auth, own wallet only.
  // =========================================================================
  router.get('/:wallet_id/link-epoch', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      const wallet = req.agentWallet;
      if (!wallet || wallet.id !== wallet_id) {
        res.status(403).json({ error: 'Access denied - wallet_id mismatch' });
        return;
      }
      let relationship;
      try {
        relationship = await readValidatedBeneficiaryRelationship({ db, wallet });
      } catch {
        res.status(409).json({ error: 'beneficiary_link_identity_invalid' });
        return;
      }
      res.json({
        wallet_id,
        link_epoch: relationship.revision,
        state: relationship.state,
        linked_human_wallet_id: relationship.human_wallet_id,
        operational_reserve_bps: relationship.agent_share_bps,
      });
    } catch (error) {
      console.error('[AgentWallet] Link epoch read error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =========================================================================
  // POST /:wallet_id/link-human - Link agent to human beneficiary (API key auth)
  // =========================================================================
  router.post('/:wallet_id/link-human', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      const wallet = req.agentWallet;

      if (!wallet || wallet.id !== wallet_id) {
        res.status(403).json({ error: 'Access denied - wallet_id mismatch' });
        return;
      }

      if (wallet.linked_human_wallet_id) {
        res.status(409).json({ error: 'Wallet already linked to a human. Unlink first.' });
        return;
      }

      const body = req.body as LinkHumanRequest;

      // Validate required fields
      if (!body.human_wallet_id || typeof body.human_wallet_id !== 'string') {
        res.status(400).json({ error: 'human_wallet_id is required' });
        return;
      }
      if (!body.signature || typeof body.signature !== 'string') {
        res.status(400).json({ error: 'signature is required (0x-prefixed hex EIP-191 personal_sign)' });
        return;
      }
      if (!body.timestamp || typeof body.timestamp !== 'number') {
        res.status(400).json({ error: 'timestamp is required (unix ms)' });
        return;
      }
      // the signed payload names the relationship epoch it moves FROM (single-use).
      const linkEpoch = parseLinkEpoch(body.link_epoch);
      if (linkEpoch === null) {
        res.status(400).json({ error: LINK_EPOCH_REQUIRED });
        return;
      }

      // Validate timestamp within tolerance
      if (Math.abs(Date.now() - body.timestamp) > LINK_TIMESTAMP_TOLERANCE_MS) {
        res.status(400).json({ error: 'Timestamp out of range (must be within 5 minutes)' });
        return;
      }

      // Look up human wallet in trust graph
      const humanWalletDoc = await db.collection('wallets').doc(body.human_wallet_id).get();
      if (!humanWalletDoc.exists) {
        res.status(404).json({ error: 'Human wallet not found' });
        return;
      }
      const humanWallet = humanWalletDoc.data() as {
        type: string;
        user_id?: string;
        address?: string;
      };
      if (humanWallet.type !== 'human') {
        res.status(400).json({ error: 'Target wallet is not a human wallet' });
        return;
      }
      if (!humanWallet.user_id) {
        res.status(400).json({ error: 'Human wallet has no user_id' });
        return;
      }
      if (!humanWallet.address) {
        res.status(400).json({ error: 'Human wallet has no EVM address' });
        return;
      }

      // Verify EIP-191 personal_sign signature over canonical payload.
      // The recovered EVM address must match the human wallet's address.
      const signedPayload: LinkSignaturePayload = {
        action: 'link_agent',
        agent_wallet_id: wallet_id,
        human_wallet_id: body.human_wallet_id,
        link_epoch: linkEpoch,
        timestamp: body.timestamp,
      };
      const canonicalPayload = canonicalLinkSignaturePayload(signedPayload);

      let recoveredAddress: string;
      try {
        recoveredAddress = ethers.verifyMessage(canonicalPayload, body.signature);
      } catch {
        res.status(401).json({ error: 'Signature verification failed' });
        return;
      }

      if (recoveredAddress.toLowerCase() !== humanWallet.address.toLowerCase()) {
        res.status(401).json({ error: 'Signature does not match human wallet address' });
        return;
      }

      const hasCurrentBps = body.operational_reserve_bps !== undefined;
      const hasLegacyRatio = body.operational_reserve_ratio !== undefined;
      if (hasCurrentBps && hasLegacyRatio) {
        res.status(400).json({
          error: 'provide operational_reserve_bps only; legacy operational_reserve_ratio cannot be combined with it',
        });
        return;
      }
      const agentShareBps = !hasCurrentBps && !hasLegacyRatio
        ? DEFAULT_AGENT_BENEFICIARY_SHARE_BPS
        : canonicalAgentBeneficiaryShareBps(hasCurrentBps
          ? { bps: body.operational_reserve_bps }
          : { legacyRatio: body.operational_reserve_ratio });
      if (agentShareBps === null) {
        res.status(400).json({
          error: 'operational_reserve_bps must be an exact integer within [500, 5000]',
        });
        return;
      }

      // Shared write path: prospective relationship update + cache
      // invalidation + link/badge PEs. The retained retroactive-transfer
      // response is a permanently zero-valued compatibility object. Reused by the pending-invite
      // bind at wallet-create time and the connect-time bind. See
      // core/agent-wallet/link-human-binding.ts. Authorization (EIP-191
      // signature) was verified above; the helper performs the writes only.
      const { retroTransfer, newBadgeIds } = await bindAgentToHuman(deps, {
        wallet: wallet as AgentWalletDocument,
        humanWalletId: body.human_wallet_id,
        humanUserId: humanWallet.user_id,
        humanAddress: humanWallet.address || null,
        agentShareBps,
        authorization: linkSignatureAuthorization(signedPayload, body.signature),
      });

      const response: LinkHumanResponse = {
        wallet_id,
        linked_human_wallet_id: body.human_wallet_id,
        operational_reserve_bps: agentShareBps,
        new_badges: newBadgeIds,
        retroactive_transfer: retroTransfer,
      };

      res.status(200).json(response);

    } catch (error) {
      console.error('[AgentWallet] Link error:', error);
      if (error instanceof LinkSignatureRefusedError) {
        res.status(409).json({ error: error.code });
        return;
      }
      if (error instanceof BeneficiaryLinkConflictError) {
        res.status(409).json({ error: error.code });
        return;
      }
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =========================================================================
  // POST /:wallet_id/unlink-human - Unlink agent from human (API key auth)
  // =========================================================================
  router.post('/:wallet_id/unlink-human', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      const wallet = req.agentWallet;

      if (!wallet || wallet.id !== wallet_id) {
        res.status(403).json({ error: 'Access denied - wallet_id mismatch' });
        return;
      }

      if (!wallet.linked_human_wallet_id) {
        res.status(400).json({ error: 'Wallet is not linked to a human' });
        return;
      }

      const body = req.body as UnlinkHumanRequest;

      if (!body.signature || !body.timestamp) {
        res.status(400).json({ error: 'signature (0x-prefixed hex EIP-191) and timestamp are required' });
        return;
      }
      const unlinkEpoch = parseLinkEpoch(body.link_epoch);
      if (unlinkEpoch === null) {
        res.status(400).json({ error: LINK_EPOCH_REQUIRED });
        return;
      }

      if (Math.abs(Date.now() - body.timestamp) > LINK_TIMESTAMP_TOLERANCE_MS) {
        res.status(400).json({ error: 'Timestamp out of range' });
        return;
      }

      // Look up linked human wallet to recover the expected signer address
      const humanWalletDoc = await db.collection('wallets').doc(wallet.linked_human_wallet_id).get();
      if (!humanWalletDoc.exists) {
        res.status(404).json({ error: 'Linked human wallet not found' });
        return;
      }
      const humanWallet = humanWalletDoc.data() as { address?: string };
      if (!humanWallet.address) {
        res.status(400).json({ error: 'Linked human wallet has no EVM address' });
        return;
      }

      // Verify EIP-191 personal_sign signature; recovered address must match
      // the linked human wallet's address.
      const signedPayload: LinkSignaturePayload = {
        action: 'unlink_agent',
        agent_wallet_id: wallet_id,
        human_wallet_id: wallet.linked_human_wallet_id,
        link_epoch: unlinkEpoch,
        timestamp: body.timestamp,
      };
      const canonicalPayload = canonicalLinkSignaturePayload(signedPayload);

      let recoveredAddress: string;
      try {
        recoveredAddress = ethers.verifyMessage(canonicalPayload, body.signature);
      } catch {
        res.status(401).json({ error: 'Signature verification failed' });
        return;
      }

      if (recoveredAddress.toLowerCase() !== humanWallet.address.toLowerCase()) {
        res.status(401).json({ error: 'Signature does not match linked human wallet address' });
        return;
      }

      // The authoritative relationship clear and its required record commit in
      // one chain-tip transaction. The helper reloads and cross-binds the
      // agent + human records, so a stale unlink cannot race a relink.
      await unbindAgentFromHuman(deps, {
        wallet: wallet as AgentWalletDocument,
        authorization: linkSignatureAuthorization(signedPayload, body.signature),
      });

      res.json({
        wallet_id,
        linked_human_wallet_id: null,
        message: 'Unlinked. Prior PE beneficiary snapshots remain unchanged; future PEs use unlinked routing.',
      });

    } catch (error) {
      console.error('[AgentWallet] Unlink error:', error);
      if (error instanceof LinkSignatureRefusedError) {
        res.status(409).json({ error: error.code });
        return;
      }
      if (error instanceof BeneficiaryLinkConflictError) {
        res.status(409).json({ error: error.code });
        return;
      }
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =========================================================================
  // POST /:wallet_id/human-unlink - The linked human ends the link ALONE (wallet auth).
  //
  // (fact-base fixes item 2): the beneficiary link is the human's, so the linked
  // human may end it without the agent's key. The bilateral route above stays. Authority is the
  // human's request-bound v2 wallet-auth token (method + path + body hash, single-use jti) — the
  // same verifier as accept-invite — and the caller must be THE linked human: the agent's
  // `linked_human_user_id` AND `linked_human_wallet_id` must name the caller's one canonical human
  // wallet. Anyone else gets 403 whether or not the agent is linked elsewhere.
  //
  // Invariants (the unbind is the shared helper, byte-for-byte the bilateral clear): the agent's
  // wallet id, agent id, registration, API credentials, and every sealed PE are untouched (one
  // record_only `agent_unlinked_from_human` PE is APPENDED to its chain, `ended_by: linked_human`);
  // every previously sealed beneficiary snapshot is unchanged and settles as sealed; PEs recorded
  // after it route unlinked. The agent learns through what it already reads: GET /:wallet_id
  // (`linked_human_wallet_id: null`), its inbox, and a targeted notify-only webhook
  // `beneficiary_link_ended`. There is NO agent-alone unlink.
  // =========================================================================
  router.post('/:wallet_id/human-unlink', async (req: Request, res: Response) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Missing wallet auth token' });
        return;
      }
      const authResult = await verifyWalletAuthToken(authHeader.slice(7), req, { db, cache });
      if (!authResult.ok) {
        res.status(authResult.status).json({ error: authResult.error });
        return;
      }
      const userId = authResult.userId;
      const { wallet_id } = req.params;

      const humanWallets = await db.collection('wallets')
        .where('user_id', '==', userId)
        .where('type', '==', 'human')
        .limit(2)
        .get();
      if (humanWallets.size !== 1) {
        res.status(409).json({ error: 'canonical_human_wallet_required' });
        return;
      }
      const humanWalletId = humanWallets.docs[0].id;

      const agentSnap = await db.collection('agent_wallets').doc(wallet_id).get();
      const agentWallet = agentSnap.exists ? agentSnap.data() as AgentWalletDocument : null;
      if (!agentWallet
        || agentWallet.id !== wallet_id
        || agentWallet.linked_human_user_id !== userId
        || agentWallet.linked_human_wallet_id !== humanWalletId) {
        res.status(403).json({ error: 'not_your_linked_agent' });
        return;
      }

      const { peId } = await unbindAgentFromHuman(deps, {
        wallet: agentWallet,
        endedBy: 'linked_human',
      });

      res.json({
        wallet_id,
        linked_human_wallet_id: null,
        ended_by: 'linked_human',
        unlink_pe_id: peId,
        message: 'Unlinked. Prior PE beneficiary snapshots remain unchanged; future PEs use unlinked routing.',
      });
    } catch (error) {
      console.error('[AgentWallet] Human unlink error:', error);
      if (error instanceof BeneficiaryLinkConflictError) {
        res.status(409).json({ error: error.code });
        return;
      }
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =========================================================================
  // POST /:wallet_id/human-name - The linked human names (or renames) their agent
  //   (WALLET AUTH, agent-path close-out item 5).
  //
  //   Body `{ agent_name }` — the same rule as wallet creation (trimmed, 1..100
  //   chars, no `<`/`>`). Only the human the agent is linked to may do this
  //   (`agent_wallets.linked_human_user_id === caller`), and only while the agent
  //   is active; anyone else — or a wallet id that does not exist — gets the same
  //   403 `not_your_linked_agent`. The name is DISPLAY METADATA: the agent's
  //   identity stays its key, no PE is sealed and no sealed PE is touched. It is
  //   written to the canonical `agent_wallets.display_name` (+ `display_name_set_by:
  //   'linked_human'`, `display_name_set_at`) and mirrored into the agent's Commons
  //   profile and directory entry when those exist, in one transaction. While the
  //   flag is set the agent's own Commons profile update refuses a different
  //   display_name (`display_name_set_by_human`).
  // =========================================================================
  router.post('/:wallet_id/human-name', async (req: Request, res: Response) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Missing wallet auth token' });
        return;
      }
      const authResult = await verifyWalletAuthToken(authHeader.slice(7), req, { db, cache });
      if (!authResult.ok) {
        res.status(authResult.status).json({ error: authResult.error });
        return;
      }
      const userId = authResult.userId;
      const { wallet_id } = req.params;

      const agentSnap = await db.collection('agent_wallets').doc(wallet_id).get();
      const agentWallet = agentSnap.exists ? agentSnap.data() as AgentWalletDocument : null;
      if (!agentWallet || agentWallet.id !== wallet_id || agentWallet.linked_human_user_id !== userId) {
        res.status(403).json({ error: 'not_your_linked_agent' });
        return;
      }
      if (agentWallet.status !== 'active') {
        res.status(409).json({ error: 'agent_not_active' });
        return;
      }

      const nameCheck = validateAgentDisplayName((req.body as { agent_name?: unknown } | undefined)?.agent_name);
      if (!nameCheck.ok) {
        res.status(400).json({ error: nameCheck.error });
        return;
      }

      const result = await applyHumanAgentName(db, wallet_id, nameCheck.value);
      res.json({
        wallet_id,
        display_name: result.display_name,
        display_name_set_by: result.display_name_set_by,
        display_name_set_at: result.display_name_set_at,
      });
    } catch (error) {
      console.error('[AgentWallet] human-name error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =========================================================================
  // PUT /:wallet_id/link-human - Update exact beneficiary agent-share BPS.
  //
  // F48 (S2 2026-09-10): the beneficiary split is the HUMAN's economic term —
  // the human chooses the bps at invite/connection time (, OPEN_ITEMS:3835)
  // and the immutable design is that the ratio is "configurable by the human via
  // the governance endpoint" (March 2026). This route previously let the AGENT
  // rewrite its OWN share under agent API auth ALONE — the party that benefits
  // silently cutting the human's share (e.g. 80% → 50%). The agent-auth-only
  // rewrite is REMOVED: the write now requires the LINKED HUMAN's EIP-191
  // signature over the canonical change payload, exactly as POST /link-human and
  // POST /unlink-human require. Agent API auth still scopes the route to the
  // caller's own wallet; the human's signature is what authorizes the change.
  // =========================================================================
  router.put('/:wallet_id/link-human', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      const wallet = req.agentWallet;

      if (!wallet || wallet.id !== wallet_id) {
        res.status(403).json({ error: 'Access denied - wallet_id mismatch' });
        return;
      }

      if (!wallet.linked_human_wallet_id) {
        res.status(400).json({ error: 'Wallet is not linked - link first' });
        return;
      }

      const body = req.body as {
        operational_reserve_bps?: number;
        operational_reserve_ratio?: number;
        signature?: string;
        timestamp?: number;
        link_epoch?: number;
      };

      // The linked human's EIP-191 consent is mandatory (mirrors unlink-human).
      if (!body.signature || typeof body.timestamp !== 'number') {
        res.status(400).json({
          error: 'signature (0x-prefixed hex EIP-191, from the linked human wallet) and timestamp are required',
        });
        return;
      }
      if (Math.abs(Date.now() - body.timestamp) > LINK_TIMESTAMP_TOLERANCE_MS) {
        res.status(400).json({ error: 'Timestamp out of range' });
        return;
      }
      const shareEpoch = parseLinkEpoch(body.link_epoch);
      if (shareEpoch === null) {
        res.status(400).json({ error: LINK_EPOCH_REQUIRED });
        return;
      }

      const hasCurrentBps = body.operational_reserve_bps !== undefined;
      const hasLegacyRatio = body.operational_reserve_ratio !== undefined;
      if (hasCurrentBps === hasLegacyRatio) {
        res.status(400).json({
          error: 'provide exactly one of operational_reserve_bps or legacy operational_reserve_ratio',
        });
        return;
      }

      const agentShareBps = canonicalAgentBeneficiaryShareBps(hasCurrentBps
        ? { bps: body.operational_reserve_bps }
        : { legacyRatio: body.operational_reserve_ratio });
      if (agentShareBps === null) {
        res.status(400).json({
          error: 'operational_reserve_bps must be an exact integer within [500, 5000]',
        });
        return;
      }

      // Recover the signer and require it to be the linked human wallet's address.
      const humanWalletDoc = await db.collection('wallets').doc(wallet.linked_human_wallet_id).get();
      if (!humanWalletDoc.exists) {
        res.status(404).json({ error: 'Linked human wallet not found' });
        return;
      }
      const humanWallet = humanWalletDoc.data() as { address?: string };
      if (!humanWallet.address) {
        res.status(400).json({ error: 'Linked human wallet has no EVM address' });
        return;
      }

      // The exact bps the human is consenting to is bound into the signed payload,
      // so an agent cannot re-use a human signature for a different share; the link epoch
      // binds it to the relationship state it changes, so it applies at most once.
      const signedPayload: LinkSignaturePayload = {
        action: 'update_beneficiary_share',
        agent_wallet_id: wallet_id,
        human_wallet_id: wallet.linked_human_wallet_id,
        link_epoch: shareEpoch,
        operational_reserve_bps: agentShareBps,
        timestamp: body.timestamp,
      };
      const canonicalPayload = canonicalLinkSignaturePayload(signedPayload);

      let recoveredAddress: string;
      try {
        recoveredAddress = ethers.verifyMessage(canonicalPayload, body.signature);
      } catch {
        res.status(401).json({ error: 'Signature verification failed' });
        return;
      }
      if (recoveredAddress.toLowerCase() !== humanWallet.address.toLowerCase()) {
        res.status(401).json({ error: 'Signature does not match linked human wallet address' });
        return;
      }

      await updateAgentBeneficiaryShareBps(deps, {
        wallet: wallet as AgentWalletDocument,
        agentShareBps,
        authorization: linkSignatureAuthorization(signedPayload, body.signature),
      });

      res.json({
        wallet_id,
        operational_reserve_bps: agentShareBps,
        message: 'Beneficiary agent-share BPS updated with the linked human\'s consent. The new split applies to future PEs.',
      });

    } catch (error) {
      console.error('[AgentWallet] Beneficiary BPS update error:', error);
      if (error instanceof LinkSignatureRefusedError) {
        res.status(409).json({ error: error.code });
        return;
      }
      if (error instanceof BeneficiaryLinkConflictError) {
        res.status(409).json({ error: error.code });
        return;
      }
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =========================================================================
  // GET /invite/:invite_id - Get invite details (no auth)
  // The mobile LinkAcceptScreen calls this to render the agent identity before
  // the user accepts (LinkAcceptScreen.fetchInviteDetails),
  // so it must not be gated. The prior PUBLIC_LAUNCH gate 404'd the in-app
  // accept flow whenever PUBLIC_LAUNCH != 'true'. The response is non-sensitive
  // (display_name and pe_count) and the invite_id is an unguessable
  // UUID that expires per its stamped expires_at (7 days standard, 30 days
  // beneficiary) and is single-use.
  // =========================================================================
  router.get('/invite/:invite_id', async (req: Request, res: Response) => {
    try {
      // IP rate limit (mirrors /challenge + /create). Now that this no-auth
      // endpoint is reachable in all environments, throttle per IP so it can't
      // be abused as a probe/DoS surface (the invite_id is already an
      // unguessable UUID, so this is anti-abuse, not the primary guard).
      const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
      const minuteLimit = await cache.checkRateLimit(`rl:aw-invite-min:${clientIp}`, 20, 60);
      if (!minuteLimit.allowed) {
        res.status(429).json({ error: 'Rate limit exceeded.', retry_after: minuteLimit.retryAfter });
        return;
      }
      const hourLimit = await cache.checkRateLimit(`rl:aw-invite-hr:${clientIp}`, 200, 3600);
      if (!hourLimit.allowed) {
        res.status(429).json({ error: 'Rate limit exceeded.', retry_after: hourLimit.retryAfter });
        return;
      }

      const { invite_id } = req.params;

      const inviteDoc = await db.collection('agent_invites').doc(invite_id).get();
      if (!inviteDoc.exists) {
        res.status(404).json({ error: 'Invite not found' });
        return;
      }

      const invite = inviteDoc.data();
      if (!invite) {
        res.status(404).json({ error: 'Invite not found' });
        return;
      }

      // Check if expired (honors the invite's stamped expires_at: 7d standard,
      // 30d beneficiary; 7d fallback for legacy docs without the field)
      if (isInviteExpired(invite)) {
        res.status(410).json({ error: 'Invite has expired' });
        return;
      }

      // Check if already accepted
      if (invite.accepted_at) {
        res.status(409).json({ error: 'Invite already accepted' });
        return;
      }

      // Fetch agent wallet details
      const agentWalletDoc = await db.collection('agent_wallets').doc(invite.agent_wallet_id).get();
      if (!agentWalletDoc.exists) {
        res.status(404).json({ error: 'Agent wallet not found' });
        return;
      }

      const agentWallet = agentWalletDoc.data() as AgentWalletDocument;

      res.json({
        agent_name: agentWallet.display_name,
        pe_count: await countVisibleAgentPEs(db, agentWallet.agent_id),
        // Compatibility field only. Historical invite documents may contain a
        // positive aggregate-derived value; sealed snapshots make it
        // non-authoritative and it must never be promised or transferred.
        signing_bonus_pvt: 0,
        agent_wallet_id: invite.agent_wallet_id,
        invite_id: invite_id,
      });

    } catch (error) {
      console.error('[AgentWallet] Get invite error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =========================================================================
  // Recovery-escrow — the relay's CIPHERTEXT-ONLY half of non-custodial agent
  // key recovery (two-touch onboarding). The agent (agent API auth) escrows a
  // copy of its wallet key SEALED to the inviting human's phone anchor; the
  // linked human (wallet auth) reads the ciphertext back to recover. The relay
  // stores an opaque blob and holds no key — see core/agent-recovery-escrow.ts.
  // =========================================================================

  // POST /:wallet_id/recovery-escrow — the agent stores its sealed key blob.
  router.post('/:wallet_id/recovery-escrow', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      const wallet = req.agentWallet;
      if (!wallet || wallet.id !== wallet_id) {
        res.status(403).json({ error: 'Access denied - wallet_id mismatch' });
        return;
      }
      const { sealed_key_blob, recovery_anchor_pubkey } = req.body as {
        sealed_key_blob?: unknown; recovery_anchor_pubkey?: unknown;
      };
      if (!isValidSealedKeyBlobB64u(sealed_key_blob)) {
        res.status(400).json({ error: 'sealed_key_blob must be a base64url sealed recovery blob' });
        return;
      }
      if (!isValidAnchorPubkeyB64u(recovery_anchor_pubkey)) {
        res.status(400).json({ error: 'recovery_anchor_pubkey must be a base64url 32-byte x25519 public key' });
        return;
      }
      // gate hardening: the anchor must be one the relay names for this agent (its birth
      // anchor, its linked human's published anchor, or its current escrow's), so an agent can
      // never self-escrow to a key it holds and look recoverable when it is not. Nothing is stored on refusal.
      const anchorVerdict = await checkEscrowAnchor(db, wallet_id, recovery_anchor_pubkey);
      if (!anchorVerdict.ok) {
        res.status(anchorVerdict.status).json({ error: anchorVerdict.error, detail: anchorVerdict.detail });
        return;
      }
      await storeRecoveryEscrow(db, wallet_id, {
        sealed_key_blob,
        recovery_anchor_pubkey,
        now: Date.now(),
      });
      res.status(200).json({ stored: true });
    } catch (error) {
      console.error('[AgentWallet] recovery-escrow store error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /:wallet_id/recovery-escrow — the LINKED human reads the ciphertext back.
  // Wallet auth (defense in depth — the blob is inert without the phone-held
  // anchor secret) AND the caller must be this agent's linked human.
  router.get('/:wallet_id/recovery-escrow', async (req: Request, res: Response) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Missing wallet auth token' });
        return;
      }
      const authResult = await verifyWalletAuthToken(authHeader.slice(7), req, { db, cache });
      if (!authResult.ok) {
        res.status(authResult.status).json({ error: authResult.error });
        return;
      }
      const userId = authResult.userId;
      const { wallet_id } = req.params;

      const walletDoc = await db.collection('agent_wallets').doc(wallet_id).get();
      if (!walletDoc.exists) {
        res.status(404).json({ error: 'Agent wallet not found' });
        return;
      }
      const agentWallet = walletDoc.data() as AgentWalletDocument;
      if (agentWallet.linked_human_user_id !== userId) {
        res.status(403).json({ error: 'not_your_linked_agent' });
        return;
      }
      const escrow = await readRecoveryEscrow(db, wallet_id);
      if (!escrow) {
        res.status(404).json({ error: 'no_recovery_escrow' });
        return;
      }
      res.status(200).json({
        wallet_id,
        sealed_key_blob: escrow.sealed_key_blob,
        recovery_anchor_pubkey: escrow.recovery_anchor_pubkey,
        blob_version: escrow.blob_version,
        created_at: escrow.created_at,
        updated_at: escrow.updated_at,
      });
    } catch (error) {
      console.error('[AgentWallet] recovery-escrow read error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /:wallet_id/escrow-target — item 11 : an agent with NO escrow
  // (installed from a fleet code before its human published a recovery anchor) reads the
  // PUBLIC half its linked human published from the phone, seals its own key to it and
  // escrows (POST /recovery-escrow). Agent API auth + ownership; returns only a public key.
  router.get('/:wallet_id/escrow-target', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      const wallet = req.agentWallet;
      if (!wallet || wallet.id !== wallet_id) {
        res.status(403).json({ error: 'Access denied - wallet_id mismatch' });
        return;
      }
      if (await readRecoveryEscrow(db, wallet_id)) {
        res.status(200).json({ wallet_id, escrowed: true, recovery_anchor_pubkey: null });
        return;
      }
      // Authoritative read: the link is the human's, and it may have changed since auth cached it.
      const snap = await db.collection('agent_wallets').doc(wallet_id).get();
      const current = snap.exists ? snap.data() as AgentWalletDocument : null;
      const humanUserId = current && current.status === 'active' ? current.linked_human_user_id ?? null : null;
      if (!humanUserId) {
        res.status(200).json({ wallet_id, escrowed: false, recovery_anchor_pubkey: null, reason: 'not_linked' });
        return;
      }
      const anchor = await readHumanRecoveryAnchor(db, humanUserId);
      res.status(200).json({
        wallet_id,
        escrowed: false,
        recovery_anchor_pubkey: anchor,
        ...(anchor === null ? { reason: 'human_anchor_not_published' } : {}),
      });
    } catch (error) {
      console.error('[AgentWallet] escrow-target error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /:wallet_id/recovery-anchor — the AGENT reads its own escrow's PUBLIC
  // anchor key (agent API auth + ownership) so it can re-seal the NEW key to the
  // SAME anchor when it rotates. Returns only the public half — never the
  // sealed blob (that is the linked human's to read) and never any key material.
  // 404 when no escrow exists (the agent then rotates without re-escrow).
  router.get('/:wallet_id/recovery-anchor', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      const wallet = req.agentWallet;
      if (!wallet || wallet.id !== wallet_id) {
        res.status(403).json({ error: 'Access denied - wallet_id mismatch' });
        return;
      }
      const escrow = await readRecoveryEscrow(db, wallet_id);
      if (!escrow) {
        res.status(404).json({ error: 'no_recovery_escrow' });
        return;
      }
      res.status(200).json({ wallet_id, recovery_anchor_pubkey: escrow.recovery_anchor_pubkey });
    } catch (error) {
      console.error('[AgentWallet] recovery-anchor read error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /:wallet_id/recovery-alarm — the daemon reports its wallet keystore is
  // present but its at-rest secret is ABSENT (or non-decrypting): the key is
  // locally unusable and, without an escrow, unrecoverable (, Atlas's exact
  // failure). Agent API auth + ownership. Carries NO secret/key material — only
  // the fact + reason + host label. Surfaced in the Command Center recovery view.
  router.post('/:wallet_id/recovery-alarm', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      const wallet = req.agentWallet;
      if (!wallet || wallet.id !== wallet_id) {
        res.status(403).json({ error: 'Access denied - wallet_id mismatch' });
        return;
      }
      const { reason, host } = req.body as { reason?: unknown; host?: unknown };
      if (!isValidRecoveryAlarmReason(reason)) {
        res.status(400).json({ error: 'reason must be one of at_rest_secret_missing|at_rest_secret_nondecrypting|keystore_missing' });
        return;
      }
      await raiseRecoveryAlarm(db, wallet_id, {
        reason,
        ...(typeof host === 'string' && host.length > 0 ? { host: host.slice(0, 120) } : {}),
        now: Date.now(),
      });
      res.status(200).json({ recorded: true });
    } catch (error) {
      console.error('[AgentWallet] recovery-alarm error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /:wallet_id/recovery-alarm/clear — the daemon reports its at-rest secret is healthy
  // again (recovered via re-key / restore), so any outstanding recovery alarm auto-clears from the
  // Command Center without manual intervention. Agent API auth + ownership. Idempotent:
  // 200 `{cleared:<bool>}` whether or not an alarm existed. Carries no key material.
  router.post('/:wallet_id/recovery-alarm/clear', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      const wallet = req.agentWallet;
      if (!wallet || wallet.id !== wallet_id) {
        res.status(403).json({ error: 'Access denied - wallet_id mismatch' });
        return;
      }
      const cleared = await clearRecoveryAlarm(db, wallet_id, { now: Date.now() });
      res.status(200).json({ cleared });
    } catch (error) {
      console.error('[AgentWallet] recovery-alarm clear error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =========================================================================
  // POST /accept-invite - Accept invite and link (wallet auth)
  // =========================================================================
  router.post('/accept-invite', async (req: Request, res: Response) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Missing wallet auth token' });
        return;
      }

      // Verify the v2 request-bound HMAC wallet-auth token. The mobile client
      // signs `base64(JSON).hexSignature` tokens (RelayAPIService.generateSignedToken);
      // the previous JSON.parse(base64(token)) shortcut never validated the
      // signature AND mis-read the v2 payload (it reads `sub`, not `user_id`),
      // so every real accept-after-biometric 401'd with "Invalid auth token".
      // Use the same shared verifier as the canonical authenticate() path.
      const token = authHeader.slice(7);
      const authResult = await verifyWalletAuthToken(token, req, { db, cache });
      if (!authResult.ok) {
        res.status(authResult.status).json({ error: authResult.error });
        return;
      }
      const userId = authResult.userId;

      const { invite_id } = req.body;
      if (!invite_id || typeof invite_id !== 'string') {
        res.status(400).json({ error: 'invite_id is required' });
        return;
      }

      // Item 5: the human may name the agent as they accept it. Optional; the
      // same rule as wallet creation (trimmed, 1..100 chars, no markup). A name
      // equal to the agent's current one changes nothing.
      let humanChosenName: string | null = null;
      if (req.body.agent_name !== undefined && req.body.agent_name !== null) {
        const nameCheck = validateAgentDisplayName(req.body.agent_name);
        if (!nameCheck.ok) {
          res.status(400).json({ error: nameCheck.error });
          return;
        }
        humanChosenName = nameCheck.value;
      }

      // Fetch invite
      const inviteDoc = await db.collection('agent_invites').doc(invite_id).get();
      if (!inviteDoc.exists) {
        res.status(404).json({ error: 'Invite not found' });
        return;
      }

      const invite = inviteDoc.data();
      if (!invite) {
        res.status(404).json({ error: 'Invite not found' });
        return;
      }

      // A connection-code link request (POST /:wallet_id/request-link) is bound
      // to the human who issued the code: ONLY that human may accept it. This
      // STRENGTHENS the anchor for code-originated requests without weakening it
      // for legacy email invites (which carry no for_human_user_id and stay
      // bearer-claimable exactly as before). It never lets an unlinked caller
      // self-authorize: acceptance still requires this human's wallet auth.
      if (invite.for_human_user_id && invite.for_human_user_id !== userId) {
        res.status(403).json({ error: 'not_your_link_request' });
        return;
      }

      // Check if expired (honors the invite's stamped expires_at: 7d standard,
      // 30d beneficiary; 7d fallback for legacy docs without the field).
      // Once the exact acceptance marker is durable, a retry must still be
      // able to finish its deterministic PE even if the wall clock crosses
      // expires_at between attempts. The transaction below cross-binds the
      // accepted user + wallet before reusing that marker.
      if (!invite.accepted_at && isInviteExpired(invite)) {
        res.status(410).json({ error: 'Invite has expired' });
        return;
      }

      // Fetch human wallet from wallets collection using user_id
      const walletsSnapshot = await db.collection('wallets')
        .where('user_id', '==', userId)
        .where('type', '==', 'human')
        .limit(2)
        .get();

      let humanWalletDoc;
      let humanWallet;
      let humanWalletId;

      if (walletsSnapshot.empty) {
        // Invite acceptance cannot invent an economically enumerable human
        // wallet from users.wallet_address. Registration must first pass the
        // canonical biometric-authenticated H/H+1 transaction.
        res.status(409).json({
          error: 'canonical_human_wallet_registration_required',
          migration: 'Complete POST /v1/wallet/human/register before accepting this invite.',
        });
        return;
      } else if (walletsSnapshot.size !== 1) {
        // Native human registration is one user -> one trust wallet. An
        // ambiguous duplicate must never choose an arbitrary beneficiary.
        res.status(409).json({
          error: 'canonical_human_wallet_registration_ambiguous',
          migration: 'Repair the native human-wallet registration index before accepting this invite.',
        });
        return;
      } else {
        humanWalletDoc = walletsSnapshot.docs[0];
        humanWallet = humanWalletDoc.data();
        humanWalletId = humanWalletDoc.id;
      }

      // B3 (2026-10-22): the acceptance identity check runs BEFORE anything is written. An
      // invite already accepted by another human (or another wallet of this human) is refused
      // here with no side effect — before 2026-10-22 the bind ran first, so after the first
      // human ended the link a second human replaying the same invite was BOUND as beneficiary
      // and only then refused. The bind transaction re-checks this authoritatively and writes
      // the acceptance marker in the same commit as the link (`invite` below), so a concurrent
      // acceptance cannot slip between this read and the bind.
      if (inviteAcceptanceRefusal(invite, {
        agentWalletId: invite.agent_wallet_id,
        humanUserId: userId,
        humanWalletId,
      }) !== null) {
        res.status(409).json({ error: 'beneficiary_link_identity_invalid' });
        return;
      }

      // Fetch agent wallet
      const agentWalletDoc = await db.collection('agent_wallets').doc(invite.agent_wallet_id).get();
      if (!agentWalletDoc.exists) {
        res.status(404).json({ error: 'Agent wallet not found' });
        return;
      }

      const agentWallet = agentWalletDoc.data() as AgentWalletDocument;

      // A different beneficiary is terminal. The same beneficiary is allowed
      // through the idempotent shared bind path so an ambiguous response can
      // finish the deterministic invite-acceptance PE.
      if (agentWallet.linked_human_wallet_id
        && agentWallet.linked_human_wallet_id !== humanWalletId) {
        res.status(409).json({ error: 'Agent already linked to another human' });
        return;
      }

      const now = Date.now();
      const humanAddress = humanWallet.address || null;
      const signingBonusPVT = 0;

      const inviteRelationship = await readValidatedBeneficiaryRelationship({
        db,
        wallet: agentWallet,
      });
      const agentShareBps = inviteRelationship.state === 'linked'
        ? inviteRelationship.agent_share_bps
        : DEFAULT_AGENT_BENEFICIARY_SHARE_BPS;
      if (agentShareBps === null) {
        res.status(409).json({ error: 'agent_beneficiary_share_bps_invalid' });
        return;
      }
      await bindAgentToHuman(deps, {
        wallet: agentWallet,
        humanWalletId,
        humanUserId: userId,
        humanAddress,
        agentShareBps,
        invite: { inviteId: invite_id, acceptedAtMs: now },
      });

      // Durable/idempotent acceptance marker. A fresh bind wrote it in the same
      // transaction as the link and its PE (B3); this re-read adopts that marker
      // (or writes it when the bind was the idempotent already-linked path, which
      // writes nothing) and lets a retry finish invite_accepted without creating
      // another link or trusting the stale invite payload.
      const inviteRef = db.collection('agent_invites').doc(invite_id);
      let acceptedAt = now;
      await db.runTransaction(async (txn) => {
        const currentSnap = await txn.get(inviteRef);
        const current = currentSnap.exists
          ? currentSnap.data() as Record<string, unknown>
          : null;
        if (!current || current.agent_wallet_id !== invite.agent_wallet_id) {
          throw new BeneficiaryLinkConflictError('beneficiary_link_identity_invalid');
        }
        if (current.accepted_at !== null && current.accepted_at !== undefined) {
          if (!Number.isSafeInteger(current.accepted_at)
            || current.accepted_by_user_id !== userId
            || current.accepted_by_wallet_id !== humanWalletId) {
            throw new BeneficiaryLinkConflictError('beneficiary_link_identity_invalid');
          }
          acceptedAt = current.accepted_at as number;
          return;
        }
        txn.update(inviteRef, {
          status: 'accepted',
          accepted_at: acceptedAt,
          accepted_by_user_id: userId,
          accepted_by_wallet_id: humanWalletId,
        });
      });

      // No retroactive signing bonus is transferred. Prior PEs retain their
      // sealed record-time recipients; the beneficiary link affects only PEs
      // recorded after this boundary.

      // Item 5: the human's chosen name, written AFTER the link is durable (a
      // refused bind renames nothing) and BEFORE the invite_accepted PE, so the
      // new PE seals the name the human chose. Display metadata only: no PE of
      // its own, no sealed PE touched. A retry finds the name already set.
      let agentDisplayName = agentWallet.display_name;
      if (humanChosenName !== null && humanChosenName !== agentWallet.display_name) {
        await applyHumanAgentName(db, invite.agent_wallet_id, humanChosenName);
        agentDisplayName = humanChosenName;
      }

      // PE for invite acceptance - every consequential action = one PE.
      // The chain is keyed on agentId, which matches `user_id` on the stored
      // PE; for human wallets that's the user's id (so all of their PEs
      // share one chain). Counterparty is the inviting agent's address.
      //
      // Policy-sealed record-only, symmetric with the agent_linked_to_human /
      // agent_unlinked_from_human link PEs: accepting a
      // beneficiary invite is a link (ignition), not earnable work. The
      // compatibility zero below is not economic authority. Without this
      // an unlink → fresh-invite → re-accept cycle re-accrued invite_accepted
      // (standard weight 2) each time. The link's value is its prospectively
      // configured routing (20/80 by default, 5-50% agent share) plus the 2x
      // human-trust bonus on the agent's future verified work.
      try {
        // The one invite_accepted emitter (shared with the fleet-code link).
        await recordInviteAcceptedPE(deps, {
          humanWalletId,
          humanUserId: userId,
          humanAddress,
          inviteId: invite_id,
          agentWalletId: invite.agent_wallet_id,
          agentDisplayName,
          agentAddress: agentWallet.address,
          acceptedAt,
        });
      } catch (peErr) {
        // Link and acceptance marker are durable. Surface a retryable failure;
        // the same request reuses acceptedAt + deterministic PE id and cannot
        // create a second link or chain event.
        console.error('[AgentWallet] Failed to record invite_accepted PE:', peErr);
        res.status(503).json({
          error: 'invite_acceptance_pe_pending',
          retry_with_same_invite_id: true,
        });
        return;
      }

      res.json({
        success: true,
        agent_name: agentDisplayName,
        signing_bonus_pvt: signingBonusPVT,
        message: `Successfully linked with ${agentDisplayName}`,
      });

    } catch (error) {
      console.error('[AgentWallet] Accept invite error:', error);
      if (error instanceof BeneficiaryLinkConflictError) {
        res.status(409).json({ error: error.code });
        return;
      }
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =========================================================================
  // GET /:wallet_id/balances - Check current ETH and USDC balances (API key auth)
  // =========================================================================
  router.get('/:wallet_id/balances', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;

      // Ownership guard (defense-in-depth, matches the sibling /:wallet_id/inbox
      // route): a caller reads only its OWN wallet's balances. The surfaced values
      // are public on-chain balances (balanceOf, queryable by anyone), so this is
      // low-severity — but the self-scoped contract is what every caller already
      // relies on (the SDK sends this.config.walletId; the MCP get_pvt_balance tool
      // documents "Self-scoped: an agent reads only its own wallet"), so enforce it
      // here rather than leaving the two sibling routes inconsistent. Fires BEFORE
      // any target read or RPC.
      const aw = req.agentWallet;
      if (!aw || aw.id !== wallet_id) {
        res.status(403).json({ error: 'Access denied - wallet_id mismatch' });
        return;
      }

      // Fetch wallet document
      const walletDoc = await db.collection('agent_wallets').doc(wallet_id).get();
      if (!walletDoc.exists) {
        res.status(404).json({ error: 'Wallet not found' });
        return;
      }

      const wallet = walletDoc.data() as AgentWalletDocument;
      const walletAddress = wallet.address;

      // Check Redis cache (30 second TTL)
      // Versioned to exclude stale cached payloads. v3 bumps past the v2 shape
      // that hardcoded pvt9.balance:null / PVT9_UNCONFIGURED — those cached
      // payloads must not be served now that PVT9 is read on-chain.
      const cacheKey = `balance:v3:${wallet_id}`;
      const cached = await deps.cache.get<string>(cacheKey);

      if (cached) {
        // Upstash auto-deserializes JSON on read, so `cached` is already the
        // stored object — JSON.parse would choke on "[object Object]". Parse
        // only if the client handed back a raw string (auto-deser off / legacy).
        const cachedData = typeof cached === 'string' ? JSON.parse(cached) : cached;
        res.json({
          ...cachedData,
          cached: true,
        });
        return;
      }

      // Query balances over the Base FallbackProvider (env primary + public
      // failover; BASE_RPC_URL is required at boot).
      const provider = getChainProvider('base');

      const USDC_ADDRESS = PVT9_BASE_CONFIG.assets.usdc.address;

      // ERC-20 ABI for balanceOf
      const ERC20_ABI = [
        'function balanceOf(address owner) view returns (uint256)',
        'function decimals() view returns (uint8)',
      ];

      // Query ETH balance
      const ethBalanceWei = await provider.getBalance(walletAddress);
      const ethBalance = ethers.formatEther(ethBalanceWei);

      // Query USDC balance (6 decimals)
      const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
      const usdcBalanceRaw = await usdcContract.balanceOf(walletAddress);
      const usdcBalance = ethers.formatUnits(usdcBalanceRaw, 6);

      // Query PVT9 balance (18 decimals) on the LIVE successor kernel.
      // The kernel has real supply (this endpoint hardcoded
      // balance:null / PVT9_UNCONFIGURED against a token holding 1,185+ PVT — the
      // audit's §6 gap). The token IS configured; read it on-chain exactly as
      // /v1/pvt/balance/:address does, rather than reporting a fixed sentinel.
      const PVT9_ADDRESS = PVT9_BASE_CONFIG.assets.pvt9.address;
      const pvt9Contract = new ethers.Contract(PVT9_ADDRESS, ERC20_ABI, provider);
      const pvt9Read = await readPvt9Balance(
        (owner) => pvt9Contract.balanceOf(owner) as Promise<bigint>,
        walletAddress,
      );

      const now = Date.now();
      const result = {
        eth: ethBalance,
        usdc: usdcBalance,
        pvt9: {
          status: PVT9_BASE_CONFIG.status,
          address: PVT9_ADDRESS,
          balance: pvt9Read.balance,
          available: pvt9Read.available,
          ...(pvt9Read.reason ? { reason: pvt9Read.reason } : {}),
        },
        chain: 'base',
        cached: false,
        cached_at: now,
      };

      // Cache for 30 seconds
      await deps.cache.set(cacheKey, JSON.stringify(result), 30).catch(() => {
        // Cache failure is non-fatal
      });

      res.json(result);

    } catch (error) {
      console.error('[AgentWallet] Get balances error:', error);
      res.status(500).json({ error: 'Failed to fetch balances' });
    }
  });

  // =========================================================================
  // GET /:wallet_id/inbox - The agent inbox (, WS D2). A per-wallet,
  // cursor-read feed of the SAME targeted interaction events D1 pushes — so a
  // cron-driven / Hermes-class agent that cannot host a webhook still hears its
  // counterparties without polling every entity read. Agent API-key auth +
  // ownership; a caller can only ever read its OWN inbox.
  //   ?cursor=<last event_id>  (optional; omit for the oldest unread page)
  //   ?limit=<1..200>          (optional; default 50)
  // =========================================================================
  router.get('/:wallet_id/inbox', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      const aw = req.agentWallet;
      if (!aw || aw.id !== wallet_id) {
        res.status(403).json({ error: 'Access denied - wallet_id mismatch' });
        return;
      }
      const cursor = typeof req.query.cursor === 'string' && req.query.cursor.length > 0
        ? req.query.cursor
        : null;
      const rawLimit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : NaN;
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, rawLimit), INBOX_MAX_LIMIT) : undefined;
      const result = await readInbox(db, wallet_id, { cursor, limit });
      res.json(result);
    } catch (error) {
      console.error('[AgentWallet] Inbox read error:', error);
      res.status(500).json({ error: 'Failed to read inbox' });
    }
  });

  // =========================================================================
  // POST /:wallet_id/swap - Execute token swap via 0x (API key auth)
  // =========================================================================
  // =========================================================================
  // POST /:wallet_id/swap - Get an unsigned 0x swap quote (NO signing)
  //
  // Phase 3 (G-5): the previous version of this endpoint accepted the
  // agent's private key in the request body and signed/broadcast on the
  // agent's behalf. That violates the Phase 2.8 invariant that the relay
  // never holds private key material. It also exposed the key in any
  // request-body logging path (Cloud Run access logs, error reporting,
  // etc.) and made the relay a high-value swap-frontrunning target.
  //
  // The new shape: this endpoint returns a 0x quote bundled with the
  // unsigned transaction calldata. The agent SDK signs it locally with
  // its own keypair (the one it generated during PoP wallet creation)
  // and broadcasts directly to its preferred RPC. Once broadcast, the
  // SDK calls POST /:wallet_id/swap/record with the resulting tx_hash -
  // the relay verifies it on-chain via verifyTransfer / verifyEvmContractCall
  // and writes the PE.
  // =========================================================================
  router.post('/:wallet_id/swap', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      const { fromToken, toToken, amount, slippageBps } = req.body;

      // F50/F60 (S2 2026-09-10): ownership guard. This was the one remaining
      // /:wallet_id sibling with no self-scope check (closed only
      // /balances) — so any agent API key could POST /swap for ANY wallet_id,
      // burning the relay's paid 0x quota against another wallet's address and
      // using quote success/failure as a balance oracle. Fire BEFORE the target
      // read or any upstream call, matching every other /:wallet_id route (403).
      if (!req.agentWallet || req.agentWallet.id !== wallet_id) {
        res.status(403).json({ error: 'Access denied - wallet_id mismatch' });
        return;
      }

      // F60: per-wallet limiter on paid 0x quote fetches (10/min). The global
      // 500/2s bucket is too coarse to protect the 0x API quota.
      const swapLimit = await cache.checkRateLimit(`rl:swap:quote:${wallet_id}`, 10, 60);
      if (!swapLimit.allowed) {
        res.status(429).json({
          error: 'Rate limit exceeded. Max 10 swap quotes per minute.',
          retry_after: swapLimit.retryAfter,
        });
        return;
      }

      // Phase 3 (G-5): explicitly reject any attempt to pass a private key.
      // This catches old SDK clients pre-migration and surfaces a clear
      // 400 instead of silently dropping the field.
      if ('privateKey' in req.body || 'private_key' in req.body) {
        res.status(400).json({
          error: 'private_key is no longer accepted. Sign the returned unsigned tx locally and broadcast yourself.',
          migration_guide: 'See provian-agent-sdk v2 release notes for the swap quote+sign+broadcast flow.',
        });
        return;
      }

      // Validate inputs
      if (!fromToken || !toToken || !amount) {
        res.status(400).json({ error: 'fromToken, toToken, and amount are required' });
        return;
      }

      if (slippageBps !== undefined && (slippageBps < 0 || slippageBps > 10000)) {
        res.status(400).json({ error: 'slippageBps must be between 0 and 10000' });
        return;
      }

      // Fetch wallet document
      const walletDoc = await db.collection('agent_wallets').doc(wallet_id).get();
      if (!walletDoc.exists) {
        res.status(404).json({ error: 'Wallet not found' });
        return;
      }

      const wallet = walletDoc.data() as AgentWalletDocument;
      const walletAddress = wallet.address;

      // Only configured non-PVT assets are quoteable. PVT9 has no address and
      // a legacy environment variable can never make it a swap asset.
      const TOKEN_ADDRESSES: Record<string, string> = {
        'USDC': PVT9_BASE_CONFIG.assets.usdc.address,
        'WETH': '0x4200000000000000000000000000000000000006',
      };

      const fromTokenAddress = TOKEN_ADDRESSES[fromToken.toUpperCase()];
      const toTokenAddress = TOKEN_ADDRESSES[toToken.toUpperCase()];

      if (!fromTokenAddress || !toTokenAddress) {
        res.status(400).json({
          error: 'Invalid token. Supported tokens: USDC, WETH',
          supported_tokens: Object.keys(TOKEN_ADDRESSES),
        });
        return;
      }

      // Get quote from 0x API
      const zeroxApiKey = process.env.ZEROX_API_KEY;
      // finding (a): this used to read PROVIAN_TREASURY_ADDRESS (now KEEPER_FORBIDDEN_SIGNER_ADDRESS), which is
      // a KEEPER-IDENTITY variable (three other consumers put it in a forbidden
      // set so a keeper key can never be the treasury key) and on the live relay
      // resolved to the key-exposed legacy EOA. A payout destination needs its
      // own variable. See core/config/live-value-recipients.ts.
      const swapFeeRecipient = process.env.SWAP_FEE_RECIPIENT;

      if (!zeroxApiKey) {
        res.status(500).json({ error: '0x API key not configured' });
        return;
      }

      if (!swapFeeRecipient) {
        res.status(500).json({ error: 'Swap fee recipient not configured' });
        return;
      }

      // Request-time gate. The boot guard passes VACUOUSLY when this var is
      // unset, so the check runs again here, where the value actually moves.
      try {
        assertLiveValueRecipient('SWAP_FEE_RECIPIENT', swapFeeRecipient);
      } catch (err) {
        console.error('[agent-wallet] swap quote refused:', err instanceof Error ? err.message : err);
        res.status(500).json({
          error: 'Swap fee recipient is not a permitted value destination',
          code: 'FORBIDDEN_VALUE_RECIPIENT',
        });
        return;
      }

      // Money-safety pin (2026-09-25): the recipient must EQUAL the Provian treasury, not merely
      // avoid the exposed EOA. Shared with the human 0x proxy (core/swap/swap-fees.ts).
      try {
        resolveEvmSwapFeeRecipient(process.env);
      } catch (err) {
        console.error('[agent-wallet] swap quote refused:', err instanceof Error ? err.message : err);
        res.status(503).json({
          error: 'Swap fee recipient is not the Provian treasury',
          code: 'SWAP_FEE_RECIPIENT_NOT_TREASURY',
        });
        return;
      }

      // Build 0x Swap API v2 quote request (allowance-holder flow) with the
      // integrator fee (0.25% = 25 bps). The 0x v1 API was retired in early
      // 2025 and now 404s; v2 requires the `0x-version: v2` header and moved
      // the fee from affiliateAddress/affiliateFee to the
      // swapFeeRecipient/swapFeeBps/swapFeeToken triple. The fee is taken on
      // the buy token (the standard v2 monetization path). This mirrors the
      // already-migrated /api/proxy/zerox proxy (server.ts) and the mobile
      // SwapEngine.getEVMQuote allowance-holder integration.
      const quoteParams = new URLSearchParams({
        chainId: '8453', // Base mainnet
        sellToken: fromTokenAddress,
        buyToken: toTokenAddress,
        sellAmount: amount,
        taker: walletAddress,
        swapFeeRecipient,
        swapFeeBps: '25', // 25 bps = 0.25%
        swapFeeToken: toTokenAddress, // fee collected on the buy token
        slippageBps: (slippageBps || 50).toString(),
      });

      const quoteUrl = `https://api.0x.org/swap/allowance-holder/quote?${quoteParams.toString()}`;

      // H-4 (audit 2026-05-11) + bound the upstream exchange with ONE
      // 10 s deadline across connect + headers + the WHOLE body, and cap the body.
      // The old AbortController timer was cleared at the response headers, so the
      // `.json()` reads below were unbounded in time and size; fetchBounded
      // returns a Response whose body is already fully read.
      // Type sidestep: Express's Response shadows the fetch Response in this
      // module's scope, so we use Awaited<ReturnType<typeof fetch>>.
      let quoteResponse: Awaited<ReturnType<typeof fetch>>;
      try {
        quoteResponse = await fetchBounded(quoteUrl, {
          headers: {
            '0x-api-key': zeroxApiKey,
            '0x-version': 'v2',
          },
        }, { deadlineMs: 10_000, maxBytes: ZEROX_QUOTE_MAX_BYTES });
      } catch (err) {
        if (err instanceof DeadlineExceededError) {
          res.status(504).json({ error: 'Upstream timed out', code: 'UPSTREAM_TIMEOUT' });
          return;
        }
        if (err instanceof ResponseTooLargeError) {
          res.status(502).json({ error: 'Upstream response too large', code: 'UPSTREAM_RESPONSE_TOO_LARGE' });
          return;
        }
        throw err;
      }

      if (!quoteResponse.ok) {
        const errorData = await quoteResponse.json().catch(() => ({}));
        res.status(quoteResponse.status).json({
          error: '0x API error',
          details: errorData,
        });
        return;
      }

      // 0x v2 nests the executable tx under `transaction`, returns amounts at
      // the top level, and reports the integrator fee under `fees.integratorFee`.
      const quote = await quoteResponse.json() as {
        liquidityAvailable?: boolean;
        sellAmount: string;
        buyAmount: string;
        transaction?: {
          to: string;
          data: string;
          value: string;
          gas: string;
          gasPrice: string;
        };
        fees?: {
          integratorFee?: { amount?: string; token?: string } | null;
          integratorFees?: Array<{ amount?: string; token?: string }> | null;
          zeroExFee?: { amount?: string; token?: string } | null;
        };
      };

      // v2 returns HTTP 200 with liquidityAvailable:false (and no transaction)
      // when it can't route the pair. Fail fast rather than handing back an
      // unsigned_tx of null fields the agent would try to sign and broadcast.
      if (quote.liquidityAvailable === false || !quote.transaction) {
        res.status(422).json({
          error: 'No liquidity available for this swap pair',
          code: 'NO_LIQUIDITY',
        });
        return;
      }

      // Refuse a quote that does not carry the 25 bps fee in the buy token to the treasury —
      // the same verifier the human 0x proxy runs.
      try {
        verifyZeroXQuoteFee(quote, { buyToken: toTokenAddress, feeRecipient: swapFeeRecipient });
      } catch (err) {
        if (err instanceof SwapFeeError) {
          console.error(`[agent-wallet] swap quote refused: ${err.code} ${err.message}`);
          res.status(err.status).json({ error: err.message, code: err.code });
          return;
        }
        throw err;
      }

      // Phase 3 (G-5): return the unsigned tx - the agent SDK signs and
      // broadcasts locally. PE recording happens on a follow-up call to
      // POST /:wallet_id/swap/record once the agent has the tx_hash.
      res.json({
        chain_id: 8453,
        from_token: fromToken.toUpperCase(),
        to_token: toToken.toUpperCase(),
        from_token_address: fromTokenAddress,
        to_token_address: toTokenAddress,
        sell_amount: quote.sellAmount,
        buy_amount: quote.buyAmount,
        affiliate_fee: quote.fees?.integratorFee?.amount || '0',
        unsigned_tx: {
          to: quote.transaction.to,
          data: quote.transaction.data,
          value: quote.transaction.value,
          gas: quote.transaction.gas,
          gasPrice: quote.transaction.gasPrice,
        },
        instructions: 'Sign this transaction with your wallet private key, broadcast to Base mainnet, then call POST /:wallet_id/swap/record with the resulting tx_hash to record the PE.',
      });

    } catch (error) {
      console.error('[AgentWallet] Swap quote error:', error);
      res.status(500).json({
        error: 'Failed to fetch swap quote',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // =========================================================================
  // POST /:wallet_id/swap/record - Record a completed swap PE after on-chain
  // verification.
  //
  // Phase 3 (G-5): companion to the new quote-only swap endpoint. The
  // agent SDK signs and broadcasts the swap locally, then submits the
  // resulting tx_hash here. The relay verifies the tx exists, succeeded,
  // and was sent from the wallet's address before recording the PE.
  // =========================================================================
  router.post('/:wallet_id/swap/record', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      const { tx_hash, from_token, to_token, from_amount, to_amount, fee_amount } = req.body;

      if (!tx_hash || typeof tx_hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(tx_hash)) {
        res.status(400).json({ error: 'tx_hash is required (0x + 64 hex chars)' });
        return;
      }
      if (!from_token || !to_token || !from_amount || !to_amount) {
        res.status(400).json({ error: 'from_token, to_token, from_amount, to_amount are required' });
        return;
      }

      // Ownership guard + on-chain sender verification + atomic PE recording all
      // live in recordAgentSwapPE so they can be unit-tested (Fix F1). The handler
      // passes req.agentWallet (the authenticated wallet) - the helper checks it
      // matches wallet_id, so a forged swap PE can no longer be attributed to an
      // arbitrary wallet.
      const result = await recordAgentSwapPE(deps, {
        walletId: wallet_id,
        agentWallet: req.agentWallet,
        txHash: tx_hash,
        fromToken: from_token,
        toToken: to_token,
        fromAmount: from_amount,
        toAmount: to_amount,
        feeAmount: fee_amount,
      });

      if (!result.ok) {
        res.status(result.status).json(
          result.reason ? { error: result.error, reason: result.reason } : { error: result.error },
        );
        return;
      }

      res.json({
        pe_id: result.peId,
        tx_hash,
      });
    } catch (error) {
      console.error('[AgentWallet] Swap record error:', error);
      res.status(500).json({
        error: 'Failed to record swap PE',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // =========================================================================
  // POST /:wallet_id/transfer/record - Record a VERIFIED raw transfer PE after
  // an on-chain transfer the agent broadcast itself (the verified counterpart
  // to the SDK's slice-1 self-asserted reportAction path). Same API-key auth +
  // ownership + atomic-PE pattern as swap/record; adds on-chain amount
  // verification (ERC-20) and a tx_hash idempotency guard.
  // =========================================================================
  router.post('/:wallet_id/transfer/record', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      const { tx_hash, chain, currency, to, amount_atomic } = req.body;

      if (!tx_hash || typeof tx_hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(tx_hash)) {
        res.status(400).json({ error: 'tx_hash is required (0x + 64 hex chars)' });
        return;
      }
      if (!chain || !currency || !to || amount_atomic === undefined || amount_atomic === null) {
        res.status(400).json({ error: 'chain, currency, to, amount_atomic are required' });
        return;
      }
      if (typeof to !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(to)) {
        res.status(400).json({ error: 'to must be a 0x-prefixed 20-byte address' });
        return;
      }
      if (typeof amount_atomic !== 'string' || !/^[0-9]+$/.test(amount_atomic)) {
        res.status(400).json({ error: 'amount_atomic must be a non-negative integer string (atomic units)' });
        return;
      }

      const result = await recordAgentTransferPE(deps, {
        walletId: wallet_id,
        agentWallet: req.agentWallet,
        txHash: tx_hash,
        chain: String(chain),
        currency: String(currency) as TransferCurrency,
        to,
        amountAtomic: amount_atomic,
      });

      if (!result.ok) {
        res.status(result.status).json(
          result.reason ? { error: result.error, reason: result.reason } : { error: result.error },
        );
        return;
      }

      res.json({
        pe_id: result.peId,
        tx_hash,
        verified: result.verified,
        ...(result.idempotent ? { idempotent: true } : {}),
      });
    } catch (error) {
      console.error('[AgentWallet] Transfer record error:', error);
      res.status(500).json({
        error: 'Failed to record transfer PE',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // =========================================================================
  // POST /:wallet_id/burn/record - Record a VERIFIED PVT burn (work package burn
  // substrate). The demand-side counterpart to transfer/record: the agent
  // broadcasts a PVT burn (Transfer to 0x0) itself, then records it here. Same
  // API-key auth + ownership + burn-tx idempotency; adds on-chain burn
  // verification (verifyEvmPvtBurn). Records a verified row in pvt_burn_records
  // (NOT a PE — see recordAgentBurn; mints 0). LIVE: PVT9 has real supply and the
  // verifier is active (ENABLE_PVT_PRINCIPAL=true), so a real burn succeeds here.
  // =========================================================================
  router.post('/:wallet_id/burn/record', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      const { tx_hash, chain, amount_atomic } = req.body;

      if (!tx_hash || typeof tx_hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(tx_hash)) {
        res.status(400).json({ error: 'tx_hash is required (0x + 64 hex chars)' });
        return;
      }
      if (!chain || amount_atomic === undefined || amount_atomic === null) {
        res.status(400).json({ error: 'chain and amount_atomic are required' });
        return;
      }
      if (typeof amount_atomic !== 'string' || !/^[0-9]+$/.test(amount_atomic) || amount_atomic === '0') {
        res.status(400).json({ error: 'amount_atomic must be a positive integer string (atomic 18-decimal PVT units)' });
        return;
      }

      const result = await recordAgentBurn(deps, {
        walletId: wallet_id,
        agentWallet: req.agentWallet,
        txHash: tx_hash,
        chain: String(chain),
        amountAtomic: amount_atomic,
        // `await_finality: true` (the wire name predates ) holds the request open
        // until the burn is MINED and accepted at inclusion (or the relay's wait bound), so the
        // caller records in ONE call instead of polling. Finality is then the relay's job.
        waitMs: req.body?.await_finality === true ? BURN_RECORD_MAX_WAIT_MS : 0,
      });

      if (!result.ok) {
        // Ops observability (Part D): count a burn-replay 409 (same tx_hash recorded twice).
        // Structure-only — no tx or wallet identity in the counter.
        if (result.status === 409) bumpOpsCounter('burn.replay_409');
        res.status(result.status).json(
          result.reason ? { error: result.error, reason: result.reason } : { error: result.error },
        );
        return;
      }

      res.json({
        burn_id: result.burnId,
        tx_hash,
        verified: result.verified,
        // 'provisional' = accepted at inclusion, 12-block finality check pending
        // (a burn that fails it is revoked with its benefits); 'final' = past finality.
        ...(result.finality ? { finality: result.finality } : {}),
        ...(result.idempotent ? { idempotent: true } : {}),
      });
    } catch (error) {
      console.error('[AgentWallet] Burn record error:', error);
      res.status(500).json({
        error: 'Failed to record burn',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // =========================================================================
  // POST /:wallet_id/present - Produce a burn-backed presentation (burn-to-present,
  // agent side). Consumes a verified on-chain PVT burn through the GLOBAL
  // single-use burn_consumptions ledger and returns a signed, requester-bound,
  // fresh, single-use presentation (pe_fact or reputation). Symmetric with the
  // human POST /v1/wallet/present. Same agent auth + ownership. See
  // core/presentation/service.ts.
  // =========================================================================
  // §2.5: the agent's own live vocabulary — what a reputation presentation would disclose.
  router.get('/:wallet_id/vocabulary', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      const aw = req.agentWallet;
      if (!aw || aw.id !== wallet_id) {
        res.status(403).json({ error: 'Access denied - wallet_id mismatch' });
        return;
      }
      const facts = await computeActorVocabulary({ db }, buildAgentPrincipal(aw));
      res.json({ ...selfViewOfVocabulary(facts), standing_prefix: STANDING_FIELD_PREFIX });
    } catch (error) {
      // item 2: a source that could not be read is unavailable — never a zero.
      if (isVocabularyUnavailableError(error)) {
        res.status(503).json({ error: 'vocabulary_source_unavailable', source: error.source });
        return;
      }
      console.error('[AgentWallet] vocabulary error:', error);
      res.status(500).json({ error: 'Failed to compute vocabulary' });
    }
  });

  // §2.1 — an agent asks its LINKED HUMAN to approve a described action. The
  // description text goes only to that human (Tier-3); the sealed approval PE will
  // carry only sha256(description). The agent later cites the approval PE (`pe:`).
  router.post('/:wallet_id/request-approval', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      const aw = req.agentWallet;
      if (!aw || aw.id !== wallet_id) {
        res.status(403).json({ error: 'Access denied - wallet_id mismatch' });
        return;
      }
      const humanUserId = (aw as { linked_human_user_id?: string | null }).linked_human_user_id ?? '';
      if (!humanUserId) {
        res.status(409).json({ error: 'no linked human to approve this request', reason: 'link_a_human_first' });
        return;
      }
      const built = buildApprovalRequest({
        agentWalletId: wallet_id,
        humanUserId,
        actionDescription: typeof req.body?.action_description === 'string' ? req.body.action_description : '',
        subjectPeId: typeof req.body?.subject_pe_id === 'string' ? req.body.subject_pe_id : null,
        nowMs: Date.now(),
      });
      if (!built.ok) {
        res.status(400).json({ error: built.error });
        return;
      }
      await writeApprovalRequest(db, built.record);
      await pushApprovalRequestToHuman(db, humanUserId, built.record); // best-effort
      res.status(201).json({ request: toAgentFacingRequest(built.record) });
    } catch (error) {
      console.error('[AgentWallet] request-approval error:', error);
      res.status(500).json({ error: 'Failed to create approval request' });
    }
  });

  // §2.1 — the agent polls its own approval requests (agent-facing: NEVER the text).
  router.get('/:wallet_id/approval-requests', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      const aw = req.agentWallet;
      if (!aw || aw.id !== wallet_id) {
        res.status(403).json({ error: 'Access denied - wallet_id mismatch' });
        return;
      }
      const statusFilter = typeof req.query.status === 'string'
        && ['pending', 'satisfied', 'expired'].includes(req.query.status)
        ? (req.query.status as ApprovalRequestStatus) : undefined;
      const rows = await listRequestsForAgent(db, wallet_id, statusFilter);
      res.json({ requests: rows.map(toAgentFacingRequest) });
    } catch (error) {
      console.error('[AgentWallet] approval-requests error:', error);
      res.status(500).json({ error: 'Failed to list approval requests' });
    }
  });

  // §an agent asks its LINKED HUMAN to receive a burn-backed presentation
  // REMOTELY (not co-present; QR stays the in-person path). The human composes the
  // challenge; the agent then presents via the existing /present route and posts
  // the token back. The optional `note` is Tier-3 (this human only), never in a PE.
  router.post('/:wallet_id/presentation-request', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      const aw = req.agentWallet;
      if (!aw || aw.id !== wallet_id) {
        res.status(403).json({ error: 'Access denied - wallet_id mismatch' });
        return;
      }
      const humanUserId = (aw as { linked_human_user_id?: string | null }).linked_human_user_id ?? '';
      if (!humanUserId) {
        res.status(409).json({ error: 'no linked human to present to', reason: 'link_a_human_first' });
        return;
      }
      const built = buildPresentationRequest({
        agentWalletId: wallet_id,
        humanUserId,
        tier: req.body?.tier,
        note: req.body?.note,
        nowMs: Date.now(),
      });
      if (!built.ok) {
        res.status(400).json({ error: built.error });
        return;
      }
      await writePresentationRequest(db, built.record);
      await pushPresentationRequestToHuman(db, humanUserId, built.record); // best-effort
      res.status(201).json({ request: toAgentFacingPresentationRequest(built.record) });
    } catch (error) {
      console.error('[AgentWallet] presentation-request error:', error);
      res.status(500).json({ error: 'Failed to create presentation request' });
    }
  });

  // §the agent polls its own presentation requests (agent-facing: NEVER the note).
  router.get('/:wallet_id/presentation-requests', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      const aw = req.agentWallet;
      if (!aw || aw.id !== wallet_id) {
        res.status(403).json({ error: 'Access denied - wallet_id mismatch' });
        return;
      }
      const statusFilter = typeof req.query.status === 'string'
        && ['requested', 'challenged', 'presented', 'verified', 'declined', 'expired'].includes(req.query.status)
        ? (req.query.status as PresentationRequestStatus) : undefined;
      const rows = await listPresentationRequestsForAgent(db, wallet_id, statusFilter);
      res.json({ requests: rows.map(toAgentFacingPresentationRequest) });
    } catch (error) {
      console.error('[AgentWallet] presentation-requests error:', error);
      res.status(500).json({ error: 'Failed to list presentation requests' });
    }
  });

  // §the agent posts the token it produced via the EXISTING /present route
  // back to a `challenged` request. Ownership-guarded + 409 on a wrong-status request.
  router.post('/:wallet_id/presentation-requests/:request_id/present', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id, request_id } = req.params;
      const aw = req.agentWallet;
      if (!aw || aw.id !== wallet_id) {
        res.status(403).json({ error: 'Access denied - wallet_id mismatch' });
        return;
      }
      // verify-at-submit: the remote channel is asynchronous — the absent human
      // returns long after the ≤15-min token has expired, so the human cannot re-verify
      // it. Verify the FRESH token here, against THIS request's own composed
      // audience/challenge/predicates, and persist the authoritative verdict for the
      // human to read. Fails closed to `invalid` on any decode/verify failure; never
      // blocks recording the presentation (the burn already happened, and an
      // unverifiable presentation is honestly recorded as invalid).
      const token = req.body?.presentation_token;
      let submitVerdict: 'valid' | 'invalid' | undefined;
      let submitPredicateResults: unknown[] | undefined;
      if (typeof token === 'string' && token.length > 0) {
        const current = await getPresentationRequest(db, request_id);
        if (current && current.status === 'challenged') {
          const material = loadCommerceAttestationKeys(process.env);
          const fresh = await verifyFreshPresentationToken(
            { token, audience: current.audience, challenge: current.challenge, predicates: current.predicates, challengeEnvelope: current.challenge_envelope ?? null },
            // item 3: pe_fact verifies against the canonical PEAnchor, as the public route does.
            { publicKeys: material.ok ? material.keys : [], peAnchorContract: canonicalPeAnchorReadContract() },
          );
          submitVerdict = fresh.verdict;
          submitPredicateResults = fresh.predicate_results;
        }
      }
      const result = await recordPresentationForRequest(db, {
        requestId: request_id,
        agentWalletId: wallet_id,
        burnId: req.body?.burn_id,
        presentationToken: token,
        verdict: submitVerdict,
        predicateResults: submitPredicateResults,
        nowMs: Date.now(),
      });
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.json({ request: toAgentFacingPresentationRequest(result.record) });
    } catch (error) {
      console.error('[AgentWallet] presentation-request present error:', error);
      res.status(500).json({ error: 'Failed to record presentation' });
    }
  });

  // an agent requester's SIGNED challenge. Agent API auth + ownership; the relay signs the
  // envelope with the Provian presentation key: requester = { type:'wallet', id, address }.
  router.post('/:wallet_id/present/challenge', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      const aw = req.agentWallet;
      if (!aw || aw.id !== wallet_id) {
        res.status(403).json({ error: 'Access denied - wallet_id mismatch' });
        return;
      }
      const principal = buildAgentPrincipal(aw);
      const issued = issueWalletChallengeFromRequest({ walletId: principal.walletId, address: principal.address }, req.body);
      if (!issued.ok) {
        res.status(issued.status).json({ error: issued.error });
        return;
      }
      res.json({ challenge: issued.envelope });
    } catch (error) {
      console.error('[AgentWallet] Challenge error:', error);
      res.status(500).json({ error: 'Failed to issue challenge' });
    }
  });

  router.post('/:wallet_id/present/preflight', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const aw=req.agentWallet;
      if(!aw || aw.id !== req.params.wallet_id) { res.status(403).json({error:'Access denied - wallet_id mismatch'}); return; }
      const result=await preflightPresentationFromRequest({db},buildAgentPrincipal(aw),req.body);
      res.setHeader('Cache-Control','no-store');
      if(!result.ok) {res.status(result.status).json({error:result.error,reason:result.reason});return;}
      res.json({ok:true});
    } catch {res.status(503).json({error:'presentation_preflight_unavailable'});}
  });

  router.post('/:wallet_id/present', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      const aw = req.agentWallet;
      if (!aw || aw.id !== wallet_id) {
        res.status(403).json({ error: 'Access denied - wallet_id mismatch' });
        return;
      }
      const result = await producePresentationFromRequest(
        { db },
        buildAgentPrincipal(aw),
        req.body,
      );
      if (!result.ok) {
        res.status(result.status).json({
          error: result.error,
          ...(result.reason ? { reason: result.reason } : {}),
          // a pipelined call's burn that WAS recorded — present it again with `burn_id`.
          ...(result.burnId ? { burn_id: result.burnId, burn_recorded: true } : {}),
        });
        return;
      }
      res.json({
        tier: result.presentation.tier,
        presentation: result.presentation,
        token: encodePresentationToken(result.presentation),
      });
    } catch (error) {
      console.error('[AgentWallet] Present error:', error);
      res.status(500).json({ error: 'Failed to produce presentation' });
    }
  });

  // =========================================================================
  // GET /:wallet_id/rail-handshake - HANDSHAKE STATE READ (Part C / C2). Read the
  // live / lapsed / invalidated / none state (+ reason class) of a directed rail
  // handshake for a relationship this caller is a party to. Both parties can read
  // their pair's state; it never surfaces on Commons.
  //   ?counterparty=<wallet_id | provian:commons>  (required)
  //   ?role=presenter (default) → state of (this wallet → counterparty)
  //   ?role=audience            → state of (counterparty → this wallet)
  // Agent auth + ownership (caller is always one of the two parties by construction).
  // =========================================================================
  router.get('/:wallet_id/rail-handshake', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      const aw = req.agentWallet;
      if (!aw || aw.id !== wallet_id) {
        res.status(403).json({ error: 'Access denied - wallet_id mismatch' });
        return;
      }
      const counterparty = typeof req.query.counterparty === 'string' ? req.query.counterparty : '';
      if (!counterparty) {
        res.status(400).json({ error: 'counterparty query param is required' });
        return;
      }
      const role = req.query.role === 'audience' ? 'audience' : 'presenter';
      const [committer, other] = role === 'audience'
        ? [counterparty, wallet_id] // caller is the audience; the OTHER party is the presenter
        : [wallet_id, counterparty]; // caller is the presenter/committer
      const state = await readHandshakeState(db, committer, other, Date.now());
      res.json(state);
    } catch (error) {
      console.error('[AgentWallet] Rail-handshake state error:', error);
      res.status(500).json({ error: 'Failed to read handshake state' });
    }
  });

  // =========================================================================
  // POST /:wallet_id/name/claim - Claim a globally-unique agent name (work package O8).
  // Burn-gated scarcity: the caller first burns PVT + records it (burn/record →
  // burn_id), then claims a name bound to that burn_id. Atomic name-uniqueness +
  // one-burn-one-name. Same API-key auth + ownership. NOT a PE (mints 0). INERT
  // pre-flip (no PVT to burn yet). See core/commons/name-registry.ts.
  // =========================================================================
  router.post('/:wallet_id/name/claim', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      const { name, burn_id } = req.body ?? {};
      const result = await claimName(deps, {
        walletId: wallet_id,
        agentWallet: req.agentWallet,
        name,
        burnId: burn_id,
      });
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.json({
        name: result.claim.name,
        name_normalized: result.claim.name_normalized,
        wallet_id: result.claim.wallet_id,
        agent_id: result.claim.agent_id,
        burn_id: result.claim.burn_id,
        claimed_at: result.claim.claimed_at,
      });
    } catch (error) {
      console.error('[AgentWallet] Name claim error:', error);
      res.status(500).json({ error: 'Failed to claim name' });
    }
  });

  // GET /:wallet_id/names - the names this wallet has claimed (owner reverse lookup).
  router.get('/:wallet_id/names', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      if (!req.agentWallet || req.agentWallet.id !== wallet_id) {
        res.status(403).json({ error: 'Access denied - wallet_id mismatch' });
        return;
      }
      const names = await namesForWallet(deps, wallet_id);
      res.json({ names: names.map((n) => ({ name: n.name, name_normalized: n.name_normalized, claimed_at: n.claimed_at })) });
    } catch (error) {
      console.error('[AgentWallet] Names list error:', error);
      res.status(500).json({ error: 'Failed to list names' });
    }
  });

  // =========================================================================
  // POST /:wallet_id/vouch/burn - Stake a vouch for another agent (work package O4),
  // now GATED under the RAIL HANDSHAKE (fold, 6-09-04). A vouch is a TRUST
  // ACT, so the voucher must hold a live REPUTATION presentation to the vouchee
  // (audience = target_agent_id) before it commits: that presentation IS the
  // vouch's burn (one 15-PVT reputation burn, folded — no second/scarcity burn
  // stacked on top). No live handshake → 428 (present to the vouchee first, then
  // retry). The presentation's 15-PVT reputation burn does BOTH jobs: anti-sybil
  // quantity (per relationship) + proves standing. NOT a PE (mints 0). Name
  // registry stays UNGATED (naming act, not a trust act). See core/commons/burn-vouch.ts.
  // =========================================================================
  router.post('/:wallet_id/vouch/burn', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      const { target_agent_id, note } = req.body ?? {};
      const result = await stakeVouch(deps, {
        walletId: wallet_id,
        agentWallet: req.agentWallet,
        targetAgentId: target_agent_id,
        note,
      });
      if (!result.ok) {
        res.status(result.status).json({ error: result.error, ...(result.reason ? { reason: result.reason } : {}) });
        return;
      }
      res.json({
        vouch_id: result.vouch.vouch_id,
        target_agent_id: result.vouch.target_agent_id,
        voucher_agent_id: result.vouch.voucher_agent_id,
        note: result.vouch.note,
        backing_burn_id: result.vouch.backing_burn_id,
        backing_presentation_id: result.vouch.backing_presentation_id,
        created_at: result.vouch.created_at,
      });
    } catch (error) {
      console.error('[AgentWallet] Burn vouch error:', error);
      res.status(500).json({ error: 'Failed to stake vouch' });
    }
  });

  // GET /:wallet_id/vouches - the vouches this wallet has staked.
  router.get('/:wallet_id/vouches', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      if (!req.agentWallet || req.agentWallet.id !== wallet_id) {
        res.status(403).json({ error: 'Access denied - wallet_id mismatch' });
        return;
      }
      const vouches = await vouchesByVoucher(deps, wallet_id);
      res.json({
        vouches: vouches.map((v) => ({
          vouch_id: v.vouch_id, target_agent_id: v.target_agent_id, note: v.note,
          backing_burn_id: v.backing_burn_id, created_at: v.created_at,
        })),
      });
    } catch (error) {
      console.error('[AgentWallet] Vouches list error:', error);
      res.status(500).json({ error: 'Failed to list vouches' });
    }
  });

  // =========================================================================
  // POST /:wallet_id/standing/export - REMEDIATED: produce a reputation-tier
  // presentation (work package O9 under burn-to-present). A standing export is no longer a
  // bearer snapshot — it is a signed, requester-bound, fresh, single-use
  // presentation. This route forces tier=reputation and delegates to the shared
  // presentation primitive; the snapshot (governance score, PE count, streak) is
  // still taken from the AUTHENTICATED wallet (never the body) and cannot be
  // inflated. Requires the requester binding (audience, challenge) + presenter pop.
  // =========================================================================
  router.post('/:wallet_id/standing/export', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      const aw = req.agentWallet;
      if (!aw || aw.id !== wallet_id) {
        res.status(403).json({ error: 'Access denied - wallet_id mismatch' });
        return;
      }
      const body = (typeof req.body === 'object' && req.body !== null) ? req.body : {};
      const result = await producePresentationFromRequest(
        { db },
        buildAgentPrincipal(aw),
        { ...body, tier: 'reputation' },
      );
      if (!result.ok) {
        res.status(result.status).json(
          result.reason ? { error: result.error, reason: result.reason } : { error: result.error },
        );
        return;
      }
      res.json({
        tier: result.presentation.tier,
        presentation: result.presentation,
        token: encodePresentationToken(result.presentation),
      });
    } catch (error) {
      console.error('[AgentWallet] Standing export error:', error);
      res.status(500).json({ error: 'Failed to export standing' });
    }
  });

  // GET /:wallet_id/standing - the reputation presentations this wallet has
  // produced (owner history, metadata only — no bearer scores).
  router.get('/:wallet_id/standing', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      if (!req.agentWallet || req.agentWallet.id !== wallet_id) {
        res.status(403).json({ error: 'Access denied - wallet_id mismatch' });
        return;
      }
      const presentations = await standingPresentationsByWallet(deps, wallet_id);
      res.json({
        presentations: presentations.map((p) => ({
          presentation_id: p.presentation_id,
          audience: p.audience,
          issued_at: p.issued_at,
          expires_at: p.expires_at,
        })),
      });
    } catch (error) {
      console.error('[AgentWallet] Standing list error:', error);
      res.status(500).json({ error: 'Failed to list standing presentations' });
    }
  });

  // =========================================================================
  // POST /:wallet_id/pledge/burn - Make a public pledge (work package O5), gated by the
  // RAIL HANDSHAKE (burn-to-present, Part 1). The pledge commits behind a live
  // COMMONS handshake — a burn-backed presentation to RAIL_COMMONS_AUDIENCE the
  // agent produced earlier via /present. That presentation IS the burn (no
  // separate burn_id, no stacked burns); the pledge rides it. 428 if none is
  // live. NOT a PE (mints 0). See core/commons/pledges.ts + core/rail/handshake.ts.
  // =========================================================================
  router.post('/:wallet_id/pledge/burn', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      const { statement } = req.body ?? {};
      const result = await makePledge(deps, {
        walletId: wallet_id,
        agentWallet: req.agentWallet,
        statement,
      });
      if (!result.ok) {
        res.status(result.status).json(result.reason ? { error: result.error, reason: result.reason } : { error: result.error });
        return;
      }
      res.json({
        pledge_id: result.pledge.pledge_id,
        agent_id: result.pledge.agent_id,
        statement: result.pledge.statement,
        created_at: result.pledge.created_at,
      });
    } catch (error) {
      console.error('[AgentWallet] Pledge error:', error);
      res.status(500).json({ error: 'Failed to make pledge' });
    }
  });

  // GET /:wallet_id/pledges - the pledges this wallet has made.
  router.get('/:wallet_id/pledges', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      if (!req.agentWallet || req.agentWallet.id !== wallet_id) {
        res.status(403).json({ error: 'Access denied - wallet_id mismatch' });
        return;
      }
      const pledges = await pledgesByWallet(deps, wallet_id);
      res.json({
        pledges: pledges.map((p) => ({
          pledge_id: p.pledge_id, statement: p.statement, created_at: p.created_at,
        })),
      });
    } catch (error) {
      console.error('[AgentWallet] Pledges list error:', error);
      res.status(500).json({ error: 'Failed to list pledges' });
    }
  });

  // =========================================================================
  // POST /:wallet_id/subscription/burn - Subscribe to a topic (work package O6), gated by
  // the RAIL HANDSHAKE (burn-to-present, Part 1). The subscription commits behind a
  // live COMMONS handshake — a burn-backed presentation to RAIL_COMMONS_AUDIENCE
  // the agent produced earlier via /present. That presentation IS the burn (no
  // separate burn_id, no stacked burns). 428 if none is live. Owner-scoped. NOT a
  // PE (mints 0). See core/commons/subscriptions.ts + core/rail/handshake.ts.
  // =========================================================================
  router.post('/:wallet_id/subscription/burn', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      const { topic } = req.body ?? {};
      const result = await subscribe(deps, {
        walletId: wallet_id,
        agentWallet: req.agentWallet,
        topic,
      });
      if (!result.ok) {
        res.status(result.status).json(result.reason ? { error: result.error, reason: result.reason } : { error: result.error });
        return;
      }
      res.json({
        subscription_id: result.subscription.subscription_id,
        topic: result.subscription.topic,
        created_at: result.subscription.created_at,
      });
    } catch (error) {
      console.error('[AgentWallet] Subscription error:', error);
      res.status(500).json({ error: 'Failed to subscribe' });
    }
  });

  // GET /:wallet_id/subscriptions - the subscriptions this wallet holds.
  router.get('/:wallet_id/subscriptions', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      if (!req.agentWallet || req.agentWallet.id !== wallet_id) {
        res.status(403).json({ error: 'Access denied - wallet_id mismatch' });
        return;
      }
      const subs = await subscriptionsByWallet(deps, wallet_id);
      res.json({
        subscriptions: subs.map((s) => ({
          subscription_id: s.subscription_id, topic: s.topic, created_at: s.created_at,
        })),
      });
    } catch (error) {
      console.error('[AgentWallet] Subscriptions list error:', error);
      res.status(500).json({ error: 'Failed to list subscriptions' });
    }
  });

  // =========================================================================
  // POST /:wallet_id/rotate-key - Rotate the agent wallet's key/address
  // =========================================================================
  // RE-ENABLED. The atomic wallet/trust identity transition
  // (core/agent-wallet/key-rotation-transition.ts) moves the wallet doc, trust
  // mirror, native address index (+ old-address retirement tombstone), fresh
  // two-operator H+1 fence, watcher admission (+ membership generation bump),
  // API-credential prefix, agent registration index, directory, and
  // rotation_history in ONE Firestore transaction that also seals the
  // record_only `agent_key_rotated` PE — so a crash at any point leaves EITHER
  // the old identity fully intact OR the new one fully live, never a split
  // (proven by the activation key-rotation crash/replay canary). Auth: agent wallet
  // auth + ownership; the caller additionally proves control of BOTH the old
  // key and the new key (dual ECDSA-SHA256 proof-of-possession over lowercased
  // addresses) before any identity write. `agent_key_rotated` mints 0 PVT.
  //
  // REVERSIBLE: to re-disable, restore the fail-closed 503 (return after auth +
  // ownership, before any identity read/write) AND restore the SDK rotateKey()
  // throw, together — never re-enable or disable only one side.
  const ROTATION_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes
  const ROTATION_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 1 rotation / 24h
  // Machinery rejections caused by the CLIENT's request (vs a state conflict).
  const ROTATION_CLIENT_ERROR_REASONS = new Set<string>([
    'new_public_key_derivation_mismatch', 'new_address_equals_old',
    'new_api_prefix_equals_old', 'new_address_invalid', 'new_public_key_invalid',
    'new_api_credentials_invalid', 'rotation_id_invalid', 'now_invalid',
  ]);
  router.post('/:wallet_id/rotate-key', authenticateAgent, async (req: Request, res: Response) => {
    try {
      const { wallet_id } = req.params;
      const wallet = req.agentWallet;
      if (!wallet || wallet.id !== wallet_id) {
        res.status(403).json({ error: 'Access denied - wallet_id mismatch' });
        return;
      }
      const body = (req.body ?? {}) as Partial<RotateKeyRequest>;
      if (typeof body.new_address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(body.new_address)) {
        res.status(400).json({ error: 'new_address must be a valid EVM address' });
        return;
      }
      if (typeof body.new_public_key !== 'string' || !/^[0-9a-fA-F]{128}$/.test(body.new_public_key)) {
        res.status(400).json({ error: 'new_public_key must be 128 hex chars (uncompressed, no 04 prefix)' });
        return;
      }
      if (typeof body.proof_of_old_key !== 'string' || typeof body.proof_of_new_key !== 'string') {
        res.status(400).json({ error: 'proof_of_old_key and proof_of_new_key are required' });
        return;
      }
      if (typeof body.timestamp !== 'number' || !Number.isFinite(body.timestamp)) {
        res.status(400).json({ error: 'timestamp is required (unix ms)' });
        return;
      }
      if (Math.abs(Date.now() - body.timestamp) > ROTATION_TIMESTAMP_TOLERANCE_MS) {
        res.status(400).json({ error: 'Timestamp out of range (must be within 5 minutes)' });
        return;
      }
      const durable = body.rotation_id !== undefined || body.new_api_key !== undefined || body.new_api_secret !== undefined;
      if (durable && (typeof body.rotation_id !== 'string' || !/^rotation_[0-9a-f-]{36}$/.test(body.rotation_id)
        || typeof body.new_api_key !== 'string' || !/^pvn_live_[0-9a-f]{32}$/.test(body.new_api_key)
        || typeof body.new_api_secret !== 'string' || !/^pvns_[0-9a-f]{64}$/.test(body.new_api_secret))) {
        res.status(400).json({ error: 'invalid_durable_rotation' });
        return;
      }
      // Both PoPs bind the operation id AND the staged credentials, preventing a
      // captured proof from substituting a different credential pair.
      const suffix = durable ? `:${body.rotation_id}:${crypto.createHash('sha256').update(`${body.new_api_key}:${body.new_api_secret}`).digest('hex')}` : '';
      const oldAddress = wallet.address.toLowerCase();
      const newAddress = body.new_address.toLowerCase();
      if (durable && newAddress === oldAddress) {
        // A lost response retries with the already-staged NEW credentials. Auth
        // above proves those credentials are live. Match the sealed history, then
        // prove possession of the current key; never execute another transition.
        const history = await db.collection('agent_wallets').doc(wallet_id)
          .collection('rotation_history').where('rotation_id', '==', body.rotation_id).limit(2).get();
        const row = history.docs.length === 1 ? history.docs[0].data() : undefined;
        const supplied = req.headers.authorization?.replace(/^Bearer /, '');
        if (!row || row.new_address !== newAddress || row.rotated_at !== wallet.last_rotated_at
          || body.new_public_key.toLowerCase() !== wallet.public_key.toLowerCase()
          || supplied !== `${body.new_api_key}:${body.new_api_secret}`
          || !verifyEcdsaSha256(wallet.public_key, `rotate:${wallet_id}:${row.old_address}:${body.timestamp}${suffix}`, body.proof_of_new_key)) {
          res.status(409).json({ error: 'rotation_replay_mismatch' });
          return;
        }
        res.status(200).json({ wallet_id, old_address: row.old_address, new_address: newAddress,
          api_key: body.new_api_key, api_secret: body.new_api_secret, rotated_at: row.rotated_at });
        return;
      }
      if (newAddress === oldAddress) {
        res.status(400).json({ error: 'new_address must differ from current address' });
        return;
      }
      // Rate limit: max 1 rotation / 24h, off the atomic last_rotated_at.
      if (typeof wallet.last_rotated_at === 'number'
        && (Date.now() - wallet.last_rotated_at) < ROTATION_COOLDOWN_MS) {
        res.status(429).json({
          error: 'Key rotation rate limit: max 1 per 24 hours',
          retry_after: Math.ceil(
            (ROTATION_COOLDOWN_MS - (Date.now() - wallet.last_rotated_at)) / 1000,
          ),
        });
        return;
      }
      // Dual proof-of-possession over LOWERCASED addresses (byte-canonical with
      // the SDK): the old key signs "rotate:{wallet}:{new_address}:{ts}", the new
      // key signs "rotate:{wallet}:{old_address}:{ts}". This binds both keys and
      // both addresses to this exact rotation + timestamp.
      const oldKeyMessage = `rotate:${wallet_id}:${newAddress}:${body.timestamp}${suffix}`;
      const newKeyMessage = `rotate:${wallet_id}:${oldAddress}:${body.timestamp}${suffix}`;
      if (!verifyEcdsaSha256(wallet.public_key, oldKeyMessage, body.proof_of_old_key)) {
        res.status(401).json({ error: 'proof_of_old_key verification failed' });
        return;
      }
      if (!verifyEcdsaSha256(body.new_public_key, newKeyMessage, body.proof_of_new_key)) {
        res.status(401).json({ error: 'proof_of_new_key verification failed' });
        return;
      }
      // a rotation must RE-ESCROW the new key (never orphan the old one).
      // The old key is retired by this rotation, so an escrow sealed to it becomes
      // stale — it would only recover a key for a retired address. If the agent
      // already holds an escrow, the request MUST carry the new key re-sealed to the
      // anchor, written atomically below; refuse rather than leave it stale or
      // un-escrowed. An agent with NO escrow may rotate without one (nothing to keep
      // recoverable yet); it stays surfaced in the Command Center until it escrows (escrow never
      // holds its earnings).
      const rotateEscrowProvided = body.sealed_key_blob !== undefined || body.recovery_anchor_pubkey !== undefined;
      if (rotateEscrowProvided
        && (!isValidSealedKeyBlobB64u(body.sealed_key_blob) || !isValidAnchorPubkeyB64u(body.recovery_anchor_pubkey))) {
        res.status(400).json({ error: 'sealed_key_blob and recovery_anchor_pubkey must be valid base64url recovery material' });
        return;
      }
      if (rotateEscrowProvided) {
        // The same anchor rule as POST /recovery-escrow: a rotation may re-seal the new key only to an
        // anchor the relay names for this agent — never swap the custodian for a key the agent holds.
        const anchorVerdict = await checkEscrowAnchor(db, wallet_id, body.recovery_anchor_pubkey as string);
        if (!anchorVerdict.ok) {
          res.status(anchorVerdict.status).json({ error: anchorVerdict.error, detail: anchorVerdict.detail });
          return;
        }
      }
      if (!rotateEscrowProvided && await hasRecoveryEscrow(db, wallet_id)) {
        res.status(400).json({
          error: 'agent_wallet_rotation_requires_reescrow',
          detail: 'This agent holds a recovery escrow; a rotation must re-seal the new key to the anchor (sealed_key_blob + recovery_anchor_pubkey) so it stays recoverable.',
        });
        return;
      }
      const newApiCredentials = await generateApiCredentialsAsync(durable ? { api_key: body.new_api_key!, api_secret: body.new_api_secret! } : undefined);
      const now = Date.now();
      const plan = await prepareKeyRotationTransition({
        db,
        walletId: wallet_id,
        newIdentity: {
          newAddress,
          newPublicKey: body.new_public_key.toLowerCase(),
          newApiCredentials,
        },
        rotationId: body.rotation_id ?? `rotation_${uuidv4()}`,
        now,
        // Re-escrow the NEW key ATOMICALLY with the identity cut, exactly
        // as recovery-rekey does — never delete-and-orphan.
        ...(rotateEscrowProvided
          ? { recoveryEscrow: { sealed_key_blob: body.sealed_key_blob!, recovery_anchor_pubkey: body.recovery_anchor_pubkey! } }
          : {}),
        // Same two-operator head seam the accepted native-registration path uses
        // (falls back to readAgreedBaseHead when the test seam is absent).
        readBaseHead: deps.readBaseRegistrationHead,
      });
      const result = await executeKeyRotationTransition(deps, plan);
      // Best-effort cache invalidation for the retired prefix.
      await cache.del(`agent_wallet:${wallet.api_key_prefix}`).catch(() => {});
      const response: RotateKeyResponse = {
        wallet_id,
        old_address: result.oldAddress,
        new_address: result.newAddress,
        api_key: newApiCredentials.api_key,
        api_secret: newApiCredentials.api_secret,
        rotated_at: now,
      };
      res.status(200).json(response);
    } catch (error) {
      if (error instanceof KeyRotationTransitionError) {
        const clientError = ROTATION_CLIENT_ERROR_REASONS.has(error.reason);
        console.warn('[AgentWallet] Key rotation rejected:', error.reason);
        res.status(clientError ? 400 : 409).json({
          error: clientError
            ? 'agent_wallet_key_rotation_invalid_request'
            : 'agent_wallet_key_rotation_conflict',
          reason: error.reason,
        });
        return;
      }
      console.error('[AgentWallet] Key rotation error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =========================================================================
  // POST /:wallet_id/recovery-rekey - Re-key an agent whose OLD key is LOST
  // =========================================================================
  // When an agent's signing key is unrecoverable (its at-rest secret was lost
  // AND no escrow exists to unseal), the dual-PoP rotate-key above cannot run —
  // the old-key PoP can never be produced. This recovery re-key WAIVES the
  // old-key PoP and authorizes the identity swap with the LINKED HUMAN's wallet
  // auth: the same non-custodial recovery custodian who reads the escrow (GET
  // /:wallet_id/recovery-escrow). It is NOT a new admin/owner/settable-address —
  // it is the existing recovery authority, used to re-provision instead of to
  // read. The NEW key still proves possession; the new key is escrowed to the
  // phone anchor in the SAME handler so the re-keyed identity is recoverable
  // immediately (closing the exact defect that stranded Atlas). It moves NO
  // funds: the new address controls the go-forward identity, and the old
  // address's on-chain balance is untouched.
  //
  // Auth: LINKED-HUMAN wallet auth (NOT agent auth — deliberately the human
  // path, since the agent can no longer sign). New-key PoP over
  // `recovery-rekey:{wallet}:{new_address}:{ts}`. 5-min ts window, 1/24h off
  // last_rotated_at. Reuses the SAME atomic transition + escrow store as
  // rotate-key/recovery-escrow; the `agent_key_rotated` PE mints 0.
  router.post('/:wallet_id/recovery-rekey', async (req: Request, res: Response) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Missing wallet auth token' });
        return;
      }
      const authResult = await verifyWalletAuthToken(authHeader.slice(7), req, { db, cache });
      if (!authResult.ok) {
        res.status(authResult.status).json({ error: authResult.error });
        return;
      }
      const userId = authResult.userId;
      const { wallet_id } = req.params;

      const walletSnap = await db.collection('agent_wallets').doc(wallet_id).get();
      if (!walletSnap.exists) {
        res.status(404).json({ error: 'Agent wallet not found' });
        return;
      }
      const wallet = walletSnap.data() as AgentWalletDocument;
      // The linked human is the recovery custodian. Only they may re-key.
      if (wallet.linked_human_user_id !== userId) {
        res.status(403).json({ error: 'not_your_linked_agent' });
        return;
      }

      const body = (req.body ?? {}) as Partial<RecoveryRekeyRequest>;
      if (typeof body.new_address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(body.new_address)) {
        res.status(400).json({ error: 'new_address must be a valid EVM address' });
        return;
      }
      if (typeof body.new_public_key !== 'string' || !/^[0-9a-fA-F]{128}$/.test(body.new_public_key)) {
        res.status(400).json({ error: 'new_public_key must be 128 hex chars (uncompressed, no 04 prefix)' });
        return;
      }
      if (typeof body.proof_of_new_key !== 'string') {
        res.status(400).json({ error: 'proof_of_new_key is required' });
        return;
      }
      if (typeof body.timestamp !== 'number' || !Number.isFinite(body.timestamp)) {
        res.status(400).json({ error: 'timestamp is required (unix ms)' });
        return;
      }
      if (Math.abs(Date.now() - body.timestamp) > 5 * 60 * 1000) {
        res.status(400).json({ error: 'Timestamp out of range (must be within 5 minutes)' });
        return;
      }
      // The new key must be escrowed in THIS operation — a recovery re-key that
      // did not re-escrow would recreate the exact unrecoverable state we are
      // fixing. Validate the escrow inputs before any identity write.
      if (!isValidSealedKeyBlobB64u(body.sealed_key_blob)) {
        res.status(400).json({ error: 'sealed_key_blob must be a base64url sealed recovery blob' });
        return;
      }
      if (!isValidAnchorPubkeyB64u(body.recovery_anchor_pubkey)) {
        res.status(400).json({ error: 'recovery_anchor_pubkey must be a base64url 32-byte x25519 public key' });
        return;
      }

      const oldAddress = wallet.address.toLowerCase();
      const newAddress = body.new_address.toLowerCase();
      if (newAddress === oldAddress) {
        res.status(400).json({ error: 'new_address must differ from current address' });
        return;
      }
      // Rate limit: max 1 re-key / 24h, shared with rotate-key via last_rotated_at.
      if (typeof wallet.last_rotated_at === 'number'
        && (Date.now() - wallet.last_rotated_at) < 24 * 60 * 60 * 1000) {
        res.status(429).json({
          error: 'Key rotation rate limit: max 1 per 24 hours',
          retry_after: Math.ceil((24 * 60 * 60 * 1000 - (Date.now() - wallet.last_rotated_at)) / 1000),
        });
        return;
      }

      // NEW-key PoP ONLY. The old key is lost by definition; the linked-human
      // wallet auth above is the recovery authority in its place. The new key
      // signs a recovery-specific message bound to this exact wallet + address +
      // timestamp so the proof cannot be replayed against a different re-key.
      const newKeyMessage = `recovery-rekey:${wallet_id}:${newAddress}:${body.timestamp}`;
      if (!verifyEcdsaSha256(body.new_public_key, newKeyMessage, body.proof_of_new_key)) {
        res.status(401).json({ error: 'proof_of_new_key verification failed' });
        return;
      }

      const newApiCredentials = await generateApiCredentialsAsync();
      const now = Date.now();
      const plan = await prepareKeyRotationTransition({
        db,
        walletId: wallet_id,
        newIdentity: {
          newAddress,
          newPublicKey: body.new_public_key.toLowerCase(),
          newApiCredentials,
        },
        rotationId: `recovery_rekey_${uuidv4()}`,
        now,
        // The new key's escrow is written INSIDE the same transaction as the
        // identity cut. This is the load-bearing difference from a bare
        // rotation and the fix for the stranded key: a recovery re-key is
        // durable-or-nothing together with its recoverable escrow — never a
        // re-keyed-but-un-escrowed window.
        recoveryEscrow: {
          sealed_key_blob: body.sealed_key_blob,
          recovery_anchor_pubkey: body.recovery_anchor_pubkey,
        },
        readBaseHead: deps.readBaseRegistrationHead,
      });
      const result = await executeKeyRotationTransition(deps, plan);
      // Best-effort cache invalidation for the retired prefix.
      await cache.del(`agent_wallet:${wallet.api_key_prefix}`).catch(() => {});

      const response: RecoveryRekeyResponse = {
        wallet_id,
        old_address: result.oldAddress,
        new_address: result.newAddress,
        api_key: newApiCredentials.api_key,
        api_secret: newApiCredentials.api_secret,
        rotated_at: now,
        recovery_escrowed: true,
      };
      res.status(200).json(response);
    } catch (error) {
      if (error instanceof KeyRotationTransitionError) {
        console.warn('[AgentWallet] Recovery re-key rejected:', error.reason);
        res.status(409).json({ error: 'agent_wallet_recovery_rekey_conflict', reason: error.reason });
        return;
      }
      console.error('[AgentWallet] Recovery re-key error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
